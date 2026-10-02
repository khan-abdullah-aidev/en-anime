import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTasteModel,
  describeModel,
  featuresOf,
  hitRate,
  learnedFit,
  learnedForModel,
  learnedRanker,
  outcomeOf,
  pastFitLabel
} from "../src/learning.js";
import { backfillPastPicks, needsBackfill, scoreDeltas } from "../src/learningBackfill.js";
import { buildUserContext, rankPool, toCandidate, toModelCandidate } from "../src/discovery.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { aniListMedia, json, malEntry, withFetch } from "./fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-02T12:00:00Z");
const ago = (days) => new Date(now - days * DAY).toISOString();

const show = (id, genres, tags = [], overrides = {}) =>
  toCandidate(aniListMedia(id, `Show ${id}`, { genres, tags: tags.map((name) => ({ name, rank: 80 })), ...overrides }));
const answered = (id, candidate, feedback, days = 5, extra = {}) => ({
  id: `e${id}`,
  date: ago(days),
  state: "rated",
  feedback,
  recommendation: { title: candidate.title, features: featuresOf(candidate) },
  ...extra
});

describe("what an answer teaches", () => {
  it("weighs each kind of answer", () => {
    assert.deepEqual(outcomeOf({ state: "rated", feedback: "good" }), { y: 1, w: 1, answered: true });
    assert.equal(outcomeOf({ state: "rated", feedback: "good", score_delta: 3 }).w, 2, "a 10 from someone who averages 7 counts double");
    assert.equal(outcomeOf({ state: "rated", feedback: "meh", seen_before: true }).w, 0.7);
    assert.deepEqual(outcomeOf({ state: "skipped" }), { y: -1, w: 0.4, answered: true });
    assert.equal(outcomeOf({ state: "not_tonight", pass_reason: "too heavy" }).moodOnly, true, "a reason is about the night, not the show");
    assert.equal(outcomeOf({ state: "unrated" }), null);
  });

  it("tallies traits with caution, fading older answers, and forgets what it's told to", () => {
    const quiet = show(1, ["Slice of Life"], ["Iyashikei"]);
    const history = [answered(1, quiet, "good", 3), answered(2, show(2, ["Slice of Life"], ["Iyashikei"]), "good", 4), answered(3, show(3, ["Psychological"]), "meh", 2)];
    const model = buildTasteModel(history, { now });
    const iyashikei = model.stats.get("t:iyashikei");
    assert.equal(iyashikei.hits, 2);
    assert.ok(iyashikei.sum / (iyashikei.n + 2) < 0.6, "two answers don't make a certainty");
    assert.equal(model.answered, 3);

    const old = buildTasteModel([answered(1, quiet, "good", 360)], { now }).stats.get("t:iyashikei");
    assert.ok(old.n < 0.3, "a year-old answer counts about a quarter");

    assert.equal(buildTasteModel(history, { now, ignored: ["t:iyashikei"] }).stats.has("t:iyashikei"), false);
  });

  it("learns what doesn't suit a mood without counting it against the show", () => {
    const heavy = { ...show(4, ["Drama"], ["Tragedy"]), moodTerms: ["Slice of Life"] };
    const pass = { id: "p", date: ago(1), state: "not_tonight", pass_reason: "too heavy", recommendation: { title: heavy.title, features: featuresOf(heavy) } };
    const model = buildTasteModel([pass], { now });
    assert.equal(model.stats.has("g:drama"), false);
    assert.ok(model.stats.get("mood:sliceoflife>tragedy").sum < 0);
  });
});

describe("using what it learned", () => {
  const history = [
    ...[1, 2, 3, 4].map((id) => answered(id, show(id, ["Slice of Life"], ["Iyashikei"]), "good")),
    ...[5, 6, 7].map((id) => answered(id, show(id, ["Psychological"], ["Philosophy"]), "meh"))
  ];
  const model = buildTasteModel(history, { now });

  it("scores candidates by how picks like them landed", () => {
    const like = learnedFit(model, show(10, ["Slice of Life"], ["Iyashikei"]));
    const unlike = learnedFit(model, show(11, ["Psychological"], ["Philosophy"]));
    assert.ok(like.fit > 0.3 && unlike.fit < -0.3, `${like.fit} vs ${unlike.fit}`);
    assert.equal(pastFitLabel(like.fit, like.evidence), "strong");
    assert.equal(pastFitLabel(unlike.fit, unlike.evidence), "poor");
    assert.equal(pastFitLabel(0.5, 0.2), null, "not without evidence");
  });

  it("reorders the pool, and tells the model", () => {
    const context = buildUserContext({ list: [], history: [], memory: buildRecommendationMemory({ malList: [], history: [] }) });
    // Seven answers can tip a close call; they shouldn't yet override a big gap in quality.
    const discovery = { genre: [show(20, ["Psychological"], ["Philosophy"], { averageScore: 80 }), show(21, ["Slice of Life"], ["Iyashikei"], { averageScore: 74 })] };
    assert.equal(rankPool({ discovery, context })[0].title, "Show 20", "without learning, the higher score wins");
    const ranked = rankPool({ discovery, context, learned: learnedRanker(model) });
    assert.equal(ranked[0].title, "Show 21");
    assert.equal(toModelCandidate(ranked[0]).pastFit, "strong");
    assert.equal(toModelCandidate(ranked[1]).pastFit, "poor");
  });

  it("describes what lands and what misses, for the page and the model", () => {
    const { landed, missed } = describeModel(model);
    assert.ok(landed.some((trait) => trait.key === "t:iyashikei" && trait.hits === 4));
    assert.ok(missed.some((trait) => trait.key === "g:psychological" && trait.misses === 3));
    const forModel = learnedForModel(model, history);
    assert.equal(forModel.answeredPicks, 7);
    assert.equal(forModel.recentHitRate, "4 of the last 7");
    assert.ok(forModel.landed.includes("Iyashikei (4 of 4 landed)"));
    assert.equal(learnedForModel(buildTasteModel(history.slice(0, 2), { now }), history.slice(0, 2)), null, "too early to say");
  });

  it("gets better the more it's answered", () => {
    // A person who likes quiet shows and has no time for psychological ones.
    // The pool's own scores don't know that; only answers can teach it.
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const genres = ["Slice of Life", "Psychological", "Action", "Comedy", "Drama", "Mystery"];
    const tags = ["Iyashikei", "Philosophy", "Swordplay", "Parody", "Tragedy", "Detective"];
    const pool = Array.from({ length: 160 }, (_, i) => {
      const g = genres[Math.floor(random() * genres.length)];
      const t = tags[Math.floor(random() * tags.length)];
      return show(100 + i, [g], [t], { averageScore: 60 + Math.floor(random() * 30) });
    });
    const likes = (candidate) => candidate.genres.includes("Slice of Life") || candidate.tags.includes("Iyashikei");
    const context = buildUserContext({ list: [], history: [], memory: buildRecommendationMemory({ malList: [], history: [] }) });

    const run = (learning) => {
      const log = [];
      for (let round = 0; round < 40; round += 1) {
        const left = pool.filter((candidate) => !log.some((entry) => entry.recommendation.title === candidate.title));
        const model = buildTasteModel(log, { now });
        const [pick] = rankPool({ discovery: { genre: left }, context, learned: learning ? learnedRanker(model) : null, limit: 1 });
        log.push(answered(round, pick, likes(pick) ? "good" : "meh", 1));
      }
      const hits = (from, to) => log.slice(from, to).filter((entry) => entry.feedback === "good").length;
      return { early: hits(0, 10), late: hits(30, 40) };
    };

    const without = run(false);
    const withLearning = run(true);
    assert.ok(withLearning.late >= 8, `late hits with learning: ${withLearning.late}/10`);
    assert.ok(withLearning.late > without.late, `${withLearning.late} vs ${without.late} without learning`);
  });
});

describe("hit rate", () => {
  it("counts good as a hit, meh and passing as misses, oldest first", () => {
    const history = [
      { id: "c", date: ago(1), state: "rated", feedback: "good", recommendation: { title: "C" } },
      { id: "a", date: ago(9), state: "rated", feedback: "meh", recommendation: { title: "A" } },
      { id: "b", date: ago(5), state: "skipped", recommendation: { title: "B" } },
      { id: "n", date: ago(3), state: "not_tonight", recommendation: { title: "N" } }
    ];
    const rate = hitRate(history, { window: 2 });
    assert.deepEqual(rate.all.map((pick) => [pick.id, pick.hit]), [["a", false], ["b", false], ["c", true]]);
    assert.deepEqual(rate.recent.map((pick) => pick.id), ["b", "c"]);
  });
});

describe("catching up on past picks", () => {
  it("looks them up on AniList (by id in one go, by title for the oldest) and keeps what it finds", async () => {
    const history = [
      { id: "with-id", date: ago(30), state: "rated", feedback: "good", recommendation: { title: "Mushishi", anilistId: 457 } },
      { id: "no-id", date: ago(90), state: "rated", feedback: "meh", recommendation: { title: "Old Catalog Pick", genre: "Drama" } },
      { id: "done", date: ago(2), state: "rated", feedback: "good", recommendation: { title: "New", features: { g: ["Drama"] } } }
    ];
    assert.deepEqual(history.map(needsBackfill), [true, true, false]);
    const { result: patches, calls } = await withFetch(
      (url, body) => {
        if (body.query.includes("search:")) return json({ data: { Page: { media: [aniListMedia(900, "Old Catalog Pick", { idMal: 9000 })] } } });
        return json({ data: { Page: { media: body.variables.ids.map((id) => aniListMedia(id, `Show ${id}`, { genres: ["Slice of Life"], tags: [{ name: "Iyashikei", rank: 90 }], popularity: 12000 })) } } });
      },
      () => backfillPastPicks({ history, pause: 0 })
    );
    assert.equal(calls.filter((call) => call.body.query.includes("id_in")).length, 1, "one batch for every id");
    assert.deepEqual(patches.get("with-id").features, { g: ["Slice of Life"], t: ["Iyashikei"], len: "short", era: "2020s", pop: "niche" });
    assert.deepEqual([patches.get("no-id").recommendation.anilistId, patches.get("no-id").recommendation.malId], [900, 9000]);
    assert.equal(patches.has("done"), false);
  });

  it("keeps what the pick itself says when AniList can't find it, and doesn't throw when it's down", async () => {
    const history = [{ id: "lost", date: ago(9), state: "rated", feedback: "good", recommendation: { title: "Nowhere", genre: "Drama, Comedy", episodes: 12, year: 2011 } }];
    const missing = await withFetch(() => json({ data: { Page: { media: [] } } }), () => backfillPastPicks({ history, pause: 0 }));
    assert.deepEqual(missing.result.get("lost").features, { g: ["Drama", "Comedy"], len: "short", era: "2010s", partial: true });
    const down = await withFetch(() => { throw new Error("offline"); }, () => backfillPastPicks({ history: [{ ...history[0], recommendation: { title: "X", anilistId: 5 } }], pause: 0 }));
    assert.equal(down.result.size, 0, "tried again next time");
  });

  it("adds how they scored it on their own list", () => {
    const list = [malEntry(1, "Mushishi", "completed", 10, []), malEntry(2, "Other", "completed", 6, []), malEntry(3, "Third", "completed", 8, [])];
    const deltas = scoreDeltas([{ id: "x", state: "rated", feedback: "good", recommendation: { title: "Mushishi", malId: 1 } }], list);
    assert.equal(deltas.get("x"), 2);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchAniListUserList, toMalShapedList } from "../src/lists.js";
import { answersFromList } from "../src/watchHistory.js";
import { buildUserContext, rankPool, resumeCandidates, selectSeeds, toCandidate, toModelCandidate } from "../src/discovery.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { aniListMedia, json, malEntry, withFetch } from "./fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString();

describe("AniList lists, read by username", () => {
  const media = (id, idMal, english) => ({ id, idMal, title: { romaji: `${english} (romaji)`, english, native: null }, synonyms: [], episodes: 12, genres: ["Drama"], startDate: { year: 2020 }, coverImage: { large: `https://img/${id}` } });
  const lists = [
    { entries: [
      { status: "COMPLETED", score: 8.6, progress: 12, updatedAt: 1700000000, media: media(1, 101, "Done") },
      { status: "REPEATING", score: 9, progress: 3, updatedAt: 1800000000, media: media(2, 102, "Rewatching") },
      { status: "PAUSED", score: 0, progress: 5, updatedAt: 1750000000, media: media(3, null, "No MAL Id") }
    ] },
    { entries: [{ status: "COMPLETED", score: 8.6, progress: 12, updatedAt: 1700000000, media: media(1, 101, "Done") }] } // a custom list repeating it
  ];

  it("converts to MyAnimeList's shape, once per show, newest first", () => {
    const list = toMalShapedList(lists);
    assert.deepEqual(list.map((entry) => entry.alternative_titles.en), ["Rewatching", "No MAL Id", "Done"]);
    assert.deepEqual(list.map((entry) => entry.my_list_status.status), ["completed", "on_hold", "completed"]);
    assert.equal(list[2].my_list_status.score, 9, "scores are rounded to MAL's whole numbers");
    assert.equal(list[1].id, null);
    assert.equal(list[1].anilistId, 3);
    assert.equal(list[1].my_list_status.num_episodes_watched, 5);
  });

  it("says whether a user is missing or private", async () => {
    const missing = await withFetch(() => json({ errors: [{ message: "User not found", status: 404 }] }, 404), () => fetchAniListUserList("nobody").catch((error) => error.message));
    assert.equal(missing.result, "There's no AniList user called nobody.");
    const hidden = await withFetch(() => json({ errors: [{ message: "Private User", status: 404 }] }, 404), () => fetchAniListUserList("Josh").catch((error) => error.message));
    assert.equal(hidden.result, "Josh's AniList list is private, so En can't read it.");
  });

  it("excludes and answers by AniList id, for shows with no MAL id", () => {
    const list = toMalShapedList(lists);
    const context = buildUserContext({ list, history: [], memory: buildRecommendationMemory({ malList: list, history: [] }) });
    assert.ok(context.excludedAnilistIds.has(3));
    const answers = answersFromList({
      list: [{ ...list[1], my_list_status: { ...list[1].my_list_status, status: "completed", score: 9 } }],
      history: [{ id: "x", state: "unrated", recommendation: { title: "Something Else", anilistId: 3 } }],
      sourceName: "AniList"
    });
    assert.deepEqual(answers, [{ id: "x", answer: "good", reflection: "finished it on AniList · 9/10.", scoreDelta: 0 }]);
  });

  it("seeds an AniList list by AniList id", async () => {
    const { by, seeds } = await selectSeeds({ list: toMalShapedList(lists) });
    assert.equal(by, "anilistId");
    assert.ok(seeds.every((seed) => seed.anilistId));
  });
});

describe("pick up where you left off", () => {
  const started = (id, title, status, watched, episodes, updatedDaysAgo, score = 0) =>
    malEntry(id, title, status, score, ["Drama"], { watched, episodes, updated: daysAgo(updatedDaysAgo) });

  it("offers shows set aside for weeks, started but not finished, best-loved first", () => {
    const list = [
      started(1, "Paused Long Ago", "on_hold", 12, 24, 60, 8),
      started(2, "Watching But Stalled", "watching", 3, 12, 30),
      started(3, "Watched Yesterday", "watching", 5, 12, 1),
      started(4, "Never Started", "on_hold", 0, 12, 90),
      started(5, "Finished", "completed", 12, 12, 90),
      started(6, "Third Candidate", "on_hold", 2, 26, 40)
    ];
    const resume = resumeCandidates({ list });
    assert.deepEqual(resume.map((candidate) => candidate.title), ["Paused Long Ago", "Watching But Stalled"]);
    assert.deepEqual(resume[0].resume, { status: "on hold", watched: 12, total: 24, remaining: 12, since: daysAgo(60).slice(0, 7) });
    assert.deepEqual(toModelCandidate(resume[0]).resume, { status: "on hold", stoppedAt: "12/24", since: daysAgo(60).slice(0, 7) });
  });

  it("doesn't suggest the same one again for a month, or for the cooldown after 'not tonight'", () => {
    const list = [started(1, "Paused Long Ago", "on_hold", 12, 24, 60, 8), started(2, "Other", "on_hold", 4, 12, 60)];
    const suggested = [{ mode: "resume", state: "unrated", date: daysAgo(10), recommendation: { title: "Paused Long Ago" } }];
    assert.deepEqual(resumeCandidates({ list, history: suggested }).map((candidate) => candidate.title), ["Other"]);
    const oldSuggestion = [{ mode: "resume", state: "rated", date: daysAgo(45), recommendation: { title: "Paused Long Ago" } }];
    assert.equal(resumeCandidates({ list, history: oldSuggestion }).length, 2);
    const passed = [{ mode: "resume", state: "not_tonight", date: daysAgo(45), not_tonight_at: daysAgo(45), recommendation: { title: "Paused Long Ago" } }];
    assert.deepEqual(resumeCandidates({ list, history: passed }).map((candidate) => candidate.title), ["Other"]);
  });

  it("needs a real list", () => {
    assert.deepEqual(resumeCandidates({ list: "Mushishi, Frieren" }), []);
  });
});

describe("variety in where the pool comes from", () => {
  const favorites = Array.from({ length: 30 }, (_, i) =>
    malEntry(1000 + i, `Fav ${i}`, "completed", 9, ["Drama"], { updated: daysAgo(i * 10) })
  );

  it("always seeds from the three most recent finishes, then rotates the rest", async () => {
    const draw = (values) => { let i = 0; return () => values[i++ % values.length]; };
    const a = (await selectSeeds({ list: favorites, random: draw([0.1, 0.5, 0.9]) })).seeds.map((seed) => seed.title);
    const b = (await selectSeeds({ list: favorites, random: draw([0.8, 0.2, 0.6]) })).seeds.map((seed) => seed.title);
    assert.equal(a.length, 10);
    assert.deepEqual(a.slice(0, 3), ["Fav 0", "Fav 1", "Fav 2"]);
    assert.deepEqual(b.slice(0, 3), ["Fav 0", "Fav 1", "Fav 2"]);
    assert.notDeepEqual(a.slice(3), b.slice(3));
  });

  const context = buildUserContext({ list: [], history: [], memory: buildRecommendationMemory({ malList: [], history: [] }) });
  const seed = (title) => ({ malId: title.length, title, weight: 2 });
  const recs = (prefix, count, rating) => Array.from({ length: count }, (_, i) => ({ rating, candidate: toCandidate(aniListMedia(prefix * 1000 + i, `${prefix === 1 ? "Famous" : "Quiet"} pick ${i}`)) }));

  it("scores each recommendation against its own favorite's best, so a famous favorite doesn't win on volume", () => {
    const pool = rankPool({
      seedGroups: [{ seed: seed("Famous Show"), recs: recs(1, 1, 5000) }, { seed: seed("Quiet Show"), recs: recs(2, 1, 40) }],
      context
    });
    assert.equal(pool[0].rankScore, pool[1].rankScore, "each is its favorite's top recommendation");
  });

  it("lets no single favorite fill more than six of the 'similar' slots while others have candidates", () => {
    const pool = rankPool({
      seedGroups: [{ seed: seed("Famous Show"), recs: recs(1, 12, 5000) }, { seed: seed("Quiet Show"), recs: recs(2, 12, 4000) }],
      context,
      limit: 14
    });
    const famous = pool.filter((candidate) => candidate.because[0] === "Famous Show").length;
    assert.ok(famous <= 8, `famous show supplied ${famous} of 14`);
    assert.ok(pool.filter((candidate) => candidate.because[0] === "Quiet Show").length >= 6);
  });
});

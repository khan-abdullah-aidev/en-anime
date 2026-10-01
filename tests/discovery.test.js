import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOpenCandidatePool,
  buildUserContext,
  moodFilters,
  rankPool,
  selectSeeds,
  toAniListFilters,
  toCandidate,
  toModelCandidate
} from "../src/discovery.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { buildTasteProfile } from "../src/tasteProfile.js";
import { MAL_LIST, aniListMedia, json, relation, withFetch } from "./fixtures.js";

const FRIEREN = { malId: 2, title: "Frieren: Beyond Journey's End", weight: 3 };
const history = [{ state: "rated", feedback: "meh", recommendation: { title: "Previously Picked", anilistId: 999 } }];
const memory = buildRecommendationMemory({ malList: MAL_LIST, history });
const context = buildUserContext({ list: MAL_LIST, history, memory });
const tasteProfile = buildTasteProfile({ malList: MAL_LIST, feedbackHistory: history });

const recs = [
  [700, aniListMedia(101, "Delicious in Dungeon", { genres: ["Adventure", "Comedy"] })],
  [300, aniListMedia(102, "To Your Eternity")],
  [500, aniListMedia(103, "Mushishi", { idMal: 4 })], // on the user's list
  [500, aniListMedia(104, "Adult Title", { isAdult: true })],
  [500, aniListMedia(105, "A Music Video", { format: "MUSIC" })],
  [500, aniListMedia(106, "Some Show Season 2", { relations: { edges: [relation("PREQUEL", { id: 1060, idMal: 7777, title: "Some Show" })] } })],
  [500, aniListMedia(107, "Frieren: Beyond Journey's End Season 2", { relations: { edges: [relation("PREQUEL", { id: 1070, idMal: 2, title: "Frieren: Beyond Journey's End" })] } })],
  [500, aniListMedia(108, "Frieren Recap Film", { format: "MOVIE", relations: { edges: [relation("PARENT", { id: 1070, idMal: 2, title: "Frieren: Beyond Journey's End" })] } })],
  [500, aniListMedia(109, "Not Out Yet", { status: "NOT_YET_RELEASED" })],
  [500, aniListMedia(999, "Previously Picked")] // En recommended it before
];
const seedGroups = [{ seed: FRIEREN, recs: recs.map(([rating, media]) => ({ rating, candidate: toCandidate(media) })) }];
const quiet = aniListMedia(201, "Natsume's Book of Friends", { genres: ["Slice of Life"], averageScore: 70, tags: [{ name: "Iyashikei", rank: 90 }] });
const plain = aniListMedia(202, "Plain Drama", { genres: ["Drama"], averageScore: 70 });
const discovery = { mood: [toCandidate(quiet)], genre: [toCandidate(plain)], recent: [toCandidate(aniListMedia(203, "New This Year", { startDate: { year: 2026 } }))] };

describe("AniList media -> candidate", () => {
  it("keeps the fields the pool needs and drops spoiler / weak tags", () => {
    const candidate = toCandidate(aniListMedia(1, "Show", {
      romaji: "Shou",
      native: "ショウ",
      tags: [{ name: "Iyashikei", rank: 90 }, { name: "Twist", rank: 95, isMediaSpoiler: true }, { name: "Minor", rank: 40 }]
    }));
    assert.equal(candidate.title, "Show");
    assert.equal(candidate.title_jp, "ショウ");
    assert.deepEqual(candidate.alternative_titles.synonyms, ["Shou"]);
    assert.deepEqual(candidate.tags, ["Iyashikei"]);
    assert.equal(candidate.image_url, "https://img.example/1.jpg");
  });

  it("treats PREQUEL links as sequels and PARENT links as recaps / side stories", () => {
    assert.equal(toCandidate(recs[6][1]).prequels[0].malId, 2);
    assert.equal(toCandidate(recs[7][1]).isSideStory, true);
    assert.equal(toCandidate(recs[7][1]).prequels.length, 0);
  });
});

describe("ranking the open pool", () => {
  const pool = rankPool({ seedGroups, discovery, context, tasteProfile, mood: "something quiet" });
  const titles = pool.map((candidate) => candidate.title);

  it("drops what's on the list, already recommended, adult, non-shows, unreleased, recaps", () => {
    for (const title of ["Mushishi", "Previously Picked", "Adult Title", "A Music Video", "Not Out Yet", "Frieren Recap Film"]) {
      assert.ok(!titles.includes(title), `${title} should be filtered out`);
    }
  });

  it("skips sequels of unseen shows but keeps continuations of finished ones", () => {
    assert.ok(!titles.includes("Some Show Season 2"));
    const continuation = pool.find((candidate) => candidate.title === "Frieren: Beyond Journey's End Season 2");
    assert.equal(continuation.continues, "Frieren: Beyond Journey's End");
  });

  it("ranks by how strongly fans of the user's favorites recommend it, and says which favorite", () => {
    assert.ok(titles.indexOf("Delicious in Dungeon") < titles.indexOf("To Your Eternity"));
    assert.deepEqual(pool.find((candidate) => candidate.title === "Delicious in Dungeon").because, [FRIEREN.title]);
  });

  it("boosts what tonight's mood asks for", () => {
    const quietRank = pool.find((candidate) => candidate.title === "Natsume's Book of Friends").rankScore;
    const plainRank = pool.find((candidate) => candidate.title === "Plain Drama").rankScore;
    assert.ok(quietRank > plainRank);
  });

  it("keeps room for mood picks even when 'similar' has plenty of higher-ranked ones", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ rating: 900, candidate: toCandidate(aniListMedia(1000 + i, `Similar ${i}`, { averageScore: 90 })) }));
    const moodOnes = Array.from({ length: 15 }, (_, i) => toCandidate(aniListMedia(3000 + i, `Mood ${i}`, { averageScore: 60 })));
    const big = rankPool({ seedGroups: [{ seed: FRIEREN, recs: many }], discovery: { mood: moodOnes }, context, tasteProfile, mood: "", limit: 60 });
    assert.equal(big.length, 60);
    assert.ok(big.filter((candidate) => candidate.title.startsWith("Mood")).length >= 12);
  });

  it("gives the model a compact view with the 'because you liked' hook", () => {
    const view = toModelCandidate(pool.find((candidate) => candidate.title === "Delicious in Dungeon"));
    assert.deepEqual(Object.keys(view).sort(), ["becauseYouLiked", "episodes", "format", "genres", "score", "title", "title_jp", "year"]);
    assert.deepEqual(view.becauseYouLiked, [FRIEREN.title]);
  });
});

describe("mood + genre filters", () => {
  it("maps mood words to real AniList genres and tags", () => {
    assert.deepEqual(moodFilters("something quiet"), { genres: ["Slice of Life"], tags: ["Iyashikei"] });
    assert.deepEqual(moodFilters("i need to feel something"), { genres: ["Drama"], tags: ["Tragedy"] });
    assert.deepEqual(moodFilters(""), { genres: [], tags: [] });
  });

  it("maps MAL and catalog genre names onto AniList's", () => {
    assert.deepEqual(toAniListFilters(["Slice of Life", "slice-of-life", "Iyashikei", "Suspense", "Award Winning"]), {
      genres: ["Slice of Life", "Thriller"],
      tags: ["Iyashikei"]
    });
  });
});

describe("seeds", () => {
  it("uses the user's favorites by MAL id, best first", async () => {
    const { by, seeds } = await selectSeeds({ list: MAL_LIST, history: [] });
    assert.equal(by, "malId");
    assert.deepEqual(seeds.map((seed) => seed.title), ["Frieren: Beyond Journey's End", "Mushishi", "Barakamon", "Laid-Back Camp"]);
  });
});

describe("building the pool", () => {
  const anilistReplies = (url, body) => {
    if (body.query.includes("recommendations(")) {
      return json({ data: { Page: { media: [{ id: 50, idMal: 2, recommendations: { nodes: recs.slice(0, 2).concat(
        Array.from({ length: 8 }, (_, i) => [100, aniListMedia(400 + i, `Extra ${i}`)])
      ).map(([rating, media]) => ({ rating, mediaRecommendation: media })) } }] } } });
    }
    return json({ data: { mood: { media: [quiet] }, genre: { media: [plain] }, recent: { media: [] } } });
  };

  it("draws from AniList", async () => {
    const { result, calls } = await withFetch(anilistReplies, () =>
      buildOpenCandidatePool({ mood: "something quiet", list: MAL_LIST, history, tasteProfile, recentPatterns: {}, memory })
    );
    assert.equal(result.source, "anilist");
    assert.ok(result.candidates.some((candidate) => candidate.title === "Delicious in Dungeon"));
    assert.ok(result.candidates.some((candidate) => candidate.title === "Natsume's Book of Friends"));
    assert.equal(calls.length, 2, "one request for the favorites' recommendations, one for discovery");
  });

  it("falls back to the curated catalog when AniList is unreachable", async () => {
    const { result } = await withFetch(() => { throw new Error("offline"); }, () =>
      buildOpenCandidatePool({ mood: "", list: MAL_LIST, history, tasteProfile, recentPatterns: {}, memory })
    );
    assert.equal(result.source, "catalog");
    assert.ok(result.candidates.length > 10);
  });

  it("in manual mode, excludes the typed favorites by their resolved AniList id", async () => {
    const mushishi = aniListMedia(457, "Mushi-shi", { romaji: "Mushishi", idMal: 457 });
    const replies = (url, body) => {
      if (body.query.includes("search:")) return json({ data: { Page: { media: [mushishi] } } });
      if (body.query.includes("recommendations(")) {
        return json({ data: { Page: { media: [{ id: 457, idMal: 457, recommendations: { nodes: Array.from({ length: 9 }, (_, i) => ({ rating: 50, mediaRecommendation: aniListMedia(500 + i, `Rec ${i}`) })) } }] } } });
      }
      // Discovery happens to surface the show the user typed.
      return json({ data: { mood: { media: [mushishi] }, genre: { media: [] }, recent: { media: [] } } });
    };
    const manualMemory = buildRecommendationMemory({ malList: "mushishi", history: [] });
    const { result } = await withFetch(replies, () =>
      buildOpenCandidatePool({ mood: "something quiet", list: "mushishi", history: [], tasteProfile: {}, recentPatterns: {}, memory: manualMemory })
    );
    assert.equal(result.source, "anilist");
    assert.ok(!result.candidates.some((candidate) => candidate.anilistId === 457));
  });
});

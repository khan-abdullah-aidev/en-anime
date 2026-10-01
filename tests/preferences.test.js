import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyTasteCorrections,
  exclusionFilter,
  loadPreferences,
  normalizePreferences,
  updatePreferences,
  userSaidFor
} from "../src/preferences.js";
import { buildOpenCandidatePool, rankPool, resumeCandidates, selectSeeds, toCandidate, buildUserContext } from "../src/discovery.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { describeGenreAffinity } from "../src/tasteProfile.js";
import { MAL_LIST, aniListMedia, json, malEntry, withFetch } from "./fixtures.js";
import { memoryStorage } from "./storage-shim.js";

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

describe("leaving genres out", () => {
  const filter = exclusionFilter(["Horror", "Isekai", "Idols", "Slice of Life"]);

  it("gives AniList its own genre and tag names", () => {
    assert.deepEqual(filter.genres, ["Horror", "Slice of Life"]);
    assert.deepEqual(filter.tags, ["Isekai", "Idol"]);
  });

  it("matches candidates from AniList, the user's MAL list and the curated catalog alike", () => {
    assert.ok(filter.matches(toCandidate(aniListMedia(1, "Scary", { genres: ["Horror"] }))));
    // A tag too minor to show the model still counts if it's a real part of the show.
    assert.ok(filter.matches(toCandidate(aniListMedia(2, "Another World", { tags: [{ name: "Isekai", rank: 55 }] }))));
    assert.ok(!filter.matches(toCandidate(aniListMedia(3, "Barely Isekai", { tags: [{ name: "Isekai", rank: 20 }] }))));
    assert.ok(filter.matches({ genres: ["Music", "Idols (Female)"] }), "MAL's spelling");
    assert.ok(filter.matches({ genres: ["slice-of-life", "drama"], themes: [] }), "the catalog's spelling");
    assert.ok(!filter.matches({ genres: ["Drama"] }));
    assert.ok(!exclusionFilter([]).matches({ genres: ["Horror"] }));
  });

  it("keeps left-out shows out of the ranked pool and out of 'pick up where you left off'", () => {
    const context = buildUserContext({ list: [], history: [], memory: buildRecommendationMemory({ malList: [], history: [] }) });
    const discovery = { genre: [toCandidate(aniListMedia(10, "Haunted", { genres: ["Horror"] })), toCandidate(aniListMedia(11, "Gentle", { genres: ["Drama"] }))] };
    const titles = rankPool({ discovery, context, exclude: filter }).map((candidate) => candidate.title);
    assert.deepEqual(titles, ["Gentle"]);

    const started = (id, title, genres) => malEntry(id, title, "on_hold", 8, genres, { watched: 3, episodes: 12, updated: "2026-01-01T00:00:00Z" });
    const resume = resumeCandidates({ list: [started(1, "Haunted House", ["Horror"]), started(2, "Long Drama", ["Drama"])] });
    assert.deepEqual(resume.filter((candidate) => !filter.matches(candidate)).map((candidate) => candidate.title), ["Long Drama"]);
  });

  it("asks AniList to leave them out, and doesn't search the favorites it just left out", async () => {
    const { calls } = await withFetch(() => json({ data: {} }), () =>
      buildOpenCandidatePool({
        mood: "",
        list: [],
        history: [],
        tasteProfile: { favoriteGenres: ["Horror", "Drama"] },
        recentPatterns: {},
        memory: buildRecommendationMemory({ malList: [], history: [] }),
        exclude: exclusionFilter(["Horror", "Isekai"])
      })
    );
    const discovery = calls.find((call) => call.body?.query.includes("genre0"));
    assert.match(discovery.body.query, /genre_not_in: \["Horror"\]/);
    assert.match(discovery.body.query, /tag_not_in: \["Isekai"\]/);
    assert.ok(!discovery.body.query.includes('genre_in: ["Horror"]'));
    assert.ok(discovery.body.query.includes('genre_in: ["Drama"]'));
  });
});

describe("correcting what En inferred", () => {
  const inferred = { favoriteGenres: ["Drama", "Slice of Life", "Mystery"], dislikedTropes: ["Horror", "Comedy"] };

  it("adds what the user asked for, drops what they said En got wrong, and what they left out", () => {
    const corrected = applyTasteCorrections(inferred, normalizePreferences({
      moreOf: ["Sports"],
      notFavorite: ["drama"],
      notDisliked: ["Comedy"],
      excludedGenres: ["Mystery"]
    }));
    assert.deepEqual(corrected.favoriteGenres, ["Sports", "Slice of Life"]);
    assert.deepEqual(corrected.dislikedTropes, ["Horror"]);
  });

  it("a genre the user wants more of is never treated as a dislike", () => {
    const corrected = applyTasteCorrections(inferred, normalizePreferences({ moreOf: ["Horror"] }));
    assert.deepEqual(corrected.dislikedTropes, ["Comedy"]);
    assert.equal(corrected.favoriteGenres[0], "Horror");
  });

  it("only sends the model what the user actually said", () => {
    assert.equal(userSaidFor(normalizePreferences({})), null);
    assert.deepEqual(userSaidFor(normalizePreferences({ notes: "  no fan service ", excludedGenres: ["Ecchi"] })), {
      notes: "no fan service",
      neverSuggest: ["Ecchi"]
    });
  });

  it("stamps every change, so the newest copy wins when devices sync", () => {
    const before = loadPreferences();
    assert.equal(before.updatedAt, "");
    const after = updatePreferences({ excludedGenres: ["Horror", "Not A Genre"] });
    assert.deepEqual(after.excludedGenres, ["Horror"]);
    assert.ok(Date.parse(after.updatedAt) > 0);
    assert.deepEqual(loadPreferences(), after);
  });

  it("shows the evidence behind each genre", () => {
    const evidence = describeGenreAffinity(MAL_LIST);
    assert.equal(evidence.sliceoflife.count, 3);
    assert.ok(evidence.sliceoflife.scoreDelta > 0);
    assert.equal(evidence.gore.dropped, 2);
    assert.ok(evidence.gore.scoreDelta < 0);
  });
});

describe("favorites the user asked En not to start from", () => {
  it("are left out of the seeds, by id or by title", async () => {
    const { seeds } = await selectSeeds({
      list: MAL_LIST,
      history: [],
      muted: [{ title: "Frieren", malId: 2 }, { title: "Laid-Back Camp" }]
    });
    assert.deepEqual(seeds.map((seed) => seed.title), ["Mushishi", "Barakamon"]);
  });
});

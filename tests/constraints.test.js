import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenCandidatePool, buildRequestFilters, meetsConstraints, parseConstraints, rankPool, toCandidate, buildUserContext } from "../src/discovery.js";
import { streamingLinks } from "../src/streaming.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { MAL_LIST, aniListMedia, json, withFetch } from "./fixtures.js";

describe("hard limits read from the mood", () => {
  const cases = [
    ["after a long day, something quiet", {}],
    ["rain on a Tuesday", {}],
    ["a movie, something that makes me cry", { formats: ["MOVIE"] }],
    ["something short and funny", { maxEpisodes: 13 }],
    ["under 6 episodes please", { maxEpisodes: 5 }],
    ["at most 12 episodes", { maxEpisodes: 12 }],
    ["a long series to sink into", { minEpisodes: 24 }],
    ["whatever's airing right now", { status: "RELEASING" }],
    ["a 90s classic", { yearMin: 1990, yearMax: 1999 }],
    ["something from the 2010s", { yearMin: 2010, yearMax: 2019 }],
    ["an old-school one", { yearMax: 2005 }]
  ];
  for (const [mood, expected] of cases) {
    it(JSON.stringify(mood), () => assert.deepEqual(parseConstraints(mood), expected));
  }
});

describe("'not tonight' reasons steer the next pick", () => {
  it("too long: a 12-episode show means films/very short; a long series means one cour", () => {
    assert.equal(buildRequestFilters({ mood: "", passedOver: [{ reason: "too long", episodes: 12 }] }).constraints.maxEpisodes, 2);
    assert.equal(buildRequestFilters({ mood: "", passedOver: [{ reason: "too long", episodes: 64 }] }).constraints.maxEpisodes, 13);
  });

  it("too heavy / too light shift the mood used for discovery", () => {
    assert.match(buildRequestFilters({ mood: "quiet", passedOver: [{ reason: "too heavy" }] }).discoveryMood, /lighthearted/);
    assert.match(buildRequestFilters({ mood: "quiet", passedOver: [{ reason: "too light" }] }).discoveryMood, /heavy/);
  });
});

describe("applying the limits", () => {
  it("checks AniList and catalog candidates alike", () => {
    assert.equal(meetsConstraints({ format: "MOVIE", episodes: 1, year: 2018 }, { formats: ["MOVIE"] }), true);
    assert.equal(meetsConstraints({ format: "TV", episodes: 12, year: 2018 }, { formats: ["MOVIE"] }), false);
    assert.equal(meetsConstraints({ episodes: 1, year: 2016 }, { formats: ["MOVIE"] }), true, "catalog films have no format, just 1 episode");
    assert.equal(meetsConstraints({ format: "TV", status: "RELEASING", episodes: null }, { maxEpisodes: 13 }), false, "unknown length can't be called short");
    assert.equal(meetsConstraints({ format: "TV", status: "FINISHED", year: 1995 }, { yearMin: 1990, yearMax: 1999 }), true);
  });

  it("filters the ranked pool", () => {
    const memory = buildRecommendationMemory({ malList: MAL_LIST, history: [] });
    const context = buildUserContext({ list: MAL_LIST, history: [], memory });
    const discovery = {
      genre: [toCandidate(aniListMedia(1, "A Film", { format: "MOVIE", episodes: 1 })), toCandidate(aniListMedia(2, "A Series", { episodes: 24 }))]
    };
    const pool = rankPool({ discovery, context, constraints: { formats: ["MOVIE"] } });
    assert.deepEqual(pool.map((candidate) => candidate.title), ["A Film"]);
  });
});

describe("discovery queries", () => {
  const memory = buildRecommendationMemory({ malList: MAL_LIST, history: [] });
  const tasteProfile = { favoriteGenres: ["Drama", "Slice of Life", "Comedy"], dislikedTropes: [] };
  const empty = (url, body) => (body.query.includes("recommendations(") ? json({ data: { Page: { media: [] } } }) : json({ data: {} }));

  it("asks AniList once per genre, because genre_in means 'has all of these'", async () => {
    const { calls } = await withFetch(empty, () =>
      buildOpenCandidatePool({ mood: "something quiet and sad", list: MAL_LIST, history: [], tasteProfile, recentPatterns: {}, memory })
    );
    const discovery = calls.find((call) => !call.body.query.includes("recommendations(")).body.query;
    assert.ok(!/genre_in: \[[^\]]*,/.test(discovery), "no genre_in lists more than one genre");
    assert.ok(!/tag_in: \[[^\]]*,/.test(discovery), "no tag_in lists more than one tag");
    assert.match(discovery, /genre0: Page/);
    assert.match(discovery, /genre1: Page/);
    assert.match(discovery, /mood0: Page/);
  });

  it("puts the mood's limits into the query, sorts airing shows by trend, and drops 'recent' under a year limit", async () => {
    const airing = await withFetch(empty, () => buildOpenCandidatePool({ mood: "airing now", list: MAL_LIST, history: [], tasteProfile, recentPatterns: {}, memory }));
    const airingQuery = airing.calls.find((call) => !call.body.query.includes("recommendations(")).body.query;
    assert.match(airingQuery, /status: RELEASING/);
    assert.match(airingQuery, /TRENDING_DESC/);
    assert.ok(!airingQuery.includes("averageScore_greater"));

    const nineties = await withFetch(empty, () => buildOpenCandidatePool({ mood: "a 90s classic", list: MAL_LIST, history: [], tasteProfile, recentPatterns: {}, memory }));
    const ninetiesQuery = nineties.calls.find((call) => !call.body.query.includes("recommendations(")).body.query;
    assert.match(ninetiesQuery, /startDate_greater: 19900000/);
    assert.match(ninetiesQuery, /startDate_lesser: 20000000/);
    assert.ok(!ninetiesQuery.includes("recent: Page"));
  });

  it("relaxes the limits rather than failing when nothing fits, and says so", async () => {
    const tvOnly = (url, body) =>
      body.query.includes("recommendations(")
        ? json({ data: { Page: { media: [] } } })
        : json({ data: { genre0: { media: Array.from({ length: 10 }, (_, i) => aniListMedia(700 + i, `Series ${i}`, { episodes: 24 })) } } });
    const { result } = await withFetch(tvOnly, () =>
      buildOpenCandidatePool({ mood: "a movie", list: MAL_LIST, history: [], tasteProfile: { favoriteGenres: ["Drama"] }, recentPatterns: {}, memory })
    );
    assert.equal(result.constraintsRelaxed, true);
    assert.deepEqual(result.constraints, { formats: ["MOVIE"] });
    assert.ok(result.candidates.length >= 3);
  });
});

describe("where it streams", () => {
  it("keeps one streaming link per site and ignores info/social links", () => {
    const links = streamingLinks([
      { site: "Crunchyroll", url: "https://cr/a", type: "STREAMING" },
      { site: "Crunchyroll", url: "https://cr/b", type: "STREAMING" },
      { site: "Official Site", url: "https://x", type: "INFO" },
      { site: "Twitter", url: "https://t", type: "SOCIAL" },
      { site: "Netflix", url: "https://n", type: "STREAMING" }
    ]);
    assert.deepEqual(links, [{ site: "Crunchyroll", url: "https://cr/a" }, { site: "Netflix", url: "https://n" }]);
  });

  it("travels with the candidate", () => {
    const candidate = toCandidate(aniListMedia(1, "Show", { externalLinks: [{ site: "Netflix", url: "https://n", type: "STREAMING" }] }));
    assert.deepEqual(candidate.watchLinks, [{ site: "Netflix", url: "https://n" }]);
  });
});

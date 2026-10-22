import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import "./storage-shim.js";
import { aniListIsDown, aniListRequest, isAniListDownError, resetAniListDown, resolveAnimeOnAniList } from "../src/anilist.js";
import { buildOpenCandidatePool, malGroups } from "../src/discovery.js";
import { toMalCandidate } from "../api/_lib/malCatalog.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function withFetch(reply, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    return reply(String(url), body);
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const node = (id, title, extra = {}) => ({
  id, title, alternative_titles: { en: title, ja: title, synonyms: [] }, media_type: "tv", status: "finished_airing",
  num_episodes: 12, average_episode_duration: 1440, start_season: { year: 2015 }, mean: 8.2, num_list_users: 50000,
  genres: [{ name: "Slice of Life" }, { name: "Drama" }], main_picture: { large: `https://img.example/${id}.jpg` }, nsfw: "white", ...extra
});
const discoverReply = {
  seeds: [{ malId: 457, recs: Array.from({ length: 10 }, (_, i) => ({ malId: 9000 + i, weight: 40 - i })) }],
  candidates: [
    ...Array.from({ length: 10 }, (_, i) => toMalCandidate(node(9000 + i, `MAL Rec ${i}`))),
    toMalCandidate(node(457, "Mushishi")),
    toMalCandidate(node(9100, "Season Two", { related_anime: [{ relation_type: "prequel", node: { id: 9101, title: "Season One" } }] }))
  ],
  charts: { top: [457, 9100], popular: [], airing: [], season: [9003] }
};

beforeEach(() => resetAniListDown());

describe("when AniList is down", () => {
  it("one refusal marks it down, and every request after fails at once without asking it", async () => {
    const { calls } = await withFetch(
      () => json({ errors: [{ message: "The AniList API has been temporarily disabled due to severe stability issues." }] }, 403),
      async () => {
        await assert.rejects(aniListRequest("{ x }"), isAniListDownError);
        await assert.rejects(aniListRequest("{ y }"), isAniListDownError);
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(aniListIsDown(), true);
  });

  it("a blocked request (how a refusal looks from the browser) counts too; a private list doesn't", async () => {
    await withFetch(() => { throw new TypeError("Failed to fetch"); }, () => assert.rejects(aniListRequest("{ x }"), isAniListDownError));
    assert.equal(aniListIsDown(), true);
    resetAniListDown();
    await withFetch(() => json({ errors: [{ message: "Private User" }] }, 404), () => assert.rejects(aniListRequest("{ x }"), /Private User/));
    assert.equal(aniListIsDown(), false);
  });

  it("a title is matched on MyAnimeList instead, unless only an AniList id will do", async () => {
    const reply = (url) =>
      url.startsWith("/api/mal-search")
        ? json({ match: { anilistId: null, malId: 37521, title: "Vinland Saga" } })
        : json({ errors: [{ message: "temporarily disabled" }] }, 403);
    const { result } = await withFetch(reply, () => resolveAnimeOnAniList("Vinland Saga"));
    assert.deepEqual([result.anilistId, result.malId], [null, 37521]);
    const { result: strict } = await withFetch(reply, () => resolveAnimeOnAniList("Vinland Saga", { anilistOnly: true }));
    assert.equal(strict, null);
  });

  it("the pool is built from MyAnimeList, without sequels of unwatched shows or the user's own list", async () => {
    const list = [{ id: 457, title: "Mushishi", my_list_status: { status: "completed", score: 10, updated_at: "2026-09-01T00:00:00Z" }, genres: ["Slice of Life"] }];
    const memory = buildRecommendationMemory({ malList: list, history: [] });
    const { result, calls } = await withFetch(
      (url) => (url.startsWith("/api/mal-discover") ? json(discoverReply) : json({ errors: [{ message: "temporarily disabled" }] }, 403)),
      () => buildOpenCandidatePool({ mood: "something quiet", list, history: [], tasteProfile: { favoriteGenres: ["Slice of Life"] }, recentPatterns: {}, memory })
    );
    assert.match(result.source, /^myanimelist/);
    const titles = result.candidates.map((candidate) => candidate.title);
    assert.ok(titles.includes("MAL Rec 0"));
    assert.ok(!titles.includes("Mushishi"), "already on their list");
    assert.ok(!titles.includes("Season Two"), "a sequel of something they haven't seen");
    assert.ok(calls.filter((call) => call.url.includes("anilist")).length <= 2, "only the first, parallel requests reach AniList");
    assert.match(calls.find((call) => call.url.startsWith("/api/mal-discover")).url, /seeds=457/);

    // The next pick doesn't wait on AniList at all.
    const again = await withFetch(
      (url) => (url.startsWith("/api/mal-discover") ? json(discoverReply) : json({ errors: [{ message: "temporarily disabled" }] }, 403)),
      () => buildOpenCandidatePool({ mood: "", list, history: [], tasteProfile: {}, recentPatterns: {}, memory })
    );
    assert.equal(again.calls.filter((call) => call.url.includes("anilist")).length, 0);
  });

  it("with MyAnimeList down as well, the curated catalog still answers", async () => {
    const { result } = await withFetch(() => json({}, 503), () =>
      buildOpenCandidatePool({ mood: "", list: [], history: [], tasteProfile: {}, recentPatterns: {}, memory: buildRecommendationMemory({ malList: [], history: [] }) })
    );
    assert.equal(result.source, "catalog");
  });

  it("MAL's answer becomes seed groups and genre, mood and recent buckets", () => {
    const groups = malGroups(discoverReply, [{ malId: 457, title: "Mushishi", weight: 1 }], { tasteProfile: { favoriteGenres: ["Drama"] }, moodWanted: { genres: ["Slice of Life"], tags: [] } });
    assert.equal(groups.seedGroups[0].recs.length, 10);
    assert.deepEqual(groups.discovery.genre.map((c) => c.malId), [457, 9100]);
    assert.equal(groups.discovery.recent[0].malId, 9003);
    assert.ok(groups.discovery.mood.length >= 10);
  });
});

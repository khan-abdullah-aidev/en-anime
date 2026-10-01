import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import handler from "../api/mal-user-list.js";
import { buildResponseSchema } from "../api/_lib/schemas.js";
import { PROMPTS } from "../api/_lib/prompts.js";
import { buildTogetherContext, buildTogetherPool, combineTasteProfiles, rankPool, toCandidate, toModelCandidate } from "../src/discovery.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { MAL_LIST, aniListMedia, json, malEntry, relation, withFetch } from "./fixtures.js";

async function call(query) {
  const res = { code: 0, body: null, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: "GET", query }, res);
  return res;
}

const savedClientId = process.env.MAL_CLIENT_ID;
beforeEach(() => { process.env.MAL_CLIENT_ID = "client-123"; });
after(() => { process.env.MAL_CLIENT_ID = savedClientId; });

describe("reading the other person's public MAL list", () => {
  it("rejects anything that isn't a MAL username", async () => {
    for (const user of ["", "a", "has space", "way-too-long-for-mal-username", "../etc"]) {
      assert.equal((await call({ user })).code, 400, user);
    }
  });

  it("reads every page with only the app client ID", async () => {
    const page = (titles, next) => json({
      data: titles.map((title, i) => ({ node: { id: title.length * 100 + i, title, genres: [{ name: "Drama" }] }, list_status: { status: "completed", score: 8 } })),
      paging: next ? { next } : {}
    });
    const { result, calls } = await withFetch(
      (url) => (url.includes("offset=1000") ? page(["Third"]) : page(["First", "Second"], "https://api.myanimelist.net/v2/users/Sam/animelist?offset=1000")),
      () => call({ user: "Sam" })
    );
    assert.equal(result.code, 200);
    assert.deepEqual(result.body.data.map((entry) => entry.title), ["First", "Second", "Third"]);
    assert.ok(calls[0].url.startsWith("https://api.myanimelist.net/v2/users/Sam/animelist?"));
    assert.deepEqual(calls[0].headers, { "X-MAL-CLIENT-ID": "client-123" });
  });

  it("explains a missing user or a private list", async () => {
    const missing = await withFetch(() => json({ error: "not_found" }, 404), () => call({ user: "nobody_here" }));
    assert.equal(missing.result.code, 404);
    assert.match(missing.result.body.error, /no MyAnimeList user called nobody_here/);

    const hidden = await withFetch(() => json({ error: "forbidden" }, 403), () => call({ user: "Sam" }));
    assert.equal(hidden.result.code, 403);
    assert.match(hidden.result.body.error, /private/);
  });
});

describe("the pool for two", () => {
  const partnerList = [
    malEntry(5001, "Their Favorite", "completed", 10, ["Comedy"]),
    malEntry(5002, "They Saw This", "completed", 7, ["Drama"]),
    malEntry(5003, "On Their List", "plan_to_watch", 0, ["Drama"])
  ];
  const memory = buildRecommendationMemory({ malList: MAL_LIST, history: [] });
  const you = { list: MAL_LIST, history: [], memory, tasteProfile: { favoriteGenres: ["Drama", "Slice of Life"], dislikedTropes: ["Gore"] } };
  const partner = { list: partnerList, tasteProfile: { favoriteGenres: ["Comedy", "Drama"], dislikedTropes: ["Horror"] } };
  const context = buildTogetherContext({ you, partner });
  const yourSeed = { malId: 2, title: "Frieren: Beyond Journey's End", weight: 2, owner: "you" };
  const theirSeed = { malId: 5001, title: "Their Favorite", weight: 2, owner: "partner" };
  const rec = (rating, media) => ({ rating, candidate: toCandidate(media) });

  const pool = rankPool({
    seedGroups: [
      { seed: yourSeed, recs: [rec(300, aniListMedia(1, "Both Of You")), rec(300, aniListMedia(2, "Just You"))] },
      { seed: theirSeed, recs: [
        rec(300, aniListMedia(1, "Both Of You")),
        rec(300, aniListMedia(3, "They Saw This", { idMal: 5002 })),
        rec(100, aniListMedia(4, "On Their List", { idMal: 5003 })),
        rec(300, aniListMedia(5, "A Sequel", { relations: { edges: [relation("PREQUEL", { id: 50, idMal: 2, title: "Frieren: Beyond Journey's End" })] } }))
      ] }
    ],
    context,
    tasteProfile: combineTasteProfiles(you.tasteProfile, partner.tasteProfile)
  });
  const byTitle = Object.fromEntries(pool.map((candidate) => [candidate.title, candidate]));

  it("leaves out anything the other person has seen, and every sequel", () => {
    assert.equal(byTitle["They Saw This"], undefined);
    assert.equal(byTitle["A Sequel"], undefined, "even one the user finished the first part of");
  });

  it("keeps what's on their plan-to-watch, flagged", () => {
    assert.equal(byTitle["On Their List"].onTheirPlanToWatch, true);
    assert.equal(toModelCandidate(byTitle["On Their List"]).onTheirPlanToWatch, true);
  });

  it("ranks what fans of both people's favorites recommend first, and says whose", () => {
    assert.equal(pool[0].title, "Both Of You");
    assert.equal(pool[0].bothLiked, true);
    const view = toModelCandidate(pool[0]);
    assert.deepEqual(view.becauseYouLiked, [yourSeed.title]);
    assert.deepEqual(view.becauseTheyLiked, [theirSeed.title]);
    assert.ok(byTitle["Both Of You"].rankScore > byTitle["Just You"].rankScore);
  });

  it("merges tastes: shared favorites first, either person's dislikes avoided", () => {
    const merged = combineTasteProfiles(you.tasteProfile, partner.tasteProfile);
    assert.equal(merged.favoriteGenres[0], "Drama");
    assert.deepEqual(merged.dislikedTropes.sort(), ["Gore", "Horror"]);
  });

  it("handles a typed-in partner list too", () => {
    const typed = buildTogetherContext({ you, partner: { list: "Both Of You, Something Else", tasteProfile: {} } });
    const typedPool = rankPool({ seedGroups: [{ seed: yourSeed, recs: [rec(300, aniListMedia(1, "Both Of You")), rec(300, aniListMedia(2, "Just You"))] }], context: typed });
    assert.deepEqual(typedPool.map((candidate) => candidate.title), ["Just You"]);
  });

  it("builds from both people's favorites in three AniList requests", async () => {
    const replies = (url, body) => {
      if (body.query.includes("recommendations(")) {
        const theirs = body.variables.ids.includes(5001);
        return json({ data: { Page: { media: [{
          id: theirs ? 9001 : 9002,
          idMal: theirs ? 5001 : 2,
          recommendations: { nodes: Array.from({ length: 6 }, (_, i) => ({ rating: 50, mediaRecommendation: aniListMedia((theirs ? 800 : 900) + i, `${theirs ? "Theirs" : "Yours"} ${i}`) })) }
        }] } } });
      }
      return json({ data: {} });
    };
    const { result, calls } = await withFetch(replies, () => buildTogetherPool({ mood: "", you, partner, recentPatterns: {} }));
    assert.equal(result.source, "anilist");
    assert.equal(calls.length, 3);
    assert.ok(result.candidates.some((candidate) => candidate.title.startsWith("Theirs")));
    assert.ok(result.candidates.some((candidate) => candidate.title.startsWith("Yours")));
  });
});

describe("the model side", () => {
  it("has a prompt for two that must name something from each history", () => {
    assert.match(PROMPTS.together, /partner\.watchHistory/);
    assert.match(PROMPTS.together, /MUST name one specific title from each person's history/);
  });

  it("limits the title to the candidates, like a normal recommendation", () => {
    assert.deepEqual(buildResponseSchema("together", { candidateList: [{ title: "A" }, { title: "B" }] }).properties.title.enum, ["A", "B"]);
  });
});

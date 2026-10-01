import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { parseMoodReading, readMood } from "../src/moodReading.js";
import { buildOpenCandidatePool, buildRequestFilters, buildUserContext, moodTerms, rankPool, toCandidate } from "../src/discovery.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { AVOID_GENRES, MOOD_GENRES, MOOD_TAGS } from "../src/moodVocabulary.js";
import { PROMPTS } from "../api/_lib/prompts.js";
import { buildResponseSchema } from "../api/_lib/schemas.js";
import handler from "../api/en.js";
import { aniListMedia, json, withFetch } from "./fixtures.js";
import { memoryStorage } from "./storage-shim.js";

const reading = (overrides = {}) => ({
  reading: "quiet and a little sad",
  genres: ["Slice of Life", "Drama"],
  tags: ["Iyashikei"],
  avoidGenres: [],
  avoidTags: [],
  film: false,
  maxEpisodes: null,
  minEpisodes: null,
  airing: false,
  yearMin: null,
  yearMax: null,
  ...overrides
});

// What the model sends back (limits as words; see MOOD_LENGTHS).
const answer = (overrides = {}) => ({
  reading: "quiet and a little sad",
  genres: ["Slice of Life", "Drama"],
  tags: ["Iyashikei"],
  avoidGenres: [],
  avoidTags: [],
  length: "any",
  era: "any",
  airing: false,
  ...overrides
});

describe("reading tonight's mood", () => {
  it("keeps only names AniList knows and numbers that make sense", () => {
    const parsed = parseMoodReading(JSON.stringify({
      reading: "Loud, fast, no thinking.",
      genres: ["Action", "Explosions", "Action"],
      tags: ["Swordplay", "Not A Tag"],
      avoidGenres: ["Romance"],
      avoidTags: [],
      length: "forever",
      era: "1200s"
    }));
    assert.deepEqual(parsed.genres, ["Action"]);
    assert.deepEqual(parsed.tags, ["Swordplay"]);
    assert.equal(parsed.reading, "loud, fast, no thinking");
    assert.equal(parsed.maxEpisodes, null);
    assert.equal(parsed.yearMin, null);
  });

  it("never asks for and rules out the same thing", () => {
    const parsed = parseMoodReading(JSON.stringify(answer({ genres: ["Horror", "Comedy"], avoidGenres: ["Horror"] })), { mood: "nothing scary" });
    assert.deepEqual(parsed.genres, ["Comedy"]);
  });

  it("turns the limit words into episode counts and years", () => {
    const limits = (length, era, mood) => {
      const parsed = parseMoodReading(JSON.stringify(answer({ length, era })), { mood });
      return [parsed.film, parsed.maxEpisodes, parsed.minEpisodes, parsed.yearMin, parsed.yearMax];
    };
    const thisYear = new Date().getFullYear();
    assert.deepEqual(limits("film", "any", "a movie"), [true, null, null, null, null]);
    assert.deepEqual(limits("tonight", "any", "something I can finish tonight"), [false, 4, null, null, null]);
    assert.deepEqual(limits("short", "1990s", "a short one from the 90s"), [false, 13, null, 1990, 1999]);
    assert.deepEqual(limits("long", "recent", "a long new series"), [false, null, 24, thisYear - 3, null]);
    assert.deepEqual(limits("any", "older", "an old classic"), [false, null, null, null, 2005]);
  });

  it("only lets the reading rule things out, or set limits, when the mood says so", () => {
    const eager = JSON.stringify(answer({ avoidGenres: ["Action"], avoidTags: ["Gore"], length: "short", era: "older", airing: true }));
    const quiet = parseMoodReading(eager, { mood: "rain on a tuesday" });
    assert.deepEqual([quiet.avoidGenres, quiet.avoidTags, quiet.maxEpisodes, quiet.yearMax, quiet.airing], [[], [], null, null, false]);
    const said = parseMoodReading(eager, { mood: "nothing gory, something short and old that's airing" });
    assert.deepEqual([said.avoidGenres, said.avoidTags, said.maxEpisodes, said.yearMax, said.airing], [["Action"], ["Gore"], 13, 2005, true]);
    assert.deepEqual(parseMoodReading(eager, { mood: "rain on a tuesday", passedOver: ["too heavy"] }).avoidTags, ["Gore"], "a pass reason is a reason to steer away");
    assert.equal(parseMoodReading(eager, { mood: "静かなものが見たい" }).maxEpisodes, 13, "other languages are taken as read");
  });

  it("returns nothing for an answer that says nothing, or isn't JSON", () => {
    assert.equal(parseMoodReading(JSON.stringify({ reading: "", genres: [], tags: [], avoidGenres: [], avoidTags: [] })), null);
    assert.equal(parseMoodReading("sorry, I can't"), null);
  });

  it("asks the server once per mood (and per pass reason), and falls back quietly", async () => {
    globalThis.localStorage = memoryStorage();
    const content = JSON.stringify(answer());
    const first = await withFetch(() => json({ content }), () => readMood("rain on a tuesday"));
    assert.equal(first.result.reading, "quiet and a little sad");
    assert.deepEqual(first.calls[0].body, { kind: "mood", payload: { mood: "rain on a tuesday" } });
    const again = await withFetch(() => json({ content }), () => readMood("Rain on a  Tuesday"));
    assert.equal(again.calls.length, 0, "cached");
    const passed = await withFetch(() => json({ content }), () => readMood("rain on a tuesday", { passedOver: [{ reason: "too heavy" }] }));
    assert.deepEqual(passed.calls[0].body.payload.passedOver, ["too heavy"]);
    const failed = await withFetch(() => json({ error: "down" }, 502), () => readMood("something new"));
    assert.equal(failed.result, null);
    assert.equal((await readMood("   ")), null);
  });
});

describe("using the reading", () => {
  it("searches what the mood asks for, never what it rules out", () => {
    assert.deepEqual(moodTerms("nothing scary tonight", reading({ genres: ["Comedy"], tags: [], avoidGenres: ["Horror"] })), {
      genres: ["Comedy"],
      tags: []
    }, "the word list alone would have searched Horror for 'scary'");
    assert.deepEqual(moodTerms("something quiet", null), { genres: ["Slice of Life"], tags: ["Iyashikei"] });
  });

  it("fills in limits the patterns missed, without overriding the ones they caught", () => {
    const finishTonight = buildRequestFilters({ mood: "something I can finish tonight", reading: reading({ maxEpisodes: 4 }) });
    assert.equal(finishTonight.constraints.maxEpisodes, 4);
    const short = buildRequestFilters({ mood: "something short", reading: reading({ maxEpisodes: 4 }) });
    assert.equal(short.constraints.maxEpisodes, 13, "'short' was already caught");
    const era = buildRequestFilters({ mood: "an old one with my dad", reading: reading({ yearMax: 2005 }) });
    assert.deepEqual([era.constraints.yearMin, era.constraints.yearMax], [undefined, 2005]);
    const film = buildRequestFilters({ mood: "date night", reading: reading({ film: true }) });
    assert.deepEqual(film.constraints.formats, ["MOVIE"]);
    assert.deepEqual(buildRequestFilters({ mood: "date night", reading: null }).constraints, {});
  });

  it("sinks what the mood rules out rather than dropping it", () => {
    const context = buildUserContext({ list: [], history: [], memory: buildRecommendationMemory({ malList: [], history: [] }) });
    const discovery = {
      genre: [
        toCandidate(aniListMedia(1, "Gutting", { genres: ["Drama"], tags: [{ name: "Tragedy", rank: 90 }], averageScore: 90 })),
        toCandidate(aniListMedia(2, "Gentle", { genres: ["Slice of Life"], averageScore: 75 }))
      ]
    };
    const titles = rankPool({ discovery, context, moodWanted: { genres: [], tags: [] }, avoid: { genres: [], tags: ["Tragedy"] } }).map((candidate) => candidate.title);
    assert.deepEqual(titles, ["Gentle", "Gutting"]);
  });

  it("queries AniList for the reading, and keeps what the mood rules out out of the query", async () => {
    const { calls } = await withFetch(() => json({ data: {} }), () =>
      buildOpenCandidatePool({
        mood: "rain on a tuesday but nothing too sad",
        list: [],
        history: [],
        tasteProfile: { favoriteGenres: ["Drama"] },
        recentPatterns: {},
        memory: buildRecommendationMemory({ malList: [], history: [] }),
        moodReading: reading({ genres: ["Slice of Life"], tags: ["Iyashikei", "Rural"], avoidTags: ["Tragedy"] })
      })
    );
    const query = calls.find((call) => call.body?.query.includes("mood0")).body.query;
    assert.ok(query.includes('tag_in: ["Iyashikei"]'));
    assert.ok(query.includes('tag_in: ["Rural"]'));
    assert.ok(query.includes('genre_in: ["Slice of Life"]'));
    assert.match(query, /tag_not_in: \["Tragedy"\]/);
  });
});

describe("api/en mood", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_FALLBACK_MODEL;
  });
  after(() => {
    process.env = saved;
  });

  it("holds genres to AniList's names, and lists the tags in the prompt (a tag enum made the schema too big)", () => {
    const schema = buildResponseSchema("mood", { mood: "x" });
    assert.deepEqual(schema.properties.genres.items.enum, MOOD_GENRES);
    assert.deepEqual(schema.properties.avoidGenres.items.enum, AVOID_GENRES);
    assert.equal(schema.properties.tags.items.enum, undefined);
    assert.ok(!JSON.stringify(schema).includes("nullable"));
    assert.deepEqual(schema.required.slice(-3), ["length", "era", "airing"], "limits always say something, if only \"any\"");
    assert.ok(MOOD_TAGS.every((tag) => PROMPTS.mood.includes(tag)));
  });

  it("goes to the lighter model first, since it's on the way to the pick", async () => {
    const res = { code: 0, body: null, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    const { calls } = await withFetch(
      () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer()) }] } }] }),
      () => handler({ method: "POST", body: { kind: "mood", payload: { mood: "rain on a tuesday" } } }, res)
    );
    assert.equal(res.code, 200);
    assert.ok(calls[0].url.endsWith("/gemini-3.5-flash-lite:generateContent"));
    assert.match(calls[0].body.systemInstruction.parts[0].text, /Tonight sounds/);
  });
});

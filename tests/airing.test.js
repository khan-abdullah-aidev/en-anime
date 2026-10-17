import test from "node:test";
import assert from "node:assert/strict";
import { airingAdvice, describeNextAiring } from "../src/anilist.js";

const now = new Date(2026, 9, 17, 12, 0).getTime(); // a Saturday, noon
const at = (days, hour = 20) => new Date(2026, 9, 17 + days, hour, 0).getTime();

test("next airing reads as today, tomorrow, a weekday, then a date", () => {
  assert.equal(describeNextAiring({ episode: 7, airingAt: at(0) }, now), "episode 7 airs today");
  assert.equal(describeNextAiring({ episode: 7, airingAt: at(1, 1) }, now), "episode 7 airs tomorrow");
  assert.equal(describeNextAiring({ episode: 8, airingAt: at(5) }, now), "episode 8 airs Thursday");
  assert.equal(describeNextAiring({ episode: 9, airingAt: at(12) }, now), "episode 9 airs on 29 Oct");
});

test("nothing to say about an episode that already aired, or no episode", () => {
  assert.equal(describeNextAiring({ episode: 3, airingAt: now - 1000 }, now), "");
  assert.equal(describeNextAiring(null, now), "");
  assert.equal(describeNextAiring({ airingAt: at(2) }, now), "the next episode airs Monday");
});

test("airing advice: enough out to start, or worth saving for later", () => {
  assert.equal(airingAdvice({ episode: 7, total: 12 }), "6 of 12 out: enough to start now");
  assert.equal(airingAdvice({ episode: 3, total: 12 }), "only 2 of 12 out so far: you could save it for later");
  assert.equal(airingAdvice({ episode: 12, total: 12 }), "11 of 12 out: nearly done, start now");
  assert.equal(airingAdvice({ episode: 1, total: null }), "it's only just starting: you could save it for later");
  assert.equal(airingAdvice({ episode: 9 }), "8 out: enough to start now");
});

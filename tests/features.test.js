import test from "node:test";
import assert from "node:assert/strict";
import { meetsConstraints, parseConstraints, parseTimeBudget, rewatchCandidates, totalMinutes } from "../src/discovery.js";
import { onServices, servicesFilter } from "../src/streaming.js";
import { answersFromList } from "../src/watchHistory.js";
import { normalizePreferences, userSaidFor } from "../src/preferences.js";

test("only what I can watch: kept when on a chosen service, dropped otherwise", () => {
  const onCrunchyroll = { watchLinks: [{ site: "Crunchyroll", url: "x" }] };
  const onPrime = { watchLinks: [{ site: "Amazon Prime Video", url: "x" }] };
  const nowhere = { watchLinks: [] };
  const filter = servicesFilter(["Crunchyroll", "Prime Video"]);
  assert.equal(filter.matches(onCrunchyroll), false);
  assert.equal(filter.matches(onPrime), false);
  assert.equal(filter.matches(nowhere), true);
  assert.equal(filter.matches({ ...nowhere, resume: { watched: 3 } }), false);
  assert.equal(servicesFilter([]).matches(nowhere), false);
  assert.equal(onServices([{ site: "Netflix" }], ["Crunchyroll"]), false);
});

test("a time budget reads from the mood and holds the whole show", () => {
  assert.equal(parseTimeBudget("I have 45 minutes"), 45);
  assert.equal(parseTimeBudget("got about an hour"), 60);
  assert.equal(parseTimeBudget("this weekend"), 720);
  assert.equal(parseTimeBudget("after a long day"), null);
  assert.equal(parseConstraints("two hours tonight").maxMinutes, 120);
  assert.equal(totalMinutes({ episodes: 12, duration: 24 }), 288);
  assert.equal(totalMinutes({ episodes: 1, format: "MOVIE" }), 100);
  assert.equal(meetsConstraints({ episodes: 1, format: "MOVIE", duration: 106 }, { maxMinutes: 120 }), true);
  assert.equal(meetsConstraints({ episodes: 12, duration: 24 }, { maxMinutes: 120 }), false);
  assert.equal(meetsConstraints({ episodes: null, status: "RELEASING" }, { maxMinutes: 600 }), false);
});

const listEntry = (id, title, score, extra = {}) => ({
  id,
  title,
  alternative_titles: { en: title },
  my_list_status: { status: "completed", score, updated_at: "2025-01-01T00:00:00Z" },
  genres: ["Drama"],
  ...extra
});

test("rewatch candidates are their best-loved finishes, not one rewatched lately", () => {
  const list = [listEntry(1, "Mushishi", 10), listEntry(2, "Frieren", 9), listEntry(3, "Fine Show", 6), listEntry(4, "Okay Show", 7)];
  const history = [{ mode: "rewatch", date: new Date().toISOString(), recommendation: { title: "Frieren" } }];
  const titles = rewatchCandidates({ list, history, random: () => 0 }).map((candidate) => candidate.title);
  assert.deepEqual(titles, ["Mushishi"]);
  assert.equal(rewatchCandidates({ list, random: () => 0 })[0].rewatch.score, 10);
});

test("a rewatch pick isn't answered from the list just because it's finished there", () => {
  const list = [listEntry(1, "Mushishi", 10)];
  const history = [
    { id: "a", state: "unrated", mode: "rewatch", recommendation: { title: "Mushishi", malId: 1 } },
    { id: "b", state: "unrated", recommendation: { title: "Mushishi", malId: 1 } }
  ];
  assert.deepEqual(answersFromList({ list, history }).map((answer) => answer.id), ["b"]);
});

test("services and dub are kept as told, and dub reaches the model as something the user said", () => {
  const preferences = normalizePreferences({ services: ["Netflix", "Not A Service"], dub: true });
  assert.deepEqual(preferences.services, ["Netflix"]);
  assert.equal(userSaidFor(preferences).prefersDub, true);
  assert.equal(userSaidFor(normalizePreferences({})), null);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCandidatePool,
  buildRecommendationMemory,
  buildUnwatchedTitles,
  deterministicRecommendation,
  findBlockedEvidenceTitle,
  isStillExcluded
} from "../src/recommendationEngine.js";
import { buildTasteProfile } from "../src/tasteProfile.js";
import { MAL_LIST } from "./fixtures.js";

describe("recommendation memory + curated catalog fallback", () => {
  const memory = buildRecommendationMemory({ malList: MAL_LIST, history: [] });
  const pool = buildCandidatePool({
    mood: "something quiet",
    tasteProfile: buildTasteProfile({ malList: MAL_LIST, feedbackHistory: [] }),
    recentPatterns: {},
    memory
  });

  it("never offers a show the user is watching or has on hold", () => {
    assert.ok(!pool.some((candidate) => candidate.title === "Odd Taxi"));
    assert.ok(!pool.some((candidate) => candidate.title === "Ping Pong the Animation"));
  });

  it("rebuilds in-progress from the live list instead of accumulating it", () => {
    const finished = { ...MAL_LIST[0], my_list_status: { ...MAL_LIST[0].my_list_status, status: "completed" } };
    const later = buildRecommendationMemory({ malList: [finished], history: [], existingMemory: memory });
    assert.deepEqual(later.in_progress, []);
    assert.ok(later.completed.includes("Odd Taxi"));
  });

  it("labels the no-model fallback as one", () => {
    const fallback = deterministicRecommendation(pool);
    assert.equal(fallback.fallback, true);
    assert.match(fallback.reason, /couldn't think/);
  });
});

describe("unwatched titles a reason must not cite", () => {
  const unwatched = buildUnwatchedTitles({ malList: MAL_LIST, history: [] });

  it("is the current plan-to-watch list", () => {
    assert.deepEqual(unwatched, ["Another", "K"]);
  });

  it("doesn't match short titles inside ordinary words", () => {
    assert.equal(findBlockedEvidenceTitle("Another quiet show. Keep the lights low and bright.", unwatched), "");
    assert.equal(findBlockedEvidenceTitle("It's another slow one, and that's fine.", unwatched), "");
  });

  it("still catches a real citation", () => {
    assert.equal(findBlockedEvidenceTitle("You'd like it. Like Another, it waits.", unwatched), "Another");
    assert.equal(findBlockedEvidenceTitle("It has the patience of Monster, without the dread.", [...unwatched, "Monster"]), "Monster");
    assert.equal(findBlockedEvidenceTitle("the warmth of laid-back camp, colder.", [...unwatched, "Laid-Back Camp"]), "Laid-Back Camp");
  });

  it("lets a reason cite a show that was plan-to-watch once and has since been finished", () => {
    const frieren = (status) => [{ ...MAL_LIST[1], my_list_status: { ...MAL_LIST[1].my_list_status, status } }];
    const stale = buildRecommendationMemory({
      malList: frieren("completed"),
      history: [],
      existingMemory: buildRecommendationMemory({ malList: frieren("plan_to_watch"), history: [] })
    });
    assert.ok(stale.watchlisted.includes("Sousou no Frieren"), "the persisted memory still remembers it as plan-to-watch");
    const reason = "You gave Frieren: Beyond Journey's End a ten. This one is patient the same way.";
    assert.equal(findBlockedEvidenceTitle(reason, buildUnwatchedTitles({ malList: frieren("completed"), history: [] })), "");
  });

  it("treats picks saved for later as unwatched and rated picks as watched", () => {
    const history = [
      { state: "pending", recommendation: { title: "Haibane Renmei" } },
      { state: "rated", feedback: "good", recommendation: { title: "Mushishi" } }
    ];
    assert.deepEqual(buildUnwatchedTitles({ malList: "Odd Taxi", history }), ["Haibane Renmei"]);
  });
});

describe("passed-over picks (not tonight)", () => {
  const day = 24 * 60 * 60 * 1000;
  const entry = (title, state, daysAgo) => ({
    id: title,
    state,
    date: new Date(Date.now() - daysAgo * day).toISOString(),
    ...(state === "not_tonight" ? { not_tonight_at: new Date(Date.now() - daysAgo * day).toISOString() } : {}),
    recommendation: { title }
  });

  it("stay out of new pools for 60 days, then come back", () => {
    assert.equal(isStillExcluded(entry("A", "not_tonight", 10)), true);
    assert.equal(isStillExcluded(entry("A", "not_tonight", 61)), false);
    assert.equal(isStillExcluded(entry("A", "rated", 400)), true, "real answers never expire");
  });

  it("rebuilds the recommended list from the log, so cooled-down and deleted picks drop out", () => {
    const memory = buildRecommendationMemory({
      malList: [],
      history: [entry("Recent Pass", "not_tonight", 3), entry("Old Pass", "not_tonight", 90), entry("Rated", "rated", 200)],
      existingMemory: { recommended: ["Old Pass", "Deleted From Log"] }
    });
    assert.deepEqual(memory.recommended, ["Recent Pass", "Rated"]);
  });
});

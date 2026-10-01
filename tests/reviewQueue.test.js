import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK_AGAIN_DAYS, askAgainAfter, findCurrentPending, findReviewEntries, isAwaitingAnswer } from "../src/reviewQueue.js";
import { answersFromList } from "../src/watchHistory.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { malEntry } from "./fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-01T12:00:00Z");
const at = (days) => new Date(now + days * DAY).toISOString();
const pick = (id, state, date, extra = {}) => ({ id, state, date, recommendation: { title: id, malId: extra.malId }, ...extra });

describe("'Did you watch it?': who gets asked, and when", () => {
  it("asks about unanswered, saved and in-progress picks, oldest first", () => {
    const history = [
      pick("newer", "unrated", at(-1)),
      pick("rated", "rated", at(-9)),
      pick("watching", "watching", at(-20)),
      pick("saved", "pending", at(-5))
    ];
    assert.deepEqual(findReviewEntries(history, new Set(), now).map((entry) => entry.id), ["watching", "saved", "newer"]);
    assert.ok(isAwaitingAnswer(history[2]));
  });

  it("'watching it' and 'later' hold the question off for a while, then it comes back", () => {
    assert.equal(askAgainAfter("watching", now), at(ASK_AGAIN_DAYS.watching));
    assert.equal(askAgainAfter("later", now), at(ASK_AGAIN_DAYS.later));
    assert.equal(askAgainAfter("good", now), null);

    const history = [
      pick("watching", "watching", at(-3), { ask_after: askAgainAfter("watching", now) }),
      pick("saved", "pending", at(-3), { ask_after: askAgainAfter("later", now) }),
      pick("due", "pending", at(-40), { ask_after: at(-1) })
    ];
    assert.deepEqual(findReviewEntries(history, new Set(), now).map((entry) => entry.id), ["due"]);
    assert.deepEqual(findReviewEntries(history, new Set(), now + 15 * DAY).map((entry) => entry.id), ["due", "watching"]);
    assert.deepEqual(findReviewEntries(history, new Set(), now + 31 * DAY).map((entry) => entry.id), ["due", "watching", "saved"]);
  });

  it("never asks about a pick from this visit, or one just snoozed", () => {
    const history = [pick("tonight", "unrated", at(0)), pick("old", "unrated", at(-2))];
    assert.deepEqual(findReviewEntries(history, new Set(["tonight"]), now).map((entry) => entry.id), ["old"]);
    const snoozed = [{ ...history[1], state: "watching", ask_after: at(14) }];
    assert.equal(findCurrentPending(snoozed, ["old"], new Set(), now), undefined);
  });

  it("MyAnimeList can still answer a pick that's being watched", () => {
    const list = [malEntry(5, "Link Click", "completed", 9, ["Drama"], { watched: 11, episodes: 11 })];
    const answers = answersFromList({ list, history: [pick("x", "watching", at(-3), { malId: 5, ask_after: at(10) })] });
    assert.deepEqual(answers, [{ id: "x", answer: "good", reflection: "finished it on MyAnimeList · 9/10." }]);
  });

  it("a pick being watched stays out of new pools", () => {
    const memory = buildRecommendationMemory({ malList: [], history: [pick("Link Click", "watching", at(-3))] });
    assert.ok(memory.in_progress.includes("Link Click"));
    assert.ok(memory.recommended.includes("Link Click"));
  });
});

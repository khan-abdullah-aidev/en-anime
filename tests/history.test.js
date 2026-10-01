import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answersFromList, buildWatchHistoryDigest, describeQueriedTitle } from "../src/watchHistory.js";
import { buildTasteProfile, compactFeedbackHistory } from "../src/tasteProfile.js";
import { MAL_LIST, malEntry } from "./fixtures.js";

describe("watch history digest (what the model reads)", () => {
  const digest = buildWatchHistoryDigest(MAL_LIST);

  it("counts every status and the average score", () => {
    assert.equal(digest.source, "myanimelist");
    assert.deepEqual(
      { ...digest.summary },
      { completed: 6, watching: 1, on_hold: 1, dropped: 2, plan_to_watch: 2, averageScore: 7.4 }
    );
  });

  it("lists recent activity newest first, in English, without plan-to-watch", () => {
    assert.equal(digest.recent[0].title, "Odd Taxi");
    assert.equal(digest.recent[1].title, "Frieren: Beyond Journey's End");
    assert.ok(!digest.recent.some((entry) => entry.title === "Another" || entry.title === "K"));
  });

  it("only shows progress for unfinished shows", () => {
    assert.equal(digest.recent[0].progress, "5/13");
    assert.equal(digest.recent[1].progress, undefined);
  });

  it("picks favorites above the user's own average and keeps where drops stopped", () => {
    assert.deepEqual(
      digest.favorites.map((entry) => entry.title),
      ["Frieren: Beyond Journey's End", "Mushishi", "Barakamon", "Laid-Back Camp"]
    );
    assert.deepEqual(digest.dropped[0], { title: "Chainsaw Man", progress: "4/12", score: 4, updated: "2026-08" });
    assert.deepEqual(digest.lowRated.map((entry) => entry.title), ["Tokyo Ghoul"]);
    assert.deepEqual(digest.inProgress.map((entry) => entry.status), ["watching", "on_hold"]);
  });

  it("passes a manual list through as the user's own words", () => {
    assert.deepEqual(buildWatchHistoryDigest("Odd Taxi, Ping Pong the Animation\nMushishi"), {
      source: "self-described",
      lovedTitles: ["Odd Taxi", "Ping Pong the Animation", "Mushishi"]
    });
  });

  it("stays small for a 3000-entry list", () => {
    const big = Array.from({ length: 3000 }, (_, i) =>
      malEntry(100 + i, `Show ${i}`, ["completed", "dropped", "watching"][i % 3], (i % 10) + 1, ["Drama"], { watched: 3 })
    );
    assert.ok(JSON.stringify(buildWatchHistoryDigest(big)).length < 6000);
  });
});

describe("queried titles (verdict / choose)", () => {
  it("matches the user's list by MAL id from AniList", () => {
    const result = describeQueriedTitle({ asked: "frieren", resolved: { malId: 2, title: "Frieren: Beyond Journey's End" }, list: MAL_LIST });
    assert.deepEqual(result.onList, { status: "completed", score: 10, progress: "28/28", updated: "2026-09" });
  });

  it("falls back to alternative titles", () => {
    assert.equal(describeQueriedTitle({ asked: "Attack on Titan", resolved: null, list: MAL_LIST }).onList.status, "completed");
  });

  it("reports a drop and how it went when En suggested it", () => {
    const result = describeQueriedTitle({
      asked: "Chainsaw Man",
      resolved: null,
      list: MAL_LIST,
      history: [{ state: "rated", feedback: "meh", feedback_note: "too loud", recommendation: { title: "Chainsaw Man" } }]
    });
    assert.equal(result.onList.status, "dropped");
    assert.deepEqual(result.enHistory, { outcome: "meh", note: "too loud" });
  });

  it("knows a title from a manual list", () => {
    assert.deepEqual(describeQueriedTitle({ asked: "mushishi", resolved: null, list: "Odd Taxi, Mushishi" }).onList, { status: "listed as seen and loved" });
    assert.equal(describeQueriedTitle({ asked: "Mob Psycho 100", resolved: null, list: MAL_LIST }).onList, undefined);
  });
});

describe("taste profile", () => {
  const profile = buildTasteProfile({ malList: MAL_LIST, feedbackHistory: [] });

  it("takes favorite genres from the whole MAL list", () => {
    assert.ok(profile.favoriteGenres.includes("Iyashikei"));
    assert.ok(profile.favoriteGenres.includes("Slice of Life"));
  });

  it("takes disliked genres from drops and low scores, never a favorite", () => {
    assert.ok(profile.dislikedTropes.includes("Gore"));
    assert.ok(!profile.dislikedTropes.some((trope) => profile.favoriteGenres.includes(trope)));
  });

  it("ignores genres with only a couple of entries on a big list, and MAL's Award Winning badge", () => {
    const big = [
      ...Array.from({ length: 100 }, (_, i) => malEntry(1000 + i, `Drama ${i}`, "completed", 8, ["Drama", "Award Winning"])),
      ...Array.from({ length: 100 }, (_, i) => malEntry(2000 + i, `Action ${i}`, "completed", 6, ["Action"])),
      malEntry(3000, "Niche A", "completed", 10, ["Childcare"]),
      malEntry(3001, "Niche B", "completed", 10, ["Childcare"])
    ];
    const bigProfile = buildTasteProfile({ malList: big, feedbackHistory: [] });
    assert.ok(bigProfile.favoriteGenres.includes("Drama"));
    assert.ok(!bigProfile.favoriteGenres.includes("Childcare"));
    assert.ok(!bigProfile.favoriteGenres.includes("Award Winning"));
  });

  it("reads a manual list's genres from the curated catalog, and makes no darkness or pacing guesses", () => {
    const manual = buildTasteProfile({ malList: "Odd Taxi, Ping Pong the Animation", feedbackHistory: [] });
    assert.ok(manual.favoriteGenres.includes("drama"));
    assert.equal(manual.darknessTolerance, undefined);
    assert.equal(manual.pacingPreference, undefined);
  });

  it("gives unrated picks no feedback signal", () => {
    const feedback = compactFeedbackHistory([
      { state: "unrated", recommendation: { title: "A" } },
      { state: "skipped", feedback: "", recommendation: { title: "B" } },
      { state: "rated", feedback: "good", recommendation: { title: "C" } }
    ]);
    assert.deepEqual(feedback.map((entry) => [entry.title, entry.feedback]), [["B", "skipped"], ["C", "good"]]);
  });
});

describe("answering 'did you watch it?' from the MAL list", () => {
  const list = [
    malEntry(100, "Loved It", "completed", 9, ["Drama"]),
    malEntry(101, "Middling", "completed", 5, ["Drama"]),
    malEntry(102, "No Score", "completed", 0, ["Drama"]),
    malEntry(103, "Gave Up", "dropped", 3, ["Drama"], { watched: 4 }),
    malEntry(104, "Still Watching", "watching", 0, ["Drama"], { watched: 2 }),
    malEntry(105, "Haibane Renmei", "completed", 8, ["Drama"])
  ];
  const awaiting = (id, title, extra = {}) => ({ id, state: "unrated", recommendation: { title, ...extra } });

  it("turns completions into good (or meh well below their average) and drops into meh", () => {
    const answers = answersFromList({
      list,
      history: [
        awaiting("a", "Loved It", { malId: 100 }),
        awaiting("b", "Middling", { malId: 101 }),
        awaiting("c", "No Score", { malId: 102 }),
        awaiting("d", "Gave Up", { malId: 103 }),
        awaiting("e", "Still Watching", { malId: 104 })
      ]
    });
    assert.deepEqual(answers, [
      { id: "a", answer: "good", reflection: "finished it on MyAnimeList · 9/10." },
      { id: "b", answer: "meh", reflection: "finished it on MyAnimeList · 5/10." },
      { id: "c", answer: "good", reflection: "finished it on MyAnimeList." },
      { id: "d", answer: "meh", reflection: "dropped it on MyAnimeList at episode 4." }
    ]);
  });

  it("matches by title when the pick has no MAL id, and leaves answered picks alone", () => {
    const answers = answersFromList({
      list,
      history: [awaiting("x", "Haibane Renmei"), { id: "y", state: "rated", feedback: "good", recommendation: { title: "Loved It", malId: 100 } }]
    });
    assert.deepEqual(answers.map((answer) => answer.id), ["x"]);
  });

  it("does nothing for a manual list", () => {
    assert.deepEqual(answersFromList({ list: "Loved It", history: [awaiting("a", "Loved It")] }), []);
  });
});

describe("feedback sent to the model", () => {
  it("leaves out 'not tonight' passes, which say nothing about the show", () => {
    const feedback = compactFeedbackHistory([
      { state: "not_tonight", recommendation: { title: "A" } },
      { state: "rated", feedback: "meh", recommendation: { title: "B" } }
    ]);
    assert.deepEqual(feedback.map((entry) => entry.title), ["B"]);
  });
});

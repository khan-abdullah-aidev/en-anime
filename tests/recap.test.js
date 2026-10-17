import test from "node:test";
import assert from "node:assert/strict";
import { monthRecap, recapText } from "../src/recap.js";

const now = new Date(2026, 9, 17);
const pick = (day, month, fields = {}) => ({
  id: `${month}-${day}`,
  date: new Date(2026, month, day, 21).toISOString(),
  recommendation: { title: `Show ${month}-${day}`, genre: "Drama, Music" },
  state: "unrated",
  ...fields
});

test("this month's recap counts picks, what was watched and what landed", () => {
  const recap = monthRecap(
    [
      pick(2, 9, { state: "rated", feedback: "good", request_mood: "Something quiet" }),
      pick(5, 9, { state: "rated", feedback: "meh" }),
      pick(9, 9, { state: "watching", recommendation: { title: "Mushishi", genre: "Slice of Life" } }),
      pick(12, 9),
      pick(20, 8, { state: "rated", feedback: "good" })
    ],
    now
  );
  assert.equal(recap.label, "October so far");
  assert.equal(recap.picks, 4);
  assert.equal(recap.watched, 3);
  assert.equal(recap.loved, 1);
  assert.equal(recap.hitRate, 50);
  assert.deepEqual(recap.topGenres, ["Drama", "Music"]);
  assert.equal(recap.favorite, "Show 9-2");
  assert.deepEqual(recap.moods, ["something quiet"]);
  assert.match(recapText(recap), /4 picks, 3 watched, 1 loved\./);
});

test("with nothing yet this month, last month's recap shows; with nothing at all, none", () => {
  assert.equal(monthRecap([pick(20, 8)], now).label, "September");
  assert.equal(monthRecap([], now), null);
});

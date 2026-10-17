import test from "node:test";
import assert from "node:assert/strict";
import { dayPattern, nightKind } from "../src/dayPattern.js";

const at = (y, m, d, h) => new Date(y, m, d, h).toISOString();
const rated = (date, feedback, features) => ({ state: "rated", feedback, date, recommendation: { title: "x", features } });
const long = { g: ["Adventure"], len: "long" };
const short = { g: ["Slice of Life"], len: "short" };

test("Friday and Saturday nights are weekend nights; 2am counts as the night before", () => {
  assert.equal(nightKind(at(2026, 9, 16, 21)), "weekend"); // Friday
  assert.equal(nightKind(at(2026, 9, 17, 23)), "weekend"); // Saturday
  assert.equal(nightKind(at(2026, 9, 18, 2)), "weekend"); // Sunday 2am, still Saturday night
  assert.equal(nightKind(at(2026, 9, 18, 21)), "weeknight"); // Sunday evening
});

test("a pattern shows once weekends and weeknights each have three answers and differ", () => {
  const history = [
    rated(at(2026, 9, 2, 21), "good", long), rated(at(2026, 9, 3, 21), "good", long), rated(at(2026, 9, 9, 21), "meh", short),
    rated(at(2026, 9, 5, 21), "good", short), rated(at(2026, 9, 6, 21), "good", short), rated(at(2026, 9, 7, 21), "meh", long)
  ];
  const pattern = dayPattern(history, new Date(2026, 9, 17, 20));
  assert.equal(pattern.tonight, "a weekend night");
  assert.equal(pattern.weekendNights.whatLanded, "long series");
  assert.equal(pattern.weeknights.whatLanded, "short shows (up to 13 episodes)");
  assert.equal(dayPattern(history.slice(0, 4)), null);
});

test("no pattern when both kinds of night go the same way", () => {
  const same = [
    rated(at(2026, 9, 2, 21), "good", short), rated(at(2026, 9, 3, 21), "good", short), rated(at(2026, 9, 9, 21), "meh", long),
    rated(at(2026, 9, 5, 21), "good", short), rated(at(2026, 9, 6, 21), "good", short), rated(at(2026, 9, 7, 21), "meh", long)
  ];
  assert.equal(dayPattern(same), null);
});

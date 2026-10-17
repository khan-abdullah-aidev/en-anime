import test from "node:test";
import assert from "node:assert/strict";
import { reminderPick } from "../src/reminders.js";

test("the reminder is about the saved pick that has waited longest", () => {
  const history = [
    { id: "new", state: "pending", date: "2026-10-10T20:00:00Z", recommendation: { title: "Newer" } },
    { id: "old", state: "pending", date: "2026-10-01T20:00:00Z", recommendation: { title: "Older" } },
    { id: "rated", state: "rated", date: "2026-09-01T20:00:00Z", recommendation: { title: "Done" } }
  ];
  assert.equal(reminderPick(history).id, "old");
  assert.equal(reminderPick([history[2]]), null);
});

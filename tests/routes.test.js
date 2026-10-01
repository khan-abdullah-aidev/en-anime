import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PARENT, VIEW, parsePath, pathFor } from "../src/routes.js";

describe("routes", () => {
  it("round-trips every screen that has an address", () => {
    for (const view of Object.values(VIEW)) {
      if (view === VIEW.THINKING) continue;
      if (view === VIEW.ROOM) {
        assert.deepEqual(parsePath(pathFor(view, "Abc_123-xyz")), { view, roomId: "Abc_123-xyz" });
        continue;
      }
      const entryId = view === VIEW.REVEAL || view === VIEW.FEEDBACK ? "abc-123" : undefined;
      assert.deepEqual(parsePath(pathFor(view, entryId)), entryId ? { view, entryId } : { view });
    }
  });

  it("encodes pick ids safely", () => {
    assert.equal(pathFor(VIEW.REVEAL, "a/b c"), "/pick/a%2Fb%20c");
    assert.deepEqual(parsePath("/pick/a%2Fb%20c"), { view: VIEW.REVEAL, entryId: "a/b c" });
  });

  it("tolerates trailing slashes and sends unknown paths to the landing page", () => {
    assert.deepEqual(parsePath("/log/"), { view: VIEW.HISTORY });
    assert.deepEqual(parsePath("/nope"), { view: VIEW.LANDING });
    assert.deepEqual(parsePath(""), { view: VIEW.LANDING });
  });

  it("gives every screen a parent that exists (or none)", () => {
    for (const view of Object.values(VIEW)) {
      assert.ok(view in PARENT, `${view} has no PARENT entry`);
      assert.ok(PARENT[view] === null || Object.values(VIEW).includes(PARENT[view]));
    }
  });
});

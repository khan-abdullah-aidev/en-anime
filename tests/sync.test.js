import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { mergeSnapshots } from "../src/syncMerge.js";
import syncHandler from "../api/sync.js";
import malStatusHandler, { planListUpdate } from "../api/mal-status.js";
import { appendHistory, clearRecommendationLog, deleteHistoryEntry, loadHistory, loadTombstones, updateHistoryEntry } from "../src/storage.js";
import { applyRemoteSnapshot, importLogText, localSnapshot, normalizeSyncCode } from "../src/sync.js";
import { json, withFetch } from "./fixtures.js";
import { memoryStorage } from "./storage-shim.js";

const pick = (id, title, updated, extra = {}) => ({
  id,
  date: extra.date || updated,
  updated_at: updated,
  state: "unrated",
  recommendation: { title },
  ...extra
});

describe("merging two copies of the log", () => {
  it("keeps every pick from both, newest version of each, newest pick first", () => {
    const phone = { history: [pick("a", "Mushishi", "2026-09-01T10:00:00Z"), pick("b", "Frieren", "2026-09-03T10:00:00Z", { state: "rated", feedback: "good" })] };
    const laptop = { history: [pick("b", "Frieren", "2026-09-02T10:00:00Z"), pick("c", "Odd Taxi", "2026-09-05T10:00:00Z")] };
    const merged = mergeSnapshots(phone, laptop);
    assert.deepEqual(merged.history.map((entry) => entry.id), ["c", "b", "a"]);
    assert.equal(merged.history.find((entry) => entry.id === "b").feedback, "good", "the later answer wins");
  });

  it("a deletion on one device sticks, unless the pick was changed again afterwards", () => {
    const deleted = { history: [], deleted: { a: "2026-09-02T00:00:00Z", b: "2026-09-02T00:00:00Z" } };
    const other = { history: [pick("a", "Mushishi", "2026-09-01T00:00:00Z"), pick("b", "Frieren", "2026-09-03T00:00:00Z")] };
    const merged = mergeSnapshots(other, deleted, Date.parse("2026-09-04T00:00:00Z"));
    assert.deepEqual(merged.history.map((entry) => entry.id), ["b"]);
    assert.ok(merged.deleted.a, "the tombstone travels on");
  });

  it("clearing the log clears it everywhere, but not what's picked after", () => {
    const cleared = { history: [pick("new", "Odd Taxi", "2026-09-10T00:00:00Z")], clearedAt: "2026-09-05T00:00:00Z" };
    const old = { history: [pick("a", "Mushishi", "2026-09-01T00:00:00Z")] };
    assert.deepEqual(mergeSnapshots(old, cleared).history.map((entry) => entry.id), ["new"]);
  });

  it("forgets tombstones once they're old", () => {
    const merged = mergeSnapshots({ deleted: { a: "2026-01-01T00:00:00Z" } }, {}, Date.parse("2026-09-01T00:00:00Z"));
    assert.deepEqual(merged.deleted, {});
  });

  it("takes the most recently changed preferences", () => {
    const merged = mergeSnapshots(
      { preferences: { excludedGenres: ["Horror"], updatedAt: "2026-09-01T00:00:00Z" } },
      { preferences: { excludedGenres: ["Isekai"], updatedAt: "2026-09-02T00:00:00Z" } }
    );
    assert.deepEqual(merged.preferences.excludedGenres, ["Isekai"]);
  });

  it("drops anything that isn't a logged pick", () => {
    const merged = mergeSnapshots({ history: [null, { id: 1 }, { id: "x" }, pick("a", "Mushishi", "2026-09-01T00:00:00Z")] }, {});
    assert.deepEqual(merged.history.map((entry) => entry.id), ["a"]);
  });
});

describe("the log on this device", () => {
  beforeEach(() => {
    globalThis.localStorage = memoryStorage();
  });

  it("stamps each write, and remembers deletions and clears", () => {
    appendHistory(pick("a", "Mushishi", "2026-09-01T00:00:00Z"));
    const stamped = loadHistory()[0].updated_at;
    assert.ok(Date.parse(stamped) > Date.parse("2026-09-01T00:00:00Z"));
    updateHistoryEntry("a", { state: "rated", feedback: "good" });
    assert.ok(loadHistory()[0].updated_at >= stamped);
    deleteHistoryEntry("a");
    assert.ok(loadTombstones().deleted.a);
    clearRecommendationLog();
    assert.ok(loadTombstones().clearedAt);
    assert.deepEqual(loadTombstones().deleted, {});
  });

  it("merges a synced copy without losing what changed here meanwhile", () => {
    appendHistory(pick("mine", "Mushishi", "2026-09-01T00:00:00Z"));
    const remote = { history: [pick("theirs", "Frieren", "2026-09-02T00:00:00Z")], deleted: {}, clearedAt: "" };
    assert.equal(applyRemoteSnapshot(remote), true);
    assert.deepEqual(loadHistory().map((entry) => entry.id).sort(), ["mine", "theirs"]);
    assert.equal(applyRemoteSnapshot(localSnapshot()), false, "nothing new the second time");
  });

  it("loads a log file and says how many picks it added", () => {
    appendHistory(pick("mine", "Mushishi", "2026-09-01T00:00:00Z"));
    const file = JSON.stringify({ app: "En", history: [pick("mine", "Mushishi", "2026-08-01T00:00:00Z"), pick("old", "Frieren", "2026-08-02T00:00:00Z")] });
    assert.equal(importLogText(file), 1);
    assert.throws(() => importLogText("{}"), /isn't an En log/);
    assert.throws(() => importLogText("not json"), /isn't an En log/);
  });

  it("reads sync codes however they're typed", () => {
    assert.equal(normalizeSyncCode("abcd efgh jkmn pqrs tuvw"), "ABCD-EFGH-JKMN-PQRS-TUVW");
    assert.equal(normalizeSyncCode("ABCD-EFGH"), "");
    assert.equal(normalizeSyncCode("ABCD-EFGH-JKMN-PQRS-TUV1"), "", "1 is never in a code");
  });
});

// ---------- api/sync ----------

async function call(handler, req) {
  const res = {
    code: 0,
    body: null,
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ headers: {}, query: {}, ...req }, res);
  return res;
}

const savedEnv = { ...process.env };
after(() => {
  process.env = savedEnv;
});

describe("api/sync", () => {
  beforeEach(() => {
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "kv-token";
  });

  // A tiny Upstash: GET/SET/DEL on a Map, plus MAL's /users/@me.
  function fakeServices(store = new Map()) {
    return (url, body) => {
      if (url.startsWith("https://api.myanimelist.net/v2/users/@me")) return json({ id: 4242, name: "someone" });
      const [command, key, value] = body;
      if (command === "GET") return json({ result: store.get(key) ?? null });
      if (command === "SET") {
        store.set(key, value);
        return json({ result: "OK" });
      }
      if (command === "DEL") return json({ result: store.delete(key) ? 1 : 0 });
      return json({ error: "unknown" }, 400);
    };
  }

  it("says whether storage is set up, without credentials", async () => {
    assert.deepEqual((await call(syncHandler, { method: "GET" })).body, { configured: true });
    delete process.env.KV_REST_API_URL;
    assert.deepEqual((await call(syncHandler, { method: "GET" })).body, { configured: false });
    const res = await call(syncHandler, { method: "PUT", headers: { "x-en-sync-code": "ABCD-EFGH-JKMN-PQRS-TUVW" }, body: { data: {} } });
    assert.equal(res.code, 501);
    assert.equal(res.body.code, "not_configured");
  });

  it("files a MAL user's log under their MAL id, and merges what each device sends", async () => {
    const store = new Map();
    const headers = { authorization: "Bearer mal-token" };
    const first = await withFetch(fakeServices(store), () =>
      call(syncHandler, { method: "PUT", headers, body: { data: { history: [pick("a", "Mushishi", "2026-09-01T00:00:00Z")] } } })
    );
    assert.equal(first.result.code, 200);
    assert.ok(store.has("en:log:mal:4242"));
    assert.equal(first.calls[0].headers.Authorization, "Bearer mal-token", "the token is checked with MAL");
    assert.equal(first.calls.at(-1).headers.Authorization, "Bearer kv-token");
    assert.deepEqual(first.calls.at(-1).body.slice(3), ["EX", String(400 * 24 * 60 * 60)]);

    const second = await withFetch(fakeServices(store), () =>
      call(syncHandler, { method: "PUT", headers, body: { data: { history: [pick("b", "Frieren", "2026-09-02T00:00:00Z")] } } })
    );
    assert.deepEqual(second.result.body.data.history.map((entry) => entry.id), ["b", "a"]);

    const read = await withFetch(fakeServices(store), () => call(syncHandler, { method: "GET", headers }));
    assert.equal(read.result.body.data.history.length, 2);
  });

  it("files a sync code's log under its hash, never the code itself", async () => {
    const store = new Map();
    const headers = { "x-en-sync-code": "abcd-efgh-jkmn-pqrs-tuvw" };
    await withFetch(fakeServices(store), () => call(syncHandler, { method: "PUT", headers, body: { data: { history: [] } } }));
    const [key] = store.keys();
    assert.match(key, /^en:log:code:[0-9a-f]{64}$/);
    assert.ok(!key.includes("ABCD"));

    const bad = await call(syncHandler, { method: "GET", headers: { "x-en-sync-code": "hello" } });
    assert.equal(bad.code, 400);
  });

  it("passes on an expired MAL session so the app can refresh it", async () => {
    const { result } = await withFetch(() => json({ error: "invalid_token" }, 401), () =>
      call(syncHandler, { method: "GET", headers: { authorization: "Bearer old" } })
    );
    assert.equal(result.code, 401);
    assert.equal(result.body.code, "auth");
  });

  it("deletes the stored copy when asked", async () => {
    const store = new Map([["en:log:mal:4242", "{}"]]);
    await withFetch(fakeServices(store), () => call(syncHandler, { method: "DELETE", headers: { authorization: "Bearer t" } }));
    assert.equal(store.size, 0);
  });
});

// ---------- api/mal-status ----------

describe("api/mal-status (En -> MyAnimeList)", () => {
  it("only ever moves a show forward on the list", () => {
    assert.deepEqual(planListUpdate("tonight", null), { status: "watching" });
    assert.deepEqual(planListUpdate("tonight", { status: "on_hold" }), { status: "watching" });
    assert.equal(planListUpdate("tonight", { status: "completed" }), null);
    assert.deepEqual(planListUpdate("later", null), { status: "plan_to_watch" });
    assert.equal(planListUpdate("later", { status: "watching" }), null);
    assert.deepEqual(planListUpdate("good", { status: "watching" }, 12), { status: "completed", num_watched_episodes: 12 });
    assert.equal(planListUpdate("good", { status: "dropped" }, 12), null);
    assert.equal(planListUpdate("good", { status: "completed", score: 9 }, 12), null, "never touches a finished show or its score");
    assert.deepEqual(planListUpdate("meh", null, 0), { status: "completed" });
    assert.equal(planListUpdate("meh", { status: "watching" }, 12), null, "meh may mean they stopped partway");
  });

  it("reads the current status, then updates with a form post", async () => {
    const { result, calls } = await withFetch(
      (url) => (url.includes("my_list_status") && !url.includes("fields") ? json({ status: "watching" }) : json({ id: 5, num_episodes: 13, my_list_status: { status: "plan_to_watch" } })),
      () => call(malStatusHandler, { method: "POST", headers: { authorization: "Bearer t" }, body: { malId: 5, action: "tonight" } })
    );
    assert.deepEqual(result.body, { changed: true, status: "watching", from: "plan_to_watch" });
    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.endsWith("/anime/5/my_list_status"));
  });

  it("changes nothing when the list is already ahead", async () => {
    const { result, calls } = await withFetch(() => json({ id: 5, num_episodes: 13, my_list_status: { status: "completed", score: 8 } }), () =>
      call(malStatusHandler, { method: "POST", headers: { authorization: "Bearer t" }, body: { malId: 5, action: "good" } })
    );
    assert.deepEqual(result.body, { changed: false, status: "completed" });
    assert.equal(calls.length, 1);
  });

  it("rejects bad input and passes on auth problems", async () => {
    assert.equal((await call(malStatusHandler, { method: "POST", headers: { authorization: "Bearer t" }, body: { malId: "x", action: "good" } })).code, 400);
    assert.equal((await call(malStatusHandler, { method: "POST", headers: { authorization: "Bearer t" }, body: { malId: 5, action: "delete" } })).code, 400);
    assert.equal((await call(malStatusHandler, { method: "POST", body: { malId: 5, action: "good" } })).code, 401);
    const { result } = await withFetch(() => json({}, 401), () =>
      call(malStatusHandler, { method: "POST", headers: { authorization: "Bearer t" }, body: { malId: 5, action: "good" } })
    );
    assert.equal(result.code, 401);
    assert.equal(result.body.code, "auth");
  });
});

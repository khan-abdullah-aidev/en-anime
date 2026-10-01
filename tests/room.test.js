import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import handler from "../api/room.js";
import { partnerListFromRoom, trimListForRoom } from "../src/rooms.js";
import { buildTogetherContext } from "../src/discovery.js";
import { buildRecommendationMemory } from "../src/recommendationEngine.js";
import { createFakeUpstash } from "./fake-upstash.js";
import { MAL_LIST } from "./fixtures.js";

const saved = { ...process.env };
after(() => {
  process.env = saved;
});

let upstash;
beforeEach(() => {
  process.env.KV_REST_API_URL = "https://kv.example";
  process.env.KV_REST_API_TOKEN = "kv-token";
  upstash = createFakeUpstash();
});

// Calls the handler with Upstash answered from memory.
async function call({ method, id, body, roomKey }) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    new Response(JSON.stringify(upstash.respond(url, JSON.parse(init.body))), { status: 200 });
  const res = { code: 0, body: null, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    await handler({ method, query: id ? { id } : {}, headers: roomKey ? { "x-en-room-key": roomKey } : {}, body }, res);
  } finally {
    globalThis.fetch = real;
  }
  return res;
}

const guestKey = "g".repeat(32);
const list = [{ id: 1, title: "Mushishi", my_list_status: { status: "completed", score: 9 } }];

describe("api/room (two phones, one pick)", () => {
  it("makes a room and hands the host a key that's never stored as itself", async () => {
    const created = await call({ method: "POST", body: { hostName: "Abdullah" } });
    assert.equal(created.code, 200);
    assert.match(created.body.id, /^[A-Za-z0-9_-]{20}$/);
    assert.ok(![...upstash.strings.values()].some((value) => value.includes(created.body.hostKey)));
    const room = await call({ method: "GET", id: created.body.id });
    assert.deepEqual({ hostName: room.body.hostName, guest: room.body.guest, picks: room.body.picks }, { hostName: "Abdullah", guest: null, picks: [] });
  });

  it("lets one person join, and only the host read their list", async () => {
    const { id, hostKey } = (await call({ method: "POST", body: { hostName: "Abdullah" } })).body;
    const joined = await call({ method: "PUT", id, body: { action: "join", key: guestKey, name: "Sam", mood: "something funny", list, seenTitles: ["Frieren"] } });
    assert.equal(joined.code, 200);

    const asAnyone = await call({ method: "GET", id });
    assert.deepEqual(asAnyone.body.guest.name, "Sam");
    assert.equal(asAnyone.body.guest.list, undefined, "the link alone doesn't show their list");
    const asHost = await call({ method: "GET", id, roomKey: hostKey });
    assert.deepEqual(asHost.body.guest.list, list);
    assert.deepEqual(asHost.body.guest.seenTitles, ["Frieren"]);

    const again = await call({ method: "PUT", id, body: { action: "join", key: guestKey, name: "Sam", mood: "something sad", list } });
    assert.equal(again.code, 200, "the same person can change their answer");
    const someoneElse = await call({ method: "PUT", id, body: { action: "join", key: "x".repeat(32), name: "Eve", list } });
    assert.equal(someoneElse.code, 409);
    assert.equal(someoneElse.body.code, "taken");
  });

  it("takes picks only from the host, and passes only from whoever joined", async () => {
    const { id, hostKey } = (await call({ method: "POST", body: { hostName: "A" } })).body;
    await call({ method: "PUT", id, body: { action: "join", key: guestKey, name: "Sam", list } });
    const pick = { id: "pick-1", recommendation: { title: "Barakamon", reason: "r", reason_for_them: "r2" } };

    assert.equal((await call({ method: "PUT", id, body: { action: "pick", key: guestKey, pick } })).code, 403);
    assert.equal((await call({ method: "PUT", id, body: { action: "pick", key: hostKey, pick } })).code, 200);
    assert.equal((await call({ method: "PUT", id, body: { action: "pass", key: hostKey, pass: { pickId: "pick-1" } } })).code, 403);
    assert.equal((await call({ method: "PUT", id, body: { action: "pass", key: guestKey, pass: { pickId: "pick-1", reason: "too heavy" } } })).code, 200);
    assert.equal((await call({ method: "PUT", id, body: { action: "host", key: hostKey, hostMood: "rain on a tuesday" } })).code, 200);

    const room = (await call({ method: "GET", id })).body;
    assert.equal(room.picks[0].recommendation.reason_for_them, "r2");
    assert.deepEqual([room.passes[0].pickId, room.passes[0].reason], ["pick-1", "too heavy"]);
    assert.equal(room.hostMood, "rain on a tuesday");
  });

  it("says when a link has run out, or isn't one", async () => {
    assert.equal((await call({ method: "GET", id: "a".repeat(20) })).body.code, "gone");
    assert.equal((await call({ method: "GET", id: "nope" })).code, 400);
    delete process.env.KV_REST_API_URL;
    assert.equal((await call({ method: "POST", body: {} })).code, 501);
  });

  it("only the host can close it", async () => {
    const { id, hostKey } = (await call({ method: "POST", body: { hostName: "A" } })).body;
    assert.equal((await call({ method: "DELETE", id })).code, 403);
    assert.equal((await call({ method: "DELETE", id, roomKey: hostKey })).code, 200);
    assert.equal((await call({ method: "GET", id })).code, 404);
  });
});

describe("the other person's list, sent over", () => {
  it("keeps only what En reads", () => {
    const trimmed = trimListForRoom([{ ...MAL_LIST[1], image_url: "https://img", mean_score: 9.1 }]);
    assert.deepEqual(Object.keys(trimmed[0]).sort(), ["alternative_titles", "episodes", "genres", "id", "my_list_status", "title", "updated_at"]);
    assert.equal(trimListForRoom("a".repeat(7000)).length, 6000);
  });

  it("counts what they've seen through their own En log as seen", () => {
    const partnerList = partnerListFromRoom({ list: trimListForRoom(MAL_LIST), seenTitles: ["Haibane Renmei"] });
    const context = buildTogetherContext({
      you: { list: [], history: [], memory: buildRecommendationMemory({ malList: [], history: [] }) },
      partner: { list: partnerList }
    });
    assert.ok(context.partnerSeenKeys.has("haibanerenmei"));
    assert.ok(context.partnerSeenIds.has(2));
    assert.equal(partnerListFromRoom({ list: "Mushishi", seenTitles: ["Frieren"] }), "Mushishi, Frieren");
  });
});

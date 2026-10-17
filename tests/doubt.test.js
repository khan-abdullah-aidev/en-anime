import test from "node:test";
import assert from "node:assert/strict";
import { doubtFor } from "../src/doubt.js";

const pool = Array.from({ length: 10 }, (_, i) => ({ title: `Show ${i}` }));
const list = Array.from({ length: 8 }, (_, i) => ({ title: `Seen ${i}`, my_list_status: { status: "completed" } }));

test("a pick says why En isn't sure, and nothing when it is", () => {
  assert.equal(doubtFor({ pick: {}, candidateList: pool, steering: {}, list }), "");
  assert.equal(doubtFor({ pick: {}, candidateList: pool.slice(0, 2), steering: { constraintsRelaxed: true }, list }), "");
  assert.match(doubtFor({ pick: {}, candidateList: pool.slice(0, 3), steering: {}, list }), /much left/);
  assert.match(doubtFor({ pick: {}, candidateList: pool, steering: {}, list: list.slice(0, 2) }), /taste well yet/);
  assert.match(doubtFor({ pick: {}, candidateList: pool, steering: {}, list: "Mushishi, Frieren" }), /taste well yet/);
  assert.equal(doubtFor({ pick: { fallback: true }, candidateList: [], steering: { constraintsRelaxed: true }, list }), "");
});

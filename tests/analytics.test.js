import test from "node:test";
import assert from "node:assert/strict";
import { anonymousEvent, anonymousUrl } from "../src/analytics.js";

test("stats see the screen, never an id, a query or the sign-in code", () => {
  assert.equal(anonymousUrl("https://en-anime.vercel.app/pick/7fab3704-2b99"), "https://en-anime.vercel.app/pick");
  assert.equal(anonymousUrl("https://en-anime.vercel.app/room/abc123?k=secret"), "https://en-anime.vercel.app/room");
  assert.equal(anonymousUrl("https://en-anime.vercel.app/callback?code=xyz&state=1"), "https://en-anime.vercel.app/callback");
  assert.equal(anonymousUrl("https://en-anime.vercel.app/tonight"), "https://en-anime.vercel.app/tonight");
  assert.deepEqual(anonymousEvent({ type: "pageview", url: "https://en-anime.vercel.app/pick/x" }), { type: "pageview", url: "https://en-anime.vercel.app/pick" });
});

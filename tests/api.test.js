import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import handler from "../api/en.js";
import { buildResponseSchema } from "../api/_lib/schemas.js";
import { json, withFetch } from "./fixtures.js";

const candidates = [{ title: "Haibane Renmei" }, { title: "Mushishi" }, { title: "Haibane Renmei" }];
const ok = (text) => json({ candidates: [{ content: { parts: [{ text }] } }] });
const fail = (status, message) => json({ error: { message } }, status);

async function call(body) {
  const res = {
    code: 0,
    body: null,
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ method: "POST", body }, res);
  return res;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  for (const key of ["GEMINI_API_KEY", "VITE_GEMINI_API_KEY", "VITE_GOOGLE_AI_API_KEY", "GEMINI_MODEL", "GEMINI_FALLBACK_MODEL"]) delete process.env[key];
  process.env.GEMINI_API_KEY = "test-key";
});
after(() => {
  process.env = savedEnv;
});

describe("api/en", () => {
  it("rejects unknown kinds (including prototype keys), missing payloads and huge payloads", async () => {
    assert.equal((await call({ kind: "constructor", payload: {} })).code, 400);
    assert.equal((await call({ kind: "nope", payload: {} })).code, 400);
    assert.equal((await call({ kind: "recommend" })).code, 400);
    assert.equal((await call({ kind: "recommend", payload: { blob: "x".repeat(130000) } })).code, 413);
  });

  it("reports a missing key as a configuration error, not a model failure", async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await call({ kind: "recommend", payload: { mood: "x" } });
    assert.equal(res.code, 500);
    assert.equal(res.body.code, "not_configured");
  });

  it("calls 3.8 Flash with the key in a header, the right prompt, a schema and no temperature", async () => {
    const { result, calls } = await withFetch(() => ok("{}"), () =>
      call({ kind: "verdict", payload: { queriedTitles: ["Chainsaw Man"], candidateList: candidates, watchHistory: { source: "myanimelist" } } })
    );
    assert.equal(result.code, 200);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/gemini-3.8-flash:generateContent"));
    assert.ok(!calls[0].url.includes("test-key"));
    assert.equal(calls[0].headers["x-goog-api-key"], "test-key");
    assert.match(calls[0].body.systemInstruction.parts[0].text, /queriedTitleHistory/);
    assert.equal(JSON.parse(calls[0].body.contents[0].parts[0].text).watchHistory.source, "myanimelist");
    assert.ok(calls[0].body.generationConfig.responseSchema);
    assert.equal(calls[0].body.generationConfig.temperature, undefined);
  });

  it("falls back to 3.5 Flash-Lite when the primary model fails", async () => {
    const { result, calls } = await withFetch((url) => (url.includes("flash-lite") ? ok('{"title":"x"}') : fail(503, "overloaded")), () =>
      call({ kind: "recommend", payload: { candidateList: candidates } })
    );
    assert.equal(result.body.content, '{"title":"x"}');
    assert.deepEqual(calls.map((c) => c.url.split("/").pop()), ["gemini-3.8-flash:generateContent", "gemini-3.5-flash-lite:generateContent"]);
  });

  it("retries the same model without the schema if Gemini rejects it", async () => {
    const { result, calls } = await withFetch(
      (url, body) => (body.generationConfig.responseSchema ? fail(400, "Invalid JSON payload: responseSchema") : ok('{"title":"Mushishi"}')),
      () => call({ kind: "recommend", payload: { candidateList: candidates } })
    );
    assert.equal(result.code, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.generationConfig.responseSchema, undefined);
  });

  it("fails cleanly after bounded attempts on a bad key", async () => {
    const { result, calls } = await withFetch(() => fail(400, "API key not valid"), () =>
      call({ kind: "recommend", payload: { candidateList: candidates } })
    );
    assert.equal(result.code, 502);
    assert.match(result.body.error, /API key not valid/);
    assert.equal(calls.length, 4);
  });

  it("lets the models be overridden from the environment", async () => {
    process.env.GEMINI_MODEL = "gemini-9-flash";
    process.env.GEMINI_FALLBACK_MODEL = "gemini-9-flash";
    const { calls } = await withFetch(() => fail(503, "overloaded"), () => call({ kind: "recommend", payload: { candidateList: candidates } }));
    assert.deepEqual(calls.map((c) => c.url.split("/").pop()), ["gemini-9-flash:generateContent"]);
  });
});

describe("response schemas", () => {
  it("limits title to the candidates (recommend), the user's titles (choose), or either (verdict)", () => {
    assert.deepEqual(buildResponseSchema("recommend", { candidateList: candidates }).properties.title.enum, ["Haibane Renmei", "Mushishi"]);
    assert.deepEqual(buildResponseSchema("choose", { queriedTitles: ["frieren", "Chainsaw Man"] }).properties.title.enum, ["frieren", "Chainsaw Man"]);
    const verdict = buildResponseSchema("verdict", { queriedTitles: ["Chainsaw Man"], candidateList: candidates });
    assert.deepEqual(verdict.properties.verdict.enum, ["yes", "no"]);
    assert.deepEqual(verdict.properties.title.enum, ["Chainsaw Man", "Haibane Renmei", "Mushishi"]);
    assert.deepEqual(verdict.required.slice(0, 2), ["verdict", "queried_title"]);
  });

  it("never sends an empty enum", () => {
    assert.deepEqual(buildResponseSchema("recommend", { candidateList: [] }).properties.title, { type: "STRING" });
  });
});

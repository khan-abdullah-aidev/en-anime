import crypto from "node:crypto";
import { kvCommand, kvConfig } from "./_lib/kv.js";
import { emptySnapshot, mergeSnapshots, normalizeSnapshot } from "../src/syncMerge.js";

// Keeps a copy of the log (and the user's preferences) so it can follow them
// to other devices. Whose copy it is comes from either:
//  - their MyAnimeList login: the token is checked with MAL, and the copy is
//    filed under their MAL user id, so signing in anywhere finds it, or
//  - a sync code (for username and typed-list users): a random code made on
//    their first device, filed under its hash.
// GET with no credentials just says whether storage is set up at all.
const MAL_ME_URL = "https://api.myanimelist.net/v2/users/@me";
const SYNC_CODE = /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){4}$/;
const KEY_PREFIX = "en:log:";
const MAX_BODY_CHARS = 2_000_000;
// A copy nobody has synced for this long is let go.
const TTL_SECONDS = 400 * 24 * 60 * 60;

export default async function handler(req, res) {
  // Same-origin only: no CORS headers, so other sites' scripts can't call this.
  if (!["GET", "PUT", "DELETE"].includes(req.method)) {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const config = kvConfig();
  if (req.method === "GET" && !hasCredentials(req)) {
    res.status(200).json({ configured: Boolean(config) });
    return;
  }
  if (!config) {
    res.status(501).json({ error: "Syncing isn't set up on this server yet.", code: "not_configured" });
    return;
  }

  let key;
  try {
    key = await storageKey(req);
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message, code: error.code });
    return;
  }

  let incoming = null;
  if (req.method === "PUT") {
    incoming = req.body?.data;
    if (!incoming || typeof incoming !== "object") {
      res.status(400).json({ error: "Expected { data }." });
      return;
    }
    if (JSON.stringify(incoming).length > MAX_BODY_CHARS) {
      res.status(413).json({ error: "The log is too large to sync." });
      return;
    }
  }

  try {
    if (req.method === "DELETE") {
      await kvCommand(config, ["DEL", key]);
      res.status(200).json({ ok: true });
      return;
    }

    const raw = await kvCommand(config, ["GET", key]);
    const stored = raw ? parseStored(raw) : null;
    if (req.method === "GET") {
      res.status(200).json({ configured: true, data: stored });
      return;
    }

    // Merged here, not on the device, so two devices syncing one after the
    // other both end up with everything.
    const merged = mergeSnapshots(incoming, stored || emptySnapshot());
    await kvCommand(config, ["SET", key, JSON.stringify(merged), "EX", String(TTL_SECONDS)]);
    res.status(200).json({ data: merged });
  } catch (error) {
    console.warn("[En] sync storage failed", error.message);
    res.status(502).json({ error: "En couldn't reach its storage. Try again in a moment." });
  }
}

function hasCredentials(req) {
  return Boolean(req.headers["x-en-sync-code"] || req.headers.authorization);
}

async function storageKey(req) {
  const code = String(req.headers["x-en-sync-code"] || "").trim().toUpperCase();
  if (code) {
    if (!SYNC_CODE.test(code)) throw httpError(400, "That isn't a sync code En made.", "bad_code");
    return `${KEY_PREFIX}code:${crypto.createHash("sha256").update(code).digest("hex")}`;
  }

  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) throw httpError(401, "Missing credentials.");
  let response;
  try {
    response = await fetch(MAL_ME_URL, { headers: { Authorization: authorization } });
  } catch {
    throw httpError(502, "MyAnimeList didn't answer. Try again in a moment.");
  }
  if (response.status === 401) throw httpError(401, "Your MyAnimeList session expired.", "auth");
  const user = await response.json().catch(() => ({}));
  if (!response.ok || !user?.id) throw httpError(502, "MyAnimeList didn't answer. Try again in a moment.");
  return `${KEY_PREFIX}mal:${user.id}`;
}

function parseStored(raw) {
  try {
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

import crypto from "node:crypto";
import { kvConfig, kvPipeline } from "./_lib/kv.js";

// "For two, from two phones": a short-lived room both phones share. The
// person who makes the link (the host) gets a host key, the one who joins
// makes a guest key; each key is the only way to write that side, and only
// the hash is stored. The guest's list goes in once, can only be read back
// with the host key, and everything expires after ROOM_TTL_SECONDS.
//
//   POST   /api/room                          { hostName } -> { id, hostKey }
//   GET    /api/room?id=                      -> the room (guest's list too, with X-En-Room-Key = hostKey)
//   PUT    /api/room?id=  { action: "host",  key, hostName?, hostMood? }
//                         { action: "join",  key, name, mood, list, seenTitles, excludedGenres }
//                         { action: "pick",  key, pick: { id, recommendation } }
//                         { action: "pass",  key, pass: { pickId, reason } }
//   DELETE /api/room?id=  (host key)
const ROOM_TTL_SECONDS = 12 * 60 * 60;
const ROOM_ID = /^[A-Za-z0-9_-]{20}$/;
const KEY = /^[A-Za-z0-9_-]{24,64}$/;
const MAX_GUEST_CHARS = 700_000;
const MAX_PICK_CHARS = 20_000;
const MAX_PICKS = 20;

export default async function handler(req, res) {
  // Same-origin only: no CORS headers, so other sites' scripts can't call this.
  if (!["GET", "POST", "PUT", "DELETE"].includes(req.method)) {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const config = kvConfig();
  if (!config) {
    res.status(501).json({ error: "Picking from two phones isn't set up on this server yet.", code: "not_configured" });
    return;
  }

  try {
    if (req.method === "POST") {
      const id = crypto.randomBytes(15).toString("base64url");
      const hostKey = crypto.randomBytes(24).toString("base64url");
      const meta = { createdAt: new Date().toISOString(), hostName: clean(req.body?.hostName, 40), hostMood: "", hostKeyHash: hash(hostKey) };
      await kvPipeline(config, [["SET", keys(id).meta, JSON.stringify(meta), "EX", String(ROOM_TTL_SECONDS)]]);
      res.status(200).json({ id, hostKey });
      return;
    }

    const id = String(req.query?.id || "");
    if (!ROOM_ID.test(id)) {
      res.status(400).json({ error: "That isn't a link En made." });
      return;
    }
    const k = keys(id);
    const [rawMeta, rawGuest, picks, passes] = await kvPipeline(config, [
      ["GET", k.meta],
      ["GET", k.guest],
      ["LRANGE", k.picks, "0", "-1"],
      ["LRANGE", k.passes, "0", "-1"]
    ]);
    const meta = parse(rawMeta);
    if (!meta) {
      res.status(404).json({ error: "This link has run out. Ask them for a new one.", code: "gone" });
      return;
    }
    const guest = parse(rawGuest);
    const roomKey = String(req.headers["x-en-room-key"] || "");
    const isHost = KEY.test(roomKey) && hash(roomKey) === meta.hostKeyHash;

    if (req.method === "GET") {
      res.status(200).json({
        id,
        createdAt: meta.createdAt,
        hostName: meta.hostName,
        hostMood: meta.hostMood,
        guest: guest
          ? {
              name: guest.name,
              mood: guest.mood,
              joinedAt: guest.joinedAt,
              ...(isHost ? { list: guest.list, seenTitles: guest.seenTitles, excludedGenres: guest.excludedGenres } : {})
            }
          : null,
        picks: (picks || []).map(parse).filter(Boolean),
        passes: (passes || []).map(parse).filter(Boolean)
      });
      return;
    }

    if (req.method === "DELETE") {
      if (!isHost) throw httpError(403, "Only whoever made the link can close it.");
      await kvPipeline(config, [["DEL", k.meta, k.guest, k.picks, k.passes]]);
      res.status(200).json({ ok: true });
      return;
    }

    // PUT
    const body = req.body || {};
    const key = String(body.key || "");
    const asHost = KEY.test(key) && hash(key) === meta.hostKeyHash;
    const ttl = String(ROOM_TTL_SECONDS);

    if (body.action === "host") {
      if (!asHost) throw httpError(403, "Only whoever made the link can change it.");
      const next = {
        ...meta,
        ...(typeof body.hostName === "string" ? { hostName: clean(body.hostName, 40) } : {}),
        ...(typeof body.hostMood === "string" ? { hostMood: clean(body.hostMood, 300) } : {})
      };
      await kvPipeline(config, [["SET", k.meta, JSON.stringify(next), "KEEPTTL"]]);
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === "join") {
      if (!KEY.test(key)) throw httpError(400, "Expected a guest key.");
      if (guest && guest.keyHash !== hash(key)) throw httpError(409, "Someone else has already joined this one.", "taken");
      const list = Array.isArray(body.list) ? body.list.slice(0, 1500) : typeof body.list === "string" ? body.list.slice(0, 6000) : null;
      if (!list || (Array.isArray(list) ? !list.length : !list.trim())) throw httpError(400, "En needs a list to read.");
      const next = {
        name: clean(body.name, 40),
        mood: clean(body.mood, 300),
        list,
        seenTitles: (Array.isArray(body.seenTitles) ? body.seenTitles : []).filter((title) => typeof title === "string").slice(0, 300).map((title) => title.slice(0, 200)),
        excludedGenres: (Array.isArray(body.excludedGenres) ? body.excludedGenres : []).filter((label) => typeof label === "string").slice(0, 40),
        joinedAt: guest?.joinedAt || new Date().toISOString(),
        keyHash: hash(key)
      };
      const text = JSON.stringify(next);
      if (text.length > MAX_GUEST_CHARS) throw httpError(413, "That list is too long to send.");
      await kvPipeline(config, [["SET", k.guest, text, "EX", ttl]]);
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === "pick") {
      if (!asHost) throw httpError(403, "Only whoever made the link can pick.");
      const pick = body.pick;
      if (!pick || typeof pick.id !== "string" || !pick.recommendation?.title) throw httpError(400, "Expected a pick.");
      const text = JSON.stringify({ id: pick.id, recommendation: pick.recommendation, at: new Date().toISOString() });
      if (text.length > MAX_PICK_CHARS) throw httpError(413, "That pick is too large.");
      await kvPipeline(config, [["RPUSH", k.picks, text], ["LTRIM", k.picks, String(-MAX_PICKS), "-1"], ["EXPIRE", k.picks, ttl]]);
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action === "pass") {
      if (!guest || guest.keyHash !== hash(key)) throw httpError(403, "Only whoever joined can pass on a pick.");
      const pass = { pickId: String(body.pass?.pickId || "").slice(0, 80), reason: clean(body.pass?.reason, 40), at: new Date().toISOString() };
      if (!pass.pickId) throw httpError(400, "Expected the pick being passed on.");
      await kvPipeline(config, [["RPUSH", k.passes, JSON.stringify(pass)], ["LTRIM", k.passes, String(-MAX_PICKS), "-1"], ["EXPIRE", k.passes, ttl]]);
      res.status(200).json({ ok: true });
      return;
    }

    throw httpError(400, "Unknown action.");
  } catch (error) {
    if (error.status) {
      res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      return;
    }
    console.warn("[En] room storage failed", error.message);
    res.status(502).json({ error: "En couldn't reach its storage. Try again in a moment." });
  }
}

function keys(id) {
  const base = `en:room:${id}`;
  return { meta: base, guest: `${base}:guest`, picks: `${base}:picks`, passes: `${base}:passes` };
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function parse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

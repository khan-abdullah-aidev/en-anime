import { MalAuthError } from "./mal.js";
import { loadPreferences, writePreferences } from "./preferences.js";
import {
  forgetDerivedMemory,
  loadHistory,
  loadTombstones,
  removeRecommendationFromMemory,
  replaceHistory,
  saveTombstones
} from "./storage.js";
import { mergeSnapshots, normalizeSnapshot, sameSnapshot } from "./syncMerge.js";

// The log on other devices (server side: api/sync.js). This device's
// settings: { enabled, via: "mal" | "code", code, lastSyncedAt, probed }.
// "probed" records that a MAL sign-in already checked for a copy made on
// another device, so it isn't checked on every visit.
const SYNC_KEY = "en.sync";
// No 0/O or 1/I, so a code read off one screen can be typed on another.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function loadSyncSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function saveSyncSettings(settings) {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable; syncing just won't be remembered
  }
  return settings;
}

export function generateSyncCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return chars.match(/.{4}/g).join("-");
}

// However it was typed ("abcd efgh...", with or without dashes), or "" if it
// can't be a code.
export function normalizeSyncCode(text) {
  const chars = String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return chars.length === 20 && /^[A-Z2-9]+$/.test(chars) ? chars.match(/.{4}/g).join("-") : "";
}

export function localSnapshot() {
  const { deleted, clearedAt } = loadTombstones();
  return normalizeSnapshot({ history: loadHistory(), deleted, clearedAt, preferences: loadPreferences() });
}

// Merges another copy into this device's and saves the result. Merging
// against the current local state (not the one sent to the server) keeps any
// answer given while the sync was in flight. Returns whether anything here
// changed.
export function applyRemoteSnapshot(remote) {
  const before = localSnapshot();
  const next = mergeSnapshots(before, remote);
  if (sameSnapshot(before, next)) return false;

  const kept = new Set(next.history.map((entry) => entry.id));
  for (const entry of before.history) {
    if (!kept.has(entry.id)) removeRecommendationFromMemory(entry.recommendation);
  }
  if (next.clearedAt && next.clearedAt !== before.clearedAt) forgetDerivedMemory();
  replaceHistory(next.history);
  saveTombstones({ deleted: next.deleted, clearedAt: next.clearedAt });
  if (next.preferences) writePreferences(next.preferences);
  return true;
}

// Whether the server has storage set up at all.
export async function syncAvailable() {
  try {
    const response = await fetch("/api/sync");
    const payload = await response.json().catch(() => ({}));
    return Boolean(response.ok && payload.configured);
  } catch {
    return false;
  }
}

// Sends this device's copy; the server merges it with the stored one and
// returns the result.
export async function pushSnapshot(credentials) {
  const { data } = await syncRequest("PUT", credentials, { data: localSnapshot() });
  return data;
}

export async function fetchRemoteSnapshot(credentials) {
  const { data } = await syncRequest("GET", credentials);
  return data || null;
}

export async function deleteRemoteSnapshot(credentials) {
  await syncRequest("DELETE", credentials);
}

// A backup file of the log, for keeping or for moving by hand.
export function exportLogBlob() {
  const snapshot = { ...localSnapshot(), exportedAt: new Date().toISOString(), app: "En" };
  return new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
}

// Merges a backup file into the log (nothing here is lost). Returns how many
// picks the file added.
export function importLogText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't an En log.");
  }
  const incoming = normalizeSnapshot(parsed);
  if (!incoming.history.length && !incoming.preferences) throw new Error("That file isn't an En log.");
  const before = new Set(loadHistory().map((entry) => entry.id));
  applyRemoteSnapshot(incoming);
  return loadHistory().filter((entry) => !before.has(entry.id)).length;
}

async function syncRequest(method, credentials, body) {
  const headers = credentials.code
    ? { "X-En-Sync-Code": credentials.code }
    : { Authorization: `Bearer ${credentials.token}` };
  if (body) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch("/api/sync", { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("En couldn't sync your log. Check your connection.");
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && payload.code === "auth") {
    throw new MalAuthError(payload.error || "Your MyAnimeList session expired.");
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `En couldn't sync your log (${response.status}).`), { code: payload.code });
  }
  return payload;
}

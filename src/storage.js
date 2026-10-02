const TOKEN_KEY = "en.malTokens";
const HISTORY_KEY = "en.recommendationHistory";
const OAUTH_KEY = "en.oauth";
const MANUAL_LIST_KEY = "en.manualList";
const TASTE_PROFILE_KEY = "en.tasteProfile";
const RECOMMENDATION_MEMORY_KEY = "en.recommendationMemory";
const PARTNER_KEY = "en.partner";
const LIST_SOURCE_KEY = "en.listSource";
const ACTIVE_MODE_KEY = "en.activeMode";
// Deleted log entries and when the log was last cleared, so another device
// syncing an older copy doesn't bring them back (see syncMerge.js).
const TOMBSTONES_KEY = "en.logTombstones";

export function loadTokens() {
  return readJson(TOKEN_KEY, null);
}

export function saveTokens(tokens) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

export function saveOauthSession(session) {
  localStorage.setItem(OAUTH_KEY, JSON.stringify(session));
}

export function loadOauthSession() {
  return readJson(OAUTH_KEY, null);
}

export function clearOauthSession() {
  localStorage.removeItem(OAUTH_KEY);
}

// Entries are saved the moment a pick is revealed (state "unrated"), so a pick
// is never lost just because the user closed the tab before rating it.
export function loadHistory() {
  const history = readJson(HISTORY_KEY, []);
  return Array.isArray(history)
    ? history.filter((entry) => Boolean(entry?.recommendation?.title))
    : [];
}

// Every write stamps updated_at, which is how syncing decides which
// device's copy of an entry is newer.
export function appendHistory(entry) {
  const next = [{ ...entry, updated_at: new Date().toISOString() }, ...loadHistory()];
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function updateHistoryEntry(id, patch) {
  const updated_at = new Date().toISOString();
  const next = loadHistory().map((entry) =>
    entry.id === id ? { ...entry, ...patch, updated_at } : entry
  );
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

// Several entries at once (e.g. what En looked up about past picks), in one write.
export function patchHistoryEntries(patches) {
  if (!patches.size) return loadHistory();
  const updated_at = new Date().toISOString();
  const next = loadHistory().map((entry) => (patches.has(entry.id) ? { ...entry, ...patches.get(entry.id), updated_at } : entry));
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function deleteHistoryEntry(id) {
  const entry = loadHistory().find((item) => item.id === id);
  const next = loadHistory().filter((item) => item.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  const tombstones = loadTombstones();
  saveTombstones({ ...tombstones, deleted: { ...tombstones.deleted, [id]: new Date().toISOString() } });

  if (entry?.recommendation) {
    removeRecommendationFromMemory(entry.recommendation);
  }

  return next;
}

export function clearRecommendationLog() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify([]));
  localStorage.removeItem(TASTE_PROFILE_KEY);
  localStorage.removeItem(RECOMMENDATION_MEMORY_KEY);
  saveTombstones({ deleted: {}, clearedAt: new Date().toISOString() });
  return [];
}

// Replaces the whole log, e.g. with the merged copy from a sync.
export function replaceHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  return loadHistory();
}

export function loadTombstones() {
  const value = readJson(TOMBSTONES_KEY, null);
  return {
    deleted: value?.deleted && typeof value.deleted === "object" ? value.deleted : {},
    clearedAt: typeof value?.clearedAt === "string" ? value.clearedAt : ""
  };
}

export function saveTombstones(tombstones) {
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(tombstones));
}

// What a log that's been cleared on another device leaves behind here.
export function forgetDerivedMemory() {
  localStorage.removeItem(TASTE_PROFILE_KEY);
  localStorage.removeItem(RECOMMENDATION_MEMORY_KEY);
}

export function loadTasteProfileCache() {
  return readJson(TASTE_PROFILE_KEY, null);
}

export function saveTasteProfileCache(profile) {
  localStorage.setItem(TASTE_PROFILE_KEY, JSON.stringify(profile));
}

export function loadRecommendationMemoryCache() {
  return readJson(RECOMMENDATION_MEMORY_KEY, {
    recommended: [],
    completed: [],
    rejected: [],
    watchlisted: [],
    pending: [],
    in_progress: []
  });
}

export function saveRecommendationMemoryCache(memory) {
  localStorage.setItem(RECOMMENDATION_MEMORY_KEY, JSON.stringify(memory));
}

export function recordRecommendedAnime(recommendation, bucket = "recommended") {
  const memory = loadRecommendationMemoryCache();
  const titles = [
    recommendation?.title,
    recommendation?.title_jp
  ].filter(Boolean);
  const targetBucket = memory[bucket] ? bucket : "recommended";

  const next = {
    ...memory,
    [targetBucket]: mergeUnique(memory[targetBucket], titles)
  };
  saveRecommendationMemoryCache(next);
  return next;
}

export function removeRecommendationFromMemory(recommendation) {
  const memory = loadRecommendationMemoryCache();
  const blocked = new Set([
    recommendation?.title,
    recommendation?.title_jp
  ].filter(Boolean).map(normalizeTitle));

  const next = Object.fromEntries(
    Object.entries(memory).map(([bucket, titles]) => [
      bucket,
      (Array.isArray(titles) ? titles : []).filter((title) => !blocked.has(normalizeTitle(title)))
    ])
  );
  saveRecommendationMemoryCache(next);
  return next;
}

// "For two": who the user last watched with -
// { kind: "mal", username } or { kind: "manual", name, list }.
export function loadPartner() {
  const partner = readJson(PARTNER_KEY, null);
  return partner?.kind === "mal" || partner?.kind === "manual" ? partner : null;
}

export function savePartner(partner) {
  localStorage.setItem(PARTNER_KEY, JSON.stringify(partner));
}

// Username sign-in: { kind: "mal" | "anilist", username }.
export function loadListSource() {
  const source = readJson(LIST_SOURCE_KEY, null);
  return (source?.kind === "mal" || source?.kind === "anilist") && source.username ? source : null;
}

export function saveListSource(source) {
  localStorage.setItem(LIST_SOURCE_KEY, JSON.stringify(source));
}

export function clearListSource() {
  localStorage.removeItem(LIST_SOURCE_KEY);
}

// Which way in the user picked last ("mal" login, "username", "manual"), so
// someone with more than one set up comes back to the one they chose.
export function loadActiveMode() {
  return localStorage.getItem(ACTIVE_MODE_KEY) || "";
}

export function saveActiveMode(mode) {
  localStorage.setItem(ACTIVE_MODE_KEY, mode);
}

export function loadManualList() {
  return localStorage.getItem(MANUAL_LIST_KEY) || "";
}

export function saveManualList(value) {
  localStorage.setItem(MANUAL_LIST_KEY, value);
}

export function clearManualList() {
  localStorage.removeItem(MANUAL_LIST_KEY);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function mergeUnique(current = [], additions = []) {
  return [...new Set([...(Array.isArray(current) ? current : []), ...additions])];
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
}

const TOKEN_KEY = "en.malTokens";
const HISTORY_KEY = "en.recommendationHistory";
const OAUTH_KEY = "en.oauth";
const MANUAL_LIST_KEY = "en.manualList";
const TASTE_PROFILE_KEY = "en.tasteProfile";
const RECOMMENDATION_MEMORY_KEY = "en.recommendationMemory";
const PARTNER_KEY = "en.partner";

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

export function appendHistory(entry) {
  const next = [entry, ...loadHistory()];
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function updateHistoryEntry(id, patch) {
  const next = loadHistory().map((entry) =>
    entry.id === id ? { ...entry, ...patch } : entry
  );
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function deleteHistoryEntry(id) {
  const entry = loadHistory().find((item) => item.id === id);
  const next = loadHistory().filter((item) => item.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));

  if (entry?.recommendation) {
    removeRecommendationFromMemory(entry.recommendation);
  }

  return next;
}

export function clearRecommendationLog() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify([]));
  localStorage.removeItem(TASTE_PROFILE_KEY);
  localStorage.removeItem(RECOMMENDATION_MEMORY_KEY);
  return [];
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

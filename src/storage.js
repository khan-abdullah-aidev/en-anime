const TOKEN_KEY = "en.malTokens";
const HISTORY_KEY = "en.recommendationHistory";
const OAUTH_KEY = "en.oauth";
const MANUAL_LIST_KEY = "en.manualList";
const TASTE_PROFILE_KEY = "en.tasteProfile";
const RECOMMENDATION_MEMORY_KEY = "en.recommendationMemory";

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

export function loadHistory() {
  const history = readJson(HISTORY_KEY, []);
  return Array.isArray(history)
    ? history.filter((entry) => entry?.state === "pending" || Boolean(entry?.feedback))
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
    pending: []
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

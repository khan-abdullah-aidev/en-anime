const TOKEN_KEY = "en.malTokens";
const HISTORY_KEY = "en.recommendationHistory";
const OAUTH_KEY = "en.oauth";

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
  return readJson(HISTORY_KEY, []);
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

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

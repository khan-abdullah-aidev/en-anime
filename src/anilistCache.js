const CACHE_KEY = "en.anilistCache";
const CACHE_TTL_MS = 21 * 24 * 60 * 60 * 1000;

export function readAniListCache(key) {
  const cache = loadCache();
  const entry = cache[key];
  if (!entry) return { hit: false };
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return { hit: false };
  return { hit: true, data: entry.data };
}

export function writeAniListCache(key, data) {
  const cache = loadCache();
  cache[key] = { data, cachedAt: Date.now() };
  persistCache(cache);
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistCache(cache) {
  const now = Date.now();
  const pruned = Object.fromEntries(
    Object.entries(cache).filter(([, entry]) => now - entry.cachedAt <= CACHE_TTL_MS)
  );
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(pruned));
  } catch {
    // localStorage full or unavailable; skip caching for this write
  }
}

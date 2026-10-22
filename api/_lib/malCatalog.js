// MyAnimeList as En's backup catalog, for when AniList is down: details,
// recommendations, charts and search from MAL's API v2 (with the app's
// client ID), turned into the same candidate shape src/discovery.js builds
// from AniList, so the rest of the pipeline doesn't care where they came from.
//
// MAL's API doesn't send CORS headers, so this runs on the server. Results
// are kept in memory for a few hours per server instance to spare MAL.

const MAL_API = "https://api.myanimelist.net/v2";
const LIST_FIELDS = "id,title,main_picture,alternative_titles,start_season,mean,num_list_users,media_type,status,genres,num_episodes,average_episode_duration,nsfw";
const DETAIL_FIELDS = `${LIST_FIELDS},related_anime,recommendations`;
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const FORMATS = { tv: "TV", movie: "MOVIE", ova: "OVA", ona: "ONA", tv_special: "TV_SHORT", special: "SPECIAL", music: "MUSIC" };
const STATUSES = { finished_airing: "FINISHED", currently_airing: "RELEASING", not_yet_aired: "NOT_YET_RELEASED" };
// What AniList calls a recap or side story (PARENT): MAL's closest names.
const SIDE_RELATIONS = new Set(["parent_story", "summary", "full_story"]);

export async function malGet(path, clientId, { timeoutMs = 8000 } = {}) {
  const key = path;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MAL_API}${path}`, { headers: { "X-MAL-CLIENT-ID": clientId }, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`MyAnimeList answered ${response.status}.`);
      error.statusCode = response.status;
      throw error;
    }
    const data = await response.json();
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// A MAL anime node -> En's candidate (src/discovery.js toCandidate).
export function toMalCandidate(node) {
  const english = node.alternative_titles?.en || null;
  const title = english || node.title;
  const genres = (node.genres || []).map((genre) => genre.name);
  const related = node.related_anime || [];
  return {
    anilistId: null,
    malId: node.id,
    title,
    title_jp: node.alternative_titles?.ja || node.title,
    alternative_titles: { en: english, synonyms: [node.title, ...(node.alternative_titles?.synonyms || [])].filter((name) => name && name !== title).slice(0, 7) },
    format: FORMATS[node.media_type] || "TV",
    status: STATUSES[node.status] || "FINISHED",
    episodes: node.num_episodes || null,
    duration: node.average_episode_duration ? Math.round(node.average_episode_duration / 60) : null,
    year: node.start_season?.year ?? null,
    genres,
    genre: genres.slice(0, 2).join(", "),
    tags: [],
    filterTags: genres,
    score: node.mean ? Math.round(node.mean * 10) : null,
    popularity: node.num_list_users || 0,
    image_url: node.main_picture?.large || node.main_picture?.medium || "",
    watchLinks: [],
    isAdult: Boolean(node.nsfw && node.nsfw !== "white"),
    isSideStory: related.some((edge) => SIDE_RELATIONS.has(edge.relation_type)),
    prequels: related
      .filter((edge) => edge.relation_type === "prequel")
      .map((edge) => ({ anilistId: null, malId: edge.node?.id || null, title: edge.node?.title || "" })),
    source: "myanimelist"
  };
}

// Runs `work` over `items`, `limit` at a time.
export async function inBatches(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]).catch(() => null);
      }
    })
  );
  return results;
}

export async function malDetails(id, clientId) {
  return malGet(`/anime/${Number(id)}?fields=${DETAIL_FIELDS}`, clientId);
}

export async function malChart(type, clientId, limit = 50) {
  const data = await malGet(`/anime/ranking?ranking_type=${type}&limit=${limit}&fields=${LIST_FIELDS}`, clientId);
  return (data?.data || []).map((item) => item.node);
}

export async function malSeason(clientId, now = new Date(), limit = 40) {
  const season = ["winter", "winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "fall", "fall", "fall"][now.getMonth()];
  const data = await malGet(`/anime/season/${now.getFullYear()}/${season}?sort=anime_num_list_users&limit=${limit}&fields=${LIST_FIELDS}`, clientId);
  return (data?.data || []).map((item) => item.node);
}

export async function malSearch(q, clientId, limit = 8) {
  const data = await malGet(`/anime?q=${encodeURIComponent(q)}&limit=${limit}&fields=${LIST_FIELDS}`, clientId);
  return (data?.data || []).map((item) => item.node);
}

const keyOf = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

// Which search result is the title asked for: an exact name match (any of
// its names) if there is one, else a name the words appear in whole
// ("frieren" in "Sousou no Frieren"); most popular first, TV and films
// before specials. Nothing for a loose match on a very short query.
export function bestMalMatch(q, nodes) {
  const wanted = keyOf(q);
  if (!wanted) return null;
  const names = (node) => [node.title, node.alternative_titles?.en, node.alternative_titles?.ja, ...(node.alternative_titles?.synonyms || [])].map(keyOf).filter(Boolean);
  const exact = nodes.filter((node) => names(node).includes(wanted));
  const words = new RegExp(`(^| )${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  const loose = wanted.length >= 4 ? nodes.filter((node) => names(node).some((name) => words.test(name))) : [];
  const pool = exact.length ? exact : loose;
  const rank = (node) => (["tv", "movie"].includes(node.media_type) ? 1e9 : 0) + (node.num_list_users || 0);
  return [...pool].sort((a, b) => rank(b) - rank(a))[0] || null;
}

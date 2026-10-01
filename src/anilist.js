import { normalizeTitleForCompare } from "./titleUtils.js";
import { readAniListCache, writeAniListCache } from "./anilistCache.js";
import { streamingLinks } from "./streaming.js";

const ANILIST_URL = "https://graphql.anilist.co";
const REQUEST_TIMEOUT_MS = 6000;

// Page.media, not a single Media(search:) lookup: AniList's search-match ranking
// can surface an unrelated SPECIAL/CM entry ahead of the real title when a
// short promotional tie-in shares synonyms with it (e.g. searching "Kimi no
// Na wa" surfaces a Suntory mineral water commercial before the actual film,
// because the CM's synonyms list includes "Kimi no Na wa."). Fetching a
// shortlist and disambiguating by popularity avoids that trap.
const SEARCH_QUERY = `query ($search: String) {
  Page(perPage: 8) {
    media(search: $search, type: ANIME, sort: [SEARCH_MATCH]) {
      id
      idMal
      title { romaji english native }
      synonyms
      format
      popularity
      averageScore
      startDate { year }
      episodes
      genres
      coverImage { extraLarge large }
      externalLinks { site url type }
    }
  }
}`;

export async function resolveAnimeOnAniList(title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) return null;

  const cacheKey = normalizeTitleForCompare(trimmed);
  if (!cacheKey) return null;

  const cached = readAniListCache(cacheKey);
  if (cached.hit) return cached.data;

  let resolved;
  try {
    resolved = await queryAniList(trimmed);
  } catch (error) {
    console.warn("[En debug] AniList lookup failed (not cached, will retry later)", {
      title: trimmed,
      error: error.message
    });
    return null;
  }

  writeAniListCache(cacheKey, resolved);
  return resolved;
}

async function queryAniList(title) {
  const data = await aniListRequest(SEARCH_QUERY, { search: title });
  return pickBestMatch(title, data?.Page?.media || []);
}

// AniList is public and CORS-enabled, so it's called straight from the
// browser: its rate limit (currently 30 requests/minute) then applies per
// user rather than to one shared server IP.
export async function aniListRequest(query, variables = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`AniList request failed (${response.status}).`);
    }

    const payload = await response.json();
    if (payload?.errors?.length) {
      throw new Error(`AniList error: ${payload.errors[0].message}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

function pickBestMatch(queryTitle, candidates) {
  const queryKey = normalizeTitleForCompare(queryTitle);
  const confident = candidates.filter((media) => titleKeysFor(media).includes(queryKey));
  if (!confident.length) return null;

  const best = confident.reduce((top, media) =>
    (media.popularity || 0) > (top.popularity || 0) ? media : top
  );

  return toAniListResult(best);
}

function titleKeysFor(media) {
  return [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])]
    .filter(Boolean)
    .map(normalizeTitleForCompare);
}

function toAniListResult(media) {
  return {
    anilistId: media.id,
    // Lets a queried title be matched to the user's MAL list by id rather
    // than by however they happened to spell it.
    malId: media.idMal || null,
    title: media.title.english || media.title.romaji,
    title_jp: media.title.native || media.title.romaji,
    title_romaji: media.title.romaji || null,
    year: media.startDate?.year || null,
    episodes: media.episodes ?? null,
    genre: (media.genres || []).slice(0, 2).join(", "),
    genres: media.genres || [],
    image_url: media.coverImage?.extraLarge || media.coverImage?.large || "",
    watch_links: streamingLinks(media.externalLinks)
  };
}

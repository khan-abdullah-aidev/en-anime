import { normalizeTitleForCompare } from "./titleUtils.js";
import { readAniListCache, writeAniListCache } from "./anilistCache.js";
import { streamingLinks } from "./streaming.js";

const ANILIST_URL = "https://graphql.anilist.co";
const REQUEST_TIMEOUT_MS = 6000;

// ---------- when AniList is down ----------
//
// The first request AniList refuses outright (disabled, overloaded, rate
// limited, blocked or timed out) marks it down for a few minutes, in this
// tab and for the rest of this visit, so nothing else waits on it: every
// later request fails at once, and callers fall back (to MyAnimeList, via
// /api/mal-*, or to the curated catalog).
const DOWN_KEY = "en.anilistDownUntil";
const DOWN_MS = 5 * 60 * 1000;
let downUntil = 0;

export class AniListDownError extends Error {
  constructor(message = "AniList isn't answering right now.") {
    super(message);
    this.name = "AniListDownError";
  }
}

export function isAniListDownError(error) {
  return error instanceof AniListDownError || error?.name === "AniListDownError";
}

export function aniListIsDown(now = Date.now()) {
  if (!downUntil) {
    try {
      downUntil = Number(sessionStorage.getItem(DOWN_KEY)) || 0;
    } catch {
      downUntil = 0;
    }
  }
  return now < downUntil;
}

export function markAniListDown(now = Date.now()) {
  downUntil = now + DOWN_MS;
  try {
    sessionStorage.setItem(DOWN_KEY, String(downUntil));
  } catch {
    // storage unavailable; this tab remembers it anyway
  }
}

// For tests.
export function resetAniListDown() {
  downUntil = 0;
  try {
    sessionStorage.removeItem(DOWN_KEY);
  } catch {
    // nothing stored
  }
}

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

// A title, matched to its AniList entry (cached). While AniList is down the
// match comes from MyAnimeList instead (anilistId null, never cached long),
// unless anilistOnly asks for an AniList id or nothing.
export async function resolveAnimeOnAniList(title, { anilistOnly = false } = {}) {
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
    if (!anilistOnly && isAniListDownError(error)) return resolveOnMal(trimmed);
    console.warn("[En debug] AniList lookup failed (not cached, will retry later)", {
      title: trimmed,
      error: error.message
    });
    return null;
  }

  writeAniListCache(cacheKey, resolved);
  return resolved;
}

const malMatches = new Map();

async function resolveOnMal(title) {
  const key = normalizeTitleForCompare(title);
  if (malMatches.has(key)) return malMatches.get(key);
  let match = null;
  try {
    const response = await fetch(`/api/mal-search?q=${encodeURIComponent(title)}`);
    if (response.ok) match = (await response.json()).match || null;
  } catch {
    match = null;
  }
  malMatches.set(key, match);
  return match;
}

async function queryAniList(title) {
  const data = await aniListRequest(SEARCH_QUERY, { search: title });
  return pickBestMatch(title, data?.Page?.media || []);
}

// AniList is public and CORS-enabled, so it's called straight from the
// browser: its rate limit (currently 30 requests/minute) then applies per
// user rather than to one shared server IP.
export async function aniListRequest(query, variables = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (aniListIsDown()) throw new AniListDownError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetch(ANILIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });
    } catch {
      // Blocked, offline or timed out: with AniList down, a refused
      // request often shows up as a CORS failure rather than a status.
      markAniListDown();
      throw new AniListDownError();
    }

    if (!response.ok) {
      // AniList explains errors in the body ("Private User", "User not found").
      const detail = (await response.json().catch(() => null))?.errors?.[0]?.message;
      if (response.status >= 500 || response.status === 429 || (response.status === 403 && /disabled|stability|maintenance/i.test(detail || ""))) {
        markAniListDown();
        throw new AniListDownError(detail || undefined);
      }
      throw new Error(`AniList request failed (${response.status})${detail ? `: ${detail}` : "."}`);
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

const NEXT_AIRING_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) { status episodes nextAiringEpisode { episode airingAt } }
}`;

// The next episode of a show that's still airing, or null. Read fresh each
// time a pick opens (it changes weekly), and never worth an error.
export async function fetchNextAiring(anilistId) {
  if (!Number.isInteger(anilistId)) return null;
  try {
    const data = await aniListRequest(NEXT_AIRING_QUERY, { id: anilistId });
    const next = data?.Media?.nextAiringEpisode;
    if (data?.Media?.status !== "RELEASING" || !next?.airingAt) return null;
    return { episode: next.episode, airingAt: next.airingAt * 1000, total: data.Media.episodes ?? null };
  } catch {
    return null;
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// "episode 7 airs Thursday" / "today" / "tomorrow" / "on 12 Nov", in the
// viewer's own time zone.
export function describeNextAiring(next, now = Date.now()) {
  if (!next?.airingAt || next.airingAt <= now) return "";
  const startOfDay = (time) => {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((startOfDay(next.airingAt) - startOfDay(now)) / 86400000);
  const when =
    days === 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : days < 7
          ? WEEKDAYS[new Date(next.airingAt).getDay()]
          : `on ${new Date(next.airingAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  return `${next.episode ? `episode ${next.episode}` : "the next episode"} airs ${when}`;
}

// Worth starting now? With three or more episodes out there's enough to get
// into; with fewer, saving it until more are out is an option worth naming.
export function airingAdvice(next) {
  if (!next?.episode) return "";
  const out = Math.max(0, next.episode - 1);
  const of = next.total ? ` of ${next.total}` : "";
  if (next.total && out >= next.total - 1) return `${out}${of} out: nearly done, start now`;
  if (out >= 3) return `${out}${of} out: enough to start now`;
  return out ? `only ${out}${of} out so far: you could save it for later` : "it's only just starting: you could save it for later";
}

const SEQUEL_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    relations { edges { relationType(version: 2) node { id idMal type format status title { english romaji } } } }
  }
}`;

// The next part of a show, if it has one that's out: a TV season, film,
// ONA or OVA linked as its SEQUEL. Null otherwise, and never an error.
export async function fetchSequel(anilistId) {
  if (!Number.isInteger(anilistId)) return null;
  try {
    const data = await aniListRequest(SEQUEL_QUERY, { id: anilistId });
    const edge = (data?.Media?.relations?.edges || []).find((item) =>
      item.relationType === "SEQUEL" &&
      item.node?.type === "ANIME" &&
      ["TV", "TV_SHORT", "MOVIE", "ONA", "OVA"].includes(item.node.format) &&
      item.node.status !== "NOT_YET_RELEASED"
    );
    if (!edge) return null;
    return { anilistId: edge.node.id, malId: edge.node.idMal || null, title: edge.node.title?.english || edge.node.title?.romaji || "" };
  } catch {
    return null;
  }
}

import { aniListRequest, resolveAnimeOnAniList } from "./anilist.js";
import { buildCandidatePool, createExclusionCheck } from "./recommendationEngine.js";
import { normalizeTitleForCompare, parseManualTitles, uniqueTitles } from "./titleUtils.js";

// Candidates come from all of AniList rather than a fixed list:
//  - "similar": what fans of the user's highest-rated shows recommend,
//  - "genre":   top titles in the genres the user scores above their average,
//  - "mood":    titles tagged with what tonight's mood asks for,
//  - "recent":  strong releases from the last two years.
// Everything on the user's list, everything En has recommended, and sequels
// of shows they haven't finished are filtered out; the rest is ranked against
// their taste and the top POOL_LIMIT go to the model, which picks one.

const POOL_LIMIT = 60;
const MIN_POOL = 8;
const SEED_LIMIT = 10;
const RECS_PER_SEED = 12;
const SEED_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = "en.discoveryCache";
const CACHE_MAX_ENTRIES = 8;
const REQUEST_TIMEOUT_MS = 9000;

const ALLOWED_FORMATS = new Set(["TV", "TV_SHORT", "MOVIE", "ONA", "OVA"]);
const ANILIST_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"
];
// MAL genre names that are tags (or a differently named genre) on AniList.
const LABEL_ALIASES = {
  iyashikei: { tags: ["Iyashikei"] },
  suspense: { genres: ["Thriller"] },
  healing: { tags: ["Iyashikei"] },
  timetravel: { tags: ["Time Manipulation"] },
  space: { tags: ["Space"] },
  isekai: { tags: ["Isekai"] },
  school: { tags: ["School"] },
  historical: { tags: ["Historical"] },
  military: { tags: ["War"] },
  gore: { tags: ["Gore"] }
};

// Words in tonight's mood -> AniList genres/tags (all verified names).
const MOOD_HINTS = [
  { words: ["quiet", "calm", "gentle", "cozy", "comfy", "soft", "relax", "relaxing", "chill", "peaceful", "slow", "warm", "soothing", "healing"], genres: ["Slice of Life"], tags: ["Iyashikei"] },
  { words: ["sad", "cry", "crying", "devastating", "devastate", "gutting", "heavy", "tragic", "tragedy", "grief", "heartbreak", "heartbreaking", "tears", "feel"], genres: ["Drama"], tags: ["Tragedy"] },
  { words: ["rain", "melancholy", "melancholic", "lonely", "loneliness", "nostalgic", "nostalgia", "bittersweet", "wistful"], genres: ["Drama", "Slice of Life"] },
  { words: ["dark", "grim", "bleak", "brutal", "disturbing"], genres: ["Psychological", "Thriller"] },
  { words: ["funny", "laugh", "comedy", "silly", "goofy", "lighthearted", "fun"], genres: ["Comedy"] },
  { words: ["romance", "romantic", "love", "crush", "date"], genres: ["Romance"] },
  { words: ["scary", "horror", "creepy", "spooky", "terrifying"], genres: ["Horror"] },
  { words: ["mystery", "detective", "puzzle", "twist", "whodunit"], genres: ["Mystery"] },
  { words: ["action", "fight", "fighting", "hype", "adrenaline", "battle", "epic"], genres: ["Action"] },
  { words: ["smart", "smarter", "cerebral", "philosophical", "think", "thinking", "clever"], genres: ["Psychological"], tags: ["Philosophy"] },
  { words: ["isekai"], tags: ["Isekai"] },
  { words: ["space", "stars", "astronaut"], tags: ["Space"] },
  { words: ["adventure", "journey", "travel", "road", "explore", "exploring"], genres: ["Adventure"], tags: ["Travel"] },
  { words: ["sports", "sport", "team", "competition"], genres: ["Sports"] },
  { words: ["music", "band", "musical", "idol"], genres: ["Music"] },
  { words: ["loop", "timeloop"], tags: ["Time Loop", "Time Manipulation"] },
  { words: ["growing", "youth", "teen", "teenage"], tags: ["Coming of Age"] },
  { words: ["family", "parent", "parenting"], tags: ["Found Family", "Family Life"] },
  { words: ["war", "soldier", "soldiers"], tags: ["War"] },
  { words: ["survival", "survive"], tags: ["Survival"] },
  { words: ["revenge"], tags: ["Revenge"] },
  { words: ["apocalypse", "apocalyptic", "wasteland"], tags: ["Post-Apocalyptic"] },
  { words: ["future", "robot", "robots", "scifi", "cyberpunk"], genres: ["Sci-Fi"] },
  { words: ["mecha", "mech"], genres: ["Mecha"] },
  { words: ["fantasy", "magic", "magical", "witch", "dragon"], genres: ["Fantasy"] }
];

const MEDIA_FIELDS = `id idMal title { romaji english native } synonyms format status episodes isAdult
  startDate { year } genres averageScore popularity coverImage { extraLarge large }
  tags { name rank isMediaSpoiler isGeneralSpoiler }
  relations { edges { relationType(version: 2) node { id idMal type title { romaji english } } } }`;
const DISCOVERY_FILTER = "type: ANIME, isAdult: false, format_in: [TV, TV_SHORT, MOVIE, ONA, OVA], status_in: [FINISHED, RELEASING]";

export async function buildOpenCandidatePool({ mood = "", list, history = [], tasteProfile, recentPatterns, memory, limit = POOL_LIMIT }) {
  let pool = [];
  try {
    const seeds = await selectSeeds({ list, history });
    const filters = {
      favorites: toAniListFilters(tasteProfile?.favoriteGenres || []),
      mood: moodFilters(mood),
      since: (new Date().getFullYear() - 2) * 10000 + 101
    };
    const [seedGroups, discovery] = await Promise.all([fetchSeedRecommendations(seeds), fetchDiscovery(filters)]);
    // In manual mode the typed favorites were resolved to exact AniList ids,
    // which is a far better "already watched" signal than their typed names.
    const watchedAnilistIds = seeds.by === "anilistId" ? seeds.seeds.map((seed) => seed.anilistId) : [];
    const context = buildUserContext({ list, history, memory, watchedAnilistIds });
    pool = rankPool({ seedGroups, discovery, context, tasteProfile, mood, limit });
  } catch (error) {
    console.warn("[En] AniList discovery failed; using the curated catalog instead", error.message);
  }

  if (pool.length >= MIN_POOL) {
    return { candidates: pool, source: "anilist" };
  }

  // AniList unreachable or the open pool came back thin: top up with the
  // curated catalog so a recommendation can still be made.
  const catalog = buildCandidatePool({ mood, tasteProfile, recentPatterns, memory, limit });
  const taken = new Set(pool.map((candidate) => normalizeTitleForCompare(candidate.title)));
  const merged = [...pool, ...catalog.filter((candidate) => !taken.has(normalizeTitleForCompare(candidate.title)))];
  return { candidates: merged.slice(0, limit), source: pool.length ? "anilist+catalog" : "catalog" };
}

// What the model sees for each candidate: enough to judge fit and to name a
// concrete link to the user's history, without internal bookkeeping.
export function toModelCandidate(candidate) {
  return compact({
    title: candidate.title,
    title_jp: candidate.title_jp,
    year: candidate.year,
    format: candidate.format,
    episodes: candidate.episodes,
    genres: candidate.genres,
    tags: candidate.tags?.length ? candidate.tags : candidate.themes,
    score: candidate.score,
    becauseYouLiked: candidate.because?.length ? candidate.because.slice(0, 3) : null,
    continues: candidate.continues || null,
    pacing: candidate.pacing,
    darkness: candidate.darkness
  });
}

// ---------- seeds ----------

export async function selectSeeds({ list, history = [] }) {
  const likedPicks = history.filter((entry) => entry.feedback === "good" && entry.recommendation);

  if (Array.isArray(list)) {
    const completed = list.filter((entry) => entry.my_list_status?.status === "completed");
    const scored = completed.filter((entry) => scoreOf(entry) > 0);
    const average = scored.length ? scored.reduce((sum, entry) => sum + scoreOf(entry), 0) / scored.length : null;
    const favorites = [...scored]
      .filter((entry) => scoreOf(entry) >= Math.max(average || 0, 7))
      .sort((a, b) => scoreOf(b) - scoreOf(a) || updatedAt(b) - updatedAt(a))
      .slice(0, 7);
    const recentGood = [...completed]
      .filter((entry) => !scoreOf(entry) || scoreOf(entry) >= (average || 0))
      .sort((a, b) => updatedAt(b) - updatedAt(a))
      .slice(0, 5);

    const seeds = new Map();
    for (const entry of [...favorites, ...recentGood]) {
      if (seeds.size >= SEED_LIMIT || seeds.has(entry.id)) continue;
      const weight = average && scoreOf(entry) ? clamp(scoreOf(entry) - average + 1, 0.5, 4) : 1;
      const recent = Date.now() - updatedAt(entry) < 120 * 24 * 60 * 60 * 1000;
      seeds.set(entry.id, { malId: entry.id, title: entry.alternative_titles?.en || entry.title, weight: recent ? weight * 1.25 : weight });
    }
    for (const entry of likedPicks) {
      const malId = entry.recommendation.malId;
      if (malId && !seeds.has(malId) && seeds.size < SEED_LIMIT) {
        seeds.set(malId, { malId, title: entry.recommendation.title, weight: 1.5 });
      }
    }
    return { by: "malId", seeds: [...seeds.values()] };
  }

  // Manual mode: resolve the typed titles on AniList (cached per title).
  const typed = parseManualTitles(list).slice(0, 8);
  const resolved = await Promise.all(typed.map((title) => resolveAnimeOnAniList(title)));
  const seeds = new Map();
  resolved.forEach((match, index) => {
    if (match?.anilistId && !seeds.has(match.anilistId)) {
      seeds.set(match.anilistId, { anilistId: match.anilistId, title: match.title || typed[index], weight: 1 });
    }
  });
  for (const entry of likedPicks) {
    const anilistId = entry.recommendation.anilistId;
    if (anilistId && !seeds.has(anilistId) && seeds.size < SEED_LIMIT) {
      seeds.set(anilistId, { anilistId, title: entry.recommendation.title, weight: 1.5 });
    }
  }
  return { by: "anilistId", seeds: [...seeds.values()] };
}

async function fetchSeedRecommendations({ by, seeds }) {
  if (!seeds.length) return [];
  const ids = seeds.map((seed) => seed[by]).sort((a, b) => a - b);
  const cacheKey = `seeds:${by}:${ids.join(",")}`;
  const cached = readCache(cacheKey, SEED_CACHE_TTL_MS);
  const groups = cached || await (async () => {
    const filter = by === "malId" ? "idMal_in: $ids" : "id_in: $ids";
    const data = await aniListRequest(
      `query ($ids: [Int]) { Page(perPage: ${SEED_LIMIT}) { media(${filter}, type: ANIME) {
        id idMal
        recommendations(perPage: ${RECS_PER_SEED}, sort: [RATING_DESC]) { nodes { rating mediaRecommendation { ${MEDIA_FIELDS} } } }
      } } }`,
      { ids },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    );
    const fresh = (data?.Page?.media || []).map((media) => ({
      seedId: by === "malId" ? media.idMal : media.id,
      recs: (media.recommendations?.nodes || [])
        .filter((node) => node.mediaRecommendation)
        .map((node) => ({ rating: node.rating || 0, candidate: toCandidate(node.mediaRecommendation) }))
    }));
    writeCache(cacheKey, fresh);
    return fresh;
  })();

  const seedById = new Map(seeds.map((seed) => [seed[by], seed]));
  return groups
    .filter((group) => seedById.has(group.seedId))
    .map((group) => ({ seed: seedById.get(group.seedId), recs: group.recs }));
}

// ---------- discovery ----------

async function fetchDiscovery({ favorites, mood, since }) {
  const aliases = [];
  const variables = { since };
  const declare = ["$since: FuzzyDateInt"];

  if (favorites.genres.length) {
    declare.push("$favGenres: [String]");
    variables.favGenres = favorites.genres.slice(0, 3);
    aliases.push(`genre: Page(perPage: 50) { media(${DISCOVERY_FILTER}, genre_in: $favGenres, averageScore_greater: 72, popularity_greater: 15000, sort: [SCORE_DESC]) { ${MEDIA_FIELDS} } }`);
  }
  if (mood.tags.length) {
    declare.push("$moodTags: [String]");
    variables.moodTags = mood.tags;
    aliases.push(`mood: Page(perPage: 40) { media(${DISCOVERY_FILTER}, tag_in: $moodTags, averageScore_greater: 68, popularity_greater: 5000, sort: [SCORE_DESC]) { ${MEDIA_FIELDS} } }`);
  } else if (mood.genres.length) {
    declare.push("$moodGenres: [String]");
    variables.moodGenres = mood.genres;
    aliases.push(`mood: Page(perPage: 40) { media(${DISCOVERY_FILTER}, genre_in: $moodGenres, averageScore_greater: 70, popularity_greater: 8000, sort: [SCORE_DESC]) { ${MEDIA_FIELDS} } }`);
  }
  aliases.push(`recent: Page(perPage: 40) { media(${DISCOVERY_FILTER}, startDate_greater: $since, averageScore_greater: 74, popularity_greater: 10000, sort: [SCORE_DESC]) { ${MEDIA_FIELDS} } }`);

  const cacheKey = `disc:${JSON.stringify(variables)}`;
  const cached = readCache(cacheKey, DISCOVERY_CACHE_TTL_MS);
  if (cached) return cached;

  const data = await aniListRequest(`query (${declare.join(", ")}) { ${aliases.join("\n")} }`, variables, { timeoutMs: REQUEST_TIMEOUT_MS });
  const result = Object.fromEntries(
    ["genre", "mood", "recent"].map((key) => [key, (data?.[key]?.media || []).map(toCandidate)])
  );
  writeCache(cacheKey, result);
  return result;
}

export function moodFilters(mood) {
  const tokens = new Set(
    String(mood || "")
      .toLowerCase()
      .normalize("NFKD")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
  const genres = new Set();
  const tags = new Set();
  for (const hint of MOOD_HINTS) {
    if (hint.words.some((word) => tokens.has(word))) {
      (hint.genres || []).forEach((genre) => genres.add(genre));
      (hint.tags || []).forEach((tag) => tags.add(tag));
    }
  }
  return { genres: [...genres], tags: [...tags] };
}

export function toAniListFilters(labels) {
  const genreByKey = new Map(ANILIST_GENRES.map((genre) => [normalizeTitleForCompare(genre), genre]));
  const genres = new Set();
  const tags = new Set();
  for (const label of labels) {
    const key = normalizeTitleForCompare(label);
    if (genreByKey.has(key)) genres.add(genreByKey.get(key));
    const alias = LABEL_ALIASES[key];
    (alias?.genres || []).forEach((genre) => genres.add(genre));
    (alias?.tags || []).forEach((tag) => tags.add(tag));
  }
  return { genres: [...genres], tags: [...tags] };
}

// ---------- filtering + ranking (pure) ----------

export function buildUserContext({ list, history = [], memory, watchedAnilistIds = [] }) {
  const listIds = new Set();
  const completedIds = new Set();
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry.id) continue;
      listIds.add(entry.id);
      if (entry.my_list_status?.status === "completed") completedIds.add(entry.id);
    }
  }
  const excludedAnilistIds = new Set(watchedAnilistIds);
  const completedAnilistIds = new Set(watchedAnilistIds);
  for (const entry of history) {
    const rec = entry.recommendation || {};
    if (rec.anilistId) excludedAnilistIds.add(rec.anilistId);
    if (entry.feedback === "good") {
      if (rec.malId) completedIds.add(rec.malId);
      if (rec.anilistId) completedAnilistIds.add(rec.anilistId);
    }
  }
  const manualKeys = new Set(
    typeof list === "string" ? parseManualTitles(list).map(normalizeTitleForCompare).filter(Boolean) : []
  );
  return { listIds, completedIds, completedAnilistIds, excludedAnilistIds, manualKeys, isExcludedTitle: createExclusionCheck(memory) };
}

export function rankPool({ seedGroups = [], discovery = {}, context, tasteProfile = {}, mood = "", limit = POOL_LIMIT }) {
  const merged = new Map();
  const add = (candidate, source, extra = {}) => {
    if (!candidate?.anilistId || !isUsable(candidate)) return;
    const entry = merged.get(candidate.anilistId) || { ...candidate, sources: new Set(), becauseWeights: new Map(), similarity: 0 };
    entry.sources.add(source);
    if (extra.seed) {
      entry.similarity += extra.seed.weight * Math.log1p(Math.max(0, extra.rating || 0));
      entry.becauseWeights.set(extra.seed.title, (entry.becauseWeights.get(extra.seed.title) || 0) + extra.rating);
    }
    merged.set(candidate.anilistId, entry);
  };

  for (const group of seedGroups) {
    for (const rec of group.recs) add(rec.candidate, "similar", { seed: group.seed, rating: rec.rating });
  }
  for (const source of ["genre", "mood", "recent"]) {
    for (const candidate of discovery[source] || []) add(candidate, source);
  }

  const favorite = new Set((tasteProfile.favoriteGenres || []).map(normalizeTitleForCompare));
  const disliked = new Set((tasteProfile.dislikedTropes || []).map(normalizeTitleForCompare));
  const moodWanted = moodFilters(mood);
  const moodKeys = new Set([...moodWanted.genres, ...moodWanted.tags].map(normalizeTitleForCompare));

  const ranked = [];
  for (const entry of merged.values()) {
    if (isExcludedCandidate(entry, context)) continue;
    const continuation = continuationOf(entry, context);
    if (!continuation.ok) continue;

    const labels = [...entry.genres, ...entry.tags].map(normalizeTitleForCompare);
    const count = (set) => labels.filter((label) => set.has(label)).length;
    const rankScore =
      entry.similarity +
      1.5 * count(favorite) -
      2.5 * count(disliked) +
      2.5 * count(moodKeys) +
      (Number.isFinite(entry.score) ? (entry.score - 70) / 6 : 0) +
      (continuation.continues ? 2 : 0);

    ranked.push({
      ...entry,
      sources: [...entry.sources],
      because: [...entry.becauseWeights.entries()].sort((a, b) => b[1] - a[1]).map(([title]) => title),
      becauseWeights: undefined,
      continues: continuation.continues || null,
      rankScore: Math.round(rankScore * 100) / 100
    });
  }
  ranked.sort((a, b) => b.rankScore - a.rankScore || (b.popularity || 0) - (a.popularity || 0));

  // Keep the pool varied: a few from each source before filling by rank, so
  // tonight's mood and new releases aren't crowded out by "similar".
  const quotas = [["mood", 12], ["recent", 6], ["genre", 8], ["similar", 30]];
  const picked = new Map();
  for (const [source, quota] of quotas) {
    ranked.filter((entry) => entry.sources.includes(source) && !picked.has(entry.anilistId))
      .slice(0, quota)
      .forEach((entry) => picked.set(entry.anilistId, entry));
  }
  for (const entry of ranked) {
    if (picked.size >= limit) break;
    picked.set(entry.anilistId, entry);
  }
  return [...picked.values()].sort((a, b) => b.rankScore - a.rankScore).slice(0, limit);
}

function isUsable(candidate) {
  return (
    ALLOWED_FORMATS.has(candidate.format) &&
    !candidate.isAdult &&
    !candidate.isSideStory &&
    ["FINISHED", "RELEASING"].includes(candidate.status)
  );
}

function isExcludedCandidate(candidate, context) {
  if (candidate.malId && context.listIds.has(candidate.malId)) return true;
  if (context.excludedAnilistIds.has(candidate.anilistId)) return true;
  return candidateTitles(candidate).some((title) => context.isExcludedTitle(title));
}

// A sequel is only a candidate when the user finished something it follows -
// then it's a continuation worth naming. Otherwise it's skipped: En shouldn't
// hand someone season two of a show they never started. (Recaps and side
// stories never get this far; isUsable drops them.)
function continuationOf(candidate, context) {
  if (!candidate.prequels?.length) return { ok: true };
  const finished = candidate.prequels.find((prequel) =>
    (prequel.malId && context.completedIds.has(prequel.malId)) ||
    context.completedAnilistIds.has(prequel.anilistId) ||
    (prequel.title && context.manualKeys.has(normalizeTitleForCompare(prequel.title)))
  );
  return finished ? { ok: true, continues: finished.title } : { ok: false };
}

export function toCandidate(media) {
  const english = media.title?.english || null;
  const romaji = media.title?.romaji || null;
  const title = english || romaji;
  return {
    anilistId: media.id,
    malId: media.idMal || null,
    title,
    title_jp: media.title?.native || romaji || title,
    alternative_titles: { en: english, synonyms: uniqueTitles([romaji, ...(media.synonyms || []).slice(0, 6)]) },
    format: media.format,
    status: media.status,
    episodes: media.episodes ?? null,
    year: media.startDate?.year ?? null,
    genres: media.genres || [],
    genre: (media.genres || []).slice(0, 2).join(", "),
    tags: (media.tags || [])
      .filter((tag) => !tag.isMediaSpoiler && !tag.isGeneralSpoiler && tag.rank >= 60)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 6)
      .map((tag) => tag.name),
    score: media.averageScore ?? null,
    popularity: media.popularity || 0,
    image_url: media.coverImage?.extraLarge || media.coverImage?.large || "",
    isAdult: Boolean(media.isAdult),
    // AniList links recap films and side-story specials to their parent with
    // PARENT; real sequels link back with PREQUEL.
    isSideStory: (media.relations?.edges || []).some((edge) => edge.relationType === "PARENT" && edge.node?.type === "ANIME"),
    prequels: (media.relations?.edges || [])
      .filter((edge) => edge.relationType === "PREQUEL" && edge.node?.type === "ANIME")
      .map((edge) => ({
        anilistId: edge.node.id,
        malId: edge.node.idMal || null,
        title: edge.node.title?.english || edge.node.title?.romaji || ""
      }))
  };
}

function candidateTitles(candidate) {
  return [candidate.title, candidate.title_jp, candidate.alternative_titles?.en, ...(candidate.alternative_titles?.synonyms || [])].filter(Boolean);
}

// ---------- cache (compact candidates, not raw AniList payloads) ----------

function readCache(key, ttlMs) {
  try {
    const entry = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}")[key];
    return entry && Date.now() - entry.cachedAt < ttlMs ? entry.data : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    cache[key] = { data, cachedAt: Date.now() };
    const newest = Object.entries(cache)
      .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
      .slice(0, CACHE_MAX_ENTRIES);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // localStorage full or unavailable (private mode, tests); just don't cache
  }
}

function scoreOf(entry) {
  return Number(entry?.my_list_status?.score) || 0;
}

function updatedAt(entry) {
  return Date.parse(entry?.my_list_status?.updated_at || entry?.updated_at || "") || 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && !value.length))
  );
}

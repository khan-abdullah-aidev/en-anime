import { aniListRequest, resolveAnimeOnAniList } from "./anilist.js";
import { NOT_TONIGHT_COOLDOWN_MS, buildCandidatePool, createExclusionCheck, isStillExcluded } from "./recommendationEngine.js";
import { streamingLinks } from "./streaming.js";
import { animeTitleKeys, normalizeTitleForCompare, parseManualTitles, uniqueTitles } from "./titleUtils.js";

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
// Below this, the mood's hard limits are relaxed rather than failing.
const MIN_CONSTRAINED_POOL = 3;
const SEED_LIMIT = 10;
const RECS_PER_SEED = 12;
const SEED_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = "en.discoveryCache.v3"; // v3 adds filterTags (for "leave out")
// Each seed's recommendations are cached on their own (so rotating seeds
// doesn't refetch the ones already seen), hence room for a few dozen.
const CACHE_MAX_ENTRIES = 60;
// No single favorite may supply more of the pool's "similar" slots than this.
const MAX_PER_SEED = 6;
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
  relations { edges { relationType(version: 2) node { id idMal type title { romaji english } } } }
  externalLinks { site url type }`;
const DEFAULT_FORMATS = ["TV", "TV_SHORT", "MOVIE", "ONA", "OVA"];
const NO_EXCLUSIONS = { labels: [], genres: [], tags: [], matches: () => false };

// exclude is the user's "leave out" filter (preferences.js exclusionFilter):
// nothing it matches gets into the pool, from any source. mutedSeeds are
// favorites the user asked En not to start from.
export async function buildOpenCandidatePool({ mood = "", passedOver = [], list, history = [], tasteProfile, recentPatterns, memory, includeResume = false, exclude = NO_EXCLUSIONS, mutedSeeds = [], limit = POOL_LIMIT }) {
  const pool = await buildFreshPool({ mood, passedOver, list, history, tasteProfile, recentPatterns, memory, exclude, mutedSeeds, limit });
  if (!includeResume) return pool;
  // A couple of shows they started and set aside ride along; the model picks
  // one only when finishing it suits tonight better than anything new.
  const resume = resumeCandidates({ list, history }).filter((candidate) =>
    !exclude.matches(candidate) &&
    meetsConstraints({ ...candidate, episodes: candidate.resume.remaining }, pool.constraintsRelaxed ? {} : pool.constraints)
  );
  return { ...pool, candidates: [...pool.candidates, ...resume] };
}

async function buildFreshPool({ mood = "", passedOver = [], list, history = [], tasteProfile, recentPatterns, memory, exclude = NO_EXCLUSIONS, mutedSeeds = [], limit = POOL_LIMIT }) {
  const { constraints, discoveryMood } = buildRequestFilters({ mood, passedOver });
  let fetched = null;
  try {
    const seeds = await selectSeeds({ list, history, muted: mutedSeeds });
    const filters = {
      favorites: withoutExcluded(toAniListFilters(tasteProfile?.favoriteGenres || []), exclude),
      mood: moodFilters(discoveryMood),
      since: (new Date().getFullYear() - 2) * 10000 + 101,
      constraints,
      exclude
    };
    const [seedGroups, discovery] = await Promise.all([fetchSeedRecommendations(seeds), fetchDiscovery(filters)]);
    // In manual mode the typed favorites were resolved to exact AniList ids,
    // which is a far better "already watched" signal than their typed names.
    const watchedAnilistIds = seeds.by === "anilistId" ? seeds.seeds.map((seed) => seed.anilistId) : [];
    fetched = { seedGroups, discovery, context: buildUserContext({ list, history, memory, watchedAnilistIds }) };
  } catch (error) {
    console.warn("[En] AniList discovery failed; using the curated catalog instead", error.message);
  }

  const assemble = (activeConstraints) => {
    const pool = fetched ? rankPool({ ...fetched, tasteProfile, mood: discoveryMood, constraints: activeConstraints, exclude, limit }) : [];
    if (pool.length >= MIN_POOL) return { candidates: pool, source: "anilist" };

    // AniList unreachable or the open pool came back thin: top up with the
    // curated catalog so a recommendation can still be made.
    const catalog = buildCandidatePool({ mood: discoveryMood, tasteProfile, recentPatterns, memory, limit: limit * 2 })
      .filter((candidate) => meetsConstraints(candidate, activeConstraints) && !exclude.matches(candidate));
    const taken = new Set(pool.map((candidate) => normalizeTitleForCompare(candidate.title)));
    const merged = [...pool, ...catalog.filter((candidate) => !taken.has(normalizeTitleForCompare(candidate.title)))].slice(0, limit);
    return { candidates: merged, source: pool.length ? "anilist+catalog" : "catalog" };
  };

  const result = assemble(constraints);
  if (!Object.keys(constraints).length || result.candidates.length >= MIN_CONSTRAINED_POOL) {
    return { ...result, constraints };
  }
  // Nothing (or almost nothing) meets every limit: relax them rather than
  // fail, and let the model say so.
  return { ...assemble({}), constraints, constraintsRelaxed: true };
}

// "For two": one pool for two people. Seeds come from both people's
// favorites (five each); nothing either has seen gets in, though a show on
// the other person's plan-to-watch list is allowed and flagged; and sequels
// are left out entirely, since a continuation only works if both finished
// the first part. Titles that fans of BOTH people's favorites recommend rank
// highest.
export async function buildTogetherPool({ mood = "", passedOver = [], you, partner, recentPatterns, exclude = NO_EXCLUSIONS, mutedSeeds = [], limit = POOL_LIMIT }) {
  const { constraints, discoveryMood } = buildRequestFilters({ mood, passedOver });
  const tasteProfile = combineTasteProfiles(you.tasteProfile, partner.tasteProfile);
  let fetched = null;
  try {
    const [yourSeeds, theirSeeds] = await Promise.all([
      selectSeeds({ list: you.list, history: you.history, muted: mutedSeeds }),
      selectSeeds({ list: partner.list, history: [] })
    ]);
    const half = (seeds, owner) => ({ by: seeds.by, seeds: seeds.seeds.slice(0, 5).map((seed) => ({ ...seed, owner })) });
    const [yourGroups, theirGroups, discovery] = await Promise.all([
      fetchSeedRecommendations(half(yourSeeds, "you")),
      fetchSeedRecommendations(half(theirSeeds, "partner")),
      fetchDiscovery({
        favorites: withoutExcluded(toAniListFilters(tasteProfile.favoriteGenres), exclude),
        mood: moodFilters(discoveryMood),
        since: (new Date().getFullYear() - 2) * 10000 + 101,
        constraints,
        exclude
      })
    ]);
    const resolvedIds = (seeds) => (seeds.by === "anilistId" ? seeds.seeds.map((seed) => seed.anilistId) : []);
    fetched = {
      seedGroups: [...yourGroups, ...theirGroups],
      discovery,
      context: buildTogetherContext({
        you,
        partner,
        yourWatchedAnilistIds: resolvedIds(yourSeeds),
        theirWatchedAnilistIds: resolvedIds(theirSeeds)
      })
    };
  } catch (error) {
    console.warn("[En] AniList discovery failed; using the curated catalog instead", error.message);
  }

  const assemble = (activeConstraints) => {
    const pool = fetched ? rankPool({ ...fetched, tasteProfile, mood: discoveryMood, constraints: activeConstraints, exclude, limit }) : [];
    if (pool.length >= MIN_POOL) return { candidates: pool, source: "anilist" };

    const context = fetched?.context || buildTogetherContext({ you, partner });
    const catalog = buildCandidatePool({ mood: discoveryMood, tasteProfile, recentPatterns, memory: you.memory, limit: limit * 2 })
      .filter((candidate) => meetsConstraints(candidate, activeConstraints) && !seenByPartner(candidate, context) && !exclude.matches(candidate));
    const taken = new Set(pool.map((candidate) => normalizeTitleForCompare(candidate.title)));
    const merged = [...pool, ...catalog.filter((candidate) => !taken.has(normalizeTitleForCompare(candidate.title)))].slice(0, limit);
    return { candidates: merged, source: pool.length ? "anilist+catalog" : "catalog" };
  };

  const result = assemble(constraints);
  if (!Object.keys(constraints).length || result.candidates.length >= MIN_CONSTRAINED_POOL) {
    return { ...result, constraints };
  }
  return { ...assemble({}), constraints, constraintsRelaxed: true };
}

// "Pick up where you left off": shows the user is watching or put on hold,
// started (some progress, not finished), untouched for a few weeks, and not
// suggested (or passed over) recently. Best-loved and furthest-along first.
const RESUME_LIMIT = 2;
const RESUME_STALE_MS = 21 * 24 * 60 * 60 * 1000;
const RESUME_REPEAT_MS = 30 * 24 * 60 * 60 * 1000;

export function resumeCandidates({ list, history = [], now = Date.now() }) {
  if (!Array.isArray(list)) return [];

  const recent = new Set();
  for (const entry of history) {
    if (entry.mode !== "resume") continue;
    const since = Date.parse(entry.not_tonight_at || entry.date || "") || 0;
    const window = entry.state === "not_tonight" ? NOT_TONIGHT_COOLDOWN_MS : RESUME_REPEAT_MS;
    if (now - since < window) recent.add(normalizeTitleForCompare(entry.recommendation?.title));
  }

  return list
    .filter((entry) => ["watching", "on_hold"].includes(entry.my_list_status?.status))
    .map((entry) => {
      const watched = Number(entry.my_list_status?.num_episodes_watched) || 0;
      const total = Number(entry.episodes) || 0;
      const updated = updatedAt(entry);
      return { entry, watched, total, updated };
    })
    .filter(({ entry, watched, total, updated }) =>
      watched > 0 &&
      (!total || watched < total) &&
      updated && now - updated >= RESUME_STALE_MS &&
      !recent.has(normalizeTitleForCompare(entry.alternative_titles?.en || entry.title))
    )
    .sort((a, b) =>
      scoreOf(b.entry) - scoreOf(a.entry) ||
      (b.total ? b.watched / b.total : 0) - (a.total ? a.watched / a.total : 0) ||
      b.updated - a.updated
    )
    .slice(0, RESUME_LIMIT)
    .map(({ entry, watched, total, updated }) => ({
      title: entry.alternative_titles?.en || entry.title,
      title_jp: entry.alternative_titles?.ja || entry.title,
      alternative_titles: { en: entry.alternative_titles?.en || null, synonyms: uniqueTitles([entry.title, ...(entry.alternative_titles?.synonyms || [])]) },
      malId: entry.id || null,
      anilistId: entry.anilistId || null,
      year: entry.year ?? null,
      episodes: entry.episodes ?? null,
      genres: entry.genres || [],
      genre: (entry.genres || []).slice(0, 2).join(", "),
      tags: [],
      image_url: entry.image_url || "",
      sources: ["resume"],
      because: [],
      becauseThem: [],
      rankScore: 0,
      resume: {
        status: entry.my_list_status.status === "on_hold" ? "on hold" : "watching",
        watched,
        total: total || null,
        remaining: total ? total - watched : null,
        since: new Date(updated).toISOString().slice(0, 7)
      }
    }));
}

export function buildTogetherContext({ you, partner, yourWatchedAnilistIds = [], theirWatchedAnilistIds = [] }) {
  const context = buildUserContext({ list: you.list, history: you.history, memory: you.memory, watchedAnilistIds: yourWatchedAnilistIds });
  const partnerSeenIds = new Set();
  const partnerPlanIds = new Set();
  const partnerSeenKeys = new Set();

  if (Array.isArray(partner.list)) {
    for (const entry of partner.list) {
      if (entry.my_list_status?.status === "plan_to_watch") {
        if (entry.id) partnerPlanIds.add(entry.id);
        continue;
      }
      if (entry.id) partnerSeenIds.add(entry.id);
      animeTitleKeys(entry).forEach((key) => partnerSeenKeys.add(key));
    }
  } else {
    parseManualTitles(partner.list)
      .map(normalizeTitleForCompare)
      .filter(Boolean)
      .forEach((key) => partnerSeenKeys.add(key));
  }
  theirWatchedAnilistIds.forEach((id) => context.excludedAnilistIds.add(id));

  return { ...context, partnerSeenIds, partnerPlanIds, partnerSeenKeys, allowContinuations: false };
}

// Genres both people favor come first; what either one dislikes is avoided,
// unless it's something both favor.
export function combineTasteProfiles(yours = {}, theirs = {}) {
  const mine = yours.favoriteGenres || [];
  const other = theirs.favoriteGenres || [];
  const otherKeys = new Set(other.map(normalizeTitleForCompare));
  const shared = mine.filter((genre) => otherKeys.has(normalizeTitleForCompare(genre)));
  const interleaved = [];
  for (let i = 0; i < Math.max(mine.length, other.length); i += 1) {
    if (mine[i]) interleaved.push(mine[i]);
    if (other[i]) interleaved.push(other[i]);
  }
  const sharedKeys = new Set(shared.map(normalizeTitleForCompare));
  return {
    ...yours,
    favoriteGenres: uniqueTitles([...shared, ...interleaved]).slice(0, 8),
    dislikedTropes: uniqueTitles([...(yours.dislikedTropes || []), ...(theirs.dislikedTropes || [])])
      .filter((trope) => !sharedKeys.has(normalizeTitleForCompare(trope)))
  };
}

function seenByPartner(candidate, context) {
  if (candidate.malId && context.partnerSeenIds?.has(candidate.malId)) return true;
  return Boolean(context.partnerSeenKeys?.size) &&
    candidateTitles(candidate).some((title) => context.partnerSeenKeys.has(normalizeTitleForCompare(title)));
}

// Hard limits read from the mood ("a film", "something short", "airing now",
// "a 90s classic"). Patterns are deliberately narrow: "after a long day" must
// not turn into "only long series".
export function parseConstraints(mood) {
  const text = ` ${String(mood || "").toLowerCase()} `;
  const constraints = {};

  if (/\b(film|films|movie|movies)\b/.test(text)) constraints.formats = ["MOVIE"];

  const under = text.match(/\b(under|less than|fewer than|at most|no more than|max(?:imum)?)\s+(\d{1,3})\s*(?:ep|eps|episodes)\b/);
  if (under) {
    const strict = ["under", "less than", "fewer than"].includes(under[1]);
    constraints.maxEpisodes = Math.max(1, Number(under[2]) - (strict ? 1 : 0));
  } else if (/\b(short|quick|one sitting|bite[- ]sized|few episodes)\b/.test(text)) {
    constraints.maxEpisodes = 13;
  } else if (/\b(long (?:series|show|one|anime)|something long|to sink into|binge|bingeable)\b/.test(text)) {
    constraints.minEpisodes = 24;
  }

  if (/\b(airing|currently airing|this season|ongoing|weekly)\b/.test(text)) constraints.status = "RELEASING";

  const nineteen = text.match(/\b(?:19)?([5-9]0)'?s\b/);
  const twenty = text.match(/\b20([0-2])0'?s\b/);
  if (twenty || nineteen) {
    const start = twenty ? 2000 + Number(twenty[1]) * 10 : 1900 + Number(nineteen[1]);
    constraints.yearMin = start;
    constraints.yearMax = start + 9;
  } else if (/\b(classic|retro|old[- ]school|vintage|older)\b/.test(text)) {
    constraints.yearMax = 2005;
  } else if (/\b(recent|latest|this year|newer|brand new)\b/.test(text)) {
    constraints.yearMin = new Date().getFullYear() - 3;
  }

  return constraints;
}

// Tonight's limits: the mood's, plus whatever "not tonight" reasons rule out.
export function buildRequestFilters({ mood = "", passedOver = [] }) {
  const constraints = parseConstraints(mood);
  let discoveryMood = mood;
  for (const pass of passedOver) {
    if (pass.reason === "too long") {
      // A 12-episode show was too long: go to films / very short; a long
      // series was too long: anything up to a single cour.
      constraints.maxEpisodes = Math.min(constraints.maxEpisodes ?? Infinity, (pass.episodes || 0) > 13 ? 13 : 2);
    } else if (pass.reason === "too heavy") {
      discoveryMood += " lighthearted gentle";
    } else if (pass.reason === "too light") {
      discoveryMood += " heavy dark";
    }
  }
  return { constraints, discoveryMood: discoveryMood.trim() };
}

export function meetsConstraints(candidate, constraints = {}) {
  const format = candidate.format || (candidate.episodes === 1 ? "MOVIE" : "TV");
  const status = candidate.status || "FINISHED";
  const episodes = Number(candidate.episodes) || 0;
  if (constraints.formats && !constraints.formats.includes(format)) return false;
  if (constraints.maxEpisodes != null && !(episodes && episodes <= constraints.maxEpisodes)) return false;
  if (constraints.minEpisodes != null && !(episodes >= constraints.minEpisodes)) return false;
  if (constraints.status && status !== constraints.status) return false;
  if (constraints.yearMin != null && !(candidate.year >= constraints.yearMin)) return false;
  if (constraints.yearMax != null && !(candidate.year <= constraints.yearMax)) return false;
  return true;
}

// The AniList filter for discovery queries, with the hard limits applied by
// AniList itself so "a film" fetches films instead of filtering a TV-heavy
// list down to nothing. Values only ever come from parseConstraints.
function discoveryFilter(constraints = {}, exclude = NO_EXCLUSIONS) {
  const parts = ["type: ANIME", "isAdult: false", `format_in: [${(constraints.formats || DEFAULT_FORMATS).join(", ")}]`];
  // Names only ever come from preferences.js EXCLUDABLE, never user text.
  if (exclude.genres.length) parts.push(`genre_not_in: ${JSON.stringify(exclude.genres)}`);
  if (exclude.tags.length) parts.push(`tag_not_in: ${JSON.stringify(exclude.tags)}`);
  parts.push(constraints.status ? `status: ${constraints.status}` : "status_in: [FINISHED, RELEASING]");
  if (constraints.maxEpisodes != null) parts.push(`episodes_lesser: ${constraints.maxEpisodes + 1}`);
  if (constraints.minEpisodes != null) parts.push(`episodes_greater: ${constraints.minEpisodes - 1}`);
  if (constraints.yearMin != null) parts.push(`startDate_greater: ${constraints.yearMin * 10000}`);
  if (constraints.yearMax != null) parts.push(`startDate_lesser: ${(constraints.yearMax + 1) * 10000}`);
  return parts.join(", ");
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
    becauseTheyLiked: candidate.becauseThem?.length ? candidate.becauseThem.slice(0, 3) : null,
    onTheirPlanToWatch: candidate.onTheirPlanToWatch || null,
    resume: candidate.resume
      ? { status: candidate.resume.status, stoppedAt: `${candidate.resume.watched}/${candidate.resume.total || "?"}`, since: candidate.resume.since }
      : null,
    continues: candidate.continues || null,
    airing: candidate.status === "RELEASING" || null,
    pacing: candidate.pacing,
    darkness: candidate.darkness
  });
}

// ---------- seeds ----------

// Which of the user's shows to start from. The three most recent good
// finishes always seed (that's what they're into now); the rest are drawn at
// random, weighted by how much they loved them, from a wider bench of
// favorites, so back-to-back pools don't all grow from the same few shows.
export async function selectSeeds({ list, history = [], random = Math.random, muted = [] }) {
  const isMuted = mutedCheck(muted);
  const likedPicks = history.filter((entry) => entry.feedback === "good" && entry.recommendation && !isMuted(entry.recommendation));

  if (Array.isArray(list)) {
    const { by, favorites, recentGood, average } = seedBench(list, { muted });
    const idOf = (entry) => (by === "anilistId" ? entry.anilistId : entry.id);

    const weightOf = (entry) => {
      const weight = average && scoreOf(entry) ? clamp(scoreOf(entry) - average + 1, 0.5, 4) : 1;
      return Date.now() - updatedAt(entry) < 120 * 24 * 60 * 60 * 1000 ? weight * 1.25 : weight;
    };
    const seeds = new Map();
    const add = (entry) => seeds.set(idOf(entry), {
      [by]: idOf(entry),
      title: entry.alternative_titles?.en || entry.title,
      weight: weightOf(entry)
    });

    recentGood.slice(0, 3).forEach(add);
    const bench = [...favorites, ...recentGood.slice(3)].filter((entry, index, all) =>
      !seeds.has(idOf(entry)) && all.findIndex((other) => idOf(other) === idOf(entry)) === index
    );
    while (seeds.size < SEED_LIMIT && bench.length) {
      const total = bench.reduce((sum, entry) => sum + weightOf(entry), 0);
      let roll = random() * total;
      const index = bench.findIndex((entry) => (roll -= weightOf(entry)) <= 0);
      add(bench.splice(index < 0 ? bench.length - 1 : index, 1)[0]);
    }

    for (const entry of likedPicks) {
      const id = by === "anilistId" ? entry.recommendation.anilistId : entry.recommendation.malId;
      if (id && !seeds.has(id) && seeds.size < SEED_LIMIT) {
        seeds.set(id, { [by]: id, title: entry.recommendation.title, weight: 1.5 });
      }
    }
    return { by, seeds: [...seeds.values()] };
  }

  // Manual mode: resolve the typed titles on AniList (cached per title).
  const typed = parseManualTitles(list).slice(0, 8);
  const resolved = await Promise.all(typed.map((title) => resolveAnimeOnAniList(title)));
  const seeds = new Map();
  resolved.forEach((match, index) => {
    if (match?.anilistId && !seeds.has(match.anilistId) && !isMuted({ anilistId: match.anilistId, title: match.title || typed[index] })) {
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

// The favorites seeds are drawn from, best first: highly scored finishes,
// and the most recent good ones. Also what "What En knows about you" lists
// as where En starts looking.
export function seedBench(list, { muted = [] } = {}) {
  if (!Array.isArray(list)) return { by: "anilistId", favorites: [], recentGood: [], average: null };
  const isMuted = mutedCheck(muted);
  // Lists read from AniList carry AniList ids (not every show has a MAL id).
  const by = list.some((entry) => entry.anilistId) ? "anilistId" : "malId";
  const idOf = (entry) => (by === "anilistId" ? entry.anilistId : entry.id);
  const completed = list.filter((entry) => entry.my_list_status?.status === "completed" && idOf(entry));
  const scored = completed.filter((entry) => scoreOf(entry) > 0);
  // The average is the whole list's; muting a favorite doesn't change it.
  const average = scored.length ? scored.reduce((sum, entry) => sum + scoreOf(entry), 0) / scored.length : null;
  const favorites = scored
    .filter((entry) => !isMuted(entry) && scoreOf(entry) >= Math.max(average || 0, 7))
    .sort((a, b) => scoreOf(b) - scoreOf(a) || updatedAt(b) - updatedAt(a))
    .slice(0, 24);
  const recentGood = completed
    .filter((entry) => !isMuted(entry) && (!scoreOf(entry) || scoreOf(entry) >= (average || 0)))
    .sort((a, b) => updatedAt(b) - updatedAt(a))
    .slice(0, 6);
  return { by, favorites, recentGood, average };
}

function mutedCheck(muted = []) {
  if (!muted.length) return () => false;
  const malIds = new Set(muted.map((seed) => seed.malId).filter(Boolean));
  const anilistIds = new Set(muted.map((seed) => seed.anilistId).filter(Boolean));
  const titles = new Set(muted.map((seed) => normalizeTitleForCompare(seed.title)).filter(Boolean));
  // A list entry (id = MAL id) or a logged pick (malId / anilistId).
  return (item) =>
    Boolean(
      (item.id && malIds.has(item.id)) ||
      (item.malId && malIds.has(item.malId)) ||
      (item.anilistId && anilistIds.has(item.anilistId)) ||
      animeTitleKeys(item).some((key) => titles.has(key))
    );
}

async function fetchSeedRecommendations({ by, seeds }) {
  if (!seeds.length) return [];
  const recsById = new Map();
  const missing = [];
  for (const seed of seeds) {
    const cached = readCache(`seed:${by}:${seed[by]}`, SEED_CACHE_TTL_MS);
    if (cached) recsById.set(seed[by], cached);
    else missing.push(seed[by]);
  }

  if (missing.length) {
    const filter = by === "malId" ? "idMal_in: $ids" : "id_in: $ids";
    const data = await aniListRequest(
      `query ($ids: [Int]) { Page(perPage: ${SEED_LIMIT}) { media(${filter}, type: ANIME) {
        id idMal
        recommendations(perPage: ${RECS_PER_SEED}, sort: [RATING_DESC]) { nodes { rating mediaRecommendation { ${MEDIA_FIELDS} } } }
      } } }`,
      { ids: missing },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    );
    const fresh = {};
    for (const media of data?.Page?.media || []) {
      const id = by === "malId" ? media.idMal : media.id;
      const recs = (media.recommendations?.nodes || [])
        .filter((node) => node.mediaRecommendation)
        .map((node) => ({ rating: node.rating || 0, candidate: toCandidate(node.mediaRecommendation) }));
      recsById.set(id, recs);
      fresh[`seed:${by}:${id}`] = recs;
    }
    writeCacheEntries(fresh);
  }

  return seeds
    .filter((seed) => recsById.has(seed[by]))
    .map((seed) => ({ seed, recs: recsById.get(seed[by]) }));
}

// ---------- discovery ----------

async function fetchDiscovery({ favorites, mood, since, constraints = {}, exclude = NO_EXCLUSIONS }) {
  const filter = discoveryFilter(constraints, exclude);
  const airing = constraints.status === "RELEASING";
  // New and airing shows often have no score yet, so for "airing now" sort
  // by what's trending instead of demanding a score.
  const quality = (minScore, minPopularity) =>
    airing ? "popularity_greater: 2000, sort: [TRENDING_DESC]" : `averageScore_greater: ${minScore}, popularity_greater: ${minPopularity}, sort: [SCORE_DESC]`;
  const page = (alias, perPage, extra) => `${alias}: Page(perPage: ${perPage}) { media(${filter}, ${extra}) { ${MEDIA_FIELDS} } }`;

  // AniList's genre_in / tag_in match media that have ALL the listed values,
  // so each genre or tag gets its own query (same request) to mean "any of".
  // Names only ever come from the fixed lists above, never from user text.
  const aliases = [];
  favorites.genres.slice(0, 2).forEach((genre, index) => {
    aliases.push(page(`genre${index}`, 25, `genre_in: [${JSON.stringify(genre)}], ${quality(72, 15000)}`));
  });
  favorites.tags.slice(0, 1).forEach((tag, index) => {
    aliases.push(page(`genreTag${index}`, 20, `tag_in: [${JSON.stringify(tag)}], ${quality(70, 8000)}`));
  });
  const moodTerms = [
    ...mood.tags.map((tag) => `tag_in: [${JSON.stringify(tag)}]`),
    ...mood.genres.map((genre) => `genre_in: [${JSON.stringify(genre)}]`)
  ].slice(0, 3);
  moodTerms.forEach((term, index) => {
    aliases.push(page(`mood${index}`, 20, `${term}, ${quality(68, 5000)}`));
  });
  // A year limit already decides the era, so "recent releases" would only
  // contradict it.
  if (constraints.yearMin == null && constraints.yearMax == null) {
    aliases.push(page("recent", 40, `startDate_greater: ${since}, ${quality(74, 10000)}`));
  }
  if (!aliases.length) {
    aliases.push(page("genre0", 50, quality(72, 15000)));
  }

  const query = `query { ${aliases.join("\n")} }`;
  const cacheKey = `disc:${hashString(query)}`;
  const cached = readCache(cacheKey, DISCOVERY_CACHE_TTL_MS);
  if (cached) return cached;

  const data = await aniListRequest(query, {}, { timeoutMs: REQUEST_TIMEOUT_MS });
  const result = { genre: [], mood: [], recent: [] };
  for (const [alias, value] of Object.entries(data || {})) {
    const source = alias.startsWith("mood") ? "mood" : alias.startsWith("recent") ? "recent" : "genre";
    result[source].push(...(value?.media || []).map(toCandidate));
  }
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

function withoutExcluded(filters, exclude) {
  return {
    genres: filters.genres.filter((genre) => !exclude.genres.includes(genre)),
    tags: filters.tags.filter((tag) => !exclude.tags.includes(tag))
  };
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
  const excludedAnilistIds = new Set(watchedAnilistIds);
  const completedAnilistIds = new Set(watchedAnilistIds);
  if (Array.isArray(list)) {
    for (const entry of list) {
      const completed = entry.my_list_status?.status === "completed";
      if (entry.id) {
        listIds.add(entry.id);
        if (completed) completedIds.add(entry.id);
      }
      // Lists read from AniList also carry AniList ids, which cover the
      // shows that have no MAL id.
      if (entry.anilistId) {
        excludedAnilistIds.add(entry.anilistId);
        if (completed) completedAnilistIds.add(entry.anilistId);
      }
    }
  }
  for (const entry of history) {
    const rec = entry.recommendation || {};
    if (rec.anilistId && isStillExcluded(entry)) excludedAnilistIds.add(rec.anilistId);
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

export function rankPool({ seedGroups = [], discovery = {}, context, tasteProfile = {}, mood = "", constraints = {}, exclude = NO_EXCLUSIONS, limit = POOL_LIMIT }) {
  const merged = new Map();
  const add = (candidate, source, extra = {}) => {
    if (!candidate?.anilistId || !isUsable(candidate)) return;
    const entry = merged.get(candidate.anilistId) || { ...candidate, sources: new Set(), becauseWeights: new Map(), becauseOwners: new Map(), similarity: 0 };
    entry.sources.add(source);
    if (extra.seed) {
      entry.similarity += extra.seed.weight * (1 + 2 * Math.max(0, extra.relative || 0));
      entry.becauseWeights.set(extra.seed.title, (entry.becauseWeights.get(extra.seed.title) || 0) + extra.rating);
      entry.becauseOwners.set(extra.seed.title, extra.seed.owner || "you");
    }
    merged.set(candidate.anilistId, entry);
  };

  for (const group of seedGroups) {
    // A hugely popular show's recommendations carry ratings in the
    // thousands; measuring each against the seed's own best keeps one famous
    // favorite from drowning out the rest.
    const best = Math.max(1, ...group.recs.map((rec) => rec.rating || 0));
    for (const rec of group.recs) {
      add(rec.candidate, "similar", { seed: group.seed, rating: rec.rating, relative: (rec.rating || 0) / best });
    }
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
    if (isExcludedCandidate(entry, context) || !meetsConstraints(entry, constraints) || exclude.matches(entry)) continue;
    const continuation = continuationOf(entry, context);
    if (!continuation.ok) continue;

    const labels = [...entry.genres, ...entry.tags].map(normalizeTitleForCompare);
    const count = (set) => labels.filter((label) => set.has(label)).length;
    const owners = new Set(entry.becauseOwners.values());
    // For two: fans of both people's favorites pointing here is the best sign.
    const bothLiked = owners.has("you") && owners.has("partner");
    const onTheirPlanToWatch = Boolean(entry.malId && context.partnerPlanIds?.has(entry.malId));
    const rankScore =
      entry.similarity +
      1.5 * count(favorite) -
      2.5 * count(disliked) +
      2.5 * count(moodKeys) +
      (Number.isFinite(entry.score) ? (entry.score - 70) / 6 : 0) +
      (continuation.continues ? 2 : 0) +
      (bothLiked ? 3 : 0) +
      (onTheirPlanToWatch ? 2 : 0);

    const because = [...entry.becauseWeights.entries()].sort((a, b) => b[1] - a[1]).map(([title]) => title);
    ranked.push({
      ...entry,
      sources: [...entry.sources],
      because: because.filter((title) => entry.becauseOwners.get(title) !== "partner"),
      becauseThem: because.filter((title) => entry.becauseOwners.get(title) === "partner"),
      bothLiked,
      onTheirPlanToWatch,
      becauseWeights: undefined,
      becauseOwners: undefined,
      continues: continuation.continues || null,
      rankScore: Math.round(rankScore * 100) / 100
    });
  }
  ranked.sort((a, b) => b.rankScore - a.rankScore || (b.popularity || 0) - (a.popularity || 0));

  // Keep the pool varied: a few from each source before filling by rank, so
  // tonight's mood and new releases aren't crowded out by "similar".
  const quotas = [["mood", 12], ["recent", 6], ["genre", 8], ["similar", 30]];
  const picked = new Map();
  const perSeed = new Map();
  for (const [source, quota] of quotas) {
    let taken = 0;
    for (const entry of ranked) {
      if (taken >= quota) break;
      if (!entry.sources.includes(source) || picked.has(entry.anilistId)) continue;
      if (source === "similar") {
        const seed = entry.because[0] || entry.becauseThem[0];
        if ((perSeed.get(seed) || 0) >= MAX_PER_SEED) continue;
        perSeed.set(seed, (perSeed.get(seed) || 0) + 1);
      }
      picked.set(entry.anilistId, entry);
      taken += 1;
    }
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
  if (seenByPartner(candidate, context)) return true;
  return candidateTitles(candidate).some((title) => context.isExcludedTitle(title));
}

// A sequel is only a candidate when the user finished something it follows -
// then it's a continuation worth naming. Otherwise it's skipped: En shouldn't
// hand someone season two of a show they never started. (Recaps and side
// stories never get this far; isUsable drops them.)
function continuationOf(candidate, context) {
  if (!candidate.prequels?.length) return { ok: true };
  if (context.allowContinuations === false) return { ok: false };
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
    // Every tag that's a real part of the show (spoilers included, since
    // they're never shown), for the "leave out" filter.
    filterTags: (media.tags || []).filter((tag) => tag.rank >= 50).map((tag) => tag.name),
    score: media.averageScore ?? null,
    popularity: media.popularity || 0,
    image_url: media.coverImage?.extraLarge || media.coverImage?.large || "",
    watchLinks: streamingLinks(media.externalLinks),
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

function writeCacheEntries(entries) {
  if (!Object.keys(entries).length) return;
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    const now = Date.now();
    for (const [key, data] of Object.entries(entries)) cache[key] = { data, cachedAt: now };
    const newest = Object.entries(cache)
      .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
      .slice(0, CACHE_MAX_ENTRIES);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // localStorage full or unavailable (private mode, tests); just don't cache
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

// Short stable key for a query string (djb2), so cache keys stay small.
function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
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

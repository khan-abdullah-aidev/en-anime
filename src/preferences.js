import { normalizeTitleForCompare, uniqueTitles } from "./titleUtils.js";
import { STREAMING_SERVICES } from "./streaming.js";

// What the user has told En directly, as opposed to what En inferred: genres
// to leave out of every pick, corrections to the inferred taste profile,
// favorites not to start from, notes in their own words, and whether to
// write answers back to MyAnimeList. Synced with the log (see sync.js), so
// updatedAt decides which device's copy wins.
const PREFERENCES_KEY = "en.preferences";
export const NOTES_LIMIT = 400;

const DEFAULTS = {
  excludedGenres: [],
  moreOf: [],
  notFavorite: [],
  notDisliked: [],
  // Traits from "What En has learned" the user told it to forget (learning.js keys).
  unlearned: [],
  mutedSeeds: [],
  notes: "",
  malSync: null, // "on" | "off" | null (not asked yet)
  // "Only what I can watch": streaming services (streaming.js labels); empty is anywhere.
  services: [],
  // Leans toward shows with an English dub.
  dub: false,
  // "Nothing over N episodes", from "never like this" on a pass; null is any length.
  maxEpisodes: null,
  updatedAt: ""
};

// Everything the "leave out" filter offers. genres/tags are AniList's exact
// names (used in the discovery query); aliases are how MyAnimeList and the
// curated catalog spell the same thing.
export const EXCLUDABLE = [
  { label: "Action", genres: ["Action"] },
  { label: "Adventure", genres: ["Adventure"] },
  { label: "Comedy", genres: ["Comedy"] },
  { label: "Drama", genres: ["Drama"] },
  { label: "Ecchi", genres: ["Ecchi"] },
  { label: "Fantasy", genres: ["Fantasy"] },
  { label: "Horror", genres: ["Horror"] },
  { label: "Mahou Shoujo", genres: ["Mahou Shoujo"] },
  { label: "Mecha", genres: ["Mecha"] },
  { label: "Music", genres: ["Music"] },
  { label: "Mystery", genres: ["Mystery"] },
  { label: "Psychological", genres: ["Psychological"] },
  { label: "Romance", genres: ["Romance"] },
  { label: "Sci-Fi", genres: ["Sci-Fi"] },
  { label: "Slice of Life", genres: ["Slice of Life"] },
  { label: "Sports", genres: ["Sports"] },
  { label: "Supernatural", genres: ["Supernatural"] },
  { label: "Thriller", genres: ["Thriller"], aliases: ["Suspense"] },
  { label: "Isekai", tags: ["Isekai"] },
  { label: "Harem", tags: ["Female Harem", "Male Harem", "Mixed Gender Harem"], aliases: ["Harem", "Reverse Harem"] },
  { label: "Idols", tags: ["Idol"], aliases: ["Idols (Female)", "Idols (Male)"] },
  { label: "School", tags: ["School"] },
  { label: "Gore", tags: ["Gore"] },
  { label: "Kids", tags: ["Kids"] },
  { label: "Full CGI", tags: ["Full CGI"] }
];

// The genres a user can say En missed ("more of this").
export const GENRE_OPTIONS = EXCLUDABLE.filter((option) => option.genres && option.label !== "Ecchi").map((option) => option.label);

export function loadPreferences() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "null");
    return normalizePreferences(raw);
  } catch {
    return normalizePreferences(null);
  }
}

// Replaces the stored preferences with these (already merged) ones.
export function writePreferences(preferences) {
  const next = normalizePreferences(preferences);
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable; the change lasts for this visit only
  }
  return next;
}

export function updatePreferences(patch) {
  return writePreferences({ ...loadPreferences(), ...patch, updatedAt: new Date().toISOString() });
}

export function normalizePreferences(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const labels = (list) => uniqueTitles((Array.isArray(list) ? list : []).filter((item) => typeof item === "string")).slice(0, 40);
  const knownExcludable = new Set(EXCLUDABLE.map((option) => option.label));
  return {
    ...DEFAULTS,
    excludedGenres: labels(value.excludedGenres).filter((label) => knownExcludable.has(label)),
    moreOf: labels(value.moreOf),
    notFavorite: labels(value.notFavorite),
    notDisliked: labels(value.notDisliked),
    unlearned: (Array.isArray(value.unlearned) ? value.unlearned : []).filter((key) => typeof key === "string").slice(0, 100),
    mutedSeeds: (Array.isArray(value.mutedSeeds) ? value.mutedSeeds : [])
      .filter((seed) => seed && typeof seed.title === "string")
      .map((seed) => ({ title: seed.title, malId: Number(seed.malId) || null, anilistId: Number(seed.anilistId) || null }))
      .slice(0, 60),
    notes: typeof value.notes === "string" ? value.notes.slice(0, NOTES_LIMIT) : "",
    malSync: value.malSync === "on" || value.malSync === "off" ? value.malSync : null,
    services: (Array.isArray(value.services) ? value.services : []).filter((label) => STREAMING_SERVICES.some((service) => service.label === label)),
    dub: value.dub === true,
    maxEpisodes: Number.isInteger(value.maxEpisodes) && value.maxEpisodes > 0 && value.maxEpisodes < 1000 ? value.maxEpisodes : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
}

// The "leave out" filter as discovery.js uses it: AniList names for the
// query, and a check for candidates from anywhere (AniList, the catalog, the
// user's own list).
export function exclusionFilter(excludedGenres = []) {
  const chosen = EXCLUDABLE.filter((option) => excludedGenres.includes(option.label));
  const keys = new Set(
    chosen.flatMap((option) => [option.label, ...(option.genres || []), ...(option.tags || []), ...(option.aliases || [])])
      .map(normalizeTitleForCompare)
  );
  return {
    labels: chosen.map((option) => option.label),
    genres: chosen.flatMap((option) => option.genres || []),
    tags: chosen.flatMap((option) => option.tags || []),
    matches(candidate) {
      if (!keys.size) return false;
      const labels = [
        ...(candidate?.genres || []),
        ...(candidate?.filterTags || candidate?.tags || []),
        ...(candidate?.themes || [])
      ];
      return labels.some((label) => keys.has(normalizeTitleForCompare(label)));
    }
  };
}

// The inferred profile with the user's corrections applied: genres they
// asked for more of come first, ones they said En got wrong are dropped, and
// nothing they've left out entirely counts as a favorite.
export function applyTasteCorrections(profile, preferences = loadPreferences()) {
  if (!profile) return profile;
  const keysOf = (list) => new Set(list.map(normalizeTitleForCompare));
  const notFavorite = keysOf(preferences.notFavorite);
  const notDisliked = keysOf(preferences.notDisliked);
  const moreOf = keysOf(preferences.moreOf);
  const excluded = keysOf(exclusionFilterKeys(preferences.excludedGenres));
  return {
    ...profile,
    favoriteGenres: uniqueTitles([...preferences.moreOf, ...(profile.favoriteGenres || [])])
      .filter((genre) => !notFavorite.has(normalizeTitleForCompare(genre)) && !excluded.has(normalizeTitleForCompare(genre)))
      .slice(0, 8),
    dislikedTropes: (profile.dislikedTropes || []).filter((trope) => {
      const key = normalizeTitleForCompare(trope);
      return !notDisliked.has(key) && !moreOf.has(key);
    })
  };
}

// What goes to the model as "userSaid": only what the user actually said.
export function userSaidFor(preferences = loadPreferences()) {
  const said = {
    notes: preferences.notes.trim() || null,
    moreOf: preferences.moreOf.length ? preferences.moreOf : null,
    notReally: preferences.notFavorite.length ? preferences.notFavorite : null,
    neverSuggest: preferences.excludedGenres.length ? preferences.excludedGenres : null,
    prefersDub: preferences.dub || null,
    nothingLongerThanEpisodes: preferences.maxEpisodes || null
  };
  const present = Object.fromEntries(Object.entries(said).filter(([, value]) => value));
  return Object.keys(present).length ? present : null;
}

function exclusionFilterKeys(excludedGenres = []) {
  return EXCLUDABLE.filter((option) => excludedGenres.includes(option.label))
    .flatMap((option) => [option.label, ...(option.genres || []), ...(option.aliases || [])]);
}

// "Never like this", offered on a pass: what of the pick could become a
// standing rule. Genres and tags it has that "leave out" knows, not already
// left out, and its length when it's longer than a cour.
export function neverOptions(pick, preferences = loadPreferences()) {
  const features = pick?.features || {};
  const candidate = {
    genres: features.g || String(pick?.genre || "").split(",").map((genre) => genre.trim()).filter(Boolean),
    tags: features.t || []
  };
  const options = EXCLUDABLE
    .filter((option) => !preferences.excludedGenres.includes(option.label) && exclusionFilter([option.label]).matches(candidate))
    .slice(0, 4)
    .map((option) => ({ kind: "genre", label: option.label, text: option.label.toLowerCase() }));
  const episodes = Number(pick?.episodes) || 0;
  const limit = episodes > 26 ? 26 : episodes > 13 ? 13 : null;
  if (limit && !(preferences.maxEpisodes && preferences.maxEpisodes <= limit)) {
    options.push({ kind: "length", maxEpisodes: limit, text: `anything over ${limit} episodes` });
  }
  return options;
}

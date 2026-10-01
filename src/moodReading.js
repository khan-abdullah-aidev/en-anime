import { debugLog } from "./debug.js";
import { requestEn } from "./llmProviders.js";
import { AVOID_GENRES, AVOID_TAGS, MOOD_GENRES, MOOD_TAGS } from "./moodVocabulary.js";

// Tonight's mood, read by the model (api/_lib/prompts.js MOOD_PROMPT) into
// AniList genres and tags to search for, what it rules out, any limits it
// states, and a few words for how it sounds. Anything can fail here (no
// network, slow model, odd answer): then it's null, and discovery falls
// back to its word list, so a pick never waits on this.
const CACHE_KEY = "en.moodReadings.v2"; // v2: readings checked against the mood's own words
const CACHE_LIMIT = 40;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 7000;

// The model reads more into a mood than it says (on production it ruled
// out Action for "rain on a Tuesday", and capped "my brain is fried" at 13
// episodes). A reading's avoid lists and limits only count when the mood has
// words of that kind. Moods in other scripts are taken as read.
const CUES = {
  avoid: /\b(no|not|nothing|none|without|don'?t|do not|can'?t|cannot|never|avoid|skip|instead|except|anything but|tired of|sick of|enough|less|isn'?t|aren'?t|won'?t|hate)\b/i,
  episodes: /\b(finish|short|shorter|quick|sitting|episodes?|eps|long|longer|binge|bingeable|sink|marathon|month|weekend|brief|hours?|minutes?|cour|season)\b/i,
  film: /\b(film|films|movie|movies|cinema)\b/i,
  airing: /\b(airing|currently|right now|this season|ongoing|weekly|new episodes|simulcast)\b/i,
  era: /\b(\d{2,4}'?s?|old|older|oldie|classic|classics|retro|vintage|recent|newer|latest|new|era|decade|childhood|grew up)\b/i
};
const NON_LATIN = /[^\u0000-\u024f\s\d\p{P}\p{S}]/u;

export async function readMood(mood, { passedOver = [] } = {}) {
  const text = String(mood || "").trim().slice(0, 500);
  if (!text) return null;
  const reasons = [...new Set(passedOver.map((pass) => pass.reason).filter(Boolean))].sort();
  const key = `${text.toLowerCase().replace(/\s+/g, " ")}|${reasons.join(",")}`;

  const cached = readCache(key);
  if (cached) return cached;

  try {
    const content = await withTimeout(requestEn("mood", { mood: text, ...(reasons.length ? { passedOver: reasons } : {}) }), TIMEOUT_MS);
    const reading = parseMoodReading(content, { mood: text, passedOver: reasons });
    debugLog("[En debug] mood reading", { mood: text, reasons, reading });
    if (reading) writeCache(key, reading);
    return reading;
  } catch (error) {
    debugLog("[En debug] mood reading failed; using the word list", error.message);
    return null;
  }
}

// Keeps only what the model is allowed to say: known genre and tag names,
// sensible numbers, and avoids or limits the mood's own words back up (see
// CUES). Returns null when nothing useful is left.
export function parseMoodReading(content, { mood = "", passedOver = [] } = {}) {
  let raw;
  try {
    const text = String(content || "").trim();
    raw = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const known = (values, allowed, limit) =>
    [...new Set((Array.isArray(values) ? values : []).filter((value) => allowed.includes(value)))].slice(0, limit);
  const count = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : null);
  const year = (value) => count(value, 1950, new Date().getFullYear() + 1);

  const reading = {
    reading: typeof raw.reading === "string" ? raw.reading.trim().toLowerCase().replace(/[.!]+$/, "").slice(0, 60) : "",
    genres: known(raw.genres, MOOD_GENRES, 3),
    tags: known(raw.tags, MOOD_TAGS, 4),
    avoidGenres: known(raw.avoidGenres, AVOID_GENRES, 4),
    avoidTags: known(raw.avoidTags, AVOID_TAGS, 6),
    film: raw.film === true,
    maxEpisodes: count(raw.maxEpisodes, 1, 200),
    minEpisodes: count(raw.minEpisodes, 2, 500),
    airing: raw.airing === true,
    yearMin: year(raw.yearMin),
    yearMax: year(raw.yearMax)
  };
  const said = (cue) => !mood || NON_LATIN.test(mood) || CUES[cue].test(mood);
  if (!said("avoid") && !passedOver.length) {
    reading.avoidGenres = [];
    reading.avoidTags = [];
  }
  if (!said("episodes") && !passedOver.includes("too long")) {
    reading.maxEpisodes = null;
    reading.minEpisodes = null;
  }
  if (!said("film")) reading.film = false;
  if (!said("airing")) reading.airing = false;
  if (!said("era")) {
    reading.yearMin = null;
    reading.yearMax = null;
  }

  // What it asks for and what it rules out can't overlap.
  reading.genres = reading.genres.filter((genre) => !reading.avoidGenres.includes(genre));
  reading.tags = reading.tags.filter((tag) => !reading.avoidTags.includes(tag));
  if (reading.maxEpisodes && reading.minEpisodes && reading.minEpisodes > reading.maxEpisodes) {
    reading.maxEpisodes = null;
    reading.minEpisodes = null;
  }
  if (reading.yearMin && reading.yearMax && reading.yearMin > reading.yearMax) {
    reading.yearMin = null;
    reading.yearMax = null;
  }

  const saysSomething =
    reading.reading || reading.genres.length || reading.tags.length || reading.avoidGenres.length ||
    reading.avoidTags.length || reading.film || reading.maxEpisodes || reading.minEpisodes || reading.airing ||
    reading.yearMin || reading.yearMax;
  return saysSomething ? reading : null;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("mood reading timed out")), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function readCache(key) {
  try {
    const entry = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}")[key];
    return entry && Date.now() - entry.at < CACHE_TTL_MS ? entry.reading : null;
  } catch {
    return null;
  }
}

function writeCache(key, reading) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    cache[key] = { reading, at: Date.now() };
    const newest = Object.entries(cache)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_LIMIT);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    // storage unavailable; the mood is just read again next time
  }
}

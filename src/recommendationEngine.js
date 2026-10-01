import { ANIME_CATALOG } from "./animeCatalog.js";
import { normalizeTitleForCompare, parseManualTitles, titleMatchesAnime, uniqueTitles } from "./titleUtils.js";

// in_progress mirrors what's currently watching/on hold on MAL, and
// recommended mirrors En's log, so unlike the other buckets both are rebuilt
// each time rather than accumulated.
const MEMORY_BUCKETS = ["recommended", "completed", "rejected", "watchlisted", "pending", "in_progress"];
// A pick the user passed over ("not tonight", or asked again instead) isn't
// a verdict on the show, so it comes back into the pool after this long.
export const NOT_TONIGHT_COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000;
const TOKEN_STOPWORDS = new Set(["of", "the", "a", "an", "and", "in", "to", "for", "with", "or"]);
// MAL genre names that mean the same thing as the catalog's own tags.
const TOKEN_ALIASES = { iyashikei: "healing", suspense: "thriller" };
const DEFAULT_CANDIDATE_LIMIT = 60;

export function buildRecommendationMemory({ malList, history = [], existingMemory = null }) {
  const memory = normalizeMemory(existingMemory);

  if (Array.isArray(malList)) {
    memory.in_progress = [];
  }
  memory.recommended = [];

  for (const entry of Array.isArray(malList) ? malList : []) {
    const status = entry.my_list_status?.status;
    const titles = extractMalTitles(entry);
    if (status === "completed") {
      memory.completed = uniqueTitles([...memory.completed, ...titles]);
    } else if (status === "dropped") {
      memory.rejected = uniqueTitles([...memory.rejected, ...titles]);
    } else if (status === "plan_to_watch") {
      memory.watchlisted = uniqueTitles([...memory.watchlisted, ...titles]);
    } else if (status === "watching" || status === "on_hold") {
      memory.in_progress = uniqueTitles([...memory.in_progress, ...titles]);
    }
  }

  if (typeof malList === "string") {
    memory.completed = uniqueTitles([...memory.completed, ...parseManualTitles(malList)]);
  }

  for (const entry of history) {
    const titles = [entry.recommendation?.title, entry.recommendation?.title_jp].filter(Boolean);
    if (isStillExcluded(entry)) {
      memory.recommended = uniqueTitles([...memory.recommended, ...titles]);
    }
    if (entry.state === "pending") {
      memory.pending = uniqueTitles([...memory.pending, ...titles]);
      memory.watchlisted = uniqueTitles([...memory.watchlisted, ...titles]);
    }
    if (entry.feedback === "good") {
      memory.completed = uniqueTitles([...memory.completed, ...titles]);
    }
    if (entry.feedback === "meh") {
      memory.rejected = uniqueTitles([...memory.rejected, ...titles]);
    }
  }

  return memory;
}

// Whether a logged pick should still keep its title out of new pools.
export function isStillExcluded(entry, now = Date.now()) {
  if (entry?.state !== "not_tonight") return true;
  const since = Date.parse(entry.not_tonight_at || entry.date || "") || 0;
  return now - since < NOT_TONIGHT_COOLDOWN_MS;
}

export function buildCandidatePool({
  mood = "",
  tasteProfile,
  recentPatterns,
  memory,
  limit = DEFAULT_CANDIDATE_LIMIT,
  removeFranchiseDuplicates = true
}) {
  const excluded = buildExcludedTitleSet(memory);
  const usedFranchises = new Set();
  const moodTokens = tokenize(mood);

  return ANIME_CATALOG
    .filter((anime) => !isExcludedAnime(anime, excluded))
    .map((anime) => ({
      ...anime,
      rankScore: scoreAnime(anime, tasteProfile, recentPatterns, moodTokens)
    }))
    .sort((a, b) => b.rankScore - a.rankScore || a.title.localeCompare(b.title))
    .filter((anime) => {
      if (!removeFranchiseDuplicates || !anime.franchise) return true;
      if (usedFranchises.has(anime.franchise)) return false;
      usedFranchises.add(anime.franchise);
      return true;
    })
    .slice(0, limit)
    .map(toCandidate);
}

export function findCandidateByRecommendation(recommendation, candidateList = []) {
  return candidateList.find((candidate) =>
    titleMatchesAnime(recommendation?.title, candidate) ||
    titleMatchesAnime(recommendation?.title_jp, candidate)
  );
}

export function deterministicRecommendation(candidateList = []) {
  const candidate = candidateList[0];
  if (!candidate) {
    throw new Error("No eligible anime remain after filtering.");
  }
  return {
    title: candidate.title,
    title_jp: candidate.title_jp || candidate.title,
    year: candidate.year,
    episodes: candidate.episodes,
    genre: candidate.genre,
    // Only reached when the model failed every attempt, so say so plainly
    // rather than dressing a ranking up as a considered reading.
    reason: "En couldn't think this one through tonight. This is simply the highest-ranked title left for your history. Ask again later for a real reason.",
    log_line: "Taken from the shelf, not from thought.",
    fallback: true
  };
}

export function isMemoryExcludedTitle(title, memory) {
  const key = normalizeTitleForCompare(title);
  return Boolean(key && buildExcludedTitleSet(memory).has(key));
}

// Same check, with the excluded set built once - for filtering hundreds of
// candidate titles at a time.
export function createExclusionCheck(memory) {
  const excluded = buildExcludedTitleSet(memory);
  return (title) => {
    const key = normalizeTitleForCompare(title);
    return Boolean(key && excluded.has(key));
  };
}

export function buildExcludedTitlesFromMemory(memory) {
  return uniqueTitles([
    ...memory.recommended,
    ...memory.completed,
    ...memory.rejected,
    ...memory.watchlisted,
    ...memory.pending,
    ...(memory.in_progress || [])
  ]);
}

// Titles a reason must not cite as taste evidence because the user hasn't
// watched them: their current plan-to-watch list and En picks saved for
// later. Built fresh from the live list on every request. The persisted
// memory never drops a title, so a show that was plan-to-watch months ago and
// has since been finished (often a favorite) used to stay "unwatched" forever,
// and every reason that named it was rejected.
export function buildUnwatchedTitles({ malList, history = [] }) {
  const watchedKeys = new Set();
  const unwatched = [];

  for (const entry of Array.isArray(malList) ? malList : []) {
    const titles = extractMalTitles(entry);
    if (entry.my_list_status?.status === "plan_to_watch") {
      unwatched.push(...titles);
    } else {
      titles.forEach((title) => watchedKeys.add(normalizeTitleForCompare(title)));
    }
  }

  for (const entry of history) {
    const titles = [entry.recommendation?.title, entry.recommendation?.title_jp].filter(Boolean);
    if (entry.state === "pending") {
      unwatched.push(...titles);
    } else if (entry.feedback === "good" || entry.feedback === "meh") {
      titles.forEach((title) => watchedKeys.add(normalizeTitleForCompare(title)));
    }
  }

  return uniqueTitles(unwatched).filter((title) => !watchedKeys.has(normalizeTitleForCompare(title)));
}

// Comparing with spaces stripped made short titles and synonyms ("K", "DB")
// match inside almost any sentence, which rejected otherwise valid
// recommendations. Titles now have to appear as whole words.
export function findBlockedEvidenceTitle(text, unwatchedTitles = []) {
  return uniqueTitles(unwatchedTitles).find((title) => mentionsTitle(text, title)) || "";
}

function mentionsTitle(text, title) {
  const needle = toSearchText(title);
  if (needle.replace(/ /g, "").length < 4) return false;

  if (needle.includes(" ") || /[^a-z0-9]/.test(needle)) {
    return ` ${toSearchText(text)} `.includes(` ${needle} `);
  }

  // A one-word title ("Another", "Monster") is usually also an ordinary word,
  // so only a capitalized use in the middle of a sentence counts as citing it.
  const cited = needle[0].toUpperCase() + needle.slice(1);
  return String(text || "")
    .split(/[.!?]+/)
    .some((sentence) => sentence.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(1).includes(cited));
}

function toSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, " ")
    .trim();
}

function normalizeMemory(memory = {}) {
  return MEMORY_BUCKETS.reduce((next, bucket) => {
    next[bucket] = uniqueTitles(Array.isArray(memory?.[bucket]) ? memory[bucket] : []);
    return next;
  }, {});
}

function extractMalTitles(entry) {
  const alternatives = entry.alternative_titles || {};
  return [
    entry.title,
    alternatives.en,
    alternatives.ja,
    ...(alternatives.synonyms || [])
  ].filter(Boolean);
}

function buildExcludedTitleSet(memory) {
  return new Set(
    buildExcludedTitlesFromMemory(normalizeMemory(memory)).map(normalizeTitleForCompare)
  );
}

function isExcludedAnime(anime, excluded) {
  return [
    anime.title,
    anime.title_jp
  ].some((title) => excluded.has(normalizeTitleForCompare(title)));
}

function scoreAnime(anime, tasteProfile = {}, recentPatterns = {}, moodTokens = []) {
  const genres = anime.genres || [];
  const themes = anime.themes || [];
  const favoriteGenres = tasteProfile.favoriteGenres || [];
  const emotionalThemes = tasteProfile.emotionalThemes || [];
  const recentGenres = recentPatterns.recentGenres || [];
  const recentThemes = recentPatterns.recentThemes || [];
  const dislikedTropes = tasteProfile.dislikedTropes || [];

  let score = 0;
  score += overlapScore(genres, favoriteGenres) * 5;
  score += overlapScore(themes, emotionalThemes) * 4;
  score += overlapScore(genres, recentGenres) * 2;
  score += overlapScore(themes, recentThemes) * 2;
  score += overlapScore([...genres, ...themes, anime.genre], moodTokens) * 6;
  score += pacingScore(anime.pacing, tasteProfile.pacingPreference);
  score += darknessScore(anime.darkness, tasteProfile.darknessTolerance);
  score += collaborativeSignal(anime);
  score -= overlapScore([...genres, ...themes, anime.genre], dislikedTropes) * 5;
  return score;
}

function overlapScore(values, targets) {
  const valueKeys = new Set(values.flatMap((value) => tokenize(value)));
  return targets.reduce((score, target) => {
    const targetTokens = tokenize(target);
    return score + targetTokens.filter((token) => valueKeys.has(token)).length;
  }, 0);
}

function pacingScore(pacing, preference) {
  if (!preference) return 0;
  if (pacing === preference) return 4;
  if ((pacing === "steady" && preference === "slow") || (pacing === "slow" && preference === "steady")) return 2;
  if ((pacing === "brisk" && preference === "fast") || (pacing === "fast" && preference === "brisk")) return 2;
  return 0;
}

function darknessScore(darkness, tolerance = 3) {
  if (!Number.isFinite(darkness)) return 0;
  const distance = Math.abs(darkness - tolerance);
  return Math.max(0, 4 - distance);
}

function collaborativeSignal(anime) {
  return (anime.psychological || 0) * 0.25 + (anime.comfort || 0) * 0.2 + (anime.action || 0) * 0.1;
}

function toCandidate(anime) {
  return {
    title: anime.title,
    title_jp: anime.title_jp || anime.title,
    year: anime.year,
    episodes: anime.episodes,
    genre: anime.genre,
    genres: anime.genres || [],
    themes: anime.themes || [],
    pacing: anime.pacing,
    darkness: anime.darkness,
    franchise: anime.franchise,
    rankScore: Math.round(anime.rankScore * 100) / 100
  };
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !TOKEN_STOPWORDS.has(token))
    .map((token) => TOKEN_ALIASES[token] || token);
}

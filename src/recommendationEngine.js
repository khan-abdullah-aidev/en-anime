import { ANIME_CATALOG } from "./animeCatalog.js";
import { normalizeTitleForCompare, titleMatchesAnime, uniqueTitles } from "./titleUtils.js";

const MEMORY_BUCKETS = ["recommended", "completed", "rejected", "watchlisted", "pending"];
const DEFAULT_CANDIDATE_LIMIT = 60;

export function buildRecommendationMemory({ malList, history = [], existingMemory = null }) {
  const memory = normalizeMemory(existingMemory);

  for (const entry of Array.isArray(malList) ? malList : []) {
    const status = entry.my_list_status?.status;
    const titles = extractMalTitles(entry);
    if (status === "completed") {
      memory.completed = uniqueTitles([...memory.completed, ...titles]);
    } else if (status === "dropped") {
      memory.rejected = uniqueTitles([...memory.rejected, ...titles]);
    } else if (status === "plan_to_watch") {
      memory.watchlisted = uniqueTitles([...memory.watchlisted, ...titles]);
    }
  }

  if (typeof malList === "string") {
    memory.completed = uniqueTitles([...memory.completed, ...extractManualTitles(malList)]);
  }

  for (const entry of history) {
    const titles = [entry.recommendation?.title, entry.recommendation?.title_jp].filter(Boolean);
    memory.recommended = uniqueTitles([...memory.recommended, ...titles]);
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
    reason: "This is the closest clean match left after your history and feedback were filtered out. It fits the mood without repeating a title En already gave you.",
    log_line: "The list got smaller. This one stayed."
  };
}

export function isMemoryExcludedTitle(title, memory) {
  const key = normalizeTitleForCompare(title);
  return Boolean(key && buildExcludedTitleSet(memory).has(key));
}

export function buildExcludedTitlesFromMemory(memory) {
  return uniqueTitles([
    ...memory.recommended,
    ...memory.completed,
    ...memory.rejected,
    ...memory.pending
  ]);
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

function extractManualTitles(value) {
  return value
    .split(/[\n,;]+/)
    .map((title) => title.trim())
    .filter(Boolean)
    .slice(0, 300);
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
    .filter(Boolean);
}

import { ANIME_CATALOG } from "./animeCatalog.js";
import { animeTitleKeys, normalizeTitleForCompare, parseManualTitles, uniqueTitles } from "./titleUtils.js";

// Genre affinity is the mean of (score - user's average) across every list
// entry tagged with that genre, shrunk toward zero by this many phantom
// neutral entries so one lucky title can't dominate.
const GENRE_PRIOR = 3;
const DROPPED_SIGNAL = -3;
const UNSCORED_COMPLETED_SIGNAL = 0.5;
const MIN_AFFINITY_ENTRIES = 5;
// MAL labels that say how a show was received, not what it is.
const NON_TASTE_LABELS = new Set(["awardwinning"]);

const DEFAULT_PROFILE = {
  favoriteGenres: [],
  emotionalThemes: [],
  dislikedTropes: [],
  recentEmotionalShifts: [],
  rewatchBehavior: "unknown",
  scoreTendencies: {
    averageScore: null,
    highScoreThreshold: 8,
    lowScoreThreshold: 5,
    generousScorer: false
  },
  updatedAt: ""
};

const TROPE_HINTS = [
  ["isekai", ["isekai", "another world", "overpowered"]],
  ["harem", ["harem"]],
  ["grim violence", ["too dark", "violent", "gore", "brutal"]],
  ["slow burn", ["too slow", "boring", "dragged"]],
  ["school comedy", ["school", "comedy"]]
];

export function buildTasteProfile({ malList, feedbackHistory = [], previousProfile = null }) {
  const entries = Array.isArray(malList) ? malList : [];
  const watchedEntries = entries.filter(isWatchedTasteEntry);
  const catalogByTitle = buildCatalogIndex();
  const scoredEntries = watchedEntries.filter((entry) => Number(entry.my_list_status?.score) > 0);
  const averageScore = scoredEntries.length
    ? round(scoredEntries.reduce((sum, entry) => sum + Number(entry.my_list_status.score), 0) / scoredEntries.length)
    : previousProfile?.scoreTendencies?.averageScore || null;

  const likedEntries = watchedEntries.filter((entry) => Number(entry.my_list_status?.score) >= 8);
  const dislikedEntries = watchedEntries.filter((entry) => {
    const status = entry.my_list_status?.status;
    const score = Number(entry.my_list_status?.score || 0);
    return status === "dropped" || (score > 0 && score <= 5);
  });
  const recentEntries = [...watchedEntries]
    .sort((a, b) => getMalUpdatedTime(b) - getMalUpdatedTime(a))
    .slice(0, 15);

  const manualCatalog = typeof malList === "string"
    ? parseManualTitles(malList).map((title) => findCatalogAnime({ title }, catalogByTitle)).filter(Boolean)
    : [];
  const positiveCatalog = [
    ...likedEntries.map((entry) => findCatalogAnime(entry, catalogByTitle)).filter(Boolean),
    ...manualCatalog,
    ...feedbackHistory
      .filter((entry) => entry.feedback === "good" || entry.state === "pending" || entry.state === "watching")
      .map((entry) => findCatalogAnime(entry.recommendation, catalogByTitle))
      .filter(Boolean)
  ];
  const negativeCatalog = [
    ...dislikedEntries.map((entry) => findCatalogAnime(entry, catalogByTitle)).filter(Boolean),
    ...feedbackHistory
      .filter((entry) => entry.feedback === "meh")
      .map((entry) => findCatalogAnime(entry.recommendation, catalogByTitle))
      .filter(Boolean)
  ];

  const feedbackText = feedbackHistory
    .map((entry) => `${entry.feedback || entry.state || ""} ${entry.feedback_note || ""} ${entry.note || ""}`)
    .join(" ")
    .toLowerCase();

  const genreAffinity = inferGenreAffinity(watchedEntries, averageScore);
  const favoriteGenres = uniqueTitles([
    ...genreAffinity.favorites,
    ...topValues(countValues(positiveCatalog.flatMap((anime) => anime.genres)), 8)
  ]).slice(0, 8);

  return {
    favoriteGenres,
    emotionalThemes: topValues(countValues(positiveCatalog.flatMap((anime) => anime.themes)), 10),
    dislikedTropes: inferDislikedTropes({
      negativeCatalog,
      feedbackText,
      previousProfile,
      genreAffinity,
      favoriteGenres
    }),
    recentEmotionalShifts: inferRecentEmotionalShifts(recentEntries, catalogByTitle),
    rewatchBehavior: inferRewatchBehavior(watchedEntries, previousProfile),
    scoreTendencies: {
      averageScore,
      highScoreThreshold: averageScore && averageScore >= 8 ? 9 : 8,
      lowScoreThreshold: averageScore && averageScore <= 6 ? 4 : 5,
      generousScorer: Boolean(averageScore && averageScore >= 7.8)
    },
    updatedAt: new Date().toISOString()
  };
}

export function summarizeRecentPatterns(malList, feedbackHistory = []) {
  const entries = Array.isArray(malList) ? malList.filter(isWatchedTasteEntry) : [];
  const catalogByTitle = buildCatalogIndex();
  const recentEntries = [...entries]
    .sort((a, b) => getMalUpdatedTime(b) - getMalUpdatedTime(a))
    .slice(0, 12);
  const recentCatalog = recentEntries
    .map((entry) => findCatalogAnime(entry, catalogByTitle))
    .filter(Boolean);
  const pendingCount = feedbackHistory.filter((entry) => entry.state === "pending").length;
  const mehTitles = feedbackHistory
    .filter((entry) => entry.feedback === "meh")
    .slice(0, 5)
    .map((entry) => entry.recommendation?.title)
    .filter(Boolean);

  return {
    recentGenres: uniqueTitles([
      ...topValues(countValues(recentEntries.flatMap((entry) => entry.genres || [])), 6),
      ...topValues(countValues(recentCatalog.flatMap((anime) => anime.genres)), 6)
    ]).slice(0, 6),
    recentThemes: topValues(countValues(recentCatalog.flatMap((anime) => anime.themes)), 8),
    pendingCount,
    recentRejections: mehTitles
  };
}

// The evidence behind each genre, for "What En knows about you": how many of
// the user's shows carry it, how they score those against their own average,
// and how many they dropped. Keyed by normalized genre name.
export function describeGenreAffinity(malList) {
  const entries = Array.isArray(malList) ? malList.filter(isWatchedTasteEntry) : [];
  const scored = entries.filter((entry) => Number(entry.my_list_status?.score) > 0);
  const averageScore = scored.length
    ? scored.reduce((sum, entry) => sum + Number(entry.my_list_status.score), 0) / scored.length
    : null;

  const stats = {};
  for (const entry of entries) {
    const score = Number(entry.my_list_status?.score || 0);
    for (const genre of entry.genres || []) {
      const key = normalizeTitleForCompare(genre);
      if (!key || NON_TASTE_LABELS.has(key)) continue;
      const stat = (stats[key] ||= { label: genre, count: 0, dropped: 0, scored: 0, deltaTotal: 0 });
      stat.count += 1;
      if (entry.my_list_status?.status === "dropped") stat.dropped += 1;
      if (score > 0 && averageScore !== null) {
        stat.scored += 1;
        stat.deltaTotal += score - averageScore;
      }
    }
  }

  return Object.fromEntries(
    Object.entries(stats).map(([key, stat]) => [
      key,
      { label: stat.label, count: stat.count, dropped: stat.dropped, scoreDelta: stat.scored ? round(stat.deltaTotal / stat.scored) : null }
    ])
  );
}

function isWatchedTasteEntry(entry) {
  const status = entry?.my_list_status?.status;
  return status !== "plan_to_watch" && status !== "watching";
}

// Unrated entries are picks the user hasn't answered about yet, and "not
// tonight" says nothing about the show - neither is a taste signal.
export function compactFeedbackHistory(history = [], limit = 12) {
  return history
    .filter((entry) => entry.state !== "unrated" && entry.state !== "not_tonight")
    .slice(0, limit)
    .map((entry) => ({
    title: entry.recommendation?.title || "",
    feedback: entry.feedback || entry.state || "",
    note: entry.feedback_note || entry.note || "",
    mood: entry.mood || ""
  }));
}

function buildCatalogIndex() {
  const index = new Map();
  for (const anime of ANIME_CATALOG) {
    for (const key of animeTitleKeys(anime)) {
      index.set(key, anime);
    }
  }
  return index;
}

function findCatalogAnime(entry, index) {
  for (const key of animeTitleKeys(entry)) {
    if (index.has(key)) return index.get(key);
  }
  return null;
}

function inferGenreAffinity(entries, averageScore) {
  const stats = new Map();
  let signalCount = 0;

  for (const entry of entries) {
    const signal = entryTasteSignal(entry, averageScore);
    if (signal === null) continue;
    signalCount += 1;

    for (const genre of entry.genres || []) {
      const key = normalizeTitleForCompare(genre);
      if (!key || NON_TASTE_LABELS.has(key)) continue;
      const current = stats.get(key) || { label: genre, count: 0, total: 0 };
      current.count += 1;
      current.total += signal;
      stats.set(key, current);
    }
  }

  const ranked = [...stats.values()].map((stat) => ({
    ...stat,
    affinity: stat.total / (stat.count + GENRE_PRIOR)
  }));

  return {
    hasSignal: signalCount >= MIN_AFFINITY_ENTRIES,
    // A genre needs a real share of the list to count: two entries means
    // something on a 12-show list and nothing on a 400-show one.
    favorites: ranked
      .filter((stat) => stat.count >= Math.max(2, Math.round(signalCount * 0.03)) && stat.affinity > 0)
      .sort((a, b) => b.affinity - a.affinity || b.count - a.count)
      .slice(0, 8)
      .map((stat) => stat.label),
    disliked: ranked
      .filter((stat) => stat.count >= Math.max(3, Math.round(signalCount * 0.03)) && stat.affinity <= -0.75)
      .sort((a, b) => a.affinity - b.affinity)
      .slice(0, 4)
      .map((stat) => stat.label)
  };
}

function entryTasteSignal(entry, averageScore) {
  const status = entry.my_list_status?.status;
  const score = Number(entry.my_list_status?.score || 0);
  if (status === "dropped") return DROPPED_SIGNAL;
  if (score > 0) return score - (averageScore || 7);
  if (status === "completed") return UNSCORED_COMPLETED_SIGNAL;
  return null;
}

function inferDislikedTropes({ negativeCatalog, feedbackText, previousProfile, genreAffinity, favoriteGenres }) {
  const textSignals = TROPE_HINTS
    .filter(([, hints]) => hints.some((hint) => feedbackText.includes(hint)))
    .map(([trope]) => trope);
  const favoriteKeys = new Set(favoriteGenres.map(normalizeTitleForCompare));

  // With enough scored MAL history, the whole-list genre affinity is far better
  // grounded than genres borrowed from the few catalog titles the user dropped.
  const listSignals = genreAffinity.hasSignal
    ? genreAffinity.disliked
    : [
        ...topValues(countValues([
          ...negativeCatalog.flatMap((anime) => anime.genres || []),
          ...negativeCatalog.flatMap((anime) => anime.themes || [])
        ]), 5),
        ...(previousProfile?.dislikedTropes || [])
      ];

  return uniqueTitles([...textSignals, ...listSignals])
    .filter((trope) => !favoriteKeys.has(normalizeTitleForCompare(trope)))
    .slice(0, 8);
}

function inferRecentEmotionalShifts(recentEntries, catalogByTitle) {
  const themes = recentEntries
    .map((entry) => findCatalogAnime(entry, catalogByTitle))
    .filter(Boolean)
    .flatMap((anime) => anime.themes || []);
  return topValues(countValues(themes), 6);
}

function inferRewatchBehavior(entries, previousProfile) {
  const totalRewatches = entries.reduce(
    (sum, entry) => sum + Number(entry.my_list_status?.num_times_rewatched || 0),
    0
  );
  if (totalRewatches >= 5) return "frequent";
  if (totalRewatches > 0) return "occasional";
  return previousProfile?.rewatchBehavior || DEFAULT_PROFILE.rewatchBehavior;
}

function countValues(values) {
  return values.filter(Boolean).reduce((counts, value) => {
    const key = normalizeTitleForCompare(value);
    counts.set(key, {
      label: value,
      count: (counts.get(key)?.count || 0) + 1
    });
    return counts;
  }, new Map());
}

function topValues(counts, limit) {
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((entry) => entry.label);
}

function getMalUpdatedTime(entry) {
  return Date.parse(
    entry?.last_updated ||
      entry?.updated_at ||
      entry?.my_list_status?.updated_at ||
      ""
  ) || 0;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

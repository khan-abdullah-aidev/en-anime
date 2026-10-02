import { normalizeTitleForCompare } from "./titleUtils.js";

// En learning from its own picks. Every pick keeps what it was (features:
// genres, tags, length, era, how mainstream, where in the pool it came from,
// which favorite led to it, what tonight's mood asked for). Every answer is
// evidence about those traits: "good" for, "meh" against, a pass mildly
// against. Tallied per trait with a few phantom neutral answers, so one pick
// never decides anything, and older answers fade. The tally then ranks the
// next pool (more as evidence grows; see LEARNED_POINTS in discovery.js) and
// tells the model what has landed for this person and what hasn't.
const DAY = 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 180;
const PRIOR = 2;
// Answered picks at which what En learned counts in full.
const FULL_CONFIDENCE_AT = 25;
// How much each kind of trait counts in a candidate's fit.
const TYPE_WEIGHTS = { g: 1, t: 0.8, seed: 1, mood: 0.7, len: 0.5, pop: 0.4, src: 0.4, era: 0.3 };
const SOURCE_LABELS = {
  similar: "picks from fans of your favorites",
  genre: "top shows in your genres",
  mood: "picks matched to the mood",
  recent: "recent releases"
};
const LENGTH_LABELS = { film: "films", short: "short series (13 or fewer)", medium: "one- or two-cour series", long: "long series (27+)" };
const POPULARITY_LABELS = { mainstream: "the big, popular shows", known: "well-known shows", niche: "lesser-known shows" };
const ERA_LABELS = { older: "shows from before 2000", "2000s": "2000s shows", "2010s": "2010s shows", "2020s": "2020s shows" };

// What a pick was, saved on its log entry when it's shown.
export function featuresOf(candidate) {
  const tags = candidate.tags?.length ? candidate.tags : candidate.themes || [];
  return compact({
    g: (candidate.genres || []).slice(0, 6),
    t: tags.slice(0, 6),
    len: lengthOf(candidate),
    era: eraOf(candidate.year),
    pop: popularityOf(candidate.popularity),
    src: [...(candidate.sources || [])].filter((source) => SOURCE_LABELS[source]).slice(0, 4),
    seed: candidate.because?.[0] || null,
    mood: candidate.moodTerms?.length ? candidate.moodTerms.slice(0, 6) : null
  });
}

// Picks from before En kept features: what the pick itself still says.
export function featuresForEntry(entry) {
  // New picks carry it on the pick itself; past ones get it from learningBackfill.js.
  if (entry.features) return entry.features;
  if (entry.recommendation?.features) return entry.recommendation.features;
  const rec = entry.recommendation || {};
  const genres = String(rec.genre || "").split(",").map((genre) => genre.trim()).filter(Boolean);
  if (!genres.length && !rec.episodes && !rec.year) return null;
  return compact({ g: genres, len: lengthOf(rec), era: eraOf(rec.year) });
}

// How an answer counts: y is for (+1) or against (-1), w how much.
// "Not tonight" with a reason is about tonight, not the show, so it only
// teaches what doesn't suit a given mood.
export function outcomeOf(entry) {
  if (entry.state === "rated") {
    const y = entry.feedback === "good" ? 1 : entry.feedback === "meh" ? -1 : 0;
    if (!y) return null;
    const delta = Number(entry.score_delta);
    const strength = Number.isFinite(delta) ? 1 + Math.min(1, Math.abs(delta) / 3) : 1;
    // Something they'd already seen says less about En's judgment.
    return { y, w: strength * (entry.seen_before ? 0.7 : 1), answered: true };
  }
  if (entry.state === "skipped") return { y: -1, w: 0.4, answered: true };
  if (entry.state === "not_tonight") return entry.pass_reason ? { y: -1, w: 0.5, moodOnly: true } : { y: -1, w: 0.2 };
  if (entry.state === "watching") return { y: 1, w: 0.3 };
  if (entry.state === "pending") return { y: 1, w: 0.15 };
  if (entry.state === "unrated" && entry.watch_tonight) return { y: 1, w: 0.15 };
  return null;
}

export function buildTasteModel(history = [], { now = Date.now(), ignored = [] } = {}) {
  const ignoredKeys = new Set(ignored);
  const stats = new Map();
  let answered = 0;
  let totalWeight = 0;
  let totalFor = 0;
  for (const entry of history) {
    const outcome = outcomeOf(entry);
    const features = outcome && featuresForEntry(entry);
    if (!features) continue;
    if (outcome.answered) answered += 1;
    // Fades by when the pick was made (updated_at moves with any edit).
    const age = Math.max(0, now - (Date.parse(entry.date || "") || now)) / DAY;
    const weight = outcome.w * 0.5 ** (age / HALF_LIFE_DAYS);
    if (!outcome.moodOnly) {
      totalWeight += weight;
      totalFor += weight * outcome.y;
    }
    for (const { key, label, type } of featureKeys(features)) {
      if (ignoredKeys.has(key) || (outcome.moodOnly && type !== "mood")) continue;
      const stat = stats.get(key) || { key, label, type, n: 0, sum: 0, hits: 0, misses: 0 };
      stat.n += weight;
      stat.sum += weight * outcome.y;
      if (outcome.answered) {
        if (outcome.y > 0) stat.hits += 1;
        else stat.misses += 1;
      }
      stats.set(key, stat);
    }
  }
  // How picks go for this person in general. A trait is judged against this,
  // not against zero: one that lands as often as everything else says
  // nothing, which keeps traits every pick shares (length, era) neutral.
  const base = totalFor / (totalWeight + PRIOR);
  return { stats, answered, base, confidence: Math.min(1, answered / FULL_CONFIDENCE_AT) };
}

// A trait's pull, from -1 to 1: how much better or worse than usual its
// picks have gone, shrunk toward nothing while there are few of them.
function lift(stat, base = 0) {
  return (stat.sum - stat.n * base) / (stat.n + PRIOR);
}

// How well a candidate matches what has landed before, from -1 to 1: the
// weighted mean of its traits' tallies. A trait En has never seen counts as
// neutral, so something untried ranks above something that keeps missing
// (that's how it finds what works, instead of circling what doesn't).
export function learnedFit(model, candidate, moodWanted = null) {
  if (!model?.stats?.size) return { fit: 0, evidence: 0 };
  const features = featuresOf({ ...candidate, moodTerms: moodWanted ? [...moodWanted.genres, ...moodWanted.tags] : candidate.moodTerms });
  const byType = {};
  let evidence = 0;
  for (const { key, type } of featureKeys(features)) {
    const stat = model.stats.get(key);
    if (stat) evidence += stat.n;
    (byType[type] ||= []).push(stat ? lift(stat, model.base) : 0);
  }
  let total = 0;
  let weights = 0;
  for (const [type, values] of Object.entries(byType)) {
    total += TYPE_WEIGHTS[type] * (values.reduce((sum, value) => sum + value, 0) / values.length);
    weights += TYPE_WEIGHTS[type];
  }
  return { fit: weights ? total / weights : 0, evidence };
}

// For the model: a word for a candidate's fit, only once there's enough to say.
export function pastFitLabel(fit, evidence) {
  if (!Number.isFinite(fit) || evidence < 1.5) return null;
  if (fit >= 0.3) return "strong";
  if (fit >= 0.1) return "good";
  if (fit <= -0.3) return "poor";
  if (fit <= -0.1) return "weak";
  return "mixed";
}

// The traits behind hits and misses, best evidenced first.
export function describeModel(model, { limit = 6 } = {}) {
  const solid = [...(model?.stats?.values() || [])].filter((stat) => stat.hits + stat.misses >= 2);
  const affinity = (stat) => lift(stat, model?.base);
  const row = (stat) => ({ key: stat.key, label: stat.label, type: stat.type, hits: stat.hits, misses: stat.misses, affinity: Math.round(affinity(stat) * 100) / 100 });
  return {
    landed: solid.filter((stat) => affinity(stat) >= 0.2 && stat.hits > stat.misses).sort((a, b) => affinity(b) - affinity(a) || b.hits - a.hits).slice(0, limit).map(row),
    missed: solid.filter((stat) => affinity(stat) <= -0.2 && stat.misses > stat.hits).sort((a, b) => affinity(a) - affinity(b) || b.misses - a.misses).slice(0, limit).map(row)
  };
}

// What goes to the model as "learned", once there are a few answers.
export function learnedForModel(model, history = []) {
  if (!model || model.answered < 3) return null;
  const { landed, missed } = describeModel(model, { limit: 8 });
  const rate = hitRate(history);
  const tally = (row, word) => `${row.label} (${word === "landed" ? row.hits : row.misses} of ${row.hits + row.misses} ${word === "landed" ? "landed" : "missed"})`;
  return compact({
    answeredPicks: model.answered,
    recentHitRate: rate.recent.length ? `${rate.recent.filter((pick) => pick.hit).length} of the last ${rate.recent.length}` : null,
    landed: landed.length ? landed.map((row) => tally(row, "landed")) : null,
    missed: missed.length ? missed.map((row) => tally(row, "missed")) : null
  });
}

// Hits and misses in the order they happened: "good" is a hit; "meh" and
// passing on it are misses. ("Not tonight" is about the night, not a miss.)
export function hitRate(history = [], { window = 10 } = {}) {
  const answered = history
    .filter((entry) => (entry.state === "rated" && (entry.feedback === "good" || entry.feedback === "meh")) || entry.state === "skipped")
    .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0))
    .map((entry) => ({ id: entry.id, title: entry.recommendation?.title || "", hit: entry.feedback === "good", date: entry.date }));
  return { all: answered, first: answered.slice(0, window), recent: answered.slice(-window) };
}

function featureKeys(features) {
  const keys = [];
  const add = (type, value, label) => {
    const norm = normalizeTitleForCompare(value);
    if (norm) keys.push({ key: `${type}:${norm}`, label, type });
  };
  (features.g || []).forEach((genre) => add("g", genre, genre));
  (features.t || []).forEach((tag) => add("t", tag, tag));
  if (features.len) add("len", features.len, LENGTH_LABELS[features.len] || features.len);
  if (features.era) add("era", features.era, ERA_LABELS[features.era] || features.era);
  if (features.pop) add("pop", features.pop, POPULARITY_LABELS[features.pop] || features.pop);
  (features.src || []).forEach((source) => add("src", source, SOURCE_LABELS[source] || source));
  if (features.seed) add("seed", features.seed, `picks that came through ${features.seed}`);
  // What works when they ask for something in particular: each of tonight's
  // mood terms paired with the pick's genres and top tags.
  const traits = [...(features.g || []).slice(0, 3), ...(features.t || []).slice(0, 3)];
  for (const term of (features.mood || []).slice(0, 3)) {
    for (const trait of traits) {
      const pair = `${normalizeTitleForCompare(term)}>${normalizeTitleForCompare(trait)}`;
      keys.push({ key: `mood:${pair}`, label: `${trait} when the mood asks for ${term}`, type: "mood" });
    }
  }
  return keys;
}

function lengthOf(item) {
  const episodes = Number(item.episodes) || 0;
  if (item.format === "MOVIE" || episodes === 1) return "film";
  if (!episodes) return null;
  return episodes <= 13 ? "short" : episodes <= 26 ? "medium" : "long";
}

function eraOf(year) {
  const value = Number(year);
  if (!value) return null;
  if (value < 2000) return "older";
  return value < 2010 ? "2000s" : value < 2020 ? "2010s" : "2020s";
}

function popularityOf(popularity) {
  const value = Number(popularity);
  if (!value) return null;
  return value > 150000 ? "mainstream" : value > 30000 ? "known" : "niche";
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && !value.length))
  );
}

// How many ranking points a perfect fit is worth once En has learned in full
// (for scale, in rankPool a favorite's top recommendation is worth about 3-9
// and each mood match 2.5). Below FULL_CONFIDENCE_AT answers it counts for
// proportionally less, so a handful of answers can't take over the pool.
export const LEARNED_POINTS = 12;

export function learnedRanker(model) {
  if (!model?.stats?.size || !model.answered) return null;
  return { weight: LEARNED_POINTS * model.confidence, fit: (candidate, moodWanted) => learnedFit(model, candidate, moodWanted) };
}

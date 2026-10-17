import { featuresForEntry } from "./learning.js";

// Weekend nights and weeknights can want different things: a long series on
// a Saturday, something short after work. From how En's picks landed on
// each, what tends to work on tonight's kind of night. Null until there are
// at least three answered picks of each kind and they really differ.

const MIN_EACH = 3;
const LENGTH_WORDS = { film: "films", short: "short shows (up to 13 episodes)", medium: "one-to-two-cour shows", long: "long series" };

// Friday and Saturday nights; anything before 5am counts as the night before.
export function nightKind(date) {
  const at = new Date(date);
  if (at.getHours() < 5) at.setDate(at.getDate() - 1);
  return at.getDay() === 5 || at.getDay() === 6 ? "weekend" : "weeknight";
}

export function dayPattern(history = [], now = new Date()) {
  const answered = history.filter((entry) => entry.state === "rated" && (entry.feedback === "good" || entry.feedback === "meh"));
  const groups = { weekend: summarize(answered.filter((entry) => nightKind(entry.date) === "weekend")), weeknight: summarize(answered.filter((entry) => nightKind(entry.date) === "weeknight")) };
  if (groups.weekend.answered < MIN_EACH || groups.weeknight.answered < MIN_EACH) return null;

  const differs =
    Math.abs(groups.weekend.landedPercent - groups.weeknight.landedPercent) >= 25 ||
    (groups.weekend.landedLength && groups.weeknight.landedLength && groups.weekend.landedLength !== groups.weeknight.landedLength) ||
    (groups.weekend.landedGenres[0] && groups.weeknight.landedGenres[0] && groups.weekend.landedGenres[0] !== groups.weeknight.landedGenres[0]);
  if (!differs) return null;

  return {
    tonight: nightKind(now) === "weekend" ? "a weekend night" : "a weeknight",
    weekendNights: describe(groups.weekend),
    weeknights: describe(groups.weeknight)
  };
}

function summarize(entries) {
  const good = entries.filter((entry) => entry.feedback === "good");
  const lengths = new Map();
  const genres = new Map();
  for (const entry of good) {
    const features = featuresForEntry(entry) || {};
    if (features.len) lengths.set(features.len, (lengths.get(features.len) || 0) + 1);
    for (const genre of features.g || []) genres.set(genre, (genres.get(genre) || 0) + 1);
  }
  const top = (map) => [...map].sort((a, b) => b[1] - a[1]).filter(([, count]) => count >= 2).map(([key]) => key);
  return {
    answered: entries.length,
    landedPercent: entries.length ? Math.round((good.length / entries.length) * 100) : 0,
    landedLength: top(lengths)[0] || null,
    landedGenres: top(genres).slice(0, 3)
  };
}

function describe(group) {
  return {
    answered: group.answered,
    landed: `${group.landedPercent}%`,
    ...(group.landedLength ? { whatLanded: LENGTH_WORDS[group.landedLength] } : {}),
    ...(group.landedGenres.length ? { genresThatLanded: group.landedGenres } : {})
  };
}

// The month in En's log: how many picks, how many were watched and landed,
// what kind of thing they were, and the moods behind them. Shown at the top
// of the log and shareable as a few lines of text.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// This month's recap, or last month's while this one has nothing in it yet.
export function monthRecap(history = [], now = new Date()) {
  const current = recapFor(history, now.getFullYear(), now.getMonth(), now);
  if (current.picks) return current;
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previous = recapFor(history, last.getFullYear(), last.getMonth(), now);
  return previous.picks ? previous : null;
}

export function recapFor(history, year, month, now = new Date()) {
  const inMonth = history.filter((entry) => {
    const date = new Date(entry.date);
    return date.getFullYear() === year && date.getMonth() === month;
  });
  const good = inMonth.filter((entry) => entry.state === "rated" && entry.feedback === "good");
  const meh = inMonth.filter((entry) => entry.state === "rated" && entry.feedback === "meh");
  const watching = inMonth.filter((entry) => entry.state === "watching");
  const genres = new Map();
  for (const entry of inMonth) {
    for (const genre of String(entry.recommendation?.genre || "").split(",").map((item) => item.trim()).filter(Boolean)) {
      genres.set(genre, (genres.get(genre) || 0) + 1);
    }
  }
  const moods = [...new Set(
    inMonth
      .map((entry) => String(entry.request_mood || "").trim().toLowerCase())
      .filter((mood) => mood && mood.length <= 40)
  )].slice(0, 3);
  return {
    label: `${MONTHS[month]}${year === now.getFullYear() && month === now.getMonth() ? " so far" : ""}`,
    picks: inMonth.length,
    watched: good.length + meh.length + watching.length,
    loved: good.length,
    hitRate: good.length + meh.length ? Math.round((good.length / (good.length + meh.length)) * 100) : null,
    topGenres: [...genres].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([genre]) => genre),
    favorite: good[0]?.recommendation?.title || null,
    moods
  };
}

// The recap as a few lines to send someone.
export function recapText(recap) {
  if (!recap) return "";
  const lines = [
    `My month with En · ${recap.label}`,
    `${recap.picks} pick${recap.picks === 1 ? "" : "s"}, ${recap.watched} watched, ${recap.loved} loved.`
  ];
  if (recap.favorite) lines.push(`Best of it: ${recap.favorite}.`);
  if (recap.topGenres.length) lines.push(`Mostly ${recap.topGenres.join(" and ").toLowerCase()}.`);
  if (recap.moods.length) lines.push(`Moods: ${recap.moods.map((mood) => `"${mood}"`).join(", ")}.`);
  return lines.join("\n");
}

// The last few months, newest first, for "taste over time": only months
// with at least one pick.
export function recentMonths(history = [], now = new Date(), count = 6) {
  const months = [];
  for (let back = 0; back < count; back += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const recap = recapFor(history, date.getFullYear(), date.getMonth(), now);
    if (recap.picks) months.push(recap);
  }
  return months;
}

import { animeTitleKeys, normalizeTitleForCompare, parseManualTitles } from "./titleUtils.js";

// A full MAL list can run to thousands of entries, so the model gets a compact
// digest instead: the latest activity plus the entries that carry the most
// taste signal (favorites, drops, low scores, what's in progress).
const RECENT_LIMIT = 15;
const FAVORITES_LIMIT = 12;
const DROPPED_LIMIT = 10;
const LOW_RATED_LIMIT = 8;
const IN_PROGRESS_LIMIT = 8;
const LOVED_TITLES_LIMIT = 60;
const STATUSES = ["completed", "watching", "on_hold", "dropped", "plan_to_watch"];

export function buildWatchHistoryDigest(list) {
  if (typeof list === "string") {
    return {
      source: "self-described",
      lovedTitles: parseManualTitles(list).slice(0, LOVED_TITLES_LIMIT)
    };
  }

  // mal.js already sorts the list newest-update first.
  const entries = Array.isArray(list) ? list : [];
  const seen = entries.filter((entry) => {
    const status = statusOf(entry);
    return status && status !== "plan_to_watch";
  });
  const scored = seen.filter((entry) => scoreOf(entry) > 0);
  const averageScore = scored.length
    ? Math.round((scored.reduce((sum, entry) => sum + scoreOf(entry), 0) / scored.length) * 10) / 10
    : null;
  const favoriteFloor = Math.max(averageScore || 0, 7);
  const lowCeiling = Math.max(5, (averageScore || 7) - 2);

  const summary = Object.fromEntries(
    STATUSES.map((status) => [status, entries.filter((entry) => statusOf(entry) === status).length])
  );
  summary.averageScore = averageScore;

  return {
    source: "myanimelist",
    summary,
    recent: seen.slice(0, RECENT_LIMIT).map(describeRecent),
    favorites: scored
      .filter((entry) => statusOf(entry) !== "dropped" && scoreOf(entry) >= favoriteFloor)
      .sort((a, b) => scoreOf(b) - scoreOf(a))
      .slice(0, FAVORITES_LIMIT)
      .map((entry) => ({ title: displayTitle(entry), score: scoreOf(entry) })),
    dropped: seen
      .filter((entry) => statusOf(entry) === "dropped")
      .slice(0, DROPPED_LIMIT)
      .map((entry) => compact({
        title: displayTitle(entry),
        progress: progressOf(entry),
        score: scoreOf(entry) || null,
        updated: monthOf(entry)
      })),
    lowRated: scored
      .filter((entry) => statusOf(entry) === "completed" && scoreOf(entry) <= lowCeiling)
      .slice(0, LOW_RATED_LIMIT)
      .map((entry) => ({ title: displayTitle(entry), score: scoreOf(entry) })),
    inProgress: seen
      .filter((entry) => ["watching", "on_hold"].includes(statusOf(entry)))
      .slice(0, IN_PROGRESS_LIMIT)
      .map((entry) => compact({
        title: displayTitle(entry),
        status: statusOf(entry),
        progress: progressOf(entry),
        updated: monthOf(entry)
      }))
  };
}

// What the user's own list (and En's log) already says about a title they
// asked about - e.g. that they dropped it at episode 4 last month.
export function describeQueriedTitle({ asked, resolved, list, history = [] }) {
  const titles = [asked, resolved?.title, resolved?.title_jp, resolved?.title_romaji].filter(Boolean);
  const keys = new Set(titles.map(normalizeTitleForCompare).filter(Boolean));
  const matchesKeys = (anime) => animeTitleKeys(anime).some((key) => keys.has(key));

  let onList = null;
  if (typeof list === "string") {
    const listed = parseManualTitles(list).some((title) => keys.has(normalizeTitleForCompare(title)));
    onList = listed ? { status: "listed as seen and loved" } : null;
  } else if (Array.isArray(list)) {
    const entry =
      (resolved?.malId && list.find((item) => item.id === resolved.malId)) ||
      list.find(matchesKeys);
    onList = entry
      ? compact({
          status: statusOf(entry),
          score: scoreOf(entry) || null,
          progress: progressOf(entry),
          updated: monthOf(entry)
        })
      : null;
  }

  const enEntry = history.find((entry) => entry.recommendation && matchesKeys(entry.recommendation));

  return compact({
    asked,
    identifiedAs: resolved?.title || null,
    onList,
    enHistory: enEntry
      ? compact({ outcome: enEntry.feedback || enEntry.state, note: enEntry.feedback_note || null })
      : null
  });
}

function describeRecent(entry) {
  const status = statusOf(entry);
  return compact({
    title: displayTitle(entry),
    status,
    score: scoreOf(entry) || null,
    progress: status === "completed" ? null : progressOf(entry),
    updated: monthOf(entry)
  });
}

function displayTitle(entry) {
  return entry.alternative_titles?.en || entry.title;
}

function statusOf(entry) {
  return entry?.my_list_status?.status || "";
}

function scoreOf(entry) {
  return Number(entry?.my_list_status?.score) || 0;
}

function progressOf(entry) {
  const watched = Number(entry?.my_list_status?.num_episodes_watched) || 0;
  return `${watched}/${entry?.episodes || "?"}`;
}

function monthOf(entry) {
  return (entry?.my_list_status?.updated_at || entry?.updated_at || "").slice(0, 7) || null;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));
}

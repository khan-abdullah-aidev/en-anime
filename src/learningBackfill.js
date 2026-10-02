import { aniListRequest, resolveAnimeOnAniList } from "./anilist.js";
import { toCandidate } from "./discovery.js";
import { featuresForEntry, featuresOf } from "./learning.js";
import { animeTitleKeys } from "./titleUtils.js";

// Teaching En from the picks it made before it kept what each pick was:
// every past pick is looked up on AniList (in batches of 50 by id; by title
// for the oldest, which have no id) for its genres, tags, length, era and
// popularity. The user's own list adds how they scored the ones they rated
// there. Picks AniList can't find keep what the pick itself says.
const BATCH = 50;
// Title searches per run. AniList allows about 30 requests a minute and En's
// pools need some of those, so the oldest picks are caught up over a few
// visits rather than all at once.
const MAX_LOOKUPS = 12;
const FEATURES_QUERY = `query ($ids: [Int]) { Page(perPage: ${BATCH}) { media(id_in: $ids, type: ANIME) {
  id idMal title { romaji english native } format status episodes popularity averageScore
  startDate { year } genres tags { name rank isMediaSpoiler isGeneralSpoiler }
} } }`;

export function needsBackfill(entry) {
  return Boolean(entry?.recommendation?.title) && !entry.features && !entry.recommendation.features;
}

// Returns Map(entry id -> patch). Never throws: whatever can't be looked up
// now is tried again next time.
export async function backfillPastPicks({ history, list = null, lookups = MAX_LOOKUPS, pause = 250 }) {
  const patches = new Map();
  const patch = (id, fields) => patches.set(id, { ...patches.get(id), ...fields });

  for (const [id, delta] of scoreDeltas(history, list)) patch(id, { score_delta: delta });

  const pending = history.filter(needsBackfill);
  const ids = new Map();
  let searches = 0;
  for (const entry of pending) {
    const rec = entry.recommendation;
    if (rec.anilistId) {
      ids.set(entry.id, { anilistId: rec.anilistId });
      continue;
    }
    if (searches >= lookups) continue;
    searches += 1;
    const resolved = await resolveAnimeOnAniList(rec.title).catch(() => null);
    if (resolved?.anilistId) ids.set(entry.id, { anilistId: resolved.anilistId, malId: resolved.malId || null });
    else patch(entry.id, { features: { ...(featuresForEntry(entry) || {}), partial: true } });
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
  }

  const media = new Map();
  const unique = [...new Set([...ids.values()].map((found) => found.anilistId))];
  for (let i = 0; i < unique.length; i += BATCH) {
    try {
      const data = await aniListRequest(FEATURES_QUERY, { ids: unique.slice(i, i + BATCH) }, { timeoutMs: 12000 });
      for (const item of data?.Page?.media || []) media.set(item.id, item);
    } catch {
      // AniList busy: these picks wait for the next visit.
      for (const id of unique.slice(i, i + BATCH)) media.set(id, undefined);
    }
  }

  for (const entry of pending) {
    const found = ids.get(entry.id);
    if (!found || !media.has(found.anilistId)) continue;
    const item = media.get(found.anilistId);
    if (item === undefined) continue;
    const rec = entry.recommendation;
    const features = item ? featuresOf(toCandidate(item)) : { ...(featuresForEntry(entry) || {}), partial: true };
    const malId = rec.malId || found.malId || item?.idMal || null;
    patch(entry.id, {
      features,
      ...(!rec.anilistId || (!rec.malId && malId) ? { recommendation: { ...rec, anilistId: found.anilistId, ...(malId ? { malId } : {}) } } : {})
    });
  }
  return patches;
}

// How the user scored, on their own list, the picks they answered: a 10 from
// someone who averages 7 says more than "good" alone.
export function scoreDeltas(history, list) {
  const deltas = new Map();
  if (!Array.isArray(list) || !list.length) return deltas;
  const scored = list.filter((item) => Number(item.my_list_status?.score) > 0);
  if (!scored.length) return deltas;
  const average = scored.reduce((sum, item) => sum + Number(item.my_list_status.score), 0) / scored.length;
  const byMal = new Map(scored.filter((item) => item.id).map((item) => [item.id, item]));
  const byAniList = new Map(scored.filter((item) => item.anilistId).map((item) => [item.anilistId, item]));
  const byTitle = new Map();
  for (const item of scored) for (const key of animeTitleKeys(item)) if (!byTitle.has(key)) byTitle.set(key, item);

  for (const entry of history) {
    const known = entry.score_delta !== null && entry.score_delta !== undefined && Number.isFinite(Number(entry.score_delta));
    if (entry.state !== "rated" || known) continue;
    const rec = entry.recommendation || {};
    const match = (rec.malId && byMal.get(rec.malId)) || (rec.anilistId && byAniList.get(rec.anilistId)) || animeTitleKeys(rec).map((key) => byTitle.get(key)).find(Boolean);
    if (match) deltas.set(entry.id, Math.round((Number(match.my_list_status.score) - average) * 10) / 10);
  }
  return deltas;
}

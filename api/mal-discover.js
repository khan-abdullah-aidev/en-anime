import { inBatches, malChart, malDetails, malSeason, toMalCandidate } from "./_lib/malCatalog.js";

const MAX_SEEDS = 10;
const RECS_PER_SEED = 8;

// A season-two-and-later title, from its name alone (chart entries don't
// carry their relations). Treated as a sequel of something unwatched, so
// discovery.js only offers it as a continuation.
const SEQUEL = /\b(season|series)\s*\d|\b\d+(st|nd|rd|th)\s+season\b|\bpart\s*(\d|ii)\b|\s(ii|iii|iv|2|3|4|5)$|final season|\bshippuu?den\b/i;

// Backup discovery for when AniList is down (see src/discovery.js): what
// MyAnimeList's users recommend from each seed, plus MAL's charts, as
// candidates in En's own shape. Same-origin only, like the other MAL routes.
//   GET /api/mal-discover?seeds=5114,9253
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "MAL_CLIENT_ID is not configured." });
    return;
  }
  const seeds = String(req.query.seeds || "")
    .split(",")
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, MAX_SEEDS);

  try {
    const [seedDetails, top, popular, airing, season] = await Promise.all([
      inBatches(seeds, 8, (id) => malDetails(id, clientId)),
      malChart("all", clientId, 30).catch(() => []),
      malChart("bypopularity", clientId, 30).catch(() => []),
      malChart("airing", clientId, 20).catch(() => []),
      malSeason(clientId).catch(() => [])
    ]);

    // Recommendations get their full details (relations, for sequels).
    const recsBySeed = seeds.map((id, i) => ({
      malId: id,
      recs: (seedDetails[i]?.recommendations || [])
        .slice(0, RECS_PER_SEED)
        .map((rec) => ({ malId: rec.node.id, weight: rec.num_recommendations || 1 }))
    }));
    const recIds = [...new Set(recsBySeed.flatMap((seed) => seed.recs.map((rec) => rec.malId)))];
    const recDetails = await inBatches(recIds, 10, (id) => malDetails(id, clientId));

    const candidates = new Map();
    for (const node of [...top, ...popular, ...airing, ...season]) {
      if (!node?.id || candidates.has(node.id)) continue;
      const candidate = toMalCandidate(node);
      const names = [node.title, node.alternative_titles?.en].filter(Boolean).join(" | ");
      if (SEQUEL.test(names)) candidate.prequels = [{ anilistId: null, malId: null, title: "" }];
      candidates.set(node.id, candidate);
    }
    for (const node of recDetails) if (node?.id) candidates.set(node.id, toMalCandidate(node));

    const ids = (nodes) => nodes.map((node) => node?.id).filter(Boolean);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).json({
      seeds: recsBySeed,
      candidates: [...candidates.values()],
      charts: { top: ids(top), popular: ids(popular), airing: ids(airing), season: ids(season) }
    });
  } catch (error) {
    res.status(502).json({ error: "MyAnimeList didn't answer. Try again in a moment." });
  }
}

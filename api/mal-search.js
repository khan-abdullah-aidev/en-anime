import { bestMalMatch, malSearch, toMalCandidate } from "./_lib/malCatalog.js";

// A title matched on MyAnimeList, for when AniList is down (see
// resolveAnimeOnAniList in src/anilist.js). Same shape as an AniList
// match, with no AniList id. Same-origin only.
//   GET /api/mal-search?q=frieren
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const q = String(req.query.q || "").trim().slice(0, 120);
  if (q.length < 2) {
    res.status(400).json({ error: "Search for at least two characters." });
    return;
  }
  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "MAL_CLIENT_ID is not configured." });
    return;
  }
  try {
    const node = bestMalMatch(q, await malSearch(q, clientId));
    if (!node) {
      res.status(200).json({ match: null });
      return;
    }
    const c = toMalCandidate(node);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).json({
      match: {
        anilistId: null,
        malId: c.malId,
        title: c.title,
        title_jp: c.title_jp,
        title_romaji: node.title || null,
        year: c.year,
        episodes: c.episodes,
        genre: c.genre,
        genres: c.genres,
        image_url: c.image_url,
        watch_links: []
      }
    });
  } catch {
    res.status(502).json({ error: "MyAnimeList didn't answer. Try again in a moment." });
  }
}

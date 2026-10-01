import { fetchMalAnimeList } from "./_lib/malList.js";

export default async function handler(req, res) {
  // Same-origin only: no CORS headers, so other sites' scripts can't call this.
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing MAL bearer token" });
    return;
  }

  try {
    const list = await fetchMalAnimeList({ user: "@me", headers: { Authorization: authorization } });
    res.status(200).json({ data: list });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message || "Could not read your MAL list."
    });
  }
}

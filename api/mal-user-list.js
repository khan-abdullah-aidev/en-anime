import { fetchMalAnimeList } from "./_lib/malList.js";

// MAL usernames are 2-16 letters, digits, "_" or "-".
const USERNAME = /^[A-Za-z0-9_-]{2,16}$/;

// "For two": reads the other person's public MyAnimeList list by username,
// with the app's client ID, so they don't have to sign in to En.
export default async function handler(req, res) {
  // Same-origin only: no CORS headers, so other sites' scripts can't call this.
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const user = String(req.query.user || "").trim();
  if (!USERNAME.test(user)) {
    res.status(400).json({ error: "That doesn't look like a MyAnimeList username." });
    return;
  }

  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "MAL_CLIENT_ID is not configured." });
    return;
  }

  try {
    const list = await fetchMalAnimeList({ user, headers: { "X-MAL-CLIENT-ID": clientId } });
    res.status(200).json({ data: list });
  } catch (error) {
    const status = error.statusCode || 502;
    const message =
      status === 404
        ? `There's no MyAnimeList user called ${user}.`
        : status === 403 || status === 401
          ? `${user}'s MyAnimeList list is private, so En can't read it.`
          : "MyAnimeList didn't answer. Try again in a moment.";
    res.status(status === 404 || status === 403 || status === 401 ? status : 502).json({ error: message });
  }
}

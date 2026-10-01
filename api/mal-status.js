// Two-way MAL sync, the En -> MAL half: when the user answers En about a pick
// (watching it tonight, saving it, how it was), the same thing goes on their
// MyAnimeList list. It reads the show's current status first and only ever
// moves it forward - never overwrites a finish, a drop or a score.
const MAL_ANIME_URL = "https://api.myanimelist.net/v2/anime";

// action -> the list change it makes, given what MAL has now (null = no
// change). "meh" can mean they stopped partway, so it only fills in a show
// that isn't being watched already.
export function planListUpdate(action, current, numEpisodes = 0) {
  const status = current?.status || null;
  const finished = numEpisodes > 0 ? { num_watched_episodes: numEpisodes } : {};
  switch (action) {
    case "tonight":
      return [null, "plan_to_watch", "on_hold", "dropped"].includes(status) ? { status: "watching" } : null;
    case "later":
      return status ? null : { status: "plan_to_watch" };
    case "good":
      return [null, "plan_to_watch", "watching", "on_hold"].includes(status) ? { status: "completed", ...finished } : null;
    case "meh":
      return [null, "plan_to_watch"].includes(status) ? { status: "completed", ...finished } : null;
    default:
      return null;
  }
}

const ACTIONS = new Set(["tonight", "later", "good", "meh"]);

export default async function handler(req, res) {
  // Same-origin only: no CORS headers, so other sites' scripts can't call this.
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authorization = String(req.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing MAL bearer token", code: "auth" });
    return;
  }

  const malId = Number(req.body?.malId);
  const action = req.body?.action;
  if (!Number.isInteger(malId) || malId <= 0 || !ACTIONS.has(action)) {
    res.status(400).json({ error: "Expected { malId, action }." });
    return;
  }

  try {
    const anime = await malRequest(`${MAL_ANIME_URL}/${malId}?fields=num_episodes,my_list_status`, { headers: { Authorization: authorization } });
    const current = anime.my_list_status || null;
    const plan = planListUpdate(action, current, Number(anime.num_episodes) || 0);
    if (!plan) {
      res.status(200).json({ changed: false, status: current?.status || null });
      return;
    }

    await malRequest(`${MAL_ANIME_URL}/${malId}/my_list_status`, {
      method: "PATCH",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.entries(plan).map(([key, value]) => [key, String(value)])).toString()
    });
    res.status(200).json({ changed: true, status: plan.status, from: current?.status || null });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
}

async function malRequest(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch {
    throw httpError(502, "MyAnimeList didn't answer. Try again in a moment.");
  }
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;
  if (response.status === 401) throw httpError(401, "Your MyAnimeList session expired.", "auth");
  if (response.status === 403) {
    throw httpError(403, "MyAnimeList didn't let En change your list. Disconnect and connect again to give it permission.", "forbidden");
  }
  if (response.status === 404) throw httpError(404, "MyAnimeList doesn't know that show.");
  throw httpError(502, "MyAnimeList didn't answer. Try again in a moment.");
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

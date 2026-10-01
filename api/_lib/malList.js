// Reads a full MyAnimeList anime list, following pagination. Used for the
// signed-in user's own list (@me, with their token) and for the other
// person's public list in "For two" (by username, with the app client ID).
const MAL_USERS_URL = "https://api.myanimelist.net/v2/users";
const MAX_PAGES = 100;

export async function fetchMalAnimeList({ user = "@me", headers }) {
  const params = new URLSearchParams({
    fields: "id,title,mean,num_episodes,start_season,genres,main_picture,alternative_titles,list_status",
    limit: "1000",
    nsfw: "true",
    sort: "list_score"
  });

  const entries = [];
  let nextUrl = `${MAL_USERS_URL}/${encodeURIComponent(user)}/animelist?${params.toString()}`;
  let pageCount = 0;

  while (nextUrl) {
    pageCount += 1;
    if (pageCount > MAX_PAGES) {
      throw new Error("MAL pagination exceeded the expected page limit.");
    }

    const response = await fetch(nextUrl, { headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || "Could not read the MyAnimeList list.");
      error.statusCode = response.status;
      throw error;
    }

    for (const item of payload.data || []) {
      entries.push(normalizeAnime(item));
    }

    nextUrl = payload.paging?.next || "";
  }

  return entries;
}

function normalizeAnime(item) {
  const node = item.node || {};
  const season = node.start_season;

  return {
    id: node.id,
    title: node.title,
    mean_score: node.mean ?? null,
    episodes: node.num_episodes ?? null,
    year: season?.year ?? null,
    season: season?.season ?? null,
    genres: (node.genres || []).map((genre) => genre.name),
    image_url: node.main_picture?.large || node.main_picture?.medium || "",
    alternative_titles: node.alternative_titles || null,
    updated_at: item.list_status?.updated_at || null,
    my_list_status: item.list_status || null
  };
}

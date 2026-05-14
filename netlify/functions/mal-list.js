const MAL_LIST_URL = "https://api.myanimelist.net/v2/users/@me/animelist";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  if (event.httpMethod !== "GET") {
    return response(405, { error: "Method not allowed" });
  }

  const authorization = event.headers.authorization || event.headers.Authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return response(401, { error: "Missing MAL bearer token" });
  }

  try {
    const list = await fetchAnimeList(authorization);
    return response(200, { data: list });
  } catch (error) {
    return response(error.statusCode || 500, {
      error: error.message || "Could not read your MAL list."
    });
  }
}

async function fetchAnimeList(authorization) {
  const params = new URLSearchParams({
    fields: "id,title,mean,num_episodes,start_season,genres,main_picture,list_status",
    limit: "1000",
    nsfw: "true",
    sort: "list_score"
  });

  const entries = [];
  let nextUrl = `${MAL_LIST_URL}?${params.toString()}`;
  let pageCount = 0;

  while (nextUrl) {
    pageCount += 1;
    if (pageCount > 100) {
      throw new Error("MAL pagination exceeded the expected page limit.");
    }

    const response = await fetch(nextUrl, {
      headers: { Authorization: authorization }
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || "Could not read your MAL list.");
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
    updated_at: item.list_status?.updated_at || null,
    my_list_status: item.list_status || null
  };
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(typeof body === "string" ? "text/plain" : "application/json"),
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

function corsHeaders(contentType) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": contentType
  };
}

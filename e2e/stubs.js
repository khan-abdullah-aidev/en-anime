// Stand-ins for everything En talks to over the network: the model
// (/api/en), AniList, the sync server and cover images. Each test gets a log
// of what was asked, to check what reached the model or AniList.

// A 1x1 transparent PNG, for covers.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const CORS = { "access-control-allow-origin": "*" };

export const MOOD_READING = {
  reading: "quiet and a little sad",
  genres: ["Slice of Life"],
  tags: ["Iyashikei"],
  avoidGenres: [],
  avoidTags: [],
  length: "any",
  era: "any",
  airing: false
};

// mediaById: what AniList says about a show looked up by id (past picks).
export async function stubServices(page, { aniListList = [], moodReading = MOOD_READING, mediaById = null } = {}) {
  const log = { en: [], anilist: [] };

  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.route("https://img.example/**", (route) => route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: PNG }));
  await page.route("**/api/sync**", (route) => route.fulfill({ json: { configured: false } }));
  await page.route("**/api/anime-image**", (route) => route.fulfill({ json: { image_url: "" } }));

  await page.route("**/api/en", async (route) => {
    const body = route.request().postDataJSON();
    log.en.push(body);
    await route.fulfill({ json: { content: JSON.stringify(modelAnswer(body, moodReading)) } });
  });

  await page.route("https://graphql.anilist.co/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
      return;
    }
    const { query, variables } = route.request().postDataJSON();
    log.anilist.push(query);
    await route.fulfill({ headers: CORS, json: { data: aniListAnswer(query, variables || {}, aniListList, mediaById) } });
  });

  return log;
}

// The model: reads moods, and picks the top candidate with a plain reason.
function modelAnswer(body, moodReading) {
  const { kind, payload } = body;
  if (kind === "mood") return moodReading;
  if (kind === "choose" || kind === "verdict") {
    const title = payload.queriedTitles[0];
    return { verdict: "yes", queried_title: title, title, title_jp: title, year: 2015, episodes: 12, genre: "Drama", reason: "It fits tonight.", log_line: "It fits." };
  }
  const pick = payload.candidateList[0];
  return {
    title: pick.title,
    title_jp: pick.title_jp || pick.title,
    year: pick.year || 2015,
    episodes: pick.episodes || 12,
    genre: (pick.genres || ["Drama"]).slice(0, 2).join(", "),
    reason: "You loved Mushishi. This one moves at the same pace.",
    log_line: "The same pace.",
    // From two phones, the other person gets it addressed to them.
    ...(payload.bothPerspectives
      ? { reason_for_them: `You loved Barakamon. ${payload.userName || "They"} loved Mushishi. This sits between.`, log_line_for_them: "Somewhere between." }
      : {})
  };
}

function aniListAnswer(query, variables, list, mediaById) {
  // Past picks, looked up by id so En can learn from them.
  if (query.includes("id_in: $ids") && !query.includes("recommendations(")) {
    return { Page: { media: (variables.ids || []).map((id) => (mediaById ? mediaById(id) : media(id, `Show ${id}`))) } };
  }
  if (query.includes("MediaListCollection")) {
    return { MediaListCollection: { lists: [{ entries: list }] } };
  }
  if (query.includes("search:")) {
    const title = variables.search;
    return { Page: { media: [media(idFor(title), title)] } };
  }
  if (query.includes("recommendations(")) {
    return {
      Page: {
        media: (variables.ids || []).map((id) => ({
          id,
          idMal: id,
          recommendations: {
            nodes: Array.from({ length: 8 }, (_, n) => ({ rating: 80 - n, mediaRecommendation: media(id * 100 + n, `Recommended ${id}-${n}`) }))
          }
        }))
      }
    };
  }
  // Discovery: every aliased page gets a few shows, one of them horror.
  const aliases = [...query.matchAll(/(\w+): Page\(/g)].map((match) => match[1]);
  return Object.fromEntries(
    aliases.map((alias, index) => [
      alias,
      {
        media: Array.from({ length: 5 }, (_, n) =>
          media(900000 + index * 10 + n, `Discovered ${alias} ${n}`, n === 0 ? { genres: ["Horror"] } : {})
        )
      }
    ])
  );
}

export function media(id, title, overrides = {}) {
  return {
    id,
    idMal: id + 50000,
    title: { english: title, romaji: title, native: title },
    synonyms: [],
    format: "TV",
    status: "FINISHED",
    episodes: 12,
    isAdult: false,
    startDate: { year: 2015 },
    genres: ["Drama"],
    averageScore: 78,
    popularity: 40000,
    coverImage: { extraLarge: `https://img.example/${id}.png`, large: "" },
    tags: [],
    relations: { edges: [] },
    externalLinks: [],
    ...overrides
  };
}

// An AniList list entry, as MediaListCollection returns it.
export function listEntry(id, title, status, score, genres) {
  return {
    status,
    score,
    progress: status === "COMPLETED" ? 12 : 3,
    updatedAt: 1790000000 - id * 1000,
    media: { id, idMal: id + 50000, title: { romaji: title, english: title, native: title }, synonyms: [], episodes: 12, genres, startDate: { year: 2015 }, coverImage: { large: "" } }
  };
}

function idFor(title) {
  let hash = 7;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  return 1000 + hash;
}

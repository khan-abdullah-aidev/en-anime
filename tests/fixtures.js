// A small MyAnimeList list, shaped like what api/mal-list.js returns (newest
// update first, as mal.js sorts it).
export function malEntry(id, title, status, score, genres, { watched = 0, episodes = 12, updated = "2026-01-01T00:00:00Z", en } = {}) {
  return {
    id,
    title,
    episodes,
    genres,
    alternative_titles: en ? { en, synonyms: [] } : { synonyms: [] },
    updated_at: updated,
    my_list_status: { status, score, num_episodes_watched: watched, updated_at: updated }
  };
}

export const MAL_LIST = [
  malEntry(1, "Odd Taxi", "watching", 0, ["Mystery", "Drama"], { watched: 5, episodes: 13, updated: "2026-09-20T00:00:00Z" }),
  malEntry(2, "Sousou no Frieren", "completed", 10, ["Adventure", "Drama", "Fantasy"], { watched: 28, episodes: 28, updated: "2026-09-10T00:00:00Z", en: "Frieren: Beyond Journey's End" }),
  malEntry(3, "Chainsaw Man", "dropped", 4, ["Action", "Gore"], { watched: 4, updated: "2026-08-30T00:00:00Z" }),
  malEntry(4, "Mushishi", "completed", 9, ["Slice of Life", "Iyashikei", "Mystery"], { watched: 26, episodes: 26, updated: "2026-08-01T00:00:00Z" }),
  malEntry(5, "Hellsing Ultimate", "dropped", 0, ["Action", "Gore", "Horror"], { watched: 2, episodes: 10, updated: "2026-07-01T00:00:00Z" }),
  malEntry(6, "Tokyo Ghoul", "completed", 5, ["Action", "Gore", "Horror"], { watched: 12, updated: "2026-06-01T00:00:00Z" }),
  malEntry(7, "Barakamon", "completed", 9, ["Comedy", "Slice of Life", "Iyashikei"], { watched: 12, updated: "2026-05-01T00:00:00Z" }),
  malEntry(8, "Another", "plan_to_watch", 0, ["Horror", "Mystery"], { updated: "2026-04-01T00:00:00Z" }),
  malEntry(9, "K", "plan_to_watch", 0, ["Action"], { episodes: 13, updated: "2026-04-01T00:00:00Z" }),
  malEntry(10, "Ping Pong the Animation", "on_hold", 0, ["Sports"], { watched: 3, episodes: 11, updated: "2026-03-01T00:00:00Z" }),
  malEntry(11, "Shingeki no Kyojin", "completed", 7, ["Action", "Drama"], { watched: 25, episodes: 25, updated: "2026-02-01T00:00:00Z", en: "Attack on Titan" }),
  malEntry(12, "Yuru Camp", "completed", 8, ["Slice of Life", "Iyashikei", "Comedy"], { updated: "2026-01-01T00:00:00Z", en: "Laid-Back Camp" })
];

// An AniList Media object, as returned by the discovery queries.
export function aniListMedia(id, english, overrides = {}) {
  return {
    id,
    idMal: overrides.idMal ?? id + 10000,
    title: { english, romaji: overrides.romaji || english, native: overrides.native || english },
    synonyms: [],
    format: "TV",
    status: "FINISHED",
    episodes: 12,
    isAdult: false,
    startDate: { year: 2020 },
    genres: ["Drama"],
    averageScore: 80,
    popularity: 50000,
    coverImage: { extraLarge: `https://img.example/${id}.jpg`, large: "" },
    tags: [],
    relations: { edges: [] },
    ...overrides
  };
}

export function relation(relationType, node) {
  return { relationType, node: { type: "ANIME", ...node, title: { english: node.title, romaji: node.title } } };
}

export function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = String(init.body); // a form post
      }
    }
    calls.push({ url: String(url), body, headers: init.headers || {} });
    return impl(String(url), body, calls.length);
  };
  return Promise.resolve(fn()).then(
    (result) => {
      globalThis.fetch = real;
      return { result, calls };
    },
    (error) => {
      globalThis.fetch = real;
      throw error;
    }
  );
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

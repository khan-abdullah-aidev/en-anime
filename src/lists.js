import { aniListRequest } from "./anilist.js";
import { fetchPartnerList } from "./mal.js";

// Username sign-in: read someone's public list from MyAnimeList (through
// /api/mal-user-list) or AniList (straight from the browser), no login.
export function fetchPublicList(source) {
  return source.kind === "anilist" ? fetchAniListUserList(source.username) : fetchPartnerList(source.username);
}

export function sourceLabel(source) {
  return source?.kind === "anilist" ? "AniList" : "MyAnimeList";
}

const LIST_QUERY = `query ($name: String) {
  MediaListCollection(userName: $name, type: ANIME) {
    lists {
      entries {
        status
        score(format: POINT_10)
        progress
        updatedAt
        media {
          id idMal
          title { romaji english native }
          synonyms episodes genres
          startDate { year }
          coverImage { large }
        }
      }
    }
  }
}`;

// AniList list statuses in MyAnimeList's terms, so everything downstream
// (digest, taste profile, exclusions, resume) treats both lists the same.
// REPEATING means they finished it before and are rewatching.
const STATUS = {
  CURRENT: "watching",
  PLANNING: "plan_to_watch",
  COMPLETED: "completed",
  DROPPED: "dropped",
  PAUSED: "on_hold",
  REPEATING: "completed"
};

export async function fetchAniListUserList(username) {
  let data;
  try {
    data = await aniListRequest(LIST_QUERY, { name: username }, { timeoutMs: 15000 });
  } catch (error) {
    if (/private user/i.test(error.message)) throw new Error(`${username}'s AniList list is private, so En can't read it.`);
    if (/not found/i.test(error.message)) throw new Error(`There's no AniList user called ${username}.`);
    throw new Error("AniList didn't answer. Try again in a moment.");
  }
  return toMalShapedList(data?.MediaListCollection?.lists || []);
}

export function toMalShapedList(lists) {
  const seen = new Set();
  const entries = [];
  // Custom lists repeat entries from the status lists; keep each show once.
  for (const entry of lists.flatMap((list) => list.entries || [])) {
    const media = entry.media;
    if (!media?.id || seen.has(media.id)) continue;
    seen.add(media.id);
    const updated = entry.updatedAt ? new Date(entry.updatedAt * 1000).toISOString() : null;
    entries.push({
      id: media.idMal || null,
      anilistId: media.id,
      title: media.title?.romaji || media.title?.english,
      episodes: media.episodes ?? null,
      year: media.startDate?.year ?? null,
      genres: media.genres || [],
      image_url: media.coverImage?.large || "",
      alternative_titles: {
        en: media.title?.english || null,
        ja: media.title?.native || null,
        synonyms: media.synonyms || []
      },
      updated_at: updated,
      my_list_status: {
        status: STATUS[entry.status] || "plan_to_watch",
        score: Math.round(Number(entry.score) || 0),
        num_episodes_watched: Number(entry.progress) || 0,
        updated_at: updated
      }
    });
  }
  return entries.sort((a, b) => (Date.parse(b.updated_at || "") || 0) - (Date.parse(a.updated_at || "") || 0));
}

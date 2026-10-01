// "For two, from two phones" on this device (server side: api/room.js).
// Each room this device is in is remembered here, with its role and key:
// { [id]: { role: "host" | "guest", key, hostName, guestName, hostMood,
//   ready, seenPickIds, handledPasses, createdAt } }
const ROOMS_KEY = "en.rooms";
const NAME_KEY = "en.myName";
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_ENTRIES = 1500;

export function loadRooms() {
  try {
    const rooms = JSON.parse(localStorage.getItem(ROOMS_KEY) || "{}");
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(rooms && typeof rooms === "object" ? rooms : {}).filter(
        ([, room]) => room && now - (Date.parse(room.createdAt) || 0) < ROOM_LIFETIME_MS
      )
    );
  } catch {
    return {};
  }
}

export function loadRoom(id) {
  return loadRooms()[id] || null;
}

export function saveRoom(id, patch) {
  const rooms = loadRooms();
  const next = { createdAt: new Date().toISOString(), seenPickIds: [], handledPasses: [], ...rooms[id], ...patch };
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify({ ...rooms, [id]: next }));
  } catch {
    // storage unavailable; the room lasts for this visit only
  }
  return next;
}

// What to call this person, remembered for next time.
export function loadMyName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

export function saveMyName(name) {
  try {
    if (name.trim()) localStorage.setItem(NAME_KEY, name.trim());
  } catch {
    // not remembered; asked again next time
  }
}

export function roomLink(id) {
  return `${window.location.origin}/with/${id}`;
}

export function newRoomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Only what En reads from a list, so a long one fits in the room.
export function trimListForRoom(list) {
  if (typeof list === "string") return list.slice(0, 6000);
  return (Array.isArray(list) ? list : []).slice(0, MAX_LIST_ENTRIES).map((entry) => ({
    id: entry.id || null,
    ...(entry.anilistId ? { anilistId: entry.anilistId } : {}),
    title: entry.title,
    alternative_titles: entry.alternative_titles
      ? { en: entry.alternative_titles.en || null, ja: entry.alternative_titles.ja || null, synonyms: (entry.alternative_titles.synonyms || []).slice(0, 3) }
      : null,
    episodes: entry.episodes ?? null,
    genres: entry.genres || [],
    updated_at: entry.updated_at || entry.my_list_status?.updated_at || null,
    my_list_status: {
      status: entry.my_list_status?.status || "",
      score: Number(entry.my_list_status?.score) || 0,
      num_episodes_watched: Number(entry.my_list_status?.num_episodes_watched) || 0,
      updated_at: entry.my_list_status?.updated_at || null
    }
  }));
}

// The other person's list as En reads it, with what they've seen through
// their own En log added, so neither turns up as a pick.
export function partnerListFromRoom(guest) {
  const seen = guest.seenTitles || [];
  if (typeof guest.list === "string") return [guest.list, ...seen].filter(Boolean).join(", ");
  return [
    ...(guest.list || []),
    ...seen.map((title) => ({ id: null, title, alternative_titles: { synonyms: [] }, genres: [], my_list_status: { status: "completed", score: 0 } }))
  ];
}

export async function createRoom({ hostName }) {
  return roomRequest("POST", "", { hostName });
}

export async function fetchRoom(id, { hostKey } = {}) {
  return roomRequest("GET", id, null, hostKey ? { "X-En-Room-Key": hostKey } : {});
}

export async function updateRoom(id, body) {
  return roomRequest("PUT", id, body);
}

async function roomRequest(method, id, body, headers = {}) {
  let response;
  try {
    response = await fetch(`/api/room${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
      method,
      headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error("En couldn't reach the room. Check your connection.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `The room didn't answer (${response.status}).`), { code: payload.code, status: response.status });
  }
  return payload;
}

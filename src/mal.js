export async function fetchAnimeList(accessToken) {
  const response = await fetch("/api/mal-list", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401 && isAuthError(payload)) {
      throw new MalAuthError("Your MyAnimeList session expired. Reconnecting should fix it.");
    }

    throw new Error(payload.message || payload.error || "Could not read your MAL list.");
  }

  return sortByRecent(payload.data || []);
}

export class MalAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "MalAuthError";
  }
}

export function isMalAuthError(error) {
  return error instanceof MalAuthError || error?.name === "MalAuthError";
}

// Image search doesn't need the user's token (the API route falls back to the
// app client ID), and a missing picture must never sink a recommendation.
export async function fetchAnimeImage(title, aliases = []) {
  if (!title) return "";

  const params = new URLSearchParams({ q: title });
  for (const alias of aliases.filter(Boolean)) {
    params.append("alias", alias);
  }

  try {
    const response = await fetch(`/api/anime-image?${params.toString()}`);
    if (!response.ok) return "";
    const payload = await response.json();
    return payload.image_url || "";
  } catch (error) {
    console.warn("[En debug] image lookup failed", { title, error: error.message });
    return "";
  }
}

function sortByRecent(list) {
  return [...list].sort((a, b) => {
    const aTime = Date.parse(a.updated_at || a.my_list_status?.updated_at || "") || 0;
    const bTime = Date.parse(b.updated_at || b.my_list_status?.updated_at || "") || 0;
    return bTime - aTime;
  });
}

function isAuthError(payload) {
  const value = `${payload?.error || ""} ${payload?.message || ""}`.toLowerCase();
  return value.includes("invalid_token") || value.includes("token");
}

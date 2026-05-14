export async function fetchAnimeList(accessToken) {
  const response = await fetch("/api/mal-list", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Could not read your MAL list.");
  }

  return sortByRecent(payload.data || []);
}

export async function fetchAnimeImage(title, accessToken) {
  if (!title) return "";

  const response = await fetch(`/api/anime-image?q=${encodeURIComponent(title)}`, {
    headers: accessToken
      ? {
          Authorization: `Bearer ${accessToken}`
        }
      : {}
  });

  const payload = await response.json();
  if (!response.ok) {
    return "";
  }

  return payload.image_url || "";
}

function sortByRecent(list) {
  return [...list].sort((a, b) => {
    const aTime = Date.parse(a.updated_at || a.my_list_status?.updated_at || "") || 0;
    const bTime = Date.parse(b.updated_at || b.my_list_status?.updated_at || "") || 0;
    return bTime - aTime;
  });
}

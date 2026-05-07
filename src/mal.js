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

  return payload.data || [];
}

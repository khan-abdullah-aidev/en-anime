// What Vercel Web Analytics and Speed Insights get to see of a page's
// address: the screen, never an id or a query. A pick's or a room's id
// (/pick/<id>, /room/<id>) becomes its screen, and the query is dropped,
// which also keeps MyAnimeList's one-time sign-in code (/callback?code=)
// out of the stats.
const WITH_ID = /^\/(pick|room)\/[^/]+/;

export function anonymousUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(WITH_ID, "/$1")}`;
  } catch {
    return url;
  }
}

export function anonymousEvent(event) {
  return { ...event, url: anonymousUrl(event.url) };
}

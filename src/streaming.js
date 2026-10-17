// Where a show streams, from AniList's external links: one link per site.
// AniList doesn't know the viewer's region, so this is "where it's offered",
// not a promise it's available everywhere.
export function streamingLinks(externalLinks = []) {
  const seen = new Set();
  return (externalLinks || [])
    .filter((link) => link?.type === "STREAMING" && link.url && link.site && !seen.has(link.site) && seen.add(link.site))
    .slice(0, 4)
    .map((link) => ({ site: link.site, url: link.url }));
}

// The services a user can say they have, for "only what I can watch". AniList
// names sites inconsistently ("Amazon Prime Video", "Amazon"), so each is
// matched by pattern rather than exact name.
export const STREAMING_SERVICES = [
  { label: "Crunchyroll", pattern: /crunchyroll/i },
  { label: "Netflix", pattern: /netflix/i },
  { label: "HIDIVE", pattern: /hidive/i },
  { label: "Prime Video", pattern: /amazon|prime video/i },
  { label: "Disney+", pattern: /disney/i },
  { label: "Hulu", pattern: /hulu/i },
  { label: "Max", pattern: /^(hbo )?max$|hbo/i },
  { label: "YouTube", pattern: /youtube/i },
  { label: "Bilibili", pattern: /bilibili/i },
  { label: "Tubi", pattern: /tubi/i },
  { label: "Apple TV", pattern: /apple tv/i },
  { label: "Muse Asia", pattern: /muse/i },
  { label: "Ani-One", pattern: /ani-?one/i }
];

// Whether any of a show's streaming links is on one of the chosen services.
export function onServices(watchLinks = [], services = []) {
  const chosen = STREAMING_SERVICES.filter((service) => services.includes(service.label));
  return (watchLinks || []).some((link) => chosen.some((service) => service.pattern.test(link.site || "")));
}

// "Only what I can watch" as a filter discovery.js can apply alongside
// "leave out": matches (and so drops) anything not on the chosen services.
// A show they already started (resume) or loved (rewatch) is theirs to find.
export function servicesFilter(services = []) {
  return {
    services,
    matches(candidate) {
      if (!services.length || candidate?.resume || candidate?.rewatch) return false;
      return !onServices(candidate?.watchLinks || candidate?.watch_links, services);
    }
  };
}

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

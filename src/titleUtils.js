export function normalizeTitleForCompare(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
}

export function uniqueTitles(titles = []) {
  const seen = new Set();
  const next = [];

  for (const title of titles.filter(Boolean)) {
    const key = normalizeTitleForCompare(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(title);
  }

  return next;
}

export function animeTitleKeys(anime) {
  const alternatives = anime?.alternative_titles || {};
  return uniqueTitles([
    anime?.title,
    anime?.title_jp,
    alternatives.en,
    alternatives.ja,
    ...(alternatives.synonyms || [])
  ]).map(normalizeTitleForCompare);
}

export function titleMatchesAnime(title, anime) {
  const normalized = normalizeTitleForCompare(title);
  return Boolean(normalized && animeTitleKeys(anime).includes(normalized));
}

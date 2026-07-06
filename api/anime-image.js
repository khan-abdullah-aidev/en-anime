const MAL_SEARCH_URL = "https://api.myanimelist.net/v2/anime";

export default async function handler(req, res) {
  setCorsHeaders(res, "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const title = req.query.q || "";
  if (!title.trim()) {
    writeJson(res, 400, { error: "Missing anime title" });
    return;
  }
  const aliases = [req.query.alias]
    .flat()
    .filter(Boolean)
    .map((alias) => String(alias));
  const requestedTitles = uniqueTitles([title, ...aliases]);

  const authorization = req.headers.authorization;
  const headers = authorization?.startsWith("Bearer ")
    ? { Authorization: authorization }
    : { "X-MAL-CLIENT-ID": process.env.MAL_CLIENT_ID || "" };

  if (!headers.Authorization && !headers["X-MAL-CLIENT-ID"]) {
    writeJson(res, 500, { error: "MAL_CLIENT_ID is not configured" });
    return;
  }

  try {
    const node = await findImageNode(requestedTitles, headers);
    writeJson(res, 200, {
      image_url: node?.main_picture?.large || node?.main_picture?.medium || ""
    });
  } catch (error) {
    writeJson(res, error.statusCode || 500, {
      error: error.message || "Could not fetch anime image"
    });
  }
}

async function findImageNode(requestedTitles, headers) {
  const requestedKeys = new Set(requestedTitles.map(normalizeTitleForCompare));
  let fallbackNode = null;

  for (const query of requestedTitles) {
    const payload = await searchAnime(query, headers);
    const nodes = (payload.data || []).map((item) => item.node).filter(Boolean);
    fallbackNode ||= nodes.find(hasImage) || null;

    const exactNode = nodes.find((node) =>
      hasImage(node) && animeTitleKeys(node).some((key) => requestedKeys.has(key))
    );
    if (exactNode) {
      return exactNode;
    }
  }

  return fallbackNode;
}

async function searchAnime(title, headers) {
  const params = new URLSearchParams({
    q: title,
    limit: "10",
    fields: "main_picture,alternative_titles"
  });

  const malResponse = await fetch(`${MAL_SEARCH_URL}?${params.toString()}`, {
    headers
  });
  const payload = await malResponse.json();

  if (!malResponse.ok) {
    const error = new Error(payload.message || payload.error || "Could not fetch anime image");
    error.statusCode = malResponse.status;
    throw error;
  }

  return payload;
}

function writeJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}

function setCorsHeaders(res, methods) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", methods);
}

function hasImage(node) {
  return Boolean(node?.main_picture?.large || node?.main_picture?.medium);
}

function animeTitleKeys(anime) {
  const alternatives = anime?.alternative_titles || {};
  return uniqueTitles([
    anime?.title,
    alternatives.en,
    alternatives.ja,
    ...(alternatives.synonyms || [])
  ]).map(normalizeTitleForCompare);
}

function uniqueTitles(titles = []) {
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

function normalizeTitleForCompare(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/\b(the|a|an)\b/g, "")
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
}

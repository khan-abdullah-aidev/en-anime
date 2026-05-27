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

  const authorization = req.headers.authorization;
  const headers = authorization?.startsWith("Bearer ")
    ? { Authorization: authorization }
    : { "X-MAL-CLIENT-ID": process.env.MAL_CLIENT_ID || "" };

  if (!headers.Authorization && !headers["X-MAL-CLIENT-ID"]) {
    writeJson(res, 500, { error: "MAL_CLIENT_ID is not configured" });
    return;
  }

  const params = new URLSearchParams({
    q: title,
    limit: "1",
    fields: "main_picture"
  });

  const malResponse = await fetch(`${MAL_SEARCH_URL}?${params.toString()}`, {
    headers
  });
  const payload = await malResponse.json();

  if (!malResponse.ok) {
    writeJson(res, malResponse.status, {
      error: payload.message || payload.error || "Could not fetch anime image"
    });
    return;
  }

  const node = payload.data?.[0]?.node || {};
  writeJson(res, 200, {
    image_url: node.main_picture?.large || node.main_picture?.medium || ""
  });
}

function writeJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}

function setCorsHeaders(res, methods) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", methods);
}

const MAL_SEARCH_URL = "https://api.myanimelist.net/v2/anime";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  if (event.httpMethod !== "GET") {
    return response(405, { error: "Method not allowed" });
  }

  const title = event.queryStringParameters?.q || "";
  if (!title.trim()) {
    return response(400, { error: "Missing anime title" });
  }

  const authorization = event.headers.authorization || event.headers.Authorization;
  const headers = authorization?.startsWith("Bearer ")
    ? { Authorization: authorization }
    : { "X-MAL-CLIENT-ID": process.env.MAL_CLIENT_ID || "" };

  if (!headers.Authorization && !headers["X-MAL-CLIENT-ID"]) {
    return response(500, { error: "MAL_CLIENT_ID is not configured" });
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
    return response(malResponse.status, {
      error: payload.message || payload.error || "Could not fetch anime image"
    });
  }

  const node = payload.data?.[0]?.node || {};
  return response(200, {
    image_url: node.main_picture?.large || node.main_picture?.medium || ""
  });
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: corsHeaders(typeof body === "string" ? "text/plain" : "application/json"),
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

function corsHeaders(contentType) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": contentType
  };
}

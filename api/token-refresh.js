const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";

export default async function handler(req, res) {
  // Same-origin only: no CORS headers, so other sites' scripts can't call this.
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    writeJson(res, 400, { error: "Missing required field: refreshToken" });
    return;
  }

  const clientId = process.env.MAL_CLIENT_ID;
  const clientSecret = process.env.MAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    writeJson(res, 500, { error: "MAL OAuth environment variables are not configured" });
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const malResponse = await fetch(MAL_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });

  res.status(malResponse.status);
  res.setHeader("Content-Type", "application/json");
  res.send(await malResponse.text());
}

function writeJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}


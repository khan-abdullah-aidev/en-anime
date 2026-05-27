const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";

export default async function handler(req, res) {
  setCorsHeaders(res, "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const { code, codeVerifier, redirectUri } = req.body || {};
  if (!code || !codeVerifier || !redirectUri) {
    writeJson(res, 400, {
      error: "Missing required fields: code, codeVerifier, redirectUri"
    });
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
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri
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

function setCorsHeaders(res, methods) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", methods);
}

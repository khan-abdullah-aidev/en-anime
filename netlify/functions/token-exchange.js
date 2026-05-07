const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  if (event.httpMethod !== "POST") {
    return response(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }

  const { code, codeVerifier, redirectUri } = body;
  if (!code || !codeVerifier || !redirectUri) {
    return response(400, {
      error: "Missing required fields: code, codeVerifier, redirectUri"
    });
  }

  const clientId = process.env.MAL_CLIENT_ID;
  const clientSecret = process.env.MAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return response(500, { error: "MAL OAuth environment variables are not configured" });
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

  const text = await malResponse.text();

  return {
    statusCode: malResponse.status,
    headers: corsHeaders("application/json"),
    body: text
  };
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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": contentType
  };
}

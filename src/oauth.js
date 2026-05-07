import { clearOauthSession, loadOauthSession, saveOauthSession, saveTokens } from "./storage.js";

const MAL_AUTH_URL = "https://myanimelist.net/v1/oauth2/authorize";
const REDIRECT_URI = "http://localhost:5173/callback";
const SCOPE = "read:users";

export function getRedirectUri() {
  return import.meta.env.VITE_MAL_REDIRECT_URI || REDIRECT_URI;
}

export function beginMalOauth() {
  const clientId = import.meta.env.VITE_MAL_CLIENT_ID;
  if (!clientId) {
    throw new Error("VITE_MAL_CLIENT_ID is missing.");
  }

  const codeVerifier = randomString(96);
  const state = randomString(48);
  saveOauthSession({ codeVerifier, state, redirectUri: getRedirectUri() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    code_challenge: codeVerifier,
    code_challenge_method: "plain",
    redirect_uri: getRedirectUri(),
    scope: SCOPE,
    state
  });

  window.location.assign(`${MAL_AUTH_URL}?${params.toString()}`);
}

export async function finishMalOauth(callbackUrl) {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    throw new Error(url.searchParams.get("error_description") || error);
  }

  if (!code) {
    throw new Error("Missing OAuth code.");
  }

  const session = loadOauthSession();
  if (!session?.codeVerifier || !session?.state) {
    throw new Error("OAuth session expired. Please connect again.");
  }

  if (state !== session.state) {
    throw new Error("OAuth state mismatch. Please connect again.");
  }

  const response = await fetch("/api/token-exchange", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: session.redirectUri
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Token exchange failed.");
  }

  saveTokens(payload);
  clearOauthSession();
  window.history.replaceState({}, "", "/");
  return payload;
}

function randomString(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

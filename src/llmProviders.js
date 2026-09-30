// The model call runs server-side (api/en.js) so the Gemini key and prompts
// never ship in the client bundle.
export class EnConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnConfigError";
  }
}

export function isEnConfigError(error) {
  return error instanceof EnConfigError || error?.name === "EnConfigError";
}

export async function requestEn(kind, payload) {
  let response;
  try {
    response = await fetch("/api/en", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, payload })
    });
  } catch {
    throw new Error("En couldn't reach its model. Check your connection and try again.");
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (body.code === "not_configured") {
      throw new EnConfigError(`En isn't configured: ${body.error}`);
    }
    throw new Error(body.error || `En's model request failed (${response.status}).`);
  }

  if (typeof body.content !== "string" || !body.content) {
    throw new Error("En's model returned an empty response.");
  }
  return body.content;
}

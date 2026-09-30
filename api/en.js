import { PROMPTS } from "./_lib/prompts.js";
import { GeminiConfigError, generateJson } from "./_lib/gemini.js";
import { buildResponseSchema } from "./_lib/schemas.js";

// Generous for a digest + 60 candidates (~25 KB), small enough to stop this
// endpoint being used as a general-purpose Gemini proxy.
const MAX_PAYLOAD_CHARS = 120000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { kind, payload } = req.body || {};
  if (!Object.hasOwn(PROMPTS, kind) || !payload || typeof payload !== "object") {
    res.status(400).json({ error: "Expected { kind, payload }." });
    return;
  }

  const userPayloadText = JSON.stringify(payload);
  if (userPayloadText.length > MAX_PAYLOAD_CHARS) {
    res.status(413).json({ error: "Payload too large." });
    return;
  }

  try {
    const content = await generateJson({
      systemPrompt: PROMPTS[kind],
      userPayloadText,
      responseSchema: buildResponseSchema(kind, payload)
    });
    res.status(200).json({ content });
  } catch (error) {
    if (error instanceof GeminiConfigError) {
      res.status(500).json({ error: error.message, code: "not_configured" });
      return;
    }
    res.status(502).json({ error: error.message || "En couldn't reach its model." });
  }
}

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// The 2.5 models are closed to newly created keys. Set GEMINI_MODEL /
// GEMINI_FALLBACK_MODEL in Vercel to switch models without a code change
// the next time Google retires one.
const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const REQUEST_TIMEOUT_MS = 25000;
// Small jobs (reading the mood) go to the lighter model first, with less
// patience, so they never hold up the pick.
const FAST_TIMEOUT_MS = 9000;

function modelChain() {
  return [
    ...new Set([
      process.env.GEMINI_MODEL || DEFAULT_MODEL,
      process.env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL
    ])
  ];
}

export class GeminiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiConfigError";
  }
}

export async function generateJson({ systemPrompt, userPayloadText, responseSchema = null, fast = false }) {
  // VITE_* names are still read so an existing deployment keeps working until
  // the key is renamed; nothing on the client references them any more.
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    process.env.VITE_GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new GeminiConfigError("GEMINI_API_KEY is not configured.");
  }

  let lastError;
  const models = fast ? [...modelChain()].reverse() : modelChain();
  const timeoutMs = fast ? FAST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  for (const model of models) {
    try {
      return await callGemini({ apiKey, model, systemPrompt, userPayloadText, responseSchema, timeoutMs });
    } catch (error) {
      lastError = error;
      console.warn(`[En] Gemini ${model} failed`, error.message);
      // The schema only saves retries; if Gemini ever rejects it, answer
      // without it rather than failing the request (the client validates).
      if (responseSchema && error.status === 400) {
        try {
          return await callGemini({ apiKey, model, systemPrompt, userPayloadText, responseSchema: null, timeoutMs });
        } catch (retryError) {
          lastError = retryError;
          console.warn(`[En] Gemini ${model} failed without a schema too`, retryError.message);
        }
      }
    }
  }
  throw lastError;
}

async function callGemini({ apiKey, model, systemPrompt, userPayloadText, responseSchema, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPayloadText }]
          }
        ],
        // No temperature: Google recommends the default (1.0) for Gemini 3
        // models and warns that lower values can cause looping.
        generationConfig: {
          responseMimeType: "application/json",
          ...(responseSchema ? { responseSchema } : {})
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(formatGeminiError(await response.text()));
      error.status = response.status;
      throw error;
    }

    const payload = await response.json();
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!text) {
      throw new Error("Gemini returned an empty response.");
    }

    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Gemini ${model} timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatGeminiError(text) {
  try {
    const payload = JSON.parse(text);
    return payload.error?.message || text || "Gemini request failed.";
  } catch {
    return text || "Gemini request failed.";
  }
}

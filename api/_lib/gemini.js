const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const REQUEST_TIMEOUT_MS = 25000;

export class GeminiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiConfigError";
  }
}

export async function generateJson({ systemPrompt, userPayloadText }) {
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
  for (const model of MODELS) {
    try {
      return await callGemini({ apiKey, model, systemPrompt, userPayloadText });
    } catch (error) {
      lastError = error;
      console.warn(`[En] Gemini ${model} failed`, error.message);
    }
  }
  throw lastError;
}

async function callGemini({ apiKey, model, systemPrompt, userPayloadText }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
        generationConfig: {
          temperature: 0.85,
          responseMimeType: "application/json"
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(formatGeminiError(await response.text()));
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

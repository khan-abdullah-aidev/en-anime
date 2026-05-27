const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = "gemini-2.5-flash-lite";

export async function generateJsonWithProvider({ systemPrompt, userPayload }) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.VITE_GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error("VITE_GEMINI_API_KEY is missing.");
  }

  try {
    return await callGemini({
      apiKey,
      model: GEMINI_MODEL,
      systemPrompt,
      userPayload
    });
  } catch (error) {
    console.warn("[En debug] Gemini primary failed; trying Flash-Lite", error);
    return callGemini({
      apiKey,
      model: GEMINI_FALLBACK_MODEL,
      systemPrompt,
      userPayload
    });
  }
}

async function callGemini({ apiKey, model, systemPrompt, userPayload }) {
  const response = await fetch(`${GEMINI_URL}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: JSON.stringify(userPayload) }]
        }
      ],
      generationConfig: {
        temperature: 0.85,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatGeminiError(text));
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
}

function formatGeminiError(text) {
  try {
    const payload = JSON.parse(text);
    return payload.error?.message || text || "Gemini request failed.";
  } catch {
    return text || "Gemini request failed.";
  }
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b:free";

const SYSTEM_PROMPT = `You are En, an anime sommelier.
Return strict JSON only. Do not return markdown, commentary, prose outside JSON, or code fences.
Recommend exactly ONE anime the user has not watched.
Use the user's full MyAnimeList history, tonight's mood, and feedback history.
The reason must feel personal, observational, and almost literary. Reference patterns in their watch history instead of only matching genres.
The JSON shape must be exactly:
{
  "title": "string",
  "title_jp": "string",
  "year": number,
  "episodes": number,
  "genre": "string",
  "reason": "string"
}`;

export async function askEn({ mood, malList, feedbackHistory, onDelta }) {
  const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("VITE_OPENROUTER_API_KEY is missing.");
  }

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": window.location.origin,
      "X-Title": "En"
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      temperature: 0.85,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            mood: mood || "Surprise me",
            malList,
            feedbackHistory
          })
        }
      ]
    })
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || "OpenRouter request failed.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const event = JSON.parse(data);
      const delta = event.choices?.[0]?.delta?.content || "";
      if (delta) {
        content += delta;
        onDelta?.(content);
      }
    }
  }

  return parseRecommendation(content);
}

function parseRecommendation(content) {
  const trimmed = content.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  const parsed = JSON.parse(jsonText);

  for (const key of ["title", "title_jp", "year", "episodes", "genre", "reason"]) {
    if (parsed[key] === undefined || parsed[key] === null || parsed[key] === "") {
      throw new Error(`En returned JSON without ${key}.`);
    }
  }

  return parsed;
}

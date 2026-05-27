import { generateJsonWithProvider } from "./llmProviders.js";

const SYSTEM_PROMPT = `You are En, a quiet anime recommendation engine.
Return strict JSON only. Do not return markdown, commentary, prose outside JSON, or code fences.
Recommend exactly ONE anime the user has not watched.

Use the user's MyAnimeList history or their raw self-described watch history, tonight's mood, and feedback history.
If malList is an array, it is sorted from most recently updated to oldest. Weight the most recent 10-15 entries much more heavily than the rest when identifying patterns.
Pay special attention to recently completed, dropped, abandoned, and low-scored shows. Reference specific anime titles from the user's history by name whenever possible.
If malList is raw text, treat it as the user's stated watched/loved anime and avoid recommending those titles.
Use feedbackHistory as a taste signal. Good means the user liked that direction. Meh means avoid that direction unless the mood clearly asks for it. Pending means the user was interested enough to save it; treat pending items as positive taste signals, but never recommend those titles again.
exclusionTitles is a hard ban list. Never recommend any title in exclusionTitles under any circumstances. Treat matching case-insensitively and avoid obvious punctuation/colon variants.

Reasoning requirements:
- reason must be 2-4 short sentences maximum.
- Write like someone who notices things but does not announce that they notice.
- No metaphors.
- Short sentences.
- If a sentence sounds like writing, cut it in half.
- The best reasoning sounds like something a quiet person would say once and not repeat.
- Target tone: Hemingway, not Fitzgerald.
- Never use words like: journey, resonate, tapestry, yearning, delve, profound, captivating, narrative.
- Never be generic. Never say "since you like action, here's another action anime."
- Be specific and understated, like: "You watched four shows about regret this month, and abandoned three of them halfway. This one earns its ending. Watch it alone, with the lights low."
- log_line must be a separate single quiet line distilled from the same observation, not a summary. It should stand alone, like "You watched three slow shows in a row. Time to breathe." or "I read your history wrong. Too quiet, even for you."

The JSON shape must be exactly:
{
  "title": "string",
  "title_jp": "string",
  "year": number,
  "episodes": number,
  "genre": "string",
  "reason": "string",
  "log_line": "string"
}`;

export async function askEn({
  mood,
  tasteProfile,
  recentPatterns,
  feedbackHistory,
  candidateList,
  onDelta
}) {
  const userPayload = {
    mood: mood || "Surprise me",
    tasteProfile,
    recentPatterns,
    feedbackHistory,
    candidateList
  };

  console.log("[En debug] exact LLM user payload", userPayload);
  const content = await generateJsonWithProvider({
    systemPrompt: SYSTEM_PROMPT,
    userPayload
  });
  onDelta?.(content);

  const recommendation = parseRecommendation(content);
  console.log("[En debug] LLM raw response text", content);
  console.log("[En debug] LLM parsed recommendation", recommendation);
  return recommendation;
}

function parseRecommendation(content) {
  const trimmed = content.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  const parsed = JSON.parse(jsonText);
  parsed.title_jp ||= parsed.title;

  for (const key of ["title", "title_jp", "year", "episodes", "genre", "reason", "log_line"]) {
    if (parsed[key] === undefined || parsed[key] === null || parsed[key] === "") {
      throw new Error(`En returned JSON without ${key}.`);
    }
  }

  for (const key of ["title", "title_jp", "genre", "reason", "log_line"]) {
    if (typeof parsed[key] !== "string") {
      throw new Error(`En returned JSON with invalid ${key}.`);
    }
  }

  for (const key of ["year", "episodes"]) {
    if (!Number.isFinite(Number(parsed[key]))) {
      throw new Error(`En returned JSON with invalid ${key}.`);
    }
    parsed[key] = Number(parsed[key]);
  }

  return parsed;
}

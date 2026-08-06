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

const VERDICT_SYSTEM_PROMPT = `You are En, a quiet anime recommendation engine.
Return strict JSON only. Do not return markdown, commentary, prose outside JSON, or code fences.

The user is naming exactly ONE anime title they are considering watching tonight (queriedTitles has one entry). They may have also given a mood, or a reason they're considering it tonight (the mood field; it can be empty). Give a verdict: does it fit, or not.

Use the user's MyAnimeList history or their raw self-described watch history, their taste profile, recent patterns, and feedback history to judge fit — but mood is a live override, not just another data point. Someone can want something completely outside their usual pattern tonight, on purpose. Do not veto a title just because it clashes with recent history or taste profile if the stated mood clearly explains and supports wanting exactly that tonight. Only veto when the title is a mismatch even accounting for the mood, or when no mood was given and the historical mismatch is clear.
If malList is an array, it is sorted from most recently updated to oldest. Weight the most recent 10-15 entries much more heavily than the rest when identifying patterns.
Pay special attention to recently completed, dropped, abandoned, and low-scored shows.
Use feedbackHistory as a taste signal. Good means the user liked that direction. Meh means avoid that direction unless the mood clearly asks for it. Pending means the user was interested enough to save it; treat pending items as positive taste signals.
exclusionTitles is a hard ban list. Never let "title" land on any title in exclusionTitles under any circumstances. Treat matching case-insensitively and avoid obvious punctuation/colon variants.

Decide:
- If the queried title genuinely fits their taste, recent pattern, or the mood they stated: verdict is "yes". "title" is that same title in canonical form, and "queried_title" is that title as the user meant it.
- If it's a clear mismatch even accounting for mood (tone, pacing, darkness, franchise fatigue, repeats something they just watched or dropped): verdict is "no". "title" must be a DIFFERENT anime, pulled from candidateList, that fits better instead. "queried_title" is the title En is vetoing.

Reasoning requirements:
- reason must be 2-4 short sentences maximum.
- Write like someone who notices things but does not announce that they notice.
- No metaphors.
- Short sentences.
- If a sentence sounds like writing, cut it in half.
- Target tone: Hemingway, not Fitzgerald.
- Never use words like: journey, resonate, tapestry, yearning, delve, profound, captivating, narrative.
- Never be generic. Never say "since you like action, here's another action anime."
- If verdict is "no", name the specific reason it doesn't fit right now, then pivot straight into why "title" fits instead. Do not soften the "no."
- If verdict is "yes", the reason should still sound like a private observation, not encouragement.
- log_line must be a separate single quiet line distilled from the same observation, not a summary. It should stand alone.

The JSON shape must be exactly:
{
  "verdict": "yes" | "no",
  "queried_title": "string",
  "title": "string",
  "title_jp": "string",
  "year": number,
  "episodes": number,
  "genre": "string",
  "reason": "string",
  "log_line": "string"
}`;

export async function askEnVerdict({
  queriedTitles,
  mood,
  tasteProfile,
  recentPatterns,
  feedbackHistory,
  candidateList,
  onDelta
}) {
  const userPayload = {
    queriedTitles,
    mood: mood || "",
    tasteProfile,
    recentPatterns,
    feedbackHistory,
    candidateList
  };

  console.log("[En debug] exact verdict LLM user payload", userPayload);
  const content = await generateJsonWithProvider({
    systemPrompt: VERDICT_SYSTEM_PROMPT,
    userPayload
  });
  onDelta?.(content);

  const verdict = parseVerdict(content);
  console.log("[En debug] verdict LLM raw response text", content);
  console.log("[En debug] verdict LLM parsed", verdict);
  return verdict;
}

const CHOOSE_SYSTEM_PROMPT = `You are En, a quiet anime recommendation engine.
Return strict JSON only. Do not return markdown, commentary, prose outside JSON, or code fences.

The user has named two to four anime titles (queriedTitles) they are torn between watching tonight. They may have also given a mood, or a reason for narrowing it to these titles (the mood field; it can be empty).

Your job is to pick exactly ONE of queriedTitles. Never pick a title outside that list — every title on it is already something they're seriously considering, so you are choosing a winner, not rejecting the set or substituting something else.

Use the user's MyAnimeList history or raw watch history, taste profile, recent patterns, and feedback history, plus the mood if given, to decide which of queriedTitles fits best right now.
If malList is an array, it is sorted from most recently updated to oldest. Weight the most recent 10-15 entries much more heavily than the rest.
Use feedbackHistory as a taste signal. Good means the user liked that direction. Meh means avoid that direction unless the mood clearly asks for it. Pending is a positive signal.

"title" and "title_jp" must exactly match one of queriedTitles, in that title's canonical form. Do not invent a title that isn't on the list.

Reasoning requirements:
- reason must be 2-4 short sentences maximum, and must explicitly name at least one of the titles NOT chosen and say why it loses to the winner tonight. That comparison is the entire point — do not skip it.
- Write like someone who notices things but does not announce that they notice.
- No metaphors. Short sentences. If a sentence sounds like writing, cut it in half.
- Target tone: Hemingway, not Fitzgerald.
- Never use words like: journey, resonate, tapestry, yearning, delve, profound, captivating, narrative.
- Never be generic. Never say "since you like action, here's another action anime."
- log_line must be a separate single quiet line distilled from the same observation, not a summary. It should stand alone.

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

export async function askEnChoose({
  queriedTitles,
  mood,
  tasteProfile,
  recentPatterns,
  feedbackHistory,
  onDelta
}) {
  const userPayload = {
    queriedTitles,
    mood: mood || "",
    tasteProfile,
    recentPatterns,
    feedbackHistory
  };

  console.log("[En debug] exact choose LLM user payload", userPayload);
  const content = await generateJsonWithProvider({
    systemPrompt: CHOOSE_SYSTEM_PROMPT,
    userPayload
  });
  onDelta?.(content);

  const choice = parseRecommendation(content);
  console.log("[En debug] choose LLM raw response text", content);
  console.log("[En debug] choose LLM parsed", choice);
  return choice;
}

function parseVerdict(content) {
  const trimmed = content.trim();
  const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
  const parsed = JSON.parse(jsonText);
  parsed.title_jp ||= parsed.title;

  if (parsed.verdict !== "yes" && parsed.verdict !== "no") {
    throw new Error("En returned an invalid verdict value.");
  }

  for (const key of ["queried_title", "title", "title_jp", "genre", "reason", "log_line"]) {
    if (typeof parsed[key] !== "string" || !parsed[key]) {
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

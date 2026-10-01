import { debugLog } from "./debug.js";
import { requestEn } from "./llmProviders.js";

// Prompts live in api/_lib/prompts.js. These helpers shape the payload and
// validate the JSON that comes back.

export async function askEn(payload) {
  const userPayload = { ...payload, mood: payload.mood || "Surprise me" };
  debugLog("[En debug] exact LLM user payload", userPayload);
  const content = await requestEn("recommend", userPayload);

  const recommendation = parseRecommendation(content);
  debugLog("[En debug] LLM raw response text", content);
  debugLog("[En debug] LLM parsed recommendation", recommendation);
  return recommendation;
}

export async function askEnVerdict(payload) {
  const userPayload = { ...payload, mood: payload.mood || "" };
  debugLog("[En debug] exact verdict LLM user payload", userPayload);
  const content = await requestEn("verdict", userPayload);

  const verdict = parseVerdict(content);
  debugLog("[En debug] verdict LLM raw response text", content);
  debugLog("[En debug] verdict LLM parsed", verdict);
  return verdict;
}

export async function askEnChoose(payload) {
  const userPayload = { ...payload, mood: payload.mood || "" };
  debugLog("[En debug] exact choose LLM user payload", userPayload);
  const content = await requestEn("choose", userPayload);

  const choice = parseRecommendation(content);
  debugLog("[En debug] choose LLM raw response text", content);
  debugLog("[En debug] choose LLM parsed", choice);
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

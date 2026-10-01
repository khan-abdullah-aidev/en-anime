// Gemini structured-output schemas. Constraining "title" to the titles the
// client will accept turns "not in candidateList" from a retry into
// something the model can't produce. The client still validates everything.

import { AVOID_GENRES, MOOD_ERAS, MOOD_GENRES, MOOD_LENGTHS } from "../../src/moodVocabulary.js";

const STRING = { type: "STRING" };
const INTEGER = { type: "INTEGER" };
const PICK_FIELDS = ["title", "title_jp", "year", "episodes", "genre", "reason", "log_line"];

export function buildResponseSchema(kind, payload) {
  if (kind === "mood") return moodSchema();
  if (kind === "recommend" || kind === "together") {
    const schema = pickSchema(titlesFrom(payload.candidateList));
    // From two phones, the partner gets the reason addressed to them.
    if (kind === "together" && payload.bothPerspectives) {
      schema.properties.reason_for_them = STRING;
      schema.properties.log_line_for_them = STRING;
      schema.required = [...schema.required, "reason_for_them", "log_line_for_them"];
    }
    return schema;
  }
  if (kind === "choose") {
    return pickSchema(titlesFrom(payload.queriedTitles));
  }
  if (kind === "verdict") {
    const schema = pickSchema(titlesFrom([...(payload.queriedTitles || []), ...(payload.candidateList || [])]));
    schema.properties = {
      verdict: { type: "STRING", enum: ["yes", "no"] },
      queried_title: STRING,
      ...schema.properties
    };
    schema.required = ["verdict", "queried_title", ...schema.required];
    return schema;
  }
  return null;
}

// Genres are held to AniList's names here. The tag list (157 names, twice)
// made the schema too large for Gemini, which then answered without one, so
// tags are listed in the prompt instead and the client drops unknown names.
// Limits are required words with an "any" (see MOOD_LENGTHS).
function moodSchema() {
  const genres = (names) => ({ type: "ARRAY", items: { type: "STRING", enum: names } });
  const strings = { type: "ARRAY", items: STRING };
  return {
    type: "OBJECT",
    properties: {
      reading: STRING,
      genres: genres(MOOD_GENRES),
      tags: strings,
      avoidGenres: genres(AVOID_GENRES),
      avoidTags: strings,
      length: { type: "STRING", enum: MOOD_LENGTHS },
      era: { type: "STRING", enum: MOOD_ERAS },
      airing: { type: "BOOLEAN" }
    },
    required: ["reading", "genres", "tags", "avoidGenres", "avoidTags", "length", "era", "airing"]
  };
}

function pickSchema(allowedTitles) {
  return {
    type: "OBJECT",
    properties: {
      title: allowedTitles.length ? { type: "STRING", enum: allowedTitles } : STRING,
      title_jp: STRING,
      year: INTEGER,
      episodes: INTEGER,
      genre: STRING,
      reason: STRING,
      log_line: STRING
    },
    required: [...PICK_FIELDS]
  };
}

function titlesFrom(items) {
  const titles = (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === "string" ? item : item?.title))
    .filter((title) => typeof title === "string" && title.trim());
  return [...new Set(titles)];
}

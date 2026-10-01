// Gemini structured-output schemas. Constraining "title" to the titles the
// client will accept turns "not in candidateList" from a retry into
// something the model can't produce. The client still validates everything.

const STRING = { type: "STRING" };
const INTEGER = { type: "INTEGER" };
const PICK_FIELDS = ["title", "title_jp", "year", "episodes", "genre", "reason", "log_line"];

export function buildResponseSchema(kind, payload) {
  if (kind === "recommend" || kind === "together") {
    return pickSchema(titlesFrom(payload.candidateList));
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

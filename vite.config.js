import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const MAL_TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
const MAL_LIST_URL = "https://api.myanimelist.net/v2/users/@me/animelist";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), localApi(env)]
  };
});

function localApi(env) {
  return {
    name: "en-local-api",
    configureServer(server) {
      server.middlewares.use("/api/token-exchange", async (req, res, next) => {
        if (req.method === "OPTIONS") {
          writeJson(res, 204, "");
          return;
        }

        if (req.method !== "POST") {
          writeJson(res, 405, { error: "Method not allowed" });
          return;
        }

        try {
          const body = JSON.parse(await readBody(req));
          const { code, codeVerifier, redirectUri } = body;

          if (!code || !codeVerifier || !redirectUri) {
            writeJson(res, 400, {
              error: "Missing required fields: code, codeVerifier, redirectUri"
            });
            return;
          }

          const params = new URLSearchParams({
            client_id: env.MAL_CLIENT_ID,
            client_secret: env.MAL_CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri
          });

          const malResponse = await fetch(MAL_TOKEN_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params
          });

          res.statusCode = malResponse.status;
          res.setHeader("Content-Type", "application/json");
          res.end(await malResponse.text());
        } catch (error) {
          next(error);
        }
      });

      server.middlewares.use("/api/mal-list", async (req, res, next) => {
        if (req.method === "OPTIONS") {
          writeJson(res, 204, "", "GET, OPTIONS");
          return;
        }

        if (req.method !== "GET") {
          writeJson(res, 405, { error: "Method not allowed" }, "GET, OPTIONS");
          return;
        }

        const authorization = req.headers.authorization;
        if (!authorization?.startsWith("Bearer ")) {
          writeJson(res, 401, { error: "Missing MAL bearer token" }, "GET, OPTIONS");
          return;
        }

        try {
          const list = await fetchAnimeList(authorization);
          writeJson(res, 200, { data: list }, "GET, OPTIONS");
        } catch (error) {
          writeJson(
            res,
            error.statusCode || 500,
            { error: error.message || "Could not read your MAL list." },
            "GET, OPTIONS"
          );
        }
      });
    }
  };
}

async function fetchAnimeList(authorization) {
  const params = new URLSearchParams({
    fields: "id,title,mean,num_episodes,start_season,genres,list_status",
    limit: "1000",
    nsfw: "true",
    sort: "list_score"
  });

  const entries = [];
  let nextUrl = `${MAL_LIST_URL}?${params.toString()}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: { Authorization: authorization }
    });

    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || "Could not read your MAL list.");
      error.statusCode = response.status;
      throw error;
    }

    for (const item of payload.data || []) {
      entries.push(normalizeAnime(item));
    }

    nextUrl = payload.paging?.next || "";
  }

  return entries;
}

function normalizeAnime(item) {
  const node = item.node || {};
  const season = node.start_season;

  return {
    id: node.id,
    title: node.title,
    mean_score: node.mean ?? null,
    episodes: node.num_episodes ?? null,
    year: season?.year ?? null,
    season: season?.season ?? null,
    genres: (node.genres || []).map((genre) => genre.name),
    my_list_status: item.list_status || null
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, body, methods = "POST, OPTIONS") {
  res.statusCode = statusCode;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Content-Type", typeof body === "string" ? "text/plain" : "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

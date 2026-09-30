import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), localApi(env)]
  };
});

// Serves the same api/*.js handlers Vercel deploys, through a small shim for
// Vercel's req.query / req.body / res.status().json() helpers, so dev and
// production can't drift apart.
function localApi(env) {
  return {
    name: "en-local-api",
    configureServer(server) {
      for (const [key, value] of Object.entries(env)) {
        process.env[key] ??= value;
      }

      server.middlewares.use("/api", async (req, res, next) => {
        const url = new URL(req.url || "/", "http://localhost");
        const route = url.pathname.replace(/^\/+|\/+$/g, "");
        // Underscore-prefixed files (api/_lib) are helpers, not routes - same as Vercel.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(route) || !fs.existsSync(path.join(server.config.root, "api", `${route}.js`))) {
          next();
          return;
        }

        try {
          const { default: handler } = await server.ssrLoadModule(`/api/${route}.js`);
          await handler(await toVercelRequest(req, url), toVercelResponse(res));
        } catch (error) {
          next(error);
        }
      });
    }
  };
}

async function toVercelRequest(req, url) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    query[key] = key in query ? [query[key]].flat().concat(value) : value;
  }
  req.query = query;

  const raw = await readBody(req);
  if (raw && String(req.headers["content-type"] || "").includes("application/json")) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      req.body = undefined;
    }
  }
  return req;
}

function toVercelResponse(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = (body) => {
    res.end(body);
    return res;
  };
  return res;
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

// The browser tests' storage: the in-memory Upstash from tests/, over HTTP,
// so the dev server's real /api/room and /api/sync handlers have somewhere
// to keep things. Started by playwright.config.js.
import http from "node:http";
import { createFakeUpstash } from "../tests/fake-upstash.js";

const port = Number(process.env.PORT || 5198);
const upstash = createFakeUpstash();

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("fake upstash");
        return;
      }
      let answer;
      try {
        answer = upstash.respond(req.url, JSON.parse(body || "null"));
      } catch (error) {
        answer = { error: error.message };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  })
  .listen(port);

import { defineConfig, devices } from "@playwright/test";

// Browser tests for the screens (npm run test:e2e). The model, AniList and
// the sync server are stubbed in e2e/stubs.js, so these run offline and
// never touch real accounts. Not part of `npm test`, which Vercel runs on
// every build without a browser.
const PORT = 5199;
// A stand-in for Upstash, so /api/room and /api/sync work in the tests.
const STORAGE_PORT = 5198;

export default defineConfig({
  testDir: "e2e",
  timeout: 30000,
  fullyParallel: true,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: `node e2e/fake-upstash-server.js`,
      url: `http://localhost:${STORAGE_PORT}`,
      env: { PORT: String(STORAGE_PORT) },
      reuseExistingServer: false
    },
    {
      command: `npx vite --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      env: { KV_REST_API_URL: `http://localhost:${STORAGE_PORT}`, KV_REST_API_TOKEN: "e2e" },
      reuseExistingServer: false,
      timeout: 60000
    }
  ],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // A phone, with reduced motion on: the path without screen transitions.
    { name: "phone", use: { ...devices["Pixel 7"], reducedMotion: "reduce" } }
  ]
});

import { defineConfig, devices } from "@playwright/test";

// Browser tests for the screens (npm run test:e2e). The model, AniList and
// the sync server are stubbed in e2e/stubs.js, so these run offline and
// never touch real accounts. Not part of `npm test`, which Vercel runs on
// every build without a browser.
const PORT = 5199;

export default defineConfig({
  testDir: "e2e",
  timeout: 30000,
  fullyParallel: true,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // A phone, with reduced motion on: the path without screen transitions.
    { name: "phone", use: { ...devices["Pixel 7"], reducedMotion: "reduce" } }
  ]
});

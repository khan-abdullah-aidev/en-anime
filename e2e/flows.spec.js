import { expect, test } from "@playwright/test";
import { listEntry, stubServices } from "./stubs.js";

const DAY = 24 * 60 * 60 * 1000;

// Puts values in localStorage before the app first loads (and only then, so
// a reload in the test keeps whatever the app saved since).
async function seed(page, values) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    for (const [key, value] of Object.entries(entries)) {
      localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    }
  }, values);
}

const typedList = { "en.manualList": "Mushishi, Frieren", "en.activeMode": "manual" };

async function noSideScroll(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("a typed list gets one pick, read from tonight's mood, and the log keeps it", async ({ page }) => {
  const log = await stubServices(page);
  await page.goto("/");
  await expect(page.getByText("erenfrickinyeager")).toBeVisible();
  await noSideScroll(page);

  await page.getByRole("button", { name: "I'll tell En myself" }).click();
  await page.getByLabel(/Anime you've watched and loved/).fill("Mushishi, Frieren");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/tonight$/);
  await expect(page.getByRole("heading", { name: "How do you feel?" })).toBeVisible();
  await noSideScroll(page);

  await page.getByLabel(/How do you feel tonight/).fill("rain on a tuesday");
  await page.getByRole("button", { name: "Let En consider" }).click();
  await expect(page).toHaveURL(/\/pick\//);

  // The mood was read by the model and searched for on AniList.
  expect(log.en.find((body) => body.kind === "mood").payload.mood).toBe("rain on a tuesday");
  expect(log.anilist.some((query) => query.includes('tag_in: ["Iyashikei"]'))).toBe(true);

  const title = log.en.find((body) => body.kind === "recommend").payload.candidateList[0].title;
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(title);
  await expect(heading).toBeFocused();

  await page.getByRole("button", { name: "LOG" }).click();
  await expect(page.getByRole("heading", { name: "What En has chosen" })).toBeFocused();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  await noSideScroll(page);

  await page.getByRole("button", { name: "← back" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
});

test("genres left out stay out of every pick, and the choice is remembered", async ({ page }) => {
  const log = await stubServices(page);
  await seed(page, typedList);
  await page.goto("/tonight");

  await page.getByRole("button", { name: "or — leave some genres out" }).click();
  await page.getByRole("button", { name: "Horror", exact: true }).click();
  await expect(page.getByRole("button", { name: "Horror, left out" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "done" }).click();
  await expect(page.getByRole("button", { name: /leaving out Horror/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: /leaving out Horror/ })).toBeVisible();

  await page.getByRole("button", { name: "or — surprise me" }).click();
  await expect(page).toHaveURL(/\/pick\//);
  const candidates = log.en.find((body) => body.kind === "recommend").payload.candidateList;
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates.filter((candidate) => (candidate.genres || []).includes("Horror"))).toEqual([]);
  expect(log.anilist.some((query) => query.includes('genre_not_in: ["Horror"]'))).toBe(true);
  expect(log.en.some((body) => body.kind === "mood"), "no mood, nothing to read").toBe(false);
});

test("'Watching it' stops the question coming back every visit", async ({ page }) => {
  await stubServices(page);
  const old = new Date(Date.now() - 3 * DAY).toISOString();
  await seed(page, {
    ...typedList,
    "en.recommendationHistory": [
      {
        id: "old",
        date: old,
        updated_at: old,
        state: "unrated",
        feedback: "",
        note: "",
        recommendation: { title: "Link Click", title_jp: "时光代理人", year: 2021, episodes: 11, genre: "Drama", reason: "r", log_line: "l" }
      }
    ]
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Did you watch Link Click?" })).toBeVisible();
  await page.getByRole("button", { name: "Watching it" }).click();
  await expect(page).toHaveURL(/\/tonight$/);

  await page.goto("/");
  await expect(page).toHaveURL(/\/tonight$/);
  await page.getByRole("button", { name: "LOG" }).click();
  await expect(page.getByText("○ watching")).toBeVisible();
  await expect(page.getByRole("button", { name: "watching it" })).toHaveAttribute("aria-pressed", "true");
});

test("'What En knows about you' shows its evidence and takes corrections", async ({ page }) => {
  const list = [
    ...Array.from({ length: 6 }, (_, i) => listEntry(10 + i, `Quiet ${i}`, "COMPLETED", 9, ["Slice of Life", "Drama"])),
    ...Array.from({ length: 6 }, (_, i) => listEntry(30 + i, `Loud ${i}`, "COMPLETED", 5, ["Action"])),
    ...Array.from({ length: 4 }, (_, i) => listEntry(50 + i, `Dropped ${i}`, "DROPPED", 3, ["Action", "Horror"]))
  ];
  await stubServices(page, { aniListList: list });
  await seed(page, { "en.listSource": { kind: "anilist", username: "someone" }, "en.activeMode": "username" });

  await page.goto("/log");
  await page.getByRole("button", { name: "what En knows about you →" }).click();
  await expect(page).toHaveURL(/\/what-en-knows$/);
  await expect(page.getByRole("heading", { name: "About you" })).toBeFocused();
  await expect(page.getByText(/Read from your AniList list: 12 finished, 4 dropped/)).toBeVisible();

  const sliceOfLife = page.locator(".knows-row", { hasText: "Slice of Life" });
  await expect(sliceOfLife).toContainText("6 of your shows · scored 3.0 above your average");
  await sliceOfLife.getByRole("button", { name: "not really" }).click();
  await expect(page.getByText("You said these aren't you:")).toContainText("Slice of Life");

  const action = page.locator(".knows-row", { hasText: "Action" });
  await expect(action).toContainText("dropped 4 of 10");
  await action.getByRole("button", { name: "it's fine, actually" }).click();
  await expect(page.getByText("You said these are fine:")).toContainText("Action");

  await page.getByRole("button", { name: "Isekai", exact: true }).click();
  await expect(page.getByRole("button", { name: "Isekai, left out" })).toHaveAttribute("aria-pressed", "true");
  await noSideScroll(page);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("en.preferences")));
  expect(saved).toMatchObject({ notFavorite: ["Slice of Life"], notDisliked: ["Action"], excludedGenres: ["Isekai"] });
});

test("the share card comes out as an image", async ({ page }) => {
  // No share sheet here, so the card downloads.
  await page.addInitScript(() => {
    delete Navigator.prototype.share;
    delete Navigator.prototype.canShare;
  });
  await stubServices(page);
  await seed(page, typedList);
  await page.goto("/tonight");
  await page.getByRole("button", { name: "or — surprise me" }).click();
  await expect(page).toHaveURL(/\/pick\//);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "share this pick" }).click();
  expect((await download).suggestedFilename()).toMatch(/^en-[a-z0-9-]+\.png$/);
  await expect(page.getByRole("button", { name: "card saved · make another" })).toBeVisible();
});

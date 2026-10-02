import { expect, test } from "@playwright/test";
import { listEntry, media, stubServices } from "./stubs.js";

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

test("answers reach MyAnimeList, even for picks saved without a MAL id", async ({ page }) => {
  const log = await stubServices(page);
  const updates = [];
  await page.route("**/api/mal-list", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/mal-status", async (route) => {
    const body = route.request().postDataJSON();
    updates.push({ ...body, auth: route.request().headers().authorization });
    const already = body.action === "later";
    await route.fulfill({ json: already ? { changed: false, status: "plan_to_watch" } : { changed: true, status: "watching", from: null } });
  });
  const old = (days) => new Date(Date.now() - days * DAY).toISOString();
  const pick = (id, title, days, extra = {}) => ({
    id,
    date: old(days),
    updated_at: old(days),
    state: "unrated",
    feedback: "",
    note: "",
    recommendation: { title, title_jp: title, year: 2021, episodes: 11, genre: "Drama", reason: "r", log_line: "l", ...extra }
  });
  await seed(page, {
    "en.malTokens": { access_token: "test-token", refresh_token: "r" },
    "en.activeMode": "mal",
    "en.recommendationHistory": [pick("saved", "Odd Taxi", 2, { malId: 46102 }), pick("no-id", "Link Click", 5)]
  });

  // The question about the older pick: answered "Watching it", and asked once.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Did you watch Link Click?" })).toBeVisible();
  await page.getByRole("button", { name: "Watching it" }).click();
  await expect(page.getByRole("dialog", { name: "Update MyAnimeList too?" })).toBeVisible();
  await page.getByRole("button", { name: "yes, keep it in step" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Link Click: marked as watching on your MyAnimeList." })).toBeVisible();

  // Looked up on AniList (the stub gives idMal = id + 50000) and kept on the pick.
  expect(log.anilist.some((query) => query.includes("search:"))).toBe(true);
  expect(updates[0]).toMatchObject({ action: "tonight", auth: "Bearer test-token" });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("en.recommendationHistory")).find((entry) => entry.id === "no-id"));
  expect(saved.recommendation.malId).toBe(updates[0].malId);

  // From the log: "later" on a pick MAL already has as plan-to-watch.
  await page.goto("/log");
  const oddTaxi = page.locator("article", { hasText: "Odd Taxi" });
  await oddTaxi.getByRole("button", { name: "later" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your MyAnimeList already has Odd Taxi as plan to watch, so En left it." })).toBeVisible();
  expect(updates[1]).toMatchObject({ malId: 46102, action: "later" });
});

test("two phones, one pick: a link, both lists and moods, the same pick on each", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "it's two browsers already; one run is enough");
  const baseURL = testInfo.project.use.baseURL;
  const host = await (await browser.newContext({ baseURL })).newPage();
  const guest = await (await browser.newContext({ baseURL })).newPage();
  const hostLog = await stubServices(host);
  await stubServices(guest);
  await seed(host, typedList);

  // The host makes the link.
  await host.goto("/together");
  await host.getByRole("button", { name: "or — send them a link, from their own phone" }).click();
  await host.getByLabel("Your name, so they know who's asking").fill("Abdullah");
  await host.getByRole("button", { name: "Make the link" }).click();
  await expect(host).toHaveURL(/\/with\/[A-Za-z0-9_-]{20}$/);
  await expect(host.getByRole("heading", { name: "Send them this link" })).toBeVisible();
  const link = await host.locator(".room-link").textContent();
  expect(link).toBe(host.url());

  // Someone new to En opens it and adds their own list and mood.
  await guest.goto(link);
  await expect(guest.getByRole("heading", { name: "Abdullah wants to pick something to watch with you" })).toBeVisible();
  await guest.getByRole("button", { name: "or — type it" }).click();
  await guest.getByLabel(/Anime you've watched and loved/).fill("Barakamon, Yuru Camp");
  await guest.getByLabel("What should Abdullah call you?").fill("Sam");
  await guest.getByLabel("What are you in the mood for? Optional.").fill("something funny");
  await guest.getByRole("button", { name: "Send to Abdullah" }).click();
  await expect(guest.getByRole("heading", { name: "Abdullah is choosing" })).toBeVisible();

  // The host sees them arrive, says their own mood, and En picks for both.
  await expect(host.getByRole("heading", { name: "Sam is in" })).toBeVisible({ timeout: 10000 });
  await expect(host.getByText("They're in the mood for “something funny”.")).toBeVisible();
  await host.getByLabel("What are you in the mood for? Optional.").fill("rain on a tuesday");
  await host.getByRole("button", { name: "Let En choose for two" }).click();
  await expect(host).toHaveURL(/\/pick\//);

  const together = () => hostLog.en.filter((body) => body.kind === "together").map((body) => body.payload);
  expect(together()[0]).toMatchObject({ mood: "rain on a tuesday", userName: "Abdullah", bothPerspectives: true, partner: { name: "Sam", mood: "something funny" } });
  expect(hostLog.en.find((body) => body.kind === "mood").payload).toMatchObject({ mood: "rain on a tuesday", partnerMood: "something funny" });
  const title = together()[0].candidateList[0].title;
  await expect(host.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(host.getByText("You loved Mushishi. This one moves at the same pace.")).toBeVisible();

  // The same pick on the other phone, explained to them.
  await expect(guest).toHaveURL(/\/pick\//, { timeout: 10000 });
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(guest.getByText("You loved Barakamon. Abdullah loved Mushishi. This sits between.")).toBeVisible();
  await expect(guest.getByText("・ for you and Abdullah")).toBeVisible();

  // Their "not tonight" reaches the host's phone, which picks again for both.
  await guest.getByRole("button", { name: "or — not tonight" }).click();
  await guest.getByRole("button", { name: "too heavy" }).click();
  await expect(guest.getByRole("heading", { name: "Told Abdullah" })).toBeVisible();
  await expect(host.getByRole("status").filter({ hasText: "Sam passed on" })).toBeVisible({ timeout: 10000 });
  await expect.poll(() => together().length, { timeout: 15000 }).toBe(2);
  expect(together()[1].passedOverTonight).toEqual([{ title, reason: "too heavy" }]);
  const second = together()[1].candidateList[0].title;
  expect(second).not.toBe(title);
  await expect(host.getByRole("heading", { level: 1 })).toHaveText(second);
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText(second, { timeout: 10000 });

  // Each phone keeps it in its own log.
  await guest.getByRole("button", { name: "LOG" }).click();
  await expect(guest.getByText("for two · with Abdullah").first()).toBeVisible();
});

test("En learns from every pick, past ones included, and shows what it's learned", async ({ page }) => {
  // Past picks saved before En kept what each pick was: quiet ones landed, psychological ones didn't.
  const quiet = { genres: ["Slice of Life"], tags: [{ name: "Iyashikei", rank: 90 }] };
  const heady = { genres: ["Psychological"], tags: [{ name: "Philosophy", rank: 90 }] };
  const log = await stubServices(page, { mediaById: (id) => media(id, `Past ${id}`, id % 2 ? heady : quiet) });
  const past = (id, feedback, days) => {
    const date = new Date(Date.now() - days * DAY).toISOString();
    return {
      id: `past-${id}`,
      date,
      updated_at: date,
      state: "rated",
      feedback,
      note: "",
      recommendation: { title: `Past ${id}`, title_jp: `Past ${id}`, year: 2019, episodes: 12, genre: "Drama", reason: "r", log_line: "l", anilistId: id }
    };
  };
  await seed(page, {
    ...typedList,
    "en.recommendationHistory": [past(2, "good", 2), past(1, "meh", 3), past(4, "good", 4), past(3, "meh", 5), past(6, "good", 6), past(5, "meh", 7), past(8, "good", 8)]
  });

  await page.goto("/what-en-knows");
  const learned = page.locator("section", { has: page.getByText("What En has learned", { exact: true }) });
  await expect(learned.getByText("Every past pick counts, not just new ones.")).toBeVisible({ timeout: 15000 });
  await expect(learned.getByText("From 7 picks you've answered. 4 of 7 landed so far.", { exact: false })).toBeVisible();
  await expect(learned.locator(".hit-dot")).toHaveCount(7);
  const iyashikei = learned.locator(".knows-row", { hasText: "Iyashikei" });
  await expect(iyashikei).toContainText("4 of 4 landed");
  await expect(learned.locator(".knows-row", { hasText: "Psychological" })).toContainText("3 of 3 missed");
  expect(log.anilist.filter((query) => query.includes("id_in: $ids")).length).toBe(1);

  // Next pick, the model is told what En has learned.
  await page.goto("/tonight");
  await page.getByRole("button", { name: "or — surprise me" }).click();
  await expect(page).toHaveURL(/\/pick\//);
  const payload = log.en.find((body) => body.kind === "recommend").payload;
  expect(payload.learned.answeredPicks).toBe(7);
  expect(payload.learned.landed).toContain("Iyashikei (4 of 4 landed)");

  // And anything it learned can be forgotten.
  await page.goto("/what-en-knows");
  await learned.locator(".knows-row", { hasText: "Iyashikei" }).getByRole("button", { name: "forget this" }).click();
  await expect(learned.locator(".knows-row", { hasText: "Iyashikei" })).toHaveCount(0);
  await expect(learned.getByRole("button", { name: /bring them back/ })).toBeVisible();
});

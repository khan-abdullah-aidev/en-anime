// Renders the trailer frame by frame: index.html draws any moment with
// renderAt(t), Chromium captures it, ffmpeg encodes it.
//
//   node trailer/render.mjs stills [--tall] 3.2 14.9 33.5   PNGs to out/stills
//   node trailer/render.mjs video [--tall] [--fps 60] [--workers 3] [--keep 1]
//        --keep N reuses the first N segments already rendered (when only later scenes changed)
//   node trailer/render.mjs final [--tall]                  grain, colour, score → out/*.mp4
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
const args = process.argv.slice(2);
const mode = args[0];
const tall = args.includes("--tall");
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const fps = Number(opt("--fps", 60));
const workers = Number(opt("--workers", 3));
const cut = tall ? "tall" : "wide";
const [W, H] = tall ? [1080, 1920] : [1920, 1080];
const pageUrl = pathToFileURL(path.join(here, "index.html")).href + `?render${tall ? "&tall" : ""}`;

fs.mkdirSync(path.join(outDir, "stills"), { recursive: true });
fs.mkdirSync(path.join(outDir, "segments"), { recursive: true });

// The poster is the studio's art, so it isn't kept in git: fetch it from AniList when missing.
async function ensurePoster() {
  const file = path.join(here, "assets", "mushishi.png");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ Media(id: 457, type: ANIME) { coverImage { extraLarge } } }" })
  });
  const url = (await res.json()).data.Media.coverImage.extraLarge;
  fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  console.log("fetched", file);
}

function framesIn(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", (c) => (c === 0 ? resolve(parseInt(out.trim(), 10)) : reject(new Error("ffprobe " + c))));
  });
}
const segmentFile = (k) => path.join(outDir, "segments", `${cut}-${String(k).padStart(2, "0")}.mkv`);

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.error("page error:", err.message));
  await page.goto(pageUrl, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => window.ready);
  const cdp = await page.context().newCDPSession(page);
  const shot = async (t) => {
    await page.evaluate((x) => window.renderAt(x), t);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
    return Buffer.from(data, "base64");
  };
  const duration = await page.evaluate(() => window.CUES.duration);
  return { page, shot, duration };
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function stills() {
  const times = args.slice(1).filter((a) => /^\d/.test(a)).map(Number);
  const browser = await chromium.launch();
  const { shot } = await openPage(browser);
  for (const t of times) {
    const file = path.join(outDir, "stills", `${cut}-${t.toFixed(2)}.png`);
    fs.writeFileSync(file, await shot(t));
    console.log(file);
  }
  await browser.close();
}

async function video() {
  const browser = await chromium.launch();
  const probe = await openPage(browser);
  const total = Math.round(probe.duration * fps);
  await probe.page.close();
  const keep = Number(opt("--keep", 0));
  const kept = [];
  let start = 0;
  for (let k = 0; k < keep; k++) {
    kept.push(segmentFile(k));
    start += await framesIn(segmentFile(k));
  }
  if (keep) console.log(`reusing ${start} frames from ${keep} segment(s)`);
  const per = Math.ceil((total - start) / workers);
  const started = Date.now();
  let done = 0;
  const jobs = [];
  for (let k = 0; k < workers; k++) {
    const from = start + k * per;
    const to = Math.min(total, from + per);
    if (from >= to) continue;
    jobs.push(
      (async () => {
        const { shot } = await openPage(browser);
        const file = segmentFile(keep + k);
        // Lossless RGB in between, so colour is converted exactly once, at the end.
        const ff = spawn("ffmpeg", [
          "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
          "-c:v", "libx264rgb", "-preset", "ultrafast", "-crf", "0", file
        ], { stdio: ["pipe", "inherit", "inherit"] });
        const finished = new Promise((resolve, reject) => ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg " + c)))));
        for (let f = from; f < to; f++) {
          const buf = await shot(f / fps);
          if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
          done++;
          if (done % 120 === 0) {
            const s = (Date.now() - started) / 1000;
            console.log(`${done}/${total - start} frames · ${(done / s).toFixed(1)} fps · ~${Math.round(((total - start - done) * s) / done)}s left`);
          }
        }
        ff.stdin.end();
        await finished;
        return file;
      })()
    );
  }
  const files = [...kept, ...(await Promise.all(jobs))];
  await browser.close();
  fs.writeFileSync(
    path.join(outDir, "segments", `${cut}.txt`),
    files.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n")
  );
  console.log(`${total - start} frames in ${Math.round((Date.now() - started) / 1000)}s`);
}

async function final() {
  const list = path.join(outDir, "segments", `${cut}.txt`);
  const score = path.join(outDir, "score.wav");
  const file = path.join(outDir, `En-trailer-${tall ? "9x16" : "16x9"}.mp4`);
  // Fine monochrome grain, BT.709 throughout so the vermilion holds its colour.
  const vf = [
    "noise=c0s=4:c0f=t+u",
    "scale=out_color_matrix=bt709:out_range=tv",
    "format=yuv420p"
  ].join(",");
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-stats",
    "-f", "concat", "-safe", "0", "-i", list,
    "-i", score,
    "-map", "0:v", "-map", "1:a",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-tune", "film", "-profile:v", "high",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
    "-movflags", "+faststart", "-shortest",
    file
  ]);
  console.log(file);
}

if (mode === "stills" || mode === "video") await ensurePoster();
if (mode === "stills") await stills();
else if (mode === "video") await video();
else if (mode === "final") await final();
else console.log("usage: node trailer/render.mjs stills|video|final [--tall]");

// The share card: tonight's pick as an image (cover, title, En's reason),
// drawn on a canvas in the app's own type and colors, then handed to the
// phone's share sheet, or downloaded where there isn't one.
const W = 1080;
const H = 1350;
const PAD = 88;
const COLORS = {
  ink: "#0d0c0b",
  bone: "#ebe6dc",
  bone2: "rgba(235, 230, 220, 0.78)",
  bone3: "rgba(235, 230, 220, 0.55)",
  bone4: "rgba(235, 230, 220, 0.32)",
  hairline: "rgba(235, 230, 220, 0.16)",
  shu: "#b8533f"
};
const SERIF = '"Cormorant Garamond", "EB Garamond", Georgia, serif';
const SANS = '"Inter", "Segoe UI", system-ui, sans-serif';
const JP = '"Noto Serif JP", "Cormorant Garamond", serif';

export async function sharePick(entry) {
  const pick = entry.recommendation;
  const blob = await makeShareCard(entry);
  const name = `en-${slug(pick.title) || "pick"}.png`;
  const file = new File([blob], name, { type: "image/png" });
  const text = `En picked ${pick.title} for me${entry.mode === "together" ? ` and ${entry.partner_name || "a friend"}` : ""}. ${window.location.origin}`;

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: pick.title, text });
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
      // Some share targets refuse files; a download still works.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return "downloaded";
}

export async function makeShareCard(entry) {
  const pick = entry.recommendation;
  const reason = clean(pick.reason || pick.log_line);
  await loadFonts(pick, reason);

  const cover = await loadImage(pick.image_url);
  try {
    return await draw(entry, reason, cover);
  } catch (error) {
    // A cover that wasn't served for canvas use taints it; go without.
    if (cover && error?.name === "SecurityError") return draw(entry, reason, null);
    throw error;
  }
}

async function draw(entry, reason, cover) {
  const pick = entry.recommendation;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.28, H * 0.34, 40, W * 0.28, H * 0.34, 900);
  glow.addColorStop(0, "rgba(184, 83, 63, 0.10)");
  glow.addColorStop(1, "rgba(13, 12, 11, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Header: the wordmark, and what En is.
  text(ctx, "縁", PAD, 122, { font: `300 40px ${JP}`, color: COLORS.shu });
  text(ctx, "En", PAD + 54, 120, { font: `italic 300 42px ${SERIF}`, color: COLORS.bone });
  text(ctx, "AN ANIME SOMMELIER", W - PAD, 112, { font: `400 18px ${SANS}`, color: COLORS.bone4, align: "right", spacing: 5 });

  // Cover.
  const box = { x: PAD, y: 188, w: 400, h: 570 };
  if (cover) {
    const scale = Math.max(box.w / cover.width, box.h / cover.height);
    const sw = box.w / scale;
    const sh = box.h / scale;
    ctx.drawImage(cover, (cover.width - sw) / 2, (cover.height - sh) / 2, sw, sh, box.x, box.y, box.w, box.h);
  } else {
    // The app's own placeholder: fine vermillion hatching.
    ctx.fillStyle = "#15130f";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.strokeStyle = "rgba(184, 83, 63, 0.12)";
    ctx.lineWidth = 1.5;
    for (let offset = -box.h; offset < box.w; offset += 20) {
      ctx.beginPath();
      ctx.moveTo(box.x + offset, box.y + box.h);
      ctx.lineTo(box.x + offset + box.h, box.y);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.strokeStyle = COLORS.hairline;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(box.x + 0.75, box.y + 0.75, box.w - 1.5, box.h - 1.5);

  // Beside the cover: what kind of pick, the title, the Japanese title, the facts.
  const x = box.x + box.w + 56;
  const width = W - PAD - x;
  let y = box.y + 20;
  y = paragraph(ctx, eyebrow(entry), x, y, width, { font: `400 19px ${SANS}`, color: COLORS.shu, lineHeight: 30, maxLines: 2, spacing: 4.5 });
  y += 34;
  y = paragraph(ctx, pick.title, x, y + 38, width, { font: `italic 300 66px ${SERIF}`, color: COLORS.bone, lineHeight: 68, maxLines: 5 });
  if (pick.title_jp && pick.title_jp !== pick.title) {
    y = paragraph(ctx, pick.title_jp, x, y + 52, width, { font: `300 26px ${JP}`, color: COLORS.bone3, lineHeight: 38, maxLines: 2 });
  }
  paragraph(ctx, facts(pick).toUpperCase(), x, y + 50, width, { font: `300 19px ${SANS}`, color: COLORS.bone3, lineHeight: 30, maxLines: 2, spacing: 3 });

  // En's reason, under everything.
  const reasonTop = box.y + box.h + 78;
  ctx.fillStyle = COLORS.hairline;
  ctx.fillRect(PAD, reasonTop - 40, 56, 1.5);
  paragraph(ctx, reason, PAD, reasonTop + 16, W - PAD * 2, { font: `italic 300 38px ${SERIF}`, color: COLORS.bone2, lineHeight: 54, maxLines: 6 });

  // Footer.
  ctx.fillStyle = COLORS.hairline;
  ctx.fillRect(PAD, H - 146, W - PAD * 2, 1.5);
  text(ctx, "One anime. Chosen for tonight.", PAD, H - 92, { font: `italic 300 28px ${SERIF}`, color: COLORS.bone3 });
  text(ctx, window.location.host.toUpperCase(), W - PAD, H - 96, { font: `300 17px ${SANS}`, color: COLORS.bone4, align: "right", spacing: 4 });

  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't make the card."))), "image/png");
    } catch (error) {
      reject(error);
    }
  });
}

function eyebrow(entry) {
  const pick = entry.recommendation;
  if (pick.resume) return "PICKED BACK UP";
  if (entry.mode === "together") return `FOR TWO, WITH ${(entry.partner_name || "A FRIEND").toUpperCase()}`;
  if (entry.mode === "choose") return pick.chooseAgainst?.length ? `CHOSEN OVER ${pick.chooseAgainst.join(", ").toUpperCase()}` : "CHOSEN FROM A SHORTLIST";
  if (pick.verdict === "yes") return "YES, TONIGHT";
  if (pick.verdict === "no") return `NOT ${String(pick.queried_title || "THAT").toUpperCase()}. THIS INSTEAD`;
  return `FOR TONIGHT · ${formatDay(entry.date).toUpperCase()}`;
}

function facts(pick) {
  const parts = [pick.year];
  if (pick.episodes === 1) parts.push("film");
  else if (pick.episodes) parts.push(`${pick.episodes} episodes`);
  if (pick.genre) parts.push(pick.genre);
  return parts.filter(Boolean).join(" · ");
}

function text(ctx, value, x, y, { font, color, align = "left", spacing = 0 }) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  setSpacing(ctx, spacing);
  ctx.fillText(value, x, y);
  setSpacing(ctx, 0);
}

// Wraps text into at most maxLines lines (the last one ellipsized) and
// returns the baseline of the last line drawn.
function paragraph(ctx, value, x, y, width, { font, color, lineHeight, maxLines, spacing = 0 }) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  setSpacing(ctx, spacing);
  const lines = wrap(ctx, String(value || ""), width, maxLines);
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
  setSpacing(ctx, 0);
  return y + Math.max(0, lines.length - 1) * lineHeight;
}

function wrap(ctx, value, width, maxLines) {
  // Words where there are spaces; single characters for Japanese.
  const tokens = value.split(/(\s+)/).flatMap((token) => (ctx.measureText(token).width > width ? [...token] : [token]));
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const next = line + token;
    if (line && ctx.measureText(next.trimEnd()).width > width) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.replace(/[\s,.;:]+$/, "")}…`;
  return kept;
}

function setSpacing(ctx, px) {
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`;
}

async function loadFonts(pick, reason) {
  if (!document.fonts?.load) return;
  const loads = [
    document.fonts.load(`italic 300 66px "Cormorant Garamond"`, pick.title),
    document.fonts.load(`italic 300 38px "Cormorant Garamond"`, reason),
    document.fonts.load(`300 19px "Inter"`),
    document.fonts.load(`400 19px "Inter"`),
    document.fonts.load(`300 26px "Noto Serif JP"`, `${pick.title_jp || ""}縁`)
  ];
  // Fonts that don't arrive in time just fall back; the card still gets made.
  await Promise.race([Promise.allSettled(loads), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

function loadImage(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve(null), 8000);
    // AniList's and MAL's image servers allow this, so the canvas stays
    // exportable. The page's own <img> cached the cover without CORS headers
    // (AniList only sends them when asked), so the card asks for its own copy.
    image.crossOrigin = "anonymous";
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    image.src = `${url}${url.includes("?") ? "&" : "?"}en-card`;
  });
}

function clean(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`>#]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatDay(date) {
  const parsed = new Date(date || Date.now());
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(
    Number.isNaN(parsed.getTime()) ? new Date() : parsed
  );
}

function slug(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

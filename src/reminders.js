// "Remind me about saved picks": a notification on a quiet evening about a
// pick saved for later. There's no server behind it: the service worker
// (public/sw.js) wakes up on its own through Periodic Background Sync, which
// Chrome only allows for an installed app, and reads what this file leaves
// for it in the cache. Per device, so not synced.

const SETTING_KEY = "en.reminders";
const SHELL = "en-shell-v1";
const REMINDER_KEY = "/__en/reminder";
const TAG = "en-saved-reminder";
const EVERY_MS = 12 * 60 * 60 * 1000;

export function remindersSupported() {
  return typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "Notification" in window &&
    typeof ServiceWorkerRegistration !== "undefined" &&
    "periodicSync" in ServiceWorkerRegistration.prototype;
}

export function remindersOn() {
  try {
    return localStorage.getItem(SETTING_KEY) === "on";
  } catch {
    return false;
  }
}

function saveSetting(on) {
  try {
    if (on) localStorage.setItem(SETTING_KEY, "on");
    else localStorage.removeItem(SETTING_KEY);
  } catch {
    // storage unavailable; the setting lasts for this visit
  }
}

// Returns { ok: true } or { ok: false, reason } in words for the user.
export async function turnOnReminders(history) {
  if (!remindersSupported()) return { ok: false, reason: "This browser can't remind you on its own. Chrome on Android or desktop can, once En is installed." };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "Notifications are blocked for En in this browser's settings." };
  const registration = await navigator.serviceWorker.ready;
  const allowed = await navigator.permissions?.query({ name: "periodic-background-sync" }).catch(() => null);
  if (allowed && allowed.state !== "granted") {
    return { ok: false, reason: "Install En first (your browser's menu, then Install or Add to Home screen), then turn this on." };
  }
  try {
    await registration.periodicSync.register(TAG, { minInterval: EVERY_MS });
  } catch {
    return { ok: false, reason: "Install En first (your browser's menu, then Install or Add to Home screen), then turn this on." };
  }
  saveSetting(true);
  await leaveReminder(history);
  return { ok: true };
}

export async function turnOffReminders() {
  saveSetting(false);
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.periodicSync?.unregister(TAG);
  } catch {
    // nothing registered
  }
  await writeReminder({ enabled: false });
}

// The saved pick to remind about: the longest-waiting one.
export function reminderPick(history = []) {
  return history
    .filter((entry) => entry.state === "pending")
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0] || null;
}

// Keeps what the service worker reads in step with the log.
export async function leaveReminder(history) {
  if (!remindersOn()) return;
  const pick = reminderPick(history);
  await writeReminder({ enabled: true, title: pick?.recommendation?.title || "", entryId: pick?.id || "" });
}

async function writeReminder(fields) {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(SHELL);
    const previous = await cache.match(REMINDER_KEY).then((response) => response?.json()).catch(() => null);
    const next = { lastShownAt: previous?.lastShownAt || 0, ...fields };
    await cache.put(REMINDER_KEY, new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } }));
  } catch {
    // cache storage unavailable (private mode); no reminders on this device
  }
}

// En's service worker: opens instantly (and offline) from the home screen,
// and reminds about a saved pick on a quiet evening when the user asked for
// that. Never caches /api (picks, sync, MAL) or /_vercel (analytics).

const SHELL = "en-shell-v1";
const REMINDER_KEY = "/__en/reminder";
const REMINDER_GAP_MS = 3 * 24 * 60 * 60 * 1000;

// The page and the built files it loads (read from it, since their names
// change with every build), so the very first visit already works offline.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(["/site.webmanifest", "/favicon-32x32.png", "/android-chrome-192x192.png"]);
      const page = await fetch("/", { cache: "no-cache" });
      const html = await page.clone().text();
      await cache.put("/", page);
      const built = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]))];
      await cache.addAll(built);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("en-shell-") && key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/_vercel/") || url.pathname === REMINDER_KEY) return;

  // Pages: the network first, so a deploy shows up at once; the last copy
  // when offline. Every screen is the same index.html.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(SHELL).then((cache) => cache.put("/", response.clone()));
          return response;
        })
        .catch(() => caches.match("/", { ignoreVary: true }))
    );
    return;
  }

  // Built files have their hash in the name, so a cached one never goes stale.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) caches.open(SHELL).then((cache) => cache.put(request, response.clone()));
        return response;
      }))
    );
    return;
  }

  // Icons and the rest: the cached copy now, a fresh one for next time.
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      const fresh = fetch(request).then((response) => {
        if (response.ok) caches.open(SHELL).then((cache) => cache.put(request, response.clone()));
        return response;
      });
      return cached || fresh;
    })
  );
});

// ---------- reminders (see reminders.js) ----------

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "en-saved-reminder") event.waitUntil(remindIfDue());
});

async function remindIfDue(now = Date.now()) {
  const cache = await caches.open(SHELL);
  const stored = await cache.match(REMINDER_KEY);
  if (!stored) return;
  const reminder = await stored.json();
  const hour = new Date(now).getHours();
  if (!reminder.enabled || !reminder.title || hour < 18 || hour > 22) return;
  if (now - (reminder.lastShownAt || 0) < REMINDER_GAP_MS) return;
  await self.registration.showNotification("En", {
    body: `${reminder.title} is still waiting, whenever tonight is the night.`,
    icon: "/android-chrome-192x192.png",
    badge: "/favicon-32x32.png",
    tag: "en-saved-reminder",
    data: { url: reminder.entryId ? `/pick/${reminder.entryId}` : "/" }
  });
  await cache.put(REMINDER_KEY, new Response(JSON.stringify({ ...reminder, lastShownAt: now }), { headers: { "Content-Type": "application/json" } }));
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      return open ? open.navigate(url).then((client) => client?.focus()) : self.clients.openWindow(url);
    })
  );
});

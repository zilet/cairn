const CACHE = "cairn-v104";
// Generated artwork lives in its own cache: the images are content-keyed and
// immutable on the server, so they stay valid across app deploys. Keeping them
// out of the versioned CACHE (and off the activate-cleanup list) means a deploy
// never re-downloads them — a slick, instant paint on every open.
const ART_CACHE = "cairn-art-v1";
const CORE_ASSETS = [
  "/", "/index.html", "/styles.css",
  "/js/01-core.js", "/js/02-ui.js", "/js/03-today.js", "/js/04-capture.js",
  "/js/05-progress.js", "/js/06-coach-meals.js", "/js/07-me-health.js",
  "/js/08-me-records.js", "/js/09-plan-chat.js", "/js/settings-routes.js", "/js/10-boot.js",
  "/art.js", "/manifest.json",
];
const OPTIONAL_ASSETS = [
  // Vendored xterm.js for the in-app agent-login terminal (lazy-loaded by the
  // Settings → Agents "Connect" modal; precached so it also works offline-installed).
  "/vendor/xterm.js", "/vendor/xterm.css", "/vendor/xterm-addon-fit.js",
  "/favicon.ico",
  "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(CORE_ASSETS);
    await Promise.all(OPTIONAL_ASSETS.map((asset) => c.add(asset).catch(() => null)));
  }));
  // Single-user self-hosted app: a deploy should always be live on the next open,
  // never stranded behind a manual tap (which is how a client once fell ~40 cache
  // versions behind). Activate the new worker immediately; the page reloads itself
  // once on controllerchange (app.js), and chat drafts + in-flight turns persist so
  // the reload loses nothing.
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      // Drop stale app caches, but PRESERVE the art cache — its images are
      // immutable and expensive to regenerate, so they outlive a version bump.
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== ART_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Generated art: cache-first in the persistent ART_CACHE. The first successful
// load is stored; every later render/reload paints instantly from Cache Storage
// (and works offline). Only 200s are cached — a 204 (not generated yet) and any
// retry (&r=1) stay uncached so they re-fetch and pick up the image once it lands.
async function artCacheFirst(request) {
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && res.status === 200) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch {
    // Offline + uncached → surface an error so the <img> onerror keeps the SVG.
    return Response.error();
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "GET" && url.pathname === "/api/art") {
    e.respondWith(artCacheFirst(e.request));
    return;
  }
  // Never cache the rest of API or MCP — always hit network.
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/mcp")) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
// Legacy compatibility: the app now calls skipWaiting at install and reloads once
// on controllerchange, but older open pages may still send this message.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting" || (e.data && e.data.type === "skipWaiting")) self.skipWaiting();
});

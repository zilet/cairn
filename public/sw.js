// The cache version is DERIVED, never hand-bumped. src/swVersion.ts hashes the
// bytes of every asset listed in CORE_ASSETS + OPTIONAL_ASSETS below (plus this
// file), and the server rewrites this literal to `cairn-<hash>` when it serves
// /sw.js. So any change to a precached asset ships a new cache name by
// construction, and an unchanged shell keeps the name it had.
//
// The literal below is the fallback for anything reading this file straight off
// disk (a dev static server, an offline checkout). Keep it EXACTLY as written —
// scripts/check-sw-cache.mjs asserts the placeholder is present, and the server
// substitutes it by exact match.
const CACHE = "cairn-shell-dev";
// Generated artwork lives in its own cache: the images are content-keyed and
// immutable on the server, so they stay valid across app deploys. Keeping them
// out of the versioned CACHE (and off the activate-cleanup list) means a deploy
// never re-downloads them — a slick, instant paint on every open.
const ART_CACHE = "cairn-art-v1";
const CORE_ASSETS = [
  "/", "/index.html", "/styles.css",
  "/js/bundle-01-core.js", "/js/bundle-02-today.js", "/js/bundle-03-capture-progress.js", "/js/bundle-04-coach-meals.js", "/js/bundle-05-me-health.js", "/js/bundle-06-chat-plan.js", "/js/bundle-07-settings-boot.js",
  "/art.js", "/cairn-body-figure.js", "/manifest.json",
];
const OPTIONAL_ASSETS = [
  // Vendored xterm.js for the in-app agent-login terminal (lazy-loaded by the
  // Settings → Agents "Connect" modal; precached so it also works offline-installed).
  "/vendor/xterm.js", "/vendor/xterm.css", "/vendor/xterm-addon-fit.js",
  "/favicon.ico",
  // Versioned icon set (…v2): bump the suffix in manifest.json + index.html + here
  // together whenever an icon's bytes change, so the new url busts every cache layer.
  "/icons/icon.v2.svg", "/icons/apple-touch-icon.v2.png", "/icons/mask-icon.v2.svg",
  "/icons/favicon-16.v2.png", "/icons/favicon-32.v2.png",
  "/icons/icon-192.v2.png", "/icons/icon-512.v2.png",
  "/icons/icon-192-maskable.v2.png", "/icons/icon-512-maskable.v2.png",
  "/icons/og.v2.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    // Bypass the HTTP cache on install: a browser-cached (not just service-worker
    // cached) response for these urls would otherwise defeat the whole point of
    // fetching fresh precache bytes on every version bump.
    await c.addAll(CORE_ASSETS.map((u) => new Request(u, { cache: "reload" })));
    await Promise.all(OPTIONAL_ASSETS.map((asset) => c.add(new Request(asset, { cache: "reload" })).catch(() => null)));
  }));
  // Single-user self-hosted app: a deploy should always be live on the next open,
  // never stranded behind a manual tap (which is how a client once fell ~40 cache
  // versions behind). Activate the new worker immediately; the page reloads itself
  // once on controllerchange (app shell), and chat drafts + in-flight turns persist so
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

// Generated art: cache-first in the persistent ART_CACHE, keyed by the full
// request URL (so `v=` is part of the identity). Only 200s are cached — a 204
// (not generated yet) stays uncached so the next try can pick the image up.
// `&r=1` is just another URL; a 200 for it WOULD be cached. Prefer `v=` for
// busting. When a 200 for v=N lands, older v<N entries for the same kind+q
// are evicted so the art cache does not grow unbounded.
//
// Eviction helpers are mirrored from src/artCachePolicy.ts (classic SW cannot
// import that module). Keep them in sync.
function artCacheIdentity(url) {
  try {
    const parsed = new URL(url, "http://cairn.local");
    if (parsed.pathname !== "/api/art") return null;
    const kind = parsed.searchParams.get("kind") || "";
    const q = parsed.searchParams.get("q") || "";
    if (!kind || !q) return null;
    const raw = parsed.searchParams.get("v");
    const v = raw == null || raw === "" ? 0 : Number(raw);
    return { kind, q, v: Number.isFinite(v) && v > 0 ? v : 0 };
  } catch {
    return null;
  }
}
function shouldEvictCachedArt(cachedUrl, incomingUrl) {
  const incoming = artCacheIdentity(incomingUrl);
  const cached = artCacheIdentity(cachedUrl);
  if (!incoming || !cached) return false;
  if (incoming.kind !== cached.kind || incoming.q !== cached.q) return false;
  return cached.v < incoming.v;
}
async function artCacheFirst(request) {
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && res.status === 200) {
      cache.put(request, res.clone()).catch(() => {});
      cache.keys().then((keys) => {
        for (const req of keys) {
          if (shouldEvictCachedArt(req.url, request.url)) cache.delete(req);
        }
      }).catch(() => {});
    }
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
  if (e.request.mode === "navigate") {
    // Cache-FIRST for the app shell. The installed PWA opens over a tailnet that
    // may be asleep or flapping, and a network-first navigation blocks on fetch("/")
    // until the OS gives up — tens of seconds of white screen before the identical
    // cached shell would have been served. The precached /index.html is the same
    // bytes the network would return for this CACHE version, so waiting buys nothing.
    //
    // A deploy still lands on the next open, one layer up: the browser re-fetches
    // sw.js itself (never from this handler — sw.js is served no-cache and the
    // registration.update() in app/sw-recovery.ts runs on resume), the new worker
    // precaches the new shell and skipWaiting()s, clients.claim() fires
    // controllerchange, and the page reloads once. THAT reload is a navigation
    // answered from the NEW cache. So the shell is always instant and never stale
    // by more than the one reload the update flow already performs.
    e.respondWith(caches.match("/index.html").then((r) => r || fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
// Legacy compatibility: the app now calls skipWaiting at install and reloads once
// on controllerchange, but older open pages may still send this message.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting" || (e.data && e.data.type === "skipWaiting")) self.skipWaiting();
});

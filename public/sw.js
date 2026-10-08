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
  // The lazy bundles' own stylesheets (src/styles LAZY_STYLE_SHEETS), fetched next to their script.
  "/css/settings.css", "/css/day-view.css", "/css/ask.css", "/css/horizon.css", "/css/welcome.css",
  // Every bundle, eager AND lazy, in manifest order: a lazy destination's first
  // offline visit resolves from here.
  "/js/bundle-01-core.js", "/js/bundle-02-today.js", "/js/bundle-03-capture.js", "/js/bundle-04-coach-meals.js", "/js/bundle-22-fuel.js", "/js/bundle-05-me-health.js", "/js/bundle-07-boot.js",
  "/js/bundle-08-train.js", "/js/bundle-20-journey.js", "/js/bundle-21-body.js", "/js/bundle-09-horizon.js", "/js/bundle-10-ask.js", "/js/bundle-17-agent-login.js", "/js/bundle-15-welcome.js",
  "/js/bundle-11-settings.js", "/js/bundle-18-glance.js", "/js/bundle-19-day-view.js", "/js/bundle-12-calendar.js", "/js/bundle-13-meals.js", "/js/bundle-14-today-ahead.js", "/js/bundle-16-auth.js",
  "/art.js", "/cairn-body-figure.js", "/manifest.json",
  // Self-hosted Atelier v2 faces (src/styles/foundation/fonts.css). Core, not
  // optional: an installed app offline must still set its own type.
  "/fonts/young-serif-latin-400.woff2", "/fonts/hanken-grotesk-latin-wght.woff2",
  "/fonts/martian-mono-latin-400.woff2", "/fonts/martian-mono-latin-500.woff2",
  // The vendored QR encoder Settings → Devices "Pair a device" loads on demand (~16 KB
  // brotli), so pairing a second device also works from an installed app offline.
  "/vendor/qrcode.js",
  // The vendored WebAuthn helper the sign-in screen and Settings → Devices load
  // on demand (~5 KB brotli), so a passkey sign-in also works from an installed app.
  "/vendor/simplewebauthn-browser.js",
];
const OPTIONAL_ASSETS = [
  // Vendored xterm.js for the in-app agent-login terminal (lazy-loaded by the
  // Settings → Agents "Connect" modal; precached so it also works offline-installed).
  "/vendor/xterm.js", "/vendor/xterm.css", "/vendor/xterm-addon-fit.js",
  "/favicon.ico",
  // Versioned icon set (…vN). Never hand-edit the suffix: `node scripts/bump-icons.mjs`
  // moves every icon url (here, manifest.json, index.html) to the next .vN at once,
  // so the new urls bust every cache layer and test/pwaInstallIdentity.test.js agrees.
  // The og: share image is deliberately NOT here: only link-preview crawlers fetch
  // it, never the app, so precaching it only cost every install its bytes.
  "/icons/icon.v3.svg", "/icons/apple-touch-icon.v3.png", "/icons/mask-icon.v3.svg",
  "/icons/favicon-16.v3.png", "/icons/favicon-32.v3.png",
  "/icons/icon-192.v3.png", "/icons/icon-512.v3.png",
  "/icons/icon-192-maskable.v3.png", "/icons/icon-512-maskable.v3.png",
];

// ---- incremental precache ----
// The server rewrites the literal below to `{ "<url>": "<hash>", … }` — a content
// hash per precached file (src/swVersion.ts). An install then COPIES every file
// whose hash it already holds (from the previous shell cache, or the stable cache)
// and downloads only what actually changed, instead of re-fetching the whole shell
// on every deploy. Served unmodified (a plain static server) it stays `{}` and the
// install falls back to downloading everything. Keep the literal EXACTLY as written:
// it is substituted by exact match and asserted by scripts/check-sw-cache.mjs.
const ASSET_HASHES = /*cairn-asset-hashes*/ {};
// Fonts, vendor code and the versioned icons change almost never, so they live in a
// STABLE cache that outlives a shell version (like the art cache): a deploy that
// touches a bundle never downloads them again. Membership is by url; the hash
// index below still re-downloads one whose bytes did change.
const STABLE_CACHE = "cairn-static-v1";
function isStableAsset(url) {
  return /^\/(fonts|vendor|icons)\//.test(url);
}
// Each cache remembers the hash every entry was stored under, as a JSON entry at
// this url (never requested by the app).
const HASH_INDEX_URL = "/__cairn/asset-hashes.json";
async function readHashIndex(cache) {
  try {
    const res = await cache.match(HASH_INDEX_URL);
    return res ? (await res.json()) || {} : {};
  } catch {
    return {};
  }
}
function writeHashIndex(cache, index) {
  return cache.put(HASH_INDEX_URL, new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } }));
}
// A filename-versioned asset (`….v3.png`) can never change under its url, so the
// browser's HTTP cache is a valid source for it. Anything else is REVALIDATED with
// the server (`no-cache`: a conditional request every time, never a stale copy), so
// a file the page itself just downloaded — the first install now registers after
// load — answers 304 instead of crossing the network twice.
function precacheRequest(url) {
  return new Request(url, { cache: /\.v\d+\.[a-z0-9]+$/i.test(url) ? "default" : "no-cache" });
}

async function precacheShell() {
  const hashes = ASSET_HASHES || {};
  const [shell, stable] = await Promise.all([caches.open(CACHE), caches.open(STABLE_CACHE)]);
  const previousNames = (await caches.keys()).filter(
    (k) => k.startsWith("cairn-") && k !== CACHE && k !== ART_CACHE && k !== STABLE_CACHE
  );
  const previous = await Promise.all(
    previousNames.map(async (name) => {
      const cache = await caches.open(name);
      return { cache, index: await readHashIndex(cache) };
    })
  );
  const stableIndex = await readHashIndex(stable);
  const shellIndex = {};

  // The stable cache is SHARED with the active worker, so it is written before this
  // install commits. Stage that safely: every stable entry about to be replaced is
  // struck from the hash index FIRST (and the index saved), so an install that fails
  // halfway can never leave new bytes recorded under an old hash — the next install
  // simply fetches that entry again.
  const stableHeld = new Set();
  let stableStruck = false;
  for (const url of [...CORE_ASSETS, ...OPTIONAL_ASSETS]) {
    if (!isStableAsset(url)) continue;
    const hash = hashes[url];
    if (hash && stableIndex[url] === hash && (await stable.match(url))) {
      stableHeld.add(url);
    } else if (url in stableIndex) {
      delete stableIndex[url];
      stableStruck = true;
    }
  }
  if (stableStruck) await writeHashIndex(stable, stableIndex);

  async function one(url, required) {
    const hash = hashes[url];
    const isStable = isStableAsset(url);
    const target = isStable ? stable : shell;
    const index = isStable ? stableIndex : shellIndex;
    try {
      if (hash) {
        // Already held, byte-identical: nothing to do (stable) or copy it over (shell).
        if (isStable && stableHeld.has(url)) return;
        for (const prior of previous) {
          if (prior.index[url] !== hash) continue;
          const hit = await prior.cache.match(url);
          if (!hit) continue;
          await target.put(url, hit);
          index[url] = hash;
          return;
        }
      }
      const res = await fetch(precacheRequest(url));
      if (!res || !res.ok) throw new Error(`precache ${url}: ${res ? res.status : "no response"}`);
      await target.put(url, res);
      if (hash) index[url] = hash;
      else delete index[url];
    } catch (error) {
      if (required) throw error;
    }
  }

  await Promise.all(CORE_ASSETS.map((url) => one(url, true)));
  await Promise.all(OPTIONAL_ASSETS.map((url) => one(url, false)));
  await Promise.all([writeHashIndex(shell, shellIndex), writeHashIndex(stable, stableIndex)]);
}

// Drop stable entries the current shell no longer lists (a bumped icon set, a
// removed font), so the stable cache holds exactly what this worker precaches.
async function pruneStableCache() {
  const listed = new Set([...CORE_ASSETS, ...OPTIONAL_ASSETS].filter(isStableAsset));
  const stable = await caches.open(STABLE_CACHE);
  const index = await readHashIndex(stable);
  let changed = false;
  for (const req of await stable.keys()) {
    const path = new URL(req.url).pathname;
    if (path === HASH_INDEX_URL || listed.has(path)) continue;
    await stable.delete(req);
    if (index[path]) {
      delete index[path];
      changed = true;
    }
  }
  if (changed) await writeHashIndex(stable, index);
}

self.addEventListener("install", (e) => {
  // Download what changed, copy what did not (precacheShell).
  e.waitUntil(precacheShell());
  // Single-user self-hosted app: a deploy should always be live on the next open,
  // never stranded behind a manual tap (which is how a client once fell ~40 cache
  // versions behind). Activate the new worker immediately; the page reloads itself
  // on controllerchange once nothing is in flight (src/client/app/update-gate.ts),
  // and chat drafts + in-flight turns persist so the reload loses nothing.
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      // Drop stale app caches, but PRESERVE the art cache — its images are
      // immutable and expensive to regenerate, so they outlive a version bump —
      // and the stable cache, pruned to what this worker lists.
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== ART_CACHE && k !== STABLE_CACHE).map((k) => caches.delete(k))))
      .then(() => pruneStableCache().catch(() => {}))
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
  // Server-rendered doors are never the shell: the OAuth consent flow for MCP connectors
  // (/oauth/authorize, its same-site hop, the return after sign-in) and the discovery
  // documents must reach the server, and so must any write (a form POST is a navigation
  // too). Answering them with the cached index.html would strand the connector flow.
  if (e.request.method !== "GET") return;
  if (url.pathname === "/oauth" || url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/")) return;
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
  // The manifest is NETWORK-first (cache fallback). An installed app's launch-time
  // manifest check is how Chrome notices a new icon, name or theme_color, and a
  // cache-first answer would hand it the precached copy forever. The precached copy
  // stays the offline fallback, and a bounded wait keeps a sleeping tailnet from
  // holding the check open.
  if (url.pathname === "/manifest.json") {
    e.respondWith(manifestNetworkFirst(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});

const MANIFEST_NETWORK_WAIT_MS = 4000;
async function manifestNetworkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(request, { cache: "no-cache" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("manifest timeout")), MANIFEST_NETWORK_WAIT_MS)),
    ]);
    if (res && res.ok) {
      cache.put("/manifest.json", res.clone()).catch(() => {});
      return res;
    }
    const cached = await cache.match("/manifest.json");
    return cached || res;
  } catch {
    const cached = await cache.match("/manifest.json");
    return cached || Response.error();
  }
}
// Legacy compatibility: the app now calls skipWaiting at install and reloads once
// on controllerchange, but older open pages may still send this message.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting" || (e.data && e.data.type === "skipWaiting")) self.skipWaiting();
  // Settings asks which shell this worker serves, so a deploy can be checked
  // against /api/health's `shell` (both are the derived cache name).
  if (e.data && e.data.type === "cairn-shell" && e.ports && e.ports[0]) e.ports[0].postMessage({ shell: CACHE });
});

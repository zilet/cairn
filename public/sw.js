const CACHE = "cairn-v334";
// Generated artwork lives in its own cache: the images are content-keyed and
// immutable on the server, so they stay valid across app deploys. Keeping them
// out of the versioned CACHE (and off the activate-cleanup list) means a deploy
// never re-downloads them — a slick, instant paint on every open.
const ART_CACHE = "cairn-art-v1";
const CORE_ASSETS = [
  "/", "/index.html", "/styles.css",
  "/js/date-utils.js", "/js/html-utils.js", "/js/markdown-client.js", "/js/ui-components.js", "/js/exercise-detail-client.js", "/js/format-utils.js", "/js/api-client.js", "/js/app-download.js", "/js/app-sw-recovery.js", "/js/01-core.js", "/js/pwa-install-coach.js", "/js/02-ui.js", "/js/detail-overlay-client.js", "/js/ui-motion-client.js", "/js/exercise-detail-controller.js", "/js/agent-login-client.js", "/js/agent-job-client.js", "/js/rest-timer.js", "/js/coaching-focus-client.js", "/js/today-activity-client.js", "/js/save-bar.js", "/js/swr-cache.js", "/js/today-agenda-client.js", "/js/today-rail-controller.js", "/js/today-training-client.js", "/js/today-progression-controller.js", "/js/today-add-exercise-controller.js", "/js/today-brief-client.js", "/js/cardio-plan-client.js", "/js/cardio-sync-client.js", "/js/today-lately-client.js", "/js/proposal-client.js", "/js/today-session-suggest-client.js", "/js/today-session-suggest-controller.js", "/js/today-session-status-client.js", "/js/today-session-controller.js", "/js/today-cards-client.js", "/js/today-program-adjustments-client.js", "/js/today-week-ahead-client.js", "/js/today-context-client.js", "/js/today-garmin-reconciliation-client.js", "/js/progress-endurance-client.js", "/js/progress-components-client.js", "/js/progress-chart-client.js", "/js/progress-history-client.js", "/js/progress-run-plan-client.js", "/js/progress-volume-client.js", "/js/progress-energy-client.js", "/js/progress-energy-surface-client.js", "/js/progress-calendar-client.js", "/js/progress-muscle-trajectory-client.js", "/js/progress-dexa-targeting-client.js", "/js/progress-performance-client.js", "/js/progress-program-adjustments-client.js", "/js/progress-test-week-client.js", "/js/progress-program-summary-client.js", "/js/progress-program-block-client.js", "/js/03-today.js", "/js/04-capture.js",
  "/js/05-progress.js", "/js/day-fuel-client.js", "/js/day-fuel-controller.js", "/js/meal-plan-client.js", "/js/meal-recipe-client.js", "/js/meal-recipe-controller.js", "/js/06-coach-meals.js", "/js/food-note-client.js", "/js/food-detail-controller.js", "/js/health-docs-client.js", "/js/me-profile-controller.js", "/js/07-me-health.js",
  "/js/health-client.js", "/js/health-read-client.js", "/js/health-standing-client.js", "/js/health-picture-client.js", "/js/health-picture-controller.js", "/js/health-markers-client.js", "/js/health-directives-client.js", "/js/health-directives-loader-client.js", "/js/health-learned-client.js", "/js/health-records-client.js", "/js/me-records-health-doc-controller.js", "/js/memory-client.js", "/js/life-client.js", "/js/family-client.js", "/js/08-me-records.js", "/js/chat-client.js", "/js/chat-attachment-client.js", "/js/chat-turn-client.js", "/js/chat-history-client.js", "/js/plan-endurance-client.js", "/js/plan-editor-client.js", "/js/09-plan-chat.js", "/js/settings-routes.js", "/js/settings-client.js", "/js/settings-data-client.js", "/js/settings-data-controller.js", "/js/settings-agents-client.js", "/js/settings-screen.js", "/js/route-state.js", "/js/app-router.js", "/js/app-route-sync.js", "/js/app-render-dispatch.js", "/js/app-tabs.js", "/js/app-job-reconnectors.js", "/js/app-mobile-viewport.js", "/js/app-service-worker.js", "/js/app-discipline-primer.js", "/js/app-onboarding.js", "/js/app-startup.js", "/js/10-boot.js",
  "/art.js", "/manifest.json",
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
    await c.addAll(CORE_ASSETS);
    await Promise.all(OPTIONAL_ASSETS.map((asset) => c.add(asset).catch(() => null)));
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
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/index.html")));
    return;
  }
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
// Legacy compatibility: the app now calls skipWaiting at install and reloads once
// on controllerchange, but older open pages may still send this message.
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting" || (e.data && e.data.type === "skipWaiting")) self.skipWaiting();
});

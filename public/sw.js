const CACHE = "cairn-v395";
// Generated artwork lives in its own cache: the images are content-keyed and
// immutable on the server, so they stay valid across app deploys. Keeping them
// out of the versioned CACHE (and off the activate-cleanup list) means a deploy
// never re-downloads them — a slick, instant paint on every open.
const ART_CACHE = "cairn-art-v1";
const CORE_ASSETS = [
  "/", "/index.html", "/styles.css",
  "/js/date-utils.js", "/js/html-utils.js", "/js/markdown-client.js", "/js/ui-components.js", "/js/ui-feedback-client.js", "/js/ui-actions-client.js", "/js/ui-view-transitions-client.js", "/js/exercise-detail-client.js", "/js/format-utils.js", "/js/api-client.js", "/js/app-download.js", "/js/app-sw-recovery.js", "/js/01-core.js", "/js/art-controller.js", "/js/pwa-install-coach.js", "/js/ui-header-client.js", "/js/ui-segments-client.js", "/js/02-ui.js", "/js/detail-overlay-client.js", "/js/ui-motion-client.js", "/js/exercise-detail-data-client.js", "/js/exercise-detail-explanation-client.js", "/js/exercise-detail-render-client.js", "/js/exercise-detail-actions-client.js", "/js/exercise-detail-controller.js", "/js/agent-login-model-client.js", "/js/agent-login-assets-client.js", "/js/agent-login-modal-client.js", "/js/agent-login-session-client.js", "/js/agent-login-client.js", "/js/agent-job-records-client.js", "/js/agent-job-client.js", "/js/rest-timer.js", "/js/coaching-focus-client.js", "/js/today-activity-client.js", "/js/save-bar.js", "/js/swr-cache.js", "/js/today-agenda-client.js", "/js/today-rail-loaders-client.js", "/js/today-rail-controller.js", "/js/today-plan-selection-client.js", "/js/today-training-client.js", "/js/today-progression-controller.js", "/js/today-add-exercise-controller.js", "/js/today-brief-client.js", "/js/today-brief-override-client.js", "/js/today-brief-actions-client.js", "/js/today-brief-controller.js", "/js/cardio-plan-client.js", "/js/cardio-sync-client.js", "/js/today-lately-client.js", "/js/proposal-client.js", "/js/today-session-suggest-client.js", "/js/today-session-suggest-controller.js", "/js/today-session-status-client.js", "/js/today-session-feedback-client.js", "/js/today-session-skip-client.js", "/js/today-session-set-model.js", "/js/today-session-set-actions.js", "/js/today-session-controller.js", "/js/today-cards-client.js", "/js/today-program-adjustments-client.js", "/js/today-week-ahead-client.js", "/js/today-context-client.js", "/js/today-compass-client.js", "/js/today-garmin-reconciliation-client.js", "/js/today-side-loaders.js", "/js/today-plan-session-model.js", "/js/today-plan-session-data-client.js", "/js/today-plan-session-preparation.js", "/js/today-data-loader.js", "/js/today-main-shell-client.js", "/js/today-plan-surface-client.js", "/js/today-plan-surface-renderer.js", "/js/today-render-state-client.js", "/js/today-post-render-wiring.js", "/js/today-dependencies.js", "/js/today-compatibility-bridges.js", "/js/today-screen-runtime-deps.js", "/js/today-screen-runtime.js", "/js/progress-data-client.js", "/js/progress-endurance-client.js", "/js/progress-components-client.js", "/js/progress-line-chart-model.js", "/js/progress-chart-scrub-client.js", "/js/progress-chart-drawing-client.js", "/js/progress-chart-client.js", "/js/progress-trend-weight-client.js", "/js/progress-history-model-client.js", "/js/progress-history-render-client.js", "/js/progress-history-client.js", "/js/progress-run-plan-client.js", "/js/progress-route-deps-client.js", "/js/progress-endurance-controller.js", "/js/progress-volume-client.js", "/js/progress-energy-client.js", "/js/progress-energy-surface-client.js", "/js/progress-calendar-client.js", "/js/progress-muscle-trajectory-client.js", "/js/progress-dexa-targeting-client.js", "/js/progress-performance-client.js", "/js/progress-program-adjustments-client.js", "/js/progress-test-week-client.js", "/js/progress-program-summary-client.js", "/js/progress-program-block-client.js", "/js/progress-program-controller.js", "/js/03-today.js", "/js/capture-provenance-client.js", "/js/capture-read-date-client.js", "/js/capture-read-cards-client.js", "/js/capture-read-jobs-client.js", "/js/capture-reads-client.js", "/js/capture-voice-client.js", "/js/04-capture.js",
  "/js/05-progress.js", "/js/day-fuel-client.js", "/js/day-fuel-controller.js", "/js/meal-row-client.js", "/js/meal-plan-client.js", "/js/meal-planner-jobs-client.js", "/js/meal-recipe-client.js", "/js/meal-recipe-controller.js", "/js/meal-swap-data-client.js", "/js/meal-swap-row-actions-controller.js", "/js/meal-swap-controller.js", "/js/meal-planner-actions-controller.js", "/js/meal-planner-controller.js", "/js/coach-proposal-controller.js", "/js/06-coach-meals.js", "/js/food-note-client.js", "/js/food-detail-controller.js", "/js/health-docs-client.js", "/js/me-profile-form-client.js", "/js/me-profile-controller.js", "/js/me-health-log-renderer.js", "/js/me-health-tabs-controller.js", "/js/me-health-controller-deps.js", "/js/me-health-dependencies.js", "/js/me-health-screen-composition.js", "/js/07-me-health.js",
  "/js/health-evidence-client.js", "/js/health-marker-order-client.js", "/js/health-client.js", "/js/health-read-client.js", "/js/health-standing-primitives-client.js", "/js/health-standing-client.js", "/js/health-standing-controller.js", "/js/health-picture-client.js", "/js/health-picture-controller.js", "/js/health-markers-client.js", "/js/health-markers-controller.js", "/js/health-directives-client.js", "/js/health-directives-loader-client.js", "/js/health-read-synthesis-client.js", "/js/health-read-supplements-client.js", "/js/health-read-controller.js", "/js/health-learned-client.js", "/js/health-records-client.js", "/js/health-doc-upload-controller.js", "/js/health-doc-date-actions-client.js", "/js/health-doc-lifecycle-actions-client.js", "/js/health-doc-actions-controller.js", "/js/me-records-health-doc-controller.js", "/js/health-share-controller.js", "/js/memory-client.js", "/js/me-memory-controller.js", "/js/life-client.js", "/js/life-form-helpers.js", "/js/life-timeline-actions.js", "/js/life-controller.js", "/js/family-client.js", "/js/family-controller.js", "/js/08-me-records.js", "/js/chat-client.js", "/js/chat-attachment-client.js", "/js/chat-composer-focus-client.js", "/js/chat-composer-controller.js", "/js/chat-message-client.js", "/js/chat-turn-records-client.js", "/js/chat-turn-stream-state-client.js", "/js/chat-layout-client.js", "/js/chat-turn-monitor-client.js", "/js/chat-turn-client.js", "/js/chat-history-client.js", "/js/chat-header-controller.js", "/js/chat-starter-chips-client.js", "/js/chat-fuel-context-client.js", "/js/chat-earlier-history-client.js", "/js/plan-endurance-model.js", "/js/plan-endurance-client.js", "/js/plan-editor-client.js", "/js/plan-editor-form-client.js", "/js/plan-editor-controller.js", "/js/09-plan-chat.js", "/js/settings-routes.js", "/js/settings-client.js", "/js/settings-surface-client.js", "/js/settings-data-client.js", "/js/settings-data-controller.js", "/js/settings-agents-client.js", "/js/settings-agents-controller.js", "/js/settings-sources-automation-controller.js", "/js/settings-screen.js", "/js/route-state.js", "/js/app-router.js", "/js/app-route-sync.js", "/js/app-render-dispatch.js", "/js/app-tabs.js", "/js/app-job-reconnectors.js", "/js/app-mobile-viewport.js", "/js/app-service-worker.js", "/js/app-discipline-primer.js", "/js/app-onboarding.js", "/js/app-startup.js", "/js/10-boot.js",
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

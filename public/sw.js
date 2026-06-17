const CACHE = "cairn-v80";
const ASSETS = [
  "/", "/index.html", "/styles.css",
  "/js/01-core.js", "/js/02-ui.js", "/js/03-today.js", "/js/04-capture.js",
  "/js/05-progress.js", "/js/06-coach-meals.js", "/js/07-me-health.js",
  "/js/08-me-records.js", "/js/09-plan-chat.js", "/js/10-boot.js",
  "/art.js", "/manifest.json",
  "/favicon.ico",
  "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
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
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API or MCP — always hit network.
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/mcp")) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
// The page asks a waiting worker to take over once the user taps "refresh".
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting" || (e.data && e.data.type === "skipWaiting")) self.skipWaiting();
});

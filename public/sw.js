const CACHE = "cairn-v55";
const ASSETS = [
  "/", "/index.html", "/styles.css", "/app.js", "/art.js", "/manifest.json",
  "/favicon.ico",
  "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  // Note: no skipWaiting() here — a waiting worker lets the page surface the
  // "Cairn updated — tap to refresh" toast and activate on the user's nod.
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

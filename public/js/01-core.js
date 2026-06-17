// ==== 01-core.js ====
const $ = (s) => document.querySelector(s);
const view = $("#view");
const headerTitle = $("#header-title");

// ---------- optional shared-token auth ----------
// No-op unless the server has CAIRN_AUTH_TOKEN set. The token lives in
// localStorage; api() sends it as a header, withToken() appends it to direct
// resource URLs (art images, file/export downloads) that can't carry a header.
function authToken() {
  try { return (localStorage.getItem("cairn_token") || "").trim(); } catch { return ""; }
}
function withToken(url) {
  const t = authToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}
let promptingAuth = false;
function handleUnauthorized() {
  if (promptingAuth) return;
  promptingAuth = true;
  try { localStorage.removeItem("cairn_token"); } catch {}
  const t = window.prompt("Cairn needs an access token (CAIRN_AUTH_TOKEN) to continue:");
  if (t && t.trim()) { try { localStorage.setItem("cairn_token", t.trim()); } catch {} }
  location.reload();
}
const api = (p, opts = {}) => {
  const t = authToken();
  const headers = { ...(opts.headers || {}) };
  if (t) headers["X-Cairn-Token"] = t;
  return fetch("/api" + p, { ...opts, headers }).then((r) => {
    if (r.status === 401) { handleUnauthorized(); return new Promise(() => {}); }
    setOffline(false); // a real response landed — Cairn is reachable
    return r.json();
  }).catch((err) => {
    setOffline(true); // the network dropped — surface the calm hairline banner
    throw err;
  });
};

// ---------- offline hairline ----------
// A calm, non-alarming banner ("Can't reach Cairn — changes will retry") that
// rides just under the header whenever a fetch fails or the browser reports
// offline. It clears itself the moment any request succeeds (or `online` fires).
// Constitution: information, never an alarm — one thin warm line, no modal.
let _offline = false;
function setOffline(on) {
  on = !!on;
  if (on === _offline) return;
  _offline = on;
  let bar = document.querySelector(".offline-bar");
  if (on) {
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "offline-bar";
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-live", "polite");
      bar.innerHTML = `<span class="offline-dot" aria-hidden="true"></span><span>Can't reach Cairn — changes will retry</span>`;
      document.body.appendChild(bar);
    }
    requestAnimationFrame(() => bar.classList.add("show"));
    document.body.classList.add("is-offline");
  } else if (bar) {
    bar.classList.remove("show");
    document.body.classList.remove("is-offline");
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
  if (navigator.onLine === false) setOffline(true);
}

// ---------- stale-while-revalidate (SWR) cache layer ----------
// The spine that makes the whole app feel instant: tabs paint REAL last-known
// content the moment you re-enter (skeleton only on a true cold start), then
// quietly revalidate in the background and upgrade in place — generalizing the
// Brief's `upgradeBriefInPlace`. Two tiers: an in-memory Map (this session) over
// localStorage (`cairn.swr.v1.<key>`, survives reload/restart). JSON-only — never
// cache DOM; rendering still flows through escHtml/escAttr everywhere.
//
// HOW A SURFACE ADOPTS IT (4 lines):
//   const KEY = "today:" + date;
//   const peek = peekCached(KEY);
//   paintSWR({ key: KEY, path: "/today?date=" + date, peek, token: pollToken,
//     render: (data, { warm } = {}) => { view.querySelector("#slot").innerHTML = buildHtml(data); } });
// `render` runs synchronously for a warm peek (no skeleton, just a `.swr-refreshing`
// hairline while it revalidates), then once more only if the payload changed. A cold
// surface keeps its existing skeleton until the first resolve.
//
// A MUTATING WRITE that invalidates a surface calls `swrInvalidate(key)` (or a
// prefix) so the next paint refetches — the same role `state.brief = null` plays
// for the Brief.
const SWR_NS = "cairn.swr.v1."; // bump the version segment in lockstep with any payload-shape change
const _swrMem = new Map();      // key -> { data, ts } (this-session tier, fastest)

// Health-sensitive surfaces stay in the MEMORY tier only — never written to disk.
// Lab markers and recovery (HRV / RHR / sleep / body-battery) are the most personal
// data the app holds; they still paint instantly WITHIN a session from _swrMem, they
// just don't persist to localStorage across a cold start (where everything else does).
const _swrMemOnly = (key) => /^(markers:|recovery:)/.test(key || "");

function _swrLsGet(key) {
  if (_swrMemOnly(key)) return null; // health data is never read back from disk
  try {
    const raw = localStorage.getItem(SWR_NS + key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && typeof o === "object" && "data" in o) return o;
  } catch {}
  return null;
}
function _swrLsSet(key, entry) {
  if (_swrMemOnly(key)) return; // health data never lands on disk
  try { localStorage.setItem(SWR_NS + key, JSON.stringify(entry)); } catch {}
}

// Read the last-known value for a key without firing a request. Memory first,
// then hydrate from localStorage (and warm the memory tier). Returns
// { data, fresh } where fresh = age < freshFor (default 60s), or null if absent.
function peekCached(key, freshFor = 60000) {
  if (!key) return null;
  let entry = _swrMem.get(key);
  if (!entry) {
    entry = _swrLsGet(key);
    if (entry) _swrMem.set(key, entry);
  }
  if (!entry) return null;
  const age = Date.now() - (entry.ts || 0);
  return { data: entry.data, fresh: age < freshFor };
}

function _swrStore(key, data) {
  const entry = { data, ts: Date.now() };
  _swrMem.set(key, entry);
  _swrLsSet(key, entry);
  return entry;
}

// Stable structural compare for "did the JSON payload actually change?" — cheap
// JSON.stringify, since these are small API bodies we already serialize anyway.
function _swrSame(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

// Fire `api(path)`, write both cache tiers on resolve, and call
// `onUpgrade(data, { changed })` ONLY when the payload changed vs what's cached
// (so a no-op revalidate never re-renders / re-animates). Revalidate errors are
// swallowed (api() already surfaced the offline hairline) and the stale value is
// returned so callers never blank out. Returns a promise of the fresh data — so a
// deliberate caller can still `await cachedApi(...)` like a plain fetch.
function cachedApi(path, { key, freshFor = 60000, onUpgrade } = {}) {
  const k = key || path;
  const prior = peekCached(k, freshFor);
  return api(path).then((data) => {
    const changed = !prior || !_swrSame(prior.data, data);
    _swrStore(k, data);
    if (onUpgrade) { try { onUpgrade(data, { changed }); } catch {} }
    return data;
  }).catch(() => (prior ? prior.data : Promise.reject(new Error("swr-offline"))));
}

// The orchestrator generalizing upgradeBriefInPlace. Given a cache key + a path +
// a `render(data, {warm})` callback:
//   • warm peek present → render(peek.data, {warm:true}) SYNCHRONOUSLY (no skeleton),
//     and add a `.swr-refreshing` hairline if the peek is stale;
//   • no peek → leave the existing skeleton in place;
// then revalidate; on resolve, stale-guard on token/tab, drop the hairline, and
// re-render via skelSwap() only if the payload changed (or we were cold).
// `peek` is passed in (the caller already peeked to decide skeleton-vs-not in
// switchTab); if omitted we peek here.
function paintSWR({ key, path, peek, render, token, freshFor = 60000, tab } = {}) {
  if (!key || !path || typeof render !== "function") return Promise.resolve();
  const p = peek !== undefined ? peek : peekCached(key, freshFor);
  const tabAtStart = tab !== undefined ? tab : state.tab;
  const stale = () => (token != null && token !== pollToken) || (tabAtStart != null && state.tab !== tabAtStart);

  if (p) {
    render(p.data, { warm: true });
    if (!p.fresh) markRefreshing(true);
  }
  return cachedApi(path, {
    key, freshFor,
    onUpgrade: (data, { changed }) => {
      if (stale()) return;
      markRefreshing(false);
      if (changed || !p) skelSwap(() => render(data, { warm: false }));
    },
  }).then((data) => { if (!stale()) markRefreshing(false); return data; })
    .catch(() => { if (!stale()) markRefreshing(false); });
}

// The calm "we have your data, just checking" hairline — a single low-key filament
// under the header, distinct from the offline bar. Reference-counted so concurrent
// surfaces don't fight over it. Reduced-motion → a static tinted top border (CSS).
let _swrRefreshing = 0;
function markRefreshing(on) {
  _swrRefreshing = Math.max(0, _swrRefreshing + (on ? 1 : -1));
  document.body.classList.toggle("swr-busy", _swrRefreshing > 0);
}

// Drop a cache entry (and its localStorage twin). With a trailing-prefix match
// (`swrInvalidate("today:")`) it drops every key under that prefix — for surfaces
// keyed by date/window. Also clears the refresh hairline bookkeeping is untouched.
function swrInvalidate(keyOrPrefix) {
  if (!keyOrPrefix) return;
  const prefix = keyOrPrefix.endsWith(":") || keyOrPrefix.endsWith(".");
  if (prefix) {
    for (const k of [..._swrMem.keys()]) if (k.startsWith(keyOrPrefix)) _swrMem.delete(k);
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const lk = localStorage.key(i);
        if (lk && lk.startsWith(SWR_NS + keyOrPrefix)) localStorage.removeItem(lk);
      }
    } catch {}
  } else {
    _swrMem.delete(keyOrPrefix);
    try { localStorage.removeItem(SWR_NS + keyOrPrefix); } catch {}
  }
}

// Boot housekeeping: evict stale localStorage SWR rows (older than ~24h) and cap
// the namespace at ~40 entries (drop the oldest), so the cache never grows
// unbounded. Cheap, runs once at startup.
function swrSweep() {
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const CAP = 40;
  try {
    const rows = [];
    for (let i = 0; i < localStorage.length; i++) {
      const lk = localStorage.key(i);
      if (!lk || !lk.startsWith(SWR_NS)) continue;
      let ts = 0;
      try { ts = (JSON.parse(localStorage.getItem(lk)) || {}).ts || 0; } catch {}
      rows.push({ lk, ts });
    }
    const now = Date.now();
    for (const r of rows) if (now - r.ts > MAX_AGE) { try { localStorage.removeItem(r.lk); } catch {} }
    const fresh = rows.filter((r) => now - r.ts <= MAX_AGE).sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < fresh.length - CAP; i++) { try { localStorage.removeItem(fresh[i].lk); } catch {} }
  } catch {}
}

function localISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Human label for the date being viewed on Today: "Today" / "Yesterday" / "Fri, Jun 5".
function dateLabel(iso) {
  if (iso === localISO()) return "Today";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (iso === localISO(y)) return "Yesterday";
  const [yr, mo, da] = iso.split("-").map(Number);
  return new Date(yr, mo - 1, da).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Compact relative timestamp for status lines: "just now" / "12m ago" / "3h ago" / "2d ago".
function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Friendly calendar-date label: "today" / "yesterday" / "3 days ago" / "2 weeks ago" /
// "Apr 2024". Recent dates read relative; older ones fall back to month + year, which is
// what makes sense for lab results spanning years. Accepts a YYYY-MM-DD string.
function humanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d)) return String(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days < 0) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 45) return `${Math.round(days / 7)} weeks ago`;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Relative-age label that never falls back to a bare month-year: "today" / "yesterday" /
// "N days ago" / "N weeks ago" / "N months ago" / "a year ago" / "N years ago". Used for
// lab-marker recency where "3 months ago" reads better than "Apr 2024". Pair it with a
// title= absolute date for precision on hover. Accepts a YYYY-MM-DD string.
function relAge(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d)) return String(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days < 0) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 45) return `${Math.round(days / 7)} weeks ago`;
  if (days < 320) return `${Math.max(1, Math.round(days / 30))} months ago`;
  if (days < 550) return "a year ago";
  return `${Math.round(days / 365)} years ago`;
}

// Full absolute date for title= tooltips alongside relAge ("June 11, 2026").
function absDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// Coaching prose tends to restate the most-recent panel date in every line
// ("LDL-C is 207 on 2026-06-11", "ApoB is 148 on 2026-06-11", …). We surface that
// date once as an "As of …" caption and clean it out of the body, then humanize any
// remaining (older, contextual) ISO dates so nothing reads as a raw YYYY-MM-DD.
function humanizeReviewText(text, latestISO) {
  if (!text) return text || "";
  let s = String(text);
  if (latestISO && /^\d{4}-\d{2}-\d{2}$/.test(latestISO)) {
    const esc = latestISO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "… on 2026-06-11", "as of 2026-06-11", "(2026-06-11)" → drop (shown once in caption)
    s = s.replace(new RegExp(`\\s*[([]?\\b(?:on|as of|dated|measured on|recorded on|taken on)\\s+${esc}\\b[)\\]]?`, "gi"), "");
    s = s.replace(new RegExp(`\\s*[([]\\s*${esc}\\s*[)\\]]`, "g"), "");
  }
  // remaining ISO dates → friendly labels ("Apr 2024", "yesterday", …)
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m0) => humanDate(m0));
  // tidy whatever stripping left behind: stray spaces before punctuation, empty (), leading commas
  return s.replace(/\(\s*\)/g, "").replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").replace(/^\s*[,.;:]\s*/, "").trim();
}

// Newest YYYY-MM-DD mentioned anywhere in the parsed review (lexical max works for ISO).
function latestReviewDate(p) {
  const hits = JSON.stringify(p || {}).match(/\d{4}-\d{2}-\d{2}/g);
  return hits && hits.length ? hits.sort()[hits.length - 1] : null;
}

const state = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: localISO() };


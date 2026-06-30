(() => {
// @ts-check
// Shared stale-while-revalidate cache layer for the vanilla PWA.
// ---------- stale-while-revalidate (SWR) cache layer ----------
// The spine that makes the whole app feel instant: tabs paint REAL last-known
// content the moment you re-enter (skeleton only on a true cold start), then
// quietly revalidate in the background and upgrade in place, generalizing the
// Brief's `upgradeBriefInPlace`. Two tiers: an in-memory Map (this session) over
// localStorage (`cairn.swr.v1.<key>`, survives reload/restart). JSON-only: never
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
// prefix) so the next paint refetches, the same role `state.brief = null` plays
// for the Brief.
const SWR_NS = "cairn.swr.v1."; // bump the version segment in lockstep with any payload-shape change
const _swrMem = new Map(); // key -> { data, ts } (this-session tier, fastest)
// Health-sensitive surfaces stay in the MEMORY tier only, never written to disk.
// Lab markers and recovery (HRV / RHR / sleep / body-battery) are the most personal
// data the app holds; they still paint instantly WITHIN a session from _swrMem, they
// just don't persist to localStorage across a cold start (where everything else does).
function _swrMemOnly(key) {
    return /^(markers:|recovery:)/.test(key || "");
}
function _swrLsGet(key) {
    if (_swrMemOnly(key))
        return null; // health data is never read back from disk
    try {
        const raw = localStorage.getItem(SWR_NS + key);
        if (!raw)
            return null;
        const o = JSON.parse(raw);
        if (o && typeof o === "object" && "data" in o)
            return o;
    }
    catch { }
    return null;
}
function _swrLsSet(key, entry) {
    if (_swrMemOnly(key))
        return; // health data never lands on disk
    try {
        localStorage.setItem(SWR_NS + key, JSON.stringify(entry));
    }
    catch { }
}
// Read the last-known value for a key without firing a request. Memory first,
// then hydrate from localStorage (and warm the memory tier). Returns
// { data, fresh } where fresh = age < freshFor (default 60s), or null if absent.
function peekCached(key, freshFor = 60000) {
    if (!key)
        return null;
    let entry = _swrMem.get(key);
    if (!entry) {
        entry = _swrLsGet(key) || undefined;
        if (entry)
            _swrMem.set(key, entry);
    }
    if (!entry)
        return null;
    const age = Date.now() - (entry.ts || 0);
    return { data: entry.data, fresh: age < freshFor };
}
function _swrStore(key, data) {
    const entry = { data, ts: Date.now() };
    _swrMem.set(key, entry);
    _swrLsSet(key, entry);
    return entry;
}
// Stable structural compare for "did the JSON payload actually change?" using
// JSON.stringify, since these are small API bodies we already serialize anyway.
function _swrSame(a, b) {
    if (a === b)
        return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    catch {
        return false;
    }
}
// Fire `api(path)`, write both cache tiers on resolve, and call
// `onUpgrade(data, { changed })` ONLY when the payload changed vs what's cached
// (so a no-op revalidate never re-renders / re-animates). Revalidate errors are
// swallowed (api() already surfaced the offline hairline) and the stale value is
// returned so callers never blank out. Returns a promise of the fresh data so a
// deliberate caller can still `await cachedApi(...)` like a plain fetch.
function cachedApi(path, options = {}) {
    const { key, freshFor = 60000, onUpgrade } = options;
    const k = key || path;
    const prior = peekCached(k, freshFor);
    return api(path)
        .then((data) => {
        const changed = !prior || !_swrSame(prior.data, data);
        _swrStore(k, data);
        if (onUpgrade) {
            try {
                onUpgrade(data, { changed });
            }
            catch { }
        }
        return data;
    })
        .catch(() => (prior ? prior.data : Promise.reject(new Error("swr-offline"))));
}
// The orchestrator generalizing upgradeBriefInPlace. Given a cache key + a path +
// a `render(data, {warm})` callback:
// - warm peek present -> render(peek.data, {warm:true}) synchronously (no skeleton),
//   and add a `.swr-refreshing` hairline if the peek is stale;
// - no peek -> leave the existing skeleton in place;
// then revalidate; on resolve, stale-guard on token/tab, drop the hairline, and
// re-render via skelSwap() only if the payload changed (or we were cold).
// `peek` is passed in (the caller already peeked to decide skeleton-vs-not in
// switchTab); if omitted we peek here.
function paintSWR(options = {}) {
    const { key, path, peek, render, token, freshFor = 60000, tab } = options;
    if (!key || !path || typeof render !== "function")
        return Promise.resolve(undefined);
    const p = peek !== undefined ? peek : peekCached(key, freshFor);
    const tabAtStart = tab !== undefined ? tab : state.tab;
    const stale = () => (token != null && token !== pollToken) || (tabAtStart != null && state.tab !== tabAtStart);
    if (p) {
        render(p.data, { warm: true });
        if (!p.fresh)
            markRefreshing(true);
    }
    return cachedApi(path, {
        key,
        freshFor,
        onUpgrade: (data, { changed }) => {
            if (stale())
                return;
            markRefreshing(false);
            if (changed || !p)
                skelSwap(() => render(data, { warm: false }));
        },
    })
        .then((data) => {
        if (!stale())
            markRefreshing(false);
        return data;
    })
        .catch(() => {
        if (!stale())
            markRefreshing(false);
        return undefined;
    });
}
// The calm "we have your data, just checking" hairline: a single low-key filament
// under the header, distinct from the offline bar. Reference-counted so concurrent
// surfaces don't fight over it. Reduced-motion -> a static tinted top border (CSS).
let _swrRefreshing = 0;
function markRefreshing(on) {
    _swrRefreshing = Math.max(0, _swrRefreshing + (on ? 1 : -1));
    document.body.classList.toggle("swr-busy", _swrRefreshing > 0);
}
// Drop a cache entry (and its localStorage twin). With a trailing-prefix match
// (`swrInvalidate("today:")`) it drops every key under that prefix for surfaces
// keyed by date/window. The refresh hairline bookkeeping is untouched.
function swrInvalidate(keyOrPrefix) {
    if (!keyOrPrefix)
        return;
    const prefix = keyOrPrefix.endsWith(":") || keyOrPrefix.endsWith(".");
    if (prefix) {
        for (const k of [..._swrMem.keys()])
            if (k.startsWith(keyOrPrefix))
                _swrMem.delete(k);
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const lk = localStorage.key(i);
                if (lk && lk.startsWith(SWR_NS + keyOrPrefix))
                    localStorage.removeItem(lk);
            }
        }
        catch { }
    }
    else {
        _swrMem.delete(keyOrPrefix);
        try {
            localStorage.removeItem(SWR_NS + keyOrPrefix);
        }
        catch { }
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
            if (!lk || !lk.startsWith(SWR_NS))
                continue;
            let ts = 0;
            try {
                ts = (JSON.parse(localStorage.getItem(lk) || "null") || {}).ts || 0;
            }
            catch { }
            rows.push({ lk, ts });
        }
        const now = Date.now();
        for (const r of rows) {
            if (now - r.ts > MAX_AGE) {
                try {
                    localStorage.removeItem(r.lk);
                }
                catch { }
            }
        }
        const fresh = rows.filter((r) => now - r.ts <= MAX_AGE).sort((a, b) => a.ts - b.ts);
        for (let i = 0; i < fresh.length - CAP; i++) {
            try {
                localStorage.removeItem(fresh[i].lk);
            }
            catch { }
        }
    }
    catch { }
}
Object.assign(globalThis, {
    peekCached,
    cachedApi,
    paintSWR,
    markRefreshing,
    swrInvalidate,
    swrSweep,
});
})();

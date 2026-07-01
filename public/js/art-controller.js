(() => {
// @ts-check
// Progressive generated artwork rendering and readiness tracking.
function artRecord(value) {
    return value && typeof value === "object" ? value : {};
}
// CairnArt (public/art.js) returns trusted static SVG strings — never user text — so its
// output is inserted raw. Guarded so a missing/stale art.js can't crash a render.
function art(fn, ...a) {
    try {
        const cairnArt = window.CairnArt;
        return cairnArt?.[fn]?.(...a) || "";
    }
    catch {
        return "";
    }
}
let artEnabled = true; // refreshed from /settings at boot + on Settings save
Object.defineProperty(globalThis, "artEnabled", {
    configurable: true,
    get: () => artEnabled,
    set: (value) => { artEnabled = !!value; },
});
// Generated art is content-keyed + immutable on the server, so once we know an
// image exists we can render it IMMEDIATELY — eager, no fade, photo straight over
// the SVG — instead of starting from the wire placeholder every render. We track
// which "kind|query" tokens are ready in `artReady`, hydrated from three sources:
//   • localStorage  — every image this client has ever loaded (instant, at module load)
//   • /api/art/manifest — what the server already has on disk (covers a cold client)
//   • a live onload — anything generated after the page opened
// Keyed token-free (no auth token / retry param) so it survives token rotation.
const artReady = new Set();
const artKey = (kind, q) => `${kind}|${String(q || "").trim().slice(0, 120)}`;
const ART_READY_LS = "cairn-art-ready";
let _artReadyTimer = 0;
function persistArtReady() {
    clearTimeout(_artReadyTimer);
    _artReadyTimer = setTimeout(() => {
        // Cap so it can't grow unbounded; keep the most recently-added tokens.
        try {
            localStorage.setItem(ART_READY_LS, JSON.stringify([...artReady].slice(-3000)));
        }
        catch { }
    }, 600);
}
function markArtReady(token) {
    const key = typeof token === "string" ? token : "";
    if (key && !artReady.has(key)) {
        artReady.add(key);
        persistArtReady();
    }
}
(function loadArtReady() {
    try {
        const stored = JSON.parse(localStorage.getItem(ART_READY_LS) || "[]");
        if (Array.isArray(stored))
            stored.forEach((k) => { if (typeof k === "string")
                artReady.add(k); });
    }
    catch { }
})();
// Prime from the server's on-disk manifest — makes a cold client (cleared cache,
// new browser) render already-generated art instantly instead of re-flashing the
// wire on its first paint. Fire-and-forget at boot; failures are silent.
async function primeArtManifest() {
    try {
        const m = artRecord(await api("/art/manifest"));
        if (m && "enabled" in m)
            artEnabled = !!m.enabled;
        if (m && Array.isArray(m.ready) && m.ready.length) {
            m.ready.forEach((k) => { if (typeof k === "string")
                artReady.add(k); });
            persistArtReady();
        }
    }
    catch { }
}
function artPhotoLoaded(img) {
    img.classList.add("on");
    markArtReady(img.dataset.artkey); // remember for instant render next time
}
function artPhotoFailed(img) {
    // Drop BOTH reveal classes — `.instant` also forces opacity:1, so leaving it on
    // would keep a failed image visible instead of falling back to the SVG beneath.
    img.classList.remove("on", "instant");
    // A token we promised was ready didn't load (server cache cleared, file gone) —
    // forget it so we stop rendering it eager and fall back to the SVG cleanly.
    const k = img.dataset.artkey;
    if (k && artReady.has(k)) {
        artReady.delete(k);
        persistArtReady();
    }
    if (img.dataset.retried)
        return; // one quiet retry only
    img.dataset.retried = "1";
    const token = pollToken;
    setTimeout(() => {
        if (token !== pollToken || !img.isConnected)
            return; // stale tab / re-render — bail
        img.src = img.src.includes("&r=") ? img.src : img.src + "&r=1";
    }, 20000);
}
document.addEventListener("load", (e) => {
    const img = e.target instanceof HTMLImageElement ? e.target : null;
    if (img && img.dataset.artPhoto === "1")
        artPhotoLoaded(img);
}, true);
document.addEventListener("error", (e) => {
    const img = e.target instanceof HTMLImageElement ? e.target : null;
    if (!img)
        return;
    if (img.dataset.artPhoto === "1") {
        artPhotoFailed(img);
        return;
    }
    if (img.dataset.removeOnError === "1")
        img.remove();
}, true);
// Art tile that renders the generated studio photo over a CairnArt SVG. `svg` may
// be passed (exercise art needs muscleGroup); defaults to art(kind, q). Falls back
// to SVG-only when artwork generation is off.
//   • Known-ready (cache/manifest/seen) → eager, no fade — the photo is served
//     instantly from the SW/HTTP cache, so it paints over the SVG with no flash.
//   • Unknown → lazy, fades in on first load, then remembered for next time.
function artImg(kind, q, cls = "artile-md", svg = null) {
    const s = svg != null ? svg : art(kind, q);
    if (!s)
        return "";
    const query = String(q || "").trim().slice(0, 120);
    if (!artEnabled || !query)
        return `<div class="artile ${cls}">${s}</div>`;
    const token = artKey(kind, query);
    const src = withToken(`/api/art?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}`);
    const ready = artReady.has(token);
    const imgCls = ready ? "artimg-photo on instant" : "artimg-photo";
    const load = ready ? "eager" : "lazy";
    return `<div class="artile artimg ${cls}">${s}<img class="${imgCls}" alt="${escAttr(query)}" loading="${load}" decoding="async" data-art-photo="1" data-artkey="${escAttr(token)}" src="${escAttr(src)}"></div>`;
}
const CAIRN_ART_GLOBALS = {
    art,
    primeArtManifest,
    artImg,
};
Object.assign(globalThis, CAIRN_ART_GLOBALS);
if (typeof window !== "undefined") {
    Object.assign(window, CAIRN_ART_GLOBALS);
}
})();

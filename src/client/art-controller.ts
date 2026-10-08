// @ts-check
// Progressive generated artwork rendering and readiness tracking.

type ClientArtManifestResponse = import("../contracts/client-api.js").ClientArtManifestResponse;
type ClientArtVersionsResponse = import("../contracts/client-api.js").ClientArtVersionsResponse;
type ClientArtStateResponse = import("../contracts/client-api.js").ClientArtStateResponse;
type ClientArtRegenerateResponse = import("../contracts/client-api.js").ClientArtRegenerateResponse;

// CairnArt (public/art.js) returns trusted static SVG strings — never user text — so its
// output is inserted raw. Guarded so a missing/stale art.js can't crash a render.
function art(fn: string, ...a: unknown[]): string {
  try {
    const cairnArt = (window as unknown as { CairnArt?: Record<string, ((...args: unknown[]) => string) | undefined> })
      .CairnArt;
    return cairnArt?.[fn]?.(...a) || "";
  } catch {
    return "";
  }
}

let artEnabled: boolean = true; // refreshed from /settings at boot + on Settings save
Object.defineProperty(globalThis, "artEnabled", {
  configurable: true,
  get: () => artEnabled,
  set: (value) => {
    artEnabled = !!value;
  },
});

// Generated art is content-keyed + immutable on the server, so once we know an
// image exists we can render it IMMEDIATELY — eager, no fade, photo straight over
// the SVG — instead of starting from the wire placeholder every render. We track
// which "kind|query" tokens are ready in `artReady`, hydrated from three sources:
//   • localStorage  — every image this client has ever loaded (instant, at module load)
//   • /api/art/manifest — what the server already has on disk (covers a cold client)
//   • a live onload — anything generated after the page opened
// Keyed token-free (no auth token / retry param) so it survives token rotation.
const artReady = new Set<string>();
const artKey = (kind: unknown, q: unknown): string =>
  `${kind}|${String(q || "")
    .trim()
    .slice(0, 120)}`;
const ART_READY_LS = "cairn-art-ready";
// Versions and recent misses live in art-memory-client.ts (CairnArtMemory).
let _artReadyTimer: ReturnType<typeof setTimeout> | number = 0;
function persistArtReady(): void {
  clearTimeout(_artReadyTimer);
  _artReadyTimer = setTimeout(() => {
    // Cap so it can't grow unbounded; keep the most recently-added tokens.
    try {
      localStorage.setItem(ART_READY_LS, JSON.stringify([...artReady].slice(-3000)));
    } catch {}
  }, 600);
}
function markArtReady(token: unknown): void {
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
      stored.forEach((k: unknown) => {
        if (typeof k === "string") artReady.add(k);
      });
  } catch {}
})();

function applyArtVersions(payload: ClientArtVersionsResponse | null | undefined): void {
  CairnArtMemory.mergeVersions(payload?.versions);
}

// Every kind carries `v=` when the server named one: exercises a redraw counter,
// food and activity the served picture's creation time — so a re-pointed picture
// is a new URL and the cache-first SW layer cannot keep serving the old bytes.
function artUrl(kind: string, query: string, version?: number): string {
  const v = version ?? CairnArtMemory.version(artKey(kind, query));
  let path = `/api/art?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}`;
  if (v > 0) path += `&v=${encodeURIComponent(String(v))}`;
  return withToken(path);
}

// Prime from the server's on-disk manifest — makes a cold client (cleared cache,
// new browser) render already-generated art instantly instead of re-flashing the
// wire on its first paint. Fire-and-forget at boot; failures are silent.
// One read (`/art/state`): readiness, the enabled flag and the version map.
async function primeArtManifest(): Promise<void> {
  try {
    const m: ClientArtStateResponse | ClientArtManifestResponse = await api("/art/state");
    if (m && "enabled" in m) artEnabled = !!m.enabled;
    if (m && Array.isArray(m.ready) && m.ready.length) {
      m.ready.forEach((k: unknown) => {
        if (typeof k !== "string") return;
        artReady.add(k);
        CairnArtMemory.forgetMiss(k); // drawn since it last missed
      });
      persistArtReady();
    }
    if (m && "versions" in m) applyArtVersions(m);
  } catch {}
}

function artPhotoLoaded(img: HTMLImageElement): void {
  img.classList.add("on");
  if (img.dataset.artkey) CairnArtMemory.forgetMiss(img.dataset.artkey);
  markArtReady(img.dataset.artkey); // remember for instant render next time
}
function artPhotoFailed(img: HTMLImageElement): void {
  // Drop BOTH reveal classes — `.instant` also forces opacity:1, so leaving it on
  // would keep a failed image visible instead of falling back to the SVG beneath.
  img.classList.remove("on", "instant");
  // A token we promised was ready didn't load (server cache cleared, file gone) —
  // forget it so we stop rendering it eager and fall back to the SVG cleanly.
  const k = img.dataset.artkey;
  if (k) CairnArtMemory.recordMiss(k);
  if (k && artReady.has(k)) {
    artReady.delete(k);
    persistArtReady();
  }
  if (img.dataset.retried) return; // one quiet retry only
  img.dataset.retried = "1";
  const token = pollToken;
  setTimeout(() => {
    if (token !== pollToken || !img.isConnected) return; // stale tab / re-render — bail
    img.src = img.src.includes("&r=") ? img.src : img.src + "&r=1";
  }, 20000);
}

// `tile` keeps its `art-redrawing` class (the redraw spinner) until the FIRST
// successful load of the redrawn image, or until the poll gives up — never
// stripped the moment this function is merely invoked (see redrawExerciseArt,
// which used to clear it in a `finally` right after kicking the poll off,
// leaving up to 9s of stale artwork with no spinner).
function pollArtUntilReady(
  img: HTMLImageElement,
  src: string,
  tile: Element | null | undefined,
  attempts = 6,
  delayMs = 1500
): void {
  const token = pollToken;
  let left = attempts;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    tile?.classList.remove("art-redrawing");
  };
  img.addEventListener?.("load", settle, { once: true });
  const tick = () => {
    if (token !== pollToken || !img.isConnected) {
      settle();
      return;
    }
    img.src = src;
    left -= 1;
    if (left <= 0) {
      settle();
      return;
    }
    setTimeout(tick, delayMs);
  };
  tick();
}

async function redrawExerciseArt(img: HTMLImageElement, query: string): Promise<void> {
  const token = artKey("exercise", query);
  const currentV = CairnArtMemory.version(token) || 1;
  const tile = img.closest(".artile");
  tile?.classList.add("art-redrawing");
  try {
    const res: ClientArtRegenerateResponse = await api("/art/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "exercise", q: query }),
    });
    if (!res.ok) {
      const toastFn = (globalThis as unknown as { toast?: (msg: unknown) => void }).toast;
      toastFn?.("Couldn't redraw that figure");
      tile?.classList.remove("art-redrawing");
      return;
    }
    if (res.regenerated === false) {
      tile?.classList.remove("art-redrawing");
      return;
    }
    const nextV = Number(res.version) || currentV + 1;
    CairnArtMemory.setVersion(token, nextV);
    CairnArtMemory.forgetMiss(token);
    markArtReady(token);
    const src = artUrl("exercise", query, nextV);
    img.dataset.retried = "";
    // The poll (up to 9s) now owns clearing `art-redrawing` itself — on the first
    // successful load, or once it gives up — so the spinner stays honest instead
    // of vanishing the instant this call returns while stale art is still showing.
    pollArtUntilReady(img, src, tile);
  } catch {
    const toastFn = (globalThis as unknown as { toast?: (msg: unknown) => void }).toast;
    toastFn?.("Couldn't redraw that figure");
    tile?.classList.remove("art-redrawing");
  }
}

let artRedrawMenu: HTMLElement | null = null;
let artRedrawMenuCleanup: (() => void) | null = null;
function hideArtRedrawMenu(): void {
  artRedrawMenuCleanup?.();
  artRedrawMenuCleanup = null;
  artRedrawMenu?.remove();
  artRedrawMenu = null;
}
function showArtRedrawMenu(x: number, y: number, img: HTMLImageElement, query: string): void {
  hideArtRedrawMenu();
  const menu = document.createElement("div");
  menu.className = "art-redraw-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<button type="button" class="art-redraw-btn" role="menuitem">${escHtml("Redraw this figure")}</button>`;
  document.body.appendChild(menu);
  artRedrawMenu = menu;
  // Clamp against the actual viewport (not just the top-left corner) — a
  // long-press or right-click near the right/bottom edge used to place the menu
  // partly off-screen.
  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(Math.max(8, x), maxLeft)}px`;
  menu.style.top = `${Math.min(Math.max(8, y), maxTop)}px`;
  menu.querySelector("button")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    hideArtRedrawMenu();
    void redrawExerciseArt(img, query);
  });
  const onDoc = (ev: Event) => {
    if (artRedrawMenu && !artRedrawMenu.contains(ev.target as Node)) hideArtRedrawMenu();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") hideArtRedrawMenu();
  };
  // No `once` here: a tap that lands on the menu's own padding (still inside
  // `contains`) must not close the menu, but it must not consume the ONLY
  // outside-click listener either — `once:true` did exactly that, leaving every
  // later genuine outside click with nothing listening. The listener is instead
  // removed explicitly by hideArtRedrawMenu, however it gets triggered.
  const timer = setTimeout(() => {
    document.addEventListener("pointerdown", onDoc, { capture: true });
  }, 0);
  document.addEventListener("keydown", onKey, { capture: true });
  artRedrawMenuCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener("pointerdown", onDoc, { capture: true });
    document.removeEventListener("keydown", onKey, { capture: true });
  };
}

function exerciseTileTarget(ev: Event): { img: HTMLImageElement; query: string } | null {
  const t = ev.target;
  const el = t instanceof Element ? t : null;
  const img = el?.closest?.(".artile.artimg")?.querySelector("img[data-art-photo='1']") as HTMLImageElement | null;
  if (!img || img.dataset.artKind !== "exercise") return null;
  const query = String(img.dataset.artQ || "").trim();
  if (!query) return null;
  return { img, query };
}

document.addEventListener(
  "load",
  (e) => {
    const img = e.target instanceof HTMLImageElement ? e.target : null;
    if (img && img.dataset.artPhoto === "1") artPhotoLoaded(img);
    else if (img?.dataset.artGeneric === "1") img.classList.add("on");
  },
  true
);
document.addEventListener(
  "error",
  (e) => {
    const img = e.target instanceof HTMLImageElement ? e.target : null;
    if (!img) return;
    if (img.dataset.artPhoto === "1") {
      artPhotoFailed(img);
      return;
    }
    if (img.dataset.artGeneric === "1") CairnArtMemory.recordMiss(`generic|${img.dataset.artQ}`);
    if (img.dataset.removeOnError === "1") img.remove();
  },
  true
);
document.addEventListener("contextmenu", (e) => {
  const hit = exerciseTileTarget(e);
  if (!hit) return;
  e.preventDefault();
  showArtRedrawMenu(e.clientX, e.clientY, hit.img, hit.query);
});
(() => {
  let timer = 0;
  let startX = 0;
  let startY = 0;
  document.addEventListener(
    "touchstart",
    (e) => {
      const hit = exerciseTileTarget(e);
      if (!hit || e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        showArtRedrawMenu(startX, startY, hit.img, hit.query);
      }, 500);
    },
    { passive: true }
  );
  const cancel = () => clearTimeout(timer);
  document.addEventListener("touchmove", cancel, { passive: true });
  document.addEventListener("touchend", cancel);
  document.addEventListener("touchcancel", cancel);
})();

// One request per image however many renders ask: the in-flight dedupe
// (CairnArtInflight) lives in art-inflight-client.ts, loaded just before this file.

// An exercise with no figure of its own yet shows the starter pack's generic
// movement-pattern figure under the photo layer. It has its OWN URL — never
// /api/art — so the SW's cache-first art layer can never keep it as this
// exercise's picture; the real photo paints over it the moment one exists, and a
// 204 (a real figure exists, or the generic was never built) just removes it.
function artGenericLayer(kind: string, query: string): string {
  if (kind !== "exercise" || CairnArtMemory.missedRecently(`generic|${query}`)) return "";
  const src = withToken(`/api/art/generic?q=${encodeURIComponent(query)}`);
  return `<img class="artimg-generic" alt="" loading="lazy" decoding="async" data-art-generic="1" data-art-q="${escAttr(query)}" data-remove-on-error="1" src="${escAttr(src)}">`;
}

// Art tile that renders the generated studio photo over a CairnArt SVG. `svg` may
// be passed (exercise art needs muscleGroup); defaults to art(kind, q). Falls back
// to SVG-only when artwork generation is off.
//   • Known-ready (cache/manifest/seen) → eager, no fade — the photo is served
//     instantly from the SW/HTTP cache, so it paints over the SVG with no flash.
//   • Unknown → lazy, fades in on first load, then remembered for next time.
function artImg(kind: string, q: unknown, cls = "artile-md", svg: string | null = null): string {
  const s = svg != null ? svg : art(kind, q);
  if (!s) return "";
  const query = String(q || "")
    .trim()
    .slice(0, 120);
  if (!artEnabled || !query) return `<div class="artile ${cls}">${s}</div>`;
  const token = artKey(kind, query);
  const ready = artReady.has(token);
  // Just answered "not drawn yet": a re-render keeps the SVG rather than asking
  // again for the same miss (the failed tile's own quiet retry still runs).
  if (!ready && CairnArtMemory.missedRecently(token)) {
    const stand = artGenericLayer(kind, query);
    return `<div class="artile${stand ? " artimg" : ""} ${cls}">${s}${stand}</div>`;
  }
  const generic = ready ? "" : artGenericLayer(kind, query);
  const src = artUrl(kind, query);
  const load = ready ? "eager" : "lazy";
  const attrs = `alt="${escAttr(query)}" loading="${load}" decoding="async" data-art-photo="1" data-artkey="${escAttr(token)}" data-art-kind="${escAttr(kind)}" data-art-q="${escAttr(query)}"`;
  const inFlight = CairnArtInflight.find(token, src);
  if (inFlight) {
    CairnArtInflight.watch(inFlight, token);
    // Hidden until it has a src (no `on`/`instant` yet, so no alt text or broken
    // glyph over the SVG); a ready figure still lands instantly when released.
    return `<div class="artile artimg ${cls}">${s}${generic}<img class="artimg-photo" ${attrs} data-art-wait="1"${ready ? ' data-art-instant="1"' : ""} data-art-src="${escAttr(src)}"></div>`;
  }
  const imgCls = ready ? "artimg-photo on instant" : "artimg-photo";
  return `<div class="artile artimg ${cls}">${s}${generic}<img class="${imgCls}" ${attrs} src="${escAttr(src)}"></div>`;
}

const CAIRN_ART_GLOBALS = {
  art,
  primeArtManifest,
  artImg,
  redrawExerciseArt,
  artUrl,
  markArtReady,
};

Object.assign(globalThis, CAIRN_ART_GLOBALS);

if (typeof window !== "undefined") {
  Object.assign(window, CAIRN_ART_GLOBALS);
}

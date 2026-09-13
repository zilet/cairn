// @ts-check
// Progressive generated artwork rendering and readiness tracking.

type ClientArtManifestResponse = import("../contracts/client-api.js").ClientArtManifestResponse;
type ClientArtVersionsResponse = import("../contracts/client-api.js").ClientArtVersionsResponse;
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
// Exercise art versions (`GET /api/art/versions`), in memory. The URL carries
// `v=` so a redraw / pose-aware replace busts the SW cache. Chosen over stuffing
// art_v onto session rows so every surface shares one map.
const artVersions = new Map<string, number>();
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
  const versions = payload?.versions;
  if (!versions || typeof versions !== "object") return;
  for (const [token, value] of Object.entries(versions)) {
    const n = Number(value);
    if (token && Number.isFinite(n) && n > 0) artVersions.set(token, n);
  }
}

function artUrl(kind: string, query: string, version?: number): string {
  const v = version ?? (kind === "exercise" ? artVersions.get(artKey(kind, query)) || 0 : 0);
  let path = `/api/art?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}`;
  if (kind === "exercise" && v > 0) path += `&v=${encodeURIComponent(String(v))}`;
  return withToken(path);
}

// Prime from the server's on-disk manifest — makes a cold client (cleared cache,
// new browser) render already-generated art instantly instead of re-flashing the
// wire on its first paint. Fire-and-forget at boot; failures are silent.
async function primeArtManifest(): Promise<void> {
  try {
    const m: ClientArtManifestResponse = await api("/art/manifest");
    if (m && "enabled" in m) artEnabled = !!m.enabled;
    if (m && Array.isArray(m.ready) && m.ready.length) {
      m.ready.forEach((k: unknown) => {
        if (typeof k === "string") artReady.add(k);
      });
      persistArtReady();
    }
  } catch {}
  try {
    applyArtVersions(await api("/art/versions"));
  } catch {}
}

function artPhotoLoaded(img: HTMLImageElement): void {
  img.classList.add("on");
  markArtReady(img.dataset.artkey); // remember for instant render next time
}
function artPhotoFailed(img: HTMLImageElement): void {
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
  if (img.dataset.retried) return; // one quiet retry only
  img.dataset.retried = "1";
  const token = pollToken;
  setTimeout(() => {
    if (token !== pollToken || !img.isConnected) return; // stale tab / re-render — bail
    img.src = img.src.includes("&r=") ? img.src : img.src + "&r=1";
  }, 20000);
}

function pollArtUntilReady(img: HTMLImageElement, src: string, attempts = 6, delayMs = 1500): void {
  const token = pollToken;
  let left = attempts;
  const tick = () => {
    if (token !== pollToken || !img.isConnected) return;
    img.src = src;
    left -= 1;
    if (left <= 0) return;
    setTimeout(tick, delayMs);
  };
  tick();
}

async function redrawExerciseArt(img: HTMLImageElement, query: string): Promise<void> {
  const token = artKey("exercise", query);
  const currentV = artVersions.get(token) || 1;
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
      return;
    }
    if (res.regenerated === false) return;
    const nextV = Number(res.version) || currentV + 1;
    artVersions.set(token, nextV);
    markArtReady(token);
    const src = artUrl("exercise", query, nextV);
    img.dataset.retried = "";
    pollArtUntilReady(img, src);
  } catch {
    const toastFn = (globalThis as unknown as { toast?: (msg: unknown) => void }).toast;
    toastFn?.("Couldn't redraw that figure");
  } finally {
    tile?.classList.remove("art-redrawing");
  }
}

let artRedrawMenu: HTMLElement | null = null;
function hideArtRedrawMenu(): void {
  artRedrawMenu?.remove();
  artRedrawMenu = null;
}
function showArtRedrawMenu(x: number, y: number, img: HTMLImageElement, query: string): void {
  hideArtRedrawMenu();
  const menu = document.createElement("div");
  menu.className = "art-redraw-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<button type="button" class="art-redraw-btn" role="menuitem">${escHtml("Redraw this figure")}</button>`;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  menu.querySelector("button")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    hideArtRedrawMenu();
    void redrawExerciseArt(img, query);
  });
  document.body.appendChild(menu);
  artRedrawMenu = menu;
  const onDoc = (ev: Event) => {
    if (artRedrawMenu && !artRedrawMenu.contains(ev.target as Node)) hideArtRedrawMenu();
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", onDoc, { capture: true, once: true });
  }, 0);
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
  const src = artUrl(kind, query);
  const ready = artReady.has(token);
  const imgCls = ready ? "artimg-photo on instant" : "artimg-photo";
  const load = ready ? "eager" : "lazy";
  return `<div class="artile artimg ${cls}">${s}<img class="${imgCls}" alt="${escAttr(query)}" loading="${load}" decoding="async" data-art-photo="1" data-artkey="${escAttr(token)}" data-art-kind="${escAttr(kind)}" data-art-q="${escAttr(query)}" src="${escAttr(src)}"></div>`;
}

const CAIRN_ART_GLOBALS = {
  art,
  primeArtManifest,
  artImg,
  redrawExerciseArt,
  artUrl,
};

Object.assign(globalThis, CAIRN_ART_GLOBALS);

if (typeof window !== "undefined") {
  Object.assign(window, CAIRN_ART_GLOBALS);
}

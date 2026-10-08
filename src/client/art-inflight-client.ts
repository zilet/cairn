// @ts-check
{
// ---- one request per image, however many renders ask ----
// A screen often renders twice in quick succession (a warm peek paint, then the
// network repaint; on a first-ever open the second paint also lands after the new
// service worker took control, so the browser cannot share the first request).
// Recreating the <img> for a URL whose request is still in flight asked for it a
// second time. Instead the re-render draws a WAITER — the same tile with the URL
// parked in `data-art-src` — and the in-flight element's outcome settles it: loaded
// means the waiter takes the src straight from the image cache, missed means it keeps
// the SVG. A bounded wait (the first element may be a lazy image that never starts
// once it is detached) hands the waiter its own src.
//
// That is only true across a service-worker takeover. Two requests for one URL made
// while the page is under the SAME control state (both direct, or both through the
// worker) are one fetch: the browser hands the second <img> the first's resource, in
// flight, with no request of its own. So a waiter is parked only when control changed
// since the page loaded; otherwise the re-render just asks, and shares. (Waiting past a
// finished load is worse than useless: setting the src then logs a second GET for a
// URL the first element already fetched.)
const ART_WAIT_MAX_MS = 6000;
const artWatched = new WeakSet<HTMLImageElement>();

function swControlled(): boolean {
  try {
    return !!(typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}
const controlledAtLoad = swControlled();

function artWaiters(token: string): HTMLImageElement[] {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return [];
  return [...document.querySelectorAll<HTMLImageElement>('img[data-art-wait="1"]')].filter(
    (img) => img.dataset.artkey === token
  );
}

function releaseArtWaiters(token: string, loaded: boolean): void {
  for (const img of artWaiters(token)) {
    const src = img.dataset.artSrc || "";
    delete img.dataset.artWait;
    delete img.dataset.artSrc;
    if (loaded && img.dataset.artInstant === "1") img.classList.add("on", "instant");
    delete img.dataset.artInstant;
    if (src) img.src = src;
  }
}

function inFlightArtImg(token: string, src: string): HTMLImageElement | null {
  if (swControlled() === controlledAtLoad) return null; // same control state: the browser shares it
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return null;
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-art-photo="1"]')) {
    if (img.dataset.artkey !== token || img.dataset.artWait === "1" || img.dataset.artWaitExpired === "1") continue;
    if (img.getAttribute("src") === src && !img.complete) return img;
  }
  return null;
}

// Follow the in-flight element to its outcome (its load/error events fire even once
// a re-render has detached it, where the document-level listeners never hear them).
function watchInFlightArt(img: HTMLImageElement, token: string): void {
  if (artWatched.has(img)) return;
  artWatched.add(img);
  let done = false;
  const finish = (loaded: boolean) => {
    if (done) return;
    done = true;
    if (loaded) {
      CairnArtMemory.forgetMiss(token);
      // art-controller.ts, loaded next: only ever called after load.
      (globalThis as { markArtReady?: (token: string) => void }).markArtReady?.(token);
    } else if (!img.isConnected) {
      CairnArtMemory.recordMiss(token);
    }
    // A miss leaves the waiters on the SVG (their own tile has no src to fail).
    if (loaded) releaseArtWaiters(token, true);
    else for (const waiter of artWaiters(token)) delete waiter.dataset.artWait;
  };
  img.addEventListener("load", () => finish(true), { once: true });
  img.addEventListener("error", () => finish(false), { once: true });
  setTimeout(() => {
    if (done) return;
    done = true;
    img.dataset.artWaitExpired = "1"; // too slow to wait on again
    releaseArtWaiters(token, false);
  }, ART_WAIT_MAX_MS);
}

  const CAIRN_ART_INFLIGHT = { find: inFlightArtImg, watch: watchInFlightArt };
  Object.assign(globalThis, { CairnArtInflight: CAIRN_ART_INFLIGHT });
}

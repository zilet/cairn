// @ts-check
{
  function registerServiceWorkerLifecycle(): void {
    if (!("serviceWorker" in navigator)) return;
    const root = globalThis as typeof globalThis & { __cairnSwLifecycleStarted?: boolean };
    if (root.__cairnSwLifecycleStarted) return;
    root.__cairnSwLifecycleStarted = true;

    // Single-user self-hosted app: a deploy should always be live on the next open
    // OR shortly after resume — not only on a cold navigation. sw.js skipWaiting()s
    // on install, so the new worker activates as soon as it downloads; reload once
    // when it takes control. The first-ever install has no prior controller and
    // must not reload.
    const hadController = !!navigator.serviceWorker.controller;
    let swReloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || swReloading) return;
      swReloading = true;
      location.reload();
    });

    // The browser only re-checks sw.js for a new version on navigation, so an
    // installed PWA that resumes from memory (typical for iOS "Add to Home
    // Screen" standalone mode, which never does a fresh navigation) can sit on a
    // stale worker indefinitely. Nudge an explicit registration.update() whenever
    // the app becomes visible again or resumes from the back/forward cache, plus
    // a slow interval as a backstop — throttled so a flurry of visibility/pageshow
    // events never spams the network.
    let registration: ServiceWorkerRegistration | undefined;
    const MIN_UPDATE_CHECK_GAP_MS = 5 * 60 * 1000;
    let lastUpdateCheck = 0;
    function checkForUpdate(): void {
      if (!registration) return;
      const now = Date.now();
      if (now - lastUpdateCheck < MIN_UPDATE_CHECK_GAP_MS) return;
      lastUpdateCheck = now;
      registration.update().catch(() => {});
    }

    navigator.serviceWorker.register("/sw.js").then((reg) => {
      registration = reg;
    }).catch(() => {});

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdate();
      });
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      // event.persisted (bfcache restore) is the case that matters most here —
      // an iOS standalone app resuming from memory never re-fetches sw.js on its
      // own — but any pageshow is a cheap, throttled opportunity to check.
      window.addEventListener("pageshow", () => checkForUpdate());
    }
    if (typeof setInterval === "function") {
      setInterval(checkForUpdate, 60 * 60 * 1000);
    }
  }

  Object.assign(globalThis, { registerServiceWorkerLifecycle });

  if (typeof window !== "undefined") {
    window.registerServiceWorkerLifecycle = registerServiceWorkerLifecycle;
  }
}

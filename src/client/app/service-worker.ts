// @ts-check
{
  function registerServiceWorkerLifecycle(): void {
    if (!("serviceWorker" in navigator)) return;
    const root = globalThis as typeof globalThis & { __cairnSwLifecycleStarted?: boolean };
    if (root.__cairnSwLifecycleStarted) return;
    root.__cairnSwLifecycleStarted = true;

    // Single-user self-hosted app: a deploy should always be live on the next open,
    // never stranded behind a manual tap. sw.js skipWaiting()s on install, so the
    // new worker activates as soon as it downloads; reload once when it takes
    // control. The first-ever install has no prior controller and must not reload.
    const hadController = !!navigator.serviceWorker.controller;
    let swReloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || swReloading) return;
      swReloading = true;
      location.reload();
    });
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  Object.assign(globalThis, { registerServiceWorkerLifecycle });

  if (typeof window !== "undefined") {
    window.registerServiceWorkerLifecycle = registerServiceWorkerLifecycle;
  }
}

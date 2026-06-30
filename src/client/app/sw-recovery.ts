// @ts-check
// Early service-worker updater. Its filename is intentionally separate from the
// normal app-service-worker helper so old caches fetch it from the network.

type ServiceWorkerRoot = typeof globalThis & {
  __cairnSwLifecycleStarted?: boolean;
  registerServiceWorkerLifecycle?: () => void;
};

{
  function startServiceWorkerLifecycle(): void {
    if (!("serviceWorker" in navigator)) return;
    const root = globalThis as ServiceWorkerRoot;
    if (root.__cairnSwLifecycleStarted) return;
    root.__cairnSwLifecycleStarted = true;

    const hadController = !!navigator.serviceWorker.controller;
    let swReloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || swReloading) return;
      swReloading = true;
      location.reload();
    });
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  const root = globalThis as ServiceWorkerRoot;
  if (typeof root.registerServiceWorkerLifecycle !== "function") {
    root.registerServiceWorkerLifecycle = startServiceWorkerLifecycle;
  }
  if (typeof window !== "undefined" && typeof window.registerServiceWorkerLifecycle !== "function") {
    window.registerServiceWorkerLifecycle = startServiceWorkerLifecycle;
  }

  startServiceWorkerLifecycle();
}

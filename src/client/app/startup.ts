// @ts-check
{
  function startAppShell(): void {
    registerServiceWorkerLifecycle();
    swrSweep(); // evict stale/over-cap SWR rows before the first paint reads the cache
    registerAppJobReconnectors();
    registerTabBarHandlers();

    const landingRoutes = routeApi();
    const landingRoute = landingRoutes ? landingRoutes.parseRoute(location.href) : null;
    const landingParams = new URLSearchParams(location.search);
    const hasRouteState = location.pathname.startsWith("/app") || landingParams.has("tab") || landingParams.has("date");
    const landingTab = hasRouteState ? applyRouteState(landingRoute) : landingParams.get("tab");
    // A v1 URL (/app/plan/food, /stand/records, ?tab=chat, ...) is rewritten to its
    // v2 home in place: replaceState, so Back never walks into the old address.
    const canonicalizeLanding = hasRouteState && (!location.pathname.startsWith("/app") || !!landingRoute?.legacy);

    primeDiscipline();
    activateTab(landingTab || "today", { replace: canonicalizeLanding, syncRoute: canonicalizeLanding });
    window.addEventListener("popstate", () => {
      // A Back that only closes (or moves) an open peek is the drill's, not a navigation.
      if (typeof CairnDrill !== "undefined" && CairnDrill.popped()) return;
      // The welcome owns its own /app/welcome addresses (its stages); leaving them
      // closes it and falls through to the app's own route.
      if (typeof CairnWelcome !== "undefined" && CairnWelcome.popped()) return;
      const routes = routeApi();
      const route = routes ? routes.parseRoute(location.href) : null;
      const tab = applyRouteState(route);
      // A v1 entry still in the history stack is canonicalised as it is re-entered.
      activateTab(tab, route?.legacy ? { replace: true } : { syncRoute: false });
    });

    maybeOnboard();
    primeArtManifest();
    // A chat turn a previous page left running may have written since: settle it so
    // its writes retire every cache they made stale (write-invalidation-client.ts).
    (globalThis as { CairnWriteInvalidation?: { resumeTurns?: () => void } }).CairnWriteInvalidation?.resumeTurns?.();
    // First paint is async, so defer a tick; jobReconnect rebuilds each running
    // job's host through the registered reconnector for that job kind.
    setTimeout(() => { jobReconnect(); }, 0);
    installMobileViewportGuards();
    installDayRolloverWatcher();
    installWakeLockWatcher();
    scheduleLazyBundleWarmup();
  }

  // Train, Horizon, Ask, Settings and Health load on first navigation. Once the
  // landing screen has painted and the page has finished loading, warm them on
  // idle so the first tap on another home is as instant as when they were eager.
  function scheduleLazyBundleWarmup(): void {
    if (typeof prefetchLazyBundles !== "function") return;
    const warm = () => prefetchLazyBundles();
    if (document.readyState === "complete") warm();
    else window.addEventListener("load", warm, { once: true });
  }

  Object.assign(globalThis, { startAppShell });

  if (typeof window !== "undefined") {
    window.startAppShell = startAppShell;
  }
}

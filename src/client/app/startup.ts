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
    const canonicalizeLanding = hasRouteState && !location.pathname.startsWith("/app");

    primeDiscipline();
    activateTab(landingTab || "today", { replace: canonicalizeLanding, syncRoute: canonicalizeLanding });
    window.addEventListener("popstate", () => {
      const routes = routeApi();
      const route = routes ? routes.parseRoute(location.href) : null;
      const tab = applyRouteState(route);
      activateTab(tab, { syncRoute: false });
    });

    maybeOnboard();
    primeArtManifest();
    // First paint is async, so defer a tick; jobReconnect rebuilds each running
    // job's host through the registered reconnector for that job kind.
    setTimeout(() => { jobReconnect(); }, 0);
    installMobileViewportGuards();
    installDayRolloverWatcher();
  }

  Object.assign(globalThis, { startAppShell });

  if (typeof window !== "undefined") {
    window.startAppShell = startAppShell;
  }
}

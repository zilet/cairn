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
    installMotionRest();
    scheduleLazyBundleWarmup();
  }

  // Ambient loops (a drifting stone, a breathing marker) pause while nobody is
  // looking: "away" when the window is blurred or hidden, "idle" after a quiet
  // spell with no input. A desktop PWA left open behind other windows counts as
  // visible, so without this a paint-bound loop (an SVG stone's drift) repaints
  // every frame for hours. Only INFINITE animations pause — an entrance landing
  // behind another window still finishes, so a background refresh never leaves
  // content faded out. While merely idle, the working vocabulary (spinner,
  // filament, typing dots) keeps moving, so a long agent call never reads frozen.
  const MOTION_IDLE_MS = 90_000;
  const WORKING_LOOPS = new Set([
    "sugspin", "enrspin", "atelier-filament", "typingdot", "hshine", "syncpulse",
    "agent-busy-breathe", "mealpulse", "recoveryOptWork",
  ]);
  function installMotionRest(): void {
    if (typeof document === "undefined" || typeof document.getAnimations !== "function") return;
    let mode: "away" | "idle" | null = null;
    let paused: Animation[] = [];
    let idleTimer: ReturnType<typeof setTimeout> | 0 = 0;
    const pauseLoops = () => {
      for (const anim of document.getAnimations()) {
        if (anim.playState !== "running" || anim.effect?.getTiming().iterations !== Infinity) continue;
        if (mode === "idle" && WORKING_LOOPS.has((anim as CSSAnimation).animationName)) continue;
        anim.pause();
        paused.push(anim);
      }
    };
    const rest = (next: "away" | "idle") => {
      mode = next;
      pauseLoops();
    };
    const away = () => document.visibilityState === "hidden" || !document.hasFocus();
    const wake = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (away()) {
        idleTimer = 0;
        rest("away");
        return;
      }
      if (mode) {
        mode = null;
        for (const anim of paused) if (anim.playState === "paused") anim.play();
        paused = [];
      }
      idleTimer = setTimeout(() => rest("idle"), MOTION_IDLE_MS);
    };
    // A loop that starts while resting (a repaint behind another window) rests too.
    document.addEventListener("animationstart", () => { if (mode) pauseLoops(); }, true);
    window.addEventListener("blur", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    for (const type of ["pointerdown", "keydown", "wheel"]) window.addEventListener(type, wake, { passive: true, capture: true });
    wake();
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

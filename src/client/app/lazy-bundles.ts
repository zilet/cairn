// "welcome" (the first-run stage and the shared AI sign-in it and Settings use) is not
// yet in the shared ClientLazyBundleName list, so the loader widens its own name.
type CairnLazyBundleName = ClientLazyBundleName | "welcome";

// @ts-check
// On-demand loader for app-shell bundles index.html does NOT load eagerly.
//
// Only Today, You, Fuel, capture and the shell are eager. Train, Horizon, Ask,
// Settings, the calendar (a day's page, peek and views, the drill controller), the meal planner (Fuel's history fold) and the
// Me / Health / Records surfaces are injected on first
// navigation to a destination that needs them, and warmed on idle after the
// first paint (prefetchLazyBundles) so a tab switch does not wait on the network.
//
// Contract, deliberately narrow:
//   - ONE <script> per bundle, ever. Concurrent callers share the same promise,
//     and a resolved bundle answers synchronously through withBundle().
//   - A bundle may DEPEND on another (LAZY_BUNDLE_DEPS): ensureBundle resolves
//     only once the bundle and every dependency have executed. Lazy bundles never
//     reference each other at load time, so they may execute in any order.
//   - The url carries NO query string. It must hash-match the service worker's
//     precached CORE_ASSETS entry (Cache Storage keys on the full url), so an
//     offline-installed PWA still resolves this from the precache. Static assets
//     are never token-gated — src/auth.ts enforces only /api and /mcp — so there
//     is no token to append here either.
//   - A failed load removes the tag so a later navigation can retry, and rejects
//     so the caller (the tab switcher) paints its normal error state.
{
  const LAZY_BUNDLE_SRC: Readonly<Record<CairnLazyBundleName, string>> = {
    "me-health": "/js/bundle-05-me-health.js",
    "train": "/js/bundle-08-train.js",
    "horizon": "/js/bundle-09-horizon.js",
    "ask": "/js/bundle-10-ask.js",
    "settings": "/js/bundle-11-settings.js",
    // The calendar: the day's views (chip, row, compact, full), its page and the drill
    // controller. Today's strip, Program and Horizon all reach it.
    "calendar": "/js/bundle-12-calendar.js",
    "meals": "/js/bundle-13-meals.js",
    // Today's below-the-Brief sections (the digest, the week, Coming up, Where you're
    // heading): Today mounts them through withBundle once its frame is painted.
    "today-ahead": "/js/bundle-14-today-ahead.js",
    // The first-run welcome and the AI sign-in panel (Settings → Agents reuses it).
    "welcome": "/js/bundle-15-welcome.js",
    // Sign-in and the passkey ceremonies: a signed-out device (the eager 401 door,
    // token-sheet.ts) and Settings → Devices.
    "auth": "/js/bundle-16-auth.js",
  };

  // What else a bundle calls into at render time. Health reuses the body-metrics
  // figure and the DEXA targeting read (train); Horizon paints the journey reads,
  // the run-plan cards and the plan week strip (train). Train's Program gallery draws
  // its movement rows and its week with the day view's shared row (calendar); Today's
  // lower half draws its week strip with the day's chip and peeks a day (calendar).
  const LAZY_BUNDLE_DEPS: Readonly<Record<CairnLazyBundleName, readonly CairnLazyBundleName[]>> = {
    "me-health": ["train"],
    "train": ["calendar"],
    "horizon": ["train"],
    "ask": [],
    // Settings → Agents "Connect" mounts the welcome bundle's sign-in panel.
    "settings": ["welcome"],
    calendar: [],
    meals: [],
    "today-ahead": ["calendar"],
    "welcome": [],
    "auth": [],
  };

  // Warm order after first paint: the homes a tap away first, Settings last.
  // Today's own lower half leads: it is the home every open lands on.
  const PREFETCH_ORDER: readonly CairnLazyBundleName[] = ["today-ahead", "train", "ask", "horizon", "calendar", "me-health", "meals", "settings", "welcome"];

  const inflight = new Map<CairnLazyBundleName, Promise<void>>();
  const executed = new Set<CairnLazyBundleName>();

  // A lazily-loaded bundle can bring boot-time registrations with it (the
  // health_review job reconnector lives on the Stand screen). Loading re-runs the
  // app's idempotent registration pass; when that registered something new, the
  // bundle OWES one reconnect sweep. The sweep is paid by the first NAVIGATION
  // into the bundle (withBundle), after that destination has painted — never at
  // load time. A reconnector only reattaches while its own view is on screen, so a
  // sweep run by the idle warm-up (on Today, say) found nothing, used up the one
  // chance, and cost every open an extra /agent-jobs round trip.
  const sweepOwed = new Set<CairnLazyBundleName>();

  function afterBundleLoaded(name: CairnLazyBundleName): void {
    const root = globalThis as { registerAppJobReconnectors?: () => unknown };
    let added: unknown;
    try {
      added = root.registerAppJobReconnectors?.();
    } catch {}
    if (added !== 0) sweepOwed.add(name);
  }

  // Pay any sweep `name`'s closure owes, once `painted` (the destination's render)
  // has settled, so the reconnector finds its view on screen.
  function settleOwedSweep(name: CairnLazyBundleName, painted: unknown): void {
    const owed = closure(name).filter((n) => sweepOwed.has(n));
    if (!owed.length) return;
    for (const n of owed) sweepOwed.delete(n);
    const reconnect = (globalThis as { jobReconnect?: (opts?: { reuseWithinMs?: number }) => Promise<void> }).jobReconnect;
    if (typeof reconnect !== "function") return;
    // The boot sweep's job list, when it is seconds old, is the list: no second read.
    void Promise.resolve(painted)
      .catch(() => {})
      .then(() => reconnect({ reuseWithinMs: 10000 }))
      .catch(() => {});
  }

  function injectBundle(name: CairnLazyBundleName, src: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (typeof document === "undefined") {
        reject(new Error(`cannot load ${name}: no document`));
        return;
      }
      const existing = document.querySelector<HTMLScriptElement>(`script[data-cairn-bundle="${name}"]`);
      if (existing?.dataset.cairnBundleLoaded === "1") {
        resolve();
        return;
      }
      const script = existing || document.createElement("script");
      script.dataset.cairnBundle = name;
      script.addEventListener(
        "load",
        () => {
          script.dataset.cairnBundleLoaded = "1";
          resolve();
        },
        { once: true }
      );
      script.addEventListener(
        "error",
        () => {
          // Drop the tag so the next attempt re-requests instead of finding a dead
          // node and assuming the bundle is on its way.
          script.remove();
          inflight.delete(name);
          reject(new Error(`failed to load ${src}`));
        },
        { once: true }
      );
      if (!existing) {
        script.src = src;
        // Injected scripts are async by default; lazy bundles have no load-time
        // ordering relationship with anything, so that is what we want.
        (document.head || document.documentElement).appendChild(script);
      }
    });
  }

  function loadOne(name: CairnLazyBundleName, warm = false): Promise<void> {
    const pending = inflight.get(name);
    if (pending) return pending;
    // A new shell is live but this page deferred its reload (app/update-gate.ts):
    // never inject the NEW lazy bundle into the OLD page. A navigation takes the
    // update here; an idle warm-up is not a safe point, so it just stops.
    if (!executed.has(name) && !bundleLoaded(name)) {
      const gate = (globalThis as { CairnUpdateGate?: { reloadIfPending?: () => boolean; hasPending?: () => boolean } }).CairnUpdateGate;
      if (warm) {
        if (gate?.hasPending?.()) return Promise.reject(new Error("update pending"));
      } else if (gate?.reloadIfPending?.()) return new Promise<void>(() => {});
    }
    const promise = injectBundle(name, LAZY_BUNDLE_SRC[name]).then(() => {
      executed.add(name);
      afterBundleLoaded(name);
    });
    inflight.set(name, promise);
    return promise;
  }

  function closure(name: CairnLazyBundleName): CairnLazyBundleName[] {
    const out: CairnLazyBundleName[] = [];
    const visit = (n: CairnLazyBundleName) => {
      if (out.includes(n)) return;
      for (const dep of LAZY_BUNDLE_DEPS[n] || []) visit(dep);
      out.push(n);
    };
    visit(name);
    return out;
  }

  /**
   * Resolve once `name`'s bundle and its dependencies have executed. Safe to call
   * on every navigation: after the first success it is a resolved-promise lookup.
   */
  function ensureBundle(name: CairnLazyBundleName): Promise<void> {
    return ensureClosure(name, false);
  }

  function ensureClosure(name: CairnLazyBundleName, warm: boolean): Promise<void> {
    if (!Object.hasOwn(LAZY_BUNDLE_SRC, name)) {
      return Promise.reject(new Error(`unknown lazy bundle: ${String(name)}`));
    }
    const parts = closure(name);
    if (parts.length === 1) return loadOne(name, warm);
    return Promise.all(parts.map((n) => loadOne(n, warm))).then(() => undefined);
  }

  /** Whether the bundle AND its dependencies have executed (no load is started by asking). */
  function bundleLoaded(name: CairnLazyBundleName): boolean {
    if (typeof document === "undefined" || !Object.hasOwn(LAZY_BUNDLE_SRC, name)) return false;
    return closure(name).every(
      (n) =>
        executed.has(n) ||
        document.querySelector(`script[data-cairn-bundle="${n}"][data-cairn-bundle-loaded="1"]`) != null
    );
  }

  /**
   * Run `fn` once `name` is ready. When it already is, `fn` runs SYNCHRONOUSLY —
   * a warm destination paints inside the caller's view transition exactly as it
   * did when the bundle was eager; only a cold one waits on the load.
   */
  function withBundle<T>(name: CairnLazyBundleName, fn: () => T): T | Promise<Awaited<T>> {
    const run = (): T => {
      const painted = fn();
      settleOwedSweep(name, painted);
      return painted;
    };
    if (bundleLoaded(name)) return run();
    return ensureBundle(name).then(() => run() as Awaited<T>);
  }

  // Warm every lazy bundle one idle slot at a time after the first paint, so the
  // first tap on Train / Horizon / Ask / You is as instant as it was when these
  // were eager. Executing (not just fetching) is the point: the parse is what a
  // tap would otherwise wait on. Skipped on Save-Data; a failed warm-up is silent
  // (the navigation that needs the bundle retries and shows its own error state).
  // The warm-up goes through ensureBundle, never withBundle, so it never pays a
  // reconnect sweep: that waits for the athlete to actually open the destination.
  let prefetchStarted = false;
  function prefetchLazyBundles(options: { delayMs?: number } = {}): void {
    if (prefetchStarted || typeof document === "undefined") return;
    prefetchStarted = true;
    const root = globalThis as { navigator?: { connection?: { saveData?: boolean } }; CAIRN_NO_WARMUP?: unknown };
    if (root.navigator?.connection?.saveData) return;
    // The browser smoke sets this for one pass so a tab switch onto a COLD bundle is
    // proven through the navigation path, not satisfied by the warm-up.
    if (root.CAIRN_NO_WARMUP === true) return;
    const idle = (cb: () => void) => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown })
        .requestIdleCallback;
      if (typeof ric === "function") ric(cb, { timeout: 4000 });
      else setTimeout(cb, 200);
    };
    const queue = PREFETCH_ORDER.slice();
    const next = (): void => {
      const name = queue.shift();
      if (!name) return;
      if (bundleLoaded(name)) {
        next();
        return;
      }
      idle(() => {
        ensureClosure(name, true)
          .catch(() => {})
          .then(() => next());
      });
    };
    setTimeout(next, Math.max(0, options.delayMs ?? 1500));
  }

  Object.assign(globalThis, { ensureBundle, bundleLoaded, withBundle, prefetchLazyBundles, LAZY_BUNDLE_SRC, LAZY_BUNDLE_DEPS });

  if (typeof window !== "undefined") {
    window.ensureBundle = ensureBundle;
    window.bundleLoaded = bundleLoaded;
    window.withBundle = withBundle;
    window.prefetchLazyBundles = prefetchLazyBundles;
  }
}

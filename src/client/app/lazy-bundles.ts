type CairnLazyBundleName = "me-health";

// @ts-check
// On-demand loader for app-shell bundles index.html does NOT load eagerly.
//
// The Me / Health / Records surfaces are ~470 KB of classic script that only the
// Stand and Me destinations need, yet every open used to parse them before the
// Brief could paint. index.html now stops at the eagerly-needed bundles and this
// module injects the rest on first navigation.
//
// Contract, deliberately narrow:
//   - ONE <script> per bundle, ever. Concurrent callers share the same promise,
//     and a resolved bundle answers synchronously from the map.
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
  };

  const inflight = new Map<string, Promise<void>>();

  // A lazily-loaded bundle can bring boot-time registrations with it (the
  // health_review job reconnector lives on the Stand screen). Re-run the app's
  // idempotent registration pass and one reconnect sweep after the bundle lands,
  // so an in-flight review still reattaches on the surface that owns it.
  function afterBundleLoaded(): void {
    const root = globalThis as {
      registerAppJobReconnectors?: () => void;
      jobReconnect?: () => Promise<void>;
    };
    try {
      root.registerAppJobReconnectors?.();
    } catch {}
    try {
      void root.jobReconnect?.();
    } catch {}
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
        // Injected scripts are async by default; this bundle has no ordering
        // relationship with anything still parsing, so that is what we want.
        (document.head || document.documentElement).appendChild(script);
      }
    });
  }

  /**
   * Resolve once `name`'s bundle has executed. Safe to call on every navigation:
   * after the first success it is a resolved-promise lookup.
   */
  function ensureBundle(name: CairnLazyBundleName): Promise<void> {
    const src = LAZY_BUNDLE_SRC[name];
    if (!src) return Promise.reject(new Error(`unknown lazy bundle: ${String(name)}`));
    const pending = inflight.get(name);
    if (pending) return pending;
    const promise = injectBundle(name, src).then(() => {
      afterBundleLoaded();
    });
    inflight.set(name, promise);
    return promise;
  }

  /** Whether the bundle has already executed (no load is started by asking). */
  function bundleLoaded(name: CairnLazyBundleName): boolean {
    if (typeof document === "undefined") return false;
    return document.querySelector(`script[data-cairn-bundle="${name}"][data-cairn-bundle-loaded="1"]`) != null;
  }

  Object.assign(globalThis, { ensureBundle, bundleLoaded, LAZY_BUNDLE_SRC });

  if (typeof window !== "undefined") {
    window.ensureBundle = ensureBundle;
    window.bundleLoaded = bundleLoaded;
  }
}

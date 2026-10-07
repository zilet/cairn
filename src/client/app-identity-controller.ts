// @ts-check
// Installed-app identity controller: stamps which icon/name an iOS home-screen
// install was added with (at load, before anything else writes storage), mounts the
// one-time re-add note, and mounts Settings -> Data's "This app" block (server build,
// this app's shell). Rules live in app-identity-model.ts, markup in
// app-identity-client.ts.

type AppIdentityStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "key" | "length">>;

type AppIdentityNoteDeps = {
  storage: AppIdentityStorage | null;
  env: AppIdentityEnv;
  outboxCount(): number;
  version?: number;
};

type AppIdentityCardDeps = {
  api(path: string): Promise<unknown>;
  /** The derived cache name the controlling worker holds: "" with no worker, null when it did not answer. */
  workerShell(): Promise<string | null>;
};

type AppIdentityControllerApi = {
  env(): AppIdentityEnv;
  stampInstall(storage: AppIdentityStorage | null, current?: number): number;
  mountReaddNote(host: Element, deps: AppIdentityNoteDeps): () => void;
  mountAppCard(host: Element, deps: AppIdentityCardDeps): () => void;
  workerShell(nav?: Navigator, wait?: (ms: number) => Promise<void>): Promise<string | null>;
};
declare const CairnAppIdentityController: AppIdentityControllerApi;

{
  const model = CairnAppIdentityModel;
  const WORKER_SHELL_WAIT_MS = 1500;

  function appIdentityEnv(): AppIdentityEnv {
    const env: AppIdentityEnv = {};
    try {
      const nav = navigator as Navigator & { standalone?: boolean };
      env.userAgent = nav.userAgent || "";
      env.maxTouchPoints = nav.maxTouchPoints || 0;
      env.navigatorStandalone = nav.standalone === true;
    } catch {}
    try {
      env.displayStandalone = !!window.matchMedia?.("(display-mode: standalone)").matches;
    } catch {}
    return env;
  }

  function read(storage: AppIdentityStorage | null, key: string): string | null {
    try {
      return storage ? storage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  // Keys that say nothing about an install's age: this module's own, and the client
  // diagnostics ring, which a load-time error can write before the stamp runs.
  const NOT_PRIOR_STATE = new Set([model.STAMP_KEY, model.DISMISS_KEY, "cairn.diagnostics.v1"]);

  // Any other Cairn state on this device means the install predates the stamp.
  function hasPriorState(storage: AppIdentityStorage): boolean {
    try {
      const length = Number(storage.length) || 0;
      for (let i = 0; i < length; i++) {
        const key = storage.key?.(i) || "";
        if (NOT_PRIOR_STATE.has(key)) continue;
        if (key.startsWith("cairn") || key === "restSec" || key.startsWith("shop:")) return true;
      }
    } catch {}
    return false;
  }

  function stampInstall(storage: AppIdentityStorage | null, current: number = model.VERSION): number {
    if (!storage) return current;
    const stored = read(storage, model.STAMP_KEY);
    const stamp = model.stampFor(stored, !stored && hasPriorState(storage), current);
    if (model.parseVersion(stored) !== stamp) {
      try {
        storage.setItem(model.STAMP_KEY, String(stamp));
      } catch {}
    }
    return stamp;
  }

  function mountReaddNote(host: Element, deps: AppIdentityNoteDeps): () => void {
    const current = deps.version ?? model.VERSION;
    if (host.querySelector(".app-readd")) return () => {};
    let outboxCount = 1;
    try {
      outboxCount = Number(deps.outboxCount()) || 0;
    } catch {}
    const visible = model.noteVisible({
      iosStandalone: model.isIOSStandalone(deps.env),
      outboxCount,
      installedWith: model.parseVersion(read(deps.storage, model.STAMP_KEY)),
      dismissedFor: model.parseVersion(read(deps.storage, model.DISMISS_KEY)),
      current,
    });
    if (!visible) return () => {};
    const doc = host.ownerDocument || document;
    const slot = doc.createElement("div");
    slot.className = "app-readd-slot";
    slot.innerHTML = CairnAppIdentity.readdNoteHtml(model.reentry((key) => read(deps.storage, key)));
    host.append(slot);
    const teardown = CairnUiActions.mount(slot, "app-readd", ({ delegate }) =>
      delegate("click", {
        "readd-dismiss": () => {
          try {
            deps.storage?.setItem(model.DISMISS_KEY, String(current));
          } catch {}
          teardown();
          slot.remove();
        },
      })
    );
    return teardown;
  }

  async function workerShell(
    nav: Navigator = navigator,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ): Promise<string | null> {
    const controller = nav?.serviceWorker?.controller;
    if (!controller) return "";
    if (typeof MessageChannel === "undefined") return null;
    const channel = new MessageChannel();
    const answer = new Promise<string | null>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent) => {
        const shell = event.data && typeof event.data.shell === "string" ? event.data.shell : null;
        resolve(shell);
      };
    });
    try {
      controller.postMessage({ type: "cairn-shell" }, [channel.port2]);
    } catch {
      return null;
    }
    // A worker from before this message existed never answers.
    const result = await Promise.race([answer, wait(WORKER_SHELL_WAIT_MS).then(() => null)]);
    try {
      channel.port1.close();
    } catch {}
    return result;
  }

  function healthBuildLabel(health: Record<string, unknown> | null): string {
    if (!health) return "";
    const build = health.build && typeof health.build === "object" ? (health.build as Record<string, unknown>) : {};
    const version = String(build.version || health.version || "").trim();
    const id = String(build.build_id || "").trim();
    return version && id ? `${version}@${id}` : version || id;
  }

  function shellState(workerShellValue: string | null, serverShell: string): AppIdentityShellState {
    if (workerShellValue === "") return "none";
    if (!workerShellValue || !serverShell) return "unknown";
    return workerShellValue === serverShell ? "current" : "behind";
  }

  function mountAppCard(host: Element, deps: AppIdentityCardDeps): () => void {
    const model0: AppIdentityCardModel = {
      build: "",
      shell: "",
      shellState: "checking",
    };
    host.innerHTML = CairnAppIdentity.appCardHtml(model0);

    const teardown = CairnUiActions.mount(host, "appid", ({ signal }) => {
      void Promise.all([deps.api("/health").catch(() => null), deps.workerShell().catch(() => null)]).then(
        ([rawHealth, shell]) => {
          if (signal.aborted || !host.isConnected) return;
          const health = rawHealth && typeof rawHealth === "object" ? (rawHealth as Record<string, unknown>) : null;
          const serverShell = health && typeof health.shell === "string" ? health.shell : "";
          host.innerHTML = CairnAppIdentity.appCardHtml({
            ...model0,
            build: healthBuildLabel(health) || "Not reported",
            shell: shell || "",
            shellState: shellState(shell, serverShell),
          });
        }
      );
    });
    return teardown;
  }

  const CAIRN_APP_IDENTITY_CONTROLLER: AppIdentityControllerApi = {
    env: appIdentityEnv,
    stampInstall,
    mountReaddNote,
    mountAppCard,
    workerShell,
  };

  Object.assign(globalThis, { CairnAppIdentityController: CAIRN_APP_IDENTITY_CONTROLLER });

  // Stamp at load, before any later code writes storage: a just-added iOS install is
  // empty right now, and that emptiness is how it is told apart from an old one.
  try {
    if (
      typeof window !== "undefined" &&
      typeof localStorage !== "undefined" &&
      model.isIOSStandalone(appIdentityEnv())
    ) {
      stampInstall(localStorage);
    }
  } catch {}
}

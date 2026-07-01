// @ts-check
// Shared view-transition helpers. Keeps transition-abort handling out of screen shells.

type UiViewTransitionDeps = {
  view: HTMLElement;
  reducedMotion(): boolean;
};

type UiViewTransitionApi = {
  viewEnter(): void;
  withViewTransition(fn: () => unknown): Promise<unknown>;
  skelSwap(fn: () => unknown): Promise<unknown>;
};

type UiViewTransitionsClientApi = {
  create(deps: UiViewTransitionDeps): UiViewTransitionApi;
  isViewTransitionAbort(error: unknown): boolean;
};

(() => {
  function errorRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function isViewTransitionAbort(error: unknown): boolean {
    const row = error instanceof Error ? { name: error.name, message: error.message } : errorRecord(error);
    const name = String(row.name || "");
    const message = String(row.message || error || "");
    return name === "AbortError" || (name === "InvalidStateError" && /transition/i.test(message));
  }

  function create(deps: UiViewTransitionDeps): UiViewTransitionApi {
    let active = false;

    function viewEnter(): void {
      if (deps.reducedMotion()) return;
      deps.view.classList.remove("view-in");
      void deps.view.offsetWidth;
      deps.view.classList.add("view-in");
    }

    function runViewSwap(fn: () => unknown): Promise<unknown> {
      try {
        return Promise.resolve(fn());
      } catch (error) {
        return Promise.reject(error);
      }
    }

    function quietTransitionPromise(promise: Promise<unknown>): Promise<unknown> {
      return Promise.resolve(promise).catch((error) => {
        if (!isViewTransitionAbort(error)) throw error;
      });
    }

    function quietSecondaryTransitionPromise(promise: Promise<unknown>): void {
      Promise.resolve(promise).catch((error) => {
        if (!isViewTransitionAbort(error)) setTimeout(() => { throw error; }, 0);
      });
    }

    function withViewTransition(fn: () => unknown): Promise<unknown> {
      if (document.startViewTransition && !deps.reducedMotion() && !active) {
        try {
          active = true;
          const transition = document.startViewTransition(() => runViewSwap(fn));
          const done = transition.updateCallbackDone || transition.finished || Promise.resolve();
          if (transition.ready) quietSecondaryTransitionPromise(transition.ready);
          if (transition.finished && transition.finished !== done) quietSecondaryTransitionPromise(transition.finished);
          return quietTransitionPromise(done).finally(() => { active = false; });
        } catch {
          active = false;
        }
      }
      return runViewSwap(fn);
    }

    function skelSwap(fn: () => unknown): Promise<unknown> {
      if (active) return runViewSwap(fn);
      return withViewTransition(fn);
    }

    return { viewEnter, withViewTransition, skelSwap };
  }

  const CAIRN_UI_VIEW_TRANSITIONS: UiViewTransitionsClientApi = {
    create,
    isViewTransitionAbort,
  };

  Object.assign(globalThis, { CairnUiViewTransitions: CAIRN_UI_VIEW_TRANSITIONS });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnUiViewTransitions: CAIRN_UI_VIEW_TRANSITIONS });
  }
})();

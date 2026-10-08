// @ts-check
// Fuel — the "Log food" control, the controller (docs/V2-PLAN.md wave 2).
// `mount(host, deps)` paints the button and, on the first open, mounts the ONE food
// composer (CairnFoodComposer, injected as `deps.mountComposer`) under it in food
// mode. The composer follows its own send to the food rows it logged and hands them
// to `deps.onLogged`, so a meal logged here lands in Fuel's list without leaving the
// screen; the panel then closes. Closing only hides the composer — a send still
// being followed keeps going — and the composer is torn down with this mount.
//
//   const log = CairnFuelLogController.mount(slot, deps);
//   log.open("Greek yogurt (a half portion)"); // "Start from this": fills (below any unsent text), never sends
//   log();                                         // teardown
{
  type Deps = ClientFuelLogDeps;

  function mountFuelLog(host: Element, deps: Deps): ClientFuelLogHandle {
    let composer: FoodComposerHandle | null = null;
    let isOpen = false;

    const root = (): HTMLElement | null => host.querySelector<HTMLElement>(".fuel-log");
    const input = (): HTMLTextAreaElement | null =>
      host.querySelector<HTMLTextAreaElement>("[data-fuel-log-composer] textarea");

    function setOpen(open: boolean): void {
      isOpen = open;
      root()?.classList.toggle("is-open", open);
      host.querySelector("[data-fuel-log-toggle]")?.setAttribute("aria-expanded", String(open));
    }

    function ensureComposer(): FoodComposerHandle | null {
      if (composer) return composer;
      const slot = host.querySelector("[data-fuel-log-composer]");
      if (!slot) return null;
      composer = deps.mountComposer(slot, {
        mode: "food",
        idPrefix: "fuelLog",
        api: deps.api,
        toast: deps.toast,
        isActive: () => isOpen && host.isConnected,
        hour: deps.hour,
        draft: deps.draft,
        retryStore: deps.retryStore,
        onLogged: (logged) => {
          if (!host.isConnected) return;
          deps.onLogged(logged);
          close();
        },
      });
      return composer;
    }

    function open(prefill?: string | null): void {
      if (!host.isConnected) return;
      setOpen(true);
      const c = ensureComposer();
      // "Start from this" fills the composer for editing (and focuses it); it never
      // sends. Unsent text already there is kept: the idea goes on a line below it.
      const idea = prefill == null ? "" : String(prefill).trim();
      if (idea && c) {
        const typed = input()?.value ?? "";
        const lines = typed.split("\n").map((line) => line.trim());
        if (!typed.trim()) c.fill(idea);
        else if (lines.includes(idea)) c.fill(typed);
        else {
          c.fill(`${typed.replace(/\s+$/, "")}\n${idea}`);
          deps.toast("Added below what you'd typed");
        }
      }
      // Focus without the browser's own jump; the one reveal brings the composer clear
      // of the keyboard and the tab bar once the keyboard has settled.
      const field = input();
      if (typeof CairnFocusReveal !== "undefined") CairnFocusReveal.focus(field, { box: root() });
      else field?.focus();
    }

    function close(): void {
      setOpen(false);
      input()?.blur();
    }

    const teardown = CairnUiActions.mount(host, "fuel-log", ({ delegate }) => {
      host.innerHTML = CairnFuelLog.html();
      delegate("click", {
        "fuel-log-toggle": () => (isOpen ? close() : open()),
      });
      return () => {
        composer?.();
        composer = null;
        isOpen = false;
      };
    });
    return Object.assign(teardown, { open, close });
  }

  const CAIRN_FUEL_LOG_CONTROLLER = {
    mount: mountFuelLog,
  };

  Object.assign(globalThis, { CairnFuelLogController: CAIRN_FUEL_LOG_CONTROLLER });
}

// @ts-check
// Train › Intake / Energy, the "Log a meal" button (split out of progress-screen.ts): it
// mounts the food composer through the shell's mountFuelLog (the lazy fuel bundle is the
// shell's to reach, never Train's), is the ONE toggle for it, and lets the composer go
// when the athlete leaves the screen. wireIntakeLog / refreshAfterLog stay globals for
// renderIntake and renderEnergy.

// After a meal is logged from the Intake/Energy composer: re-read that surface and repaint it if still on screen.
const refreshAfterLog = (token: number, path: string, seg: string, key: string, paint: (data: unknown) => void) => () =>
  api(path)
    .then((fresh) => {
      if (token !== pollToken || state.tab !== "progress" || state.progressSeg !== seg) return;
      swrSet(key, fresh);
      paint(fresh);
    })
    .catch(() => {});

let _intakeLogTeardown: (() => void) | null = null;
function wireIntakeLog(token: number, onLogged?: () => void): void {
  _intakeLogTeardown?.();
  _intakeLogTeardown = null;
  const btn = view.querySelector<HTMLButtonElement>("[data-intake-log-btn]");
  const slot = view.querySelector<HTMLElement>("[data-intake-log-slot]");
  if (!btn || !slot) return;
  let handle: ClientFuelLogHandle | null = null;
  const isOpen = (): boolean => !!slot.querySelector(".fuel-log.is-open");
  const syncExpanded = (): void => btn.setAttribute("aria-expanded", String(isOpen()));
  const toggle = (h: ClientFuelLogHandle): void => {
    if (isOpen()) h.close();
    else h.open();
    syncExpanded();
  };
  // Leaving the screen replaces #view's children and strands the slot on a detached node;
  // the mounted composer (its listeners, a draft timer) goes with it. The next wire also
  // lands here, so a screen change and a re-wire release the same way.
  let leaveWatch: MutationObserver | null = null;
  const leave = (): void => {
    leaveWatch?.disconnect();
    leaveWatch = null;
    handle?.();
    handle = null;
    if (_intakeLogTeardown === leave) _intakeLogTeardown = null;
  };
  _intakeLogTeardown = leave;
  if (typeof MutationObserver === "function") {
    leaveWatch = new MutationObserver(() => {
      if (!slot.isConnected) leave();
    });
    leaveWatch.observe(view, { childList: true });
  }
  // A cold first tap loads the fuel bundle through the shell; taps meanwhile are ignored so the toggle never runs twice.
  let pending = false;
  btn.addEventListener("click", () => {
    if (pending) return;
    if (handle) return toggle(handle);
    pending = true;
    const onLog = (): void => {
      if (typeof swrInvalidate === "function") {
        swrInvalidate("progress:intake");
        swrInvalidate("progress:energy");
      }
      onLogged?.();
      setTimeout(syncExpanded, 0);
    };
    void Promise.resolve(mountFuelLog(slot, onLog))
      .then((h) => {
        pending = false;
        // Left (or re-wired) while the bundle loaded: nothing to keep.
        if (token !== pollToken || (slot as { isConnected?: boolean }).isConnected === false || _intakeLogTeardown !== leave)
          return h();
        handle = h;
        slot.querySelector("[data-fuel-log-toggle]")?.addEventListener("click", () => setTimeout(syncExpanded, 0));
        toggle(h);
      })
      .catch(() => {
        pending = false;
      });
  });
}

Object.assign(globalThis, { refreshAfterLog, wireIntakeLog });

// @ts-check
// Mid-entry safety for the Session surface: a set is typed into fields and logged
// with one tap, often on a phone with a flaky signal. Two things used to break it:
//   - a background repaint (a queued set syncing, the first set's Finish block)
//     replaced every node while a field was focused or a finger was down, which
//     dropped the keyboard mid-number and detached the button being pressed;
//   - tapping Log blurred the weight field first, the keyboard closed, the tab and
//     rest bars slid back, the button moved under the finger and iOS cancelled the
//     click — so the first Log never logged.
{
  type RepaintOpts = { soft?: boolean; fresh?: boolean; [key: string]: unknown };

  // `act` fires on the tap without moving focus off the field being typed in.
  // preventDefault on a touch pointerdown keeps focus (on iOS WebKit it also
  // suppresses the synthesized click), so a touch acts on pointerup — only when
  // the finger lifts over the button. The click stays for mouse and keyboard and
  // is ignored right after a pointerup acted.
  function tapWithoutBlur(button: HTMLElement, act: () => unknown): void {
    let pointerActedAt = 0;
    button.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") event.preventDefault();
    });
    button.addEventListener("pointerup", (event) => {
      if (event.pointerType === "mouse") return;
      const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(event.clientX, event.clientY) : button;
      if (hit && !button.contains(hit)) return; // slid off: not a tap
      pointerActedAt = Date.now();
      void act();
    });
    button.addEventListener("click", () => {
      if (Date.now() - pointerActedAt < 800) return;
      void act();
    });
  }

  // Wraps a surface's full repaint so one landing mid-entry waits until the
  // athlete is between entries — focus off the surface's fields, no finger down —
  // then lands at once. Requests that pile up merge: any full or fresh request
  // outranks a soft one. A fresh entry, or a host with no surface yet, never waits.
  function repaintGate(
    host: HTMLElement,
    surfaceSelector: string,
    paint: (opts: RepaintOpts) => Promise<void>,
  ): (opts?: RepaintOpts) => Promise<void> {
    // When a finger went down on the surface; 0 = none. A press older than a few
    // seconds counts as over, so one lost pointerup can never hold repaints back.
    let pointerDownAt = 0;
    let queued: { opts: RepaintOpts; waiters: Array<() => void> } | null = null;
    let watching = false;

    const entering = (): boolean => {
      if (pointerDownAt && Date.now() - pointerDownAt < 4000) return true;
      const active = typeof document !== "undefined" ? document.activeElement : null;
      return !!active?.matches?.("input, textarea, select") && !!active.closest?.(surfaceSelector) && host.contains(active);
    };
    const flush = () => {
      if (!queued || entering()) return;
      const { opts, waiters } = queued;
      queued = null;
      Promise.resolve(paint(opts)).finally(() => waiters.forEach((done) => done()));
    };
    // A tick late, so a pointerup's own click (and focus moving field to field)
    // settles before the repaint.
    const later = () => setTimeout(flush, 60);
    const watch = () => {
      if (watching || typeof document === "undefined") return;
      watching = true;
      const passive = { capture: true, passive: true };
      host.addEventListener("pointerdown", () => { pointerDownAt = Date.now(); }, passive);
      const up = () => {
        if (!pointerDownAt) return;
        pointerDownAt = 0;
        later();
      };
      document.addEventListener("pointerup", up, passive);
      document.addEventListener("pointercancel", up, passive);
      host.addEventListener("focusout", later);
      // Backgrounding is a natural break; a hidden page cannot be mid-tap.
      document.addEventListener("visibilitychange", () => {
        pointerDownAt = 0;
        if (document.visibilityState === "visible") later();
      });
    };

    return (opts: RepaintOpts = {}) => {
      watch();
      if (opts.fresh || !host.querySelector(surfaceSelector) || !entering()) return paint(opts);
      if (!queued) queued = { opts: { soft: true }, waiters: [] };
      const merged = queued.opts;
      if (!opts.soft) merged.soft = false;
      for (const key of Object.keys(opts)) if (key !== "soft") merged[key] = opts[key];
      const waiters = queued.waiters;
      return new Promise<void>((resolve) => waiters.push(resolve));
    };
  }

  // One gate per painter, so every caller of the same repaint shares its queue.
  const gates = new WeakMap<object, (opts?: RepaintOpts) => Promise<void>>();
  function gate(host: HTMLElement, surfaceSelector: string, paint: (opts: RepaintOpts) => Promise<void>) {
    let gated = gates.get(paint);
    if (!gated) gates.set(paint, (gated = repaintGate(host, surfaceSelector, paint)));
    return gated;
  }

  const CAIRN_SESSION_ENTRY = { tapWithoutBlur, gate };
  Object.assign(globalThis, { CairnSessionEntry: CAIRN_SESSION_ENTRY });
}

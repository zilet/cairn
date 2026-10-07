// @ts-check
{
  let installed = false;

  // ONE app-wide keyboard state (`html.kb-up`): the soft keyboard is on screen for a
  // focused text field, on any surface. Chat keeps its own finer-grained body classes
  // for its column; this one is what everything else keys off — above all the tab
  // bar, which is `position:fixed; bottom: var(--vvb)` and would otherwise ride up
  // on top of the keyboard and sit over the very composer being typed into (the Fuel
  // log on an installed iPhone PWA). Standard iOS behavior: the bar steps away while
  // typing and comes back when the keyboard does.
  //
  // Pure, so it is testable without a DOM: the keyboard is "up" only when the
  // viewport geometry says a keyboard is occluding the page AND a text field has
  // focus on a soft-keyboard device AND the page is not pinch-zoomed (a zoom shrinks
  // the visual viewport exactly like a keyboard does).
  function keyboardUpState(input: { geometryOpen: boolean; textFocused: boolean; scale?: number | null }): boolean {
    const zoomed = typeof input.scale === "number" && Number.isFinite(input.scale) && input.scale > 1.05;
    return !!input.geometryOpen && !!input.textFocused && !zoomed;
  }

  // How far to scroll the page so a composer box sits inside the visible viewport
  // (layout-viewport coordinates, as getBoundingClientRect reports them): its bottom
  // just above the keyboard, or — when it is taller than what is visible — its top
  // at the top. 0 when it is already in view.
  function revealDelta(rect: { top: number; bottom: number }, visibleTop: number, visibleHeight: number): number {
    const margin = 12;
    const visibleBottom = visibleTop + visibleHeight;
    if (rect.bottom <= visibleBottom - 8 && rect.top >= visibleTop) return 0;
    if (rect.bottom - rect.top > visibleHeight - 2 * margin) return Math.round(rect.top - visibleTop - margin);
    return Math.round(rect.bottom - visibleBottom + margin);
  }

  function installMobileViewportGuards(): void {
    if (installed) return;
    installed = true;

    // Keep the bottom-fixed UI (tab bar, rest timer, toast) clear of the mobile
    // browser's bottom toolbar. iOS Safari anchors position:fixed;bottom:0 to the
    // full layout viewport, so a visible address/tool bar overlaps the tab bar and
    // clips its labels (env(safe-area-inset-bottom) is 0 in a normal tab, only the
    // installed PWA gets it). visualViewport tells us how much layout viewport is
    // hidden at the bottom; we lift everything by that much via the --vvb variable.
    // Re-measure the chat column whenever the viewport shifts (zoom, keyboard,
    // orientation, window resize). Cheap and idempotent — bails immediately when
    // Chat isn't on screen.
    // measureChatTop rides the lazy ask bundle: nothing to measure until it has landed.
    const syncChatViewport = () => { if (state.tab === "chat" && typeof measureChatTop === "function") measureChatTop(); };
    window.addEventListener("resize", syncChatViewport);
    window.addEventListener("orientationchange", syncChatViewport);

    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    // On touch devices, focus/tap is useful as an early "keyboard requested" signal,
    // but it is not durable truth: iOS can dismiss the keyboard while keeping the
    // textarea focused. The lasting state comes from visualViewport geometry. Compare
    // both innerHeight-vs-vv.height (Safari tab) and vvMax-vs-vv.height (installed
    // PWA, where the layout viewport can shrink with the visual viewport). Pointer
    // devices are excluded from the intent path so desktop chat auto-focus does not
    // briefly hide the bottom bar.
    const TEXTY = /^(|text|search|email|url|tel|password|number)$/;
    const softKeyboard = () => !matchMedia("(hover:hover)").matches;
    const textInputEl = (el: EventTarget | Element | null | undefined): el is HTMLElement => {
      if (!(el instanceof Element) || el === document.body) return false;
      if (el.tagName === "TEXTAREA") return true;
      if (el.tagName === "INPUT") return TEXTY.test((el.getAttribute("type") || "").toLowerCase());
      return el instanceof HTMLElement && el.isContentEditable === true;
    };
    const focusedTextInput = () => softKeyboard() && textInputEl(document.activeElement);
    // The tallest visual viewport seen this orientation approximates the no-keyboard
    // height. Used to tell "keyboard is actually on screen" from "keyboard is gone"
    // in both Safari tabs and installed PWAs.
    let vvMax = vv.height;
    let keyboardIntentUntil = 0;
    let nativePickerFocusSuppressUntil = 0;
    let settleTimer: ReturnType<typeof setTimeout> | 0 = 0;
    // Relaxed threshold so a SMALL keyboard (a hardware accessory bar, an iPad
    // floating/split keyboard) still registers as "open" instead of reading closed
    // mid-type — a false "closed" used to trigger a stale-focus blur.
    const keyboardThreshold = () => Math.max(100, window.innerHeight * 0.15);
    const keyboardGeometryOpen = () => {
      const layoutShrink = Math.max(0, window.innerHeight - vv.height);
      const visualShrink = Math.max(0, vvMax - vv.height);
      return Math.max(layoutShrink, visualShrink) > keyboardThreshold();
    };
    const keyboardIntentOpen = () => Date.now() < keyboardIntentUntil;
    const isChatTextInput = (el: EventTarget | Element | null | undefined): el is HTMLElement =>
      textInputEl(el) && Boolean(el.closest?.(".chatview"));
    // NOTE: there is deliberately no blur-by-heuristic here anymore. iOS can dismiss
    // the keyboard without blurring the textarea, and a stale geometry read (resume,
    // small keyboard) used to make us blur the composer — dropping a keyboard that
    // was actually up. Recovery is now REFOCUS-only (on the next real tap); we never
    // blur the composer from a heuristic.
    const settle = (long = false) => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(sync, long ? 960 : 420);
    };
    const requestKeyboard = (target: EventTarget | Element | null | undefined = document.activeElement) => {
      if (!softKeyboard()) return;
      const isChatTarget = isChatTextInput(target);
      if (isChatTarget && Date.now() < nativePickerFocusSuppressUntil) {
        sync();
        settle(true);
        return;
      }
      keyboardIntentUntil = Date.now() + (isChatTarget ? 1500 : 900);
      sync();
      settle(true);
    };
    const applyVvb = () => {
      // Pin the fixed bottom bars (toast, rest timer, and the tab bar when shown) to
      // the VISUAL viewport's bottom edge: settled PWA -> 0; browser tab with a bottom
      // toolbar -> positive. NOT forced to 0 while the keyboard is up — the tab bar is
      // slid off-screen by CSS then, and the toast/rest-bar should float ABOVE the
      // keyboard rather than snap down behind it.
      const rawVvb = window.innerHeight - (vv.offsetTop + vv.height);
      root.style.setProperty("--vvb", `${Math.round(Math.max(0, rawVvb))}px`);
      // Its top twin: how far iOS has scrolled the visual viewport down (it does as the
      // keyboard rises). A full-screen fixed layer pinned between --vvt and --vvb is
      // exactly the visible area, so its bottom-docked composer rides the keyboard top.
      root.style.setProperty("--vvt", `${Math.round(Math.max(0, vv.offsetTop))}px`);
    };
    // The focused field (and its composer) stays in view above the keyboard. The
    // browser scrolls a focused field into view as the keyboard rises, but it measures
    // before the tab bar steps away and does not know about a composer's send row, so
    // once the keyboard has settled the whole composer is brought into view if any of
    // it is still hidden. Chat owns its own column (measureChatTop), so it is skipped.
    let kbUp = false;
    let revealTimer: ReturnType<typeof setTimeout> | 0 = 0;
    const revealFocusedComposer = () => {
      const active = document.activeElement;
      if (!textInputEl(active)) return;
      const el: HTMLElement = active;
      if (el.closest?.(".chatview")) return;
      const box = (el.closest?.(".chatbar, .fuel-log-composer, [data-composer], .logrow, form") as HTMLElement | null) || el;
      if (typeof box.getBoundingClientRect !== "function") return;
      const rect = box.getBoundingClientRect();
      // Scroll by the MEASURED overlap with the visual viewport, never
      // scrollIntoView({block:"end"}): iOS WebKit keeps the layout viewport at full
      // height under the keyboard, so "end" lines the composer up behind it.
      const delta = revealDelta(rect, vv.offsetTop, vv.height);
      if (!delta) return;
      try {
        window.scrollBy(0, delta);
      } catch {}
    };
    // Moving weight -> reps -> RIR keeps the keyboard up, so no kb-up transition fires
    // and iOS's own scroll-to-field lands somewhere arbitrary (often under the keyboard).
    // Re-run the reveal for every field focused while the keyboard is already up, and
    // once more after iOS's own scroll has finished fighting us.
    const revealAfterFocus = () => {
      if (!kbUp) return;
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = setTimeout(() => {
        revealTimer = 0;
        if (root.classList?.contains("kb-up")) revealFocusedComposer();
      }, 140);
      setTimeout(() => { if (root.classList?.contains("kb-up")) revealFocusedComposer(); }, 420);
    };
    const syncKeyboardUp = (geometryOpen: boolean) => {
      const up = keyboardUpState({ geometryOpen, textFocused: focusedTextInput(), scale: vv.scale });
      root.classList?.toggle("kb-up", up);
      if (up && !kbUp) {
        if (revealTimer) clearTimeout(revealTimer);
        revealTimer = setTimeout(() => {
          revealTimer = 0;
          if (root.classList?.contains("kb-up")) revealFocusedComposer();
        }, 320);
      }
      kbUp = up;
    };
    const sync = () => {
      if (vv.height > vvMax) vvMax = vv.height;
      const geometryOpen = keyboardGeometryOpen();
      if (geometryOpen) {
        keyboardIntentUntil = 0;
        nativePickerFocusSuppressUntil = 0;
      }
      const kbOpen = geometryOpen || keyboardIntentOpen();
      // STRUCTURAL layout (tab bar slide, chat-column re-anchor to bottom:0, chatnote
      // hide) is gated on REAL keyboard geometry only — an intent tap that never
      // summons a keyboard must not bounce the tab bar. `kb-open` (intent) is kept for
      // cheap cosmetic prep only and drives nothing structural.
      document.body.classList.toggle("kb-geometry-open", geometryOpen);
      document.body.classList.toggle("kb-open", kbOpen);
      syncKeyboardUp(geometryOpen);
      applyVvb();
      syncChatViewport();
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync); // keyboard open/close shifts offsetTop
    window.addEventListener("orientationchange", () => { vvMax = vv.height; sync(); });
    // Focus/tap is an early intent signal, not proof that the keyboard is open.
    document.addEventListener("pointerdown", (e) => { if (textInputEl(e.target)) requestKeyboard(e.target); }, true);
    document.addEventListener("focusin", (e) => { if (focusedTextInput()) { requestKeyboard(e.target); revealAfterFocus(); } else sync(); }, true);
    // A repaint that restores the focused field (preventScroll) calls this to re-reveal it.
    document.addEventListener("cairn:reveal-focused", revealAfterFocus);
    document.addEventListener("focusout", () => {
      sync();
      requestAnimationFrame(() => requestAnimationFrame(sync));
      setTimeout(sync, 300);
    }, true);
    // Resume paths can leave visualViewport metrics stale; re-measure after pageshow,
    // focus, app-visible, and explicit chat keyboard-settle notifications.
    const resync = () => { sync(); requestAnimationFrame(() => requestAnimationFrame(sync)); };
    // On resume the vvMax ratchet can be stale. Re-baseline it to the current height,
    // but ONLY when no text input is focused (keyboard down) — otherwise we'd shrink
    // the tall baseline the PWA needs to keep detecting an on-screen keyboard, and
    // (now that we never blur) that would just misread geometry, not drop the keyboard.
    const reseedAndResync = () => { if (!focusedTextInput()) vvMax = vv.height; resync(); };
    window.addEventListener("pageshow", reseedAndResync);
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reseedAndResync(); });
    document.addEventListener("cairn:keyboard-settle", (event) => {
      const detail = event instanceof CustomEvent && event.detail && typeof event.detail === "object"
        ? event.detail as { nativePickerSuppressMs?: unknown }
        : null;
      const nativePickerSuppressMs = Number(detail?.nativePickerSuppressMs) || 0;
      if (nativePickerSuppressMs > 0) {
        nativePickerFocusSuppressUntil = Math.max(
          nativePickerFocusSuppressUntil,
          Date.now() + Math.min(nativePickerSuppressMs, 1800),
        );
      }
      keyboardIntentUntil = 0;
      resync();
      settle(true);
    });
    sync();
  }

  Object.assign(globalThis, { installMobileViewportGuards });
  Object.assign(globalThis, { CairnKeyboardState: { keyboardUpState, revealDelta } });

  if (typeof window !== "undefined") {
    window.installMobileViewportGuards = installMobileViewportGuards;
  }
}

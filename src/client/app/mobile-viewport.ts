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

  // A text field: what raises the soft keyboard and what the focus reveal serves.
  const TEXTY = /^(|text|search|email|url|tel|password|number)$/;
  const textInputEl = (el: EventTarget | Element | null | undefined): el is HTMLElement => {
    if (!(el instanceof Element) || el === document.body) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXTY.test((el.getAttribute("type") || "").toLowerCase());
    return el instanceof HTMLElement && el.isContentEditable === true;
  };

  // ---------- CairnFocusReveal: the ONE "reveal the focused field" helper ----------
  // A focused field is brought clear of the keyboard (the visual viewport) and of every
  // element declaring `data-occludes="top|bottom"` that is pinned (fixed, or a stuck
  // sticky): tab bar, rest bar, save bar, sticky headers, docks. The nearest scroller
  // moves first, by the least distance, and nothing moves when the field is visible. A
  // field in a fixed layer (chat, welcome, a sheet) never scrolls the page. The geometry
  // is pure (getBoundingClientRect coordinates in, deltas out) so it is testable.
  type RevealBand = { top: number; bottom: number };
  type RevealOccluder = { side: "top" | "bottom"; rect: RevealBand; pinned: boolean };
  // A scroller: its clip (top/bottom), where it is scrolled to (at) and how far it can go (max).
  type RevealScroller = RevealBand & { at: number; max: number };
  const MARGIN = 12;

  // The visible band minus what pinned occluders cover; one swallowing half the band (a
  // misdeclared layer) is ignored.
  function occludedBand(view: RevealBand, occluders: readonly RevealOccluder[]): RevealBand {
    let { top, bottom } = view;
    for (const { side, rect: r, pinned } of occluders) {
      const h = r.bottom - r.top;
      if (!pinned || h <= 0 || h > (view.bottom - view.top) / 2 || r.bottom <= view.top || r.top >= view.bottom) continue;
      if (side === "top") top = Math.max(top, r.bottom);
      else bottom = Math.min(bottom, r.top);
    }
    return { top, bottom: Math.max(top, bottom) };
  }

  // The least scroll (positive = content up) that lands `rect` inside `band` with a breath
  // of margin; 0 when it is already wholly visible. Too tall to fit: its top leads.
  function revealDelta(rect: RevealBand, band: RevealBand, margin = MARGIN): number {
    if (rect.top >= band.top && rect.bottom <= band.bottom) return 0;
    if (rect.top < band.top || rect.bottom - rect.top > band.bottom - band.top - 2 * margin) return Math.round(rect.top - band.top - margin);
    return Math.round(rect.bottom - band.bottom + margin);
  }

  // Per scroller, innermost first: each reveals inside its own clip, only as far as it can
  // scroll, and leaves the rest to the one outside it.
  function planReveal(rect: RevealBand, band: RevealBand, scrollers: readonly RevealScroller[], margin = MARGIN): number[] {
    let { top, bottom } = rect;
    return scrollers.map((s) => {
      const clip = { top: Math.max(band.top, s.top), bottom: Math.min(band.bottom, s.bottom) };
      if (clip.bottom - clip.top < 24) return 0;
      const delta = Math.max(-s.at, Math.min(Math.max(0, s.max - s.at), revealDelta({ top, bottom }, clip, margin)));
      top -= delta;
      bottom -= delta;
      return delta;
    });
  }

  // The composer row a field belongs to comes into view with it — never a whole <form>,
  // which on a long settings page would lead with its top and lose the field.
  const REVEAL_BOX = "[data-reveal-box], .logrow, .fuel-log-composer";
  const css = (el: Element) => getComputedStyle(el);

  // Where the visible area starts in getBoundingClientRect coordinates. Not `offsetTop`:
  // iOS Safari moves scrollY WITH the visual viewport as the keyboard rises (scrollY,
  // offsetTop and pageTop all read 268 on an iPhone), so client rects are already
  // visual-relative and adding offsetTop pushed the band a keyboard's worth down — every
  // focus then "fixed" a field iOS had just placed, and the page bounced. pageTop − scrollY
  // is the offset on every engine (Chrome: offsetTop; WebKit: 0).
  function visibleTop(vv: VisualViewport): number {
    return typeof vv.pageTop === "number" ? vv.pageTop - (window.scrollY || 0) : vv.offsetTop;
  }

  function revealNow(field: Element, opts: { box?: Element | null } = {}): number[] {
    const f = field.getBoundingClientRect();
    if (!f.height) return []; // detached or not rendered
    let layer: Element | null = null;
    const chain: Array<[Element | null, RevealScroller]> = [];
    for (let n = field.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = css(n);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) {
        const r = n.getBoundingClientRect();
        const top = r.top + n.clientTop;
        chain.push([n, { top, bottom: top + n.clientHeight, at: n.scrollTop, max: n.scrollHeight - n.clientHeight }]);
      }
      if (cs.position === "fixed") { layer = n; break; }
    }
    if (!layer) chain.push([null, { top: -Infinity, bottom: Infinity, at: window.scrollY || 0, max: Infinity }]);
    const occluders: RevealOccluder[] = [];
    for (const el of document.querySelectorAll("[data-occludes]")) {
      const cs = css(el);
      if (el.contains(field) || (layer && !layer.contains(el)) || cs.visibility === "hidden" || cs.opacity === "0") continue;
      const side = el.getAttribute("data-occludes") === "top" ? "top" : "bottom";
      const rect = el.getBoundingClientRect();
      // A sticky header covers anything only once it is stuck at the top.
      occluders.push({ side, rect, pinned: cs.position === "fixed" || (cs.position === "sticky" && rect.top <= parseFloat(cs.top) + 1.5) });
    }
    const vv = window.visualViewport;
    const vvTop = vv ? visibleTop(vv) : 0;
    const band = occludedBand(vv ? { top: vvTop, bottom: vvTop + vv.height } : { top: 0, bottom: window.innerHeight }, occluders);
    let target: RevealBand = f;
    for (const box of [opts.box, field.closest(REVEAL_BOX)]) {
      const r = box && box.contains(field) ? box.getBoundingClientRect() : null;
      if (r && r.bottom - r.top <= band.bottom - band.top - 2 * MARGIN) { target = r; break; }
    }
    const deltas = planReveal(target, band, chain.map((c) => c[1]));
    const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
    deltas.forEach((top, i) => { if (top) (chain[i][0] || window).scrollBy({ top, behavior }); });
    return deltas;
  }

  // ---------- when: once things have SETTLED ----------
  // Requested on focus, on a visual-viewport resize (the keyboard rising or resizing) and
  // when an occluder changes while a field has focus (the rest bar sliding in). It runs
  // once the viewport and scrollers have been quiet for QUIET ms and no occluder is still
  // animating, or at MAX_WAIT — so it corrects what the native iOS focus scroll left
  // instead of racing it. Scrolls only postpone it.
  const QUIET = 140;
  const MAX_WAIT = 900;
  let revealTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let deadline = 0; // 0: nothing pending
  let scrolledAway = false;
  let explicit: { field: Element; box: Element | null } | null = null;
  const occludersMoving = () =>
    [...document.querySelectorAll("[data-occludes]")].some((el) => el.getAnimations?.().some((a) => a.playState === "running"));
  const quiet = () => {
    if (!deadline) return;
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(runReveal, Math.max(0, Math.min(QUIET, deadline - Date.now())));
  };
  function runReveal(): void {
    revealTimer = 0;
    if (Date.now() < deadline && occludersMoving()) {
      quiet();
      return;
    }
    deadline = 0;
    const target = explicit;
    explicit = null;
    if (target?.field.isConnected) revealNow(target.field, { box: target.box });
    else if (textInputEl(document.activeElement)) revealNow(document.activeElement);
  }
  function requestReveal(auto = false): void {
    if (auto && scrolledAway) return;
    if (!deadline) deadline = Date.now() + MAX_WAIT;
    quiet();
  }

  function installFocusReveal(): void {
    const doc = document;
    const watch = typeof MutationObserver === "function"
      ? new MutationObserver((records) => { if (records.some((r) => (r.target as Element).hasAttribute?.("data-occludes"))) requestReveal(true); })
      : null;
    doc.addEventListener("focusin", (e) => {
      if (!textInputEl(e.target)) return;
      scrolledAway = false;
      watch?.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
      requestReveal();
    }, true);
    doc.addEventListener("focusout", () => setTimeout(() => { if (!textInputEl(doc.activeElement)) watch?.disconnect(); }, 0), true);
    // A repaint that put the focused field back (preventScroll) asks by event.
    doc.addEventListener("cairn:reveal-focused", () => requestReveal());
    // The athlete's hand wins: a touch drops a pending automatic reveal (a tap that focuses
    // a field asks again on focusin) and stops re-reveals until the next focus.
    doc.addEventListener("touchstart", () => {
      scrolledAway = true;
      if (!explicit) deadline = 0;
    }, { capture: true, passive: true });
    window.addEventListener("scroll", quiet, { capture: true, passive: true });
    window.visualViewport?.addEventListener("resize", () => (textInputEl(doc.activeElement) ? requestReveal(true) : quiet()));
    window.visualViewport?.addEventListener("scroll", quiet);
  }

  // Focus without the browser's own jump, then one settled reveal; `box` (a card, a
  // composer) comes into view with the field when it fits.
  function focusAndReveal(field: HTMLElement | null | undefined, opts: { box?: Element | null } = {}): void {
    if (!field) return;
    field.focus({ preventScroll: true });
    explicit = { field, box: opts.box ?? null };
    scrolledAway = false;
    requestReveal();
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

    installFocusReveal();

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
    const softKeyboard = () => !matchMedia("(hover:hover)").matches;
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
    const syncKeyboardUp = (geometryOpen: boolean) => {
      root.classList?.toggle("kb-up", keyboardUpState({ geometryOpen, textFocused: focusedTextInput(), scale: vv.scale }));
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
    document.addEventListener("focusin", (e) => { if (focusedTextInput()) requestKeyboard(e.target); else sync(); }, true);
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
  Object.assign(globalThis, {
    CairnKeyboardState: { keyboardUpState },
    CairnFocusReveal: {
      focus: focusAndReveal,
      request: () => requestReveal(),
      revealNow,
      occludedBand,
      revealDelta,
      planReveal,
    },
  });

  if (typeof window !== "undefined") {
    window.installMobileViewportGuards = installMobileViewportGuards;
  }
}

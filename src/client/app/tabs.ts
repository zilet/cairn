type TabSwitchOptions = {
  replace?: boolean;
  syncRoute?: boolean;
  /** Move focus into the freshly-rendered view. Set ONLY by a user-initiated tab
   *  change (a tap on the tab bar); boot and programmatic re-renders leave focus
   *  exactly where the athlete put it. */
  focusView?: boolean;
  /** The tab change came from the keyboard (Enter/Space on a tab), so the moved
   *  focus should show its ring. A pointer tap lands focus QUIETLY: the view or
   *  heading it lands on is a reading position, not a control the athlete aimed at. */
  focusRing?: boolean;
};

// @ts-check
{
  const TAB_NAMES: ClientTabName[] = [...(window.CairnAppRouter?.ROUTE_TABS || ["today"])];

  // An API failure that escapes a renderer was ALREADY reported by api() as an
  // api_failure. Reporting it again as a render_error produced a duplicate row
  // per outage whose top frame was the CairnApiError constructor — telemetry
  // pointing at the reporter rather than at anything broken. The tab still
  // paints its error state; only the second diagnostic is suppressed. The class
  // lives in another client module sharing one global scope, so the lookup must
  // be lazy (a top-level reference would not be hoisted across script tags).
  function isApiFailure(err: unknown): boolean {
    const ctor = (globalThis as { CairnApiError?: unknown }).CairnApiError;
    if (typeof ctor === "function" && err instanceof (ctor as new (...args: never[]) => Error)) return true;
    return !!err && typeof err === "object" && (err as { name?: unknown }).name === "CairnApiError";
  }

  function normalizeTabName(tab: unknown): ClientTabName {
    const candidate = String(tab || "");
    return TAB_NAMES.includes(candidate as ClientTabName) ? (candidate as ClientTabName) : "today";
  }

  // The Progress sub-view to land on. Endurance athletes default to the Endurance
  // read; everyone else to the Train overview (the muscle-balance home). Once the
  // user picks any Progress seg this session, state.progressSeg keeps that choice.
  function defaultProgressSeg(): string {
    if (state.progressSeg && PROGRESS_SEG.some(([key]) => key === state.progressSeg)) return state.progressSeg;
    return isEndurance() ? "endurance" : "overview";
  }

  function tabSkeleton(tab: ClientTabName): string {
    if (tab === "today" || tab === "session") return todaySkeleton();
    if (tab === "stand") return skelLines(2) + skelLines(3);
    if (tab === "progress") {
      const seg = defaultProgressSeg();
      return segSkeleton(seg, PROGRESS_SEG, seg === "endurance" ? 2 : 3);
    }
    if (tab === "plan") {
      const activePlan = state.planJump || state.planSeg;
      const jump =
        activePlan === "food"
          ? "food"
          : activePlan === "meals"
            ? "meals"
            : activePlan === "coach"
              ? "coach"
              : activePlan === "endurance"
                ? "endurance"
                : "edit";
      return segSkeleton(jump, planSeg(), 3);
    }
    if (tab === "me") {
      // The skeleton paints BEFORE renderTab awaits the lazy me-health bundle, so
      // ME_SEG (defined by that bundle) may not exist on the very first visit.
      // Fall back to plain skeleton lines rather than throwing before the paint.
      const meSeg = (globalThis as { ME_SEG?: readonly (readonly [string, string])[] }).ME_SEG;
      if (!Array.isArray(meSeg)) return skelLines(2) + skelLines(3);
      const seg = state.meSeg || "profile";
      return meSeg.some(([key]) => key === seg) ? segSkeleton(seg, meSeg, 2) : segSkeleton("profile", meSeg, 2);
    }
    if (tab === "settings") return skelLines(2) + skelLines(3);
    return "";
  }

  function primaryKeyFor(tab: ClientTabName): string | null {
    // Session awaits its own loads even when the plan is warm, so it always paints its skeleton.
    if (tab === "session") return null;
    if (tab === "today") return "plan";
    if (tab === "progress") return defaultProgressSeg() === "sessions" ? "history:sessions" : null;
    if (tab === "plan") {
      const activePlan = state.planJump || state.planSeg;
      return activePlan === "coach" || activePlan === "food" ? null : activePlan === "meals" ? MEALS_KEY : "plan";
    }
    return null;
  }

  // Replacing #view's innerHTML destroys whatever the keyboard/screen reader was
  // on, and focus silently falls back to <body> — so the next Tab starts from the
  // top of the document and nothing announces where the athlete just landed.
  // Land focus on the new view's first heading (the destination's own name), or
  // on #view itself carrying the tab's label. preventScroll keeps the page still.
  // Browsers disagree on whether script focus after a TAP matches :focus-visible
  // (iOS/WebKit and Chrome-after-keyboard both can), which painted a terracotta
  // ring on the landed heading or along #view's top edge. So a pointer-driven
  // switch marks the target data-focus-quiet (CSS drops the outline, the mark
  // leaves with the focus) and asks for focusVisible:false where supported; a
  // keyboard-driven switch keeps the ring.
  function tabDisplayName(tab: ClientTabName): string {
    const el = document.querySelector<HTMLElement>(`.tab[data-tab="${tab}"]`);
    const label = el?.getAttribute("aria-label") || el?.querySelector(".tab-lbl")?.textContent || "";
    return label.trim() || tab;
  }

  // Sets #view's aria-label from the destination tab only when the freshly-painted
  // content has no heading of its own to announce instead; clears it otherwise.
  // Called on EVERY render this tab produces (not just a focus-moving switch), so a
  // later programmatic re-render (route sync, activateTab with no focusView, a
  // primer re-render) can never leave a label from a previous destination lagging
  // behind content that has since changed shape.
  function syncViewAriaLabel(tab: ClientTabName): HTMLElement | null {
    if (state.tab !== tab || !view) return null;
    const heading = view.querySelector<HTMLElement>("h1,h2,h3,[role=heading]");
    if (heading) view.removeAttribute("aria-label");
    else view.setAttribute("aria-label", tabDisplayName(tab));
    return heading;
  }

  function focusViewStart(tab: ClientTabName, ring: boolean): void {
    if (state.tab !== tab || !view) return;
    const heading = syncViewAriaLabel(tab);
    const target = heading || view;
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
      // A heading is not a real control — drop the affordance again once focus
      // leaves so it never joins the Tab order.
      if (target !== view) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
    if (!ring) {
      target.setAttribute("data-focus-quiet", "");
      target.addEventListener("blur", () => target.removeAttribute("data-focus-quiet"), { once: true });
    }
    try {
      // focusVisible is newer than the DOM lib typings; unsupported engines ignore it.
      target.focus({ preventScroll: true, focusVisible: ring } as FocusOptions);
    } catch {
      target.focus();
    }
  }

  // The first-paint skeletons sit at the top level of #view; an async slot's own
  // inline skeleton inside real content does not count.
  function viewShowsSkeleton(): boolean {
    return !!view.querySelector(":scope > .today-skel, :scope > .skel-region, :scope > .skel-card");
  }

  // Skeleton → content crossfade. Renderers write #view themselves at whatever
  // await point their data lands, so the swap is watched rather than wrapped: the
  // first childList change that leaves no top-level skeleton gets viewHydrate()
  // (one short fade; the cards' own stagger is switched off so nothing
  // double-animates). The observer callback is a microtask, so it runs before the
  // content's first frame. Disarmed by the next tab switch or after 15 s.
  let hydrateObserver: MutationObserver | null = null;
  let hydrateTimer: ReturnType<typeof setTimeout> | null = null;
  function disarmHydrate(): void {
    hydrateObserver?.disconnect();
    hydrateObserver = null;
    if (hydrateTimer != null) clearTimeout(hydrateTimer);
    hydrateTimer = null;
  }
  function armHydrate(): void {
    disarmHydrate();
    if (typeof MutationObserver !== "function" || reducedMotion() || !viewShowsSkeleton()) return;
    hydrateObserver = new MutationObserver(() => {
      if (viewShowsSkeleton()) return; // a renderer repainted its own skeleton — keep waiting
      disarmHydrate();
      viewHydrate();
    });
    hydrateObserver.observe(view, { childList: true });
    hydrateTimer = setTimeout(disarmHydrate, 15000);
  }

  function paintTabSkeleton(tab: ClientTabName): void {
    const cacheKey = primaryKeyFor(tab);
    const warm = cacheKey ? !!peekCached(cacheKey) : false;
    const skel = warm ? "" : tabSkeleton(tab);
    if (skel) view.innerHTML = skel;
  }

  // Switch tabs inside ONE short fade (tabSwap: the View Transition root crossfade,
  // or the view-enter keyframe where transitions are unavailable). The skeleton —
  // or, for a warm tab, the renderer's synchronous cached paint — lands INSIDE the
  // swap, so the fade goes straight to real content instead of fading to the old
  // screen and hard-swapping after. The renderer's async remainder runs on outside
  // the swap (the transition never waits on the network), and a skeleton it later
  // replaces hydrates with its own crossfade (armHydrate).
  function switchTab(tab: unknown, opts: TabSwitchOptions = {}): void {
    const next = normalizeTabName(tab);
    const moveFocus = opts.focusView === true && state.tab !== next;
    disarmHydrate();
    if (state.tab === "chat" && next !== "chat") chatTeardownMonitor();
    teardownJobs();
    closeDetail(true);
    closeMealSheet(true);
    document.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
      const isActive = el.dataset.tab === next;
      el.classList.toggle("active", isActive);
      // aria-current names the live tab for assistive tech; the active dot (mobile)
      // / bold label + inset (desktop) carry the non-color affordance in CSS.
      if (isActive) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    state.tab = next;
    if (opts.syncRoute !== false) syncRouteFromState(opts.replace ? "replace" : "push");
    // Started exactly once — inside the swap when it runs, or after it if the swap
    // itself failed before calling back.
    let rendered: Promise<unknown> | null = null;
    const startRender = (): Promise<unknown> => {
      if (!rendered) {
        try {
          rendered = Promise.resolve(renderTab(next));
        } catch (err) {
          rendered = Promise.reject(err);
        }
      }
      return rendered;
    };
    Promise.resolve(
      tabSwap(() => {
        if (state.tab !== next) return;
        paintTabSkeleton(next);
        armHydrate();
        // Not returned: the swap must not wait on the renderer's network reads.
        startRender().catch(() => {});
      })
    ).finally(() => {
      // A newer switch owns the view now; its own render covers the paint.
      if (state.tab !== next && !rendered) return;
      startRender()
        .then(() => {
          // Focus and label bookkeeping runs after a successful paint; a fault
          // here is an a11y nit, never a render failure, so it must not drop the
          // freshly painted tab into the error state below.
          try {
            if (moveFocus) focusViewStart(next, opts.focusRing === true);
            else syncViewAriaLabel(next);
          } catch (err) {
            console.warn("[cairn] view focus sync failed", err);
          }
        })
        .catch((err) => {
          console.error("[cairn] render failed", err);
          try {
            if (!isApiFailure(err))
              (
                globalThis as {
                  CairnClientDiagnostics?: { reportError?(kind: string, error: unknown, extra?: unknown): unknown };
                }
              ).CairnClientDiagnostics?.reportError?.("render_error", err, { tab: next, level: "error" });
          } catch {}
          tabErrorState(next);
        });
    });
  }

  function registerTabBarHandlers(): void {
    document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
      tab.addEventListener("click", (event?: MouseEvent) => {
        // The Plan tab from the tab bar opens on Training. A Food/Meals visit is a
        // jump someone else asked for (planJump), never a new default for the tab.
        if (tab.dataset.tab === "plan" && state.tab !== "plan" && !state.planJump) state.planSeg = "edit";
        // A keyboard-activated button click reports detail 0; a tap or mouse click ≥ 1.
        switchTab(tab.dataset.tab, { focusView: true, focusRing: !!event && event.detail === 0 });
      });
    });
  }

  // Activate a tab programmatically, with the same skeleton-first behavior as
  // switchTab. Invalid route or shortcut names land on Today.
  function activateTab(name: unknown, opts: TabSwitchOptions = {}): void {
    switchTab(normalizeTabName(name), opts);
  }

  Object.assign(globalThis, { activateTab, defaultProgressSeg, registerTabBarHandlers, switchTab });

  if (typeof window !== "undefined") {
    window.activateTab = activateTab;
    window.defaultProgressSeg = defaultProgressSeg;
    window.registerTabBarHandlers = registerTabBarHandlers;
    window.switchTab = switchTab;
  }
}

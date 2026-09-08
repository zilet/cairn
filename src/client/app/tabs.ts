type TabSwitchOptions = {
  replace?: boolean;
  syncRoute?: boolean;
  /** Move focus into the freshly-rendered view. Set ONLY by a user-initiated tab
   *  change (a tap on the tab bar); boot and programmatic re-renders leave focus
   *  exactly where the athlete put it. */
  focusView?: boolean;
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
    if (tab === "today" || tab === "session") return "plan";
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
  // on #view itself carrying the tab's label. Programmatic focus does not match
  // :focus-visible, so no ring appears; preventScroll keeps the page still.
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

  function focusViewStart(tab: ClientTabName): void {
    if (state.tab !== tab || !view) return;
    const heading = syncViewAriaLabel(tab);
    const target = heading || view;
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1");
      // A heading is not a real control — drop the affordance again once focus
      // leaves so it never joins the Tab order.
      if (target !== view) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
    try {
      target.focus({ preventScroll: true });
    } catch {
      target.focus();
    }
  }

  function paintTabSkeleton(tab: ClientTabName): void {
    const cacheKey = primaryKeyFor(tab);
    const warm = cacheKey ? !!peekCached(cacheKey) : false;
    const skel = warm ? "" : tabSkeleton(tab);
    if (skel) {
      view.innerHTML = skel;
      viewEnter();
    }
  }

  // Switch tabs by crossfading old content to a synchronous skeleton, then letting
  // the async renderer hydrate outside the transition.
  function switchTab(tab: unknown, opts: TabSwitchOptions = {}): void {
    const next = normalizeTabName(tab);
    const moveFocus = opts.focusView === true && state.tab !== next;
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
    Promise.resolve(withViewTransition(() => paintTabSkeleton(next))).finally(() => {
      Promise.resolve(renderTab(next))
        .then(() => {
          // Focus and label bookkeeping runs after a successful paint; a fault
          // here is an a11y nit, never a render failure, so it must not drop the
          // freshly painted tab into the error state below.
          try {
            if (moveFocus) focusViewStart(next);
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
      tab.addEventListener("click", () => switchTab(tab.dataset.tab, { focusView: true }));
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

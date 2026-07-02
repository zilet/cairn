type TabSwitchOptions = {
  replace?: boolean;
  syncRoute?: boolean;
};

// @ts-check
{
  const TAB_NAMES: ClientTabName[] = [...(window.CairnAppRouter?.ROUTE_TABS || ["today"])];

  function normalizeTabName(tab: unknown): ClientTabName {
    const candidate = String(tab || "");
    return TAB_NAMES.includes(candidate as ClientTabName) ? candidate as ClientTabName : "today";
  }

  // The Progress sub-view to land on. Endurance athletes default to the Endurance
  // read; everyone else to History. Once the user picks any Progress seg this
  // session, state.progressSeg keeps that choice.
  function defaultProgressSeg(): string {
    if (state.progressSeg && PROGRESS_SEG.some(([key]) => key === state.progressSeg)) return state.progressSeg;
    return isEndurance() ? "endurance" : "sessions";
  }

  function tabSkeleton(tab: ClientTabName): string {
    if (tab === "today" || tab === "session") return todaySkeleton();
    if (tab === "progress") {
      const seg = defaultProgressSeg();
      return segSkeleton(seg, PROGRESS_SEG, seg === "endurance" ? 2 : 3);
    }
    if (tab === "plan") {
      const activePlan = state.planJump || state.planSeg;
      const jump = activePlan === "food" ? "food"
        : activePlan === "meals" ? "meals"
        : activePlan === "coach" ? "coach"
        : activePlan === "endurance" ? "endurance"
        : "edit";
      return segSkeleton(jump, planSeg(), 3);
    }
    if (tab === "me") {
      const seg = state.meSeg || "standing";
      return ME_SEG.some(([key]) => key === seg) ? segSkeleton(seg, ME_SEG, 2) : segSkeleton("standing", ME_SEG, 2);
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
      Promise.resolve(renderTab(next)).catch((err) => {
        console.error("[cairn] render failed", err);
        tabErrorState(next);
      });
    });
  }

  function registerTabBarHandlers(): void {
    document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
      tab.addEventListener("click", () => switchTab(tab.dataset.tab));
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

// @ts-check
{
  // Every renderTab call is a newer paint of #view. A lazy destination whose
  // bundle is still loading must not paint over a destination the athlete has
  // since moved to, so a deferred render runs only while it is still the latest.
  // Every other painter of #view that may wait on a lazy bundle (a Train or Plan
  // segment tap, the chat hand-off) claims a turn the same way through
  // withLatestRender, so whichever paint was asked for LAST is the one that lands.
  let renderSeq = 0;

  /** Claim the next paint of #view; the returned render runs only if nothing newer has claimed one. */
  function withLatestRender<T>(bundle: ClientLazyBundleName, render: () => T): T | undefined | Promise<Awaited<T> | undefined> {
    const seq = ++renderSeq;
    return withBundle(bundle, () => (seq === renderSeq ? render() : undefined));
  }

  function renderAppTab(tabName: unknown): unknown {
    const tab = String(tabName || "");
    const seq = ++renderSeq;
    const lazy = <T>(bundle: ClientLazyBundleName, render: () => T) =>
      withBundle(bundle, () => (seq === renderSeq ? render() : undefined));
    headerTitle.classList.remove("hdr-tappable", "hdr-eyebrow");
    document.getElementById("hdrChatActions")?.remove();
    document.body.classList.remove("chat-mode");
    if (tab !== "chat") document.body.classList.remove("kb-open", "kb-geometry-open");
    document.body.dataset.tab = tab;
    updateHeaderCondense();
    // Leaving the session surface drops any screen wake lock it was holding;
    // renderSession retakes one on the way in.
    if (tab !== "session" && typeof releaseWakeLock === "function") void releaseWakeLock();
    // The rest bar belongs on Session (where sets are logged) and Today (where
    // you land between sets). Anywhere else it would float over Chat's composer
    // (and keep body.resting padding app-wide); the deadline stays persisted so
    // returning to Session or Today restores it.
    if (tab === "session" || tab === "today") {
      if (typeof surfaceRestBar === "function") surfaceRestBar();
    } else if (typeof hideRestBar === "function") {
      hideRestBar();
    }

    if (tab === "today") return renderToday();
    // Any day that is not today, a record or a preview: the lazy "calendar" bundle.
    if (tab === "day") return lazy("calendar", () => renderDay());
    if (tab === "session") {
      // Session paints only after its loads settle, and switchTab skips the skeleton
      // when the plan cache is warm. On a deep link #view starts EMPTY, so without
      // this the page sat blank until every load returned — paint Today's skeleton
      // (the same one a cold switch shows) whenever there is nothing on screen yet.
      const host = typeof view !== "undefined" ? view : null;
      if (host && !host.firstElementChild && typeof todaySkeleton === "function") host.innerHTML = todaySkeleton();
      return renderSession();
    }
    // Every destination below Today and You lives in a lazily-injected bundle
    // (build-client's BUNDLES). lazy() calls straight through when the bundle
    // has already executed — the common case once the idle warm-up has run — and
    // otherwise awaits it: switchTab already awaits this promise and routes a
    // rejection (a failed script fetch) to the tab's error state.
    if (tab === "stand") return lazy("me-health", () => CairnStand.renderStand());
    if (tab === "plan") {
      const jump = state.planJump || state.planSeg || "edit";
      state.planJump = null;
      // Fuel is the lazy fuel bundle's (its frame, 06-coach-meals, is eager); Meals opens
      // Fuel with the meal-plan journal (the lazy meals bundle) open, Changes mounts the
      // ask bundle's feed, the editor is Train's, the race view Horizon's.
      return jump === "food" ? lazy("fuel", () => renderFoodJournal())
        : jump === "meals" ? lazy("meals", () => renderMeals())
        : jump === "coach" ? lazy("ask", () => renderCoach())
        : jump === "endurance" ? lazy("horizon", () => renderPlanEndurance())
        : lazy("train", () => renderPlanEditor());
    }
    if (tab === "progress") return lazy("train", () => (PROGRESS_HANDLERS[defaultProgressSeg()] || renderHistory)());
    if (tab === "chat") return lazy("ask", () => renderChat());
    // The You landing lives in the EAGER bundle-02, so it never waits; only a tap
    // into Health or About you loads me-health.
    if (tab === "horizon") return lazy("horizon", () => renderHorizon());
    if (tab === "you") return renderYou();
    if (tab === "me") return lazy("me-health", () => renderMe());
    return lazy("settings", () => renderSettings());
  }

  Object.assign(globalThis, { renderTab: renderAppTab });
  Object.assign(globalThis, { withLatestRender });

  if (typeof window !== "undefined") {
    window.renderTab = renderAppTab;
    window.withLatestRender = withLatestRender;
  }
}

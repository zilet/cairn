// @ts-check
{
  function renderAppTab(tabName: unknown): unknown {
    const tab = String(tabName || "");
    headerTitle.classList.remove("hdr-tappable");
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
    if (tab === "session") return renderSession();
    // Stand and Me live in the lazily-injected me-health bundle. Await it before
    // calling into it: switchTab already awaits this promise and routes a
    // rejection (a failed script fetch) to the tab's error state.
    if (tab === "stand") return ensureBundle("me-health").then(() => CairnStand.renderStand());
    if (tab === "plan") {
      const jump = state.planJump || state.planSeg || "edit";
      state.planJump = null;
      return jump === "food" ? renderFoodJournal()
        : jump === "meals" ? renderMeals()
        : jump === "coach" ? renderCoach()
        : jump === "endurance" ? renderPlanEndurance()
        : renderPlanEditor();
    }
    if (tab === "progress") return (PROGRESS_HANDLERS[defaultProgressSeg()] || renderHistory)();
    if (tab === "chat") return renderChat();
    if (tab === "me") return ensureBundle("me-health").then(() => renderMe());
    return renderSettings();
  }

  Object.assign(globalThis, { renderTab: renderAppTab });

  if (typeof window !== "undefined") {
    window.renderTab = renderAppTab;
  }
}

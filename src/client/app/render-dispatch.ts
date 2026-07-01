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

    if (tab === "today") return renderToday();
    if (tab === "session") return renderSession();
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
    if (tab === "me") return renderMe();
    return renderSettings();
  }

  Object.assign(globalThis, { renderTab: renderAppTab });

  if (typeof window !== "undefined") {
    window.renderTab = renderAppTab;
  }
}

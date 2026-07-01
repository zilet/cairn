// @ts-check
// Today rail slot loaders: side-effectful card hydration for agenda-selected rail cards.

type TodayRailDayIntake = import("../contracts/client.js").ClientDayIntake;
type TodayRailRecentTrainingFeedRow = import("../contracts/client.js").ClientRecentTrainingFeedRow;

type TodayRailLoadersApi = {
  loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void>;
  loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void>;
  loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void>;
  loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void>;
  loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void>;
};

(() => {
  function isCurrentToday(deps: ClientTodayRailControllerDeps): boolean {
    return !deps.state.tab || deps.state.tab === "today";
  }

  async function loadFuelToday(date: string, deps: ClientTodayRailControllerDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#fuelSlot");
    if (!slot) return;
    let day: unknown = null;
    try { day = await deps.api(`/nutrition/day?date=${encodeURIComponent(date || deps.state.logDate)}`); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const count = day && typeof day === "object" ? Number((day as { count?: unknown }).count) : 0;
    if (!(count > 0)) { slot.innerHTML = ""; return; }
    slot.innerHTML = CairnTodayAgenda.fuelCardHtml(day as TodayRailDayIntake);
    const card = slot.querySelector("#fuelCard");
    if (card) card.addEventListener("click", () => { deps.state.planJump = "food"; deps.activateTab("plan"); });
    deps.runCountUps(slot);
  }

  async function loadWeekAhead(deps: ClientTodayRailControllerDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#weekAheadSlot");
    if (!slot) return;
    let response: unknown = null;
    try { response = await deps.api("/week-ahead"); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    slot.innerHTML = CairnTodayWeekAhead.cardHtml(response);
  }

  async function loadProgramAdjustmentsBanner(deps: ClientTodayRailControllerDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#adjustSlot");
    if (!slot) return;
    let rows: unknown = null;
    try { rows = await deps.api("/program/adjustments"); } catch { rows = null; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) { slot.innerHTML = ""; return; }
    const more = CairnTodayProgramAdjustments.extraCount(list);
    slot.innerHTML = CairnTodayProgramAdjustments.bannerHtml(list);
    const card = slot.querySelector(".adjust-card");
    if (!card) return;
    card.addEventListener("click", (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      const act = target?.closest<HTMLElement>(".adjust-act");
      if (act) {
        deps.state.chatPrefill = act.getAttribute("data-req") || "";
        deps.activateTab("chat");
        return;
      }
      if (target?.closest("#adjustAll")) { deps.activateTab("plan"); return; }
      const moreBtn = target?.closest<HTMLButtonElement>("#adjustMore");
      if (moreBtn) {
        const open = card.classList.toggle("adjust-open");
        moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
        moreBtn.textContent = open ? "Show less" : `+${more} more in your program`;
        return;
      }
      const item = target?.closest<HTMLElement>(".adjust-item");
      if (item) {
        const open = item.getAttribute("aria-expanded") === "true";
        item.setAttribute("aria-expanded", open ? "false" : "true");
        const detail = item.parentElement?.querySelector<HTMLElement>(".adjust-detail");
        if (detail) detail.hidden = open;
      }
    });
  }

  async function loadRecentActivities(deps: ClientTodayRailControllerDeps): Promise<void> {
    const wrap = deps.root.querySelector<HTMLElement>("#qlRecent");
    if (!wrap) return;
    let rows: TodayRailRecentTrainingFeedRow[] = [];
    try { rows = await deps.api("/recent-training?limit=6") as TodayRailRecentTrainingFeedRow[]; } catch { rows = []; }
    if (!isCurrentToday(deps) || !wrap.isConnected) return;
    if (!rows || !rows.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML =
      `<div class="lately-h"><span class="ql-recent-h lbl">Lately</span>` +
      `<button class="lately-all lbl" id="latelyAll" type="button">see all →</button></div>` +
      rows.map((row) => CairnTodayLately.rowHtml(row)).join("");

    const allBtn = wrap.querySelector("#latelyAll");
    if (allBtn) allBtn.addEventListener("click", () => deps.activateTab("progress"));

    wrap.querySelectorAll<HTMLElement>('.lately-head[role="button"]').forEach((head) => {
      const toggle = () => {
        const row = head.closest(".lately-row");
        const detail = row && row.querySelector<HTMLElement>(".lately-detail");
        if (!detail) return;
        const open = detail.hidden !== false;
        detail.hidden = !open;
        row.classList.toggle("lately-open", open);
        head.setAttribute("aria-expanded", open ? "true" : "false");
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  async function loadGarminReconcile(deps: ClientTodayRailControllerDeps): Promise<void> {
    await CairnTodayGarminReconciliation.load({
      root: deps.root,
      date: deps.state.logDate,
      isCurrentToday: () => isCurrentToday(deps),
      api: deps.api,
      escapeHtml: deps.escapeHtml,
      toast: deps.toast,
      invalidate: deps.invalidate,
      refreshToday: deps.refreshToday,
    });
  }

  const CAIRN_TODAY_RAIL_LOADERS: TodayRailLoadersApi = {
    loadFuelToday,
    loadGarminReconcile,
    loadProgramAdjustmentsBanner,
    loadRecentActivities,
    loadWeekAhead,
  };

  Object.assign(globalThis, { CairnTodayRailLoaders: CAIRN_TODAY_RAIL_LOADERS });

  if (typeof window !== "undefined") {
    window.CairnTodayRailLoaders = CAIRN_TODAY_RAIL_LOADERS;
  }
})();

// @ts-check
// Today rail salience wiring: agenda fetch, slot loaders, and generic-card actions.

type TodayRailAgenda = import("../contracts/client.js").ClientTodayAgenda;
type TodayRailCandidate = import("../contracts/client.js").ClientTodayAgendaCandidate;
type TodayRailDayIntake = import("../contracts/client.js").ClientDayIntake;
type TodayRailRecentTrainingFeedRow = import("../contracts/client.js").ClientRecentTrainingFeedRow;

type TodayRailState = {
  tab?: string;
  logDate: string;
  planJump?: string | null;
  chatPrefill?: string | null;
  meSeg?: string | null;
  healthSeg?: string | null;
  healthSegPicked?: boolean;
};

type TodayRailLoaderKey =
  | "fuel"
  | "week-ahead"
  | "program-adjustments"
  | "weekly-read"
  | "connection-insight"
  | "garmin-reconcile"
  | "lately";

type TodayRailDeps = {
  root: ParentNode;
  state: TodayRailState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  activateTab(tab: string): unknown;
  gotoChatWith(text: string): unknown;
  collapseEl(el: Element, done?: () => void): void;
  loadTodayReads(): unknown;
  runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
  escapeHtml(value: unknown): string;
  toast(message: string): void;
  invalidate(key: string): void;
  refreshToday(options: { soft: boolean }): unknown;
};

(() => {
  function loaderMap(deps: TodayRailDeps): Record<TodayRailLoaderKey, () => unknown> {
    const loadTodayReads = () => deps.loadTodayReads();
    return {
      fuel: () => loadFuelToday(deps.state.logDate, deps),
      "week-ahead": () => loadWeekAhead(deps),
      "program-adjustments": () => loadProgramAdjustmentsBanner(deps),
      "weekly-read": loadTodayReads,
      "connection-insight": loadTodayReads,
      "garmin-reconcile": () => loadGarminReconcile(deps),
      lately: () => loadRecentActivities(deps),
    };
  }

  function isCurrentToday(deps: TodayRailDeps): boolean {
    return !deps.state.tab || deps.state.tab === "today";
  }

  async function fetchTodayAgenda(date: string, deps: TodayRailDeps): Promise<TodayRailAgenda | null> {
    try {
      const agenda = await deps.api("/today-agenda?date=" + encodeURIComponent(date || deps.state.logDate));
      const row = agenda && typeof agenda === "object" ? agenda as Partial<TodayRailAgenda> : null;
      if (!row || !Array.isArray(row.primary) || !Array.isArray(row.more)) return null;
      return row as TodayRailAgenda;
    } catch {
      return null;
    }
  }

  function railHtml(agenda: Partial<TodayRailAgenda> | null | undefined, genericPending: TodayRailCandidate[]): string {
    return CairnTodayAgenda.railHtml(agenda, genericPending);
  }

  function fallbackRailHtml(isToday: boolean): string {
    return `<aside class="today-rail">
    ${isToday ? `<div id="weekAheadSlot" class="weekahead-slot"></div>` : ""}
    ${isToday ? `<div id="adjustSlot" class="adjust-slot"></div>` : ""}
    <div id="weeklySlot" class="weekly-slot"></div>
    <div id="insightSlot" class="insight-slot"></div>
    ${isToday ? `<div id="garminReconcileSlot" class="garmin-reconcile-slot"></div>` : ""}
    <div id="qlRecent" class="ql-recent lately-slot"></div>
  </aside>`;
  }

  function runAgendaRail(agenda: Partial<TodayRailAgenda> | null | undefined, genericPending: TodayRailCandidate[], deps: TodayRailDeps): void {
    const called = new Set<() => unknown>();
    const loaders = loaderMap(deps);
    const buckets = CairnTodayAgenda.renderableBuckets(agenda);
    for (const candidate of [...buckets.primary, ...buckets.more]) {
      const key = candidate.client_card as TodayRailLoaderKey | undefined;
      if (!key) continue;
      const loader = loaders[key];
      if (!loader || called.has(loader)) continue;
      called.add(loader);
      try { loader(); } catch {}
    }
    wireGenericAgendaCards(genericPending, deps);
  }

  function runFallbackRail(isToday: boolean, deps: TodayRailDeps): void {
    loadRecentActivities(deps);
    if (!isToday) return;
    try { deps.loadTodayReads(); } catch {}
    loadGarminReconcile(deps);
    loadWeekAhead(deps);
    loadProgramAdjustmentsBanner(deps);
  }

  async function loadFuelToday(date: string, deps: TodayRailDeps): Promise<void> {
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

  async function loadWeekAhead(deps: TodayRailDeps): Promise<void> {
    const slot = deps.root.querySelector<HTMLElement>("#weekAheadSlot");
    if (!slot) return;
    let response: unknown = null;
    try { response = await deps.api("/week-ahead"); } catch { return; }
    if (!isCurrentToday(deps) || !slot.isConnected) return;
    slot.innerHTML = CairnTodayWeekAhead.cardHtml(response);
  }

  async function loadProgramAdjustmentsBanner(deps: TodayRailDeps): Promise<void> {
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

  async function loadRecentActivities(deps: TodayRailDeps): Promise<void> {
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

  async function loadGarminReconcile(deps: TodayRailDeps): Promise<void> {
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

  function wireGenericAgendaCards(pending: TodayRailCandidate[], deps: TodayRailDeps): void {
    if (!pending.length) return;
    deps.root.querySelectorAll<HTMLElement>("[data-agenda-act]").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", () => {
        const kind = button.getAttribute("data-agenda-act") || "";
        const id = button.getAttribute("data-agenda-id") || "";
        const candidate = pending.find((item) => item.id === id);
        const action = candidate?.action;
        const payload = action?.payload;
        if (kind.startsWith("chat")) {
          deps.gotoChatWith(typeof payload === "string" ? payload : candidate?.title || "");
          return;
        }
        if (kind === "plan-coach") {
          deps.state.planJump = "coach";
          deps.activateTab("plan");
          return;
        }
        if (kind === "plan-endurance") {
          deps.state.planJump = "endurance";
          deps.activateTab("plan");
          return;
        }
        if (kind === "me-health-standing") {
          deps.state.meSeg = "standing";
          deps.activateTab("me");
          return;
        }
        if (kind === "me-health-read") {
          deps.state.meSeg = "health";
          deps.state.healthSeg = "read";
          deps.state.healthSegPicked = true;
          deps.activateTab("me");
          return;
        }
        if (kind.startsWith("tab:")) deps.activateTab(kind.slice(4));
      });
    });

    deps.root.querySelectorAll<HTMLElement>("[data-agenda-dismiss]").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", () => {
        const card = button.closest(".agenda-card");
        if (card) deps.collapseEl(card, () => card.remove());
        else button.remove();
      });
    });
  }

  const CAIRN_TODAY_RAIL_CONTROLLER = {
    fetchTodayAgenda,
    railHtml,
    fallbackRailHtml,
    runAgendaRail,
    runFallbackRail,
    loadFuelToday,
    loadWeekAhead,
    loadProgramAdjustmentsBanner,
    loadRecentActivities,
    loadGarminReconcile,
    wireGenericAgendaCards,
  };

  Object.assign(globalThis, { CairnTodayRailController: CAIRN_TODAY_RAIL_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodayRailController = CAIRN_TODAY_RAIL_CONTROLLER;
  }
})();

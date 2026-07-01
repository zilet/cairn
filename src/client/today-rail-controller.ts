// @ts-check
// Today rail salience wiring: agenda fetch, slot loaders, and generic-card actions.

type TodayRailAgenda = import("../contracts/client.js").ClientTodayAgenda;
type TodayRailCandidate = import("../contracts/client.js").ClientTodayAgendaCandidate;

type TodayRailState = {
  logDate: string;
  planJump?: string | null;
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
  api(path: string): Promise<unknown>;
  activateTab(tab: string): unknown;
  gotoChatWith(text: string): unknown;
  collapseEl(el: Element, done?: () => void): void;
  loadFuelToday(date: string): unknown;
  loadWeekAhead(): unknown;
  loadProgramAdjustmentsBanner(): unknown;
  loadTodayReads(): unknown;
  loadGarminReconcile(): unknown;
  loadRecentActivities(): unknown;
};

(() => {
  function loaderMap(deps: TodayRailDeps): Record<TodayRailLoaderKey, () => unknown> {
    const loadTodayReads = () => deps.loadTodayReads();
    return {
      fuel: () => deps.loadFuelToday(deps.state.logDate),
      "week-ahead": () => deps.loadWeekAhead(),
      "program-adjustments": () => deps.loadProgramAdjustmentsBanner(),
      "weekly-read": loadTodayReads,
      "connection-insight": loadTodayReads,
      "garmin-reconcile": () => deps.loadGarminReconcile(),
      lately: () => deps.loadRecentActivities(),
    };
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
    runAgendaRail,
    wireGenericAgendaCards,
  };

  Object.assign(globalThis, { CairnTodayRailController: CAIRN_TODAY_RAIL_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodayRailController = CAIRN_TODAY_RAIL_CONTROLLER;
  }
})();

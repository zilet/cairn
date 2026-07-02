// @ts-check
// Today rail salience wiring: agenda fetch, slot loaders, and generic-card actions.

type TodayRailAgenda = import("../contracts/client.js").ClientTodayAgenda;
type TodayRailCandidate = import("../contracts/client.js").ClientTodayAgendaCandidate;

type TodayRailState = {
  tab?: string;
  logDate: string;
  planJump?: string | null;
  chatPrefill?: string | null;
  meSeg?: string | null;
  standSeg?: string | null;
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
  function railLoaders(): Window["CairnTodayRailLoaders"] {
    return (globalThis as unknown as { CairnTodayRailLoaders: Window["CairnTodayRailLoaders"] }).CairnTodayRailLoaders;
  }

  function loaderMap(deps: TodayRailDeps): Record<TodayRailLoaderKey, () => unknown> {
    const loadTodayReads = () => deps.loadTodayReads();
    return {
      fuel: () => railLoaders().loadFuelToday(deps.state.logDate, deps),
      "week-ahead": () => railLoaders().loadWeekAhead(deps),
      "program-adjustments": () => railLoaders().loadProgramAdjustmentsBanner(deps),
      "weekly-read": loadTodayReads,
      "connection-insight": loadTodayReads,
      "garmin-reconcile": () => railLoaders().loadGarminReconcile(deps),
      lately: () => railLoaders().loadRecentActivities(deps),
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
    railLoaders().loadRecentActivities(deps);
    if (!isToday) return;
    try { deps.loadTodayReads(); } catch {}
    railLoaders().loadGarminReconcile(deps);
    railLoaders().loadWeekAhead(deps);
    railLoaders().loadProgramAdjustmentsBanner(deps);
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
          deps.state.standSeg = null;
          deps.activateTab("stand");
          return;
        }
        if (kind === "me-health-read") {
          // The whole-picture read lives on the Stand overview now.
          deps.state.standSeg = null;
          deps.activateTab("stand");
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
    loadFuelToday: (date: string, deps: TodayRailDeps) => railLoaders().loadFuelToday(date, deps),
    loadWeekAhead: (deps: TodayRailDeps) => railLoaders().loadWeekAhead(deps),
    loadProgramAdjustmentsBanner: (deps: TodayRailDeps) => railLoaders().loadProgramAdjustmentsBanner(deps),
    loadRecentActivities: (deps: TodayRailDeps) => railLoaders().loadRecentActivities(deps),
    loadGarminReconcile: (deps: TodayRailDeps) => railLoaders().loadGarminReconcile(deps),
    wireGenericAgendaCards,
  };

  Object.assign(globalThis, { CairnTodayRailController: CAIRN_TODAY_RAIL_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodayRailController = CAIRN_TODAY_RAIL_CONTROLLER;
  }
})();

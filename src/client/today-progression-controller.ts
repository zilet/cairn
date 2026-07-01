// @ts-check
// Today adapted-prescription refresh wiring for set logging.

type TodayProgressionState = {
  tab?: string;
  day?: string | number | null;
  logDate?: string;
};

type TodayProgressionDeps = {
  state: TodayProgressionState;
  root: ParentNode;
  cachedApi(path: string, options?: { key?: string; freshFor?: number }): Promise<unknown>;
  invalidate(keyOrPrefix: string): void;
  exRxLineHtml(rx: unknown): string;
  moveCount(rxByEx: Record<string, unknown>): number;
  loadProgramAdjustmentsBanner(): unknown;
};

(() => {
  let rxRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  function progressionKey(day: string | number): string {
    return `program:progression:${day}`;
  }

  function scheduleRxRefresh(deps: TodayProgressionDeps): void {
    if (deps.state.day == null) return;
    if (rxRefreshTimer != null) clearTimeout(rxRefreshTimer);
    rxRefreshTimer = setTimeout(() => {
      void refreshAdaptedRx(deps);
    }, 600);
  }

  function invalidateTodayProgression(deps: TodayProgressionDeps): void {
    if (deps.state.day != null) deps.invalidate(progressionKey(deps.state.day));
  }

  async function refreshAdaptedRx(deps: TodayProgressionDeps): Promise<void> {
    if (deps.state.tab !== "today" || deps.state.day == null) return;
    const day = deps.state.day;
    const date = deps.state.logDate;
    let list: unknown;
    try {
      list = await deps.cachedApi("/program/progression?day=" + encodeURIComponent(day), {
        key: progressionKey(day),
        freshFor: 15000,
      });
    } catch {
      return;
    }
    if (deps.state.tab !== "today" || deps.state.day !== day || deps.state.logDate !== date) return;
    if (!Array.isArray(list)) return;

    const rxByEx: Record<string, unknown> = {};
    for (const rx of list) {
      const row = rx && typeof rx === "object" ? rx as Record<string, unknown> : null;
      if (row?.exercise) rxByEx[String(row.exercise).toLowerCase()] = row;
    }

    deps.root.querySelectorAll<HTMLElement>(".ex[data-card]").forEach((card) => {
      const name = (card.dataset.card || "").toLowerCase();
      const rx = name ? rxByEx[name] || null : null;
      const complete = card.classList.contains("ex-complete");
      const existing = card.querySelector(".ex-rx");
      const html = complete ? "" : deps.exRxLineHtml(rx);
      if (existing) {
        if (!html) {
          existing.remove();
          return;
        }
        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        const fresh = tpl.content.firstChild;
        if (fresh) existing.replaceWith(fresh);
      } else if (html) {
        const tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        const fresh = tpl.content.firstChild;
        const loggedWrap = card.querySelector("[data-logged]");
        if (fresh && loggedWrap) card.insertBefore(fresh, loggedWrap);
      }
    });

    const banner = deps.root.querySelector(".rx-banner");
    if (banner) {
      const moves = deps.moveCount(rxByEx);
      if (moves === 0) banner.remove();
      else {
        const heading = banner.querySelector(".rx-banner-h");
        if (heading) heading.textContent = `${moves === 1 ? "One lift has a new target" : `${moves} lifts have new targets`} from what you logged`;
      }
    }

    deps.loadProgramAdjustmentsBanner();
  }

  const CAIRN_TODAY_PROGRESSION_CONTROLLER = {
    invalidateTodayProgression,
    refreshAdaptedRx,
    scheduleRxRefresh,
  };

  Object.assign(globalThis, { CairnTodayProgressionController: CAIRN_TODAY_PROGRESSION_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodayProgressionController = CAIRN_TODAY_PROGRESSION_CONTROLLER;
  }
})();

// @ts-check
// Today session skip/restore and off-plan removal helpers.

type TodaySessionSkipPendingOffPlan = { name: string; mode?: string | null };
type TodaySessionSkipState = {
  tab?: string;
  logDate: string;
  sessionIdsByDate?: Record<string, string>;
  pendingOffPlan?: Record<string, TodaySessionSkipPendingOffPlan[]>;
};

type TodaySessionSkipStatusApi = {
  skipNameHtml(name: unknown): string;
};

type TodaySessionSkipDeps = {
  root: HTMLElement;
  state: TodaySessionSkipState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  invalidate(key: string): void;
  renderToday(opts?: Record<string, unknown>): unknown;
  toast(message: string, options?: { action?: string; onAction?: () => void }): void;
  collapseEl(el: Element, done?: () => void): void;
  expandEl(el: Element): void;
  sessionStatus: TodaySessionSkipStatusApi;
};

(() => {
  function surfaceStillCurrent(deps: TodaySessionSkipDeps, date: string, tab: string | undefined): boolean {
    return deps.state.logDate === date && deps.state.tab === tab;
  }

  function responseRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function addSkipName(name: string, deps: TodaySessionSkipDeps): void {
    const line = deps.root.querySelector("#skipLine");
    const names = line?.querySelector(".skipline-names");
    if (!line || !names) return;
    const dup = [...names.querySelectorAll<HTMLElement>("[data-unskip]")]
      .some((button) => decodeURIComponent(button.dataset.unskip || "").toLowerCase() === name.toLowerCase());
    if (!dup) {
      const tpl = document.createElement("template");
      tpl.innerHTML = deps.sessionStatus.skipNameHtml(name).trim();
      const el = tpl.content.firstElementChild as HTMLElement | null;
      if (!el) return;
      el.classList.add("chip-in");
      names.appendChild(el);
    }
    line.classList.remove("skipline-empty");
  }

  function removeSkipName(name: string, deps: TodaySessionSkipDeps): void {
    const line = deps.root.querySelector("#skipLine");
    if (!line) return;
    [...line.querySelectorAll<HTMLElement>("[data-unskip]")]
      .filter((button) => decodeURIComponent(button.dataset.unskip || "").toLowerCase() === name.toLowerCase())
      .forEach((button) => button.remove());
    if (!line.querySelector("[data-unskip]")) line.classList.add("skipline-empty");
  }

  async function skipFromCard(
    card: HTMLElement | null,
    exercise: string,
    deps: TodaySessionSkipDeps,
    actionDate: string,
    actionTab: string | undefined,
  ): Promise<void> {
    if (!card) return;
    let result: Record<string, unknown>;
    try {
      result = responseRecord(await deps.api("/sessions/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: actionDate, exercise }),
      }));
    } catch {
      if (surfaceStillCurrent(deps, actionDate, actionTab)) deps.toast("Couldn't skip — try again");
      return;
    }
    const responseDateMatches = result.date == null || String(result.date) === actionDate;
    if (result.ok !== true || !responseDateMatches) {
      if (surfaceStillCurrent(deps, actionDate, actionTab)) {
        deps.toast(result.error ? "Sets already logged — delete them first" : "Couldn't skip — try again");
      }
      return;
    }
    CairnTodaySessionSetModel.rememberMutationSessionId(deps, actionDate, result);
    if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
    deps.invalidate("today:session:" + actionDate);
    const anchor = card.nextElementSibling;
    deps.collapseEl(card, () => {
      if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
      card.remove();
      addSkipName(exercise, deps);
      if (deps.state.tab === "today") void deps.renderToday({ soft: true });
    });
    deps.toast(`${exercise} skipped today`, {
      action: "Undo",
      onAction: () => { void undoSkip(card, anchor, exercise, deps, actionDate, actionTab); },
    });
  }

  async function undoSkip(
    card: HTMLElement,
    anchor: Element | null,
    exercise: string,
    deps: TodaySessionSkipDeps,
    actionDate: string,
    actionTab: string | undefined,
  ): Promise<void> {
    if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
    try {
      await deps.api("/sessions/skip", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: actionDate, exercise }),
      });
    } catch {
      if (surfaceStillCurrent(deps, actionDate, actionTab)) deps.toast("Couldn't restore — try again");
      return;
    }
    if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
    deps.invalidate("today:session:" + actionDate);
    if (deps.state.tab !== "today") return;
    removeSkipName(exercise, deps);
    if (!card.isConnected) {
      const before = anchor && anchor.isConnected ? anchor : deps.root.querySelector(".addex");
      if (!before || !before.parentNode) {
        deps.renderToday();
        return;
      }
      before.parentNode.insertBefore(card, before);
    }
    deps.expandEl(card);
  }

  function removeOffPlanCard(card: HTMLElement | null, deps: TodaySessionSkipDeps): void {
    if (!card) return;
    const name = card.dataset.card;
    const pending = deps.state.pendingOffPlan?.[deps.state.logDate];
    if (name && pending) {
      deps.state.pendingOffPlan![deps.state.logDate] = pending.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    }
    deps.collapseEl(card, () => card.remove());
  }

  function wireSkips(deps: TodaySessionSkipDeps): void {
    const surfaceDate = deps.state.logDate;
    const surfaceTab = deps.state.tab;
    deps.root.querySelectorAll<HTMLElement>(".ex-skip").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        const card = button.closest<HTMLElement>(".ex");
        if (button.hasAttribute("data-remove-card")) {
          removeOffPlanCard(card, deps);
          return;
        }
        void skipFromCard(card, decodeURIComponent(button.dataset.skip || ""), deps, surfaceDate, surfaceTab);
      });
    });

    const line = deps.root.querySelector<HTMLElement>("#skipLine");
    if (line && !line.dataset.wired) {
      line.dataset.wired = "1";
      line.addEventListener("click", async (event) => {
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        const button = (event.target as Element | null)?.closest<HTMLElement>("[data-unskip]");
        if (!button) return;
        const exercise = decodeURIComponent(button.dataset.unskip || "");
        try {
          await deps.api("/sessions/skip", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date: surfaceDate, exercise }),
          });
        } catch {
          if (surfaceStillCurrent(deps, surfaceDate, surfaceTab)) deps.toast("Couldn't restore — try again");
          return;
        }
        if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
        deps.invalidate("today:session:" + surfaceDate);
        deps.toast(`${exercise} is back on`);
        deps.renderToday();
      });
    }
  }

  const CAIRN_TODAY_SESSION_SKIP = {
    wireSkips,
  };

  Object.assign(globalThis, { CairnTodaySessionSkip: CAIRN_TODAY_SESSION_SKIP });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSkip = CAIRN_TODAY_SESSION_SKIP;
  }
})();

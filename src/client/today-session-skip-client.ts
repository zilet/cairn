// @ts-check
// Today session skip/restore and off-plan removal helpers.

type TodaySessionSkipPendingOffPlan = { name: string; mode?: string | null };
type TodaySessionSkipState = {
  tab?: string;
  logDate: string;
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

  async function skipFromCard(card: HTMLElement | null, exercise: string, deps: TodaySessionSkipDeps): Promise<void> {
    if (!card) return;
    let result: Record<string, unknown>;
    try {
      result = responseRecord(await deps.api("/sessions/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: deps.state.logDate, exercise }),
      }));
    } catch {
      deps.toast("Couldn't skip — try again");
      return;
    }
    if (result.ok !== true) {
      deps.toast(result.error ? "Sets already logged — delete them first" : "Couldn't skip — try again");
      return;
    }
    deps.invalidate("today:session:" + deps.state.logDate);
    const anchor = card.nextElementSibling;
    deps.collapseEl(card, () => {
      card.remove();
      addSkipName(exercise, deps);
      if (deps.state.tab === "today") void deps.renderToday({ soft: true });
    });
    deps.toast(`${exercise} skipped today`, { action: "Undo", onAction: () => { void undoSkip(card, anchor, exercise, deps); } });
  }

  async function undoSkip(card: HTMLElement, anchor: Element | null, exercise: string, deps: TodaySessionSkipDeps): Promise<void> {
    try {
      await deps.api("/sessions/skip", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: deps.state.logDate, exercise }),
      });
    } catch {
      deps.toast("Couldn't restore — try again");
      return;
    }
    deps.invalidate("today:session:" + deps.state.logDate);
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
    deps.root.querySelectorAll<HTMLElement>(".ex-skip").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const card = button.closest<HTMLElement>(".ex");
        if (button.hasAttribute("data-remove-card")) {
          removeOffPlanCard(card, deps);
          return;
        }
        void skipFromCard(card, decodeURIComponent(button.dataset.skip || ""), deps);
      });
    });

    const line = deps.root.querySelector<HTMLElement>("#skipLine");
    if (line && !line.dataset.wired) {
      line.dataset.wired = "1";
      line.addEventListener("click", async (event) => {
        const button = (event.target as Element | null)?.closest<HTMLElement>("[data-unskip]");
        if (!button) return;
        const exercise = decodeURIComponent(button.dataset.unskip || "");
        try {
          await deps.api("/sessions/skip", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date: deps.state.logDate, exercise }),
          });
        } catch {
          deps.toast("Couldn't restore — try again");
          return;
        }
        deps.invalidate("today:session:" + deps.state.logDate);
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

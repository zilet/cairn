// @ts-check
// Today session controller: set logging, skip/restore/remove, finish/reopen, and feedback wiring.

type TodaySessionPendingOffPlan = { name: string; mode?: string | null };
type TodaySessionState = {
  tab?: string;
  logDate: string;
  brief?: unknown;
  planReveal?: { date: string; on: boolean } | null;
  pendingOffPlan?: Record<string, TodaySessionPendingOffPlan[]>;
};

type TodaySessionStatusApi = {
  feedbackDoneHtml(session: Record<string, unknown> | null | undefined): string;
  feedbackFormHtml(session: Record<string, unknown> | null | undefined): string;
  feedbackOpenHtml(): string;
  hasFeedback(session: Record<string, unknown> | null | undefined): boolean;
  setChipHtml(set: Record<string, unknown>, index?: number | null | undefined): string;
  skipLineHtml(names: unknown): string;
  skipNameHtml(name: unknown): string;
};

type TodaySessionDeps = {
  root: HTMLElement;
  state: TodaySessionState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  invalidate(key: string): void;
  invalidateTodayProgression(): void;
  scheduleRxRefresh(): void;
  renderToday(opts?: Record<string, unknown>): unknown;
  activateTab(tab: string): void;
  withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
  viewEnter(): void;
  reducedMotion(): boolean;
  startRest(): void;
  stopRest(): void;
  toast(message: string, options?: { action?: string; onAction?: () => void }): void;
  parseDur(value: string): number | null;
  fmtDur(seconds: number): string;
  collapseEl(el: Element, done?: () => void): void;
  expandEl(el: Element): void;
  localISO(): string;
  sessionStatus: TodaySessionStatusApi;
};

type TodaySessionSurfaceOptions = {
  session: Record<string, unknown>;
  hasLoggedSets: boolean;
};

(() => {
  function responseRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function sessionPathId(session: Record<string, unknown>): string {
    return encodeURIComponent(String(session.id ?? ""));
  }

  function invalidateSessionTruth(deps: TodaySessionDeps): void {
    deps.invalidate("today:session:" + deps.state.logDate);
    deps.invalidate("history:sessions");
  }

  function wireFinishControls(session: Record<string, unknown>, deps: TodaySessionDeps): void {
    const finishBtn = deps.root.querySelector<HTMLButtonElement>("#finishBtn");
    if (finishBtn && !finishBtn.dataset.wired) {
      finishBtn.dataset.wired = "1";
      finishBtn.addEventListener("click", async () => {
        finishBtn.disabled = true;
        const notes = deps.root.querySelector<HTMLInputElement | HTMLTextAreaElement>("#sessNotes")?.value.trim() || "";
        let result: Record<string, unknown>;
        try {
          result = responseRecord(await deps.api(`/sessions/${sessionPathId(session)}/finish`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes }),
          }));
        } catch {
          finishBtn.disabled = false;
          deps.toast("Couldn't finish — check your connection");
          return;
        }

        const summary = responseRecord(result.summary);
        deps.state.brief = null;
        invalidateSessionTruth(deps);
        deps.invalidate("stats");
        deps.stopRest();

        const settle = () => {
          if (deps.state.tab !== "today") return;
          deps.toast(`Done · ${Number(summary.sets || 0)} sets · ${Number(summary.tonnage || 0).toLocaleString()} lb`);
          deps.renderToday();
        };
        const surface = deps.root.querySelector<HTMLElement>(".plansurface");
        if (surface && !deps.reducedMotion()) {
          surface.classList.add("slide-out");
          setTimeout(settle, 300);
        } else {
          settle();
        }
      });
    }

    const reopenBtn = deps.root.querySelector<HTMLButtonElement>("#reopenBtn");
    if (reopenBtn && !reopenBtn.dataset.wired) {
      reopenBtn.dataset.wired = "1";
      reopenBtn.addEventListener("click", async () => {
        reopenBtn.disabled = true;
        try {
          await deps.api(`/sessions/${sessionPathId(session)}/reopen`, { method: "POST" });
        } catch {}
        deps.state.brief = null;
        invalidateSessionTruth(deps);
        deps.state.planReveal = { date: deps.state.logDate, on: true };
        deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(() => deps.viewEnter()));
      });
    }

    deps.root.querySelector("#toHistoryBtn")?.addEventListener("click", () => deps.activateTab("progress"));
  }

  function wireDeletes(deps: TodaySessionDeps): void {
    deps.root.querySelectorAll<HTMLElement>("[data-del]").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        await deps.api(`/sets/${button.dataset.del}`, { method: "DELETE" });
        deps.state.brief = null;
        deps.invalidate("today:session:" + deps.state.logDate);
        deps.invalidate("stats");
        deps.invalidate("history:sessions");
        deps.invalidate("progress:volume");
        deps.invalidateTodayProgression();
        deps.renderToday();
      });
    });
  }

  function bumpProgress(card: HTMLElement): void {
    const prog = card.querySelector<HTMLElement>("[data-prog]");
    if (!prog) return;
    const done = card.querySelectorAll("[data-logged] .chip").length;
    const goal = Number((prog.textContent?.match(/\/\s*(\d+)/) || [])[1] || 0);
    prog.innerHTML = `${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span>`;
    const complete = goal && done >= goal;
    prog.classList.toggle("done", !!complete);
    card.classList.toggle("ex-complete", !!complete);
  }

  function refreshFinishStat(deps: TodaySessionDeps): boolean {
    const chips = deps.root.querySelectorAll(".ex [data-logged] .chip");
    if (!chips.length) return false;
    const stat = deps.root.querySelector("[data-finishstat]");
    if (!stat) {
      deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(() => deps.viewEnter()));
      return true;
    }
    let sets = 0;
    let tonnage = 0;
    chips.forEach((chip) => {
      sets++;
      const match = chip.textContent?.match(/(-?\d+(?:\.\d+)?)\s*×\s*(\d+)/);
      if (match) {
        const wt = Number(match[1]);
        const reps = Number(match[2]);
        if (wt > 0) tonnage += wt * reps;
      }
    });
    const isToday = deps.state.logDate === deps.localISO();
    stat.textContent = `${sets} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + deps.state.logDate}`;
    return false;
  }

  function wireLogRow(row: Element | null | undefined, deps: TodaySessionDeps): void {
    if (!(row instanceof HTMLElement)) return;
    const logBtn = row.querySelector<HTMLButtonElement>(".logbtn");
    if (!logBtn || logBtn.dataset.wired) return;
    logBtn.dataset.wired = "1";
    logBtn.addEventListener("click", async () => {
      if (logBtn.disabled) return;
      const timed = row.dataset.mode === "timed";
      let body: Record<string, unknown>;
      if (timed) {
        const durEl = row.querySelector<HTMLInputElement>(".in-dur");
        const sec = deps.parseDur(durEl?.value || "");
        if (sec == null || sec <= 0) {
          deps.toast("Time? e.g. 1:30 or 90");
          durEl?.focus();
          return;
        }
        if (durEl) durEl.value = deps.fmtDur(sec);
        body = {
          exercise: decodeURIComponent(row.dataset.ex || ""),
          weight: null,
          reps: null,
          rir: null,
          duration_sec: sec,
          exercise_mode: "timed",
          day_number: Number(row.dataset.day),
          date: deps.state.logDate,
        };
      } else {
        const wEl = row.querySelector<HTMLInputElement>(".in-w");
        const rEl = row.querySelector<HTMLInputElement>(".in-r");
        const rirEl = row.querySelector<HTMLInputElement>(".in-rir");
        const w = wEl?.value || "";
        const r = rEl?.value || "";
        const rir = rirEl?.value || "";
        if (r === "") {
          deps.toast("Reps?");
          rEl?.focus();
          return;
        }
        body = {
          exercise: decodeURIComponent(row.dataset.ex || ""),
          weight: w === "" ? null : Number(w),
          reps: Number(r),
          rir: rir === "" ? null : Number(rir),
          day_number: Number(row.dataset.day),
          date: deps.state.logDate,
        };
      }

      logBtn.disabled = true;
      let result: Record<string, unknown>;
      try {
        result = responseRecord(await deps.api("/sets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }));
      } catch {
        logBtn.disabled = false;
        deps.toast("Couldn't log that set — check your connection.");
        return;
      }
      logBtn.disabled = false;
      if (!result || result.ok === false || result.error || result.id == null) {
        deps.toast(result && result.error ? String(result.error) : "Couldn't log that set.");
        return;
      }

      deps.state.brief = null;
      deps.invalidate("today:session:" + deps.state.logDate);
      deps.invalidate("stats");
      deps.invalidate("history:sessions");
      deps.invalidate("progress:volume");
      deps.invalidateTodayProgression();

      const card = row.closest<HTMLElement>(".ex");
      const loggedWrap = card?.querySelector("[data-logged]");
      const tpl = document.createElement("template");
      tpl.innerHTML = deps.sessionStatus.setChipHtml(result).trim();
      const chipEl = tpl.content.firstElementChild as HTMLElement | null;
      if (!card || !loggedWrap || !chipEl) return;
      chipEl.classList.add("chip-in");
      loggedWrap.appendChild(chipEl);
      wireDeletes(deps);
      bumpProgress(card);
      card.querySelector(".ex-skip")?.remove();
      if (result.pr) {
        deps.toast("🏆 New PR!");
        if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([60, 40, 120]);
      } else {
        deps.toast("Set logged");
      }
      deps.startRest();
      if (!refreshFinishStat(deps)) deps.scheduleRxRefresh();
    });
  }

  function wireSessionSurface(options: TodaySessionSurfaceOptions, deps: TodaySessionDeps): void {
    const session = responseRecord(options.session);
    wireDeletes(deps);
    CairnTodaySessionSkip.wireSkips(deps);
    wireFinishControls(session, deps);
    deps.root.querySelectorAll(".ex .logrow").forEach((row) => wireLogRow(row, deps));
    if (options.hasLoggedSets) CairnTodaySessionFeedback.renderFeedback(deps.root.querySelector("#feedbackSlot"), session, deps);
  }

  const CAIRN_TODAY_SESSION_CONTROLLER = {
    renderFeedback: CairnTodaySessionFeedback.renderFeedback,
    wireDeletes,
    wireLogRow,
    wireSessionSurface,
    wireSkips: CairnTodaySessionSkip.wireSkips,
  };

  Object.assign(globalThis, { CairnTodaySessionController: CAIRN_TODAY_SESSION_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionController = CAIRN_TODAY_SESSION_CONTROLLER;
  }
})();

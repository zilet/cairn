// @ts-check
// Today session set actions: log rows, delete chips, and update local set UI after commits.

type TodaySessionSetActionsApi = {
  wireDeletes(deps: ClientTodaySessionControllerDeps): void;
  wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void;
  refreshFinishStat(deps: ClientTodaySessionControllerDeps): boolean;
};

(() => {
  function surfaceStillCurrent(deps: ClientTodaySessionControllerDeps, date: string, tab: string | undefined): boolean {
    return deps.state.logDate === date && deps.state.tab === tab;
  }

  function wireDeletes(deps: ClientTodaySessionControllerDeps): void {
    deps.root.querySelectorAll<HTMLElement>("[data-del]").forEach((button) => {
      if (button.dataset.wired) return;
      button.dataset.wired = "1";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void deleteSet(button, deps);
      });
    });
  }

  // Optimistic set-delete — mirrors the set-LOG path (DOM surgery + local stat
  // repaint, no full re-render). The chip vanishes the instant you tap and the
  // affected card/finish stats are re-tallied LOCALLY *before* the network
  // round-trip; the DELETE fires in the background and, on failure, the chip is
  // put back exactly where it sat. Dropping the old full renderToday() means
  // removing one set no longer rebuilds the whole surface (which yanked scroll,
  // replayed the entrance stagger, and refetched the world).
  async function deleteSet(button: HTMLElement, deps: ClientTodaySessionControllerDeps): Promise<void> {
    const id = button.dataset.del;
    if (!id || button.dataset.deleting) return;
    const chip = button.closest<HTMLElement>(".chip");
    const card = button.closest<HTMLElement>(".ex");
    if (!chip || !card) {
      // Unexpected structure — fall back to the safe, correct full refresh.
      try {
        await deps.api(`/sets/${id}`, { method: "DELETE" });
      } catch {
        deps.toast("Couldn't remove that — try again.");
        return;
      }
      CairnTodaySessionSetModel.invalidateSetTruth(deps);
      deps.renderToday();
      return;
    }
    button.dataset.deleting = "1";
    // Remember the chip's exact position so a failed delete rolls back cleanly.
    const parent = chip.parentElement;
    const anchor = chip.nextElementSibling;
    chip.remove();
    bumpProgress(card);
    refreshFinishStat(deps);
    CairnTodaySessionSetModel.invalidateSetTruth(deps);
    try {
      const result = CairnTodaySessionSetModel.responseRecord(await deps.api(`/sets/${id}`, { method: "DELETE" }));
      if (result.error) throw new Error(String(result.error));
    } catch {
      if (parent) {
        if (anchor && anchor.parentElement === parent) parent.insertBefore(chip, anchor);
        else parent.appendChild(chip);
      }
      button.dataset.deleting = "";
      bumpProgress(card);
      refreshFinishStat(deps);
      deps.toast("Couldn't remove that — try again.");
    }
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

  function refreshFinishStat(deps: ClientTodaySessionControllerDeps): boolean {
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

  function wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void {
    if (!(row instanceof HTMLElement)) return;
    const logBtn = row.querySelector<HTMLButtonElement>(".logbtn");
    if (!logBtn || logBtn.dataset.wired) return;
    const surfaceDate = deps.state.logDate;
    const surfaceTab = deps.state.tab;
    logBtn.dataset.wired = "1";
    logBtn.addEventListener("click", async () => {
      if (logBtn.disabled) return;
      if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
      const actionDate = surfaceDate;
      const actionTab = surfaceTab;
      const payload = CairnTodaySessionSetModel.logPayloadFromRow(row, deps);
      if (!payload.ok) {
        deps.toast(payload.message);
        payload.focus?.();
        return;
      }

      logBtn.disabled = true;
      const runtime = globalThis as {
        runSessionMutation?: (
          input: {
            date: string;
            kind: string;
            path: string;
            body: unknown;
            method?: "POST" | "DELETE";
            identity?: { sessionId?: unknown; dailySessionId?: unknown };
          },
          send: (idempotencyKey: string) => Promise<unknown>,
        ) => Promise<{
          status: "sent" | "queued" | "blocked" | "storage_error" | "failed";
          value?: unknown;
          reason?: unknown;
          item?: { depends_on?: unknown };
        }>;
      };
      if (typeof runtime.runSessionMutation !== "function") {
        logBtn.disabled = false;
        deps.toast("Couldn’t safely save that set — refresh and try again.");
        return;
      }
      const mutation = await runtime.runSessionMutation({
        date: actionDate,
        kind: "set",
        path: "/sets",
        body: payload.body,
        identity: { sessionId: deps.state.sessionIdsByDate?.[actionDate] },
      }, (idempotencyKey) => deps.api("/sets", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey },
          body: JSON.stringify(payload.body),
        }));
      if (mutation.status !== "sent") {
        if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
        logBtn.disabled = false;
        if (mutation.status === "queued") {
          deps.toast(mutation.item?.depends_on
            ? "Set saved — reconciling this session"
            : "Set saved — will sync when you're back online");
        } else if (mutation.status === "blocked") {
          deps.toast(
            mutation.reason === "other_tab"
              ? "This session is being prepared in another tab or view — refresh before logging more sets."
              : "This saved session needs attention before more sets can be logged.",
          );
        } else if (mutation.status === "storage_error") {
          deps.toast("Couldn’t save that set on this device — free storage and try again.");
        } else {
          deps.toast("Couldn't log that set.");
        }
        return;
      }
      const result = CairnTodaySessionSetModel.responseRecord(mutation.value);
      const responseDateMatches = result.date == null || String(result.date) === actionDate;
      if (!result || result.ok === false || result.error || result.id == null || !responseDateMatches) {
        if (surfaceStillCurrent(deps, actionDate, actionTab)) {
          logBtn.disabled = false;
          deps.toast(result && result.error ? String(result.error) : "Couldn't log that set.");
        }
        return;
      }

      // POST /sets returns `id` for the set itself. Only its explicit
      // `session_id` may seed Finish; older responses without that field recover
      // via GET /sessions?date= instead of adopting the set ID.
      CairnTodaySessionSetModel.rememberMutationSessionId(deps, actionDate, result);
      if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
      logBtn.disabled = false;
      CairnTodaySessionSetModel.invalidateSetTruth(deps);

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

  const CAIRN_TODAY_SESSION_SET_ACTIONS: TodaySessionSetActionsApi = {
    wireDeletes,
    wireLogRow,
    refreshFinishStat,
  };

  Object.assign(globalThis, { CairnTodaySessionSetActions: CAIRN_TODAY_SESSION_SET_ACTIONS });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSetActions = CAIRN_TODAY_SESSION_SET_ACTIONS;
  }
})();

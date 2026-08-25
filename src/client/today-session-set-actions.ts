// @ts-check
// Today session set actions: log rows, delete chips, and update local set UI after commits.

type TodaySessionSetActionsApi = {
  wireDeletes(deps: ClientTodaySessionControllerDeps): void;
  wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void;
  refreshFinishStat(deps: ClientTodaySessionControllerDeps, options?: { repaint?: boolean }): boolean;
  captureExDrafts(root: ParentNode | null | undefined): ClientTodayExDraftSnapshot | null;
  restoreExDrafts(root: ParentNode | null | undefined, snapshot: ClientTodayExDraftSnapshot | null): void;
  reprojectPendingSets(deps: ClientTodaySessionControllerDeps): void;
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

  // Optimistic set-delete — the same shape wireLogRow's set-LOG path uses below
  // (DOM surgery + local stat repaint, no full re-render). The chip vanishes the instant you tap and the
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

  // Returns true when the surface has no Finish block yet — the first set of a
  // session brings one into existence, which only a full render can do.
  // `repaint:false` asks the question WITHOUT triggering that render: the optimistic
  // log path must not rebuild the surface from server truth that doesn't know about
  // the set yet, so it defers the repaint until the write has landed.
  function refreshFinishStat(
    deps: ClientTodaySessionControllerDeps,
    options: { repaint?: boolean } = {},
  ): boolean {
    const chips = deps.root.querySelectorAll(".ex [data-logged] .chip");
    if (!chips.length) return false;
    const stat = deps.root.querySelector("[data-finishstat]");
    if (!stat) {
      if (options.repaint !== false) {
        deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(() => deps.viewEnter()));
      }
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

  // The optimistic chip and everything the card has to put back if the write never
  // lands: the chip itself, and the skip ✕ that a logged set retires.
  type PendingSetChip = {
    card: HTMLElement;
    chip: HTMLElement;
    skip: { node: HTMLElement; parent: Node; anchor: Node | null } | null;
    mutationId?: string;
  };

  function stampChipMutationId(chip: HTMLElement, mutationId: string): void {
    chip.dataset.mutationId = mutationId;
  }

  function livePendingChip(pending: PendingSetChip, deps: ClientTodaySessionControllerDeps): HTMLElement {
    const id = pending.mutationId || pending.chip.dataset.mutationId;
    if (!id) return pending.chip;
    // todayView.innerHTML replaces the whole subtree, so pending.card is itself
    // detached after a real repaint. Search the live surface (deps.root) and
    // fall back to the original node only when nothing matches.
    for (const node of deps.root.querySelectorAll(`.chip[data-mutation-id="${id}"]`)) {
      if (node instanceof HTMLElement) return node;
    }
    return pending.chip;
  }

  // runSessionMutation allocates the idempotency id inside the lock, so the
  // optimistic chip is born without it. Stamp as soon as send() sees the key
  // (in-flight) or the queued item returns — a mid-flight repaint reprojects
  // from the same outbox id, and commit/rollback then find that live node.
  function stampPendingMutationId(
    pending: PendingSetChip | null,
    mutationId: unknown,
    deps: ClientTodaySessionControllerDeps,
  ): void {
    const id = mutationId == null ? "" : String(mutationId);
    if (!pending || !id) return;
    pending.mutationId = id;
    stampChipMutationId(pending.chip, id);
    const live = livePendingChip(pending, deps);
    if (live !== pending.chip) stampChipMutationId(live, id);
  }

  function appendPendingChip(
    card: HTMLElement | null,
    body: unknown,
    deps: ClientTodaySessionControllerDeps,
    mutationId?: string,
  ): PendingSetChip | null {
    if (!card) return null;
    const loggedWrap = card.querySelector("[data-logged]");
    if (!loggedWrap) return null;
    const set = CairnTodaySessionSetModel.responseRecord(body);
    const tpl = document.createElement("template");
    tpl.innerHTML = deps.sessionStatus.setChipHtml({
      id: null,
      set_number: card.querySelectorAll("[data-logged] .chip").length + 1,
      weight: set.weight ?? null,
      reps: set.reps ?? null,
      rir: set.rir ?? null,
      duration_sec: set.duration_sec ?? null,
    }).trim();
    const chip = tpl.content.firstElementChild as HTMLElement | null;
    if (!chip) return null;
    chip.dataset.pending = "1";
    if (mutationId) stampChipMutationId(chip, mutationId);
    chip.classList.add("chip-in");
    loggedWrap.appendChild(chip);
    // × is hidden while pending (CSS on .chip[data-pending="1"]); deleteSet also
    // bails on the empty id so a stray tap cannot DELETE a row that doesn't exist.
    wireDeletes(deps);
    bumpProgress(card);
    const skipNode = card.querySelector<HTMLElement>(".ex-skip");
    const skip = skipNode?.parentElement
      ? { node: skipNode, parent: skipNode.parentElement, anchor: skipNode.nextSibling }
      : null;
    skipNode?.remove();
    return { card, chip, skip, ...(mutationId ? { mutationId } : {}) };
  }

  function rollbackPendingChip(pending: PendingSetChip | null, deps: ClientTodaySessionControllerDeps): void {
    if (!pending) return;
    livePendingChip(pending, deps).remove();
    if (pending.skip) {
      const { node, parent, anchor } = pending.skip;
      if (anchor && anchor.parentNode === parent) parent.insertBefore(node, anchor);
      else parent.appendChild(node);
    }
    bumpProgress(pending.card);
    refreshFinishStat(deps);
  }

  // Adopt the server's row: the id is what turns the chip's × back into a real
  // DELETE /sets/:id, and the set number is the server's own count of the session.
  function commitPendingChip(
    pending: PendingSetChip | null,
    result: Record<string, unknown>,
    deps: ClientTodaySessionControllerDeps,
  ): void {
    if (!pending) return;
    const chip = livePendingChip(pending, deps);
    const id = result.id == null ? "" : String(result.id);
    chip.removeAttribute("data-pending");
    chip.removeAttribute("data-mutation-id");
    chip.dataset.set = id;
    const del = chip.querySelector<HTMLElement>("[data-del]");
    if (del) del.dataset.del = id;
    wireDeletes(deps);
    if (result.set_number != null) {
      const number = chip.querySelector<HTMLElement>(".chip-n");
      if (number) number.textContent = `#${String(result.set_number)}`;
    }
  }

  type OutboxSetItem = {
    id?: string;
    kind?: string;
    session_date?: unknown;
    body?: unknown;
    state?: "pending" | "sending" | "prepared" | "needs_attention";
  };

  // claimNext / drain replay rows with no `state` (the queued default after
  // enqueue and after settle("pending")), explicit `pending`, and `sending`.
  // `needs_attention` stays in the review sheet; `prepared` is a prepare barrier.
  function outboxSetWillReplay(item: OutboxSetItem): boolean {
    const state = item.state;
    return state == null || state === "pending" || state === "sending";
  }

  function setBodyRecord(body: unknown): Record<string, unknown> {
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  }

  function cardForQueuedSet(
    cards: HTMLElement[],
    body: Record<string, unknown>,
  ): HTMLElement | undefined {
    const exercise = String(body.exercise || "").toLowerCase();
    if (!exercise) return undefined;
    const matches = cards.filter((el) => (el.dataset.card || "").toLowerCase() === exercise);
    if (!matches.length) return undefined;
    // Peak-day duplicate names share data-card; queued sets for a lift rendered twice land on the first card.
    return matches[0];
  }

  function undeliveredSetItems(date: string): OutboxSetItem[] {
    const runtime = globalThis as { CairnOutbox?: { list?: () => OutboxSetItem[] } };
    const items = typeof runtime.CairnOutbox?.list === "function" ? runtime.CairnOutbox.list() : [];
    return items.filter((item) => {
      if (item.kind !== "set" || !outboxSetWillReplay(item)) return false;
      const body = setBodyRecord(item.body);
      return String(item.session_date || body.date || "") === date;
    });
  }

  // A full innerHTML swap drops any chip that only existed on the card. Queued
  // writes still live in the outbox, so after the new markup is wired we put
  // those sets back as data-pending chips — the same shape appendPendingChip
  // painted on the original tap.
  function reprojectPendingSets(deps: ClientTodaySessionControllerDeps): void {
    const items = undeliveredSetItems(deps.state.logDate);
    if (!items.length) return;
    const cards = [...deps.root.querySelectorAll<HTMLElement>(".ex[data-card]")];
    for (const item of items) {
      const body = setBodyRecord(item.body);
      const card = cardForQueuedSet(cards, body);
      if (!card) continue;
      const pendingCount = card.querySelectorAll("[data-pending]").length;
      const queuedForCard = items.filter((candidate) => cardForQueuedSet(cards, setBodyRecord(candidate.body)) === card).length;
      if (pendingCount >= queuedForCard) continue;
      const mutationId = item.id == null ? "" : String(item.id);
      appendPendingChip(card, body, deps, mutationId || undefined);
    }
    refreshFinishStat(deps, { repaint: false });
  }

  type TimedStopwatch = {
    pause(): void;
    reset(): void;
  };

  const activeTimedStopwatchBySurface = new WeakMap<HTMLElement, TimedStopwatch>();

  // Keep the source of truth as a clock anchor, rather than incrementing a
  // counter. Browsers throttle background timers, but Date.now() still gives the
  // right whole-second elapsed time when the row wakes up again.
  function wireTimedStopwatch(row: HTMLElement, deps: ClientTodaySessionControllerDeps): TimedStopwatch | null {
    if (row.dataset.mode !== "timed") return null;
    const duration = row.querySelector<HTMLInputElement>(".in-dur");
    const button = row.querySelector<HTMLButtonElement>(".timerbtn");
    if (!duration || !button) return null;
    const durationEl = duration;
    const timerButton = button;

    let elapsedMs = 0;
    let startedAt: number | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopwatch: TimedStopwatch;

    function clearTick(): void {
      if (interval != null) clearInterval(interval);
      interval = null;
    }

    function render(state: "idle" | "running" | "paused"): void {
      timerButton.dataset.stopwatchState = state;
      timerButton.textContent = state === "running" ? "Stop" : state === "paused" ? "Resume" : "Start";
      const exercise = decodeURIComponent(row.dataset.ex || "exercise");
      timerButton.ariaLabel = state === "running"
        ? `Stop ${exercise} stopwatch`
        : state === "paused"
          ? `Resume ${exercise} stopwatch`
          : `Start ${exercise} stopwatch`;
      timerButton.ariaPressed = state === "running" ? "true" : "false";
    }

    function elapsedNowMs(): number {
      return elapsedMs + (startedAt == null ? 0 : Math.max(0, Date.now() - startedAt));
    }

    function renderDuration(): void {
      const formatted = deps.fmtDur(Math.floor(elapsedNowMs() / 1000));
      if (durationEl.value === formatted) return;
      durationEl.value = formatted;
      durationEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function sync(): void {
      if (startedAt == null) return;
      renderDuration();
    }

    function rowDetached(): boolean {
      // The parent check keeps the small test DOM supported, while real detached
      // cards report false for both the row and its parent via isConnected.
      return row.isConnected === false && (!row.parentElement || row.parentElement.isConnected === false);
    }

    function pause(): void {
      if (startedAt == null) return;
      elapsedMs = elapsedNowMs();
      startedAt = null;
      renderDuration();
      clearTick();
      if (activeTimedStopwatchBySurface.get(deps.root) === stopwatch) activeTimedStopwatchBySurface.delete(deps.root);
      render("paused");
    }

    function takeActiveStopwatch(): void {
      const active = activeTimedStopwatchBySurface.get(deps.root);
      if (active && active !== stopwatch) active.pause();
      activeTimedStopwatchBySurface.set(deps.root, stopwatch);
      deps.stopRest();
    }

    function start(): void {
      // A new run deliberately ignores any prescribed / last-set prefill.
      elapsedMs = 0;
      startedAt = Date.now();
      takeActiveStopwatch();
      renderDuration();
      render("running");
      clearTick();
      interval = setInterval(() => {
        if (rowDetached()) {
          clearTick();
          return;
        }
        sync();
      }, 250);
    }

    function resume(): void {
      startedAt = Date.now();
      takeActiveStopwatch();
      render("running");
      clearTick();
      interval = setInterval(() => {
        if (rowDetached()) {
          clearTick();
          return;
        }
        sync();
      }, 250);
    }

    timerButton.addEventListener("click", () => {
      if (startedAt != null) pause();
      else if (elapsedMs > 0) resume();
      else start();
    });
    render("idle");

    stopwatch = {
      pause,
      reset() {
        clearTick();
        elapsedMs = 0;
        startedAt = null;
        if (activeTimedStopwatchBySurface.get(deps.root) === stopwatch) activeTimedStopwatchBySurface.delete(deps.root);
        render("idle");
      },
    };
    return stopwatch;
  }

  function wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void {
    if (!(row instanceof HTMLElement)) return;
    const logBtn = row.querySelector<HTMLButtonElement>(".logbtn");
    if (!logBtn || logBtn.dataset.wired) return;
    const surfaceDate = deps.state.logDate;
    const surfaceTab = deps.state.tab;
    const stopwatch = wireTimedStopwatch(row, deps);
    logBtn.dataset.wired = "1";
    row.querySelectorAll("input").forEach((input) => {
      if (!(input instanceof HTMLElement) || input.dataset.draftWired) return;
      input.dataset.draftWired = "1";
      input.addEventListener("input", () => {
        input.dataset.dirty = "1";
      });
    });
    logBtn.addEventListener("click", async () => {
      if (logBtn.disabled || row.dataset.logging === "1") return;
      if (!surfaceStillCurrent(deps, surfaceDate, surfaceTab)) return;
      const actionDate = surfaceDate;
      const actionTab = surfaceTab;
      // Capture the clock before parsing so a tap on + never loses the fraction
      // of a second since the last background timer tick.
      stopwatch?.pause();
      const payload = CairnTodaySessionSetModel.logPayloadFromRow(row, deps);
      if (!payload.ok) {
        deps.toast(payload.message);
        payload.focus?.();
        return;
      }

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
          item?: { id?: unknown; depends_on?: unknown };
        }>;
      };
      if (typeof runtime.runSessionMutation !== "function") {
        deps.toast("Couldn’t safely save that set — refresh and try again.");
        return;
      }

      // Per-row in-flight token: keep + disabled until the mutation resolves OR a
      // short re-arm window elapses, whichever is first. Re-enabling in the same
      // synchronous pass used to let a double-tap allocate a second idempotency
      // key and write a second row.
      row.dataset.logging = "1";
      logBtn.disabled = true;
      const rearmLog = () => {
        row.dataset.logging = "";
        logBtn.disabled = false;
      };
      const rearmTimer = typeof setTimeout === "function" ? setTimeout(rearmLog, 400) : 0;

      // OPTIMISTIC: the set is on the card, the rest timer is running and the row
      // is ready for the next set BEFORE the write leaves the device. A set the
      // athlete just did is not in doubt — the network is. The chip carries
      // data-pending="1" until the server answers with the real row: on success it
      // adopts that id (which is what makes its × a real DELETE), on failure it is
      // removed and the card re-tallied, and on a queued write it deliberately
      // STAYS — the set is durably held in the outbox, and blanking it there is
      // what read as "the app ate my set".
      const card = row.closest<HTMLElement>(".ex");
      const pending = appendPendingChip(card, payload.body, deps);
      stopwatch?.reset();
      deps.startRest();
      // The first set of a session has no Finish block to update — that one needs a
      // real render, which has to wait for the write so it doesn't repaint the set
      // away. Everything after the first set is pure local surgery.
      const finishSurfaceMissing = refreshFinishStat(deps, { repaint: false });
      if (!finishSurfaceMissing) deps.scheduleRxRefresh();
      CairnTodaySessionSetModel.invalidateSetTruth(deps);

      const mutation = await runtime.runSessionMutation({
        date: actionDate,
        kind: "set",
        path: "/sets",
        body: payload.body,
        identity: { sessionId: deps.state.sessionIdsByDate?.[actionDate] },
      }, (idempotencyKey) => {
        stampPendingMutationId(pending, idempotencyKey, deps);
        return deps.api("/sets", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Idempotency-Key": idempotencyKey },
          body: JSON.stringify(payload.body),
        });
      });
      if (mutation.status === "queued") stampPendingMutationId(pending, mutation.item?.id, deps);
      if (typeof clearTimeout === "function") clearTimeout(rearmTimer);
      rearmLog();
      if (mutation.status !== "sent") {
        // Anything that isn't a durable hold rolls the card back to what the
        // server will actually have. Rest started before the write; a failed /
        // blocked / storage_error outcome never recorded the set, so the timer
        // must not keep counting (and must not persist a deadline restoreRest
        // would resurrect). A queued write is a durable hold — the rest is real.
        if (mutation.status !== "queued") {
          rollbackPendingChip(pending, deps);
          deps.stopRest();
        }
        if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
        if (mutation.status === "queued") {
          // Deliberately NO repaint here, even for a session's first set: a render
          // reads server truth, which does not know about a set that is still in
          // the outbox — it would wipe the pending chip. The Finish block appears
          // on the next natural render, once the queue has drained.
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
        rollbackPendingChip(pending, deps);
        deps.stopRest();
        if (surfaceStillCurrent(deps, actionDate, actionTab)) {
          deps.toast(result && result.error ? String(result.error) : "Couldn't log that set.");
        }
        return;
      }

      // POST /sets returns `id` for the set itself. Only its explicit
      // `session_id` may seed Finish; older responses without that field recover
      // via GET /sessions?date= instead of adopting the set ID.
      CairnTodaySessionSetModel.rememberMutationSessionId(deps, actionDate, result);
      commitPendingChip(pending, result, deps);
      if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
      // The Finish block only exists once the session has a set, so bringing it in
      // is the one repaint the first set of the day still owes.
      if (finishSurfaceMissing) refreshFinishStat(deps);
      if (result.pr) {
        deps.toast("🏆 New PR!");
        if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([60, 40, 120]);
      } else {
        deps.toast("Set logged");
      }
    });
  }

  // ---- draft rescue across a full repaint ----
  // Weight / reps / RIR / duration live ONLY in the DOM until the set is logged, and
  // both logging surfaces repaint by replacing their whole subtree — which threw away
  // whatever the athlete had typed mid-set, along with the caret. So the drafts and the
  // focused field are lifted off the old cards and put back on the new ones. Cards are
  // keyed by name PLUS their ordinal among same-named cards, because a peak day renders
  // one lift twice (top single + back-off block).
  function draftKey(card: HTMLElement, seen: Map<string, number>): string {
    const name = (card.dataset.card || "").toLowerCase();
    const ordinal = seen.get(name) || 0;
    seen.set(name, ordinal + 1);
    return `${name}#${ordinal}`;
  }

  function captureExDrafts(root: ParentNode | null | undefined): ClientTodayExDraftSnapshot | null {
    if (!root) return null;
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const drafts = new Map<string, Array<string | null>>();
    let focus: ClientTodayExDraftSnapshot["focus"] = null;
    const seen = new Map<string, number>();
    for (const card of root.querySelectorAll<HTMLElement>(".ex[data-card]")) {
      const key = draftKey(card, seen);
      const inputs = [...card.querySelectorAll<HTMLInputElement>(".logrow input")];
      if (!inputs.length) continue;
      const values = inputs.map((el) => {
        const focused = el === active;
        if (!focused && el.dataset.dirty !== "1") return null;
        return el.value || "";
      });
      const focusIndex = active ? inputs.indexOf(active as HTMLInputElement) : -1;
      if (focusIndex >= 0) {
        const el = inputs[focusIndex];
        focus = { key, index: focusIndex, start: el.selectionStart ?? null, end: el.selectionEnd ?? null };
      }
      if (focusIndex >= 0 || values.some((value) => value != null)) drafts.set(key, values);
    }
    return drafts.size ? { drafts, focus } : null;
  }

  function restoreExDrafts(root: ParentNode | null | undefined, snapshot: ClientTodayExDraftSnapshot | null): void {
    if (!root || !snapshot) return;
    const seen = new Map<string, number>();
    for (const card of root.querySelectorAll<HTMLElement>(".ex[data-card]")) {
      const key = draftKey(card, seen);
      const values = snapshot.drafts.get(key);
      const focused = snapshot.focus && snapshot.focus.key === key ? snapshot.focus : null;
      if (!values && !focused) continue;
      const inputs = [...card.querySelectorAll<HTMLInputElement>(".logrow input")];
      (values || []).forEach((value, index) => {
        const el = inputs[index];
        if (!el || value == null || el.value === value) return;
        el.value = value;
        // The live "That beats last time" line listens on input — only the event
        // tells it the row changed under it.
        try {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } catch {}
      });
      const focusEl = focused ? inputs[focused.index] : null;
      if (focused && focusEl) {
        try {
          focusEl.focus({ preventScroll: true });
          if (focused.start != null) focusEl.setSelectionRange(focused.start, focused.end ?? focused.start);
        } catch {}
      }
    }
  }

  const CAIRN_TODAY_SESSION_SET_ACTIONS: TodaySessionSetActionsApi = {
    wireDeletes,
    wireLogRow,
    refreshFinishStat,
    captureExDrafts,
    restoreExDrafts,
    reprojectPendingSets,
  };

  Object.assign(globalThis, { CairnTodaySessionSetActions: CAIRN_TODAY_SESSION_SET_ACTIONS });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSetActions = CAIRN_TODAY_SESSION_SET_ACTIONS;
  }
})();

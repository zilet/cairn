// @ts-check
// Today session set actions: log rows, delete chips, and update local set UI after commits.

type TodaySessionSetActionsApi = {
  wireDeletes(deps: ClientTodaySessionControllerDeps): void;
  wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void;
  refreshFinishStat(deps: ClientTodaySessionControllerDeps, options?: { repaint?: boolean }): boolean;
  captureExDrafts(root: ParentNode | null | undefined): ClientTodayExDraftSnapshot | null;
  restoreExDrafts(root: ParentNode | null | undefined, snapshot: ClientTodayExDraftSnapshot | null): void;
  reprojectPendingSets(deps: ClientTodaySessionControllerDeps): void;
  reattachSavedSets(deps: ClientTodaySessionControllerDeps): void;
  markRepeats(deps: ClientTodaySessionControllerDeps, session: unknown): void;
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
    const held = CairnSessionSetLedger.forget(id); // a repaint mid-delete must not put it back
    try {
      const result = CairnTodaySessionSetModel.responseRecord(await deps.api(`/sets/${id}`, { method: "DELETE" }));
      if (result.error) throw new Error(String(result.error));
    } catch {
      if (held) CairnSessionSetLedger.remember(held, { seen: held.seen });
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
    stat.textContent = `${sets} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + CairnFmt.date(deps.state.logDate)}`;
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

  // A full innerHTML swap drops any chip that only existed on the card. Queued
  // writes still live in the outbox, so after the new markup is wired we put
  // those sets back as data-pending chips — the same shape appendPendingChip
  // painted on the original tap. (An off-plan lift keeps its card for them through
  // CairnSessionSetLedger.merge, run on the read the surface was built from.)
  function reprojectPendingSets(deps: ClientTodaySessionControllerDeps): void {
    const ledger = CairnSessionSetLedger;
    const items = ledger.undeliveredSets(deps.state.logDate);
    if (!items.length) return;
    const cards = [...deps.root.querySelectorAll<HTMLElement>(".ex[data-card]")];
    const cardOf = (item: { body?: unknown }) => ledger.cardFor(cards, ledger.bodyOf(item.body).exercise);
    for (const item of items) {
      const card = cardOf(item);
      if (!card) continue;
      const pendingCount = card.querySelectorAll("[data-pending]").length;
      if (pendingCount >= items.filter((candidate) => cardOf(candidate) === card).length) continue;
      const mutationId = item.id == null ? "" : String(item.id);
      appendPendingChip(card, ledger.bodyOf(item.body), deps, mutationId || undefined);
    }
    refreshFinishStat(deps, { repaint: false });
  }

  // A set whose POST answered AFTER the read this surface was built from began: the outbox
  // has let it go and the read never had it. The server's own answer puts it back, with its
  // real id (so its × deletes). No card for it yet (an off-plan lift): one more read draws it.
  const repaintAskedFor = new Set<string>();
  function reattachSavedSets(deps: ClientTodaySessionControllerDeps): void {
    const cards = [...deps.root.querySelectorAll<HTMLElement>(".ex[data-card]")];
    let added = false;
    for (const entry of CairnSessionSetLedger.recent(deps.state.logDate)) {
      if (deps.root.querySelector(`.chip[data-set="${entry.id}"]`)) continue;
      const card = CairnSessionSetLedger.cardFor(cards, entry.exercise);
      const wrap = card?.querySelector("[data-logged]");
      if (!card || !wrap) {
        if (!repaintAskedFor.has(entry.id)) {
          repaintAskedFor.add(entry.id);
          void deps.renderToday({ soft: true });
        }
        continue;
      }
      const tpl = document.createElement("template");
      tpl.innerHTML = deps.sessionStatus.setChipHtml({ ...entry }).trim();
      const chip = tpl.content.firstElementChild;
      if (!(chip instanceof HTMLElement)) continue;
      wrap.appendChild(chip);
      card.querySelector(".ex-skip")?.remove();
      bumpProgress(card);
      added = true;
    }
    if (!added) return;
    wireDeletes(deps);
    refreshFinishStat(deps, { repaint: false });
  }

  // The last line against a set logged twice: a set entered while the screen was missing
  // saved sets of that lift, matching one of them, is marked — one tap removes it, one
  // keeps it. Never a dialog, never in the way of the next set.
  function markRepeats(deps: ClientTodaySessionControllerDeps, session: unknown): void {
    deps.root.querySelectorAll("[data-repeat-line]").forEach((line) => line.remove());
    const byCard = new Map<HTMLElement, HTMLElement[]>();
    for (const id of CairnSessionSetLedger.repeats(deps.state.logDate, session)) {
      const chip = deps.root.querySelector<HTMLElement>(`.chip[data-set="${id}"]`);
      const card = chip?.closest<HTMLElement>(".ex");
      if (!chip || !card) continue;
      chip.dataset.repeat = "1";
      byCard.set(card, [...(byCard.get(card) || []), chip]);
    }
    for (const [card, chips] of byCard) {
      const one = chips.length === 1;
      const tpl = document.createElement("template");
      tpl.innerHTML = `<div class="ex-reaction ex-repeat" data-repeat-line role="status">${escHtml(one ? "This set matches one already saved that the screen had missed." : `These ${chips.length} sets match ones already saved that the screen had missed.`)} <button type="button" class="ghostbtn" data-repeat-remove>${one ? "Remove the repeat" : "Remove the repeats"}</button> <button type="button" class="ghostbtn" data-repeat-keep>Keep</button></div>`;
      const line = tpl.content.firstElementChild;
      const logged = card.querySelector("[data-logged]");
      if (!(line instanceof HTMLElement) || !logged?.parentElement) continue;
      logged.parentElement.insertBefore(line, logged.nextSibling);
      line.querySelector("[data-repeat-remove]")?.addEventListener("click", () => {
        line.remove();
        for (const chip of chips) {
          const del = chip.querySelector<HTMLElement>("[data-del]");
          if (del) void deleteSet(del, deps);
        }
      });
      line.querySelector("[data-repeat-keep]")?.addEventListener("click", () => {
        line.remove();
        CairnSessionSetLedger.keep(chips.map((chip) => String(chip.dataset.set || "")));
        for (const chip of chips) delete chip.dataset.repeat;
      });
    }
  }

  function wireLogRow(row: Element | null | undefined, deps: ClientTodaySessionControllerDeps): void {
    if (!(row instanceof HTMLElement)) return;
    const logBtn = row.querySelector<HTMLButtonElement>(".logbtn");
    if (!logBtn || logBtn.dataset.wired) return;
    const surfaceDate = deps.state.logDate;
    const surfaceTab = deps.state.tab;
    const stopwatch = CairnTodaySessionStopwatch.wire(row, deps);
    logBtn.dataset.wired = "1";
    row.querySelectorAll("input").forEach((input) => {
      if (!(input instanceof HTMLElement) || input.dataset.draftWired) return;
      input.dataset.draftWired = "1";
      input.addEventListener("input", () => {
        input.dataset.dirty = "1";
      });
    });
    CairnSessionEntry.tapWithoutBlur(logBtn, async () => { // never blurs the field first: session-entry-client.ts
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
      const rearmLog = () => { row.dataset.logging = ""; logBtn.disabled = false; };
      const rearmTimer = typeof setTimeout === "function" ? setTimeout(rearmLog, 400) : 0;
      const typing = typeof document !== "undefined" ? document.activeElement : null; // registered: let the keyboard go
      if (typing instanceof HTMLElement && row.contains(typing)) typing.blur();

      // OPTIMISTIC: the set is on the card, the rest timer is running and the row
      // is ready for the next set BEFORE the write leaves the device. A set the
      // athlete just did is not in doubt — the network is. The chip carries
      // data-pending="1" until the server answers with the real row: on success it
      // adopts that id (which is what makes its × a real DELETE), on failure it is
      // removed and the card re-tallied, and on a queued write it deliberately
      // STAYS — the set is durably held in the outbox, and blanking it there is
      // what read as "the app ate my set".
      const card = row.closest<HTMLElement>(".ex");
      const seen = CairnSessionSetLedger.seenOnScreen(deps.root, String(payload.body.exercise || ""));
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
      CairnSessionSetLedger.remember(result, { seen });
      // Dropped again now the row exists: a read that began before it landed (the drop on
      // the tap only covers reads begun after) is never kept as this day's session.
      deps.invalidate("today:aggregate:" + actionDate);
      deps.invalidate("today:session:" + actionDate);
      commitPendingChip(pending, result, deps);
      if (!surfaceStillCurrent(deps, actionDate, actionTab)) return;
      // The Finish block only exists once the session has a set, so bringing it in
      // is the one repaint the first set of the day still owes.
      if (finishSurfaceMissing) refreshFinishStat(deps);
      CairnTodaySetNotes.delivered(card, result, deps.toast);
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
        // The live "That beats last time" line listens on input; only the event tells it.
        try {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } catch {}
      });
      const focusEl = focused ? inputs[focused.index] : null;
      if (focused && focusEl) {
        try {
          focusEl.focus({ preventScroll: true });
          if (focused.start != null) focusEl.setSelectionRange(focused.start, focused.end ?? focused.start);
          document.dispatchEvent(new Event("cairn:reveal-focused"));
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
    reattachSavedSets,
    markRepeats,
  };

  Object.assign(globalThis, { CairnTodaySessionSetActions: CAIRN_TODAY_SESSION_SET_ACTIONS });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSetActions = CAIRN_TODAY_SESSION_SET_ACTIONS;
  }
})();

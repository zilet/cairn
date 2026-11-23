// @ts-check
// Progress history route and session edit interaction controller.

function sessionCardHtml(session: unknown, index: number): string {
  return CairnProgressHistoryRender.sessionCardHtml(session, index);
}

function numOrNull(value: unknown): number | null {
  return CairnProgressHistoryModel.numOrNull(value);
}

// SWR over /sessions?limit=30 (key history:sessions): a warm re-entry into the
// History seg paints the hero + session cards instantly, then revalidates and
// re-paints only on change. A set-log / session-edit invalidates the key.
async function renderHistory() {
  headerTitle.textContent = "History";
  state.progressSeg = "sessions"; // remember the chosen seg so the default never yanks back
  const token = ++pollToken;
  const peek = peekCached("history:sessions");
  if (!peek) view.innerHTML = segSkeleton("sessions", PROGRESS_SEG, 3); // cold: skeleton-first
  return paintSWR({
    key: "history:sessions",
    path: "/sessions?limit=30",
    peek: peek as never,
    token,
    tab: "progress",
    render: (sessions: unknown) => paintHistoryBody(CairnProgressHistoryModel.rows<HistorySession>(sessions)),
  });
}

const HISTORY_LEAD = 6;

// Build + wire the History view from a sessions list. Idempotent: re-queries the
// freshly-written DOM each call (warm peek + changed revalidate both route here).
function paintHistoryBody(sessions: HistorySession[]) {
  const head = segBar("sessions", PROGRESS_SEG);
  const shown = CairnProgressHistoryModel.listed(sessions);
  if (!shown.length) {
    view.innerHTML = head + progressHero("Training history", []) +
      emptyStateHtml(art("exercise", "barbell squat"), "No sessions logged yet — your story starts on Today.");
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  // One voice line and one fact; pounds moved lives on Volume, one tap deeper.
  const summary = CairnProgressHistoryModel.summary(shown);
  const month = summary.monthSessions;
  const hero = progressHero("Training history", [], {
    line: month
      ? `${progressCountWord(month, true)} session${month === 1 ? "" : "s"} this month.`
      : "A quiet month so far.",
    fact: summary.sets30 ? `${summary.sets30} set${summary.sets30 === 1 ? "" : "s"} · last 30 days` : "",
  });
  // The latest sessions lead; the rest of the month folds under one line, one tap away.
  const lead = shown.slice(0, HISTORY_LEAD);
  const earlier = shown.slice(HISTORY_LEAD);
  const more = earlier.length
    ? `<details class="hist-more"><summary class="hist-more-sum">${earlier.length} earlier session${earlier.length === 1 ? "" : "s"}</summary>
        <div class="sess-grid">${earlier.map((s, i) => sessionCardHtml(s, Math.min(12, i + 1))).join("")}</div></details>`
    : "";
  view.innerHTML = head + hero + `<div class="sess-grid">${lead.map((s, i) => sessionCardHtml(s, i + 1)).join("")}</div>${more}`;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  // Tap a past session → edit its logged sets + notes (corrections flow into the brain).
  const openFrom = (card: Element) => {
    const sess = shown.find((s) => s.id === Number((card as HTMLElement).dataset.sessid));
    if (sess) openSessionEdit(sess, card);
  };
  view.querySelectorAll(".hist-tap[data-sessid]").forEach((card) => {
    card.addEventListener("click", () => openFrom(card));
    card.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFrom(card); }
    });
  });
}

// Edit a past session: correct any logged set's numbers (or duration), delete a
// mis-entry, fix the notes. Saves via PUT /sets/:id + PUT /sessions/:id/notes — and
// because trainingSignals re-reads sessions live, the coach sees the correction on
// its next read. No score, no judgement — just "fix what you logged".
async function openSessionEdit(sess: HistorySession, fromEl: Element) {
  openDetailFrom(fromEl, () => {
    const el = mountDetail(CairnProgressHistoryRender.sessionEditHtml(sess));
    wireDetailCommon();
    // delete a set inline — two-tap armed × (the one destructive-confirm pattern),
    // then the row collapses out (deletion is committed on the confirming tap).
    el.querySelectorAll<HTMLElement>("[data-eddel]").forEach((b) => b.addEventListener("click", () => armDelete(b, async () => {
      try { await api(`/sets/${b.dataset.eddel}`, { method: "DELETE" }); } catch { toast("Couldn't delete set"); return; }
      (globalThis as { CairnSessionSetLedger?: SessionSetLedgerApi }).CairnSessionSetLedger?.forget(b.dataset.eddel); // the session screen lets it go too
      const row = b.closest(".edset"); if (row) collapseEl(row, () => row.remove());
    })));
    const save = el.querySelector<HTMLButtonElement>("#edSave");
    if (save) save.addEventListener("click", async () => {
      save.disabled = true;
      const tasks: Array<Promise<unknown>> = [];
      el.querySelectorAll<HTMLElement>(".edset").forEach((row) => {
        if (!row.isConnected) return; // a set deleted mid-edit
        const id = row.dataset.setid;
        const body = row.dataset.kind === "timed"
          ? {
              weight: numOrNull(row.querySelector<HTMLInputElement>(".edset-w")?.value),
              duration_sec: parseDur(row.querySelector<HTMLInputElement>(".edset-dur")?.value),
            }
          : {
              weight: numOrNull(row.querySelector<HTMLInputElement>(".edset-w")?.value),
              reps: numOrNull(row.querySelector<HTMLInputElement>(".edset-r")?.value),
              rir: numOrNull(row.querySelector<HTMLInputElement>(".edset-rir")?.value),
            };
        tasks.push(api(`/sets/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      });
      tasks.push(api(`/sessions/${sess.id}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: el.querySelector<HTMLTextAreaElement>("#edNotes")?.value.trim() || "" }),
      }));
      try { await Promise.all(tasks); toast("Updated"); } catch { toast("Some changes didn't save"); }
      // corrected sets/notes change the History list, weekly stats, volume, and (if
      // it's that date's session) Today — drop the caches so renderHistory below and
      // any later paint read truth.
      swrInvalidate("history:sessions");
      swrInvalidate("stats");
      swrInvalidate("progress:volume");
      swrInvalidate("progress:volume-balance");
      swrInvalidate("progress:1rm:");
      if (sess.date) swrInvalidate("today:session:" + sess.date);
      closeDetail(true);
      renderHistory();
    });
  });
}

const CAIRN_PROGRESS_HISTORY = {
  renderHistory,
  paintHistoryBody,
  openSessionEdit,
  sessionCardHtml,
  numOrNull,
};

Object.assign(globalThis, {
  CairnProgressHistory: CAIRN_PROGRESS_HISTORY,
  renderHistory,
  sessionCardHtml,
  numOrNull,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressHistory: CAIRN_PROGRESS_HISTORY,
    renderHistory,
    sessionCardHtml,
    numOrNull,
  });
}

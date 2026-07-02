(() => {
// @ts-check
// Progress history route and session edit interaction controller.
function sessionCardHtml(session, index) {
    return CairnProgressHistoryRender.sessionCardHtml(session, index);
}
function numOrNull(value) {
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
    if (!peek)
        view.innerHTML = segSkeleton("sessions", PROGRESS_SEG, 3); // cold: skeleton-first
    return paintSWR({
        key: "history:sessions",
        path: "/sessions?limit=30",
        peek: peek,
        token,
        tab: "progress",
        render: (sessions) => paintHistoryBody(CairnProgressHistoryModel.rows(sessions)),
    });
}
// Build + wire the History view from a sessions list. Idempotent: re-queries the
// freshly-written DOM each call (warm peek + changed revalidate both route here).
function paintHistoryBody(sessions) {
    const head = segBar("sessions", PROGRESS_SEG);
    if (!sessions.length) {
        view.innerHTML = head + progressHero("Training history", []) +
            emptyStateHtml(art("exercise", "barbell squat"), "No sessions logged yet — your story starts on Today.");
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const hero = progressHero("Training history", CairnProgressHistoryModel.summary(sessions).stats);
    view.innerHTML = head + hero + `<div class="sess-grid">${sessions.map((s, i) => sessionCardHtml(s, i + 1)).join("")}</div>`;
    wireSeg(PROGRESS_HANDLERS);
    runCountUps(view);
    // Tap a past session → edit its logged sets + notes (corrections flow into the brain).
    const openFrom = (card) => {
        const sess = sessions.find((s) => s.id === Number(card.dataset.sessid));
        if (sess)
            openSessionEdit(sess, card);
    };
    view.querySelectorAll(".hist-tap[data-sessid]").forEach((card) => {
        card.addEventListener("click", () => openFrom(card));
        card.addEventListener("keydown", (event) => {
            const e = event;
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openFrom(card);
            }
        });
    });
}
// Edit a past session: correct any logged set's numbers (or duration), delete a
// mis-entry, fix the notes. Saves via PUT /sets/:id + PUT /sessions/:id/notes — and
// because trainingSignals re-reads sessions live, the coach sees the correction on
// its next read. No score, no judgement — just "fix what you logged".
async function openSessionEdit(sess, fromEl) {
    openDetailFrom(fromEl, () => {
        const el = mountDetail(CairnProgressHistoryRender.sessionEditHtml(sess));
        wireDetailCommon();
        // delete a set inline — two-tap armed × (the one destructive-confirm pattern),
        // then the row collapses out (deletion is committed on the confirming tap).
        el.querySelectorAll("[data-eddel]").forEach((b) => b.addEventListener("click", () => armDelete(b, async () => {
            try {
                await api(`/sets/${b.dataset.eddel}`, { method: "DELETE" });
            }
            catch {
                toast("Couldn't delete set");
                return;
            }
            const row = b.closest(".edset");
            if (row)
                collapseEl(row, () => row.remove());
        })));
        const save = el.querySelector("#edSave");
        if (save)
            save.addEventListener("click", async () => {
                save.disabled = true;
                const tasks = [];
                el.querySelectorAll(".edset").forEach((row) => {
                    if (!row.isConnected)
                        return; // a set deleted mid-edit
                    const id = row.dataset.setid;
                    const body = row.dataset.kind === "timed"
                        ? { duration_sec: parseDur(row.querySelector(".edset-dur")?.value) }
                        : {
                            weight: numOrNull(row.querySelector(".edset-w")?.value),
                            reps: numOrNull(row.querySelector(".edset-r")?.value),
                            rir: numOrNull(row.querySelector(".edset-rir")?.value),
                        };
                    tasks.push(api(`/sets/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
                });
                tasks.push(api(`/sessions/${sess.id}/notes`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ notes: el.querySelector("#edNotes")?.value.trim() || "" }),
                }));
                try {
                    await Promise.all(tasks);
                    toast("Updated");
                }
                catch {
                    toast("Some changes didn't save");
                }
                // corrected sets/notes change the History list, weekly stats, volume, and (if
                // it's that date's session) Today — drop the caches so renderHistory below and
                // any later paint read truth.
                swrInvalidate("history:sessions");
                swrInvalidate("stats");
                swrInvalidate("progress:volume");
                if (sess.date)
                    swrInvalidate("today:session:" + sess.date);
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
})();

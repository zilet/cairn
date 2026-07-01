(() => {
// @ts-check
// Progress history route, card renderer, and session edit controller.
function progressHistoryRows(value) {
    return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
}
function progressHistoryString(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
}
function progressHistoryNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
function sessionSetScore(set) {
    if (set.duration_sec != null)
        return Number(set.duration_sec) || 0;
    const weight = Number(set.weight);
    const reps = Number(set.reps);
    return weight > 0 && reps ? weight * (1 + reps / 30) : reps || 0;
}
function progressHistoryWeekday(date) {
    const [year, month, day] = String(date || "").split("-").map(Number);
    return year ? new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "long" }) : "";
}
function progressHistoryExerciseGroups(sets) {
    const byExercise = {};
    for (const set of sets || []) {
        const exercise = String(set.exercise ?? "");
        (byExercise[exercise] ??= []).push(set);
    }
    return Object.entries(byExercise).map(([exercise, groupedSets]) => {
        let bestIndex = 0;
        groupedSets.forEach((set, setIndex) => {
            if (sessionSetScore(set) > sessionSetScore(groupedSets[bestIndex] ?? {}))
                bestIndex = setIndex;
        });
        return { exercise, sets: groupedSets, bestIndex };
    });
}
function progressHistorySessionCardModel(session) {
    const row = (session ?? {});
    return {
        row,
        weekday: progressHistoryWeekday(row.date),
        groups: progressHistoryExerciseGroups(row.sets),
        tonnage: setsTonnage(row.sets),
        setCount: (row.sets || []).length,
    };
}
function progressHistorySetFigure(set) {
    return set.duration_sec != null ? fmtDur(set.duration_sec) : `${fmtWeight(set.weight)}×${set.reps}`;
}
function sessionCardHtml(session, index) {
    const model = progressHistorySessionCardModel(session);
    const { row, weekday, tonnage, setCount } = model;
    const lines = model.groups.map(({ exercise, sets, bestIndex }) => {
        const figures = sets.map((set, setIndex) => {
            const figure = progressHistorySetFigure(set);
            return `<span class="hist-set${setIndex === bestIndex && sets.length > 1 ? " hist-best" : ""}">${escHtml(figure)}</span>`;
        }).join(`<span class="hist-sep">·</span>`);
        return `<div class="hist-line"><span class="hist-ex">${escHtml(exercise)}</span><span class="hist-sets">${figures}</span></div>`;
    }).join("");
    const chips = [
        tonnage ? `${fmtK(Math.round(tonnage))} lb` : null,
        row.duration_min ? `${row.duration_min} min` : null,
        `${setCount} set${setCount === 1 ? "" : "s"}`,
    ].filter(Boolean).map((text) => `<span class="hist-chip">${escHtml(text)}</span>`).join("");
    return `<div class="sess hist hist-tap reveal" data-sessid="${escAttr(row.id)}" role="button" tabindex="0" style="${stagger(index)}" aria-label="Edit ${escAttr(weekday)} session">
      <div class="hist-head">
        <div>
          <div class="hist-kicker lbl">${escHtml(fmtShortDate(row.date))}${(row.title || row.day_name) ? ` · ${escHtml(row.title || row.day_name)}` : ""}</div>
          <div class="hist-day">${escHtml(weekday)}<span class="hist-edit" aria-hidden="true">edit</span></div>
        </div>
        <div class="hist-chips">${chips}</div>
      </div>
      ${lines || `<div class="hist-line"><span class="hist-ex" style="color:var(--muted)">No sets</span></div>`}
      ${row.notes ? `<div class="hist-notes">“${escHtml(row.notes)}”</div>` : ""}
    </div>`;
}
function numOrNull(value) {
    if (value === "" || value == null)
        return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
// SWR over /sessions?limit=30 (key history:sessions): a warm re-entry into the
// History seg paints the hero + session cards instantly, then revalidates and
// re-paints only on change. A set-log / session-edit invalidates the key.
async function renderHistory() {
    headerTitle.textContent = "Progress";
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
        render: (sessions) => paintHistoryBody(progressHistoryRows(sessions)),
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
    const ym = localISO().slice(0, 7);
    const iso30 = localISO(new Date(Date.now() - 30 * 864e5));
    const inMonth = sessions.filter((s) => progressHistoryString(s.date).slice(0, 7) === ym).length;
    const last30 = sessions.filter((s) => progressHistoryString(s.date) >= iso30);
    const t30 = last30.reduce((t, s) => t + setsTonnage(s.sets), 0);
    const sets30 = last30.reduce((t, s) => t + (s.sets || []).length, 0);
    const hero = progressHero("Training history", [
        ["sessions this month", inMonth],
        ["lb moved · 30d", Math.round(t30), { k: true }],
        ["sets · 30d", sets30],
    ]);
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
    const sets = (sess.sets || []).slice().sort((a, b) => progressHistoryNumber(a.id) - progressHistoryNumber(b.id));
    const byEx = {};
    for (const s of sets) {
        const key = progressHistoryString(s.exercise) || "Exercise";
        (byEx[key] ??= []).push(s);
    }
    const groups = Object.entries(byEx).map(([ex, list]) => {
        const setRows = list.map((s) => {
            const timed = s.duration_sec != null || s.mode === "timed";
            const fields = timed
                ? `<input class="edset-dur" inputmode="numeric" value="${s.duration_sec != null ? fmtDur(s.duration_sec) : ""}" placeholder="1:30" aria-label="duration">`
                : `<input class="edset-w" type="number" inputmode="decimal" value="${s.weight ?? ""}" placeholder="wt" aria-label="weight">
           <input class="edset-r" type="number" inputmode="numeric" value="${s.reps ?? ""}" placeholder="reps" aria-label="reps">
           <input class="edset-rir" type="number" inputmode="numeric" value="${s.rir ?? ""}" placeholder="rir" aria-label="rir">`;
            return `<div class="edset" data-setid="${s.id}" data-kind="${timed ? "timed" : "reps"}">
          ${fields}
          <button class="edset-del" data-eddel="${s.id}" title="Delete set" aria-label="Delete set">×</button>
        </div>`;
        }).join("");
        return `<div class="ed-exgroup"><div class="ed-exname">${escHtml(ex)}</div>${setRows}</div>`;
    }).join("");
    openDetailFrom(fromEl, () => {
        const el = mountDetail(`
      <h2 class="detail-title">${escHtml(sess.title || sess.day_name || "Session")}</h2>
      <div class="detail-ctx lbl">${escHtml(fmtShortDate(sess.date))} · edit logged sets</div>
      <div class="ed-sets">${groups || `<div class="detail-body" style="color:var(--muted)">No sets logged.</div>`}</div>
      <div class="detail-section"><div class="lbl">Session notes</div>
        <textarea id="edNotes" class="ed-notes" rows="2" placeholder="How did it go?">${escHtml(sess.notes || "")}</textarea></div>
      <div class="detail-actions">
        <button class="pillbtn pill-accent" id="edSave">Save changes</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`);
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

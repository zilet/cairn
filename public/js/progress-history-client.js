(() => {
// @ts-check
// Progress history card renderer and shared edit-field number coercion.
function sessionSetScore(set) {
    if (set.duration_sec != null)
        return Number(set.duration_sec) || 0;
    const weight = Number(set.weight);
    const reps = Number(set.reps);
    return weight > 0 && reps ? weight * (1 + reps / 30) : reps || 0;
}
function sessionCardHtml(session, index) {
    const row = (session ?? {});
    const [year, month, day] = String(row.date || "").split("-").map(Number);
    const weekday = year ? new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "long" }) : "";
    const byExercise = {};
    for (const set of row.sets || []) {
        const exercise = String(set.exercise ?? "");
        (byExercise[exercise] ??= []).push(set);
    }
    const lines = Object.entries(byExercise).map(([exercise, sets]) => {
        let bestIndex = 0;
        sets.forEach((set, setIndex) => {
            if (sessionSetScore(set) > sessionSetScore(sets[bestIndex] ?? {}))
                bestIndex = setIndex;
        });
        const figures = sets.map((set, setIndex) => {
            const figure = set.duration_sec != null ? fmtDur(set.duration_sec) : `${fmtWeight(set.weight)}×${set.reps}`;
            return `<span class="hist-set${setIndex === bestIndex && sets.length > 1 ? " hist-best" : ""}">${escHtml(figure)}</span>`;
        }).join(`<span class="hist-sep">·</span>`);
        return `<div class="hist-line"><span class="hist-ex">${escHtml(exercise)}</span><span class="hist-sets">${figures}</span></div>`;
    }).join("");
    const tonnage = setsTonnage(row.sets);
    const setCount = (row.sets || []).length;
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
const CAIRN_PROGRESS_HISTORY = {
    sessionCardHtml,
    numOrNull,
};
Object.assign(globalThis, {
    CairnProgressHistory: CAIRN_PROGRESS_HISTORY,
    sessionCardHtml,
    numOrNull,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressHistory: CAIRN_PROGRESS_HISTORY,
        sessionCardHtml,
        numOrNull,
    });
}
})();

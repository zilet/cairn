(() => {
// @ts-check
// Me health log list rendering: food notes, activity rows, and note-card click wiring.
(() => {
    function healthLogRows(value) {
        return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
    }
    function wireNoteCard(el, deps) {
        const card = el;
        if (!card || card._wired)
            return;
        card._wired = true;
        card.addEventListener("click", (e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (target?.closest("button, a, input"))
                return;
            const note = (deps.state._notesById || {})[card.dataset.noteid || ""];
            if (note)
                deps.openFoodDetail(note, card.querySelector(".artile"));
        });
    }
    function renderNotes(notes, deps) {
        const wrap = deps.select("#notelist");
        if (!wrap)
            return;
        const rows = healthLogRows(notes);
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty">Nothing logged yet. Snap a plate or jot a meal in Chat and it shows up here.</div>`;
            return;
        }
        deps.state._notesById = Object.fromEntries(rows.map((note) => [String(note.id), note]));
        wrap.innerHTML = rows.map((note, index) => deps.noteEntryHtml(note, index)).join("");
        wrap.querySelectorAll(".fnent").forEach((el) => wireNoteCard(el, deps));
    }
    function renderActs(acts, deps) {
        const wrap = deps.select("#actlist");
        if (!wrap)
            return;
        const rows = healthLogRows(acts);
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty">Nothing logged yet. Log a ride, run, or walk on Today and it lands here.</div>`;
            return;
        }
        wrap.innerHTML = rows.map((activity) => deps.activityEntryHtml(activity)).join("");
    }
    const CAIRN_ME_HEALTH_LOG_RENDERER = {
        healthLogRows,
        wireNoteCard,
        renderNotes,
        renderActs,
    };
    Object.assign(globalThis, { CairnMeHealthLogRenderer: CAIRN_ME_HEALTH_LOG_RENDERER });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnMeHealthLogRenderer: CAIRN_ME_HEALTH_LOG_RENDERER });
    }
})();
})();

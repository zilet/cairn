(() => {
// @ts-check
// Pure Today session status rendering helpers for the vanilla PWA.
(() => {
    const TODAY_FEEL_FACES = ["·", "◦", "○", "◍", "●"];
    function todaySetChipHtml(set, index) {
        const row = set && typeof set === "object" ? set : {};
        const number = row.set_number ?? (index != null ? index + 1 : null);
        const id = row.id != null ? String(row.id) : "";
        const figure = row.duration_sec != null
            ? fmtDur(row.duration_sec)
            : `${fmtWeight(row.weight)} <span>×</span> ${escHtml(row.reps ?? "")}${row.rir != null ? ` <span>@${escHtml(row.rir)}</span>` : ""}`;
        return `<span class="chip" data-set="${escAttr(id)}">${number != null ? `<span class="chip-n">#${escHtml(number)}</span> ` : ""}${figure}<button class="xbtn chip-x" data-del="${escAttr(id)}" title="delete">×</button></span>`;
    }
    // Tonnage = sum weight×reps over loaded sets. Timed, bodyweight, and assisted
    // sets stay out of the load total, matching the historical Today/History rule.
    function todaySetsTonnage(sets) {
        return (Array.isArray(sets) ? sets : []).reduce((total, row) => {
            const set = row && typeof row === "object" ? row : {};
            const weight = Number(set.weight);
            const reps = Number(set.reps);
            return total + (weight > 0 && reps ? weight * reps : 0);
        }, 0);
    }
    function todaySessionDoneCardHtml(session, day, options = {}) {
        const row = session && typeof session === "object" ? session : {};
        const sets = Array.isArray(row.sets) ? row.sets : [];
        const setCount = sets.length;
        const tonnage = todaySetsTonnage(sets);
        const name = row.title || day?.name || row.day_name || "Session";
        const chips = [
            `${setCount} set${setCount === 1 ? "" : "s"}`,
            tonnage ? `${Math.round(tonnage).toLocaleString()} lb` : null,
            row.duration_min ? `${row.duration_min} min` : null,
        ].filter(Boolean).map((text) => `<span class="done-chip">${escHtml(text)}</span>`).join("");
        return `<div class="sessiondone reveal" style="--i:2">
      <div class="done-mark" aria-hidden="true">✓</div>
      <div class="done-kicker lbl">${options.isToday ? "Today · complete" : "Complete"}</div>
      <h2 class="done-title">${escHtml(name)}</h2>
      <div class="done-chips">${chips}</div>
      ${row.notes ? `<div class="done-notes">“${escHtml(row.notes)}”</div>` : ""}
      <div id="feedbackSlot" class="feedback-slot done-feedback"></div>
      <div class="done-actions">
        <button class="ghostbtn done-reopen" id="reopenBtn">Log more</button>
        <button class="ghostbtn done-history" id="toHistoryBtn">In your history →</button>
      </div>
    </div>`;
    }
    function todaySessionHasFeedback(session) {
        const row = session && typeof session === "object" ? session : {};
        return row.soreness != null || row.performance != null ||
            (row.joint_pain != null && String(row.joint_pain).trim() !== "");
    }
    function todayFeedbackOpenHtml() {
        return `<button class="checkin-open" id="feedbackOpen" type="button">
      <span class="checkin-open-dot" aria-hidden="true"></span>
      how did that feel?
    </button>`;
    }
    function todayFeedbackScaleHtml(kind, label) {
        const dots = TODAY_FEEL_FACES.map((glyph, index) => `<button class="feel-dot" data-feel="${escAttr(kind)}" data-val="${index + 1}" aria-label="${escAttr(`${label} ${index + 1}`)}">${glyph}</button>`).join("");
        return `<div class="feel-row"><span class="feel-lbl lbl">${escHtml(label)}</span><div class="feel-dots">${dots}</div></div>`;
    }
    function todayFeedbackFormHtml(session) {
        const row = session && typeof session === "object" ? session : {};
        return `<div class="checkin-form feedback-form chip-in">
      ${todayFeedbackScaleHtml("soreness", "soreness")}
      ${todayFeedbackScaleHtml("performance", "performance")}
      <input id="feedbackJoint" class="feedback-joint" type="text" autocomplete="off"
        placeholder="any joint or area? (e.g. left knee)" value="${escAttr(row.joint_pain || "")}">
      <button class="checkin-dismiss" id="feedbackDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
    }
    function todayFeedbackDoneHtml(session) {
        const row = session && typeof session === "object" ? session : {};
        const parts = [];
        if (row.soreness != null)
            parts.push(`soreness ${Number(row.soreness)}/5`);
        if (row.performance != null)
            parts.push(`performance ${Number(row.performance)}/5`);
        if (row.joint_pain && String(row.joint_pain).trim())
            parts.push(escHtml(String(row.joint_pain).trim()));
        if (!parts.length)
            return "";
        return `<div class="checkin-done feedback-done chip-in">
      <span class="checkin-done-mark" aria-hidden="true">✓</span> ${parts.join(" · ")}
      <button class="linkbtn linkbtn-plain linkbtn-sm feedback-edit" id="feedbackEdit" type="button">edit</button>
    </div>`;
    }
    function todaySkipNameHtml(name) {
        const label = String(name ?? "");
        return `<button class="skip-name" data-unskip="${encodeURIComponent(label)}" title="Restore ${escAttr(label)}">${escHtml(label)}<span class="skip-undo">↺</span></button>`;
    }
    function todaySkipLineHtml(names) {
        const rows = Array.isArray(names) ? names : [];
        return `<div class="skipline${rows.length ? "" : " skipline-empty"}" id="skipLine" aria-live="polite">
      <span class="lbl">Skipped</span>
      <span class="skipline-names">${rows.map(todaySkipNameHtml).join("")}</span>
    </div>`;
    }
    const CAIRN_TODAY_SESSION_STATUS = {
        FEEL_FACES: TODAY_FEEL_FACES,
        setChipHtml: todaySetChipHtml,
        setsTonnage: todaySetsTonnage,
        sessionDoneCardHtml: todaySessionDoneCardHtml,
        hasFeedback: todaySessionHasFeedback,
        feedbackOpenHtml: todayFeedbackOpenHtml,
        feedbackScaleHtml: todayFeedbackScaleHtml,
        feedbackFormHtml: todayFeedbackFormHtml,
        feedbackDoneHtml: todayFeedbackDoneHtml,
        skipNameHtml: todaySkipNameHtml,
        skipLineHtml: todaySkipLineHtml,
    };
    Object.assign(globalThis, {
        CairnTodaySessionStatus: CAIRN_TODAY_SESSION_STATUS,
        setsTonnage: todaySetsTonnage,
    });
    if (typeof window !== "undefined") {
        Object.assign(window, {
            CairnTodaySessionStatus: CAIRN_TODAY_SESSION_STATUS,
            setsTonnage: todaySetsTonnage,
        });
    }
})();
})();

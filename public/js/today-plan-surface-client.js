(() => {
// @ts-check
// Pure Today plan-surface markup helpers. The screen owns data flow and wiring.
(() => {
    function sessionHeadHtml(options, deps) {
        if (options.isRunDay) {
            const lead = options.cardioItems[0] || null;
            const runName = lead ? deps.cardioLabel(lead) : "Today's run";
            const runPrescription = lead ? deps.cardioPrescription(lead) : "";
            return `<div class="session-head session-head-run">
          <div class="session-head-main">
            <div class="session-kicker lbl">${options.isToday ? "TODAY · A RUN" : "A RUN"}</div>
            <h2 class="session-title">${deps.escapeHtml(runName)}${runPrescription ? `<span class="session-focus"> · ${deps.escapeHtml(runPrescription)}</span>` : ""}</h2>
          </div>
        </div>`;
        }
        const sessionName = options.day?.name ? String(options.day.name) : "Today's session";
        const sessionFocus = options.day?.focus ? String(options.day.focus) : "";
        const mixed = options.cardioItems.length > 0 || options.hasSyncedCardioToday;
        const kicker = mixed
            ? (options.isToday ? "TODAY · LIFT + RUN" : "LIFT + RUN")
            : (options.isToday ? "TODAY'S SESSION" : "SESSION");
        return `<div class="session-head">
          <div class="session-head-main">
            <div class="session-kicker lbl">${kicker}</div>
            <h2 class="session-title">${deps.escapeHtml(sessionName)}${sessionFocus ? `<span class="session-focus"> · ${deps.escapeHtml(sessionFocus)}</span>` : ""}</h2>
          </div>
          <div class="session-head-side">
            ${options.exTotal ? `<span class="session-prog" title="exercises with a logged set"><b>${options.exDone}</b><span class="session-prog-sep">/</span>${options.exTotal}</span>` : ""}
          </div>
        </div>`;
    }
    function daySwitchHtml(plan, activeDay, deps) {
        let html = `<div class="day-switch">`;
        for (const day of plan) {
            const dayNumber = Number(day.day_number);
            html += `<button class="daybtn ${dayNumber === activeDay ? "active" : ""}" data-day="${dayNumber}">${dayNumber} · ${deps.escapeHtml(day.name || "")}</button>`;
        }
        return `${html}</div><div id="tableHint"></div>`;
    }
    function rxBannerHtml(rxByEx, day, deps) {
        const moves = deps.rxMoveCount(rxByEx);
        if (moves <= 0)
            return "";
        const word = moves === 1 ? "One lift has a new target" : `${moves} lifts have new targets`;
        return `<div class="rx-banner reveal" style="${deps.stagger(0)}">
        <div class="rx-banner-text">
          <span class="rx-banner-ico" aria-hidden="true">✦</span>
          <span class="rx-banner-h">${deps.escapeHtml(word)} from what you logged</span>
        </div>
        <button class="rx-banner-apply draftbtn" id="rxApplyBtn" type="button" data-rx-day="${deps.escapeAttr(String(day))}">Apply to my plan</button>
      </div>`;
    }
    function addExerciseFormHtml() {
        return `<div class="addex">
      <button id="addExBtn" class="ghostbtn addex-btn">+ Add exercise</button>
      <div id="addExForm" class="addex-form" hidden>
        <div class="addex-row">
          <input id="addExInput" type="text" autocomplete="off" placeholder="Search or type an exercise" list="exOptions">
          <datalist id="exOptions"></datalist>
          <button id="addExGo" class="logbtn">+</button>
        </div>
        <div class="addex-mode" id="addExMode" role="group" aria-label="Exercise type">
          <button class="modebtn active" data-exmode="reps">Reps</button>
          <button class="modebtn" data-exmode="timed">Timed</button>
        </div>
      </div>
    </div>`;
    }
    function finishHtml(session, options, deps) {
        const sets = Array.isArray(session.sets) ? session.sets : [];
        const tonnage = deps.setsTonnage(sets);
        return `<div class="finish">
        <div class="finish-stat" data-finishstat>${sets.length} sets · ${Math.round(tonnage).toLocaleString()} lb ${options.isToday ? "logged today" : "on " + options.logDate}</div>
        <div id="feedbackSlot" class="feedback-slot"></div>
        <div class="logrow" style="margin-top:8px">
          <input id="sessNotes" type="text" placeholder="Session notes (optional)" value="${deps.escapeAttr(session.notes || "")}" style="text-align:left">
          <button id="finishBtn" class="logbtn" style="width:auto;padding:0 16px;font-size:.82rem;letter-spacing:.04em">FINISH</button>
        </div>
      </div>`;
    }
    const CAIRN_TODAY_PLAN_SURFACE = {
        sessionHeadHtml,
        daySwitchHtml,
        rxBannerHtml,
        addExerciseFormHtml,
        finishHtml,
    };
    Object.assign(globalThis, { CairnTodayPlanSurface: CAIRN_TODAY_PLAN_SURFACE });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayPlanSurface: CAIRN_TODAY_PLAN_SURFACE });
    }
})();
})();

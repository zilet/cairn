(() => {
// @ts-check
// Today main shell markup: Brief/capture lead, weekly fold, and focus/rail wrapper.
(() => {
    function weightChipLabel(currentWeight) {
        return currentWeight != null ? `${currentWeight}<span class="wt-mini-unit">lb</span>` : "weight";
    }
    function captureRowHtml(currentWeight, deps) {
        return `<div class="capture-row reveal" style="--i:1">
      <div class="wt-inline" id="wtInline" hidden>
        <input id="wtInlineInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (lb)">
        <button id="wtInlineGo" class="logbtn">+</button>
      </div>
      <div class="quicklog">
        <input id="qlInput" type="text" placeholder="Log a ride, run, meal, or weight…">
        <button id="qlMic" class="qlmic" type="button" hidden aria-label="Dictate" title="Say it out loud">${deps.micGlyph}</button>
        <button id="qlBtn" class="logbtn">↵</button>
        <button id="wtChipMini" class="wt-mini" title="Log bodyweight">${weightChipLabel(currentWeight)}<span class="stat-plus">+</span></button>
      </div>
    </div>`;
    }
    function leadHtml(options, deps) {
        return `${options.isToday ? "" : `<button id="backToday" class="ghostbtn back-today">← Back to today</button>`}
    <div id="ctxBanner"><div id="ctxEvents"></div><div id="ctxHealth"></div></div>
    ${options.briefHtml}
    ${options.conductorHtml ? `<div class="cfocus-slot cfocus-thread-slot" id="cfocusSlot">${options.conductorHtml}</div>` : `<div class="cfocus-slot" id="cfocusSlot"></div>`}
    <div id="goalSlot">${options.conductorLeads ? "" : options.goalLineHtml}</div>
    <div id="draftSlot" class="draft-slot"></div>
    <div id="sugSlot" class="sug-slot"></div>
    ${captureRowHtml(options.currentWeight, deps)}`;
    }
    function weekFoldHtml(compass, deps) {
        return `${compass.paceOfferHtml || ""}
    <details class="weekfold" id="weekFold">
      <summary class="weekfold-sum"><span class="lbl">This week</span>${compass.weekRecap ? `<span class="weekfold-recap">${deps.escapeHtml(compass.weekRecap)}</span>` : ""}<span class="weekfold-chev" aria-hidden="true">▾</span></summary>
      <div class="statstrip statstrip-compass">
        ${compass.cellsHtml || ""}
      </div>
      <div id="wearStrip"></div>
    </details>`;
    }
    function wrapHtml(content, options) {
        return `<div class="today-wrap"><div class="today-main">${content}</div>${options.railHtml}</div>`;
    }
    const CAIRN_TODAY_MAIN_SHELL = {
        leadHtml,
        weekFoldHtml,
        wrapHtml,
    };
    Object.assign(globalThis, { CairnTodayMainShell: CAIRN_TODAY_MAIN_SHELL });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayMainShell: CAIRN_TODAY_MAIN_SHELL });
    }
})();
})();

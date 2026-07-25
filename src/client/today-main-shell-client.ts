// @ts-check
// Today main shell markup: Brief/capture lead, weekly fold, and focus/rail wrapper.

type TodayMainShellLeadOptions = {
  isToday: boolean;
  briefHtml: string;
  conductorHtml: string;
  currentWeight: unknown;
};
type TodayMainShellCompass = {
  weekRecap?: string | null;
  cellsHtml?: string;
};
type TodayMainShellDeps = {
  escapeHtml(value: unknown): string;
};
type TodayMainShellApi = {
  leadHtml(options: TodayMainShellLeadOptions, deps: TodayMainShellDeps): string;
  weekFoldHtml(compass: TodayMainShellCompass, deps: Pick<TodayMainShellDeps, "escapeHtml">): string;
  wrapHtml(content: string, options: { railHtml: string }): string;
};

(() => {
  function weightChipLabel(currentWeight: unknown): string {
    return currentWeight != null ? `${currentWeight}<span class="wt-mini-unit">lb</span>` : "weight";
  }

  function captureRowHtml(currentWeight: unknown): string {
    return `<div class="capture-row reveal" style="--i:1">
      <div class="wt-inline" id="wtInline" hidden>
        <input id="wtInlineInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (lb)">
        <button id="wtInlineGo" class="logbtn">+</button>
      </div>
      <button id="wtChipMini" class="wt-mini" type="button" title="Log bodyweight">${weightChipLabel(currentWeight)}<span class="stat-plus">+</span></button>
    </div>`;
  }

  function leadHtml(options: TodayMainShellLeadOptions, deps: TodayMainShellDeps): string {
    return `${options.isToday ? "" : `<button id="backToday" class="ghostbtn back-today">← Back to today</button>`}
    <div id="ctxBanner"><div id="ctxEvents"></div><div id="ctxHealth"></div></div>
    ${options.briefHtml}
    ${options.conductorHtml ? `<div class="cfocus-slot cfocus-thread-slot" id="cfocusSlot">${options.conductorHtml}</div>` : `<div class="cfocus-slot" id="cfocusSlot"></div>`}
    <div id="attentionLead" class="attention-lead card-stack"></div>
    <div id="sugSlot" class="sug-slot"></div>
    ${captureRowHtml(options.currentWeight)}`;
  }

  function weekFoldHtml(compass: TodayMainShellCompass, deps: Pick<TodayMainShellDeps, "escapeHtml">): string {
    return `<details class="weekfold" id="weekFold">
      <summary class="weekfold-sum"><span class="lbl">This week</span>${compass.weekRecap ? `<span class="weekfold-recap">${deps.escapeHtml(compass.weekRecap)}</span>` : ""}<span class="weekfold-chev" aria-hidden="true">▾</span></summary>
      <div class="statstrip statstrip-compass">
        ${compass.cellsHtml || ""}
      </div>
      <div id="wearStrip"></div>
      <div id="wearBands"></div>
    </details>`;
  }

  function wrapHtml(content: string, options: { railHtml: string }): string {
    return `<div class="today-wrap"><div class="today-main">${content}</div>${options.railHtml}</div>`;
  }

  const CAIRN_TODAY_MAIN_SHELL: TodayMainShellApi = {
    leadHtml,
    weekFoldHtml,
    wrapHtml,
  };

  Object.assign(globalThis, { CairnTodayMainShell: CAIRN_TODAY_MAIN_SHELL });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayMainShell: CAIRN_TODAY_MAIN_SHELL });
  }
})();

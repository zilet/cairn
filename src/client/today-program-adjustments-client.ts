// @ts-check
// Pure Today program-adjustment rail rendering helpers.

type TodayProgramAdjustment = {
  kind?: unknown;
  title?: unknown;
  why?: unknown;
  group?: unknown;
  exercise?: unknown;
  suggestions?: unknown;
  recovering?: unknown;
  programmed?: unknown;
};

(() => {
  const TODAY_ADJUST_GLYPH: Record<string, string> = { progression: "↑", balance: "◆", deload: "↓", gap: "○" };
  const TODAY_ADJUST_COLLAPSE_AFTER = 3;

  function todayAdjustmentRow(value: unknown): TodayProgramAdjustment {
    return value && typeof value === "object" ? value as TodayProgramAdjustment : {};
  }

  function todayAdjustmentSuggestions(value: unknown): string[] {
    return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
  }

  function todayAdjustmentPlanRequest(value: unknown): string {
    const adjustment = todayAdjustmentRow(value);
    if (!adjustment || !Object.keys(adjustment).length) return "Help me adjust my plan.";
    const group = adjustment.group ? String(adjustment.group) : "";
    const suggestions = todayAdjustmentSuggestions(adjustment.suggestions);
    const suggestionLine = suggestions.length ? ` (e.g. ${suggestions.join(", ")})` : "";
    if (adjustment.recovering) {
      return `My ${group || "those muscles"} took a beating recently and ${group ? "is" : "are"} still recovering. Plan my next session around fresher muscles instead, and tell me which day to come back to ${group || "them"}.`;
    }
    switch (adjustment.kind) {
      case "gap":
        return `Add some ${group || "the missing"} work to my plan${suggestionLine}. Fit it in without adding much time, and tell me which day it goes on.`;
      case "balance":
        if (adjustment.title && /running high/i.test(String(adjustment.title))) {
          return `My ${group} volume is running high lately — rebalance some of it toward a group that's due.`;
        }
        if (adjustment.programmed) {
          return `I'm light on logged ${group} volume this week, but ${group} is already in my plan${suggestions.length ? ` (${suggestions.join(", ")})` : ""}. Help me actually get those sessions in this week — don't add more ${group} work.`;
        }
        return `I'm light on ${group} lately. Add a ${group} movement to my plan this week${suggestionLine}, and tell me which day.`;
      case "deload":
        return adjustment.exercise
          ? `Ease off ${adjustment.exercise} next session — back the load off about 10% and let it rebuild.`
          : "A deload week looks about due — plan me a lighter week.";
      case "progression":
        if (adjustment.title && /rotate/i.test(String(adjustment.title))) {
          return `Rotate ${adjustment.exercise || "this lift"} to a close variation (same movement) to break the plateau.`;
        }
        return `Apply the earned step up for ${adjustment.exercise || "this lift"} on my plan.`;
      default:
        return adjustment.title ? String(adjustment.title) : "Help me adjust my plan.";
    }
  }

  function todayProgramAdjustmentExtraCount(rows: unknown): number {
    const list = Array.isArray(rows) ? rows : [];
    return Math.max(0, list.length - TODAY_ADJUST_COLLAPSE_AFTER);
  }

  function todayProgramAdjustmentRowHtml(value: unknown, index: number): string {
    const adjustment = todayAdjustmentRow(value);
    const kind = typeof adjustment.kind === "string" ? adjustment.kind : "";
    const glyph = adjustment.recovering ? "↻" : (TODAY_ADJUST_GLYPH[kind] || "○");
    const suggestions = todayAdjustmentSuggestions(adjustment.suggestions);
    const suggestionLabel = adjustment.programmed ? "In your plan" : "Try";
    const chips = suggestions.length
      ? `<div class="adjust-sugs"><span class="adjust-sugs-lbl lbl">${suggestionLabel}</span>${suggestions
          .map((suggestion) => `<span class="adjust-chip">${escHtml(suggestion)}</span>`).join("")}</div>`
      : "";
    const action = adjustment.recovering ? "Plan around it →" : adjustment.programmed ? "Help me fit it in →" : "Plan it →";
    return `<div class="adjust-row${index >= TODAY_ADJUST_COLLAPSE_AFTER ? " adjust-extra" : ""}${adjustment.recovering ? " adjust-rec" : ""}">
        <button class="adjust-item" type="button" aria-expanded="false">
          <span class="adjust-glyph" aria-hidden="true">${glyph}</span>
          <span class="adjust-title">${escHtml(adjustment.title || "")}</span>
          <span class="adjust-chev" aria-hidden="true">⌄</span>
        </button>
        <div class="adjust-detail" hidden>
          ${adjustment.why ? `<div class="adjust-why">${escHtml(adjustment.why)}</div>` : ""}
          ${chips}
          <button class="adjust-act" type="button" data-req="${escAttr(todayAdjustmentPlanRequest(adjustment))}">${action}</button>
        </div>
      </div>`;
  }

  function todayProgramAdjustmentsBannerHtml(rows: unknown): string {
    if (!Array.isArray(rows) || !rows.length) return "";
    const items = rows.map(todayProgramAdjustmentRowHtml).join("");
    const more = todayProgramAdjustmentExtraCount(rows);
    return `<div class="adjust-card reveal" style="--i:0">
      <div class="adjust-head">
        <span class="lbl">What changed</span>
        <button class="adjust-all lbl" id="adjustAll" type="button">My plan →</button>
      </div>
      ${items}
      ${more > 0 ? `<button class="adjust-more lbl" id="adjustMore" type="button" aria-expanded="false">+${more} more in your program</button>` : ""}
    </div>`;
  }

  const CAIRN_TODAY_PROGRAM_ADJUSTMENTS = {
    ADJUST_GLYPH: TODAY_ADJUST_GLYPH,
    COLLAPSE_AFTER: TODAY_ADJUST_COLLAPSE_AFTER,
    extraCount: todayProgramAdjustmentExtraCount,
    planRequest: todayAdjustmentPlanRequest,
    rowHtml: todayProgramAdjustmentRowHtml,
    bannerHtml: todayProgramAdjustmentsBannerHtml,
  };

  Object.assign(globalThis, { CairnTodayProgramAdjustments: CAIRN_TODAY_PROGRAM_ADJUSTMENTS });

  if (typeof window !== "undefined") {
    window.CairnTodayProgramAdjustments = CAIRN_TODAY_PROGRAM_ADJUSTMENTS;
  }
})();

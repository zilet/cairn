// @ts-check
// Today main shell markup: Brief/capture lead, weekly fold, and focus/rail wrapper.
// The Brief leads (Atelier v2: the day's voice is the first thing on Today); the
// life-context banner follows it as a quiet line rather than sitting above it.

type TodayMainShellLeadOptions = {
  isToday: boolean;
  briefHtml: string;
  conductorHtml: string;
  currentWeight: unknown;
};
type TodayMainShellCompass = {
  weekRecap?: string | null;
  cellsHtml?: string;
  planned?: number;
  done?: number;
  weekKm?: number;
};
type TodayMainShellWeekOptions = {
  currentWeight?: unknown;
  /** The weight trend, lb/wk (the weekly stats' own slope). */
  trendLbWk?: unknown;
  /** Today's lift name when it is still open ("Pull"), for the lifts tally. */
  liftOpen?: unknown;
  /** The athlete runs (a km tally rather than a cardio count). */
  runs?: boolean;
  weekCardio?: unknown;
};
type TodayMainShellDeps = {
  escapeHtml(value: unknown): string;
};
type TodayMainShellApi = {
  carryBriefSlots(from: Element): (into: Element) => void;
  leadHtml(options: TodayMainShellLeadOptions, deps: TodayMainShellDeps): string;
  weekFoldHtml(
    compass: TodayMainShellCompass,
    deps: Pick<TodayMainShellDeps, "escapeHtml">,
    options?: TodayMainShellWeekOptions
  ): string;
  digestSlotHtml(): string;
  aheadSlotsHtml(): string;
  wrapHtml(content: string, options: { railHtml: string }): string;
};

(() => {
  // The capture row now carries only the quiet context-tag chips (rendered when its
  // loader has something to show; `:empty{display:none}` until then). The bodyweight
  // chip moved onto the week row (weekFoldHtml): "This week" and the weigh-in are one
  // tidy line, and the weight is said once. Food frequents live in the Chat composer.
  //
  // The morning check-in is NOT here any more. It belongs under the sentence that
  // asks how the body is, so the Brief mounts `#checkinSlot` on the rest/easy reads
  // where the question is actually being asked (today-brief-client.ts).
  function captureRowHtml(isToday: boolean): string {
    return isToday
      ? `<div class="capture-row reveal" style="--i:1"><div id="tagsSlot" class="tags-slot"></div></div>`
      : "";
  }

  function leadHtml(options: TodayMainShellLeadOptions, deps: TodayMainShellDeps): string {
    void deps;
    return `${options.briefHtml}
    <div id="ctxBanner"><div id="ctxEvents"></div><div id="ctxHealth"></div></div>
    ${options.conductorHtml ? `<div class="cfocus-slot cfocus-thread-slot" id="cfocusSlot">${options.conductorHtml}</div>` : `<div class="cfocus-slot" id="cfocusSlot"></div>`}
    <div id="attentionLead" class="card-stack"></div>
    <div id="sugSlot" class="sug-slot"></div>
    ${captureRowHtml(options.isToday)}`;
  }

  // THIS WEEK (the Today redesign): a seven-day strip of stones, three tallies (lifts
  // done of planned, kilometres, the bodyweight with its trend and a sparkline), the
  // recovery gauges, and the older detail (the compass tiles, the wearable strip)
  // folded under "More about this week". What the frame knows at paint time (the
  // weekly stats, today's lift line, the weight) is written now; the strip, the gauges,
  // the block clock, the km plan and the sparkline are filled into their own slots by
  // the today-ahead bundle (CairnTodayAhead). The bodyweight tile keeps the inline
  // capture's id, so one tap still opens the weigh-in input under the section.
  function weekFoldHtml(
    compass: TodayMainShellCompass,
    deps: Pick<TodayMainShellDeps, "escapeHtml">,
    options: TodayMainShellWeekOptions = {}
  ): string {
    const esc = deps.escapeHtml;
    const num = (value: unknown): number | null =>
      value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    const done = num(compass.done) ?? 0;
    const planned = num(compass.planned);
    const km = num(compass.weekKm) ?? 0;
    const open = String(options.liftOpen ?? "").trim();
    const lifts = `<div class="tweek-tally"><div class="tweek-n num"><span data-cu="${done}">0</span>${
      planned ? `<span class="tweek-u">/${planned}</span>` : ""
    }</div><small>lift${done === 1 && !planned ? "" : "s"}${open ? ` · ${esc(open)} open` : ""}</small></div>`;
    const cardio = num(options.weekCardio) ?? 0;
    const second =
      km > 0 || options.runs
        ? `<div class="tweek-tally"><div class="tweek-n num">${esc(String(Math.round(km * 10) / 10))}<span class="tweek-u">km</span></div><small id="tweekKmNote">this week</small></div>`
        : `<div class="tweek-tally"><div class="tweek-n num"><span data-cu="${cardio}">0</span></div><small>cardio</small></div>`;
    const weight = num(options.currentWeight);
    const trend = num(options.trendLbWk);
    const trendText = trend == null ? "log a weigh-in" : `${trend > 0 ? "+" : trend < 0 ? "−" : ""}${Math.abs(Math.round(trend * 10) / 10)}/wk`;
    const wt = `<button id="wtChipMini" class="tweek-tally tweek-wt" type="button" title="Log bodyweight" data-keep-fold><span class="tweek-n num" data-wtval>${
      weight != null ? `${esc(String(weight))}<span class="tweek-u">lb</span>` : "—"
    }</span><small>${weight != null ? `lb · ${esc(trendText)}` : "weight · tap to log"}</small><span class="tweek-spark" id="tweekSpark" aria-hidden="true"></span></button>`;
    return `<section class="tweek" id="todayWeek" aria-label="This week">
    <div class="tweek-mast"><span class="lbl">This week</span><span class="tweek-block lbl" id="tweekBlock"></span></div>
    <div id="tweekStrip" class="tweek-strip-slot"></div>
    <div class="tweek-tallies">${lifts}${second}${wt}</div>
    <div class="wt-inline" id="wtInline" hidden>
      <input id="wtInlineInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (lb)" aria-label="Bodyweight in lb">
      <button id="wtInlineGo" class="logbtn" type="button" aria-label="Log bodyweight">+</button>
    </div>
    <div id="tweekGauges" class="tweek-gauges-slot"></div>
    <details class="weekfold tweek-more" id="weekFold">
      <summary class="weekfold-sum"><span class="lbl">More about this week</span>${compass.weekRecap ? `<span class="weekfold-recap">${esc(compass.weekRecap)}</span>` : ""}<span class="weekfold-chev" aria-hidden="true">▾</span></summary>
      <div class="statstrip statstrip-compass">
        ${compass.cellsHtml || ""}
      </div>
      <div id="wearStrip"></div>
    </details>
    </section>`;
  }

  // The redesigned Today's async sections below the column's lead, each an empty slot
  // the today-ahead bundle fills (an empty one collapses): the overnight digest sits
  // before the week; Coming up and the one new connection follow it.
  function digestSlotHtml(): string {
    return `<div id="todayDigestSlot" class="tdg-slot"></div>`;
  }

  function aheadSlotsHtml(): string {
    return `<div id="todayHorizonSlot" class="thz-slot"></div><div id="todayHeadingSlot" class="thd-slot"></div>`;
  }

  // A control inside the week row's summary acts on its own, never toggling the fold.
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("summary [data-keep-fold]")) event.preventDefault();
      },
      true
    );
  }

  // The fuel glance is mounted INTO the Brief by its own controller (voice → NOW →
  // fuel). An in-place Brief swap takes the painted node out of the old element and
  // stands it in the new one, where its own controller places it, so nothing
  // repaints or replays its entrance.
  // The Path card's slot rides the same way: the painted node (its drawn trail, no
  // replay) stands in for the fresh Brief's empty one.
  function carryBriefSlots(from: Element): (into: Element) => void {
    const fuel = from.querySelector("#todayFuelSlot");
    const path = from.querySelector("#todayPathSlot");
    // "What's ahead" rides too: its node keeps its listeners and an open day stays open.
    const strip = from.querySelector("#todayStripSlot");
    return (into) => {
      const g = globalThis as {
        CairnTodayFuelGlance?: { place?(brief: Element, slot: Element): void };
      };
      try {
        if (fuel) g.CairnTodayFuelGlance?.place?.(into, fuel);
      } catch {}
      for (const [node, id] of [
        [path, "#todayPathSlot"],
        [strip, "#todayStripSlot"],
      ] as const) {
        try {
          const home = into.querySelector(id);
          if (node && home && node.innerHTML) home.replaceWith(node);
        } catch {}
      }
    };
  }

  function wrapHtml(content: string, options: { railHtml: string }): string {
    return `<div class="today-wrap"><div class="today-main">${content}</div>${options.railHtml}</div>`;
  }

  const CAIRN_TODAY_MAIN_SHELL: TodayMainShellApi = {
    carryBriefSlots,
    leadHtml,
    weekFoldHtml,
    digestSlotHtml,
    aheadSlotsHtml,
    wrapHtml,
  };

  Object.assign(globalThis, { CairnTodayMainShell: CAIRN_TODAY_MAIN_SHELL });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayMainShell: CAIRN_TODAY_MAIN_SHELL });
  }
})();

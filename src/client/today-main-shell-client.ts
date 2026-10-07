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
  /** The ONE weight-trend read's rate, already in words and units ("−0.9 lb/wk"). */
  trendWords?: string | null;
  /** The athlete runs (their distance rides the week strip's header; no cardio count here). */
  runs?: boolean;
  weekCardio?: unknown;
};
type TodayMainShellDeps = {
  escapeHtml(value: unknown): string;
};
type TodayMainShellApi = {
  carryBriefSlots(from: Element): (into: Element) => void;
  freezeSnapshot(root: ParentNode): void;
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
    // #coachLinkSlot: one quiet line ahead of the Brief while no AI coach is connected
    // (or one is, and has not said hello yet) — coach-link-client.ts fills it; empty,
    // it collapses. It leads because it is the one next step a fresh install has.
    return `${options.isToday ? `<div id="coachLinkSlot" class="clink-slot"></div>` : ""}${options.briefHtml}
    <div id="ctxBanner"><div id="ctxEvents"></div><div id="ctxHealth"></div></div>
    ${options.conductorHtml ? `<div class="cfocus-slot cfocus-thread-slot" id="cfocusSlot">${options.conductorHtml}</div>` : `<div class="cfocus-slot" id="cfocusSlot"></div>`}
    <div id="attentionLead" class="card-stack"></div>
    <div id="sugSlot" class="sug-slot"></div>
    ${captureRowHtml(options.isToday)}`;
  }

  // BODY & RECOVERY (what was "This week"): Today has ONE week view — the "What's ahead"
  // strip under the Brief, whose header line carries the week's counts (lifting days,
  // distance against the run plan, new bests) and the block clock. What stays here is
  // the body's side of the week: the bodyweight with its trend and a sparkline (and,
  // for an athlete who does not run, the week's cardio count), the recovery gauges, and
  // the older detail (the compass tiles, the wearable strip) folded under "More about
  // this week". The gauges and the sparkline are filled into their own slots by the
  // today-ahead bundle (CairnTodayAhead). The bodyweight tile keeps the inline
  // capture's id, so one tap still opens the weigh-in input under the section.
  function weekFoldHtml(
    compass: TodayMainShellCompass,
    deps: Pick<TodayMainShellDeps, "escapeHtml">,
    options: TodayMainShellWeekOptions = {}
  ): string {
    const esc = deps.escapeHtml;
    const num = (value: unknown): number | null =>
      value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    const cardio = num(options.weekCardio) ?? 0;
    const second =
      !options.runs && !((num(compass.weekKm) ?? 0) > 0) && cardio > 0
        ? `<div class="tweek-tally"><div class="tweek-n num"><span data-cu="${cardio}">0</span></div><small>cardio this week</small></div>`
        : "";
    const weight = num(options.currentWeight);
    const unit = CairnFmt.units().weight;
    const trendText = options.trendWords || "log a weigh-in";
    const wt = `<button id="wtChipMini" class="tweek-tally tweek-wt" type="button" title="Log bodyweight" data-keep-fold><span class="tweek-n num" data-wtval>${
      weight != null ? `${esc(CairnFmt.weight(weight, unit, true))}<span class="tweek-u">${unit}</span>` : "—"
    }</span><small>${weight != null ? esc(trendText) : "weight · tap to log"}</small><span class="tweek-spark" id="tweekSpark" aria-hidden="true"></span></button>`;
    return `<section class="tweek" id="todayWeek" aria-label="Body and recovery">
    <div class="tweek-mast"><span class="lbl">Body &amp; recovery</span></div>
    <div class="tweek-tallies${second ? "" : " is-one"}">${wt}${second}</div>
    <div class="wt-inline" id="wtInline" hidden>
      <input id="wtInlineInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (${unit})" aria-label="Bodyweight in ${unit}" data-unit="${unit}">
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
  // before the week; the one new connection follows it.
  function digestSlotHtml(): string {
    return `<div id="todayDigestSlot" class="tdg-slot"></div>`;
  }

  function aheadSlotsHtml(): string {
    return `<div id="todayHeadingSlot" class="thd-slot"></div>`;
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
  // The Horizon glance line's slot and "What's ahead" ride the same way, ALWAYS — painted or not.
  // Each is the node its controller mounted on: carried, it keeps its listeners, an open
  // day stays open, and a paint still in flight (a cold week read, a held snapshot copy)
  // lands on screen. Left behind when still empty, the controller painted into a
  // detached node and the fresh Brief kept an empty, never-wired slot.
  function carryBriefSlots(from: Element): (into: Element) => void {
    const fuel = from.querySelector("#todayFuelSlot");
    const path = from.querySelector("#todayPathSlot");
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
          if (node && home) home.replaceWith(node);
        } catch {}
      }
    };
  }

  // A saved first-paint snapshot of Today is markup only: a section a lazy controller
  // wires (`data-wired`: the week strip, the push offer) would paint as a live control
  // that answers nothing until the real write lands. It is frozen instead — inert and
  // busy — and the real render (or the slot hold's release) brings it back live.
  function freezeSnapshot(root: ParentNode): void {
    root.querySelectorAll("[data-wired]").forEach((el) => {
      el.setAttribute("inert", "");
      el.setAttribute("aria-busy", "true");
    });
  }

  function wrapHtml(content: string, options: { railHtml: string }): string {
    return `<div class="today-wrap"><div class="today-main">${content}</div>${options.railHtml}</div>`;
  }

  const CAIRN_TODAY_MAIN_SHELL: TodayMainShellApi = {
    carryBriefSlots,
    freezeSnapshot,
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

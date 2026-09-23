// @ts-check
// Pure Today plan-surface markup helpers. The screen owns data flow and wiring.

type TodayPlanSurfaceDay = {
  day_number?: unknown;
  name?: unknown;
  focus?: unknown;
  // A single quiet "why this session" line tying the day to the strength
  // block/endurance goal (repo/day-read.ts planDayPurpose). Absent whenever
  // the program state can't ground one — never a fallback literal.
  purpose?: unknown;
};
type TodayPlanSurfaceSession = {
  sets?: unknown[] | null;
  notes?: unknown;
};
type TodayPlanSurfaceDeps = {
  escapeHtml(value: unknown): string;
  escapeAttr(value: unknown): string;
  stagger(index?: number | null): string;
  rxMoveCount(rxByEx: Record<string, unknown>): number;
  setsTonnage(sets: unknown): number;
  // Optional: formats a last-set API row into "Last time: …" text (today-session-set-model.ts's
  // lastSetLineText). Optional so existing planSurface() deps callers keep typechecking
  // until this is wired in; lastSetLineHtml renders "" without it.
  lastSetLineText?(lastSet: unknown): string;
};
type TodayPlanSurfaceApi = {
  sessionHeadHtml(options: {
    isRunDay: boolean;
    isToday: boolean;
    day: TodayPlanSurfaceDay | null | undefined;
    exDone: number;
    exTotal: number;
    hasSyncedCardioToday: boolean;
  }, deps: TodayPlanSurfaceDeps): string;
  daySwitchHtml(
    plan: TodayPlanSurfaceDay[],
    activeDay: unknown,
    deps: Pick<TodayPlanSurfaceDeps, "escapeHtml">,
    recovery?: Record<number, { recovering_groups?: string[]; mostly_recovering?: boolean }> | null,
  ): string;
  rxBannerHtml(rxByEx: Record<string, unknown>, day: unknown, deps: Pick<TodayPlanSurfaceDeps, "escapeAttr" | "escapeHtml" | "rxMoveCount" | "stagger">): string;
  addExerciseFormHtml(): string;
  finishHtml(session: TodayPlanSurfaceSession, options: { isToday: boolean; logDate: string }, deps: Pick<TodayPlanSurfaceDeps, "escapeAttr" | "setsTonnage">): string;
  lastSetLineHtml(lastSet: unknown, deps: Pick<TodayPlanSurfaceDeps, "escapeHtml" | "lastSetLineText">): string;
  runLineHtml(
    agenda: unknown,
    options: { date: string; units?: "km" | "mi"; syncLine?: string },
    deps: TodayRunLineDeps,
  ): string;
};
type TodayRunLineDeps = Pick<TodayPlanSurfaceDeps, "escapeHtml"> & {
  formatDistance?(km: unknown, units?: unknown): string;
};

(() => {
  function sessionHeadHtml(
    options: {
      isRunDay: boolean;
      isToday: boolean;
      day: TodayPlanSurfaceDay | null | undefined;
      exDone: number;
      exTotal: number;
      hasSyncedCardioToday: boolean;
    },
    deps: TodayPlanSurfaceDeps,
  ): string {
    // A synced run already in on a day that holds no lift. The run itself is never
    // a line item here — its prescription lives on the agenda and in Plan ->
    // Endurance — so the head only names what the day already was.
    if (options.isRunDay) {
      return `<div class="session-head session-head-run">
          <div class="session-head-main">
            <div class="session-kicker lbl">${options.isToday ? "TODAY · A RUN" : "A RUN"}</div>
            <h2 class="session-title">${deps.escapeHtml("Today's run")}</h2>
          </div>
        </div>`;
    }

    const sessionName = options.day?.name ? String(options.day.name) : "Today's session";
    const sessionFocus = options.day?.focus ? String(options.day.focus) : "";
    const sessionPurpose = options.day?.purpose ? String(options.day.purpose) : "";
    // A run synced today beside the lift still reads as a hybrid day in the kicker
    // (a cross-reference, not a card): the lift list below stays lifts only.
    const mixed = options.hasSyncedCardioToday;
    const kicker = mixed
      ? (options.isToday ? "TODAY · LIFT + RUN" : "LIFT + RUN")
      : (options.isToday ? "TODAY'S SESSION" : "SESSION");
    return `<div class="session-head">
          <div class="session-head-main">
            <div class="session-kicker lbl">${kicker}</div>
            <h2 class="session-title">${deps.escapeHtml(sessionName)}${sessionFocus ? `<span class="session-focus"> · ${deps.escapeHtml(sessionFocus)}</span>` : ""}</h2>
            ${sessionPurpose ? `<p class="session-purpose">${deps.escapeHtml(sessionPurpose)}</p>` : ""}
          </div>
          <div class="session-head-side">
            ${options.exTotal ? `<span class="session-prog" title="exercises with a logged set"><b>${options.exDone}</b><span class="session-prog-sep">/</span>${options.exTotal}</span>` : ""}
          </div>
        </div>`;
  }

  // Lower-body groups read as one word to an athlete. "quads and hamstrings
  // recovering" is an inventory; "legs recovering" is the thing they need to know
  // before they tap the pill.
  const LEG_GROUPS = ["quads", "hamstrings", "glutes", "calves"];

  function recoveringCaption(groups: string[] | null | undefined): string {
    const names = (Array.isArray(groups) ? groups : []).map((group) => String(group).toLowerCase()).filter(Boolean);
    if (!names.length) return "";
    if (names.every((group) => LEG_GROUPS.includes(group))) return "legs recovering";
    const words = names.map((group) => (group === "rear delts" ? "rear shoulders" : group)).slice(0, 2);
    return `${words.length === 2 ? `${words[0]} and ${words[1]}` : words[0]} recovering`;
  }

  // The day pills offer lift days only. A rest day or a run-only day an older plan
  // payload still carries is not a session to switch into — runs live in Plan ->
  // Endurance. An empty training day stays: it is the athlete's own scaffold.
  function isLiftPill(day: TodayPlanSurfaceDay): boolean {
    const row = day as TodayPlanSurfaceDay & { day_type?: unknown; items?: unknown };
    if (String(row.day_type ?? "training") === "rest") return false;
    const items: unknown[] = Array.isArray(row.items) ? row.items : [];
    return !items.length || items.some((item) => !(item && typeof item === "object" && (item as { kind?: unknown }).kind === "cardio"));
  }

  // A hint, never a gate (VISION §2.1 — the wheel is always the athlete's). The
  // pill stays fully tappable; it just says what it is offering, so a leg day the
  // morning after a hard run does not have to be discovered by tapping it.
  function daySwitchHtml(
    plan: TodayPlanSurfaceDay[],
    activeDay: unknown,
    deps: Pick<TodayPlanSurfaceDeps, "escapeHtml">,
    recovery?: Record<number, { recovering_groups?: string[]; mostly_recovering?: boolean }> | null,
  ): string {
    let html = `<div class="day-switch">`;
    for (const day of plan.filter(isLiftPill)) {
      const dayNumber = Number(day.day_number);
      const read = recovery ? recovery[dayNumber] : null;
      const caption = read && read.mostly_recovering ? recoveringCaption(read.recovering_groups) : "";
      const classes = `daybtn${dayNumber === activeDay ? " active" : ""}${caption ? " recovering" : ""}`;
      html += `<button class="${classes}" data-day="${dayNumber}">${dayNumber} · ${deps.escapeHtml(day.name || "")}${caption ? `<span class="daybtn-cap">${deps.escapeHtml(caption)}</span>` : ""}</button>`;
    }
    return `${html}</div><div id="tableHint"></div>`;
  }

  function rxBannerHtml(
    rxByEx: Record<string, unknown>,
    day: unknown,
    deps: Pick<TodayPlanSurfaceDeps, "escapeAttr" | "escapeHtml" | "rxMoveCount" | "stagger">,
  ): string {
    const moves = deps.rxMoveCount(rxByEx);
    if (moves <= 0) return "";
    const word = moves === 1 ? "One lift has a new target" : `${moves} lifts have new targets`;
    return `<div class="rx-banner reveal" style="${deps.stagger(0)}">
        <div class="rx-banner-text">
          <span class="rx-banner-ico" aria-hidden="true">✦</span>
          <span class="rx-banner-h">${deps.escapeHtml(word)} from what you logged</span>
        </div>
        <button class="rx-banner-apply draftbtn" id="rxApplyBtn" type="button" data-rx-day="${deps.escapeAttr(String(day))}">Apply to my plan</button>
      </div>`;
  }

  function addExerciseFormHtml(): string {
    return `<div class="addex">
      <button id="addExBtn" class="ghostbtn addex-btn">+ Add exercise</button>
      <div id="addExForm" class="addex-form" hidden>
        <div class="addex-row">
          <label for="addExInput" class="sr-only">Exercise name</label>
          <input id="addExInput" type="text" autocomplete="off" placeholder="Search or type an exercise" list="exOptions">
          <datalist id="exOptions"></datalist>
          <button id="addExGo" class="logbtn" aria-label="Add exercise">+</button>
          <button id="addExCancel" class="ghostbtn addex-cancel" type="button">Cancel</button>
        </div>
        <div class="addex-mode" id="addExMode" role="group" aria-label="Exercise type">
          <button class="modebtn active" data-exmode="reps">Reps</button>
          <button class="modebtn" data-exmode="timed">Timed</button>
        </div>
      </div>
    </div>`;
  }

  function finishHtml(
    session: TodayPlanSurfaceSession,
    options: { isToday: boolean; logDate: string },
    deps: Pick<TodayPlanSurfaceDeps, "escapeAttr" | "setsTonnage">,
  ): string {
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

  // The quiet "Last time: 165 × 10" target line for a not-yet-logged exercise row (empty
  // string, i.e. nothing rendered, when there's no last-set data or the dep isn't wired).
  // The live "That beats last time" swap is handled by today-session-set-model.ts's
  // wireLastSetLine, which looks this element up by its .ex-lastset class.
  function lastSetLineHtml(
    lastSet: unknown,
    deps: Pick<TodayPlanSurfaceDeps, "escapeHtml" | "lastSetLineText">,
  ): string {
    const text = deps.lastSetLineText ? deps.lastSetLineText(lastSet) : "";
    if (!text) return "";
    return `<div class="ex-lastset">${deps.escapeHtml(text)}</div>`;
  }

  // Today's run, OUTSIDE the lift list. A run is never a plan item any more — the
  // rolling agenda (GET /training-agenda, the same read Plan -> Endurance shows)
  // owns it — so this is one quiet line under the lift card, and only for a run
  // the agenda has actually opened for today. A run already done says itself in
  // the Brief's strength line ("Run in · …"); a run suggested for another day
  // stays in the week strip and in Endurance. Nothing to say renders nothing.
  function runLineHtml(
    agenda: unknown,
    options: { date: string; units?: "km" | "mi"; syncLine?: string },
    deps: TodayRunLineDeps,
  ): string {
    const read = agenda && typeof agenda === "object" ? (agenda as Record<string, unknown>) : null;
    if (!read || read.available === false || !Array.isArray(read.intents)) return "";
    const today = String(options.date || "").slice(0, 10);
    const intent = (read.intents as Array<Record<string, unknown> | null>).find(
      (row) => !!row && row.status === "open" && String(row.suggested_date || "").slice(0, 10) === today,
    );
    if (!intent) return "";
    const kind = intent.kind === "quality" ? "quality" : intent.kind === "long" ? "long" : "easy";
    const kindWord = kind === "quality" ? "Quality" : kind === "long" ? "Long" : "Easy";
    const label = String(intent.label || "").trim() || `${kindWord} run`;
    const dose: string[] = [];
    const km = Number(intent.target_distance_km);
    const min = Number(intent.target_duration_min);
    if (intent.target_distance_km != null && Number.isFinite(km) && km > 0) {
      dose.push(deps.formatDistance ? deps.formatDistance(km, options.units) : `${Number.isInteger(km) ? km : km.toFixed(1)} km`);
    } else if (intent.target_duration_min != null && Number.isFinite(min) && min > 0) {
      dose.push(`${Math.round(min)} min`);
    }
    if (intent.target_zone) dose.push(String(intent.target_zone));
    // This morning's call on a quality or long run, in its own words (the server
    // decided it — kind, label and dose above already carry the answer).
    const adjustment = intent.adjustment && typeof intent.adjustment === "object"
      ? (intent.adjustment as Record<string, unknown>)
      : null;
    const why = adjustment ? String(adjustment.why || "").trim() : "";
    return `<div class="today-run-line reveal" style="--i:3;margin-top:10px" data-today-run>
        <div class="wrun-row wrun-${kind}">
          <div class="wrun-row-head">
            <span class="wrun-kind">${deps.escapeHtml(`Today · ${kindWord}`)}</span>
            <span class="wrun-label">${deps.escapeHtml(label)}</span>
          </div>
          ${dose.length ? `<div class="wrun-pres">${deps.escapeHtml(dose.join(" · "))}</div>` : ""}
          ${why ? `<div class="wrun-note" data-today-run-why>${deps.escapeHtml(why)}</div>` : ""}
          <div class="wrun-note"><button class="linkbtn linkbtn-plain linkbtn-sm" type="button" data-today-run-go>This week's runs, in Endurance →</button></div>
        </div>
        ${options.syncLine || ""}
      </div>`;
  }

  const CAIRN_TODAY_PLAN_SURFACE: TodayPlanSurfaceApi = {
    sessionHeadHtml,
    daySwitchHtml,
    rxBannerHtml,
    addExerciseFormHtml,
    finishHtml,
    lastSetLineHtml,
    runLineHtml,
  };

  Object.assign(globalThis, { CairnTodayPlanSurface: CAIRN_TODAY_PLAN_SURFACE });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSurface: CAIRN_TODAY_PLAN_SURFACE });
  }
})();

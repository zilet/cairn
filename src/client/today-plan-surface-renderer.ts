// @ts-check
// Today plan/logging surface renderer: done card, session surface, card ordering,
// pending off-plan cards, finish affordance, and skipped line.

type TodayPlanSurfaceRendererRecord = Record<string, unknown>;
type TodayPlanSurfaceRendererItem = TodayPlanSurfaceRendererRecord & {
  exercise?: unknown;
  fromPlan?: unknown;
  fromSession?: unknown;
};
type TodayPlanSurfaceRendererJourney = import("../contracts/client-api.js").ClientStrengthJourney;
type TodayPlanSurfaceRendererPendingOffPlan = {
  name: string;
  mode?: string | null;
};
type TodayPlanSurfaceRendererPrefill = {
  weight?: unknown;
  reps?: unknown;
  rir?: unknown;
  duration_sec?: unknown;
};
type TodayPlanSurfaceRendererLastSet = TodayPlanSurfaceRendererRecord & {
  weight?: unknown;
  reps?: unknown;
  rir?: unknown;
  duration_sec?: unknown;
};
type TodayPlanSurfaceRendererOptions = {
  showDone: boolean;
  showPlan: boolean;
  focus: boolean;
  session: TodayPlanSurfaceRendererRecord | null | undefined;
  day: TodayPlanSurfaceRendererRecord;
  isToday: boolean;
  plan: TodayPlanSurfaceRendererRecord[];
  activeDay: unknown;
  logDate: string;
  cardioItems: TodayPlanSurfaceRendererItem[];
  strengthItems: TodayPlanSurfaceRendererItem[];
  activeItems: TodayPlanSurfaceRendererItem[];
  skippedItems: TodayPlanSurfaceRendererItem[];
  matchedCardio: Map<TodayPlanSurfaceRendererItem, unknown>;
  syncedLine: string;
  loggedByEx: Record<string, unknown[]>;
  offPlanEx: string[];
  pendingOffPlan: TodayPlanSurfaceRendererPendingOffPlan[];
  lastSets: Record<string, TodayPlanSurfaceRendererLastSet | null | undefined>;
  rxByEx: Record<string, unknown>;
  strengthJourney: TodayPlanSurfaceRendererJourney | null;
  exDone: number;
  exTotal: number;
  hasSyncedCardioToday: boolean;
  hasLoggedSets: boolean;
  hasGarmin: boolean;
  isRunDay: boolean;
  preserveItemOrder?: boolean;
  prefillFor(item: TodayPlanSurfaceRendererItem): TodayPlanSurfaceRendererPrefill;
  rxFor(name: unknown): unknown;
};
type TodayPlanSurfaceRendererDeps = {
  planSurface: Window["CairnTodayPlanSurface"];
  planSurfaceDeps(): Parameters<Window["CairnTodayPlanSurface"]["sessionHeadHtml"]>[1];
  isCardioItem(item: TodayPlanSurfaceRendererItem): boolean;
  cardioLabel(item: TodayPlanSurfaceRendererItem): string;
  cardioPlanCard(item: TodayPlanSurfaceRendererItem, index: number, matched?: unknown, syncLine?: string): string;
  exCard(
    item: TodayPlanSurfaceRendererItem,
    logged: unknown[],
    prefill: TodayPlanSurfaceRendererPrefill,
    index: number,
    rx: unknown,
    lastSet?: unknown,
  ): string;
  garminSessionCard(value: unknown): string;
  sessionDoneCard(session: unknown, day: unknown, options: { isToday: boolean }): string;
  skipLineHtml(labels: string[]): string;
};
type TodayPlanSurfaceRendererApi = {
  buildHtml(options: TodayPlanSurfaceRendererOptions, deps: TodayPlanSurfaceRendererDeps): string;
};

(() => {
  // Stored item notes fossilize: a session eased as a whole leaves every single
  // card repeating the same sentence. Say it once above the cards and let each
  // card keep only what is its own. Render-side only — the rows are repaired
  // separately and this must not wait for that.
  const EASED_PREFIX = /^eased for today[\s.,:;·—–-]*/i;
  const SESSION_EASED_LINES = [
    "Eased for today — every movement sits a notch lighter.",
    "The whole session is eased today; each lift is set a notch lighter.",
    "Everything below is eased for today.",
    "Lighter across the board today — that's deliberate.",
  ];

  // Deterministic per date (the pickDayVariant rotation, client side) so the line
  // is stable all day and does not read as the same sentence every morning.
  function sessionEasedLine(logDate: string): string {
    const ms = Date.parse(`${String(logDate ?? "").slice(0, 10)}T00:00:00Z`);
    const dayIndex = Number.isFinite(ms) ? Math.floor(ms / 864e5) : 0;
    const span = SESSION_EASED_LINES.length;
    return SESSION_EASED_LINES[((dayIndex % span) + span) % span];
  }

  function easedNote(item: TodayPlanSurfaceRendererItem): boolean {
    return EASED_PREFIX.test(String(item.note ?? "").trim());
  }

  function withoutEasedPrefix(note: unknown): string {
    return String(note ?? "").trim().replace(EASED_PREFIX, "").trim();
  }

  function sameJourneyExercise(left: unknown, right: unknown): boolean {
    return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
  }

  function journeyItem(
    item: TodayPlanSurfaceRendererItem,
    day: TodayPlanSurfaceRendererRecord,
    journey: TodayPlanSurfaceRendererJourney | null,
  ): TodayPlanSurfaceRendererItem {
    const exercise = String(item.exercise || "");
    const objective = journey?.available ? journey.objective : null;
    if (!objective?.exercise || !exercise) return item;
    if (sameJourneyExercise(exercise, objective.exercise)) {
      const current = journey?.current;
      const gap = journey?.gap_lb;
      const line = objective.status === "completed"
        ? "Anchor milestone complete — keep this lift steady and consolidate it."
        : journey?.phase === "protecting"
          ? "Anchor lift — hold or ease today; the relevant safety signal takes priority."
          : current
            ? `Anchor lift — ${Number(current.est_1rm).toFixed(1)} lb estimated 1RM on ${current.date}${Number(gap) > 0 ? ` · ${Number(gap).toFixed(1)} lb to target` : ""}.`
            : "Anchor lift — establish one clean exact-lift checkpoint today.";
      return { ...item, journey_role: "anchor", journey_line: line };
    }
    const dayNumber = Number(day.day_number);
    const support = (Array.isArray(journey?.planned_support) ? journey.planned_support : []).find((entry) =>
      sameJourneyExercise(entry.exercise, exercise) && Number(entry.plan_day_number) === dayNumber
    );
    return support
      ? { ...item, journey_role: "support", journey_line: `${support.role} for ${objective.exercise} — ${support.why}` }
      : item;
  }

  function orderedSurfaceItems(options: TodayPlanSurfaceRendererOptions, deps: TodayPlanSurfaceRendererDeps): TodayPlanSurfaceRendererItem[] {
    if (options.preserveItemOrder) return options.activeItems;
    if (options.isRunDay || options.cardioItems.length > 1 || (options.cardioItems.length && options.strengthItems.length)) {
      return [
        ...options.activeItems.filter(deps.isCardioItem),
        ...options.activeItems.filter((item) => !deps.isCardioItem(item)),
      ];
    }
    return options.activeItems;
  }

  function pendingPrefill(last: TodayPlanSurfaceRendererLastSet | null | undefined): TodayPlanSurfaceRendererPrefill {
    if (!last) return { weight: null, reps: null, rir: null, duration_sec: null };
    return {
      weight: last.weight,
      reps: last.reps,
      rir: last.rir,
      duration_sec: last.duration_sec ?? null,
    };
  }

  function buildHtml(options: TodayPlanSurfaceRendererOptions, deps: TodayPlanSurfaceRendererDeps): string {
    if (options.showDone) {
      return deps.sessionDoneCard(options.session, options.day, { isToday: options.isToday });
    }
    if (!options.showPlan) return "";

    const surfaceDeps = deps.planSurfaceDeps();
    let html = `<div class="plansurface reveal" style="--i:2">`;

    if (!options.focus) {
      html += deps.planSurface.sessionHeadHtml({
        isRunDay: options.isRunDay,
        isToday: options.isToday,
        cardioItems: options.cardioItems,
        day: options.day,
        exDone: options.exDone,
        exTotal: options.exTotal,
        hasSyncedCardioToday: options.hasSyncedCardioToday,
      }, surfaceDeps);
    }

    html += deps.planSurface.daySwitchHtml(options.plan, options.activeDay, surfaceDeps);
    html += deps.planSurface.rxBannerHtml(options.rxByEx, options.activeDay, surfaceDeps);

    const garmin = options.session && typeof options.session === "object" ? options.session.garmin : null;
    if (options.hasGarmin) html += deps.garminSessionCard(garmin);

    const surfaceItems = orderedSurfaceItems(options, deps);
    const easedItems = surfaceItems.filter((item) => !deps.isCardioItem(item));
    // One card saying it is eased is its own fact; every card saying it is the
    // session's fact, and belongs above them once.
    const easedSession = easedItems.length > 1 && easedItems.every(easedNote);
    if (easedSession) {
      html += `<div class="session-eased sess-line">${surfaceDeps.escapeHtml(sessionEasedLine(options.logDate))}</div>`;
    }

    let cardIdx = 0;
    let syncLineUsed = false;
    for (const item of surfaceItems) {
      if (deps.isCardioItem(item)) {
        const matched = options.matchedCardio.get(item) || null;
        const line = (!matched && !syncLineUsed) ? options.syncedLine : "";
        if (line) syncLineUsed = true;
        html += deps.cardioPlanCard(item, cardIdx++, matched, line);
        continue;
      }
      const exerciseName = String(item.exercise || "");
      const carded = journeyItem(item, options.day, options.strengthJourney);
      html += deps.exCard(
        {
          ...carded,
          ...(easedSession ? { note: withoutEasedPrefix(carded.note) } : {}),
          fromPlan: item.fromPlan !== false,
          fromSession: item.fromSession === true,
        },
        options.loggedByEx[exerciseName] || [],
        options.prefillFor(item),
        cardIdx++,
        options.rxFor(exerciseName),
        options.lastSets[exerciseName],
      );
    }

    for (const exercise of options.offPlanEx) {
      const logged = options.loggedByEx[exercise] || [];
      const latest = logged[logged.length - 1] as TodayPlanSurfaceRendererLastSet | undefined;
      html += deps.exCard(
        { exercise, fromPlan: false },
        logged,
        { weight: latest?.weight, reps: latest?.reps, rir: latest?.rir },
        cardIdx++,
        options.rxFor(exercise),
      );
    }

    for (const pending of options.pendingOffPlan) {
      html += deps.exCard(
        { exercise: pending.name, fromPlan: false, mode: pending.mode || null },
        [],
        pendingPrefill(options.lastSets[pending.name]),
        cardIdx++,
        options.rxFor(pending.name),
        options.lastSets[pending.name],
      );
    }

    html += deps.planSurface.addExerciseFormHtml();
    if (options.hasLoggedSets) {
      html += deps.planSurface.finishHtml(
        options.session || {},
        { isToday: options.isToday, logDate: options.logDate },
        surfaceDeps,
      );
    }

    html += deps.skipLineHtml(options.skippedItems.map((item) => (
      deps.isCardioItem(item) ? deps.cardioLabel(item) : String(item.exercise || "")
    )));
    html += `</div>`;
    return html;
  }

  const CAIRN_TODAY_PLAN_SURFACE_RENDERER: TodayPlanSurfaceRendererApi = {
    buildHtml,
  };

  Object.assign(globalThis, { CairnTodayPlanSurfaceRenderer: CAIRN_TODAY_PLAN_SURFACE_RENDERER });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSurfaceRenderer: CAIRN_TODAY_PLAN_SURFACE_RENDERER });
  }
})();

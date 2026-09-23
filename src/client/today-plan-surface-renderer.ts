// @ts-check
// Today plan/logging surface renderer: done card, session surface (lifts only),
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
type TodayPlanSurfaceRendererAttribution = {
  key: string;
  exercise: string;
  sets: unknown[];
  siblings: number;
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
  strengthItems: TodayPlanSurfaceRendererItem[];
  activeItems: TodayPlanSurfaceRendererItem[];
  skippedItems: TodayPlanSurfaceRendererItem[];
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
  // Per-plan-day acute-recovery read, keyed by day_number, for the day pills.
  // Optional: a render without it simply shows no hint.
  planDayRecovery?: Record<number, { recovering_groups?: string[]; mostly_recovering?: boolean }> | null;
  // The envelope's first rationale entry, when the caller already holds it. Optional:
  // the renderer also reads it off the composition on the session.
  capRationale?: unknown;
  prefillFor(item: TodayPlanSurfaceRendererItem): TodayPlanSurfaceRendererPrefill;
  attributionFor?(item: TodayPlanSurfaceRendererItem): TodayPlanSurfaceRendererAttribution | null;
  rxFor(name: unknown): unknown;
};
type TodayPlanSurfaceRendererDeps = {
  planSurface: Window["CairnTodayPlanSurface"];
  planSurfaceDeps(): Parameters<Window["CairnTodayPlanSurface"]["sessionHeadHtml"]>[1];
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

  // The envelope's own athlete-facing sentence for why today's session is shaped the
  // way it is — the FIRST rationale entry, which the server keeps as the day's read
  // (`daily-decision.ts` orders it that way deliberately). A capped day used to
  // render as a shorter plan with fewer sets and no reason at all; this is that
  // reason, once, under the day header.
  //
  // Read from wherever the envelope reaches this surface, in order of specificity,
  // because the entry rides on the composition the server hands back. Absent
  // everywhere — an older server, a day with nothing to explain — renders NOTHING;
  // an empty line is worse than none.
  function envelopeRationaleText(options: TodayPlanSurfaceRendererOptions): string {
    const first = (value: unknown): string => {
      const list = Array.isArray(value) ? value : [];
      const head = list[0];
      if (typeof head === "string") return head.trim();
      if (head && typeof head === "object") return String((head as { text?: unknown }).text ?? "").trim();
      return "";
    };
    const session = options.session && typeof options.session === "object" ? options.session : null;
    const composition =
      session && session.daily_session && typeof session.daily_session === "object"
        ? (session.daily_session as Record<string, unknown>)
        : null;
    const day = options.day && typeof options.day === "object" ? (options.day as Record<string, unknown>) : null;
    const candidates = [options.capRationale, composition?.rationale, day?.rationale];
    for (const candidate of candidates) {
      const text = typeof candidate === "string" ? candidate.trim() : first(candidate);
      if (text) return text.slice(0, 240);
    }
    return "";
  }

  function easedNote(item: TodayPlanSurfaceRendererItem): boolean {
    return EASED_PREFIX.test(String(item.note ?? "").trim());
  }

  function withoutEasedPrefix(note: unknown): string {
    return String(note ?? "").trim().replace(EASED_PREFIX, "").trim();
  }

  // The distinct decision-level narrations across the session's cards, in card order.
  // Normally exactly one; a session touched by several decisions keeps every one of
  // them. A cap here silently dropped a change the athlete's session actually carries
  // — and the deduped set is small by construction, one line per decision.
  // Undo lives here: one decision, one tap — not copied onto every lift.
  function sessionBrainLines(items: TodayPlanSurfaceRendererItem[]): Array<{
    summary: string;
    decision_id: unknown;
    reversible: boolean;
  }> {
    const out: Array<{ summary: string; decision_id: unknown; reversible: boolean }> = [];
    for (const item of items) {
      if (item.brain_decision_id == null) continue;
      const summary = String(item.brain_change_summary ?? "").replace(/\s+/g, " ").trim() || "Cairn adjusted this session.";
      const existing = out.find((row) => row.summary === summary);
      if (existing) {
        if (item.brain_change_reversible === true) existing.reversible = true;
        continue;
      }
      out.push({
        summary,
        decision_id: item.brain_decision_id,
        reversible: item.brain_change_reversible === true,
      });
    }
    return out;
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

  // The lift list is lifts only. A run is never a card here (it lives on the
  // agenda: Today's run line and Plan -> Endurance), and a cardio item an older
  // payload still carries is dropped rather than drawn.
  function surfaceItemsOf(options: TodayPlanSurfaceRendererOptions): TodayPlanSurfaceRendererItem[] {
    return options.activeItems.filter((item) => item.kind !== "cardio");
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
        day: options.day,
        exDone: options.exDone,
        exTotal: options.exTotal,
        hasSyncedCardioToday: options.hasSyncedCardioToday,
      }, surfaceDeps);
      const capLine = envelopeRationaleText(options);
      if (capLine) {
        html += `<div class="session-cap sess-line">${surfaceDeps.escapeHtml(capLine)}</div>`;
      }
    }

    html += deps.planSurface.daySwitchHtml(
      options.plan,
      options.activeDay,
      surfaceDeps,
      options.planDayRecovery ?? null,
    );
    html += deps.planSurface.rxBannerHtml(options.rxByEx, options.activeDay, surfaceDeps);

    const garmin = options.session && typeof options.session === "object" ? options.session.garmin : null;
    if (options.hasGarmin) html += deps.garminSessionCard(garmin);

    const surfaceItems = surfaceItemsOf(options);
    // One card saying it is eased is its own fact; every card saying it is the
    // session's fact, and belongs above them once.
    const easedSession = surfaceItems.length > 1 && surfaceItems.every(easedNote);
    if (easedSession) {
      html += `<div class="session-eased sess-line">${surfaceDeps.escapeHtml(sessionEasedLine(options.logDate))}</div>`;
    }

    // Same rule for the brain's own narration. `brain_change_summary` describes the
    // DECISION, not the movement, and the server copies it onto every changed
    // exercise — so it belongs above the cards, once, with one Undo.
    for (const line of sessionBrainLines(surfaceItems)) {
      const undo =
        line.reversible && line.decision_id != null
          ? ` <button class="linkbtn-quiet" type="button" data-decision-undo="${surfaceDeps.escapeHtml(String(line.decision_id))}">Undo</button>`
          : "";
      html += `<div class="session-brain sess-line">${surfaceDeps.escapeHtml(line.summary)}${undo}</div>`;
    }

    let cardIdx = 0;
    for (const item of surfaceItems) {
      const exerciseName = String(item.exercise || "");
      const carded = journeyItem(item, options.day, options.strengthJourney);
      // The card, not the exercise name, owns its sets: a peak day renders the same
      // lift twice and the attribution says which logged sets belong to which card.
      // With one card per exercise the attribution IS the whole pile, so this stays
      // exactly what it was.
      const attributed = options.attributionFor ? options.attributionFor(item) : null;
      const cardSets = attributed ? attributed.sets : options.loggedByEx[exerciseName] || [];
      html += deps.exCard(
        {
          ...carded,
          ...(easedSession ? { note: withoutEasedPrefix(carded.note) } : {}),
          fromPlan: item.fromPlan !== false,
          fromSession: item.fromSession === true,
          ...(attributed && attributed.siblings > 1
            ? {
                cardKey: attributed.key,
                exerciseLogged: (options.loggedByEx[exerciseName] || []).length,
              }
            : {}),
        },
        cardSets,
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

    html += deps.skipLineHtml(
      options.skippedItems.filter((item) => item.kind !== "cardio").map((item) => String(item.exercise || "")),
    );
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

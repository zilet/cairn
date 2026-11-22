// @ts-check
// Strength-journey cue for a Today session card: marks the objective's own lift as
// the anchor, and a planned support lift (for this plan day) with its role and why.
// Split out of the plan surface renderer, which only decides WHEN a card is drawn.

type TodaySessionJourneyApi = {
  journeyItem(
    item: TodayPlanSurfaceRendererItem,
    day: TodayPlanSurfaceRendererRecord,
    journey: TodayPlanSurfaceRendererJourney | null
  ): TodayPlanSurfaceRendererItem;
  repsWords(journey: Partial<TodayPlanSurfaceRendererJourney> | null | undefined): StrengthRepsWords | null;
};

// A bodyweight lift's REPS goal in words (the server's `journey.reps`, strength-reps.ts):
// the Today anchor line and Train's anchor card read these instead of est-1RM pounds.
type StrengthRepsWords = { current: string; date: string | null; target: string; gap: string; route: string };

(() => {
  function sameJourneyExercise(left: unknown, right: unknown): boolean {
    return (
      String(left || "")
        .trim()
        .toLowerCase() ===
      String(right || "")
        .trim()
        .toLowerCase()
    );
  }

  function repsWords(journey: Partial<TodayPlanSurfaceRendererJourney> | null | undefined): StrengthRepsWords | null {
    const reps = journey?.reps;
    if (!reps) return null;
    const now = reps.now ?? reps.latest;
    const assist = now && now.value === 0 && now.assist_lb != null ? Number(now.assist_lb) : null;
    const from = reps.start_assist_lb != null && assist != null && reps.start_assist_lb > assist ? reps.start_assist_lb : null;
    // The athlete's own unit (ui-format's CairnFmt.weight); a harness without it keeps pounds.
    const load = (lb: number, bare = false) => (typeof CairnFmt === "object" ? CairnFmt.weight(lb, undefined, bare) : bare ? String(lb) : `${lb} lb`);
    const assistText = assist != null ? `${load(assist)} of assist${from != null ? `, down from ${load(from, true)}` : ""}` : "";
    const left = now ? Math.max(0, reps.goal_value - now.value) : null;
    return {
      current: now ? `Best ${now.text} at bodyweight${assistText ? ` · ${assistText}` : ""}` : "No set at bodyweight logged yet",
      date: now?.date ? String(now.date) : null,
      target: `${reps.goal_text} at bodyweight`,
      gap:
        left == null
          ? "no exposure logged yet"
          : left === 0
            ? "at the target"
            : assistText || `${left} ${left === 1 ? "rep" : "reps"} to go`,
      route: now ? `${now.text} → ${reps.goal_text}` : `${reps.goal_text} goal`,
    };
  }

  function journeyItem(
    item: TodayPlanSurfaceRendererItem,
    day: TodayPlanSurfaceRendererRecord,
    journey: TodayPlanSurfaceRendererJourney | null
  ): TodayPlanSurfaceRendererItem {
    const exercise = String(item.exercise || "");
    const objective = journey?.available ? journey.objective : null;
    if (!objective?.exercise || !exercise) return item;
    // A goal carried through a plan swap is anchored on the lift now trained.
    if (sameJourneyExercise(exercise, journey?.tracked?.exercise || objective.exercise)) {
      const current = journey?.current;
      const reps = repsWords(journey);
      const gap = journey?.gap_lb;
      const line =
        objective.status === "completed"
          ? "Anchor milestone complete — keep this lift steady and consolidate it."
          : journey?.phase === "protecting"
            ? "Anchor lift — hold or ease today; the relevant safety signal takes priority."
            : reps
              ? `Anchor lift — ${reps.current}, toward ${reps.target}.`
              : current
              ? `Anchor lift — ${Number(current.est_1rm).toFixed(1)} lb estimated 1RM on ${CairnFmt.date(current.date)}${Number(gap) > 0 ? ` · ${Number(gap).toFixed(1)} lb to target` : ""}.`
              : "Anchor lift — establish one clean exact-lift checkpoint today.";
      return { ...item, journey_role: "anchor", journey_line: line };
    }
    const dayNumber = Number(day.day_number);
    const support = (Array.isArray(journey?.planned_support) ? journey.planned_support : []).find(
      (entry) => sameJourneyExercise(entry.exercise, exercise) && Number(entry.plan_day_number) === dayNumber
    );
    return support
      ? { ...item, journey_role: "support", journey_line: `${support.role} for ${objective.exercise} — ${support.why}` }
      : item;
  }

  const CAIRN_TODAY_SESSION_JOURNEY: TodaySessionJourneyApi = { journeyItem, repsWords };

  Object.assign(globalThis, { CairnTodaySessionJourney: CAIRN_TODAY_SESSION_JOURNEY });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodaySessionJourney: CAIRN_TODAY_SESSION_JOURNEY });
  }
})();

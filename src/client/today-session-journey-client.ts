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
};

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

  function journeyItem(
    item: TodayPlanSurfaceRendererItem,
    day: TodayPlanSurfaceRendererRecord,
    journey: TodayPlanSurfaceRendererJourney | null
  ): TodayPlanSurfaceRendererItem {
    const exercise = String(item.exercise || "");
    const objective = journey?.available ? journey.objective : null;
    if (!objective?.exercise || !exercise) return item;
    if (sameJourneyExercise(exercise, objective.exercise)) {
      const current = journey?.current;
      const gap = journey?.gap_lb;
      const line =
        objective.status === "completed"
          ? "Anchor milestone complete — keep this lift steady and consolidate it."
          : journey?.phase === "protecting"
            ? "Anchor lift — hold or ease today; the relevant safety signal takes priority."
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

  const CAIRN_TODAY_SESSION_JOURNEY: TodaySessionJourneyApi = { journeyItem };

  Object.assign(globalThis, { CairnTodaySessionJourney: CAIRN_TODAY_SESSION_JOURNEY });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodaySessionJourney: CAIRN_TODAY_SESSION_JOURNEY });
  }
})();

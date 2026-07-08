// @ts-check
// Today plan-day selection: infer which plan day a session belongs to, then pick
// the next calm default when the user opens Today without explicitly choosing.

type TodayPlanSelectionItem = {
  exercise?: string | null;
  kind?: string | null;
};

type TodayPlanSelectionDay = {
  id?: number | string | null;
  day_number: number;
  items?: TodayPlanSelectionItem[] | null;
};

type TodayPlanSelectionSet = {
  exercise?: string | null;
};

type TodayPlanSelectionSession = {
  date?: string | null;
  plan_day_id?: number | string | null;
  sets?: TodayPlanSelectionSet[] | null;
};

type TodayPlanSelectionDeps = {
  state: {
    logDate: string;
    plan: TodayPlanSelectionDay[];
  };
  api(path: string): Promise<unknown>;
  cachedApi?(path: string, options?: { key?: string; freshFor?: number }): Promise<unknown>;
};

(() => {
  type MovementBucket = "push" | "pull" | "lower" | "core" | "mobility" | "cardio" | "other";

  function movementBucket(name: string | null | undefined): MovementBucket {
    const n = String(name || "").toLowerCase();
    if (!n) return "other";
    if (/\b(run|ride|bike|cycle|swim|row|walk|hike|ruck|cardio|z2|tempo|interval)\b/.test(n)) return "cardio";
    if (/(90\s*\/\s*90|hip switch|mobility|stretch|cat[\s-]?cow|cossack|thoracic|opener|ankle|wrist prep)/.test(n)) return "mobility";
    if (/(plank|dead\s*bug|hollow|bird\s*dog|pallof|crunch|sit[\s-]?up|leg raise|rollout|carry|farmer|suitcase)/.test(n)) return "core";
    if (/(squat|deadlift|lunge|hinge|\brdl\b|leg press|leg curl|leg extension|hip thrust|glute|step[\s-]?up|calf|split squat|bulgarian)/.test(n)) return "lower";
    if (/(bench|overhead press|\bohp\b|push[\s-]?up|\bdip\b|\bfly\b|lateral raise|press|tricep|pushdown|skullcrusher)/.test(n)) return "push";
    if (/(\brow\b|pull[\s-]?up|pulldown|chin[\s-]?up|curl|face pull|\blat\b|shrug|pull[\s-]?over|rear delt)/.test(n)) return "pull";
    return "other";
  }

  function bucketSet(names: Array<string | null | undefined>): Set<MovementBucket> {
    const out = new Set<MovementBucket>();
    for (const name of names) {
      const bucket = movementBucket(name);
      if (bucket !== "other" && bucket !== "mobility") out.add(bucket);
    }
    return out;
  }

  function planDayNumberForSession(
    session: TodayPlanSelectionSession | null | undefined,
    plan: TodayPlanSelectionDay[] | null | undefined,
  ): number | null {
    const days = Array.isArray(plan) ? plan : [];
    if (!session || !(session.sets || []).length) return null;
    const byId = days.find((day) => Number(day.id) === Number(session.plan_day_id));
    if (byId) return byId.day_number;

    const loggedNames = new Set((session.sets || []).map((set) => set.exercise).filter(Boolean));
    let best: { day_number: number; hits: number } | null = null;
    for (const day of days) {
      const plannedNames = new Set((day.items || []).map((item) => item.exercise));
      let hits = 0;
      loggedNames.forEach((name) => { if (plannedNames.has(name)) hits++; });
      if (hits && (!best || hits > best.hits)) best = { day_number: day.day_number, hits };
    }
    if (best) return best.day_number;

    const loggedBuckets = bucketSet((session.sets || []).map((set) => set.exercise));
    let groupBest: { day_number: number; hits: number; ratio: number } | null = null;
    if (loggedBuckets.size) {
      for (const day of days) {
        const plannedBuckets = bucketSet((day.items || []).filter((item) => item.kind !== "cardio").map((item) => item.exercise));
        let hits = 0;
        loggedBuckets.forEach((bucket) => { if (plannedBuckets.has(bucket)) hits++; });
        if (!hits) continue;
        const ratio = hits / Math.max(1, Math.min(loggedBuckets.size, plannedBuckets.size));
        if (!groupBest || hits > groupBest.hits || (hits === groupBest.hits && ratio > groupBest.ratio)) {
          groupBest = { day_number: day.day_number, hits, ratio };
        }
      }
    }
    return groupBest?.day_number ?? null;
  }

  function nextPlanDayNumber(dayNumber: number | null | undefined, plan: TodayPlanSelectionDay[] | null | undefined): number | null {
    const ordered = [...(Array.isArray(plan) ? plan : [])].sort((a, b) => a.day_number - b.day_number);
    if (!ordered.length) return null;
    const idx = ordered.findIndex((day) => day.day_number === dayNumber);
    return ordered[idx >= 0 ? (idx + 1) % ordered.length : 0].day_number;
  }

  async function suggestedPlanDayNumber(
    session: TodayPlanSelectionSession | null | undefined,
    isToday: boolean,
    deps: TodayPlanSelectionDeps,
  ): Promise<number> {
    const plan = deps.state.plan || [];
    const currentLoggedDay = planDayNumberForSession(session, plan);
    if (currentLoggedDay) return currentLoggedDay;
    if (!isToday) return plan[0]?.day_number ?? 1;

    try {
      const recent = deps.cachedApi
        ? await deps.cachedApi("/sessions?limit=20", { key: "history:sessions", freshFor: 30000 })
        : await deps.api("/sessions?limit=20");
      const rows = Array.isArray(recent) ? recent as TodayPlanSelectionSession[] : [];
      const latest = rows.find((row) =>
        row.date !== deps.state.logDate && planDayNumberForSession(row, plan)
      );
      const latestDay = planDayNumberForSession(latest, plan);
      return latestDay ? (nextPlanDayNumber(latestDay, plan) ?? plan[0]?.day_number ?? 1) : (plan[0]?.day_number ?? 1);
    } catch {
      return plan[0]?.day_number ?? 1;
    }
  }

  const CAIRN_TODAY_PLAN_SELECTION = {
    nextPlanDayNumber,
    planDayNumberForSession,
    suggestedPlanDayNumber,
  };

  Object.assign(globalThis, { CairnTodayPlanSelection: CAIRN_TODAY_PLAN_SELECTION });

  if (typeof window !== "undefined") {
    window.CairnTodayPlanSelection = CAIRN_TODAY_PLAN_SELECTION;
  }
})();

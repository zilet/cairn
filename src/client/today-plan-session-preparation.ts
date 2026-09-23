// @ts-check
// Today plan/session preparation: selected day, skips, last-set prefill, pending
// off-plan cards, and adaptive prescriptions. Lifts only: runs live in Plan ->
// Endurance and reach Today through the agenda, never as a plan item.

type TodayPlanSessionPrepCachedApiOptions<T> = {
  key?: string;
  freshFor?: number;
  onUpgrade?: (data: T, meta: { changed: boolean }) => void;
};
type TodayPlanSessionPrepSwrPeek<T> = { data: T; fresh: boolean };
type TodayPlanSessionPrepPlanItem = import("../contracts/client.js").ClientPlanItem & {
  fromPlan?: boolean;
  fromSession?: boolean;
};
type TodayPlanSessionPrepPlanDay = {
  id?: number;
  day_number: number;
  name?: string;
  focus?: string | null;
  items?: TodayPlanSessionPrepPlanItem[] | null;
  [key: string]: unknown;
};
type TodayPlanSessionPrepLoggedSet = import("../contracts/client.js").ClientLoggedSet & {
  exercise: string;
  set_number?: number | null;
  duration_sec?: number | null;
};
type TodayPlanSessionPrepSession = import("../contracts/client.js").ClientTrainingSession & {
  plan_day_id?: number | null;
  skips?: unknown[];
  sets?: TodayPlanSessionPrepLoggedSet[] | null;
};
type TodayPlanSessionPrepDailySession = import("../contracts/client-api.js").ClientDailySessionComposition;
type TodayPlanSessionPrepCardioEffort = import("../contracts/client.js").ClientCardioEffort;
type TodayPlanSessionPrepPrescription = import("../contracts/client.js").ClientPrescription & {
  exercise?: string | null;
};
type TodayPlanSessionPrepStrengthJourney = import("../contracts/client-api.js").ClientStrengthJourney;
type TodayPlanSessionPrepPendingOffPlan = { name: string; mode?: string | null };
type TodayPlanSessionPrepPrefill = { weight: unknown; reps: unknown; rir: unknown; duration_sec?: unknown };
type TodayPlanSessionPrepCardAttribution = {
  key: string;
  exercise: string;
  sets: TodayPlanSessionPrepLoggedSet[];
  siblings: number;
};
type TodayPlanSessionPrepState = {
  logDate: string;
  day: number | null;
  /** True when the server said today is a calendar run or rest day (no lift selected). */
  calendarDay?: boolean;
  dayPicked?: boolean;
  dayPickedOn?: string | null;
  plan: TodayPlanSessionPrepPlanDay[];
  planReveal?: { date: string; on: boolean; blank?: boolean } | null;
  pendingOffPlan?: Record<string, TodayPlanSessionPrepPendingOffPlan[]>;
};
type TodayPlanSessionPrepDeps = {
  state: TodayPlanSessionPrepState;
  session: TodayPlanSessionPrepSession | null | undefined;
  isToday: boolean;
  api(path: string): Promise<unknown>;
  cachedApi(path: string, opts?: TodayPlanSessionPrepCachedApiOptions<unknown>): Promise<unknown>;
  peekCached<T = unknown>(key: string, freshFor?: number): TodayPlanSessionPrepSwrPeek<T> | null;
  storeCached?(key: string, data: unknown): void;
  suggestedPlanDayNumber(session: TodayPlanSessionPrepSession | null | undefined, isToday: boolean): Promise<number | null>;
  // What the /today aggregate already answered for THIS render (see
  // today-data-loader): primed SWR keys plus the strength journey payload, so the
  // paint-blocking prep wave asks the network only for what is genuinely missing.
  primedLastSets?: string[];
  primedProgressionDay?: number | null;
  primedStrengthJourney?: unknown;
};
type TodayPlanSessionPrepResult = {
  revealBlank: boolean;
  day: TodayPlanSessionPrepPlanDay;
  dailySession: TodayPlanSessionPrepDailySession | null;
  loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>;
  planNames: Set<string>;
  cardioEfforts: TodayPlanSessionPrepCardioEffort[];
  activeItems: TodayPlanSessionPrepPlanItem[];
  skippedItems: TodayPlanSessionPrepPlanItem[];
  strengthItems: TodayPlanSessionPrepPlanItem[];
  planEx: string[];
  offPlanEx: string[];
  pendingOffPlan: TodayPlanSessionPrepPendingOffPlan[];
  lastSets: Record<string, Record<string, unknown> | null>;
  rxByEx: Record<string, TodayPlanSessionPrepPrescription | null | undefined>;
  strengthJourney: TodayPlanSessionPrepStrengthJourney | null;
  rxFor(name: unknown): TodayPlanSessionPrepPrescription | null;
  prefillFor(item: TodayPlanSessionPrepPlanItem): TodayPlanSessionPrepPrefill;
  attributionFor(item: TodayPlanSessionPrepPlanItem): TodayPlanSessionPrepCardAttribution | null;
  exDone: number;
  exTotal: number;
  hasSyncedCardioToday: boolean;
  isRunDay: boolean;
  // Per-plan-day acute-recovery read for the day pills, keyed by day_number.
  planDayRecovery: Record<number, { recovering_groups: string[]; mostly_recovering: boolean }>;
};
type TodayPlanSessionPreparationApi = {
  groupLoggedSets(
    session: TodayPlanSessionPrepSession | null | undefined
  ): Record<string, TodayPlanSessionPrepLoggedSet[]>;
  preparePlanSession(deps: TodayPlanSessionPrepDeps): Promise<TodayPlanSessionPrepResult>;
};
type TodayPlanSessionPrepModelApi = {
  planItems(day: TodayPlanSessionPrepPlanDay | null | undefined): TodayPlanSessionPrepPlanItem[];
  groupLoggedSets(
    session: TodayPlanSessionPrepSession | null | undefined
  ): Record<string, TodayPlanSessionPrepLoggedSet[]>;
  selectedPlanDay(state: TodayPlanSessionPrepState, revealBlank: boolean): TodayPlanSessionPrepPlanDay;
  itemGroups(params: {
    items: TodayPlanSessionPrepPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>;
    skips: unknown[];
  }): {
    planNames: Set<string>;
    activeItems: TodayPlanSessionPrepPlanItem[];
    skippedItems: TodayPlanSessionPrepPlanItem[];
    strengthItems: TodayPlanSessionPrepPlanItem[];
    planEx: string[];
    offPlanEx: string[];
  };
  prunePendingOffPlan(
    state: TodayPlanSessionPrepState,
    planNames: Set<string>,
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>
  ): TodayPlanSessionPrepPendingOffPlan[];
  prefillFor(
    item: TodayPlanSessionPrepPlanItem,
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>,
    lastSets: Record<string, Record<string, unknown> | null>,
    rx?: TodayPlanSessionPrepPrescription | null,
    attributed?: TodayPlanSessionPrepCardAttribution | null
  ): TodayPlanSessionPrepPrefill;
  cardAttribution(params: {
    items: TodayPlanSessionPrepPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>;
  }): Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardAttribution>;
};
type TodayPlanSelectionRecoveryApi = {
  loadPlanDayRecovery?(
    date: string,
    deps: { api(path: string): Promise<unknown> }
  ): Promise<Record<number, { recovering_groups: string[]; mostly_recovering: boolean }>>;
};
type TodayPlanSessionPrepDataApi = {
  loadLastSets(
    names: string[],
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>,
    deps: TodayPlanSessionPrepDeps
  ): Promise<Record<string, Record<string, unknown> | null>>;
  loadPrescriptions(
    day: number | null,
    planEx: string[],
    deps: Pick<TodayPlanSessionPrepDeps, "cachedApi" | "peekCached" | "primedProgressionDay">
  ): Promise<Record<string, TodayPlanSessionPrepPrescription | null | undefined>>;
  loadCardioContext(
    dayItems: TodayPlanSessionPrepPlanItem[],
    isToday: boolean,
    deps: TodayPlanSessionPrepDeps
  ): Promise<{
    cardioEfforts: TodayPlanSessionPrepCardioEffort[];
  }>;
};

(() => {
  const todayPlanSessionModel = (
    globalThis as unknown as {
      CairnTodayPlanSessionModel: TodayPlanSessionPrepModelApi;
    }
  ).CairnTodayPlanSessionModel;
  const todayPlanSessionData = (
    globalThis as unknown as {
      CairnTodayPlanSessionData: TodayPlanSessionPrepDataApi;
    }
  ).CairnTodayPlanSessionData;

  async function preparePlanSession(deps: TodayPlanSessionPrepDeps): Promise<TodayPlanSessionPrepResult> {
    const loggedByEx = todayPlanSessionModel.groupLoggedSets(deps.session);
    const dailySession =
      deps.session?.daily_session && Array.isArray(deps.session.daily_session.items)
        ? (deps.session.daily_session as TodayPlanSessionPrepDailySession)
        : null;
    const revealBlank = !!(
      deps.state.planReveal &&
      deps.state.planReveal.date === deps.state.logDate &&
      deps.state.planReveal.on &&
      deps.state.planReveal.blank
    );
    const linked =
      dailySession?.plan_day_id == null
        ? null
        : deps.state.plan.find((day) => Number(day.id) === Number(dailySession.plan_day_id)) || null;
    if (dailySession) {
      deps.state.day = linked?.day_number ?? null;
      deps.state.dayPicked = dailySession.source === "manual_plan";
      // Anchor the pick to the day it was made on (see dayRolloverTarget). A manual
      // pick on the calendar's own day is only stale once midnight passes; one made
      // while looking at another day is deliberate and never rolls forward.
      deps.state.dayPickedOn = deps.state.dayPicked && deps.isToday ? deps.state.logDate : null;
    } else {
      const hasSelectedDay = deps.state.plan.some((day) => day.day_number === deps.state.day);
      if (revealBlank && !deps.state.dayPicked) {
        deps.state.day = null;
      } else if (!deps.state.dayPicked || deps.state.day === null || !hasSelectedDay) {
        deps.state.day = await deps.suggestedPlanDayNumber(deps.session, deps.isToday);
        // null = the calendar says run or rest today: no lift is selected by default.
        deps.state.calendarDay = deps.state.day === null;
        deps.state.dayPicked = false;
        deps.state.dayPickedOn = null;
      }
    }

    const planSource = dailySession?.source === "adaptive_plan" || dailySession?.source === "manual_plan";
    const selectedDay = dailySession
      ? (() => {
          const snapshotItems = [...dailySession.items]
            .sort((left, right) => Number(left.position) - Number(right.position))
            .map((item) => ({ ...item, fromPlan: planSource, fromSession: true }));
          return {
            id: dailySession.plan_day_id ?? undefined,
            day_number: deps.state.day ?? 0,
            name: dailySession.title || (planSource ? "Today's session" : "Built for today"),
            focus: dailySession.focus,
            // The accepted one-day composition is the complete prescription.
            // Later weekly-plan edits require an explicit prepare/replace and can
            // never leak into this durable snapshot. A run an older snapshot still
            // carries is dropped by planItems below — runs are not plan items.
            items: snapshotItems,
            daily_session: dailySession,
          };
        })()
      : todayPlanSessionModel.selectedPlanDay(deps.state, revealBlank);
    const items = todayPlanSessionModel.planItems(selectedDay);
    // The day every surface reads carries the lift list alone, so a run an older
    // payload still holds can never make a lift-less day look startable.
    const day: TodayPlanSessionPrepPlanDay = { ...selectedDay, items };
    const skips = (deps.session && deps.session.skips) || [];

    // Skip state reads only loggedByEx/skips, so the groups are known before any
    // fetch and the synced-run check (/cardio) rides in the SAME wave as the
    // last-set + prescription fetches instead of gating them serially.
    const { planNames, activeItems, skippedItems, strengthItems, planEx, offPlanEx } = todayPlanSessionModel.itemGroups({
      items,
      loggedByEx,
      skips,
    });
    const pendingOffPlan = todayPlanSessionModel.prunePendingOffPlan(deps.state, planNames, loggedByEx);

    // Read LAZILY, inside the function: the plan-selection module shares the Today
    // bundle's one global scope, and a top-level reference across module files does
    // not hoist (CLAUDE.md).
    const planSelection = (globalThis as unknown as { CairnTodayPlanSelection?: TodayPlanSelectionRecoveryApi })
      .CairnTodayPlanSelection;
    const [{ cardioEfforts }, lastSets, rxByEx, strengthJourney, planDayRecovery] =
      await Promise.all([
        todayPlanSessionData.loadCardioContext(items, deps.isToday, deps),
        todayPlanSessionData.loadLastSets(
          [...planEx, ...pendingOffPlan.map((item) => item.name)],
          loggedByEx,
          deps
        ),
        todayPlanSessionData.loadPrescriptions(dailySession && !planSource ? null : deps.state.day, planEx, deps),
        deps.primedStrengthJourney !== undefined
          ? Promise.resolve(
              deps.primedStrengthJourney && typeof deps.primedStrengthJourney === "object"
                ? (deps.primedStrengthJourney as TodayPlanSessionPrepStrengthJourney)
                : null
            )
          : deps
              .api("/strength-journey")
              .then((value) => (value && typeof value === "object" ? (value as TodayPlanSessionPrepStrengthJourney) : null))
              .catch(() => null),
        // Shares one request with the adaptive-day read above (api() dedupes the
        // same path), and a failure is silence — a missing hint never blocks a pill.
        planSelection?.loadPlanDayRecovery
          ? planSelection.loadPlanDayRecovery(deps.state.logDate, deps).catch(() => ({}))
          : Promise.resolve({}),
      ]);

    const rxFor = (name: unknown) => (name ? rxByEx[String(name).toLowerCase()] || null : null);
    // Cards, not exercise names, are what the athlete logs into. On a peak day the
    // top single and its back-off block share one name, so every per-card question
    // — what to prefill, how many sets are done — asks the attribution, not the pile.
    const attribution = todayPlanSessionModel.cardAttribution({ items, loggedByEx });
    const attributionFor = (item: TodayPlanSessionPrepPlanItem) => attribution.get(item) || null;
    const prefillFor = (item: TodayPlanSessionPrepPlanItem): TodayPlanSessionPrepPrefill =>
      todayPlanSessionModel.prefillFor(item, loggedByEx, lastSets, rxFor(item.exercise), attributionFor(item));
    const exDone = strengthItems.filter((item) => {
      const attributed = attributionFor(item);
      return (attributed ? attributed.sets : loggedByEx[String(item.exercise)] || []).length > 0;
    }).length;
    const exTotal = strengthItems.length;
    const hasSyncedCardioToday = cardioEfforts.length > 0;
    const isRunDay = hasSyncedCardioToday && exTotal === 0;

    return {
      revealBlank,
      day,
      dailySession,
      loggedByEx,
      planNames,
      cardioEfforts,
      activeItems,
      skippedItems,
      strengthItems,
      planEx,
      offPlanEx,
      pendingOffPlan,
      lastSets,
      rxByEx,
      strengthJourney,
      rxFor,
      prefillFor,
      attributionFor,
      exDone,
      exTotal,
      hasSyncedCardioToday,
      isRunDay,
      planDayRecovery,
    };
  }

  const CAIRN_TODAY_PLAN_SESSION_PREPARATION: TodayPlanSessionPreparationApi = {
    groupLoggedSets: todayPlanSessionModel.groupLoggedSets,
    preparePlanSession,
  };

  Object.assign(globalThis, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });
  }
})();

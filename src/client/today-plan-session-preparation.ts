// @ts-check
// Today plan/session preparation: selected day, skips, cardio matches, last-set
// prefill, pending off-plan cards, and adaptive prescriptions.

type TodayPlanSessionPrepCachedApiOptions<T> = {
  key?: string;
  freshFor?: number;
  onUpgrade?: (data: T, meta: { changed: boolean }) => void;
};
type TodayPlanSessionPrepSwrPeek<T> = { data: T; fresh: boolean };
type TodayPlanSessionPrepPlanItem = import("../contracts/client.js").ClientPlanItem & {
  fromPlan?: boolean;
  fromSession?: boolean;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
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
type TodayPlanSessionPrepState = {
  logDate: string;
  day: number | null;
  dayPicked?: boolean;
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
  suggestedPlanDayNumber(session: TodayPlanSessionPrepSession | null | undefined, isToday: boolean): Promise<number>;
  isCardioItem(item: TodayPlanSessionPrepPlanItem): boolean;
  cardioLabel(item: TodayPlanSessionPrepPlanItem): string;
  cardioEffortMatches(
    item: TodayPlanSessionPrepPlanItem,
    effort: TodayPlanSessionPrepCardioEffort | null | undefined
  ): boolean;
};
type TodayPlanSessionPrepResult = {
  revealBlank: boolean;
  day: TodayPlanSessionPrepPlanDay;
  dailySession: TodayPlanSessionPrepDailySession | null;
  loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>;
  planNames: Set<string>;
  allCardio: TodayPlanSessionPrepPlanItem[];
  cardioEfforts: TodayPlanSessionPrepCardioEffort[];
  todaySettings: unknown;
  matchedCardio: Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>;
  activeItems: TodayPlanSessionPrepPlanItem[];
  skippedItems: TodayPlanSessionPrepPlanItem[];
  cardioItems: TodayPlanSessionPrepPlanItem[];
  strengthItems: TodayPlanSessionPrepPlanItem[];
  planEx: string[];
  offPlanEx: string[];
  pendingOffPlan: TodayPlanSessionPrepPendingOffPlan[];
  lastSets: Record<string, Record<string, unknown> | null>;
  rxByEx: Record<string, TodayPlanSessionPrepPrescription | null | undefined>;
  symptomMovements: string[];
  strengthJourney: TodayPlanSessionPrepStrengthJourney | null;
  rxFor(name: unknown): TodayPlanSessionPrepPrescription | null;
  prefillFor(item: TodayPlanSessionPrepPlanItem): TodayPlanSessionPrepPrefill;
  exDone: number;
  exTotal: number;
  hasSyncedCardioToday: boolean;
  isRunDay: boolean;
  expectingRun: boolean;
};
type TodayPlanSessionPreparationApi = {
  groupLoggedSets(
    session: TodayPlanSessionPrepSession | null | undefined
  ): Record<string, TodayPlanSessionPrepLoggedSet[]>;
  matchCardioEfforts(
    items: TodayPlanSessionPrepPlanItem[],
    efforts: TodayPlanSessionPrepCardioEffort[],
    matches: TodayPlanSessionPrepDeps["cardioEffortMatches"]
  ): Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>;
  preparePlanSession(deps: TodayPlanSessionPrepDeps): Promise<TodayPlanSessionPrepResult>;
};
type TodayPlanSessionPrepModelApi = {
  planItems(day: TodayPlanSessionPrepPlanDay | null | undefined): TodayPlanSessionPrepPlanItem[];
  groupLoggedSets(
    session: TodayPlanSessionPrepSession | null | undefined
  ): Record<string, TodayPlanSessionPrepLoggedSet[]>;
  selectedPlanDay(state: TodayPlanSessionPrepState, revealBlank: boolean): TodayPlanSessionPrepPlanDay;
  matchCardioEfforts(
    items: TodayPlanSessionPrepPlanItem[],
    efforts: TodayPlanSessionPrepCardioEffort[],
    matches: TodayPlanSessionPrepDeps["cardioEffortMatches"]
  ): Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>;
  itemGroups(params: {
    items: TodayPlanSessionPrepPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>;
    matchedCardio: Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>;
    skips: unknown[];
    isCardioItem(item: TodayPlanSessionPrepPlanItem): boolean;
    cardioLabel(item: TodayPlanSessionPrepPlanItem): string;
  }): {
    planNames: Set<string>;
    activeItems: TodayPlanSessionPrepPlanItem[];
    skippedItems: TodayPlanSessionPrepPlanItem[];
    cardioItems: TodayPlanSessionPrepPlanItem[];
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
    rx?: TodayPlanSessionPrepPrescription | null
  ): TodayPlanSessionPrepPrefill;
};
type TodayPlanSessionPrepDataApi = {
  loadSymptomMovements(names: string[], deps: TodayPlanSessionPrepDeps): Promise<string[]>;
  loadLastSets(
    names: string[],
    loggedByEx: Record<string, TodayPlanSessionPrepLoggedSet[]>,
    deps: TodayPlanSessionPrepDeps
  ): Promise<Record<string, Record<string, unknown> | null>>;
  loadPrescriptions(
    day: number | null,
    planEx: string[],
    deps: Pick<TodayPlanSessionPrepDeps, "cachedApi">
  ): Promise<Record<string, TodayPlanSessionPrepPrescription | null | undefined>>;
  loadCardioContext(
    dayItems: TodayPlanSessionPrepPlanItem[],
    isToday: boolean,
    deps: TodayPlanSessionPrepDeps
  ): Promise<{
    allCardio: TodayPlanSessionPrepPlanItem[];
    cardioEfforts: TodayPlanSessionPrepCardioEffort[];
    todaySettings: unknown;
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
    } else {
      const hasSelectedDay = deps.state.plan.some((day) => day.day_number === deps.state.day);
      if (revealBlank && !deps.state.dayPicked) {
        deps.state.day = null;
      } else if (!deps.state.dayPicked || deps.state.day === null || !hasSelectedDay) {
        deps.state.day = await deps.suggestedPlanDayNumber(deps.session, deps.isToday);
        deps.state.dayPicked = false;
      }
    }

    const planSource = dailySession?.source === "adaptive_plan" || dailySession?.source === "manual_plan";
    const day = dailySession
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
            // never leak into this durable snapshot, including cardio items.
            items: snapshotItems,
            daily_session: dailySession,
          };
        })()
      : todayPlanSessionModel.selectedPlanDay(deps.state, revealBlank);
    const items = todayPlanSessionModel.planItems(day);
    const skips = (deps.session && deps.session.skips) || [];

    // planEx/planNames/pendingOffPlan never actually depend on cardio-effort
    // matching: a STRENGTH item's skip status only reads loggedByEx/skips
    // (matchedCardio only changes whether a CARDIO item counts as skipped, and
    // planEx excludes cardio items either way). Fold them against an empty
    // matchedCardio map so the cardio-context fetch (/cardio + /settings) can run
    // in the SAME wave as the last-set + prescription fetches, instead of gating
    // them serially.
    const NO_CARDIO_MATCH = new Map<TodayPlanSessionPrepPlanItem, TodayPlanSessionPrepCardioEffort>();
    const early = todayPlanSessionModel.itemGroups({
      items,
      loggedByEx,
      matchedCardio: NO_CARDIO_MATCH,
      skips,
      isCardioItem: deps.isCardioItem,
      cardioLabel: deps.cardioLabel,
    });
    const pendingOffPlan = todayPlanSessionModel.prunePendingOffPlan(deps.state, early.planNames, loggedByEx);

    const [{ allCardio, cardioEfforts, todaySettings }, lastSets, rxByEx, symptomMovements, strengthJourney] =
      await Promise.all([
        todayPlanSessionData.loadCardioContext(items, deps.isToday, deps),
        todayPlanSessionData.loadLastSets(
          [...early.planEx, ...pendingOffPlan.map((item) => item.name)],
          loggedByEx,
          deps
        ),
        todayPlanSessionData.loadPrescriptions(dailySession && !planSource ? null : deps.state.day, early.planEx, deps),
        todayPlanSessionData.loadSymptomMovements(early.planEx, deps),
        deps
          .api("/strength-journey")
          .then((value) => (value && typeof value === "object" ? (value as TodayPlanSessionPrepStrengthJourney) : null))
          .catch(() => null),
      ]);

    const matchedCardio = todayPlanSessionModel.matchCardioEfforts(allCardio, cardioEfforts, deps.cardioEffortMatches);
    const { planNames, activeItems, skippedItems, cardioItems, strengthItems, planEx, offPlanEx } =
      todayPlanSessionModel.itemGroups({
        items,
        loggedByEx,
        matchedCardio,
        skips,
        isCardioItem: deps.isCardioItem,
        cardioLabel: deps.cardioLabel,
      });
    const rxFor = (name: unknown) => (name ? rxByEx[String(name).toLowerCase()] || null : null);
    const prefillFor = (item: TodayPlanSessionPrepPlanItem): TodayPlanSessionPrepPrefill =>
      todayPlanSessionModel.prefillFor(item, loggedByEx, lastSets, rxFor(item.exercise));
    const exDone = strengthItems.filter((item) => (loggedByEx[String(item.exercise)] || []).length).length;
    const exTotal = strengthItems.length;
    const hasSyncedCardioToday = cardioEfforts.length > 0;
    const isRunDay = (cardioItems.length > 0 || hasSyncedCardioToday) && exTotal === 0;
    const expectingRun = deps.isToday && cardioItems.length > 0 && !cardioItems.some((item) => matchedCardio.has(item));

    return {
      revealBlank,
      day,
      dailySession,
      loggedByEx,
      planNames,
      allCardio,
      cardioEfforts,
      todaySettings,
      matchedCardio,
      activeItems,
      skippedItems,
      cardioItems,
      strengthItems,
      planEx,
      offPlanEx,
      pendingOffPlan,
      lastSets,
      rxByEx,
      symptomMovements,
      strengthJourney,
      rxFor,
      prefillFor,
      exDone,
      exTotal,
      hasSyncedCardioToday,
      isRunDay,
      expectingRun,
    };
  }

  const CAIRN_TODAY_PLAN_SESSION_PREPARATION: TodayPlanSessionPreparationApi = {
    groupLoggedSets: todayPlanSessionModel.groupLoggedSets,
    matchCardioEfforts: todayPlanSessionModel.matchCardioEfforts,
    preparePlanSession,
  };

  Object.assign(globalThis, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });
  }
})();

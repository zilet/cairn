// @ts-check
// Today plan/session model: deterministic selected-day, set grouping, item
// partitioning, pending off-plan pruning, and prefill decisions.

type TodayPlanSessionModelPlanItem = import("../contracts/client.js").ClientPlanItem & {
  fromPlan?: boolean;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
};
type TodayPlanSessionModelPlanDay = {
  id?: number;
  day_number: number;
  name?: string;
  focus?: string | null;
  items?: TodayPlanSessionModelPlanItem[] | null;
  [key: string]: unknown;
};
type TodayPlanSessionModelLoggedSet = import("../contracts/client.js").ClientLoggedSet & {
  exercise: string;
  set_number?: number | null;
  duration_sec?: number | null;
};
type TodayPlanSessionModelSession = import("../contracts/client.js").ClientTrainingSession & {
  skips?: unknown[];
  sets?: TodayPlanSessionModelLoggedSet[] | null;
};
type TodayPlanSessionModelCardioEffort = import("../contracts/client.js").ClientCardioEffort;
type TodayPlanSessionModelPrescription = Partial<import("../contracts/client.js").ClientPrescription>;
type TodayPlanSessionModelPendingOffPlan = { name: string; mode?: string | null };
type TodayPlanSessionModelPrefill = { weight: unknown; reps: unknown; rir: unknown; duration_sec?: unknown };
type TodayPlanSessionModelState = {
  logDate: string;
  day: number | null;
  plan: TodayPlanSessionModelPlanDay[];
  pendingOffPlan?: Record<string, TodayPlanSessionModelPendingOffPlan[]>;
};
type TodayPlanSessionItemGroups = {
  planNames: Set<string>;
  activeItems: TodayPlanSessionModelPlanItem[];
  skippedItems: TodayPlanSessionModelPlanItem[];
  cardioItems: TodayPlanSessionModelPlanItem[];
  strengthItems: TodayPlanSessionModelPlanItem[];
  planEx: string[];
  offPlanEx: string[];
};
type TodayPlanSessionCardAttribution = {
  key: string;
  exercise: string;
  sets: TodayPlanSessionModelLoggedSet[];
  siblings: number;
};
type TodayPlanSessionModelApi = {
  planItems(day: TodayPlanSessionModelPlanDay | null | undefined): TodayPlanSessionModelPlanItem[];
  cardAttribution(params: {
    items: TodayPlanSessionModelPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>;
    isCardioItem(item: TodayPlanSessionModelPlanItem): boolean;
  }): Map<TodayPlanSessionModelPlanItem, TodayPlanSessionCardAttribution>;
  groupLoggedSets(session: TodayPlanSessionModelSession | null | undefined): Record<string, TodayPlanSessionModelLoggedSet[]>;
  selectedPlanDay(state: TodayPlanSessionModelState, revealBlank: boolean): TodayPlanSessionModelPlanDay;
  matchCardioEfforts(
    items: TodayPlanSessionModelPlanItem[],
    efforts: TodayPlanSessionModelCardioEffort[],
    matches: (item: TodayPlanSessionModelPlanItem, effort: TodayPlanSessionModelCardioEffort | null | undefined) => boolean,
  ): Map<TodayPlanSessionModelPlanItem, TodayPlanSessionModelCardioEffort>;
  itemGroups(params: {
    items: TodayPlanSessionModelPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>;
    matchedCardio: Map<TodayPlanSessionModelPlanItem, TodayPlanSessionModelCardioEffort>;
    skips: unknown[];
    isCardioItem(item: TodayPlanSessionModelPlanItem): boolean;
    cardioLabel(item: TodayPlanSessionModelPlanItem): string;
  }): TodayPlanSessionItemGroups;
  prunePendingOffPlan(
    state: TodayPlanSessionModelState,
    planNames: Set<string>,
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>,
  ): TodayPlanSessionModelPendingOffPlan[];
  prefillFor(
    item: TodayPlanSessionModelPlanItem,
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>,
    lastSets: Record<string, Record<string, unknown> | null>,
    rx?: TodayPlanSessionModelPrescription | null,
    attributed?: TodayPlanSessionCardAttribution | null,
  ): TodayPlanSessionModelPrefill;
};

(() => {
  function planItems(day: TodayPlanSessionModelPlanDay | null | undefined): TodayPlanSessionModelPlanItem[] {
    return Array.isArray(day?.items) ? day.items : [];
  }

  function groupLoggedSets(session: TodayPlanSessionModelSession | null | undefined): Record<string, TodayPlanSessionModelLoggedSet[]> {
    const loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]> = {};
    if (session) {
      for (const set of session.sets || []) {
        if (!set?.exercise) continue;
        (loggedByEx[set.exercise] ??= []).push(set);
      }
    }
    for (const key of Object.keys(loggedByEx)) {
      loggedByEx[key].sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0));
    }
    return loggedByEx;
  }

  // A peak day prescribes the SAME lift twice — the near-max top single, then its
  // back-off block — so an exercise NAME no longer identifies a card. Logged sets
  // arrive under the one real lift name (they must: est-1RM and calibration read
  // that name), so each card claims its share chronologically against its own
  // prescribed set count, in plan order: the top single takes the first set, the
  // back-off block the rest. The last card absorbs whatever is left over, which is
  // what makes the ordinary one-card day degenerate to exactly today's behaviour —
  // that card's key IS the exercise name and it claims every logged set.
  function cardAttribution(params: {
    items: TodayPlanSessionModelPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>;
    isCardioItem(item: TodayPlanSessionModelPlanItem): boolean;
  }): Map<TodayPlanSessionModelPlanItem, TodayPlanSessionCardAttribution> {
    const attribution = new Map<TodayPlanSessionModelPlanItem, TodayPlanSessionCardAttribution>();
    const byExercise = new Map<string, { item: TodayPlanSessionModelPlanItem; position: number }[]>();
    params.items.forEach((item, position) => {
      if (params.isCardioItem(item)) return;
      const exercise = String(item.exercise || "");
      if (!exercise) return;
      const cards = byExercise.get(exercise) || [];
      cards.push({ item, position });
      byExercise.set(exercise, cards);
    });
    for (const [exercise, cards] of byExercise) {
      const logged = params.loggedByEx[exercise] || [];
      let cursor = 0;
      cards.forEach((card, ordinal) => {
        const isLast = ordinal === cards.length - 1;
        const budget = Number(card.item.sets) || 0;
        const remaining = Math.max(0, logged.length - cursor);
        const take = isLast ? remaining : Math.min(budget, remaining);
        const sets = logged.slice(cursor, cursor + take);
        cursor += sets.length;
        attribution.set(card.item, {
          key: cards.length > 1 ? `${exercise}#${card.position}` : exercise,
          exercise,
          sets,
          siblings: cards.length,
        });
      });
    }
    return attribution;
  }

  function selectedPlanDay(state: TodayPlanSessionModelState, revealBlank: boolean): TodayPlanSessionModelPlanDay {
    if (revealBlank && state.day === null) return { day_number: 0, name: "", items: [] };
    return state.plan.find((day) => day.day_number === state.day) || state.plan[0] || { day_number: 0, name: "", items: [] };
  }

  function matchCardioEfforts(
    items: TodayPlanSessionModelPlanItem[],
    efforts: TodayPlanSessionModelCardioEffort[],
    matches: (item: TodayPlanSessionModelPlanItem, effort: TodayPlanSessionModelCardioEffort | null | undefined) => boolean,
  ): Map<TodayPlanSessionModelPlanItem, TodayPlanSessionModelCardioEffort> {
    const matched = new Map<TodayPlanSessionModelPlanItem, TodayPlanSessionModelCardioEffort>();
    if (!items.length || !efforts.length) return matched;
    const pool = [...efforts];
    for (const item of items) {
      const index = pool.findIndex((effort) => matches(item, effort));
      if (index >= 0) matched.set(item, pool.splice(index, 1)[0]);
    }
    return matched;
  }

  function itemGroups(params: {
    items: TodayPlanSessionModelPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>;
    matchedCardio: Map<TodayPlanSessionModelPlanItem, TodayPlanSessionModelCardioEffort>;
    skips: unknown[];
    isCardioItem(item: TodayPlanSessionModelPlanItem): boolean;
    cardioLabel(item: TodayPlanSessionModelPlanItem): string;
  }): TodayPlanSessionItemGroups {
    const planNames = new Set(params.items.filter((item) => !params.isCardioItem(item) && item.exercise).map((item) => String(item.exercise)));
    const skippedSet = new Set((params.skips || []).map((name) => String(name).toLowerCase()));
    const isSkipped = (item: TodayPlanSessionModelPlanItem) =>
      params.isCardioItem(item)
        ? skippedSet.has(params.cardioLabel(item).toLowerCase()) && !params.matchedCardio.has(item)
        : !!item.exercise && skippedSet.has(String(item.exercise).toLowerCase()) && !(params.loggedByEx[String(item.exercise)] || []).length;
    const activeItems = params.items.filter((item) => !isSkipped(item));
    const skippedItems = params.items.filter(isSkipped);
    const cardioItems = activeItems.filter(params.isCardioItem);
    const strengthItems = activeItems.filter((item) => !params.isCardioItem(item));
    const planEx = activeItems.filter((item) => !params.isCardioItem(item) && item.exercise).map((item) => String(item.exercise));
    const offPlanEx = Object.keys(params.loggedByEx).filter((name) => !planNames.has(name));
    return { planNames, activeItems, skippedItems, cardioItems, strengthItems, planEx, offPlanEx };
  }

  function prunePendingOffPlan(
    state: TodayPlanSessionModelState,
    planNames: Set<string>,
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>,
  ): TodayPlanSessionModelPendingOffPlan[] {
    const planLower = new Set([...planNames].map((name) => name.toLowerCase()));
    const loggedLower = new Set(Object.keys(loggedByEx).map((name) => name.toLowerCase()));
    const pending = state.pendingOffPlan?.[state.logDate] ?? [];
    const kept = pending.filter((item) =>
      item && item.name && !planLower.has(item.name.toLowerCase()) && !loggedLower.has(item.name.toLowerCase())
    );
    if (state.pendingOffPlan && state.pendingOffPlan[state.logDate]) state.pendingOffPlan[state.logDate] = kept;
    return kept;
  }

  function finiteOrNull(value: unknown): number | null {
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  }

  function prefillFor(
    item: TodayPlanSessionModelPlanItem,
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>,
    lastSets: Record<string, Record<string, unknown> | null>,
    rx?: TodayPlanSessionModelPrescription | null,
    attributed?: TodayPlanSessionCardAttribution | null,
  ): TodayPlanSessionModelPrefill {
    const exercise = String(item.exercise || "");
    // Only the sets THIS card claimed. Reading the name-keyed pile instead is what
    // loaded a back-off card with the near-max single the athlete had just hit.
    const logged = attributed ? attributed.sets : loggedByEx[exercise] || [];
    if (logged.length) {
      const set = logged[logged.length - 1];
      return { weight: set.weight, reps: set.reps, rir: set.rir, duration_sec: set.duration_sec ?? null };
    }
    // A card sharing its exercise name with another card today cannot trust a
    // name-keyed history row to describe ITS dose — one "last time" would open the
    // top single and its back-off block on the same number. Its own prescribed
    // target is the only authorized start.
    if (attributed && attributed.siblings > 1) {
      const own = {
        weight: item.target_weight ?? null,
        reps: item.rep_low ?? null,
        rir: null,
        duration_sec: item.target_seconds ?? null,
      };
      if (own.weight != null || own.reps != null || own.duration_sec != null) return own;
    }
    const last = lastSets[exercise];
    if (last) return { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
    // Last resort: a rotated-in lift can arrive with target_weight NULL and no
    // history under its own name. The server's own grounded suggestion is then the
    // only honest number to start from — never invent one, and never overwrite a
    // deliberate NULL weight (bodyweight) with anything the server didn't produce.
    const suggested = rx && typeof rx.suggested === "object" && rx.suggested ? rx.suggested : null;
    return {
      weight: item.target_weight ?? finiteOrNull(suggested?.weight),
      reps: item.rep_low ?? finiteOrNull(suggested?.rep_low),
      rir: null,
      duration_sec: item.target_seconds ?? finiteOrNull(suggested?.seconds),
    };
  }

  const CAIRN_TODAY_PLAN_SESSION_MODEL: TodayPlanSessionModelApi = {
    planItems,
    groupLoggedSets,
    cardAttribution,
    selectedPlanDay,
    matchCardioEfforts,
    itemGroups,
    prunePendingOffPlan,
    prefillFor,
  };

  Object.assign(globalThis, { CairnTodayPlanSessionModel: CAIRN_TODAY_PLAN_SESSION_MODEL });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSessionModel: CAIRN_TODAY_PLAN_SESSION_MODEL });
  }
})();

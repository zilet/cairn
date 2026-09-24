// @ts-check
// Today plan/session model: deterministic selected-day, set grouping, item
// partitioning, pending off-plan pruning, and prefill decisions.

type TodayPlanSessionModelPlanItem = import("../contracts/client.js").ClientPlanItem & {
  fromPlan?: boolean;
  reach?: { weight?: unknown; reps?: unknown; note?: unknown; amrap?: unknown } | null;
  /** Leading top-set sets folded into this card (see foldTopSetCards); `sets` counts them. */
  top_sets?: number;
  /** An agent-composed one-set single: the lift whose block it leads (never a reach). */
  top_set_of?: string | null;
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
type TodayPlanSessionModelPrescription = Partial<import("../contracts/client.js").ClientPrescription>;
type TodayPlanSessionModelPendingOffPlan = { name: string; mode?: string | null };
type TodayPlanSessionModelPrefill = { weight: unknown; reps: unknown; rir: unknown; duration_sec?: unknown };
type TodayPlanSessionModelState = {
  logDate: string;
  day: number | null;
  /** True when the server said today is a calendar run or rest day (no lift selected). */
  calendarDay?: boolean;
  plan: TodayPlanSessionModelPlanDay[];
  pendingOffPlan?: Record<string, TodayPlanSessionModelPendingOffPlan[]>;
};
type TodayPlanSessionItemGroups = {
  planNames: Set<string>;
  activeItems: TodayPlanSessionModelPlanItem[];
  skippedItems: TodayPlanSessionModelPlanItem[];
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
  }): Map<TodayPlanSessionModelPlanItem, TodayPlanSessionCardAttribution>;
  groupLoggedSets(session: TodayPlanSessionModelSession | null | undefined): Record<string, TodayPlanSessionModelLoggedSet[]>;
  selectedPlanDay(state: TodayPlanSessionModelState, revealBlank: boolean): TodayPlanSessionModelPlanDay;
  itemGroups(params: {
    items: TodayPlanSessionModelPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>;
    skips: unknown[];
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
  // A plan day holds lifts only; every run lives in Plan -> Endurance. The server
  // no longer sends a cardio item, but a cached plan or an older composition
  // snapshot still can, so the lift card and the session drop it HERE, the one
  // door every Today/Session item list comes through. Inline rather than the
  // shared isCardioItem: this model also loads on its own.
  function isRunItem(item: unknown): boolean {
    return !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "cardio";
  }

  function planItems(day: TodayPlanSessionModelPlanDay | null | undefined): TodayPlanSessionModelPlanItem[] {
    return Array.isArray(day?.items) ? foldTopSetCards(day.items.filter((item) => !isRunItem(item))) : [];
  }

  function sameLift(a: TodayPlanSessionModelPlanItem, b: TodayPlanSessionModelPlanItem): boolean {
    const left = String(a.exercise || "").trim().toLowerCase();
    return !!left && left === String(b.exercise || "").trim().toLowerCase();
  }

  // A server top set — the day's reach, or a peak single — arrives as its own one-set
  // item directly ahead of the back-off block of the SAME lift. Two cards with one
  // name read as a duplicate exercise, so the card list folds them: ONE card whose
  // first set is the top set (its own "Top set" line and prefill) and whose remaining
  // sets are the block. `sets` counts both, so progress and completion stay the
  // server's total; `top_sets` lets the header print the block's own dose. The stored
  // composition is untouched — this is how the card reads it.
  function foldTopSetCards(items: TodayPlanSessionModelPlanItem[]): TodayPlanSessionModelPlanItem[] {
    const out: TodayPlanSessionModelPlanItem[] = [];
    for (let index = 0; index < items.length; index++) {
      const top = items[index];
      const block = items[index + 1];
      const reach = top?.reach && typeof top.reach === "object" ? top.reach : null;
      // The server's reach/peak single, or an agent's single that names its block and
      // really is heavier than it.
      const agentSingle =
        !reach &&
        !!top?.top_set_of &&
        !!block &&
        sameLift({ exercise: top.top_set_of } as TodayPlanSessionModelPlanItem, block) &&
        finiteOrNull(top.target_weight) != null &&
        finiteOrNull(block.target_weight) != null &&
        Number(top.target_weight) > Number(block.target_weight);
      const topWeight = reach ? finiteOrNull(reach.weight) : agentSingle ? finiteOrNull(top.target_weight) : null;
      const foldable =
        topWeight != null &&
        Number(top.sets) === 1 &&
        !!block &&
        sameLift(top, block) &&
        !block.reach &&
        !(Number(block.top_sets) > 0);
      if (!foldable || !block) {
        out.push(top);
        continue;
      }
      // `reach` here is the card's display shape for its first set (label, prefill);
      // it is never written back.
      out.push({
        ...block,
        sets: (Number(block.sets) || 0) + 1,
        top_sets: 1,
        reach: {
          weight: topWeight,
          reps: finiteOrNull(reach?.reps) ?? finiteOrNull(top.rep_low),
          note: reach?.note ?? top.note ?? null,
        },
      });
      index++;
    }
    return out;
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
  }): Map<TodayPlanSessionModelPlanItem, TodayPlanSessionCardAttribution> {
    const attribution = new Map<TodayPlanSessionModelPlanItem, TodayPlanSessionCardAttribution>();
    const byExercise = new Map<string, { item: TodayPlanSessionModelPlanItem; position: number }[]>();
    params.items.forEach((item, position) => {
      if (isRunItem(item)) return;
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
    if ((revealBlank || state.calendarDay) && state.day === null) return { day_number: 0, name: "", items: [] };
    return state.plan.find((day) => day.day_number === state.day) || state.plan[0] || { day_number: 0, name: "", items: [] };
  }

  function itemGroups(params: {
    items: TodayPlanSessionModelPlanItem[];
    loggedByEx: Record<string, TodayPlanSessionModelLoggedSet[]>;
    skips: unknown[];
  }): TodayPlanSessionItemGroups {
    const items = params.items.filter((item) => !isRunItem(item));
    const planNames = new Set(items.filter((item) => item.exercise).map((item) => String(item.exercise)));
    const skippedSet = new Set((params.skips || []).map((name) => String(name).toLowerCase()));
    const isSkipped = (item: TodayPlanSessionModelPlanItem) =>
      !!item.exercise && skippedSet.has(String(item.exercise).toLowerCase()) && !(params.loggedByEx[String(item.exercise)] || []).length;
    const activeItems = items.filter((item) => !isSkipped(item));
    const skippedItems = items.filter(isSkipped);
    const strengthItems = activeItems;
    const planEx = activeItems.filter((item) => item.exercise).map((item) => String(item.exercise));
    const offPlanEx = Object.keys(params.loggedByEx).filter((name) => !planNames.has(name));
    return { planNames, activeItems, skippedItems, strengthItems, planEx, offPlanEx };
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

  function reachForCard(
    item: TodayPlanSessionModelPlanItem,
    rx?: TodayPlanSessionModelPrescription | null,
    attributed?: TodayPlanSessionCardAttribution | null,
  ): { weight: number | null; reps: number | null } | null {
    const own = item.reach && typeof item.reach === "object" ? item.reach as Record<string, unknown> : null;
    if (own && (finiteOrNull(own.weight) != null || finiteOrNull(own.reps) != null)) {
      return { weight: finiteOrNull(own.weight), reps: finiteOrNull(own.reps) };
    }
    // A split card (peak/reach item + back-off) already carries its own target.
    // The name-keyed rx.top_set describes the FIRST card, never the block.
    if (attributed && attributed.siblings > 1) return null;
    const top = rx && rx.top_set && typeof rx.top_set === "object" ? rx.top_set as unknown as Record<string, unknown> : null;
    if (top && (finiteOrNull(top.weight) != null || finiteOrNull(top.reps) != null)) {
      return { weight: finiteOrNull(top.weight), reps: finiteOrNull(top.reps) };
    }
    return null;
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
    const reach = reachForCard(item, rx, attributed);
    if (logged.length) {
      // After the reach set is in, remaining rows on a mixed card open at the
      // working weight — not at the heavier look the athlete just logged.
      if (reach && Number(item.sets) > 1) {
        return {
          weight: item.target_weight ?? null,
          reps: item.rep_low ?? null,
          rir: null,
          duration_sec: item.target_seconds ?? null,
        };
      }
      // The next set opens at the one just logged — but never at its RIR. RIR is the
      // athlete's own read of THIS set; a copied one is evidence nobody gave.
      const set = logged[logged.length - 1];
      return { weight: set.weight, reps: set.reps, rir: null, duration_sec: set.duration_sec ?? null };
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
    if (reach) {
      return {
        weight: reach.weight ?? item.target_weight ?? null,
        reps: reach.reps ?? item.rep_low ?? null,
        rir: null,
        duration_sec: item.target_seconds ?? null,
      };
    }
    // One tap logs what the card SHOWS. The prescription is the card's headline dose
    // (the server's grounded number when the stored target is being re-grounded, i.e.
    // the "hold this load" line), so it leads; last time is the reference line under
    // the card, and only fills what the prescription leaves open. RIR always opens
    // blank: it is optional, and a copied one fabricates evidence.
    const suggested = rx && typeof rx.suggested === "object" && rx.suggested ? rx.suggested : null;
    const regrounding = !!rx && (rx as { reground?: unknown }).reground === true;
    const shownWeight = regrounding
      ? (finiteOrNull(suggested?.weight) ?? item.target_weight ?? null)
      : (item.target_weight ?? finiteOrNull(suggested?.weight));
    const shownReps = item.rep_low ?? finiteOrNull(suggested?.rep_low);
    const shownSeconds = item.target_seconds ?? finiteOrNull(suggested?.seconds);
    const last = lastSets[exercise];
    return {
      weight: shownWeight ?? (last ? last.weight : null) ?? null,
      reps: shownReps ?? (last ? last.reps : null) ?? null,
      rir: null,
      duration_sec: shownSeconds ?? (last ? (last.duration_sec ?? null) : null),
    };
  }

  const CAIRN_TODAY_PLAN_SESSION_MODEL: TodayPlanSessionModelApi = {
    planItems,
    groupLoggedSets,
    cardAttribution,
    selectedPlanDay,
    itemGroups,
    prunePendingOffPlan,
    prefillFor,
  };

  Object.assign(globalThis, { CairnTodayPlanSessionModel: CAIRN_TODAY_PLAN_SESSION_MODEL });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPlanSessionModel: CAIRN_TODAY_PLAN_SESSION_MODEL });
  }
})();

// @ts-check
// Today render-state decisions: derive the high-level visible mode for the day
// before the screen assembles markup.

type TodayRenderStateDayRead = import("../contracts/client.js").ClientDayRead & {
  _provisional?: boolean;
  override?: string | null;
};
type TodayRenderStatePlanItem = import("../contracts/client.js").ClientPlanItem;
type TodayRenderStatePlanDay = {
  items?: TodayRenderStatePlanItem[] | null;
};
type TodayRenderStateSession = import("../contracts/client.js").ClientTrainingSession & {
  garmin?: unknown;
};
type TodayRenderStatePlanReveal = {
  date?: string | null;
  on?: boolean | null;
};
type TodayRenderStateInput = {
  logDate: string;
  session: TodayRenderStateSession | null | undefined;
  day: TodayRenderStatePlanDay | null | undefined;
  read: Partial<TodayRenderStateDayRead> | null | undefined;
  isToday: boolean;
  planReveal?: TodayRenderStatePlanReveal | null;
};
type TodayRenderStateResult = {
  hasLoggedSets: boolean;
  hasPlanDay: boolean;
  revealOn: boolean;
  isFinished: boolean;
  hasGarmin: boolean;
  showPlan: boolean;
  showDone: boolean;
};
type TodayRenderStateApi = {
  derive(input: TodayRenderStateInput): TodayRenderStateResult;
};

(() => {
  function derive(input: TodayRenderStateInput): TodayRenderStateResult {
    const hasLoggedSets = !!(input.session && (input.session.sets || []).length);
    const hasPlanDay = !!(input.day?.items || []).length;
    const revealOn = !!(
      input.planReveal &&
      input.planReveal.date === input.logDate &&
      input.planReveal.on
    );
    const isFinished = !!(input.session && input.session.finished_at);
    const hasGarmin = !!(input.session && input.session.garmin);
    const showPlan = !input.isToday || hasLoggedSets || hasGarmin || revealOn || input.read?.kind === "train";
    const showDone = isFinished && input.isToday && !revealOn;

    return {
      hasLoggedSets,
      hasPlanDay,
      revealOn,
      isFinished,
      hasGarmin,
      showPlan,
      showDone,
    };
  }

  const CAIRN_TODAY_RENDER_STATE: TodayRenderStateApi = { derive };

  Object.assign(globalThis, { CairnTodayRenderState: CAIRN_TODAY_RENDER_STATE });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayRenderState: CAIRN_TODAY_RENDER_STATE });
  }
})();

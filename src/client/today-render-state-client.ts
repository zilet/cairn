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
  // The accepted daily session. When the athlete CHOSE it (one they or an AI app over
  // MCP wrote — athlete_override, even an empty "open session" — or an accepted
  // suggestion that holds work; the server's ChosenSession, src/repo/today-strength-line.ts),
  // that is the same commitment as "Train anyway": its launch card stands under any read.
  // An accepted suggestion with nothing in it (a rest read's "Rest day") opens nothing.
  // Only the fallback for a Today whose aggregate carried no `openSession`.
  dailySession?: { source?: unknown; items?: unknown[] | null } | null;
  // The server's one fact about today's session (`open_session` on the Today aggregate).
  // When present it is the hero under ANY read: its `label` is the one action, and
  // `chosen` says whether the quiet read is a headline or only the caveat line.
  openSession?: import("../contracts/client-api.js").ClientOpenSession | null;
};
type TodayRenderStateResult = {
  hasLoggedSets: boolean;
  hasPlanDay: boolean;
  revealOn: boolean;
  isFinished: boolean;
  hasGarmin: boolean;
  showPlan: boolean;
  showDone: boolean;
  // The open session's hero; null when the date has none.
  hero: { label: string; action: "start" | "continue"; chosen: boolean } | null;
  // False once the athlete chose the session: the rest/easy read is then a caveat only.
  readLeads: boolean;
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
    const open = input.openSession ?? null;
    const source = input.dailySession?.source;
    const chosenSession =
      !!open ||
      source === "athlete_override" ||
      (source === "agent_suggest" && !!input.dailySession?.items?.length);
    const showPlan =
      !input.isToday || hasLoggedSets || hasGarmin || revealOn || chosenSession || input.read?.kind === "train";
    const showDone = isFinished && input.isToday && !revealOn;

    return {
      hasLoggedSets,
      hasPlanDay,
      revealOn,
      isFinished,
      hasGarmin,
      showPlan,
      showDone,
      hero: open ? { label: open.label, action: open.action, chosen: !!open.chosen } : null,
      readLeads: !open?.chosen,
    };
  }

  const CAIRN_TODAY_RENDER_STATE: TodayRenderStateApi = { derive };

  Object.assign(globalThis, { CairnTodayRenderState: CAIRN_TODAY_RENDER_STATE });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayRenderState: CAIRN_TODAY_RENDER_STATE });
  }
})();

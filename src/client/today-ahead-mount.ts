// @ts-check
// Mounts what the redesigned Today paints after its frame: the one Horizon glance line
// under the Brief (eager, CairnTodayPathController) and the rest — the push line and
// offer, the week strip, the overnight digest, Body & recovery's gauges / sparkline,
// the new connection — from the
// lazy today-ahead bundle (CairnTodayAhead), reached only through withBundle. Warm, the
// bundle mounts in the same turn; cold, the frame's empty slots fill once it lands.
{
  type TodayAheadMountRail = {
    state: { planJump?: string | null; standSeg?: string | null; horizonSeg?: ClientHorizonSection | null };
    api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
    activateTab(tab: string): unknown;
    gotoChatWith(text: string): unknown;
    toast(message: string): void;
    invalidate(key: string): void;
    refreshToday(options: { soft: boolean }): unknown;
  };
  type TodayAheadMountOptions = {
    date: string;
    read: unknown;
    /** The Brief's read as it stands NOW (an in-place upgrade may have replaced `read`). */
    currentRead?(): unknown;
    agenda: Promise<unknown>;
    /** Still the same Today render (tab, date and poll token unchanged). */
    isCurrent(): boolean;
    rail: TodayAheadMountRail;
  };

  function mountTodayAhead(view: Element, opts: TodayAheadMountOptions): void {
    const rail = opts.rail;
    const go = (tab: string, set?: () => void) => () => {
      set?.();
      rail.activateTab(tab);
    };
    const pathSlot = view.querySelector("#todayPathSlot");
    if (pathSlot) {
      CairnTodayPathController.mount(pathSlot, {
        date: opts.date,
        peek: (key) => peekCached(key) as ReturnType<Parameters<typeof CairnTodayPathController.mount>[1]["peek"]>,
        load: (path, options) => cachedApi(path, options) as never,
        // The glance opens Horizon on its Week (the default landing, never a remembered section).
        openHorizon: go("horizon", () => (rail.state.horizonSeg = null)),
      });
    }
    void withBundle("today-ahead", () => {
      const main = view.querySelector(".today-main");
      if (!opts.isCurrent() || !main) return;
      CairnTodayAhead.mount(main, {
        date: opts.date,
        read: (opts.read && typeof opts.read === "object" ? opts.read : null) as never,
        currentRead: () => (opts.currentRead ? opts.currentRead() : opts.read),
        agenda: () => opts.agenda,
        peek: (key) => peekCached(key),
        load: (path, options) => cachedApi(path, options) as Promise<unknown>,
        api: rail.api,
        toast: rail.toast,
        gotoChatWith: (text) => void rail.gotoChatWith(text),
        openChanges: go("plan", () => (rail.state.planJump = "coach")),
        openPlanCoach: go("plan", () => (rail.state.planJump = "coach")),
        refreshToday: () => rail.refreshToday({ soft: true }),
        invalidate: (key) => rail.invalidate(key),
      });
    });
  }

  const CAIRN_TODAY_AHEAD_MOUNT = { mount: mountTodayAhead };

  Object.assign(globalThis, { CairnTodayAheadMount: CAIRN_TODAY_AHEAD_MOUNT });
}

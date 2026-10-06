// @ts-check
// Opening a day (v2 wave 7, "Today is Home"). EAGER, and deliberately tiny: the day
// view itself (day-record-client.ts) lives in the lazy "day" bundle, but a day is
// opened from Today, Train and Horizon alike, so the opener must always be there.
//
// Any element carrying `data-open-day="YYYY-MM-DD"` opens its day through the one
// delegated listener below, so a surface in any bundle needs no reference to the day
// view at all. A day that is today opens Today itself.
type DayOpenOrigin = { tab: ClientTabName; label: string };

{
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  // Where the day was opened from, so its back link says so ("‹ Train") and steps
  // back through history. Unknown on a cold deep link: then Today, its home.
  let from: DayOpenOrigin | null = null;

  function homeFor(tab: ClientTabName): ClientHomeName {
    const routes = window.CairnRoutes;
    const home =
      routes && typeof routes.homeOf === "function"
        ? routes.homeOf(tab, tab === "plan" ? state.planJump || state.planSeg : tab === "day" ? state.dayHome : null)
        : "today";
    return (home || "today") as ClientHomeName;
  }

  /** "Train" — a home as its tab-bar button names it. */
  function homeLabel(home: unknown): string {
    return String(home || "today").replace(/^./, (c) => c.toUpperCase());
  }

  /**
   * Open a day: today opens Today; any other day opens its record or preview. `home`
   * reads the day under another home than the one it was opened from (Today's strip
   * opens a day "in Horizon"); the back link still names where it was opened.
   */
  function openDay(date: unknown, opts?: { home?: ClientHomeName }): void {
    const iso = String(date || "").slice(0, 10);
    if (!ISO.test(iso)) return;
    if (iso === localISO()) {
      activateTab("today");
      return;
    }
    if (state.tab !== "day") {
      // The day is read UNDER the home it was opened from: the route carries it
      // (/app/train/day), the tab bar keeps it lit and the back link names it.
      const home = homeFor(state.tab);
      from = { tab: state.tab, label: homeLabel(home) };
      state.dayHome = opts?.home || home;
    }
    state.dayDate = iso;
    try {
      window.scrollTo(0, 0);
    } catch {}
    // Stepping between days inside the view replaces history rather than stacking a
    // back-entry per day, so Back returns to where the day was opened from.
    if (state.tab === "day") {
      if (typeof syncRouteFromState === "function") syncRouteFromState("replace");
      void renderTab("day");
      return;
    }
    activateTab("day");
  }

  function origin(): DayOpenOrigin | null {
    return from;
  }

  function takeOrigin(): DayOpenOrigin | null {
    const was = from;
    from = null;
    return was;
  }

  // One delegated opener for every `data-open-day` in the app (a week strip's day,
  // a calendar square, a Horizon week row, the day view's own stepper). Keyboard: a
  // non-button row carrying it takes Enter/Space.
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const el = target?.closest<HTMLElement>("[data-open-day]");
      if (!el || el.hasAttribute("disabled")) return;
      event.preventDefault();
      openDay(el.dataset.openDay);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target instanceof Element ? event.target : null;
      const el = target?.closest<HTMLElement>("[data-open-day]");
      if (!el || el.tagName === "BUTTON" || el.tagName === "A") return;
      event.preventDefault();
      openDay(el.dataset.openDay);
    });
  }

  const CAIRN_DAY_OPEN = { openDay, origin, takeOrigin, homeLabel };
  Object.assign(globalThis, { CairnDayOpen: CAIRN_DAY_OPEN, openDay });
}

// @ts-check
// App-level local-day rollover watcher. state.logDate is set ONCE at boot
// (01-core/state.ts). A PWA resumed from memory after midnight — or simply left
// open across midnight — keeps yesterday's logDate and its stale Brief until
// something re-measures the date. This re-measures localISO() on resume
// (visibilitychange -> visible, pageshow) AND on a timer armed for just past local
// midnight; when the day has genuinely rolled AND the user hasn't manually picked a
// date, it advances state.logDate, clears the stale Brief, and re-renders the active
// tab through the normal tab entry so Today repaints fresh for the new day. Its own
// module (NOT bolted onto the viewport guards, whose concern is keyboard geometry)
// so the date concern stays isolated and unit-testable.

// Pure decision, extracted so the rollover rule is deterministically tested with no
// DOM, timer, or real clock. Returns the date to roll to, or null to leave as-is:
//   - no measurable date, or still the same calendar day -> nothing to do
//   - the user is deliberately looking AHEAD of the calendar -> never override it
//   - the user deliberately opened a PAST day -> never override it either; logging a
//     Saturday workout on Monday must not silently re-point the next set at Monday.
// `dayPickedOn` is the anchor that separates those two: it records the calendar day
// that was measured WHEN the date was picked. A pick made on the day it names was
// "today" at the time, and merely went stale when midnight passed — that one catches
// up. A pick whose shown date never was the measured day is a deliberate visit and
// stands. Without an anchor we cannot tell, so the picked date stands.
function dayRolloverTarget(
  current: string,
  measured: string,
  dayPicked: boolean,
  dayPickedOn?: string | null
): string | null {
  if (!measured || measured === current) return null;
  if (dayPicked && (current > measured || current !== dayPickedOn)) return null;
  return measured;
}

{
  type RolloverState = {
    tab?: unknown;
    logDate: string;
    day?: number | null;
    dayPicked?: boolean;
    dayPickedOn?: string | null;
    brief?: unknown;
  };
  const g = globalThis as typeof globalThis & {
    state?: RolloverState;
    localISO?: (d?: Date) => string;
    activateTab?: (name: unknown, opts?: { syncRoute?: boolean }) => void;
    renderToday?: (opts?: { soft?: boolean }) => unknown;
    syncRouteFromState?: (mode?: "push" | "replace") => void;
  };

  let midnightTimer: ReturnType<typeof setTimeout> | null = null;

  // ms until just AFTER the next local midnight (a small cushion so we fire on the
  // new day, never a hair before the boundary).
  function msUntilNextLocalMidnight(now = new Date()): number {
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // start of tomorrow, local
    return Math.max(0, next.getTime() - now.getTime()) + 1000;
  }

  // One timestamp, no polling: the moment this watcher last confirmed the active
  // tab fresh (a rollover repaint, a stale-paint repaint, or simply a foreground
  // event that found nothing stale). A phone locked for a long stretch and
  // unlocked on the SAME calendar day never trips dayRolloverTarget — nothing else
  // re-fetches the tab on its own — so a return from more than 5 minutes away
  // still deserves a repaint; the SWR cache underneath paints the (instant) cached
  // snapshot immediately and revalidates quietly behind it, same as any other
  // tab entry.
  const STALE_PAINT_MS = 5 * 60 * 1000;
  let lastPaintAt = Date.now();

  // visibilitychange and pageshow arrive together on a resume: one repaint, not two. And a Today
  // being typed into (the weigh-in field) or covered by a sheet is never rebuilt under the hand.
  const REPAINT_COALESCE_MS = 1500;
  let lastTodayRepaintAt = 0;
  function todayRepaintVerdict(now: number, last: number, editing: boolean): "go" | "skip" | "defer" {
    if (now - last < REPAINT_COALESCE_MS) return "skip";
    return editing ? "defer" : "go";
  }
  function editingToday(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return true;
    return !!document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])');
  }
  let repaintDeferred = false;
  function deferTodayRepaint(): void {
    if (repaintDeferred) return;
    repaintDeferred = true;
    document.addEventListener(
      "focusout",
      () => {
        setTimeout(() => {
          if (editingToday()) return;
          repaintDeferred = false;
          repaintStaleActiveTab();
        }, 300);
      },
      { once: true },
    );
  }

  function repaintStaleActiveTab(): void {
    const s = g.state;
    const now = Date.now();
    // Today is where another device's change shows up (a session opened on the laptop,
    // then the phone foregrounded a moment later), so coming back to it ALWAYS
    // revalidates from the network: the cached Today paints first, quietly, and the
    // aggregate's answer settles in over it — never a spinner, never a rebuild under
    // your hands. Every other tab keeps the long window: a phone locked between sets
    // must not rebuild the log under you.
    if (s?.tab === "today" && typeof g.renderToday === "function") {
      const verdict = todayRepaintVerdict(now, lastTodayRepaintAt, editingToday());
      if (verdict === "defer") deferTodayRepaint();
      if (verdict !== "go") return;
      repaintDeferred = false;
      lastPaintAt = now;
      lastTodayRepaintAt = now;
      void g.renderToday({ soft: true });
      return;
    }
    const stale = now - lastPaintAt >= STALE_PAINT_MS;
    lastPaintAt = now;
    if (!stale || !s || typeof g.activateTab !== "function") return;
    g.activateTab(s.tab, { syncRoute: false });
  }

  // Returns whether a day rollover actually repainted, so callers can skip the
  // separate stale-paint repaint above (a rollover already repaints fresh).
  function checkRollover(): boolean {
    const s = g.state;
    if (!s || typeof g.localISO !== "function") return false;
    const target = dayRolloverTarget(s.logDate, g.localISO(), !!s.dayPicked, s.dayPickedOn ?? null);
    if (!target) return false;
    lastPaintAt = Date.now();
    s.logDate = target;
    // Landing on the new day is the same arrival as "Back to today": the pick that
    // named yesterday is spent, and the plan day chosen under it would otherwise
    // survive as a stale selection Today paints and openSession reads as a manual
    // pick. Mirror that handler rather than advancing the date alone.
    s.dayPicked = false;
    s.dayPickedOn = null;
    s.day = null;
    // Clear the stale Brief so Today repaints from the new day. The Brief
    // localStorage cache (cairn.brief.v1) is already date-guarded, so it won't
    // repaint yesterday's read once logDate is right.
    s.brief = null;
    // Re-render the active tab through the tab entry the router/tabs already use.
    if (typeof g.activateTab === "function") g.activateTab(s.tab, { syncRoute: false });
    // The URL still carries the date we just left. Replace it (never push — this is a
    // correction, not navigation) so the next cold launch doesn't restore yesterday.
    if (typeof g.syncRouteFromState === "function") g.syncRouteFromState("replace");
    return true;
  }

  // The single entry both foreground listeners call: a rollover already repaints
  // fresh, so the stale-paint check only runs when the day itself didn't change.
  function checkFreshness(): void {
    if (!checkRollover()) repaintStaleActiveTab();
  }

  function armMidnightTimer(): void {
    if (midnightTimer) clearTimeout(midnightTimer);
    const t = setTimeout(() => {
      midnightTimer = null;
      checkRollover();
      armMidnightTimer(); // re-arm for the following midnight
    }, msUntilNextLocalMidnight());
    (t as { unref?: () => void }).unref?.();
    midnightTimer = t;
  }

  // Coming back to the app is when a just-finished run is most wanted on screen. Ask
  // the server (POST /api/garmin/check) whether the watch has sent something Cairn
  // has not stored; it answers at once, holds its own five-minute floor and pulls only
  // when there is news. Fire-and-forget through a plain fetch, never api(): this is
  // not the person's request, so a 401 must not open sign-in and a failure says
  // nothing. The page's own minute floor just keeps a flurry of foregrounds off the
  // wire entirely.
  const GARMIN_NUDGE_MIN_MS = 60 * 1000;
  let lastGarminNudgeAt = 0;
  function nudgeGarminArrival(): void {
    const now = Date.now();
    if (now - lastGarminNudgeAt < GARMIN_NUDGE_MIN_MS || typeof fetch !== "function") return;
    lastGarminNudgeAt = now;
    const headers: Record<string, string> = {};
    try {
      // The same two headers api() sends: the optional stored token and the device zone.
      const shared = g as { authToken?: () => string; deviceTimeZone?: () => string };
      const token = shared.authToken?.();
      if (token) headers["X-Cairn-Token"] = token;
      const tz = shared.deviceTimeZone?.();
      if (tz) headers["X-Cairn-TZ"] = tz;
      fetch("/api/garmin/check", { method: "POST", credentials: "same-origin", headers }).catch(() => {});
    } catch {}
  }

  function installDayRolloverWatcher(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      checkFreshness();
      nudgeGarminArrival();
    });
    window.addEventListener("pageshow", () => checkFreshness());
    armMidnightTimer();
  }

  Object.assign(globalThis, { installDayRolloverWatcher, dayRolloverTarget, todayRepaintVerdict });

  if (typeof window !== "undefined") {
    (window as typeof window & { installDayRolloverWatcher?: () => void }).installDayRolloverWatcher =
      installDayRolloverWatcher;
  }
}

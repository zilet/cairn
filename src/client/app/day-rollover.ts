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
//   - the user is deliberately browsing another day (dayPicked) -> never override it
//   - no measurable date, or still the same calendar day -> nothing to do
function dayRolloverTarget(current: string, measured: string, dayPicked: boolean): string | null {
  if (dayPicked) return null;
  if (!measured || measured === current) return null;
  return measured;
}

{
  type RolloverState = { tab?: unknown; logDate: string; dayPicked?: boolean; brief?: unknown };
  const g = globalThis as typeof globalThis & {
    state?: RolloverState;
    localISO?: (d?: Date) => string;
    activateTab?: (name: unknown, opts?: { syncRoute?: boolean }) => void;
  };

  let midnightTimer: ReturnType<typeof setTimeout> | null = null;

  // ms until just AFTER the next local midnight (a small cushion so we fire on the
  // new day, never a hair before the boundary).
  function msUntilNextLocalMidnight(now = new Date()): number {
    const next = new Date(now);
    next.setHours(24, 0, 0, 0); // start of tomorrow, local
    return Math.max(0, next.getTime() - now.getTime()) + 1000;
  }

  function checkRollover(): void {
    const s = g.state;
    if (!s || typeof g.localISO !== "function") return;
    const target = dayRolloverTarget(s.logDate, g.localISO(), !!s.dayPicked);
    if (!target) return;
    s.logDate = target;
    // Clear the stale Brief so Today repaints from the new day. The Brief
    // localStorage cache (cairn.brief.v1) is already date-guarded, so it won't
    // repaint yesterday's read once logDate is right.
    s.brief = null;
    // Re-render the active tab through the tab entry the router/tabs already use.
    if (typeof g.activateTab === "function") g.activateTab(s.tab, { syncRoute: false });
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

  function installDayRolloverWatcher(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkRollover();
    });
    window.addEventListener("pageshow", () => checkRollover());
    armMidnightTimer();
  }

  Object.assign(globalThis, { installDayRolloverWatcher, dayRolloverTarget });

  if (typeof window !== "undefined") {
    (window as typeof window & { installDayRolloverWatcher?: () => void }).installDayRolloverWatcher = installDayRolloverWatcher;
  }
}

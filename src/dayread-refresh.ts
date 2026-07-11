// Recompute-on-invalidate — keep the morning Brief instant even right after a
// brain signal lands. repo.invalidateDayRead() only DELETES the cached day-read;
// the next GET /api/today-read would otherwise pay a synchronous ~90s agent run
// inline on the request path. This schedules a DEBOUNCED, COALESCED,
// fire-and-forget background recompute the moment TODAY's read is cleared, so the
// athlete's next open serves a fresh agentic read that was warmed off the request
// path (exactly like the nightly precompute + boot warm, but signal-driven).
//
// Contract (Track A / A1):
//   - never throws, never blocks or slows the synchronous write path (setTimeout,
//     unref'd so the timer can never hold the process open on its own)
//   - COALESCED: a burst of signals (e.g. a 20-set logging session) collapses to
//     ONE recompute — a new signal during the window resets/extends the debounce
//   - only when the invalidated date COVERS TODAY (device zone) — a past/future
//     invalidation never warms the live open
//   - NO usable agent -> do NOTHING (never re-cache a deterministic floor; the next
//     fetch keeps its chance to run the agent). This is also what keeps the offline
//     test suite from spawning a CLI here.
//
// The effectful edges (the "today" comparison, the agent gate, the actual
// recompute, the timer) are injectable so the debounce / coalesce / gating logic
// is unit-testable deterministically; production uses the real ones. Kept in its
// own module so repo/day-read.ts can import it with NO static cycle — the agent
// gate + the agent-running recompute are reached only via lazy dynamic import.
import { localDateISO } from "./repo/shared.js";

const DEFAULT_DEBOUNCE_MS = 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface DayReadRefreshHooks {
  // The device-zone "today" the invalidated date is compared against. Evaluated
  // synchronously inside the live request context, so localDateISO() sees the
  // request's X-Cairn-TZ zone (the same zone the cache key + next open use).
  today: () => string;
  // Cheap, SIDE-EFFECT-FREE gate: is any coaching CLI usable right now? Returning
  // false -> the recompute does nothing. (We deliberately do NOT call
  // pickAgentOrder() here — that would advance the round-robin cursor on every
  // brain-signal write.)
  agentsAvailable: () => boolean | Promise<boolean>;
  // The actual (agentic) recompute + re-cache of the canonical read for the date
  // the next open will request (recorded client zone).
  recompute: () => void | Promise<void>;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  debounceMs: number;
}

const DEFAULT_HOOKS: DayReadRefreshHooks = {
  today: () => localDateISO(),
  agentsAvailable: async () => {
    // Lazy import so this module never statically pulls in the repo barrel.
    const { getAgentConfig } = await import("./repo/settings.js");
    return getAgentConfig().some((a) => a.usable);
  },
  recompute: async () => {
    // Lazy import breaks the module cycle (repo/day-read -> here -> dayread) and
    // keeps the agent-running orchestration out of this module's static graph.
    const { precomputeDayRead, warmToday } = await import("./dayread.js");
    await precomputeDayRead(warmToday());
  },
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h),
  debounceMs: DEFAULT_DEBOUNCE_MS,
};

let hooks: DayReadRefreshHooks = { ...DEFAULT_HOOKS };
let pending: TimerHandle | null = null;
let inFlight: Promise<void> | null = null;

// Called from repo.invalidateDayRead the instant TODAY's cached read is cleared.
// Synchronous + best-effort: it only (re)arms a debounce timer and returns — the
// real (async) recompute happens later, off the write path.
export function scheduleDayReadRefresh(invalidatedDate?: string): void {
  try {
    const today = hooks.today();
    const target = invalidatedDate || today;
    if (target !== today) return; // only the live "today" open benefits from a warm recompute
    if (pending != null) hooks.clearTimer(pending); // coalesce: extend the window on a new signal
    pending = hooks.setTimer(fire, hooks.debounceMs);
  } catch {
    // Scheduling is best-effort — never let it disturb the synchronous write path.
  }
}

// A cached deterministic Brief means the safe floor did its job during a
// transient agent outage. Ensure one background retry is armed so that floor is
// self-healing, but do not extend an already-pending debounce on every screen
// render/poll. Signal invalidations above intentionally reset the window.
export function ensureDayReadRefresh(readDate?: string): void {
  try {
    const today = hooks.today();
    const target = readDate || today;
    if (target !== today || pending != null || inFlight != null) return;
    pending = hooks.setTimer(fire, hooks.debounceMs);
  } catch {
    // Best-effort recovery must never disturb the instant deterministic read.
  }
}

function fire(): void {
  pending = null;
  inFlight = runRefresh();
}

async function runRefresh(): Promise<void> {
  try {
    if (!(await hooks.agentsAvailable())) return; // no usable agent -> do nothing (see contract)
    await hooks.recompute();
  } catch {
    // A failed background warm is a calm no-op; the next fetch re-derives.
  } finally {
    inFlight = null;
  }
}

// ---- test seam (production never calls these) ----
// Override the effectful edges so the debounce / coalesce / gating logic is
// deterministically testable without real timers, a real clock, or a CLI.
export function configureDayReadRefresh(overrides: Partial<DayReadRefreshHooks>): void {
  hooks = { ...hooks, ...overrides };
}

// Await any in-flight recompute (test-only convenience after a fake timer fires).
export function flushDayReadRefresh(): Promise<void> {
  return inFlight ?? Promise.resolve();
}

// Clear any pending debounce timer AND restore default hooks. Wired into
// test/_isolate's per-test DB wipe so a timer armed in one test can never leak
// into (or fire a real recompute during) a later one.
export function resetDayReadRefresh(): void {
  if (pending != null) {
    try {
      hooks.clearTimer(pending);
    } catch {
      /* a fake/stale handle is harmless to clear */
    }
    pending = null;
  }
  inFlight = null;
  hooks = { ...DEFAULT_HOOKS };
}

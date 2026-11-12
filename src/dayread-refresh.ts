// Recompute-on-invalidate — keep the morning Brief instant even right after a
// brain signal lands. repo.invalidateDayRead() only marks the cached day-read stale
// (or deletes a row with no agent wording to keep); the next GET /api/today-read
// serves the floor or re-stamps the kept sentence, never an agent run. This
// schedules a DEBOUNCED, COALESCED, fire-and-forget background recompute the moment
// TODAY's read is invalidated, so the athlete's next open serves an agentic read
// warmed off the request path (like the nightly precompute + boot warm, but
// signal-driven) — and for an unchanged call that recompute is the prose pin, no agent.
//
// Contract (Track A / A1):
//   - never throws, never blocks or slows the synchronous write path (setTimeout,
//     unref'd so the timer can never hold the process open on its own)
//   - COALESCED: a burst of signals (e.g. a 20-set logging session) collapses to
//     ONE recompute — a new signal during the window resets/extends the debounce,
//     and a signal that lands while a recompute is ALREADY RUNNING arms exactly one
//     follow-up when that run finishes rather than stacking a second run behind it
//   - only when the invalidated date COVERS TODAY (device zone) — a past/future
//     invalidation never warms the live open
//   - NO usable agent (or a failed recompute) -> warm the DETERMINISTIC FLOOR only,
//     so an invalidated row is never left uncached until the next open. This never
//     spawns a CLI, which is also what keeps the offline test suite quiet; the
//     self-heal path (ensureDayReadRefresh) still asks the agent again later —
//     except within DAY_READ_FAILURE_BACKOFF_MINUTES of a FAILED agent attempt for
//     that date and call, so a reply that keeps breaking its contract is not paid
//     for on every open.
//
// The effectful edges (the "today" comparison, the agent gate, the actual
// recompute, the timer) are injectable so the debounce / coalesce / gating logic
// is unit-testable deterministically; production uses the real ones. Kept in its
// own module so repo/day-read.ts can import it with NO static cycle — the agent
// gate + the agent-running recompute are reached only via lazy dynamic import.
import { localDateISO } from "./repo/shared.js";
import { log } from "./log.js";

const DEFAULT_DEBOUNCE_MS = 60_000;

// How long a date's self-heal stays disarmed after its agent attempt FAILED (a
// contract rejection, a timeout, a process failure). The self-heal re-arms on every
// open of a floor row, so a day whose agent keeps breaking its contract otherwise paid
// a two-spawn retry (the reply plus its one repair) on every single open. Same window
// as week_ahead's failure backoff (WEEK_AHEAD_FAILURE_BACKOFF_MINUTES, repo/chat.ts).
export const DAY_READ_FAILURE_BACKOFF_MINUTES = 30;
const DAY_READ_FAILURE_BACKOFF_MS = DAY_READ_FAILURE_BACKOFF_MINUTES * 60_000;

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
  // The no-CLI fallback: re-cache the deterministic floor for the date the next
  // open will request, so an invalidated row is never left uncached. Called
  // instead of `recompute` when no agent is usable, and as a fallback if
  // `recompute` throws.
  warmFloor: () => void | Promise<void>;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  debounceMs: number;
  // The clock the failure backoff is measured on (tests move it).
  now: () => number;
}

const DEFAULT_HOOKS: DayReadRefreshHooks = {
  today: () => localDateISO(),
  agentsAvailable: async () => {
    // Lazy import so this module never statically pulls in the repo barrel.
    const { getAgentConfig } = await import("./repo/settings.js");
    return getAgentConfig({ loginProbe: "peek" }).some((a) => a.usable);
  },
  recompute: async () => {
    // Lazy import breaks the module cycle (repo/day-read -> here -> dayread) and
    // keeps the agent-running orchestration out of this module's static graph.
    const { precomputeDayRead, warmToday } = await import("./dayread.js");
    await precomputeDayRead(warmToday());
    // The re-warm follows a write the athlete just made, and the open that follows
    // it would otherwise rebuild the whole coach context inline.
    const { prewarmCoachContext } = await import("./repo/coach.js");
    prewarmCoachContext();
  },
  warmFloor: async () => {
    // Lazy import for the same reason as `recompute` above. No agent spawn.
    const { precomputeDayReadFloor, warmToday } = await import("./dayread.js");
    precomputeDayReadFloor(warmToday());
  },
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h),
  debounceMs: DEFAULT_DEBOUNCE_MS,
  now: () => Date.now(),
};

let hooks: DayReadRefreshHooks = { ...DEFAULT_HOOKS };
let pending: TimerHandle | null = null;
let inFlight: Promise<void> | null = null;
// A signal that landed while a recompute was already running. The debounce window
// only coalesces signals that arrive BEFORE the timer fires; once the agent run is
// under way, re-arming stacked a second run behind one that had just read the same
// state — so the athlete paid twice for one change. The signal is remembered here
// instead and arms exactly ONE follow-up when the run lands, which is what keeps
// this a coalescer and not a time cooldown: nothing is ever suppressed outright.
let armAfterFlight = false;
// The last FAILED agent attempt per read date, with the prose identity it was asked
// for. Process-local on purpose (Cairn is one Node process, and a restart is a fair
// moment to try again). Only the self-heal (ensureDayReadRefresh) consults it: the
// athlete's explicit new read, a signal-driven refresh, the 04:00 precompute and an
// identity change all still ask the agent.
const agentFailures = new Map<string, { at: number; identity: string | null }>();

// computeDayRead reports how its agent attempt ended. A failure disarms the date's
// self-heal for the backoff window; a success clears it. Host congestion
// (AgentBusyError) is NOT reported here — the CLI never ran, so the next open must
// keep its defer-and-retry.
export function noteDayReadAgentFailure(date: string, identity?: string | null): void {
  try {
    agentFailures.set(date, { at: hooks.now(), identity: identity ?? null });
  } catch {
    /* bookkeeping is best-effort */
  }
}

export function clearDayReadAgentFailure(date: string): void {
  agentFailures.delete(date);
}

// Is the self-heal for this date inside its failure backoff? An identity the failed
// attempt was NOT asked for is a genuinely new call, so it is never held back.
export function dayReadSelfHealCoolingDown(date: string, identity?: string | null): boolean {
  const failure = agentFailures.get(date);
  if (!failure) return false;
  if (hooks.now() - failure.at >= DAY_READ_FAILURE_BACKOFF_MS) {
    agentFailures.delete(date);
    return false;
  }
  if (identity && failure.identity && identity !== failure.identity) return false;
  return true;
}

// Called from repo.invalidateDayRead the instant TODAY's cached read is cleared.
// Synchronous + best-effort: it only (re)arms a debounce timer and returns — the
// real (async) recompute happens later, off the write path.
export function scheduleDayReadRefresh(invalidatedDate?: string): void {
  try {
    const today = hooks.today();
    const target = invalidatedDate || today;
    if (target !== today) return; // only the live "today" open benefits from a warm recompute
    // Match ensureDayReadRefresh: never arm on top of a running recompute. Deferred,
    // not dropped — see armAfterFlight.
    if (inFlight != null) {
      armAfterFlight = true;
      return;
    }
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
// `identity` is the prose identity of the floor row being served, when the caller has
// it: a date whose agent just failed is left alone for the backoff window unless the
// row now answers a different call (dayReadSelfHealCoolingDown).
export function ensureDayReadRefresh(readDate?: string, identity?: string | null): void {
  try {
    const today = hooks.today();
    const target = readDate || today;
    if (target !== today || pending != null || inFlight != null) return;
    if (dayReadSelfHealCoolingDown(target, identity)) {
      log.debug("[brief] self-heal held: the agent failed this read recently", { date: target });
      return;
    }
    pending = hooks.setTimer(fire, hooks.debounceMs);
  } catch {
    // Best-effort recovery must never disturb the instant deterministic read.
  }
}

function fire(): void {
  pending = null;
  // The run about to start reads the current state, so anything that arrived while
  // the debounce was open is already covered by it.
  armAfterFlight = false;
  inFlight = runRefresh();
}

async function runRefresh(): Promise<void> {
  try {
    if (!(await hooks.agentsAvailable())) {
      // No usable agent -> warm the deterministic floor instead of leaving the
      // invalidated row uncached (see contract). No CLI spawn either way.
      log.debug("[brief] scheduled refresh has no usable agent; warming the deterministic floor");
      await hooks.warmFloor();
      return;
    }
    await hooks.recompute();
  } catch (err) {
    // A failed background warm still leaves the invalidated row uncached — warm
    // the deterministic floor so a read always exists for the next open.
    log.debug("[brief] scheduled recompute failed; warming the deterministic floor", {
      error: (err as any)?.message,
    });
    try {
      await hooks.warmFloor();
    } catch {
      // Best-effort recovery; the next fetch still re-derives.
    }
  } finally {
    inFlight = null;
    // Clear the in-flight state BEFORE re-arming, so a change that landed mid-run
    // still gets its own recompute. There is deliberately no time cooldown here: with
    // the decision-relevant fingerprint and the guarded invalidations upstream, a
    // signal reaching this module is rare and means something, and a blanket cooldown
    // would drop exactly the changes worth recomputing for. (The failure backoff above
    // holds only the open-driven self-heal, never a signal.)
    if (armAfterFlight) {
      armAfterFlight = false;
      scheduleDayReadRefresh();
    }
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
  armAfterFlight = false;
  agentFailures.clear();
  hooks = { ...DEFAULT_HOOKS };
}

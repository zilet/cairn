// ============================================================================
// run-day-steer.ts — the Brief steer, heard by the read it steers.
//
// The athlete's steer on the Brief ("tired today, go easy") is recorded on the day's
// suggestion row — but only AFTER the steered read is computed, because that row
// carries the read's own outcome. The morning run read (athleteWordToday in
// run-day-intensity.ts) reads that table, so the steered Brief used to be computed
// without its own steer: the Brief, the plan, the agenda and the Today line disagreed
// until the next read.
//
// So the steer rides a scope for exactly the duration of the steered computation.
// Inside it the steer is the newest statement of the day. The scope also opens a
// FRESH brain snapshot (nothing memoized by the canonical read leaks in, nothing
// steered leaks out), and `runDaySteerKey()` is folded into the module-level memo keys
// (the day-read memo, the coach-context memo) for the same reason. Once the suggestion
// row is written every later read hears the steer from the table as before.
//
// A leaf on purpose: no repo imports, so the memo owners can read it without a cycle.
// ============================================================================
import { AsyncLocalStorage } from "node:async_hooks";
import { runWithFreshBrainSnapshot } from "../brain/snapshot.js";

interface RunDaySteer {
  date: string;
  text: string;
}

const steerScope = new AsyncLocalStorage<RunDaySteer>();

/** Run `fn` with the athlete's Brief steer for `date` heard as today's newest word. */
export function withRunDaySteer<T>(date: string, text: string | null | undefined, fn: () => T): T {
  const steer = String(text ?? "").trim();
  if (!steer || !date) return fn();
  return steerScope.run({ date, text: steer }, () => runWithFreshBrainSnapshot(fn));
}

/** The steer in scope for `date`, or null. */
export function runDaySteer(date: string): string | null {
  const scope = steerScope.getStore();
  return scope && scope.date === date ? scope.text : null;
}

/** "" outside a steer; a stable key inside one — for module-level memo keys. */
export function runDaySteerKey(): string {
  const scope = steerScope.getStore();
  return scope ? `steer:${scope.date}:${scope.text}` : "";
}

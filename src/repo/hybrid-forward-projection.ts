// The slot for the forward half of the hybrid read (the next stated run, the next
// heavy-lower day) — training-read's `hybridDayContext` asks it, plan-selection fills it.
//
// The projection needs the athlete's schedules and the lifting week's weekday map, which
// live above training-read, so plan-selection registers the projector when it loads (the
// same registration shape training-cache uses) rather than training-read importing it.
// The slot itself lives HERE, in a module that imports nothing at run time: training-read
// is no longer a leaf (it reaches plan-selection through run-intensity → profile →
// intelligence), so a slot declared in training-read could be registered into while
// training-read was still mid-load — loading training-read first threw a TDZ error at
// plan-selection's top-level registration. Unregistered (a bare unit import), the
// projection reads null and both fields stay null: absence is neutral.
import type { HybridDayContext } from "./training-read.js";

export type HybridForwardProjection = (date: string) => Pick<HybridDayContext, "planned_run_next" | "heavy_lower_next">;

let projector: HybridForwardProjection | null = null;

export function registerHybridForwardProjection(fn: HybridForwardProjection): void {
  projector = fn;
}

export function registeredHybridForwardProjection(): HybridForwardProjection | null {
  return projector;
}

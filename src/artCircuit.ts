import { getAppState, setAppState } from "./repo/app-state.js";

// Circuit breaker for the Gemini art pipeline (src/art.ts).
//
// **The state is DURABLE, and that is the whole point.** The original defect was
// not that art failed — it was that the only memory of failure was a per-process
// `failed` Set. A restart cleared it, warmArt() fires 5s after every boot, and
// the entire miss backlog went straight back out with no backoff: the 500-650
// fail/day bursts line up exactly with deploy days. An in-memory breaker would
// have had the identical hole, so the failure count, the cooldown and the
// open-until instant live in `app_state` and survive a restart.
//
// **The state is also PER MODEL**, because the pipeline is no longer single-model
// (GEMINI_EXERCISE_IMAGE_MODEL can send exercise art somewhere else). One global
// counter got both halves of that wrong: interleaved fail/success across two
// models reset the count on every other call, so a model that failed EVERY time
// never opened its circuit; and when it finally did, it took the healthy model's
// food and activity backlog offline with it for hours. So the counter, cooldown
// and open-until are keyed by model id, and a model's success resets only its own.
//
// Both directions matter:
//   - a restart during an outage must NOT re-attempt the backlog (the persisted
//     open-until still gates the very first call after boot), and
//   - recovery must NOT need an operator (the cooldown lapses on its own, and a
//     single success resets everything).
//
// Reads go through a process-local cache hydrated once from the row; the server
// is single-process, so the cache is authoritative after hydration and no gate
// costs a query.
//
// Deliberately depends on nothing but the app_state KV, so src/art.ts and
// src/repo/art-ledger.ts can both use it without an import cycle.

export const ART_CIRCUIT_KEY = "art_circuit";
export const OPEN_AFTER_CONSECUTIVE_FAILURES = 5;
export const COOLDOWN_FLOOR_MS = 15 * 60 * 1000; // 15 minutes
export const COOLDOWN_CEILING_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface ArtCircuitState {
  open: boolean;
  consecutive_failures: number;
  /** ISO instant the circuit next allows a call, or null when closed. */
  retry_at: string | null;
  /** Cooldown the NEXT open would use, in ms — grows while failures persist. */
  next_cooldown_ms: number;
  last_error_code: string | null;
  last_failure_at: string | null;
}

interface PersistedCircuit {
  consecutive_failures: number;
  open_until_ms: number;
  cooldown_ms: number;
  last_error_code: string | null;
  last_failure_at: string | null;
}

/** One entry per model id that has ever failed or succeeded this deployment. */
type PersistedCircuits = Record<string, PersistedCircuit>;

function emptyCircuit(): PersistedCircuit {
  return {
    consecutive_failures: 0,
    open_until_ms: 0,
    cooldown_ms: COOLDOWN_FLOOR_MS,
    last_error_code: null,
    last_failure_at: null,
  };
}

let cache: PersistedCircuits | null = null;

function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readCircuit(raw: unknown): PersistedCircuit {
  const parsed = (raw ?? {}) as Record<string, unknown>;
  return {
    consecutive_failures: Math.trunc(finiteNumber(parsed.consecutive_failures, 0)),
    open_until_ms: finiteNumber(parsed.open_until_ms, 0),
    cooldown_ms: Math.min(
      Math.max(finiteNumber(parsed.cooldown_ms, COOLDOWN_FLOOR_MS), COOLDOWN_FLOOR_MS),
      COOLDOWN_CEILING_MS
    ),
    last_error_code: typeof parsed.last_error_code === "string" ? parsed.last_error_code : null,
    last_failure_at: typeof parsed.last_failure_at === "string" ? parsed.last_failure_at : null,
  };
}

/** Read the durable row once per process; a corrupt or absent row reads as closed. */
function state(): PersistedCircuits {
  if (cache) return cache;
  cache = {};
  const raw = getAppState(ART_CIRCUIT_KEY);
  if (!raw) return cache;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const models = parsed?.models;
    // Anything that isn't the per-model shape (absent, or a row written by an
    // older single-circuit build) reads as closed — fail OPEN, never wedged.
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const [model, value] of Object.entries(models as Record<string, unknown>)) {
        if (value && typeof value === "object") cache[model] = readCircuit(value);
      }
    }
  } catch {
    cache = {};
  }
  return cache;
}

function circuitFor(model: string): PersistedCircuit {
  return state()[model] ?? emptyCircuit();
}

function persist(model: string, next: PersistedCircuit): void {
  const all = state();
  all[model] = next;
  cache = all;
  setAppState(ART_CIRCUIT_KEY, JSON.stringify({ models: all })); // fail-soft by contract
}

// Fired when a model's circuit transitions open → closed (cooldown lapsed, or a
// success landed), carrying the model id. src/art.ts uses this to clear the
// per-key `failed` entries that belong to THAT model, so items burned during the
// outage get another chance without a restart — while keys waiting on a model
// that is still down stay parked.
const closeListeners = new Set<(model: string) => void>();

export function onArtCircuitClose(listener: (model: string) => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

function fireClose(model: string): void {
  for (const listener of closeListeners) {
    try {
      listener(model);
    } catch {
      /* a listener must never break the breaker */
    }
  }
}

/**
 * True while this model's circuit is open. Calling this is what advances the
 * state machine past a lapsed cooldown, so every gate should go through it —
 * including the first gate after a restart, which is where the old design leaked.
 */
export function artCircuitOpen(model: string, now = Date.now()): boolean {
  const current = circuitFor(model);
  if (!current.open_until_ms) return false;
  if (now >= current.open_until_ms) {
    // The cooldown lapsed: close, and let the backlog retry with no operator.
    persist(model, { ...current, open_until_ms: 0, consecutive_failures: 0 });
    fireClose(model);
    return false;
  }
  return true;
}

/** Record one upstream failure for this model; opens its circuit at the threshold. */
export function noteArtFailure(model: string, errorCode?: string | null, now = Date.now()): void {
  const current = circuitFor(model);
  const next: PersistedCircuit = {
    ...current,
    consecutive_failures: current.consecutive_failures + 1,
    last_error_code: errorCode ? String(errorCode).slice(0, 80) : current.last_error_code,
    last_failure_at: new Date(now).toISOString(),
  };
  // Already open: record the failed probe, but don't escalate the cooldown twice.
  if (!current.open_until_ms && next.consecutive_failures >= OPEN_AFTER_CONSECUTIVE_FAILURES) {
    next.open_until_ms = now + current.cooldown_ms;
    next.cooldown_ms = Math.min(current.cooldown_ms * 2, COOLDOWN_CEILING_MS);
  }
  persist(model, next);
}

/** Record one upstream success for this model: closes it and resets its backoff. */
export function noteArtSuccess(model: string): void {
  const wasOpen = circuitFor(model).open_until_ms > 0;
  persist(model, emptyCircuit());
  if (wasOpen) fireClose(model);
}

/** The models this process knows anything about — for the aggregate read. */
function knownModels(): string[] {
  return Object.keys(state());
}

/**
 * One model's breaker state, or — with no model — the whole pipeline's, which is
 * what the Settings health line and `getArtStats().health` report.
 *
 * NOTE: this READ intentionally advances the state machine. `artCircuitOpen()`
 * is what closes a lapsed cooldown and fires the close listeners, so merely
 * looking at health can self-heal a circuit whose cooldown expired while nothing
 * was calling. That is deliberate — the alternative is a breaker that stays
 * "open" on the screen until the next generation attempt happens to poke it.
 */
export function artCircuitState(model?: string, now = Date.now()): ArtCircuitState {
  if (model) {
    const open = artCircuitOpen(model, now); // advances a lapsed cooldown before reporting
    const current = circuitFor(model);
    return {
      open,
      consecutive_failures: current.consecutive_failures,
      retry_at: open ? new Date(current.open_until_ms).toISOString() : null,
      next_cooldown_ms: current.cooldown_ms,
      last_error_code: current.last_error_code,
      last_failure_at: current.last_failure_at,
    };
  }

  // Aggregate: the pipeline is "paused" if any model is, it resumes when the
  // last open one does, and the error shown is the most recent one anywhere.
  const models = knownModels();
  const out: ArtCircuitState = {
    open: false,
    consecutive_failures: 0,
    retry_at: null,
    next_cooldown_ms: COOLDOWN_FLOOR_MS,
    last_error_code: null,
    last_failure_at: null,
  };
  let newestFailure = "";
  for (const id of models) {
    const one = artCircuitState(id, now);
    out.open ||= one.open;
    out.consecutive_failures = Math.max(out.consecutive_failures, one.consecutive_failures);
    out.next_cooldown_ms = Math.max(out.next_cooldown_ms, one.next_cooldown_ms);
    if (one.retry_at && (!out.retry_at || one.retry_at > out.retry_at)) out.retry_at = one.retry_at;
    if (one.last_failure_at && one.last_failure_at >= newestFailure) {
      newestFailure = one.last_failure_at;
      out.last_failure_at = one.last_failure_at;
      out.last_error_code = one.last_error_code;
    }
  }
  return out;
}

/**
 * Drop the process-local cache so the next read re-hydrates from app_state.
 * Simulates a RESTART: the durable row is deliberately left alone, which is
 * exactly what a redeploy does.
 */
export function forgetArtCircuitCache(): void {
  cache = null;
}

/** Test-only: clear both the cache and the durable row. */
export function resetArtCircuit(): void {
  cache = {};
  setAppState(ART_CIRCUIT_KEY, JSON.stringify({ models: {} }));
}

// Durable ownership for protective meal reshapes. A request remains pending
// until a draft succeeds; failures retry with bounded backoff, and a short lease
// prevents concurrent scheduler ticks from launching duplicate agent jobs.
import { getAppState, setAppState } from "./app-state.js";
import { localDateISO } from "./shared.js";

export const MEAL_REFRESH_REQUEST_KEY = "meal_plan_refresh_requested";
export const MEAL_REFRESH_INSTRUCTION_KEY = "meal_plan_refresh_instruction";
export const MEAL_REFRESH_ATTEMPT_KEY = "meal_plan_refresh_attempt_state";
export const MEAL_REFRESH_SUCCESS_KEY = "meal_plan_refresh_success_state";

const LEASE_MS = 15 * 60 * 1000;
const BACKOFF_MS = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000, 12 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

export interface MealRefreshAttemptState {
  request: string;
  count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  in_flight_until: string | null;
  last_error: string | null;
}

function parseState(raw: string | null): MealRefreshAttemptState | null {
  try {
    const value = JSON.parse(String(raw ?? ""));
    const request = String(value?.request ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(request)) return null;
    return {
      request,
      count: Math.max(0, Math.trunc(Number(value?.count) || 0)),
      last_attempt_at: value?.last_attempt_at ? String(value.last_attempt_at) : null,
      next_attempt_at: value?.next_attempt_at ? String(value.next_attempt_at) : null,
      in_flight_until: value?.in_flight_until ? String(value.in_flight_until) : null,
      last_error: value?.last_error ? String(value.last_error).slice(0, 500) : null,
    };
  } catch {
    return null;
  }
}

function instant(value: string | null): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  return String(text || "Meal-plan refresh returned ok:false.").trim().slice(0, 500);
}

export function getMealRefreshAttemptState(): MealRefreshAttemptState | null {
  return parseState(getAppState(MEAL_REFRESH_ATTEMPT_KEY));
}

export function mealRefreshRetryDue(
  request: string | null,
  now = new Date(),
  today = localDateISO(),
): boolean {
  const owned = String(request ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(owned) || owned > today) return false;
  const state = getMealRefreshAttemptState();
  if (!state || state.request !== owned) return true;
  const current = now.getTime();
  const lease = instant(state.in_flight_until);
  if (lease != null && lease > current) return false;
  const next = instant(state.next_attempt_at);
  return next == null || next <= current;
}

export function beginMealRefreshAttempt(
  request: string,
  now = new Date(),
  today = localDateISO(),
): MealRefreshAttemptState | null {
  if (!mealRefreshRetryDue(request, now, today)) return null;
  const prior = getMealRefreshAttemptState();
  const count = prior?.request === request ? prior.count + 1 : 1;
  const state: MealRefreshAttemptState = {
    request,
    count,
    last_attempt_at: now.toISOString(),
    next_attempt_at: null,
    in_flight_until: new Date(now.getTime() + LEASE_MS).toISOString(),
    last_error: null,
  };
  // Synchronous persistence happens before the caller starts its async agent
  // work, so another tick in this process observes the lease immediately.
  setAppState(MEAL_REFRESH_ATTEMPT_KEY, JSON.stringify(state));
  return state;
}

export function failMealRefreshAttempt(request: string, error: unknown, now = new Date()): MealRefreshAttemptState | null {
  const prior = getMealRefreshAttemptState();
  if (!prior || prior.request !== request) return null;
  const delay = BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, Math.max(0, prior.count - 1))];
  const state: MealRefreshAttemptState = {
    ...prior,
    next_attempt_at: new Date(now.getTime() + delay).toISOString(),
    in_flight_until: null,
    last_error: errorLine(error),
  };
  setAppState(MEAL_REFRESH_ATTEMPT_KEY, JSON.stringify(state));
  return state;
}

export function succeedMealRefreshAttempt(request: string, now = new Date()): MealRefreshAttemptState | null {
  const prior = getMealRefreshAttemptState();
  if (!prior || prior.request !== request) return null;
  const state: MealRefreshAttemptState = {
    ...prior,
    next_attempt_at: null,
    in_flight_until: null,
    last_error: null,
  };
  setAppState(MEAL_REFRESH_ATTEMPT_KEY, JSON.stringify(state));
  setAppState(MEAL_REFRESH_SUCCESS_KEY, JSON.stringify({ request, succeeded_at: now.toISOString(), attempts: state.count }));
  // A newer request may have arrived while this agent was running. Never clear
  // that newer owner's work with the older job's success.
  if (getAppState(MEAL_REFRESH_REQUEST_KEY) === request) {
    setAppState(MEAL_REFRESH_REQUEST_KEY, "");
    setAppState(MEAL_REFRESH_INSTRUCTION_KEY, "");
  }
  return state;
}

export async function runOwnedMealRefreshAttempt<T extends { ok?: boolean }>(
  request: string,
  task: () => Promise<T>,
  opts: { now?: Date; today?: string } = {},
): Promise<{ attempted: boolean; ok: boolean; result: T | null; error: string | null }> {
  const startedAt = opts.now ?? new Date();
  if (!beginMealRefreshAttempt(request, startedAt, opts.today ?? localDateISO())) {
    return { attempted: false, ok: false, result: null, error: null };
  }
  try {
    const result = await task();
    if (result?.ok === true) {
      succeedMealRefreshAttempt(request, new Date());
      return { attempted: true, ok: true, result, error: null };
    }
    const error = errorLine((result as any)?.error);
    failMealRefreshAttempt(request, error, new Date());
    return { attempted: true, ok: false, result, error };
  } catch (error) {
    const message = errorLine(error);
    failMealRefreshAttempt(request, message, new Date());
    return { attempted: true, ok: false, result: null, error: message };
  }
}

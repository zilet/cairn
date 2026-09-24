// Numeric coercion, rounding and small statistics — the canonical copies.
//
// DEPENDENCY-FREE, like `./dates.js`: nothing here imports from the rest of `src/`.
//
// THE ONE THING TO GET RIGHT: `Number(null)` is 0, `Number("")` is 0, and 0 is
// finite. So a bare `Number.isFinite(Number(v))` silently turns "no reading" into a
// reading of ZERO — a missing maintenance anchor becomes a maintenance of 0 kcal, a
// missing protein figure becomes a floor of none. `finite()` guards absence
// EXPLICITLY and is what almost every caller wants. `coerceFinite()` is the
// unguarded form, kept only for the call sites that were already written against it
// (a JSON payload where the key is present-or-absent, never null), so that
// consolidating these copies changed no behavior.

/**
 * A finite number, or null — with ABSENCE preserved as absence. Null, undefined and
 * a blank/whitespace-only string all read as null rather than 0.
 */
export function finite(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The UNGUARDED coercion: `Number(value)` when it is finite, else null. Reads null
 * and "" as 0 — see the header. Prefer `finite`; reach for this only to preserve an
 * existing call site's behavior.
 */
export function coerceFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One decimal place. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Two decimal places. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Nearest 5 — the coarse grain for a kcal/step figure a person reads. */
export function round5(value: number): number {
  return Math.round(value / 5) * 5;
}

/**
 * The median, or null for an empty list. Null rather than 0 or NaN: an empty sample
 * has no middle, and 0 would read as a real measurement. Callers that need one of
 * the older sentinels say so at their own call site (`?? Number.NaN`, `?? 0`).
 * Does not mutate the input.
 */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * JSON with object keys sorted at every depth, so two structurally-equal values
 * always serialize identically. Every fingerprint/idempotency hash in the codebase
 * depends on that — `JSON.stringify` alone preserves INSERTION order, which makes
 * an unchanged snapshot look changed whenever a builder happens to assign its keys
 * in a different order. `undefined` serializes as "null" rather than disappearing,
 * so an explicitly-cleared field still occupies its slot in an array.
 */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/** Reps in reserve is only meaningful from 0 to 10 — the bounds a set can be logged with. */
export const RIR_MIN = 0;
export const RIR_MAX = 10;

/**
 * A logged RIR, or null when there is none worth reading. A value outside 0–10 is
 * not a reserve anybody has — it is seconds or a rep count typed into the wrong
 * field — so it reads as ABSENT, never as "very easy".
 */
export function plausibleRir(value: unknown): number | null {
  const n = finite(value);
  return n != null && n >= RIR_MIN && n <= RIR_MAX ? n : null;
}

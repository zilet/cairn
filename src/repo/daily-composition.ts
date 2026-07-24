import { DAILY_SESSION_SUGGESTION_NORMALIZATION, normalizeSessionSuggestionResult } from "./adaptive-session.js";
import type { DailyDecisionEnvelope } from "./daily-decision.js";
import { findExercise } from "./exercises.js";
import { getPlanDay } from "./plan.js";

// Stage 3 — bounded agent composition (docs/ADAPTIVE_DAILY_TRAINING_PLAN.md §5).
// The agent composes INSIDE the deterministic Stage 2 envelope; it never
// redefines safety. This module is the server-side normalizer + deterministic
// fallback that make that boundary real: every agent item is re-verified,
// clamped, and checked against the envelope's exclusions/caps and the
// safe-exercise-introduction rules, and any invalid/empty/over-excluded output
// falls back to a usable deterministic session built from the same envelope.

export interface ComposedSession {
  name: string | null;
  focus: string | null;
  why: string | null;
  est_minutes: number | null;
  items: any[];
}

export interface CompositionValidation {
  ok: boolean;
  reason: string | null;
  rejected: Array<{ exercise: string; reason: string }>;
  novel_introduced: number;
  capped: boolean;
}

function volumeCap(envelope: DailyDecisionEnvelope): number {
  switch (envelope.caps.volume) {
    case "minimal":
      return 4;
    case "reduced":
      return 7;
    default:
      return 12;
  }
}

function baselineNote(note: string | null): string {
  const base = "NEW — establishing a baseline; keep it light and log the actual load";
  const trimmed = (note ?? "").trim();
  if (!trimmed) return base;
  if (/baseline/i.test(trimmed)) return trimmed.slice(0, 500);
  return `${base}. ${trimmed}`.slice(0, 500);
}

// Verify + clamp an agent composition against the envelope. Returns a normalized
// session (identical in shape to a session suggestion) or null when nothing
// usable survives. Enforced here, never trusted from the agent:
//   - every item re-runs the agent-source normalization (load clamps, shape);
//   - items loading an EXCLUDED muscle group are dropped;
//   - at most ONE novel (not-yet-known) movement family is admitted, with no
//     falsely precise load and a baseline label;
//   - item count and duration are clamped to the envelope caps.
export function normalizeComposedSession(
  raw: unknown,
  envelope: DailyDecisionEnvelope
): { session: ComposedSession | null; validation: CompositionValidation } {
  const base = normalizeSessionSuggestionResult(raw);
  const rejected: Array<{ exercise: string; reason: string }> = [];
  if (!base) {
    return {
      session: null,
      validation: { ok: false, reason: "unparseable", rejected, novel_introduced: 0, capped: false },
    };
  }
  const excluded = new Set(envelope.muscles.excluded.map((g) => g.toLowerCase()));
  let novelCount = 0;
  const kept: any[] = [];
  for (const item of base.items) {
    const isCardio = item.kind === "cardio";
    const stored = isCardio ? null : findExercise(String(item.exercise ?? ""));
    const group = stored?.muscle_group ? String(stored.muscle_group).toLowerCase() : null;
    if (group && excluded.has(group)) {
      rejected.push({ exercise: String(item.exercise), reason: "excluded_group" });
      continue;
    }
    const novel = !isCardio && !stored;
    if (novel) {
      // A novel movement is not in the canon, so it carries no muscle_group and the
      // excluded-group filter above cannot verify what area it loads. When the envelope
      // excludes ANY muscle group, refuse novel introductions entirely — the server
      // cannot certify an unknown movement avoids the excluded area — and keep the rest
      // of the composition (the agent is told to compose from the canon in this case).
      if (excluded.size) {
        rejected.push({ exercise: String(item.exercise), reason: "novel_blocked_by_exclusions" });
        continue;
      }
      if (novelCount >= 1) {
        rejected.push({ exercise: String(item.exercise), reason: "extra_novel_movement" });
        continue;
      }
      novelCount++;
      // No performance baseline exists — never prescribe a falsely precise load.
      item.target_weight = null;
      item.note = baselineNote(item.note == null ? null : String(item.note));
    }
    kept.push(item);
  }
  if (!kept.length) {
    return {
      session: null,
      validation: { ok: false, reason: "all_items_excluded", rejected, novel_introduced: novelCount, capped: false },
    };
  }
  const cap = volumeCap(envelope);
  const capped = kept.slice(0, cap);
  let est = base.est_minutes;
  if (envelope.caps.duration_min != null && (est == null || est > envelope.caps.duration_min)) {
    est = envelope.caps.duration_min;
  }
  return {
    session: { name: base.name, focus: base.focus, why: base.why, est_minutes: est, items: capped },
    validation: {
      ok: true,
      reason: null,
      rejected,
      novel_introduced: novelCount,
      capped: capped.length < kept.length,
    },
  };
}

function planItemToRaw(it: any): Record<string, unknown> {
  if (it?.kind === "cardio") {
    return {
      kind: "cardio",
      exercise: it.exercise,
      target_distance_km: it.target_distance_km ?? null,
      target_duration_min: it.target_duration_min ?? null,
      target_zone: it.target_zone ?? null,
      note: it.note ?? null,
    };
  }
  return {
    exercise: it.exercise,
    sets: it.sets ?? 3,
    rep_low: it.rep_low ?? null,
    rep_high: it.rep_high ?? null,
    target_weight: it.mode === "timed" ? null : (it.target_weight ?? null),
    target_seconds: it.mode === "timed" ? (it.target_seconds ?? null) : null,
    mode: it.mode ?? "reps",
    warmup_sets: it.warmup_sets ?? null,
    note: it.note ?? null,
  };
}

// The deterministic session used when the agent is absent, times out, or returns
// nothing usable (docs §5: agent absence never blocks a usable session). Built
// from the envelope's own template day (exclusions applied) so it always honors
// the same safety bounds. Falls back to a short easy-movement session when there
// is no plan day (custom/rest intent). Returned as a RAW payload so it flows back
// through `normalizeComposedSession` and shares the agent path's exact shape.
export function deterministicSessionRawFromEnvelope(envelope: DailyDecisionEnvelope): Record<string, unknown> {
  const excluded = new Set(envelope.muscles.excluded.map((g) => g.toLowerCase()));
  const items: Array<Record<string, unknown>> = [];
  if (envelope.template.day_number != null && envelope.kind !== "rest") {
    const day = getPlanDay(envelope.template.day_number) as any;
    for (const it of Array.isArray(day?.items) ? day.items : []) {
      const group = String(it?.muscle_group ?? "").toLowerCase();
      if (group && excluded.has(group)) continue;
      items.push(planItemToRaw(it));
    }
  }
  if (!items.length) {
    // Custom/rest intent, or every template item was excluded: a calm, safe,
    // low-load default that always survives normalization.
    items.push({
      kind: "cardio",
      exercise: envelope.kind === "rest" ? "Easy walk" : "Easy movement",
      target_duration_min: Math.min(envelope.caps.duration_min ?? 25, 25),
      target_zone: "easy",
      note: "Deterministic fallback — keep it light",
    });
  }
  const why = envelope.rationale[0]?.text ?? "Today's deterministic session.";
  const name =
    envelope.kind === "rest"
      ? "Easy recovery"
      : envelope.template.focus
        ? String(envelope.template.focus)
        : "Today's session";
  return {
    name,
    focus: envelope.template.focus,
    why,
    est_minutes: envelope.caps.duration_min,
    items,
  };
}

export function deterministicComposedSession(envelope: DailyDecisionEnvelope): ComposedSession {
  const raw = deterministicSessionRawFromEnvelope(envelope);
  const { session } = normalizeComposedSession(raw, envelope);
  // The raw payload is built from safe template/plan items, so it always
  // normalizes; this null-guard is defensive only.
  return (
    session ?? {
      name: "Easy movement",
      focus: envelope.template.focus,
      why: "Deterministic fallback session.",
      est_minutes: envelope.caps.duration_min ?? 25,
      items: [],
    }
  );
}

export const DAILY_COMPOSITION_NORMALIZATION = DAILY_SESSION_SUGGESTION_NORMALIZATION;

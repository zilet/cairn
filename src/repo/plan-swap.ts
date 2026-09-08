// ============================================================================
// plan-swap.ts — "rotate one in": resolving WHICH plan slot a lift occupies, and
// the propose→apply path that swaps it (or, when the movement isn't on the plan
// at all, adds the incoming variation to the day that already trains its muscle
// group). Split out of progression.ts; REST + MCP both call these so the two
// surfaces never drift.
//
// Constitution: buildSwapProposal only DRAFTS — the swap lands when the athlete
// taps Apply. buildAndApplySwap is the explicit in-session "rotate one in" intent
// (the plan quietly follows the athlete), and it discards its own draft when the
// apply can't land so nothing is left dangling.
// ============================================================================
import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import {
  classifyMuscleGroup,
  movementKey,
  type MuscleGroup,
  normalizeExerciseName,
  normalizedExerciseKey,
  resolveGroup,
} from "./exercise-canon.js";
import { addExerciseToPlanDay } from "./plan.js";
import { applyProposal, createProposal, setProposalStatus } from "./proposals.js";
import { localDateISO } from "./shared.js";

// The PLAN SLOT a lift resolves to, matched with the same tiered ladder applyPlanSwap
// uses (exact normalized name → conservative key → movementKey) — so a surface with
// only a lift name (e.g. the conductor's swap payload, which names the LOGGED lift)
// finds the slot even when the plan spells the movement with a different implement
// ("Barbell Bench Press" logged, "DB Bench Press" planned). Lowest day_number within
// the winning tier; tiers never mix (an exact match elsewhere always beats a
// movement-family match). Null when nothing on the plan trains that movement.
export function resolvePlanSwapSlot(name: string): { day: number; plan_name: string } | null {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  try {
    const rows = db
      .prepare(
        `SELECT pd.day_number AS d, e.name AS ex_name
         FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id
         JOIN exercises e ON e.id = pi.exercise_id
        ORDER BY pd.day_number, pi.position`
      )
      .all() as any[];
    const norm = normalizeExerciseName(raw);
    const key = normalizedExerciseKey(raw);
    const move = movementKey(raw);
    const hit =
      rows.find((r) => normalizeExerciseName(r.ex_name) === norm) ??
      rows.find((r) => normalizedExerciseKey(r.ex_name) === key) ??
      rows.find((r) => movementKey(r.ex_name) === move);
    if (!hit || !Number.isFinite(Number(hit.d))) return null;
    return { day: Number(hit.d), plan_name: String(hit.ex_name) };
  } catch {
    return null;
  }
}

// Back-compat day-only view of resolvePlanSwapSlot (existing callers + MCP).
export function findPlanDayForExercise(name: string): number | null {
  return resolvePlanSwapSlot(name)?.day ?? null;
}

// The plan day best suited to host a movement of `group` — the day already doing the
// most work for that muscle group (ties → the earliest day). Null when no plan day
// trains it at all.
function bestPlanDayForGroup(group: MuscleGroup): number | null {
  try {
    const rows = db
      .prepare(
        `SELECT pd.day_number AS d, e.name AS ex_name, e.muscle_group AS mg
         FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id
         JOIN exercises e ON e.id = pi.exercise_id`
      )
      .all() as any[];
    const counts = new Map<number, number>();
    for (const r of rows) {
      if (resolveGroup(String(r.ex_name ?? ""), r.mg) !== group) continue;
      const d = Number(r.d);
      if (!Number.isFinite(d)) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    let best: number | null = null;
    for (const [d, n] of counts) {
      if (best == null || n > (counts.get(best) ?? 0) || (n === (counts.get(best) ?? 0) && d < best)) best = d;
    }
    return best;
  } catch {
    return null;
  }
}

// The full "rotate one in" intent behind one tap: resolve WHERE the outgoing lift
// lives (tiered — the plan's implement spelling never blocks the athlete's), swap
// that slot, and when the movement isn't represented anywhere, ADD the incoming
// variation to the day already training that muscle group instead of dead-ending.
// The message says what actually happened, in the plan's own names. REST + MCP both
// call this so the surfaces never drift.
export function applySwapSmart(
  from: string,
  to: string,
  day?: number | null,
): { ok: false; error: string } | { ok: true; mode: "swapped" | "added"; day: number; from?: string; exercise: string; message: string; swapped?: any } {
  const f = String(from ?? "").trim();
  const t = String(to ?? "").trim();
  if (!f) return { ok: false, error: "from exercise required" };
  if (!t) return { ok: false, error: "to exercise required" };

  // day == null must stay NaN so the slot resolution runs — Number(null) is 0,
  // which reads as a (nonexistent) explicit day 0 and breaks the whole ladder.
  let d = day == null ? Number.NaN : Number(day);
  let planName = f;
  if (!Number.isFinite(d)) {
    const slot = resolvePlanSwapSlot(f);
    if (slot) {
      d = slot.day;
      planName = slot.plan_name;
    } else {
      // Nothing on the plan trains this movement — land the variation on the day
      // that already works the muscle group (the athlete asked for it; an error
      // toast would just make them do this by hand from the Plan tab).
      const group = groupForName(f) ?? groupForName(t);
      const hostDay = group ? bestPlanDayForGroup(group) : null;
      if (hostDay == null) return { ok: false, error: `couldn't find ${f} — or a day that trains it — on your plan` };
      let added: ReturnType<typeof addExerciseToPlanDay>;
      try {
        // The LEAD clause only — addExerciseToPlanDay grounds the movement and adds
        // the starting cue that grounding earned. A lift with real logged history
        // must not be told to start light just because it arrived by this path
        // rather than by a swap.
        added = addExerciseToPlanDay(hostDay, t, `Added as a fresh variation for ${f}`);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!added) return { ok: false, error: `couldn't add ${t} to your plan` };
      emitBrainEvent({
        kind: "exercise_swapped",
        domain: "training",
        date: localDateISO(),
        subject_key: `${f} -> ${t} (added)`.slice(0, 160),
      });
      return {
        ok: true,
        mode: "added",
        day: added.day,
        exercise: added.exercise,
        message: `${f} isn't on your plan — added ${added.exercise} to day ${added.day} instead (nothing removed)`,
      };
    }
  }
  // Pass the RESOLVED plan spelling as `from` so the apply hits its exact-match tier.
  const applied = buildAndApplySwap(d, planName, t);
  if (!applied.ok) return applied;
  const renamed = planName.toLowerCase() !== f.toLowerCase();
  return {
    ok: true,
    mode: "swapped",
    day: d,
    from: planName,
    exercise: t,
    message: renamed
      ? `Rotated ${t} in for ${planName} (your plan's slot for ${f}) on day ${d}`
      : `Rotated ${t} in for ${planName} on day ${d}`,
    swapped: applied.swapped,
  };
}

// The canonical muscle group for a lift name — stored group when the exercise
// exists, else classified from the name.
function groupForName(name: string): MuscleGroup | null {
  try {
    const row = db.prepare(`SELECT muscle_group FROM exercises WHERE LOWER(name) = LOWER(?)`).get(name) as any;
    return resolveGroup(name, row?.muscle_group ?? null);
  } catch {
    return classifyMuscleGroup(name);
  }
}

// Build a DRAFT proposal to ROTATE one exercise out for another on a day — the
// propose→apply path behind Today's "rotate one in" chips (and MCP swap_exercise).
// Never auto-applies; the swap only lands when the athlete taps Apply. Returns the
// designed { ok:false, error } (status 200 at the surface) on bad input.
export function buildSwapProposal(
  day: number,
  from: string,
  to: string
): { ok: false; error: string } | { ok: true; proposal: any } {
  const d = Number(day);
  if (!Number.isFinite(d)) return { ok: false, error: "day required" };
  const f = String(from ?? "").trim();
  const t = String(to ?? "").trim();
  if (!f) return { ok: false, error: "from exercise required" };
  if (!t) return { ok: false, error: "to exercise required" };
  const parsed = {
    summary: `Rotate ${f} → ${t} on day ${d}`,
    changes: [{ day_number: d, swap: { from: f, to: t }, reason: `Rotate a same-pattern variation in for ${f}.` }],
  };
  const proposal = createProposal("exercise-swap", `swap ${f} → ${t}`, "", parsed);
  return { ok: true, proposal };
}

// Swap one exercise for another on a day AND APPLY it immediately — the in-session
// "rotate one in" intent: the athlete taps a variation and it lands in the plan now,
// so the very next render shows the new movement ready to log against. This is the
// "adapts as I go" path (no Coach review gate); the plan quietly follows the athlete.
// Builds through the same tested buildSwapProposal → applyProposal path so REST + MCP
// never drift, and discards the draft if the apply can't land (e.g. `from` not on the
// day) so nothing is left dangling. Returns the applied result or the designed
// { ok:false, error } at 200.
export function buildAndApplySwap(
  day: number,
  from: string,
  to: string
): { ok: false; error: string } | { ok: true; swapped: any } {
  const draft = buildSwapProposal(day, from, to);
  if (!draft.ok) return draft;
  try {
    const applied = applyProposal(draft.proposal.id) as { ok?: boolean; error?: string; skipped?: Array<{ error?: string }> };
    if (!applied || applied.ok === false) {
      setProposalStatus(draft.proposal.id, "discarded");
      // Prefer the per-change error (e.g. '"X" is not on day N to swap out') over
      // the apply layer's generic line — the surface toasts this verbatim.
      const detail = Array.isArray(applied?.skipped) ? applied.skipped.find((s) => s?.error)?.error : undefined;
      return { ok: false, error: detail || applied?.error || "couldn't apply that swap" };
    }
    // savePlanDay already emitted plan_changed; the explicit swap kind carries
    // WHICH movement rotated out/in so the review can speak to the rotation.
    emitBrainEvent({
      kind: "exercise_swapped",
      domain: "training",
      date: localDateISO(),
      subject_key: `${from} -> ${to}`.slice(0, 160),
    });
    return { ok: true, swapped: applied };
  } catch (e: any) {
    setProposalStatus(draft.proposal.id, "discarded");
    return { ok: false, error: e?.message || "couldn't apply that swap" };
  }
}

import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import { constraintLimitsLoad, movementKey, normalizeExerciseName, normalizedExerciseKey } from "./exercise-canon.js";
import { findExercise, findOrCreateExercise, recentWorkingWeight } from "./exercises.js";
import { invalidateDayRead } from "./intelligence.js";
import { localDateISO } from "./shared.js";
import { bumpTrainingDataVersion } from "./training-cache.js";

// ---------- plan ----------
// LEFT JOIN on exercises (v35): a cardio plan item (kind='cardio') has no
// exercise_id, so an INNER JOIN would silently drop it. A cardio row's `exercise`
// is its own label (planned in the note/name) and its endurance fields carry the
// prescription. hydratePlanItem coerces the row so the surface shape is stable.
const PLAN_ITEM_COLS = `pi.id, pi.plan_day_id, pi.position, pi.sets, pi.rep_low, pi.rep_high,
                pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds,
                pi.kind, pi.target_distance_km, pi.target_duration_min, pi.target_zone, pi.interval_json,
                pi.superset_group,
                e.name AS exercise, e.muscle_group, e.unit, e.constraint_note, e.mode`;

function hydratePlanItem(row: any) {
  if (!row) return row;
  const kind = row.kind === "cardio" ? "cardio" : "strength";
  let interval: any = null;
  try { interval = row.interval_json ? JSON.parse(row.interval_json) : null; } catch { interval = null; }
  const { interval_json, ...rest } = row;
  return { ...rest, kind, interval };
}

type AccountablePlanChange = { decision_id: number; summary: string; rationale: string | null; reversible: boolean };

function accountablePlanChanges(): Map<string, AccountablePlanChange> {
  const map = new Map<string, AccountablePlanChange>();
  try {
    const rows = db
      .prepare(
        `SELECT id, summary, rationale, reversible, action_json
         FROM brain_decisions
        WHERE status = 'applied' AND domain = 'training' AND autonomy_tier IN ('quiet_apply','announce')
        ORDER BY id DESC LIMIT 100`
      )
      .all() as any[];
    for (const row of rows) {
      let action: any = null;
      try {
        action = row.action_json ? JSON.parse(row.action_json) : null;
      } catch {
        action = null;
      }
      for (const change of Array.isArray(action?.changes) ? action.changes : []) {
        const day = Number(change?.day_number);
        const exercise = String(change?.exercise ?? "")
          .trim()
          .toLowerCase();
        if (!Number.isFinite(day) || !exercise) continue;
        const key = `${day}|${exercise}`;
        if (!map.has(key))
          map.set(key, {
            decision_id: Number(row.id),
            summary: String(row.summary ?? "Cairn adjusted this exercise."),
            rationale: row.rationale == null ? null : String(row.rationale),
            reversible: !!row.reversible,
          });
      }
    }
  } catch {
    /* pre-ledger / partial migration: plan reads remain unchanged */
  }
  return map;
}

function decorateAccountablePlan(days: any[]): any[] {
  const changes = accountablePlanChanges();
  if (!changes.size) return days;
  return days.map((day) => ({
    ...day,
    items: (day.items ?? []).map((item: any) => {
      const change = changes.get(
        `${Number(day.day_number)}|${String(item.exercise ?? "")
          .trim()
          .toLowerCase()}`
      );
      return change
        ? {
            ...item,
            brain_decision_id: change.decision_id,
            brain_change_summary: change.summary,
            brain_change_reason: change.rationale,
            brain_change_reversible: change.reversible,
          }
        : item;
    }),
  }));
}

export function getPlan() {
  const days = db.prepare(`SELECT * FROM plan_days ORDER BY day_number`).all() as any[];
  const stmt = db.prepare(
    `SELECT ${PLAN_ITEM_COLS}
       FROM plan_items pi LEFT JOIN exercises e ON e.id = pi.exercise_id
       WHERE pi.plan_day_id = ? ORDER BY pi.position`
  );
  return decorateAccountablePlan(
    days.map((d) => ({
      ...d,
      items: (stmt.all(d.id) as any[]).map(hydratePlanItem),
    }))
  );
}

export function getPlanDay(dayNumber: number) {
  const d = db.prepare(`SELECT * FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!d) return null;
  return decorateAccountablePlan([
    {
      ...d,
      items: (
        db
          .prepare(
            `SELECT ${PLAN_ITEM_COLS}
         FROM plan_items pi LEFT JOIN exercises e ON e.id = pi.exercise_id
         WHERE pi.plan_day_id = ? ORDER BY pi.position`
          )
          .all(d.id) as any[]
      ).map(hydratePlanItem),
    },
  ])[0];
}

// ---------- iCal plan export (pull-not-push calendar) ----------
// A subscribe-able weekly view of the training template — the calmest possible
// "calendar": you pull it into Apple/Google Calendar, it never pushes or nags.
// Plan days carry no inherent weekday, so day_number maps sequentially onto
// weekdays from a start day (Monday by default): Day 1 → Mon, Day 2 → Tue, …
// wrapping at 7. Each plan day becomes ONE weekly-recurring all-day VEVENT with
// no alarm. Pure over getPlan(); the only non-determinism (DTSTAMP + the first
// occurrence date) is injectable via opts for deterministic tests.
export function buildPlanICS(opts: { now?: Date; startWeekday?: number } = {}): string {
  const now = opts.now ?? new Date();
  // JS weekday index (0=Sun..6=Sat) the plan's Day 1 lands on. Default Monday = 1.
  const start = Number.isFinite(opts.startWeekday as number)
    ? ((Math.trunc(opts.startWeekday as number) % 7) + 7) % 7
    : 1;
  const plan = getPlan();

  const p2 = (n: number) => String(n).padStart(2, "0");
  const esc = (s: string) =>
    String(s ?? "")
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const stampUTC = (d: Date) =>
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  const dateOnly = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  // RFC 5545 line folding: ≤75 octets, continuation lines begin with a space.
  const fold = (line: string) => {
    if (Buffer.byteLength(line, "utf8") <= 75) return line;
    const out: string[] = [];
    let cur = "";
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch, "utf8") > 74) { out.push(cur); cur = " " + ch; }
      else cur += ch;
    }
    if (cur) out.push(cur);
    return out.join("\r\n");
  };
  const fmtItem = (it: any) => {
    // A cardio item renders its endurance prescription ("Long run — 12 km, Z2").
    if (it.kind === "cardio") {
      const label = String(it.note || it.exercise || "Cardio").trim();
      const bits: string[] = [];
      if (it.target_distance_km != null) bits.push(`${it.target_distance_km} km`);
      if (it.target_duration_min != null) bits.push(`${Math.round(it.target_duration_min)} min`);
      if (it.target_zone) bits.push(String(it.target_zone));
      return bits.length ? `${label} — ${bits.join(", ")}` : label;
    }
    const name = it.exercise || "exercise";
    if (it.mode === "timed" && it.target_seconds) return `${name} ${it.sets || 1}×${it.target_seconds}s`;
    const lo = it.rep_low, hi = it.rep_high;
    const reps = lo && hi ? (lo === hi ? `${lo}` : `${lo}-${hi}`) : (lo || hi || "");
    return reps ? `${name} ${it.sets || 1}×${reps}` : name;
  };

  const dtstamp = stampUTC(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cairn//Training Plan//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Cairn Training Plan",
  ];

  for (const day of plan) {
    const items = (day.items ?? []) as any[];
    if (!items.length && !day.name && !day.focus) continue;
    const targetWd = (start + (Number(day.day_number) - 1)) % 7;
    const first = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    first.setDate(first.getDate() + ((targetWd - first.getDay() + 7) % 7));
    const summary = day.focus || day.name || `Day ${day.day_number}`;
    const desc = items.map(fmtItem).join(", ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:cairn-plan-day-${day.day_number}@cairn`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${dateOnly(first)}`,
      "RRULE:FREQ=WEEKLY",
      fold(`SUMMARY:${esc(summary)}`),
      ...(desc ? [fold(`DESCRIPTION:${esc(desc)}`)] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---------- code-enforced apply guardrails (Trust build V1) ----------
// A deterministic safety clamp on a load-progression step. Prompts ALREADY ask
// for conservative progression, but a prompt is a request, not a rule: an
// off-spec agent value (a +50 lb jump, a fat-finger 10x) would otherwise be
// written verbatim. This caps the *applied* (auto/reviewed) value to a safe step
// vs. the CURRENT target — transparently (every adjustment is returned and
// surfaced), NEVER silently. It only ever runs on the apply path; a deliberate
// manual edit (PUT /plan/:day/target, MCP update_target) is unclamped — the user
// drives and may choose any value directly.
//
// Encoding (domain gotchas): weight null = bodyweight, negative = assist (e.g.
// -30 = 30 lb assist). We clamp the signed difficulty value, preserving the sign.
// Bodyweight↔loaded transitions (a null on either side) are left alone — that's a
// kind change, not a progression step, and the coach owns that decision.
const CLAMP_STEP_FRAC = 0.1;      // max progression step = 10% of the current target…
const CLAMP_WEIGHT_FLOOR_LB = 10; // …or this many lb, whichever is larger (so light weights still move)
const CLAMP_SECONDS_FLOOR = 10;   // …or this many seconds for timed holds

// The transparent record of a code-enforced adjustment (V3 renders these as a
// calm "adjusted to a safe step" note). `field` is the value that was capped
// (target_weight/target_seconds for training; target_kcal/protein_g for the
// nutrition advisory). `exercise` names the subject (an exercise, or "nutrition
// target"). NEVER silent — every cap produces one of these.
export interface ClampAdjustment {
  exercise: string;
  field: string;
  requested: number;
  applied: number;
  reason: string;
}

// Clamp one numeric step against a current value. Returns the safe value plus an
// optional adjustment record (null when nothing was capped). `constrained` (an
// active injury constraint_note) forbids any INCREASE in resistance/duration —
// the move is held at its current value, never loaded heavier.
function clampStep(
  field: "target_weight" | "target_seconds",
  exercise: string,
  current: number | null,
  requested: number,
  floor: number,
  constrained: boolean
): { applied: number; adjustment: ClampAdjustment | null } {
  // No baseline to compare against (e.g. a brand-new prescription): accept as-is.
  if (current == null || !Number.isFinite(current)) return { applied: requested, adjustment: null };

  const isWeight = field === "target_weight";
  // For weight, "resistance" runs heavy-assist(−) → bodyweight(0) → loaded(+), so
  // more resistance = a larger signed value; for seconds, longer = harder. In both
  // cases the signed value IS the difficulty axis, so we clamp the signed delta.
  const maxStep = Math.max(Math.abs(current) * CLAMP_STEP_FRAC, floor);
  const delta = requested - current;

  // Injury constraint: never increase resistance/duration on a flagged movement.
  if (constrained && delta > 0) {
    return {
      applied: current,
      adjustment: { exercise, field, requested, applied: current,
        reason: "held — exercise has an injury constraint; load not increased" },
    };
  }

  if (Math.abs(delta) <= maxStep) return { applied: requested, adjustment: null };

  const applied = Math.round(current + Math.sign(delta) * maxStep);
  const dir = delta > 0 ? "increase" : "decrease";
  return {
    applied,
    adjustment: { exercise, field, requested, applied,
      reason: `${dir} capped to a safe step (≤${Math.round(maxStep)}${isWeight ? " lb" : " sec"} vs current ${current})` },
  };
}

export function updateTarget(
  dayNumber: number,
  exerciseName: string,
  target_weight?: number | null,
  target_seconds?: number | null,
  opts: { clamp?: boolean } = {}
) {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) throw new Error(`No plan day ${dayNumber}`);
  const ex = findExercise(exerciseName);
  if (!ex) throw new Error(`No exercise "${exerciseName}"`);

  // Apply-path safety clamp (off by default → manual edits pass through verbatim).
  const clamps: ClampAdjustment[] = [];
  if (opts.clamp) {
    // Only a LOAD-limiting constraint blocks a load increase; a grip/form cue does not
    // (mirrors the progression engine — see classifyConstraint). A grip note no longer
    // freezes a lift the athlete is driving heavy.
    const loadConstrained = constraintLimitsLoad(ex.constraint_note);
    // Read the CURRENT prescribed targets to clamp the step against.
    const cur = db
      .prepare(`SELECT target_weight, target_seconds FROM plan_items WHERE plan_day_id = ? AND exercise_id = ?`)
      .get(day.id, ex.id) as any;
    if (target_weight !== undefined && target_weight !== null && Number.isFinite(Number(target_weight))) {
      // Reality-aware baseline: clamp against the HARDER of the stored plan target and
      // the athlete's real recent working weight, so RE-GROUNDING a stale target onto
      // what they actually lift (plan 27 → reality 50) reads as catch-up, not a +85%
      // leap. The per-session step cap still applies ABOVE that grounded baseline.
      const rw = recentWorkingWeight(ex.name);
      const stored = cur?.target_weight ?? null;
      const grounded = stored != null && rw != null ? Math.max(stored, rw) : (stored != null ? stored : rw);
      const r = clampStep("target_weight", ex.name, grounded, Number(target_weight), CLAMP_WEIGHT_FLOOR_LB, loadConstrained);
      target_weight = r.applied;
      if (r.adjustment) clamps.push(r.adjustment);
    }
    if (target_seconds !== undefined && target_seconds !== null && Number.isFinite(Number(target_seconds))) {
      const r = clampStep("target_seconds", ex.name, cur?.target_seconds ?? null, Number(target_seconds), CLAMP_SECONDS_FLOOR, loadConstrained);
      target_seconds = r.applied;
      if (r.adjustment) clamps.push(r.adjustment);
    }
  }

  const sets: string[] = [];
  const vals: any[] = [];
  if (target_weight !== undefined) { sets.push("target_weight = ?"); vals.push(target_weight); }
  if (target_seconds !== undefined) { sets.push("target_seconds = ?"); vals.push(target_seconds); }
  if (!sets.length) throw new Error("target_weight or target_seconds required");
  vals.push(day.id, ex.id);
  const info = db
    .prepare(`UPDATE plan_items SET ${sets.join(", ")} WHERE plan_day_id = ? AND exercise_id = ?`)
    .run(...vals);
  return {
    updated: info.changes, day: dayNumber, exercise: ex.name,
    ...(target_weight !== undefined ? { target_weight } : {}),
    ...(target_seconds !== undefined ? { target_seconds } : {}),
    ...(clamps.length ? { clamped: clamps } : {}),
  };
}

// The ONE place that knows the plan_items column shape. Every insert — savePlanDay's
// cardio + strength branches and applyPlanChange's ADD — goes through it, so a schema
// column change is a single edit instead of three parallel 15-column statements.
// Omitted columns default to NULL (kind defaults to 'strength').
function insertPlanItem(row: {
  plan_day_id: number; position: number; exercise_id: number | null;
  sets?: number | null; rep_low?: number | null; rep_high?: number | null;
  target_weight?: number | null; note?: string | null; warmup_sets?: number | null;
  target_seconds?: number | null; kind?: string;
  target_distance_km?: number | null; target_duration_min?: number | null;
  target_zone?: string | null; interval_json?: string | null; superset_group?: number | null;
}) {
  return db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note, warmup_sets, target_seconds, kind, target_distance_km, target_duration_min, target_zone, interval_json, superset_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.plan_day_id, row.position, row.exercise_id ?? null,
    row.sets ?? null, row.rep_low ?? null, row.rep_high ?? null, row.target_weight ?? null,
    row.note ?? null, row.warmup_sets ?? null, row.target_seconds ?? null,
    row.kind ?? "strength", row.target_distance_km ?? null, row.target_duration_min ?? null,
    row.target_zone ?? null, row.interval_json ?? null, row.superset_group ?? null
  );
}

// Preserve the coach's "why" at the exact exercise it changed. A plan item can
// already carry a useful manual note, so a background adjustment appends a compact
// rationale instead of overwriting it. Re-applying the same reason is idempotent.
function addCoachAdjustmentNote(planDayId: number, exerciseName: string, reason: unknown): void {
  const clean = String(reason ?? "").trim().replace(/\s+/g, " ").slice(0, 420);
  if (!clean) return;
  const row = db.prepare(
    `SELECT pi.id, pi.note FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? AND e.name = ?`
  ).get(planDayId, exerciseName) as any;
  if (!row) return;
  const adjustment = `Coach note: ${clean}`;
  const existing = String(row.note ?? "").trim();
  if (existing.includes(adjustment)) return;
  const note = [existing, adjustment].filter(Boolean).join("\n").slice(0, 500);
  db.prepare(`UPDATE plan_items SET note = ? WHERE id = ?`).run(note || null, row.id);
}

// Apply ONE coach proposal change to the plan — an UPSERT, unlike updateTarget
// (edit-only). It updates the matching prescription's target when the movement is
// already on that day, and ADDS the movement to the day when it isn't yet. That
// "add a back movement" intent is the coach's most natural plan edit, and it used
// to vanish silently: applyProposal looped updateTarget, whose UPDATE matched zero
// rows for an absent exercise (or threw "No exercise") — yet the proposal still
// flipped to "applied" and the UI claimed "✓ Applied". Returns the action taken so
// applyProposal can report honestly. clamp:true runs the apply-path safety clamp on
// an UPDATE (an ADD starts at the coach's conservative target as-is).
export interface PlanChange {
  day_number: number;
  exercise?: string;
  target_weight?: number | null;
  target_seconds?: number | null;
  sets?: number | null;
  rep_low?: number | null;
  rep_high?: number | null;
  reason?: string | null;
  note?: string | null;
  mode?: string | null;
  // A first-class SWAP: rotate one exercise out for another IN PLACE on a day
  // (the vary/rotate intent) — replaces the matching plan item's exercise while
  // keeping its slot + rep scheme, starting the new movement light (log actual).
  swap?: { from?: string | null; to?: string | null } | null;
}
export function applyPlanChange(
  c: PlanChange,
  opts: { clamp?: boolean } = {}
): { action: "updated" | "added" | "swapped"; day: number; exercise: string; from?: string; updated?: number; clamped?: ClampAdjustment[] } {
  const dayNumber = Number(c.day_number);
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) throw new Error(`No plan day ${dayNumber}`);

  // SWAP: replace one movement in place (the rotate/vary intent). Handled before the
  // name-match path because a swap change carries {from,to}, not a single `exercise`.
  if (c.swap && (c.swap.from || c.swap.to)) {
    return applyPlanSwap(day.id, dayNumber, c.swap, c.reason ?? c.note ?? null);
  }

  const name = String(c.exercise ?? "").trim();
  if (!name) throw new Error("exercise required");

  // Find the matching strength item already on this day — exact name first, then a
  // normalized-key drift match (so a tweak phrased "DB Row" updates an existing
  // "Single-Arm DB Row" instead of adding a near-duplicate). Only when NOTHING on
  // the day matches is this treated as an ADD.
  const dayItems = db.prepare(
    `SELECT e.name AS ex_name
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`
  ).all(day.id) as any[];
  const norm = normalizeExerciseName(name);
  const key = normalizedExerciseKey(name);
  const match =
    dayItems.find((r) => normalizeExerciseName(r.ex_name) === norm) ??
    dayItems.find((r) => normalizedExerciseKey(r.ex_name) === key);

  const tw = c.target_weight !== undefined && c.target_weight !== null ? Number(c.target_weight) : undefined;
  const ts = c.target_seconds !== undefined && c.target_seconds !== null ? Number(c.target_seconds) : undefined;

  if (match) {
    const r = updateTarget(dayNumber, match.ex_name, tw, ts, opts) as any;
    addCoachAdjustmentNote(day.id, match.ex_name, c.note ?? c.reason);
    return { action: "updated", day: dayNumber, exercise: match.ex_name, updated: r.updated, ...(r.clamped ? { clamped: r.clamped } : {}) };
  }

  // ADD: the movement isn't on this day yet. Create the exercise if needed (its
  // group auto-classifies), then append it with the change's prescription + sensible
  // defaults, carrying the coach's reason as the note so the "why" survives.
  const timed = ts !== undefined && tw === undefined;
  const ex = findOrCreateExercise(name, undefined, undefined, c.mode ?? (timed ? "timed" : "reps"));
  const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM plan_items WHERE plan_day_id = ?`).get(day.id) as any).p;
  const sets = Number.isFinite(Number(c.sets)) && Number(c.sets) > 0 ? Math.trunc(Number(c.sets)) : 3;
  const repLow = c.rep_low != null && Number.isFinite(Number(c.rep_low)) ? Math.trunc(Number(c.rep_low)) : timed ? null : 8;
  const repHigh = c.rep_high != null && Number.isFinite(Number(c.rep_high)) ? Math.trunc(Number(c.rep_high)) : timed ? null : 12;
  const noteSrc = c.note ?? c.reason;
  const note = noteSrc != null && String(noteSrc).trim() ? String(noteSrc).trim().slice(0, 500) : null;
  insertPlanItem({ plan_day_id: day.id, position: pos, exercise_id: ex.id, sets, rep_low: repLow, rep_high: repHigh, target_weight: tw ?? null, note, target_seconds: ts ?? null, kind: "strength" });
  return { action: "added", day: dayNumber, exercise: ex.name };
}

// Replace one exercise IN PLACE on a day (the swap/rotate intent). Finds the plan
// item for `from` (exact name, then a normalized-key drift match), points it at the
// resolved `to` exercise, keeps the slot (position/sets/reps/superset), and starts the
// new movement light (target reset + a "start light, log actual" note) since load
// rarely transfers cleanly across a variation. Throws when `from` isn't on the day
// (so applyProposal reports it honestly) or `to` is missing.
function applyPlanSwap(
  dayId: number,
  dayNumber: number,
  swap: { from?: string | null; to?: string | null },
  reason: string | null,
): { action: "swapped"; day: number; exercise: string; from: string; updated: number } {
  const fromName = String(swap.from ?? "").trim();
  const toName = String(swap.to ?? "").trim();
  if (!fromName) throw new Error("swap.from required");
  if (!toName) throw new Error("swap.to required");

  const dayItems = db.prepare(
    `SELECT pi.id AS id, pi.target_seconds AS target_seconds, e.name AS ex_name, e.mode AS mode
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`
  ).all(dayId) as any[];
  const fromNorm = normalizeExerciseName(fromName);
  const fromKey = normalizedExerciseKey(fromName);
  // Tier 3 (movementKey): the plan may name a different IMPLEMENT for the same slot
  // ("DB Bench Press" on the plan, "Barbell Bench Press" in the logs) — the swap
  // still targets that slot rather than erroring on a lift the athlete demonstrably
  // trains. Exact/normalized matches always win first.
  const fromMove = movementKey(fromName);
  const match =
    dayItems.find((r) => normalizeExerciseName(r.ex_name) === fromNorm) ??
    dayItems.find((r) => normalizedExerciseKey(r.ex_name) === fromKey) ??
    dayItems.find((r) => movementKey(r.ex_name) === fromMove);
  if (!match) throw new Error(`"${fromName}" is not on day ${dayNumber} to swap out`);

  // Resolve (or create) the incoming movement — its group + mode auto-classify from
  // the name (findOrCreateExercise applies detectExerciseMode when mode is omitted).
  const toEx = findOrCreateExercise(toName);
  const note = `Rotated in for ${match.ex_name}${reason ? ` — ${reason}` : ""} — start light, log your actual working weight.`.slice(0, 500);
  const timed = toEx.mode === "timed";
  const info = db.prepare(
    `UPDATE plan_items SET exercise_id = ?, target_weight = NULL, target_seconds = ?, note = ? WHERE id = ?`
  ).run(toEx.id, timed ? (match.target_seconds ?? null) : null, note, match.id);
  return { action: "swapped", day: dayNumber, exercise: toEx.name, from: match.ex_name, updated: Number(info.changes) };
}

// Append one exercise to an existing plan day — the graceful landing for a rotate-in
// whose `from` isn't represented anywhere on the plan (nothing to swap out, but the
// athlete asked for the movement, so it lands on the day that already trains that
// area instead of dead-ending). Conservative slot defaults (3×8-12 / 30s hold,
// no target load — start light, log actual). Null when the day doesn't exist.
export function addExerciseToPlanDay(
  dayNumber: number,
  name: string,
  note?: string | null,
): { day: number; exercise: string } | null {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(Number(dayNumber)) as any;
  if (!day) return null;
  const ex = findOrCreateExercise(String(name ?? "").trim());
  const pos = (db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM plan_items WHERE plan_day_id = ?`).get(day.id) as any).p;
  const timed = ex.mode === "timed";
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note, target_seconds)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(day.id, pos, ex.id, 3, timed ? null : 8, timed ? null : 12, note ? String(note).slice(0, 500) : null, timed ? 30 : null);
  bumpTrainingDataVersion();
  invalidateDayRead();
  return { day: Number(dayNumber), exercise: ex.name };
}

// ---------- plan editing (manual + restructure) ----------
export interface PlanItemInput {
  exercise?: string;            // optional for a cardio item (its label can live in `note`)
  sets?: number;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  note?: string | null;
  warmup_sets?: number | null;
  target_seconds?: number | null;
  superset_group?: number | null;       // pair items on a day into a superset (v56); NULL = standalone
  mode?: string | null; // applied when the exercise is created (reps | timed)
  // First-class planned cardio (v35). kind:'cardio' carries an endurance
  // prescription with NO loaded exercise; kind:'strength' (default) is unchanged.
  kind?: string | null;                 // strength | cardio
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
  interval?: any;                       // structured interval JSON (any shape)
  interval_json?: string | null;        // raw JSON string accepted too
}

const numOrNull = (v: any): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function intervalJson(it: PlanItemInput): string | null {
  if (it.interval_json != null) {
    const s = String(it.interval_json).trim();
    if (!s) return null;
    try { JSON.parse(s); return s.slice(0, 4000); } catch { return null; }
  }
  if (it.interval != null) {
    try { return JSON.stringify(it.interval).slice(0, 4000); } catch { return null; }
  }
  return null;
}

// Upsert one day and replace its full exercise list. Unknown exercises are created.
// A cardio item (kind:'cardio') is written with a NULL exercise_id and its endurance
// prescription columns — strength items keep their exercise-id behavior unchanged.
export function savePlanDay(day_number: number, name: string, focus: string | null, items: PlanItemInput[]) {
  const existing = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(day_number) as any;
  let dayId: number;
  if (existing) {
    db.prepare(`UPDATE plan_days SET name = ?, focus = ? WHERE id = ?`).run(name, focus ?? null, existing.id);
    dayId = existing.id;
    db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(dayId);
  } else {
    dayId = Number(
      db.prepare(`INSERT INTO plan_days (day_number, name, focus) VALUES (?, ?, ?)`).run(day_number, name, focus ?? null).lastInsertRowid
    );
  }
  (items || []).forEach((it, i) => {
    const isCardio = String(it.kind ?? "").toLowerCase() === "cardio";
    if (isCardio) {
      // A cardio item needs no exercise; its label rides in `note` (or `exercise`,
      // folded into the note so the column stays NULL). Endurance prescription only.
      const label = String(it.exercise ?? "").trim();
      const note = it.note != null && String(it.note).trim() ? String(it.note).trim() : (label || null);
      insertPlanItem({
        plan_day_id: dayId, position: i, exercise_id: null, sets: it.sets ?? 1,
        note: note ? note.slice(0, 500) : null, kind: "cardio",
        target_distance_km: numOrNull(it.target_distance_km), target_duration_min: numOrNull(it.target_duration_min),
        target_zone: it.target_zone != null && String(it.target_zone).trim() ? String(it.target_zone).trim().slice(0, 40) : null,
        interval_json: intervalJson(it),
      });
      return;
    }
    if (!it.exercise || !String(it.exercise).trim()) return;
    const ex = findOrCreateExercise(String(it.exercise), undefined, undefined, it.mode ?? undefined);
    insertPlanItem({
      plan_day_id: dayId, position: i, exercise_id: ex.id, sets: it.sets ?? 3,
      rep_low: it.rep_low ?? null, rep_high: it.rep_high ?? null, target_weight: it.target_weight ?? null,
      note: it.note ?? null, warmup_sets: it.warmup_sets ?? null, target_seconds: it.target_seconds ?? null, kind: "strength",
      superset_group: numOrNull(it.superset_group),
    });
  });
  // A changed plan day can change what "today" points at (focus/frequency) — refresh
  // the cached Brief so an applied edit isn't read against the old day from any surface.
  invalidateDayRead();
  // plan_days count feeds getWeeklyStats.week_planned; bump covers a same-count in-place
  // day rewrite too (setWeeklyRuns + replacePlan reach here, so they're covered as well).
  bumpTrainingDataVersion();
  emitBrainEvent({
    kind: "plan_changed",
    domain: "training",
    date: localDateISO(),
    entity_id: dayId,
    subject_key: `day:${day_number}`,
  });
  return getPlanDay(day_number);
}

// A single run prescription the coach can hand back for THIS week, applyable without
// a full plan restructure (the heavy `days` path). Each maps onto a plan day.
export interface RunPrescription {
  day_number: number;
  label?: string | null;               // e.g. "Easy run", "Long run", "Tempo"
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;          // Z2 | easy | tempo | threshold | intervals | long
  note?: string | null;
  day_name?: string | null;             // used only when CREATING a new day for this run
  focus?: string | null;
  interval?: any;                       // structured interval reps (e.g. [{reps,on,off,zone}]) — persisted as interval_json
}

// Apply a week of run prescriptions onto the plan WITHOUT touching strength work: for
// each day, keep its strength items and replace its cardio items with the given runs.
// A day_number with no plan day yet is created as a dedicated run day. This is the
// surgical counterpart to a full `replacePlan` restructure — used by the apply path so
// a runner/hybrid athlete can accept "this week's runs" while lifting stays intact.
export function setWeeklyRuns(runs: RunPrescription[]) {
  const byDay = new Map<number, RunPrescription[]>();
  for (const r of runs || []) {
    const dn = Math.trunc(Number(r?.day_number));
    if (!Number.isFinite(dn) || dn < 1) continue;
    if (!byDay.has(dn)) byDay.set(dn, []);
    byDay.get(dn)?.push(r);
  }
  const applied: { day_number: number; runs: number; created: boolean }[] = [];
  for (const [dn, dayRuns] of byDay) {
    const existing = getPlanDay(dn);
    const strength: PlanItemInput[] = existing
      ? existing.items
          .filter((it: any) => it.kind !== "cardio")
          .map((it: any) => ({
            exercise: it.exercise, sets: it.sets, rep_low: it.rep_low, rep_high: it.rep_high,
            target_weight: it.target_weight, note: it.note, warmup_sets: it.warmup_sets,
            target_seconds: it.target_seconds, mode: it.mode, superset_group: it.superset_group,
          }))
      : [];
    const cardio: PlanItemInput[] = dayRuns.map((r) => ({
      kind: "cardio",
      exercise: (r.label ?? "Run") || "Run",
      target_distance_km: numOrNull(r.target_distance_km),
      target_duration_min: numOrNull(r.target_duration_min),
      target_zone: r.target_zone ?? null,
      note: r.note ?? null,
      // Persist interval STRUCTURE for an interval/quality session (the column
      // already exists; intervalJson() coerces it to a bounded JSON string).
      interval_json: r.interval != null ? JSON.stringify(r.interval) : null,
    }));
    const name = existing?.name ?? (dayRuns[0]?.day_name || "Run");
    const focus = existing?.focus ?? (dayRuns[0]?.focus || "Endurance");
    savePlanDay(dn, name, focus, [...strength, ...cardio]);
    applied.push({ day_number: dn, runs: cardio.length, created: !existing });
  }
  return { applied };
}

export function deletePlanDay(day_number: number) {
  const d = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(day_number) as any;
  if (!d) return { deleted: 0, day_number };
  db.prepare(`UPDATE sessions SET plan_day_id = NULL WHERE plan_day_id = ?`).run(d.id); // keep history, drop the link
  const r = db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(d.id); // plan_items cascade
  if (r.changes) bumpTrainingDataVersion(); // removing a day changes week_planned
  if (r.changes)
    emitBrainEvent({
      kind: "plan_changed",
      domain: "training",
      date: localDateISO(),
      entity_id: d.id,
      subject_key: `day:${day_number}`,
    });
  return { deleted: r.changes, day_number };
}

// Full restructure: make the plan exactly the given days (add/remove/rewrite).
export function replacePlan(days: { day_number?: number; name?: string; focus?: string | null; items?: PlanItemInput[] }[]) {
  if (!Array.isArray(days) || !days.length) throw new Error("replacePlan needs a non-empty days array");
  db.exec("BEGIN");
  try {
    const normalized = days.map((d, i) => ({ ...d, day_number: Number(d.day_number ?? i + 1) }));
    const keep = new Set(normalized.map((d) => d.day_number));
    const existing = db.prepare(`SELECT day_number FROM plan_days`).all() as any[];
    for (const e of existing) if (!keep.has(e.day_number)) deletePlanDay(e.day_number);
    normalized.forEach((d, i) => savePlanDay(d.day_number, d.name || `Day ${i + 1}`, d.focus ?? null, d.items || []));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  // A restructure (new split/frequency) can move what today should be — bust the
  // cached Brief so a stale "train your old focus" read never survives an apply.
  invalidateDayRead();
  emitBrainEvent({
    kind: "plan_changed",
    domain: "training",
    date: localDateISO(),
    subject_key: "full-plan",
    material: true,
  });
  return getPlan();
}

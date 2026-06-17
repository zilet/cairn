import { db } from "../db.js";
import { findExercise, findOrCreateExercise } from "./exercises.js";

// ---------- plan ----------
export function getPlan() {
  const days = db.prepare(`SELECT * FROM plan_days ORDER BY day_number`).all() as any[];
  return days.map((d) => ({
    ...d,
    items: db
      .prepare(
        `SELECT pi.id, pi.plan_day_id, pi.position, pi.sets, pi.rep_low, pi.rep_high,
                pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds,
                e.name AS exercise, e.muscle_group, e.unit, e.constraint_note, e.mode
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
         WHERE pi.plan_day_id = ? ORDER BY pi.position`
      )
      .all(d.id),
  }));
}

export function getPlanDay(dayNumber: number) {
  const d = db.prepare(`SELECT * FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!d) return null;
  return {
    ...d,
    items: db
      .prepare(
        `SELECT pi.id, pi.plan_day_id, pi.position, pi.sets, pi.rep_low, pi.rep_high,
                pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds,
                e.name AS exercise, e.muscle_group, e.unit, e.constraint_note, e.mode
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
         WHERE pi.plan_day_id = ? ORDER BY pi.position`
      )
      .all(d.id),
  };
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
    const constrained = !!(ex.constraint_note && String(ex.constraint_note).trim());
    // Read the CURRENT prescribed targets to clamp the step against.
    const cur = db
      .prepare(`SELECT target_weight, target_seconds FROM plan_items WHERE plan_day_id = ? AND exercise_id = ?`)
      .get(day.id, ex.id) as any;
    if (target_weight !== undefined && target_weight !== null && Number.isFinite(Number(target_weight))) {
      const r = clampStep("target_weight", ex.name, cur?.target_weight ?? null, Number(target_weight), CLAMP_WEIGHT_FLOOR_LB, constrained);
      target_weight = r.applied;
      if (r.adjustment) clamps.push(r.adjustment);
    }
    if (target_seconds !== undefined && target_seconds !== null && Number.isFinite(Number(target_seconds))) {
      const r = clampStep("target_seconds", ex.name, cur?.target_seconds ?? null, Number(target_seconds), CLAMP_SECONDS_FLOOR, constrained);
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

// ---------- plan editing (manual + restructure) ----------
export interface PlanItemInput {
  exercise: string;
  sets?: number;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  note?: string | null;
  warmup_sets?: number | null;
  target_seconds?: number | null;
  mode?: string | null; // applied when the exercise is created (reps | timed)
}

// Upsert one day and replace its full exercise list. Unknown exercises are created.
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
  const ins = db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note, warmup_sets, target_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  (items || []).forEach((it, i) => {
    if (!it.exercise || !String(it.exercise).trim()) return;
    const ex = findOrCreateExercise(String(it.exercise), undefined, undefined, it.mode ?? undefined);
    ins.run(dayId, i, ex.id, it.sets ?? 3, it.rep_low ?? null, it.rep_high ?? null, it.target_weight ?? null, it.note ?? null, it.warmup_sets ?? null, it.target_seconds ?? null);
  });
  return getPlanDay(day_number);
}

export function deletePlanDay(day_number: number) {
  const d = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(day_number) as any;
  if (!d) return { deleted: 0, day_number };
  db.prepare(`UPDATE sessions SET plan_day_id = NULL WHERE plan_day_id = ?`).run(d.id); // keep history, drop the link
  const r = db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(d.id); // plan_items cascade
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
  return getPlan();
}


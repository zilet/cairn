import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { constraintLimitsLoad, movementKey, normalizeExerciseName, normalizedExerciseKey } from "./exercise-canon.js";
import { findExercise, findOrCreateExercise, recentWorkingSeconds, recentWorkingWeight } from "./exercises.js";
import { relatedLiftStart } from "./related-lift.js";
import { invalidateDayRead } from "./intelligence.js";
import { localDateISO } from "./shared.js";
import { bumpTrainingDataVersion } from "./training-cache.js";
import { PlanQualityError, pressSlotKey, qualityIssueKey, validateTrainingPlan } from "./plan-quality.js";
import { afterSqliteCommit, withSqliteSavepoint } from "./sqlite-savepoint.js";
import {
  type ReasonProvenance,
  normalizeHistoricalReason,
  validReasonProvenance,
} from "./proposal-truth.js";

export { PlanQualityError, pressSlotKey, validateTrainingPlan } from "./plan-quality.js";

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
  try {
    interval = row.interval_json ? JSON.parse(row.interval_json) : null;
  } catch {
    interval = null;
  }
  const { interval_json, ...rest } = row;
  return { ...rest, kind, interval };
}

type AccountablePlanChange = {
  decision_id: number;
  summary: string;
  rationale: string | null;
  reason_provenance: ReasonProvenance | null;
  reversible: boolean;
  before: Omit<PlanPrescription, "day_number" | "exercise"> | null;
};

function accountablePlanChanges(): Map<string, AccountablePlanChange> {
  const map = new Map<string, AccountablePlanChange>();
  try {
    const rows = db
      .prepare(
        `SELECT d.id, d.created_at, d.effective_date, d.summary, d.rationale, d.reversible,
                d.action_json, d.context_json, p.created_at AS proposal_created_at
         FROM brain_decisions d
         LEFT JOIN plan_proposals p
           ON d.source_ref_type = 'plan_proposal' AND d.source_ref_key = CAST(p.id AS TEXT)
        WHERE d.status = 'applied' AND d.domain = 'training' AND d.autonomy_tier IN ('quiet_apply','announce')
        ORDER BY d.id DESC LIMIT 100`
      )
      .all() as any[];
    for (const row of rows) {
      let action: any = null;
      try {
        action = row.action_json ? JSON.parse(row.action_json) : null;
      } catch {
        action = null;
      }
      let context: any = null;
      try {
        context = row.context_json ? JSON.parse(row.context_json) : null;
      } catch {
        context = null;
      }
      for (const change of Array.isArray(action?.changes) ? action.changes : []) {
        const day = Number(change?.day_number);
        const exercise = String(change?.exercise ?? "")
          .trim()
          .toLowerCase();
        if (!Number.isFinite(day) || !exercise) continue;
        const key = `${day}|${exercise}`;
        const reasonProvenance = validReasonProvenance(change?.reason_provenance)
          ? change.reason_provenance
          : null;
        const fallbackAsOf = String(
          reasonProvenance?.as_of_date ??
            context?.proposal_as_of_date ??
            row.proposal_created_at ??
            row.effective_date ??
            row.created_at ??
            localDateISO()
        ).slice(0, 10);
        if (!map.has(key))
          map.set(key, {
            decision_id: Number(row.id),
            summary: normalizeHistoricalReason(
              String(row.summary ?? "Cairn adjusted this exercise."),
              null,
              fallbackAsOf
            ),
            rationale:
              change?.reason != null || row.rationale != null
                ? normalizeHistoricalReason(change?.reason ?? row.rationale, reasonProvenance, fallbackAsOf)
                : null,
            reason_provenance: reasonProvenance,
            reversible: !!row.reversible,
            before:
              change?.before && typeof change.before === "object"
                ? {
                    sets: change.before.sets ?? null,
                    rep_low: change.before.rep_low ?? null,
                    rep_high: change.before.rep_high ?? null,
                    target_weight: change.before.target_weight ?? null,
                    target_seconds: change.before.target_seconds ?? null,
                  }
                : null,
          });
      }
    }
  } catch {
    /* pre-ledger / partial migration: plan reads remain unchanged */
  }
  return map;
}

// ---------- accountable prescription diff ----------
// The ledger's `action.changes` is what lights up per-item provenance on every plan
// surface (decorateAccountablePlan below). A targeted `changes[]` apply can describe
// itself, but a RESTRUCTURE (parsed.days -> replacePlan) rewrites the whole template
// at once and used to record only `action.days` — so the athlete saw sets drop from
// four to two with nothing anywhere saying why. These two helpers give both apply
// paths one shape: snapshot the live prescriptions before the mutation, diff after.
export interface PlanPrescription {
  day_number: number;
  exercise: string;
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  target_seconds: number | null;
}

// The canonical `action.changes` entry. After-values stay at the TOP level (the shape
// the targeted path already wrote, and the shape accountablePlanChanges reads); the
// pre-change prescription rides in `before`, so "why is this different" can be
// answered without re-deriving history.
export interface AccountablePlanChangeRecord extends PlanPrescription {
  change: "updated" | "added";
  before: Omit<PlanPrescription, "day_number" | "exercise"> | null;
  reason: string | null;
  reason_provenance: ReasonProvenance | null;
}

export function planPrescriptionKey(dayNumber: unknown, exercise: unknown): string | null {
  const day = Number(dayNumber);
  const name = String(exercise ?? "")
    .trim()
    .toLowerCase();
  return Number.isFinite(day) && name ? `${day}|${name}` : null;
}

// Every strength prescription currently on the template, keyed the same way
// decorateAccountablePlan keys its lookup. Cardio rows carry no loaded prescription
// to compare, so they stay out of the diff (their provenance rides `run_reasons`).
export function planPrescriptionSnapshot(): Map<string, PlanPrescription> {
  const map = new Map<string, PlanPrescription>();
  const rows = db
    .prepare(
      `SELECT pd.day_number, e.name AS exercise, pi.sets, pi.rep_low, pi.rep_high,
              pi.target_weight, pi.target_seconds
         FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id
         JOIN exercises e ON e.id = pi.exercise_id
        WHERE pi.kind IS NULL OR pi.kind != 'cardio'`
    )
    .all() as any[];
  for (const row of rows) {
    const key = planPrescriptionKey(row.day_number, row.exercise);
    if (!key || map.has(key)) continue;
    map.set(key, {
      day_number: Number(row.day_number),
      exercise: String(row.exercise),
      sets: row.sets ?? null,
      rep_low: row.rep_low ?? null,
      rep_high: row.rep_high ?? null,
      target_weight: row.target_weight ?? null,
      target_seconds: row.target_seconds ?? null,
    });
  }
  return map;
}

function samePrescription(a: PlanPrescription, b: PlanPrescription): boolean {
  return (
    a.sets === b.sets &&
    a.rep_low === b.rep_low &&
    a.rep_high === b.rep_high &&
    a.target_weight === b.target_weight &&
    a.target_seconds === b.target_seconds
  );
}

// Only what MOVED. A removed movement is deliberately absent: it is no longer on the
// plan, so nothing on a plan surface could carry its note, and listing it would only
// pad the ledger. Reasons come from the proposal's own per-item prose when it wrote
// any; an item the agent changed silently still gets its before/after, and the
// decision's own rationale remains the fallback the surface reads.
export function planPrescriptionDiff(
  before: Map<string, PlanPrescription>,
  after: Map<string, PlanPrescription>,
  reasons: Map<string, { reason: string | null; reason_provenance: ReasonProvenance | null }> = new Map(),
  limit = 24
): AccountablePlanChangeRecord[] {
  const out: AccountablePlanChangeRecord[] = [];
  for (const [key, next] of after) {
    const prior = before.get(key);
    if (prior && samePrescription(prior, next)) continue;
    const note = reasons.get(key);
    out.push({
      ...next,
      change: prior ? "updated" : "added",
      before: prior
        ? {
            sets: prior.sets,
            rep_low: prior.rep_low,
            rep_high: prior.rep_high,
            target_weight: prior.target_weight,
            target_seconds: prior.target_seconds,
          }
        : null,
      reason: note?.reason ?? null,
      reason_provenance: note?.reason_provenance ?? null,
    });
  }
  return out
    .sort((a, b) => a.day_number - b.day_number || a.exercise.localeCompare(b.exercise))
    .slice(0, Math.max(0, Math.trunc(limit)));
}

// Per-item prose off a restructure payload (`parsed.days[].items[]`), keyed for the
// diff above. `label` is the cardio/free-form spelling some drafts use for `exercise`.
export function planRestructureReasons(
  days: unknown
): Map<string, { reason: string | null; reason_provenance: ReasonProvenance | null }> {
  const map = new Map<string, { reason: string | null; reason_provenance: ReasonProvenance | null }>();
  for (const day of Array.isArray(days) ? days : []) {
    const dayNumber = (day as any)?.day_number;
    for (const item of Array.isArray((day as any)?.items) ? (day as any).items : []) {
      const key = planPrescriptionKey(dayNumber, item?.exercise ?? item?.label);
      if (!key || map.has(key)) continue;
      const reason = item?.reason == null ? null : String(item.reason);
      if (!reason && !item?.reason_provenance) continue;
      map.set(key, {
        reason,
        reason_provenance: validReasonProvenance(item?.reason_provenance) ? item.reason_provenance : null,
      });
    }
  }
  return map;
}

// ---------- what the plan has already DONE to one lift ------------------------
// The plan itself keeps no per-target history, so applied proposals are the only
// audit trail of a load cut. Auto-progression marks its own deload changes
// (`progression_action: 'deload'`) precisely so a SECOND cut on the same lift can
// be recognised as a repeat rather than prescribed as another identical one — see
// the escalation branch in repo/progression.ts. A fuel-protection dose never
// carries the marker: that cut is about fuel, not about this lift stalling.
//
// Fail-soft: an unreadable payload counts as nothing, so a bad row can never
// manufacture an escalation.
export function appliedProgressionDeloads(exerciseName: string, sinceISO: string, asOfISO?: string): number {
  return countAppliedProgressionChanges(exerciseName, sinceISO, asOfISO, (change) => change?.progression_action === "deload");
}

/**
 * How many times an ESCALATED rep wave has actually been applied to this lift.
 *
 * The escalation branch answers a repeated deload by changing the SHAPE of the
 * work rather than cutting again — but a wave that is itself repeated every week
 * is the same failure one rung up, and it never terminates. So the applied wave
 * carries its own marker (`progression_escalation`) and the branch reads it back:
 * a lift already inside a wave is left to run it out, not re-waved.
 */
export function appliedProgressionEscalations(exerciseName: string, sinceISO: string, asOfISO?: string): number {
  return countAppliedProgressionChanges(
    exerciseName,
    sinceISO,
    asOfISO,
    (change) => change?.progression_escalation === "rep_wave"
  );
}

function countAppliedProgressionChanges(
  exerciseName: string,
  sinceISO: string,
  asOfISO: string | undefined,
  matches: (change: any) => boolean
): number {
  const key = normalizedExerciseKey(String(exerciseName ?? ""));
  if (!key) return 0;
  const since = String(sinceISO ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return 0;
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(asOfISO ?? "").slice(0, 10))
    ? String(asOfISO).slice(0, 10)
    : localDateISO();
  let rows: Array<{ parsed_json: string | null }> = [];
  try {
    rows = db
      .prepare(
        `SELECT parsed_json FROM plan_proposals
          WHERE status = 'applied' AND parsed_json IS NOT NULL
            AND date(created_at) >= ? AND date(created_at) <= ?`
      )
      .all(since, asOf) as Array<{ parsed_json: string | null }>;
  } catch {
    return 0;
  }
  let count = 0;
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(row?.parsed_json ?? ""));
    } catch {
      continue;
    }
    const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
    const hit = changes.some(
      (change: any) => matches(change) && normalizedExerciseKey(String(change?.exercise ?? "")) === key
    );
    if (hit) count += 1;
  }
  return count;
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
            brain_change_reason_provenance: change.reason_provenance,
            brain_change_reversible: change.reversible,
            brain_change_before: change.before,
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
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  const stampUTC = (d: Date) =>
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  const dateOnly = (d: Date) => `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  // RFC 5545 line folding: ≤75 octets, continuation lines begin with a space.
  const fold = (line: string) => {
    if (Buffer.byteLength(line, "utf8") <= 75) return line;
    const out: string[] = [];
    let cur = "";
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch, "utf8") > 74) {
        out.push(cur);
        cur = " " + ch;
      } else cur += ch;
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
    const lo = it.rep_low,
      hi = it.rep_high;
    const reps = lo && hi ? (lo === hi ? `${lo}` : `${lo}-${hi}`) : lo || hi || "";
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
const CLAMP_STEP_FRAC = 0.1; // max progression step = 10% of the current target…
const CLAMP_WEIGHT_FLOOR_LB = 10; // …or this many lb, whichever is larger (so light weights still move)
const CLAMP_SECONDS_FLOOR = 10; // …or this many seconds for timed holds

// The transparent record of a code-enforced adjustment (V3 renders these as a
// calm "adjusted to a safe step" note). `field` is the value that was capped
// (target_weight/target_seconds for training; target_kcal/protein_g for the
// nutrition advisory). `exercise` names the subject (an exercise, or "nutrition
// target"). NEVER silent — every cap produces one of these.
export interface ClampAdjustment {
  exercise: string;
  field: string;
  requested: number;
  applied: number | null;
  reason: string;
}

function boundPrescriptionInt(
  field: "sets" | "rep_low" | "rep_high",
  exercise: string,
  value: unknown,
  min: number,
  max: number
): { value: number | null; adjustment: ClampAdjustment | null } {
  if (value == null || !Number.isFinite(Number(value))) return { value: null, adjustment: null };
  const requested = Math.trunc(Number(value));
  const applied = Math.max(min, Math.min(max, requested));
  return {
    value: applied,
    adjustment:
      applied === requested
        ? null
        : {
            exercise,
            field,
            requested,
            applied,
            reason: `${field} bounded to the supported ${min}–${max} range`,
          },
  };
}

// A volume cut is not a load step, and it is the one prescription field the
// progression ladder structurally cannot climb back: overload only ever moves
// load/reps, so an applied change that drops an item from 5 sets to 1 is a
// one-way ratchet. On the APPLY path an applied change may therefore lower an
// item's `sets` by at most one per revision. A halver that keeps proposing
// ceil(n/2) simply descends one step per natural boundary — which is the
// bounded-reversible-change law, not a refusal. Increases are untouched, and a
// deliberate manual edit (clamp:false) is never stepped: the athlete drives.
//
// The step is measured against where the plan stood when the REVISION began, not
// against the row's live value. Applying a proposal writes its changes[] one at a
// time, so a payload naming the same day+exercise three times would otherwise walk
// 5 → 4 → 3 → 2 inside a single apply, each hop legal on its own — one revision,
// three sets gone. `revision_baseline` (the pre-apply prescription snapshot the
// caller already reads for provenance) makes the whole revision the unit.
const MAX_SET_REDUCTION_PER_APPLY = 1;

function clampSetReductionStep(
  exercise: string,
  current: number | null,
  requested: number | null
): { value: number | null; adjustment: ClampAdjustment | null } {
  if (requested == null || current == null || !Number.isFinite(current)) return { value: requested, adjustment: null };
  const floor = Math.max(1, Math.trunc(current) - MAX_SET_REDUCTION_PER_APPLY);
  if (requested >= floor) return { value: requested, adjustment: null };
  return {
    value: floor,
    adjustment: {
      exercise,
      field: "sets",
      requested,
      applied: floor,
      reason: `sets lowered one step at a time (requested ${requested}, applied ${floor} from ${Math.trunc(current)})`,
    },
  };
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
      adjustment: {
        exercise,
        field,
        requested,
        applied: current,
        reason: "held — exercise has an injury constraint; load not increased",
      },
    };
  }

  if (Math.abs(delta) <= maxStep) return { applied: requested, adjustment: null };

  const applied = Math.round(current + Math.sign(delta) * maxStep);
  const dir = delta > 0 ? "increase" : "decrease";
  return {
    applied,
    adjustment: {
      exercise,
      field,
      requested,
      applied,
      reason: `${dir} capped to a safe step (≤${Math.round(maxStep)}${isWeight ? " lb" : " sec"} vs current ${current})`,
    },
  };
}

type AgentPrescriptionKind = "add" | "update" | "swap";

// The single load trust-boundary for agent-originated strength-plan writes. ADD,
// UPDATE and SWAP all call this before persistence. A model value is never treated
// as evidence: new/swapped movements need exact-exercise logged history, while an
// existing prescription may also use its stored target as the update baseline.
// Load-limiting constraints are never papered over with a confident new target.
function canonicalizeAgentPrescriptionLoad(
  exercise: { name: string; constraint_note?: string | null },
  kind: AgentPrescriptionKind,
  requested: { target_weight?: number; target_seconds?: number },
  current: { target_weight?: number | null; target_seconds?: number | null } = {}
): {
  target_weight?: number | null;
  target_seconds?: number | null;
  adjustments: ClampAdjustment[];
} {
  const adjustments: ClampAdjustment[] = [];
  const out: { target_weight?: number | null; target_seconds?: number | null } = {};
  const constrained = constraintLimitsLoad(exercise.constraint_note);

  const canonicalize = (
    field: "target_weight" | "target_seconds",
    value: number | undefined,
    history: number | null,
    stored: number | null | undefined,
    floor: number
  ) => {
    if (value === undefined || !Number.isFinite(value)) return;
    const baseline =
      kind === "update"
        ? stored != null && history != null
          ? Math.max(stored, history)
          : (stored ?? history)
        : history;

    // An incoming movement with a load-limiting note is intentionally left
    // unprescribed. The note remains the authority and the athlete logs a real,
    // tolerated starting point before Cairn progresses it.
    if (constrained && kind !== "update") {
      out[field] = null;
      adjustments.push({
        exercise: exercise.name,
        field,
        requested: value,
        applied: null,
        reason:
          "prescribed load removed — this exercise has a load-limiting constraint; log a tolerated working value first",
      });
      return;
    }

    if (baseline == null || !Number.isFinite(baseline)) {
      out[field] = null;
      adjustments.push({
        exercise: exercise.name,
        field,
        requested: value,
        applied: null,
        reason: constrained
          ? "prescribed load removed — the active constraint has no established safe baseline"
          : "prescribed load removed — no exact-exercise working history anchors a safe starting value",
      });
      return;
    }

    const bounded = clampStep(field, exercise.name, baseline, value, floor, constrained);
    out[field] = bounded.applied;
    if (bounded.adjustment) adjustments.push(bounded.adjustment);
  };

  canonicalize(
    "target_weight",
    requested.target_weight,
    recentWorkingWeight(exercise.name),
    current.target_weight,
    CLAMP_WEIGHT_FLOOR_LB
  );
  canonicalize(
    "target_seconds",
    requested.target_seconds,
    recentWorkingSeconds(exercise.name),
    current.target_seconds,
    CLAMP_SECONDS_FLOOR
  );
  return { ...out, adjustments };
}

export function updateTarget(
  dayNumber: number,
  exerciseName: string,
  target_weight?: number | null,
  target_seconds?: number | null,
  opts: {
    clamp?: boolean;
    quality_override?: boolean;
    bump_cache?: boolean;
    invalidate_day_read?: boolean;
  } = {}
) {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) throw new Error(`No plan day ${dayNumber}`);
  const ex = findExercise(exerciseName);
  if (!ex) throw new Error(`No exercise "${exerciseName}"`);
  const cur = db
    .prepare(`SELECT id, target_weight, target_seconds FROM plan_items WHERE plan_day_id = ? AND exercise_id = ?`)
    .get(day.id, ex.id) as any;
  if (!cur) throw new Error(`"${ex.name}" is not on plan day ${dayNumber}`);

  // Apply-path safety clamp (off by default → manual edits pass through verbatim).
  const clamps: ClampAdjustment[] = [];
  if (opts.clamp) {
    if (ex.mode === "reps" && target_seconds !== undefined && target_seconds !== null) {
      throw new Error(`Cannot set target_seconds on reps-based exercise "${ex.name}"`);
    }
    if (ex.mode === "timed" && target_weight !== undefined && target_weight !== null) {
      throw new Error(`Cannot set target_weight on timed exercise "${ex.name}"`);
    }
    const bounded = canonicalizeAgentPrescriptionLoad(
      ex,
      "update",
      {
        ...(target_weight !== undefined && target_weight !== null && Number.isFinite(Number(target_weight))
          ? { target_weight: Number(target_weight) }
          : {}),
        ...(target_seconds !== undefined && target_seconds !== null && Number.isFinite(Number(target_seconds))
          ? { target_seconds: Number(target_seconds) }
          : {}),
      },
      { target_weight: cur?.target_weight ?? null, target_seconds: cur?.target_seconds ?? null }
    );
    if (Object.hasOwn(bounded, "target_weight")) target_weight = bounded.target_weight;
    if (Object.hasOwn(bounded, "target_seconds")) target_seconds = bounded.target_seconds;
    clamps.push(...bounded.adjustments);
  }

  const sets: string[] = [];
  const vals: any[] = [];
  if (target_weight !== undefined) {
    sets.push("target_weight = ?");
    vals.push(target_weight);
  }
  if (target_seconds !== undefined) {
    sets.push("target_seconds = ?");
    vals.push(target_seconds);
  }
  if (!sets.length) throw new Error("target_weight or target_seconds required");

  // Compile the complete candidate day before touching SQLite. This matters for
  // direct/manual target edits too: setting target_seconds on an explicitly
  // reps-based movement (or load on timed work) used to persist an incoherent
  // prescription because only proposal/full-day writes passed through quality.
  const beforePlan = getPlan();
  const candidatePlan = beforePlan.map((candidateDay: any) => {
    if (Number(candidateDay.day_number) !== Number(dayNumber)) return candidateDay;
    return {
      ...candidateDay,
      items: (candidateDay.items ?? []).map((item: any) =>
        Number(item.id) === Number(cur?.id)
          ? {
              ...item,
              ...(target_weight !== undefined ? { target_weight } : {}),
              ...(target_seconds !== undefined ? { target_seconds } : {}),
            }
          : item
      ),
    };
  });
  const quality = validateTrainingPlan(candidatePlan);
  const beforeKeys = new Set(validateTrainingPlan(beforePlan).errors.map(qualityIssueKey));
  const blocking = quality.errors.filter(
    (entry) => Number(entry.day_number) === Number(dayNumber) || !beforeKeys.has(qualityIssueKey(entry))
  );
  if (blocking.length && opts.quality_override !== true) {
    throw new PlanQualityError({ ok: false, errors: blocking, warnings: quality.warnings });
  }

  vals.push(day.id, ex.id);
  const info = db
    .prepare(`UPDATE plan_items SET ${sets.join(", ")} WHERE plan_day_id = ? AND exercise_id = ?`)
    .run(...vals);
  if (info.changes && opts.bump_cache !== false) afterSqliteCommit(bumpTrainingDataVersion);
  if (info.changes && opts.invalidate_day_read !== false) invalidateDayRead();
  return {
    updated: info.changes,
    day: dayNumber,
    exercise: ex.name,
    ...(target_weight !== undefined ? { target_weight } : {}),
    ...(target_seconds !== undefined ? { target_seconds } : {}),
    ...(clamps.length ? { clamped: clamps } : {}),
    ...(blocking.length ? { quality_override: true, quality } : {}),
  };
}

// The ONE place that knows the plan_items column shape. Every insert — savePlanDay's
// cardio + strength branches and applyPlanChange's ADD — goes through it, so a schema
// column change is a single edit instead of three parallel 15-column statements.
// Omitted columns default to NULL (kind defaults to 'strength').
function insertPlanItem(row: {
  plan_day_id: number;
  position: number;
  exercise_id: number | null;
  sets?: number | null;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  note?: string | null;
  warmup_sets?: number | null;
  target_seconds?: number | null;
  kind?: string;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
  interval_json?: string | null;
  superset_group?: number | null;
}) {
  return db
    .prepare(
      `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets, rep_low, rep_high, target_weight, note, warmup_sets, target_seconds, kind, target_distance_km, target_duration_min, target_zone, interval_json, superset_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.plan_day_id,
      row.position,
      row.exercise_id ?? null,
      row.sets ?? null,
      row.rep_low ?? null,
      row.rep_high ?? null,
      row.target_weight ?? null,
      row.note ?? null,
      row.warmup_sets ?? null,
      row.target_seconds ?? null,
      row.kind ?? "strength",
      row.target_distance_km ?? null,
      row.target_duration_min ?? null,
      row.target_zone ?? null,
      row.interval_json ?? null,
      row.superset_group ?? null
    );
}

const COACH_NOTE_PREFIX = "Coach note: ";
const PLAN_ITEM_NOTE_LIMIT = 500;

// Cut `text` down to `maxLen` without ever landing mid-word: prefer the last
// complete sentence (a `.`/`!`/`?` followed by whitespace or the string's end),
// and fall back to the last whole word when there is no sentence break in the
// budget at all.
function truncateAtSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  const sentence = slice.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (sentence && sentence[0].trim()) return sentence[0].trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

// A stored note is at most two layers: the item's own base note (manual, or
// none) and the most recent "Coach note: ..." layer. Strip the coach layer
// (and anything after it — old stacked layers from before this fix) to get
// back the stable base the next adjustment should be appended to.
function stripCoachNoteLayer(note: string): string {
  const marker = note.indexOf(`\n${COACH_NOTE_PREFIX}`);
  if (marker >= 0) return note.slice(0, marker).trim();
  if (note.startsWith(COACH_NOTE_PREFIX)) return "";
  return note.trim();
}

function currentCoachNoteLayer(note: string): string | null {
  const marker = note.indexOf(`\n${COACH_NOTE_PREFIX}`);
  if (marker >= 0) return note.slice(marker + 1);
  if (note.startsWith(COACH_NOTE_PREFIX)) return note;
  return null;
}

// Preserve the coach's "why" at the exact exercise it changed. A plan item can
// already carry a useful manual note, so a background adjustment appends a compact
// rationale instead of overwriting it. Re-applying the same reason is idempotent.
// A NEW coach note REPLACES the previous coach-note layer rather than stacking on
// top of it — the note field is a stable prescription fact, not a log, so only the
// current rationale needs to survive. That also keeps the field bounded: without
// it, every adjustment call grew the note by another layer forever, and the final
// join eventually pushed the total past the 500-char column budget, silently
// truncating whatever was left mid-word (never the newest note's own fault).
function addCoachAdjustmentNote(planDayId: number, exerciseName: string, reason: unknown): number {
  const clean = truncateAtSentenceBoundary(
    String(reason ?? "")
      .trim()
      .replace(/\s+/g, " "),
    420
  );
  if (!clean) return 0;
  const row = db
    .prepare(
      `SELECT pi.id, pi.note FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? AND e.name = ?`
    )
    .get(planDayId, exerciseName) as any;
  if (!row) return 0;
  const adjustment = `${COACH_NOTE_PREFIX}${clean}`;
  const existing = String(row.note ?? "").trim();
  if (currentCoachNoteLayer(existing) === adjustment) return 0;
  const base = stripCoachNoteLayer(existing);
  const budget = PLAN_ITEM_NOTE_LIMIT - (base ? 1 : 0) - adjustment.length;
  const boundedBase = base && budget > 0 ? truncateAtSentenceBoundary(base, budget) : "";
  const note = [boundedBase, adjustment].filter(Boolean).join("\n");
  return Number(db.prepare(`UPDATE plan_items SET note = ? WHERE id = ?`).run(note || null, row.id).changes);
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
  // Remove one prescription from the template. Logged history is untouched.
  remove?: boolean;
  target_weight?: number | null;
  target_seconds?: number | null;
  sets?: number | null;
  rep_low?: number | null;
  rep_high?: number | null;
  reason?: string | null;
  reason_provenance?: ReasonProvenance | null;
  note?: string | null;
  mode?: string | null;
  // A first-class SWAP: rotate one exercise out for another IN PLACE on a day
  // (the vary/rotate intent) — replaces the matching plan item's exercise while
  // keeping its slot + rep scheme, starting the new movement light (log actual).
  swap?: { from?: string | null; to?: string | null } | null;
}

// Implement-agnostic slot for loaded horizontal chest presses. Deliberately excludes
// OHP, flyes, push-ups, close-grip variants, and ambiguous "DB Press" so the guard
// blocks accidental same-angle duplicates without flattening distinct movements.
export function validatePlanPressSlots(days: Array<{ day_number?: unknown; items?: unknown }>): {
  ok: boolean;
  collisions: Array<{ day_number: number; slot: string; exercises: string[] }>;
} {
  const collisions: Array<{ day_number: number; slot: string; exercises: string[] }> = [];
  for (const day of Array.isArray(days) ? days : []) {
    const bySlot = new Map<string, string[]>();
    for (const raw of Array.isArray(day?.items) ? day.items : []) {
      if (!raw || typeof raw !== "object" || String((raw as any).kind ?? "strength") === "cardio") continue;
      const exercise = String((raw as any).exercise ?? "").trim();
      const slot = pressSlotKey(exercise);
      if (!slot) continue;
      bySlot.set(slot, [...(bySlot.get(slot) ?? []), exercise]);
    }
    for (const [slot, exercises] of bySlot) {
      if (exercises.length > 1) collisions.push({ day_number: Number(day.day_number), slot, exercises });
    }
  }
  return { ok: collisions.length === 0, collisions };
}

export function getPlanQuality() {
  return validateTrainingPlan(getPlan());
}

function planModeQualityError(
  dayNumber: number,
  exercise: string,
  code: "timed_load_incoherence" | "reps_timed_incoherence",
  message: string
): PlanQualityError {
  return new PlanQualityError(
    {
      ok: false,
      errors: [{ severity: "error", code, message, day_number: dayNumber, exercises: [exercise] }],
      warnings: [],
    },
    message
  );
}

// Validation must use the same exercise identity/mode that persistence will use.
// findOrCreateExercise() reuses an existing canonical exercise even when an input
// omits `mode`; compiling the raw request first would therefore let a timed DB
// movement arrive with reps/load, pass as reps work, and then persist incoherently.
function withAuthoritativeExerciseModes(items: PlanItemInput[] = []): PlanItemInput[] {
  const existing = db.prepare(`SELECT name, mode FROM exercises`).all() as Array<{ name: string; mode: string | null }>;
  const byKey = new Map(existing.map((row) => [normalizedExerciseKey(row.name), row.mode]));
  return items.map((item) => {
    if (String(item?.kind ?? "strength").toLowerCase() === "cardio") return item;
    const exercise = String(item?.exercise ?? "").trim();
    const storedMode = exercise ? byKey.get(normalizedExerciseKey(exercise)) : null;
    const declaredMode = item.mode === "timed" || item.mode === "reps" ? item.mode : null;
    // Existing exercise identity is authoritative. A brand-new prescription with
    // target_seconds is the same timed inference validateTrainingPlan makes; make
    // it explicit here so findOrCreateExercise persists that exact conclusion.
    const mode =
      storedMode === "timed" || storedMode === "reps"
        ? storedMode
        : (declaredMode ?? (item.target_seconds != null ? "timed" : "reps"));
    return { ...item, mode };
  });
}

// Manual editor authority is explicit: invalid structure is reported before any
// write, but a deliberate editor/MCP caller may pass quality_override:true. Quality
// warnings are always returned so a human can distinguish "allowed" from "optimal".
export function savePlanDayChecked(
  day_number: number,
  name: string,
  focus: string | null,
  items: PlanItemInput[],
  opts: { quality_override?: boolean } = {}
) {
  const before = validateTrainingPlan(getPlan());
  const normalizedItems = withAuthoritativeExerciseModes(items);
  const candidate = getPlan().filter((day: any) => Number(day.day_number) !== Number(day_number));
  candidate.push({ day_number, name, focus, items: normalizedItems });
  candidate.sort((a: any, b: any) => Number(a.day_number) - Number(b.day_number));
  const quality = validateTrainingPlan(candidate);
  const beforeKeys = new Set(before.errors.map(qualityIssueKey));
  const blocking = quality.errors.filter(
    (entry) => Number(entry.day_number) === Number(day_number) || !beforeKeys.has(qualityIssueKey(entry))
  );
  if (blocking.length && !opts.quality_override) {
    throw new PlanQualityError({ ok: false, errors: blocking, warnings: quality.warnings });
  }
  const day = savePlanDay(day_number, name, focus, normalizedItems);
  return { ok: true, day, quality, quality_override: blocking.length > 0 };
}

export function replacePlanChecked(
  days: { day_number?: number; name?: string; focus?: string | null; items?: PlanItemInput[] }[],
  opts: { quality_override?: boolean } = {}
) {
  const normalized = days.map((day, index) => ({
    ...day,
    day_number: day.day_number ?? index + 1,
    items: withAuthoritativeExerciseModes(day.items ?? []),
  }));
  const quality = validateTrainingPlan(normalized);
  if (!quality.ok && !opts.quality_override) throw new PlanQualityError(quality);
  const plan = replacePlan(normalized);
  return { ok: true, plan, quality, quality_override: !quality.ok };
}

function assertNoRedundantPress(dayItems: Array<{ ex_name: string }>, incoming: string, except?: string): void {
  const pattern = pressSlotKey(incoming);
  if (!pattern) return;
  const duplicate = dayItems.find((row) => row.ex_name !== except && pressSlotKey(row.ex_name) === pattern);
  if (duplicate) {
    throw new Error(`Cannot add ${incoming}: day already has the same press angle (${duplicate.ex_name})`);
  }
}

export function applyPlanChange(
  c: PlanChange,
  opts: {
    clamp?: boolean;
    defer_cache_bump?: boolean;
    defer_day_read_invalidation?: boolean;
    // What the plan held before THIS revision started writing. Only the set-reduction
    // step reads it, so that N changes naming one item still move it a single step.
    revision_baseline?: Map<string, PlanPrescription>;
  } = {}
): {
  action: "updated" | "added" | "swapped" | "removed";
  day: number;
  exercise: string;
  from?: string;
  updated?: number;
  sets?: number | null;
  prior_sets?: number | null;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  target_seconds?: number | null;
  mode?: string | null;
  clamped?: ClampAdjustment[];
} {
  const dayNumber = Number(c.day_number);
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) throw new Error(`No plan day ${dayNumber}`);

  // SWAP: replace one movement in place (the rotate/vary intent). Handled before the
  // name-match path because a swap change carries {from,to}, not a single `exercise`.
  if (c.swap && (c.swap.from || c.swap.to)) {
    const result = applyPlanSwap(day.id, dayNumber, c, opts);
    if (result.updated && opts.defer_cache_bump !== true) afterSqliteCommit(bumpTrainingDataVersion);
    if (result.updated && opts.defer_day_read_invalidation !== true) invalidateDayRead();
    return result;
  }

  const name = String(c.exercise ?? "").trim();
  if (!name) throw new Error("exercise required");

  // Find the matching strength item already on this day — exact name first, then a
  // normalized-key drift match (so a tweak phrased "DB Row" updates an existing
  // "Single-Arm DB Row" instead of adding a near-duplicate). Only when NOTHING on
  // the day matches is this treated as an ADD.
  const dayItems = db
    .prepare(
      `SELECT e.name AS ex_name
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`
    )
    .all(day.id) as any[];
  const norm = normalizeExerciseName(name);
  const key = normalizedExerciseKey(name);
  const match =
    dayItems.find((r) => normalizeExerciseName(r.ex_name) === norm) ??
    dayItems.find((r) => normalizedExerciseKey(r.ex_name) === key);

  // REMOVE: exact/canonical matching keeps a model spelling drift from leaving the
  // duplicate behind. It deletes only the plan prescription; session history remains.
  if (c.remove === true || Number(c.sets) === 0) {
    if (!match) throw new Error(`"${name}" is not on day ${dayNumber} to remove`);
    const info = db
      .prepare(
        `DELETE FROM plan_items
        WHERE plan_day_id = ? AND exercise_id = (SELECT id FROM exercises WHERE name = ?)`
      )
      .run(day.id, match.ex_name);
    if (!info.changes) throw new Error(`"${match.ex_name}" could not be removed from day ${dayNumber}`);
    if (opts.defer_cache_bump !== true) afterSqliteCommit(bumpTrainingDataVersion);
    if (opts.defer_day_read_invalidation !== true) invalidateDayRead();
    return { action: "removed", day: dayNumber, exercise: match.ex_name, updated: Number(info.changes) };
  }

  const tw = c.target_weight !== undefined && c.target_weight !== null ? Number(c.target_weight) : undefined;
  const ts = c.target_seconds !== undefined && c.target_seconds !== null ? Number(c.target_seconds) : undefined;

  if (match) {
    const current = db
      .prepare(
        `SELECT pi.sets, pi.rep_low, pi.rep_high, e.mode
         FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
        WHERE pi.plan_day_id = ? AND e.name = ?`
      )
      .get(day.id, match.ex_name) as any;
    const requestedMode = c.mode === "timed" || c.mode === "reps" ? c.mode : null;
    if (requestedMode && requestedMode !== current?.mode) {
      throw new Error(`Cannot change mode for existing exercise "${match.ex_name}" through a plan update`);
    }
    const priorSets = Number.isFinite(Number(current?.sets)) ? Math.trunc(Number(current.sets)) : null;
    const boundedSets = boundPrescriptionInt("sets", match.ex_name, c.sets, 1, 20);
    // The absolute 1–20 bound above answers "is this a supported number"; the step
    // clamp answers "is this a supported MOVE from where the plan stood when this
    // revision began" — the baseline, when the caller supplied one, so repeated
    // changes on one item cannot each take their own step.
    const baselineKey = planPrescriptionKey(dayNumber, match.ex_name);
    const baselineSets = baselineKey ? opts.revision_baseline?.get(baselineKey)?.sets : undefined;
    const stepFrom = Number.isFinite(Number(baselineSets)) ? Math.trunc(Number(baselineSets)) : priorSets;
    const steppedSets = opts.clamp
      ? clampSetReductionStep(match.ex_name, stepFrom, boundedSets.value)
      : { value: boundedSets.value, adjustment: null as ClampAdjustment | null };
    const boundedRepLow = boundPrescriptionInt("rep_low", match.ex_name, c.rep_low, 1, 100);
    const boundedRepHigh = boundPrescriptionInt("rep_high", match.ex_name, c.rep_high, 1, 100);
    const volumeClamps = [
      boundedSets.adjustment,
      steppedSets.adjustment,
      boundedRepLow.adjustment,
      boundedRepHigh.adjustment,
    ].filter((entry): entry is ClampAdjustment => !!entry);
    const nextRepLow = boundedRepLow.value ?? current?.rep_low;
    const nextRepHigh = boundedRepHigh.value ?? current?.rep_high;
    if (nextRepLow != null && nextRepHigh != null && Number(nextRepLow) > Number(nextRepHigh)) {
      throw new Error(`rep_low cannot exceed rep_high for "${match.ex_name}"`);
    }
    let updated = 0;
    const clamped: ClampAdjustment[] = [...volumeClamps];
    if (tw !== undefined || ts !== undefined) {
      // Proposal application owns one savepoint for the full change set. Defer
      // the in-memory cache bump until that savepoint commits so a later failed
      // change cannot invalidate caches for SQL that was rolled back.
      const r = updateTarget(dayNumber, match.ex_name, tw, ts, {
        clamp: opts.clamp,
        bump_cache: opts.defer_cache_bump !== true,
        invalidate_day_read: false,
      }) as any;
      updated += Number(r.updated) || 0;
      if (Array.isArray(r.clamped)) clamped.push(...r.clamped);
    }
    // A bounded session edit commonly changes volume/reps without changing load
    // (e.g. make today's incline press one easy set). These fields used to be
    // silently ignored, leaving the old prescription while chat claimed success.
    const sets: string[] = [];
    const vals: any[] = [];
    const addInt = (column: "sets" | "rep_low" | "rep_high", value: number | null) => {
      if (value == null) return;
      sets.push(`${column} = ?`);
      vals.push(value);
    };
    addInt("sets", steppedSets.value);
    addInt("rep_low", boundedRepLow.value);
    addInt("rep_high", boundedRepHigh.value);
    if (sets.length) {
      vals.push(day.id, match.ex_name);
      updated += Number(
        db
          .prepare(
            `UPDATE plan_items SET ${sets.join(", ")}
          WHERE plan_day_id = ? AND exercise_id = (SELECT id FROM exercises WHERE name = ?)`
          )
          .run(...vals).changes
      );
    }
    // `note` is the stable prescription fact; `reason` is proposal narrative and
    // belongs in the decision ledger. Keeping them separate prevents a weekly
    // template (and any daily snapshot copied from it) from freezing an old story.
    const adjustmentReason = normalizeHistoricalReason(
      c.note,
      validReasonProvenance(c.reason_provenance) ? c.reason_provenance : null
    );
    updated += addCoachAdjustmentNote(day.id, match.ex_name, adjustmentReason);
    if (!updated) throw new Error(`No supported prescription fields supplied for "${match.ex_name}"`);
    const stored = db
      .prepare(
        `SELECT pi.sets, pi.rep_low, pi.rep_high, pi.target_weight, pi.target_seconds, e.mode
         FROM plan_items pi JOIN exercises e ON e.id=pi.exercise_id
        WHERE pi.plan_day_id=? AND e.name=?`
      )
      .get(day.id, match.ex_name) as any;
    // updateTarget owns the cache bump for load edits; a volume/note-only update
    // must do the same here. Proposal savepoints defer both signals until commit.
    if (tw === undefined && ts === undefined && opts.defer_cache_bump !== true)
      afterSqliteCommit(bumpTrainingDataVersion);
    if (opts.defer_day_read_invalidation !== true) invalidateDayRead();
    return {
      action: "updated",
      day: dayNumber,
      exercise: match.ex_name,
      updated,
      sets: stored?.sets ?? null,
      // What this item's volume WAS before the change — the only record of where a
      // reduction has to climb back to, since nothing downstream can re-derive it.
      prior_sets: priorSets,
      rep_low: stored?.rep_low ?? null,
      rep_high: stored?.rep_high ?? null,
      target_weight: stored?.target_weight ?? null,
      target_seconds: stored?.target_seconds ?? null,
      mode: stored?.mode ?? null,
      ...(clamped.length ? { clamped } : {}),
    };
  }

  // ADD: the movement isn't on this day yet. Create the exercise if needed (its
  // group auto-classifies), then append it with the change's prescription + sensible
  // defaults, carrying the coach's reason as the note so the "why" survives.
  assertNoRedundantPress(dayItems, name);
  const timed = ts !== undefined && tw === undefined;
  const boundedSets = boundPrescriptionInt("sets", name, c.sets, 1, 20);
  const boundedRepLow = boundPrescriptionInt("rep_low", name, c.rep_low, 1, 100);
  const boundedRepHigh = boundPrescriptionInt("rep_high", name, c.rep_high, 1, 100);
  const volumeClamps = [boundedSets.adjustment, boundedRepLow.adjustment, boundedRepHigh.adjustment].filter(
    (entry): entry is ClampAdjustment => !!entry
  );
  const sets = boundedSets.value ?? 3;
  const repLow = boundedRepLow.value ?? (timed ? null : 8);
  const repHigh = boundedRepHigh.value ?? (timed ? null : 12);
  if (repLow != null && repHigh != null && repLow > repHigh) {
    throw new Error(`rep_low cannot exceed rep_high for "${name}"`);
  }
  const ex = findOrCreateExercise(name, undefined, undefined, c.mode ?? (timed ? "timed" : "reps"));
  const requestedMode = c.mode === "timed" || c.mode === "reps" ? c.mode : null;
  if (requestedMode && ex.mode !== requestedMode) {
    throw new Error(`Exercise "${ex.name}" already uses ${ex.mode ?? "an unknown"} mode, not ${requestedMode}`);
  }
  if (ex.mode === "reps" && ts !== undefined) {
    const message = `Cannot set target_seconds on reps-based exercise "${ex.name}"`;
    throw planModeQualityError(dayNumber, ex.name, "reps_timed_incoherence", message);
  }
  if (ex.mode === "timed" && tw !== undefined) {
    const message = `Cannot set target_weight on timed exercise "${ex.name}"`;
    throw planModeQualityError(dayNumber, ex.name, "timed_load_incoherence", message);
  }
  const pos = (
    db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM plan_items WHERE plan_day_id = ?`).get(day.id) as any
  ).p;
  const stableNote = normalizeHistoricalReason(
    c.note,
    validReasonProvenance(c.reason_provenance) ? c.reason_provenance : null
  );
  const safeLoad = opts.clamp
    ? canonicalizeAgentPrescriptionLoad(ex, "add", {
        ...(tw !== undefined ? { target_weight: tw } : {}),
        ...(ts !== undefined ? { target_seconds: ts } : {}),
      })
    : { target_weight: tw, target_seconds: ts, adjustments: [] as ClampAdjustment[] };
  const targetWeight = Object.hasOwn(safeLoad, "target_weight") ? safeLoad.target_weight : null;
  const targetSeconds = Object.hasOwn(safeLoad, "target_seconds") ? safeLoad.target_seconds : null;
  const hasStoredPrescription = targetWeight != null || targetSeconds != null;
  const reasonCarriesBaseline =
    /(?:start|begin)\s+(?:very\s+)?light/i.test(String(c.reason ?? "")) &&
    /log\b[^.]{0,60}\b(?:actual|working)/i.test(String(c.reason ?? ""));
  const note = (
    stableNote ||
    (!hasStoredPrescription || reasonCarriesBaseline ? "NEW — start light, log your actual working value." : "")
  ).slice(0, 500) || null;
  const addClamps = [...volumeClamps, ...safeLoad.adjustments];
  insertPlanItem({
    plan_day_id: day.id,
    position: pos,
    exercise_id: ex.id,
    sets,
    rep_low: repLow,
    rep_high: repHigh,
    target_weight: targetWeight ?? null,
    note,
    target_seconds: targetSeconds ?? null,
    kind: "strength",
  });
  if (opts.defer_cache_bump !== true) afterSqliteCommit(bumpTrainingDataVersion);
  if (opts.defer_day_read_invalidation !== true) invalidateDayRead();
  return {
    action: "added",
    day: dayNumber,
    exercise: ex.name,
    updated: 1,
    sets,
    rep_low: repLow,
    rep_high: repHigh,
    target_weight: targetWeight ?? null,
    target_seconds: targetSeconds ?? null,
    mode: ex.mode ?? null,
    ...(addClamps.length ? { clamped: addClamps } : {}),
  };
}

// ---- what a movement ENTERING the plan starts at, and how that is said -------
// GROUNDING IS SERVER CODE, NOT MODEL JUDGEMENT. Every way a movement enters the
// plan — the agent's swap proposal, the deterministic vary/introduce swap built in
// progression.ts, and the append-instead-of-dead-end path when nothing on the plan
// trains it — lands on one of the two writers below, and only the agent path ever
// carried a target. So a lift with 95 lb × 10 × 3 in its logs one day earlier
// arrived with a NULL target and "start light" under it. The tiers run for all of
// them:
//   1. an incoming target that was supplied and survived the clamp,
//   2. the incoming movement's OWN recent working history (never the outgoing
//      lift's load — that never transfers),
//   3. a conservative starting idea from a RELATED lift the athlete does train
//      (see related-lift.ts), phrased as an idea rather than a settled number,
//   4. the baseline-establishing "start light, log your actual working value."
// A load-limiting constraint note stops at tier 4 by design: the note is the
// authority and the athlete logs a tolerated value first.
type SwapGrounding =
  | { kind: "direct"; label: string }
  | { kind: "related"; label: string; source: string }
  | null;

const GROUNDED_START_NOTES: readonly [(lead: string, load: string) => string, ...((lead: string, load: string) => string)[]] = [
  (lead, load) => `${lead} — picking up from your last working ${load}.`,
  (lead, load) => `${lead} — starting at ${load}, where you left this one.`,
  (lead, load) => `${lead} — your own logs put this at ${load}, so that's the start.`,
];

const RELATED_START_NOTES: readonly [
  (lead: string, source: string, load: string) => string,
  ...((lead: string, source: string, load: string) => string)[],
] = [
  (lead, source, load) =>
    `${lead} — nothing logged on this one yet; your ${source} suggests starting around ${load}. Log what you actually lift.`,
  (lead, source, load) =>
    `${lead} — no history here yet, but ${source} puts a sensible start near ${load}. Log the real number.`,
  (lead, source, load) =>
    `${lead} — untested so far; going off your ${source}, somewhere around ${load} is a fair start. Log what it really is.`,
];

function swapLoadLabel(weight: number): string {
  return weight < 0 ? `${Math.abs(weight)} lb assist` : `${weight} lb`;
}

// Tiers 2 and 3 for ANY movement entering the plan. Its own logged reality first,
// then a conservative idea off a related lift; a load-limiting note skips both.
// Timed work reads seconds and is never anchored to a sibling movement (a hold
// belongs to its exact grip — see recentWorkingSeconds).
function groundIncomingMovement(ex: {
  name: string;
  mode?: string | null;
  constraint_note?: string | null;
}): { target_weight: number | null; target_seconds: number | null; grounding: SwapGrounding } {
  const none = { target_weight: null, target_seconds: null, grounding: null };
  if (constraintLimitsLoad(ex.constraint_note)) return none;
  if (ex.mode === "timed") {
    const ownSeconds = recentWorkingSeconds(ex.name);
    if (ownSeconds == null) return none;
    const seconds = Math.round(ownSeconds);
    return { target_weight: null, target_seconds: seconds, grounding: { kind: "direct", label: `${seconds}s` } };
  }
  const ownWeight = recentWorkingWeight(ex.name);
  if (ownWeight != null)
    return {
      target_weight: ownWeight,
      target_seconds: null,
      grounding: { kind: "direct", label: swapLoadLabel(ownWeight) },
    };
  // TIER 3 IS ADVISORY AND IS NEVER STORED. The related-lift number is a starting
  // idea, and a stored idea stops being one: progression grounds every future step
  // at `Math.max(planWeight, recentWorkingWeight)`, so an estimate written into
  // plan_items.target_weight becomes a floor the athlete cannot log their way below
  // — 185 × 0.80 = 145 on someone who really inclines 135 would survive every
  // subsequent session, keep planBehind false, and even deload off the guess. So the
  // target stays NULL (exactly the pre-grounding behavior, which fell through to
  // real logged weight) and only the GROUNDING travels, to carry the idea in the
  // note. The number itself reaches the athlete through the live prescription
  // instead — see the no-history branch of repsPrescription — where the first
  // logged set replaces it outright.
  const related = relatedLiftStart(ex.name);
  if (related)
    return {
      target_weight: null,
      target_seconds: null,
      grounding: { kind: "related", label: swapLoadLabel(related.weight), source: related.source_exercise },
    };
  return none;
}

// `lead` is the stable fact about HOW the movement got here ("Rotated in for Bench
// Press", "Added as a fresh variation for Hack Squat"); this adds exactly one
// starting cue in the register the grounding earned. The rationale for the change
// itself stays in the proposal and decision ledger — the reusable plan note never
// repeats it.
function movementStartNote(
  lead: string,
  exercise: string,
  grounding: SwapGrounding,
  hasStoredPrescription: boolean
): string {
  const date = localDateISO();
  const key = (code: string) => `${code}:${normalizedExerciseKey(exercise)}`;
  if (grounding?.kind === "direct")
    return pickDayVariant(GROUNDED_START_NOTES, date, key("movement_grounded"))(lead, grounding.label);
  if (grounding?.kind === "related")
    return pickDayVariant(RELATED_START_NOTES, date, key("movement_related"))(lead, grounding.source, grounding.label);
  return `${lead}${hasStoredPrescription ? "." : " — start light, log your actual working value."}`;
}

// Replace one exercise IN PLACE on a day (the swap/rotate intent). Finds the plan
// item for `from` (exact name, then a normalized-key drift match), points it at the
// resolved `to` exercise, keeps the slot (position/sets/reps/superset), and grounds
// the new movement through the tiers above; load never transfers from the outgoing
// variation. Throws when `from` isn't on the day (so applyProposal reports it
// honestly) or `to` is missing.
function applyPlanSwap(
  dayId: number,
  dayNumber: number,
  change: PlanChange,
  opts: { clamp?: boolean } = {}
): {
  action: "swapped";
  day: number;
  exercise: string;
  from: string;
  updated: number;
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  target_seconds: number | null;
  mode: string | null;
  clamped?: ClampAdjustment[];
} {
  const swap = change.swap ?? {};
  const fromName = String(swap.from ?? "").trim();
  const toName = String(swap.to ?? "").trim();
  if (!fromName) throw new Error("swap.from required");
  if (!toName) throw new Error("swap.to required");

  const dayItems = db
    .prepare(
      `SELECT pi.id AS id, pi.target_weight AS target_weight, pi.target_seconds AS target_seconds,
            pi.sets AS sets, pi.rep_low AS rep_low, pi.rep_high AS rep_high,
            e.name AS ex_name, e.mode AS mode
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`
    )
    .all(dayId) as any[];
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
  assertNoRedundantPress(dayItems, toName, match.ex_name);
  const requestedMode = change.mode === "timed" || change.mode === "reps" ? change.mode : undefined;
  const toEx = findOrCreateExercise(toName, undefined, undefined, requestedMode);
  if (requestedMode && toEx.mode !== requestedMode) {
    throw new Error(`Exercise "${toEx.name}" already uses ${toEx.mode ?? "an unknown"} mode, not ${requestedMode}`);
  }
  if (toEx.mode === "reps" && change.target_seconds != null) {
    const message = `Cannot set target_seconds on reps-based exercise "${toEx.name}"`;
    throw planModeQualityError(dayNumber, toEx.name, "reps_timed_incoherence", message);
  }
  if (toEx.mode === "timed" && change.target_weight != null) {
    const message = `Cannot set target_weight on timed exercise "${toEx.name}"`;
    throw planModeQualityError(dayNumber, toEx.name, "timed_load_incoherence", message);
  }
  const timed = toEx.mode === "timed";
  let targetWeight =
    change.target_weight != null && Number.isFinite(Number(change.target_weight)) ? Number(change.target_weight) : null;
  let targetSeconds =
    change.target_seconds != null && Number.isFinite(Number(change.target_seconds))
      ? Number(change.target_seconds)
      : null;
  // The slot's existing duration is the LAST resort for a timed rotation — the
  // incoming hold's own logged times (below) describe it better than the outgoing
  // movement's prescription does.
  const inheritedSeconds = timed && !opts.clamp ? (match.target_seconds ?? null) : null;
  const boundedSets = boundPrescriptionInt("sets", toEx.name, change.sets, 1, 20);
  const boundedRepLow = boundPrescriptionInt("rep_low", toEx.name, change.rep_low, 1, 100);
  const boundedRepHigh = boundPrescriptionInt("rep_high", toEx.name, change.rep_high, 1, 100);
  const clamps = [boundedSets.adjustment, boundedRepLow.adjustment, boundedRepHigh.adjustment].filter(
    (entry): entry is ClampAdjustment => !!entry
  );
  if (opts.clamp) {
    const safeLoad = canonicalizeAgentPrescriptionLoad(toEx, "swap", {
      ...(targetWeight != null ? { target_weight: targetWeight } : {}),
      ...(targetSeconds != null ? { target_seconds: targetSeconds } : {}),
    });
    if (targetWeight != null) targetWeight = safeLoad.target_weight ?? null;
    if (targetSeconds != null) targetSeconds = safeLoad.target_seconds ?? null;
    clamps.push(...safeLoad.adjustments);
  }
  const suppliedPrescription = targetWeight != null || targetSeconds != null;
  // Tiers 2 and 3, and they run on EVERY swap — a proposal that happened to carry
  // no number is not evidence the athlete has never done this movement.
  let grounding: SwapGrounding = null;
  if (!suppliedPrescription) {
    const grounded = groundIncomingMovement(toEx);
    grounding = grounded.grounding;
    if (grounded.target_weight != null) targetWeight = grounded.target_weight;
    if (grounded.target_seconds != null) targetSeconds = grounded.target_seconds;
  }
  if (timed && targetSeconds == null) targetSeconds = inheritedSeconds;
  const hasStoredPrescription = targetWeight != null || targetSeconds != null;
  const note = movementStartNote(
    `Rotated in for ${match.ex_name}`,
    toEx.name,
    grounding,
    hasStoredPrescription
  ).slice(0, 500);
  const sets = boundedSets.value;
  const repLow = boundedRepLow.value;
  const repHigh = boundedRepHigh.value;
  const finalRepLow = repLow ?? match.rep_low ?? null;
  const finalRepHigh = repHigh ?? match.rep_high ?? null;
  if (finalRepLow != null && finalRepHigh != null && Number(finalRepLow) > Number(finalRepHigh)) {
    throw new Error(`rep_low cannot exceed rep_high for "${toEx.name}"`);
  }
  const info = db
    .prepare(
      `UPDATE plan_items SET exercise_id = ?, target_weight = ?, target_seconds = ?, note = ?,
       sets = COALESCE(?, sets), rep_low = COALESCE(?, rep_low), rep_high = COALESCE(?, rep_high)
     WHERE id = ?`
    )
    .run(toEx.id, targetWeight, targetSeconds, note, sets, repLow, repHigh, match.id);
  return {
    action: "swapped",
    day: dayNumber,
    exercise: toEx.name,
    from: match.ex_name,
    updated: Number(info.changes),
    sets: sets ?? match.sets ?? null,
    rep_low: finalRepLow,
    rep_high: finalRepHigh,
    target_weight: targetWeight,
    target_seconds: targetSeconds,
    mode: toEx.mode ?? null,
    ...(clamps.length ? { clamped: clamps } : {}),
  };
}

// Append one exercise to an existing plan day — the graceful landing for a rotate-in
// whose `from` isn't represented anywhere on the plan (nothing to swap out, but the
// athlete asked for the movement, so it lands on the day that already trains that
// area instead of dead-ending). Conservative slot defaults (3×8-12 / 30s hold), and
// the SAME grounding tiers a swap gets: arriving by the append path rather than the
// swap path is not evidence the athlete has never done this movement. `lead` is the
// stable fact about how it got here; movementStartNote adds the starting cue the
// grounding earned. Null when the day doesn't exist.
export function addExerciseToPlanDay(
  dayNumber: number,
  name: string,
  lead?: string | null
): { day: number; exercise: string } | null {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(Number(dayNumber)) as any;
  if (!day) return null;
  const dayItems = db
    .prepare(
      `SELECT e.name AS ex_name
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`
    )
    .all(day.id) as Array<{ ex_name: string }>;
  assertNoRedundantPress(dayItems, String(name ?? "").trim());
  const ex = findOrCreateExercise(String(name ?? "").trim());
  const pos = (
    db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM plan_items WHERE plan_day_id = ?`).get(day.id) as any
  ).p;
  const timed = ex.mode === "timed";
  const grounded = groundIncomingMovement(ex);
  const targetWeight = timed ? null : grounded.target_weight;
  // A timed slot always lands with a duration — its own logged hold when there is
  // one, otherwise the conservative default. Either way something IS prescribed, so
  // the note must not tell the athlete to start light and log their own value while
  // a 30s hold sits right beside it.
  const targetSeconds = timed ? (grounded.target_seconds ?? 30) : null;
  const note = lead
    ? movementStartNote(
        String(lead),
        ex.name,
        grounded.grounding,
        targetWeight != null || targetSeconds != null
      ).slice(0, 500)
    : null;
  insertPlanItem({
    plan_day_id: day.id,
    position: pos,
    exercise_id: ex.id,
    sets: 3,
    rep_low: timed ? null : 8,
    rep_high: timed ? null : 12,
    target_weight: targetWeight,
    note,
    target_seconds: targetSeconds,
  });
  afterSqliteCommit(bumpTrainingDataVersion);
  invalidateDayRead();
  return { day: Number(dayNumber), exercise: ex.name };
}

// ---------- plan editing (manual + restructure) ----------
export interface PlanItemInput {
  exercise?: string; // optional for a cardio item (its label can live in `note`)
  sets?: number;
  rep_low?: number | null;
  rep_high?: number | null;
  target_weight?: number | null;
  note?: string | null;
  warmup_sets?: number | null;
  target_seconds?: number | null;
  superset_group?: number | null; // pair items on a day into a superset (v56); NULL = standalone
  mode?: string | null; // applied when the exercise is created (reps | timed)
  // First-class planned cardio (v35). kind:'cardio' carries an endurance
  // prescription with NO loaded exercise; kind:'strength' (default) is unchanged.
  kind?: string | null; // strength | cardio
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
  interval?: any; // structured interval JSON (any shape)
  interval_json?: string | null; // raw JSON string accepted too
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
    try {
      JSON.parse(s);
      return s.slice(0, 4000);
    } catch {
      return null;
    }
  }
  if (it.interval != null) {
    try {
      return JSON.stringify(it.interval).slice(0, 4000);
    } catch {
      return null;
    }
  }
  return null;
}

// Upsert one day and replace its full exercise list. Unknown exercises are created.
// A cardio item (kind:'cardio') is written with a NULL exercise_id and its endurance
// prescription columns — strength items keep their exercise-id behavior unchanged.
export function savePlanDay(
  day_number: number,
  name: string,
  focus: string | null,
  items: PlanItemInput[],
  opts: { deferTrainingVersionBump?: boolean; deferDayReadInvalidation?: boolean } = {}
) {
  const existing = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(day_number) as any;
  let dayId: number;
  if (existing) {
    db.prepare(`UPDATE plan_days SET name = ?, focus = ? WHERE id = ?`).run(name, focus ?? null, existing.id);
    dayId = existing.id;
    db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(dayId);
  } else {
    dayId = Number(
      db
        .prepare(`INSERT INTO plan_days (day_number, name, focus) VALUES (?, ?, ?)`)
        .run(day_number, name, focus ?? null).lastInsertRowid
    );
  }
  (items || []).forEach((it, i) => {
    const isCardio = String(it.kind ?? "").toLowerCase() === "cardio";
    if (isCardio) {
      // A cardio item needs no exercise; its label rides in `note` (or `exercise`,
      // folded into the note so the column stays NULL). Endurance prescription only.
      const label = String(it.exercise ?? "").trim();
      const note = it.note != null && String(it.note).trim() ? String(it.note).trim() : label || null;
      insertPlanItem({
        plan_day_id: dayId,
        position: i,
        exercise_id: null,
        sets: it.sets ?? 1,
        note: note ? note.slice(0, 500) : null,
        kind: "cardio",
        target_distance_km: numOrNull(it.target_distance_km),
        target_duration_min: numOrNull(it.target_duration_min),
        target_zone:
          it.target_zone != null && String(it.target_zone).trim() ? String(it.target_zone).trim().slice(0, 40) : null,
        interval_json: intervalJson(it),
      });
      return;
    }
    if (!it.exercise || !String(it.exercise).trim()) return;
    const ex = findOrCreateExercise(String(it.exercise), undefined, undefined, it.mode ?? undefined);
    insertPlanItem({
      plan_day_id: dayId,
      position: i,
      exercise_id: ex.id,
      sets: it.sets ?? 3,
      rep_low: it.rep_low ?? null,
      rep_high: it.rep_high ?? null,
      target_weight: it.target_weight ?? null,
      note: it.note ?? null,
      warmup_sets: it.warmup_sets ?? null,
      target_seconds: it.target_seconds ?? null,
      kind: "strength",
      superset_group: numOrNull(it.superset_group),
    });
  });
  // A changed plan day can change what "today" points at (focus/frequency) — refresh
  // the cached Brief so an applied edit isn't read against the old day from any surface.
  if (!opts.deferDayReadInvalidation) invalidateDayRead();
  // plan_days count feeds getWeeklyStats.week_planned; bump covers a same-count in-place
  // day rewrite too (setWeeklyRuns + replacePlan reach here, so they're covered as well).
  if (!opts.deferTrainingVersionBump) afterSqliteCommit(bumpTrainingDataVersion);
  afterSqliteCommit(() =>
    emitBrainEvent({
      kind: "plan_changed",
      domain: "training",
      date: localDateISO(),
      entity_id: dayId,
      subject_key: `day:${day_number}`,
    })
  );
  return getPlanDay(day_number);
}

// A single run prescription the coach can hand back for THIS week, applyable without
// a full plan restructure (the heavy `days` path). Each maps onto a plan day.
export interface RunPrescription {
  day_number: number;
  label?: string | null; // e.g. "Easy run", "Long run", "Tempo"
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null; // Z2 | easy | tempo | threshold | intervals | long
  note?: string | null;
  day_name?: string | null; // used only when CREATING a new day for this run
  focus?: string | null;
  interval?: any; // structured interval reps (e.g. [{reps,on,off,zone}]) — persisted as interval_json
}

// Apply a week of run prescriptions onto the plan WITHOUT touching strength work: for
// each day, keep its strength items and replace its cardio items with the given runs.
// A day_number with no plan day yet is created as a dedicated run day. This is the
// surgical counterpart to a full `replacePlan` restructure — used by the apply path so
// a runner/hybrid athlete can accept "this week's runs" while lifting stays intact.
export function setWeeklyRuns(
  runs: RunPrescription[],
  opts: { deferTrainingVersionBump?: boolean; deferDayReadInvalidation?: boolean } = {}
) {
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
            exercise: it.exercise,
            sets: it.sets,
            rep_low: it.rep_low,
            rep_high: it.rep_high,
            target_weight: it.target_weight,
            note: it.note,
            warmup_sets: it.warmup_sets,
            target_seconds: it.target_seconds,
            mode: it.mode,
            superset_group: it.superset_group,
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
    savePlanDay(dn, name, focus, [...strength, ...cardio], opts);
    applied.push({ day_number: dn, runs: cardio.length, created: !existing });
  }
  return { applied };
}

export function deletePlanDay(
  day_number: number,
  opts: { deferTrainingVersionBump?: boolean; deferDayReadInvalidation?: boolean } = {}
) {
  const d = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(day_number) as any;
  if (!d) return { deleted: 0, day_number };
  db.prepare(`UPDATE sessions SET plan_day_id = NULL WHERE plan_day_id = ?`).run(d.id); // keep history, drop the link
  const r = db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(d.id); // plan_items cascade
  if (r.changes && !opts.deferTrainingVersionBump) afterSqliteCommit(bumpTrainingDataVersion); // removing a day changes week_planned
  if (r.changes && !opts.deferDayReadInvalidation) invalidateDayRead();
  if (r.changes)
    afterSqliteCommit(() =>
      emitBrainEvent({
        kind: "plan_changed",
        domain: "training",
        date: localDateISO(),
        entity_id: d.id,
        subject_key: `day:${day_number}`,
      })
    );
  return { deleted: r.changes, day_number };
}

// Full restructure: make the plan exactly the given days (add/remove/rewrite).
export function replacePlan(
  days: { day_number?: number; name?: string; focus?: string | null; items?: PlanItemInput[] }[]
) {
  if (!Array.isArray(days) || !days.length) throw new Error("replacePlan needs a non-empty days array");
  const result = withSqliteSavepoint("replace_plan", () => {
    const normalized = days.map((d, i) => ({ ...d, day_number: Number(d.day_number ?? i + 1) }));
    const keep = new Set(normalized.map((d) => d.day_number));
    const existing = db.prepare(`SELECT day_number FROM plan_days`).all() as any[];
    for (const e of existing) {
      if (!keep.has(e.day_number)) {
        deletePlanDay(e.day_number, { deferTrainingVersionBump: true, deferDayReadInvalidation: true });
      }
    }
    normalized.forEach((d, i) =>
      savePlanDay(d.day_number, d.name || `Day ${i + 1}`, d.focus ?? null, d.items || [], {
        deferTrainingVersionBump: true,
        deferDayReadInvalidation: true,
      })
    );
    return getPlan();
  });
  // A restructure (new split/frequency) can move what today should be — bust the
  // cached Brief so a stale "train your old focus" read never survives an apply.
  invalidateDayRead();
  afterSqliteCommit(bumpTrainingDataVersion);
  afterSqliteCommit(() =>
    emitBrainEvent({
      kind: "plan_changed",
      domain: "training",
      date: localDateISO(),
      subject_key: "full-plan",
      material: true,
    })
  );
  return result;
}

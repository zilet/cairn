// ============================================================================
// session-primer.ts — the pre-session "a coach was already here" read.
//
// When the athlete opens a session, this composes a calm, deterministic primer:
//   - why_today  : why today's session is what it is (REUSED from the stored day
//                  read — never recomputed here);
//   - changed[]  : per-movement deltas since last time — earned targets (the rx
//                  path) and recovery-driven caps (deloads / autoregulated holds);
//   - watch[]    : active training/watch directives, recent joint/soreness echoes,
//                  and a recovery note when the unified read is clearly low;
//   - fresh[]    : movements new this week / recently rotated in, each with its
//                  one-line rationale — what's deliberately fresh today;
//   - approach   : ONE calm line for how to attack the session.
//
// Constitution (binding): calm, suggestion-never-a-gate, plain words only — NO
// scores/grades anywhere. Pull, never push. Everything is additive + null-safe:
// empty inputs → empty arrays, and the primer is NULL when there's genuinely
// nothing to say (a bare plan day with no signals) — silence beats filler.
//
// Pure composition over existing deterministic reads; never runs an agent, never
// writes. Sibling imports (not the ../repo.js barrel) to avoid the cycle, exactly
// like today-agenda.ts.
// ============================================================================
import { db } from "../db.js";
import { getCachedDayRead } from "./day-read.js";
import { dayRead } from "./day-read.js";
import { listBrainDecisions } from "./brain-decisions.js";
import { planDayFocus, planDayCandidates, selectAdaptivePlanDay } from "./plan-selection.js";
import { getProposal } from "./profile.js";
import {
  movementTenureWeeks,
  painAreaLoadsExercise,
  planDayProgression,
  recentAutoregulation,
  type Prescription,
} from "./progression.js";
import { directivesForCoach } from "./propagation.js";
import { localDateISO } from "./shared.js";

// ---- the public contract (mirrored in src/contracts/client-api.ts) ----------
export type SessionPrimerChangeKind = "target" | "recovery_cap" | "rotation";

export interface SessionPrimerChange {
  exercise: string;
  kind: SessionPrimerChangeKind;
  text: string; // plain words, e.g. "Back Squat — +5 lb" / "Bench Press — easing the load"
}

export interface SessionPrimerWatch {
  text: string;
  soft?: boolean; // an uncertain / uncited directive or a low-recovery nudge — a softer heads-up
}

export interface SessionPrimerFresh {
  exercise: string;
  why: string; // one-line rationale ("new this week — log your real working weight")
}

export interface SessionPrimer {
  date: string;
  day_number: number | null;
  focus: string | null;
  why_today: string;
  changed: SessionPrimerChange[];
  watch: SessionPrimerWatch[];
  fresh: SessionPrimerFresh[];
  approach: string | null;
}

const MAX_CHANGED = 4;
const MAX_WATCH = 3;
const MAX_FRESH = 3;
// Base gate for "fresh": a movement only stands out as DELIBERATELY fresh against
// an established routine. On a brand-new athlete every movement is new, which is
// noise, not novelty — so fresh[] stays empty until there's a real training base.
const FRESH_BASE_SESSIONS = 6;

// The focus label for an explicit plan-day number (the client's manual day pick).
function focusForDay(dayNumber: number): string | null {
  const day = planDayCandidates().find((c) => c.day_number === dayNumber);
  return day ? planDayFocus(day) : null;
}

// Count of distinct logged session-days — the "does this athlete have a routine"
// base gate for the fresh signal. Null-safe.
function loggedSessionDays(): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT s.date) AS n FROM sessions s JOIN logged_sets l ON l.session_id = s.id`
      )
      .get() as any;
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

// The strength (non-cardio) movements programmed on a plan day, in plan order.
function strengthMovementsForDay(dayNumber: number): string[] {
  try {
    const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
    if (!day) return [];
    return (
      db
        .prepare(
          `SELECT e.name AS name FROM plan_items pi
             JOIN exercises e ON e.id = pi.exercise_id
            WHERE pi.plan_day_id = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')
            ORDER BY pi.position`
        )
        .all(day.id) as any[]
    )
      .map((r) => String(r.name || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// changed[] — the target deltas the coach made for this exposure. Earned overloads
// (the rx path) read as new targets; deloads and autoregulation-braked holds read
// as recovery caps. Plain holds / rep advances / rotations are NOT "changes" here
// (a rep advance is already inside the prescribed range; rotations live in fresh[]).
function changedFromPrescriptions(prescriptions: Prescription[]): SessionPrimerChange[] {
  const out: SessionPrimerChange[] = [];
  for (const p of prescriptions) {
    if (!p?.exercise) continue;
    if (p.action === "overload" && !p.rep_step) {
      const delta = String(p.delta_text || "").trim();
      out.push({
        exercise: p.exercise,
        kind: "target",
        text: delta ? `${p.exercise} — ${delta}${p.reground ? " (caught up to what you're lifting)" : ""}` : `${p.exercise} — new target`,
      });
    } else if (p.action === "deload") {
      const delta = String(p.delta_text || "").trim();
      out.push({
        exercise: p.exercise,
        kind: "recovery_cap",
        text: delta ? `${p.exercise} — easing the load (${delta})` : `${p.exercise} — easing the load to recover`,
      });
    } else if (p.autoregulated && p.action === "hold") {
      out.push({
        exercise: p.exercise,
        kind: "recovery_cap",
        text: `${p.exercise} — holding the load today (recovery)`,
      });
    }
    if (out.length >= MAX_CHANGED) break;
  }
  return out;
}

// The last logged session-day strictly before `before` — the "since you last trained"
// anchor for what counts as newly changed. Null when there's no prior session.
function lastComparableSessionDate(before: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT MAX(s.date) AS d FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date < ?`
      )
      .get(before) as any;
    const d = row?.d ? String(row.d).slice(0, 10) : null;
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  } catch {
    return null;
  }
}

// Applied exercise-rotation decisions (a swap the coach landed) that sit on today's
// plan day and landed since the athlete last trained — surfaced as "Swapped in X for Y"
// so a rotated-in movement reads as a deliberate coaching move, not a mystery. Reads the
// swap {from,to,reason} off the decision's source proposal; null-safe and bounded. An
// undated decision, one off today's day, or one whose incoming movement is no longer on
// the plan is skipped.
function appliedRotationsForDay(
  dayNumber: number,
  movements: string[],
  windowStart: string | null
): Array<{ to: string; change: SessionPrimerChange }> {
  const out: Array<{ to: string; change: SessionPrimerChange }> = [];
  const onDay = new Set(movements.map((m) => m.trim().toLowerCase()));
  const seen = new Set<string>();
  let decisions: any[] = [];
  try {
    decisions = listBrainDecisions({ status: "applied", kind: "exercise_rotation", limit: 100 }) as any[];
  } catch {
    return out;
  }
  for (const decision of decisions) {
    const when = String(decision?.applied_at ?? decision?.created_at ?? "").slice(0, 10);
    if (!when || (windowStart && when < windowStart)) continue;
    const action = (decision?.action ?? {}) as any;
    const proposalId = Number(
      action.proposal_id ??
        action.plan_proposal_id ??
        (String(decision?.source_ref_type) === "plan_proposal" ? decision?.source_ref_key : Number.NaN)
    );
    if (!(proposalId > 0)) continue;
    let proposal: any = null;
    try {
      proposal = getProposal(proposalId);
    } catch {
      proposal = null;
    }
    const changes = Array.isArray(proposal?.parsed?.changes) ? proposal.parsed.changes : [];
    for (const change of changes) {
      const from = String(change?.swap?.from ?? "").trim();
      const to = String(change?.swap?.to ?? "").trim();
      if (!from || !to) continue;
      // Touches today's plan day: the swap named this day AND the incoming movement is on it now.
      if (Number(change?.day_number) !== dayNumber) continue;
      const key = to.toLowerCase();
      if (!onDay.has(key) || seen.has(key)) continue;
      seen.add(key);
      const why = String(decision?.summary ?? change?.reason ?? "").replace(/\s+/g, " ").trim();
      const text = why ? `Swapped in ${to} for ${from} — ${why}` : `Swapped in ${to} for ${from}`;
      out.push({
        to,
        change: { exercise: to, kind: "rotation", text: text.length > 160 ? `${text.slice(0, 159).trimEnd()}...` : text },
      });
      if (out.length >= MAX_CHANGED) return out;
    }
  }
  return out;
}

// watch[] — the calm heads-ups: active training/watch directives (an uncertain one
// is a softer nudge), a recent joint/soreness echo tied to a movement on the day,
// and a low-recovery note. All bounded + deduped; empty when there's nothing.
function buildWatch(movements: string[], read: any): SessionPrimerWatch[] {
  const out: SessionPrimerWatch[] = [];
  const seen = new Set<string>();
  const push = (text: string, soft?: boolean) => {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(soft ? { text: t, soft: true } : { text: t });
  };

  // 1) Active training / watch directives (informational, not medical advice).
  try {
    const directives = directivesForCoach() as any[];
    for (const d of directives) {
      const domain = String(d?.domain || "").toLowerCase();
      if (domain !== "training" && domain !== "watch") continue;
      const text = String(d?.directive || "").trim();
      if (!text) continue;
      push(text, !!d?.uncertain || !d?.citation);
      if (out.length >= MAX_WATCH) break;
    }
  } catch {
    /* directives unavailable → skip */
  }

  // 2) A recent joint / soreness echo, tied to a movement this session actually
  //    loads (so "left knee grumbled" only shows on a day with knee-loading work).
  if (out.length < MAX_WATCH) {
    try {
      const autoreg = recentAutoregulation();
      const joint = autoreg.joint_pain ? String(autoreg.joint_pain).trim() : "";
      if (joint) {
        const hit = movements.find((m) => painAreaLoadsExercise(joint, { name: m }));
        if (hit) push(`${joint} was grumbling recently — keep ${hit} honest and stop if it barks.`, true);
      }
      if (out.length < MAX_WATCH && autoreg.soreness != null && Number(autoreg.soreness) >= 4) {
        push("You flagged real soreness recently — treat the first sets as a check-in and build from there.", true);
      }
    } catch {
      /* autoreg unavailable → skip */
    }
  }

  // 3) A low-recovery note when the unified read is clearly low (or a recovery week).
  if (out.length < MAX_WATCH) {
    const signals = read?.signals ?? {};
    const recoveryWeek = !!signals?.recovery_week;
    const lowSleep = !!signals?.low_sleep;
    const lowReadiness = !!signals?.fatigue?.low_readiness;
    const anticipate = !!signals?.fatigue?.anticipate_deload;
    const restOrEasy = read?.kind === "rest" || read?.kind === "easy";
    if (recoveryWeek) {
      push("This is the reduced recovery-week dose — keep every set crisp and well shy of failure.", true);
    } else if (lowSleep || lowReadiness || restOrEasy) {
      push("Recovery's running low today — keep the load conservative and leave a couple of reps in the tank.", true);
    } else if (anticipate) {
      push("Fatigue's quietly building — a couple more hard days and you'll likely want a reset.", true);
    }
  }

  return out.slice(0, MAX_WATCH);
}

// fresh[] — movements that are deliberately fresh on today's session: new this week
// or logged for the very first time (against an established base). Each carries a
// one-line rationale. Gated on a real training base so a brand-new plan — where
// EVERYTHING is new — stays quiet rather than flagging every row.
function buildFresh(movements: string[], date: string): SessionPrimerFresh[] {
  if (loggedSessionDays() < FRESH_BASE_SESSIONS) return [];
  const out: SessionPrimerFresh[] = [];
  for (const name of movements) {
    const tenure = movementTenureWeeks(name, date);
    if (tenure === 0) {
      out.push({
        exercise: name,
        why: `New this week — you've only just started logging ${name}; start conservative and let the target calibrate.`,
      });
    } else if (tenure == null) {
      out.push({
        exercise: name,
        why: `Fresh on your plan — no history for ${name} yet, so log your real working weight and the coach will build from there.`,
      });
    }
    if (out.length >= MAX_FRESH) break;
  }
  return out;
}

// approach — ONE calm line (deterministic; plain words, no scores). Reflects the
// dominant signal: recovery-first on a low day, chase-the-target when overloads are
// earned, ease-into-it when something's fresh, else a steady honest session.
function buildApproach(
  changed: SessionPrimerChange[],
  fresh: SessionPrimerFresh[],
  read: any
): string {
  const signals = read?.signals ?? {};
  const recoveryWeek = !!signals?.recovery_week;
  const lowRecovery =
    !!signals?.low_sleep || !!signals?.fatigue?.low_readiness || read?.kind === "rest" || read?.kind === "easy";
  if (recoveryWeek || lowRecovery) {
    return "Treat this as a quality day — smooth reps, plenty in reserve, and stop while it still feels good.";
  }
  if (changed.some((c) => c.kind === "target")) {
    return "You've earned a step up — warm up properly, then chase the new target with clean reps.";
  }
  if (fresh.length || changed.some((c) => c.kind === "rotation")) {
    return "There's something fresh in the mix — start light, find the groove, and only add load once it moves well.";
  }
  return "Solid session ahead — log honestly and the plan follows your lead.";
}

// The pre-session primer for `date` (defaults to today). `opts.dayNumber` pins an
// explicit plan day (the client's manual day pick); otherwise the adaptive pick is
// used, matching the Brief. Returns null when there's no plan day to prime, or when
// there's genuinely nothing to say beyond the Brief (no changes, watch, or fresh).
export function sessionPrimer(
  date?: string,
  opts: { dayNumber?: number | null } = {}
): SessionPrimer | null {
  const d = String(date || localDateISO()).slice(0, 10);

  // 1) Resolve the plan day being opened.
  let dayNumber: number | null = null;
  let focus: string | null = null;
  if (opts.dayNumber != null && Number.isFinite(Number(opts.dayNumber))) {
    dayNumber = Number(opts.dayNumber);
    focus = focusForDay(dayNumber);
    if (focus == null) return null; // an explicit day that isn't on the plan → nothing to prime
  } else {
    const sel = (() => {
      try {
        return selectAdaptivePlanDay(d);
      } catch {
        return null;
      }
    })();
    if (!sel) return null; // no plan day (bare / empty plan) → nothing to prime
    dayNumber = sel.day_number;
    focus = sel.focus ?? null;
  }

  // 2) why_today — REUSE the stored day read (never recompute the judgment here).
  const cached = (() => {
    try {
      return getCachedDayRead(d);
    } catch {
      return null;
    }
  })();
  const read =
    cached ??
    (() => {
      try {
        return dayRead(d);
      } catch {
        return null;
      }
    })();
  const why_today = String(read?.why || "").replace(/\s+/g, " ").trim();

  // 3) The three quiet sections + the approach line.
  const prescriptions = (() => {
    try {
      return planDayProgression(dayNumber);
    } catch {
      return [] as Prescription[];
    }
  })();
  const movements = strengthMovementsForDay(dayNumber);
  // Earned/recovery target deltas from the prescriptions, plus applied exercise
  // rotations the coach landed since the athlete last trained — both are "what changed".
  const rotations = appliedRotationsForDay(dayNumber, movements, lastComparableSessionDate(d));
  const changed = [...changedFromPrescriptions(prescriptions), ...rotations.map((r) => r.change)].slice(0, MAX_CHANGED);
  const watch = buildWatch(movements, read);
  // A movement the coach deliberately swapped in reads as a rotation in changed[], so it
  // must not ALSO surface as a mysteriously-"fresh" row (only suppress the ones actually
  // shown after the changed[] cap).
  const shownRotations = new Set(
    changed.filter((c) => c.kind === "rotation").map((c) => c.exercise.trim().toLowerCase())
  );
  const fresh = buildFresh(movements, d).filter((f) => !shownRotations.has(f.exercise.trim().toLowerCase()));

  // Silence beats filler: with no changes, no watch items and nothing fresh, the
  // primer would only echo the Brief — so there's genuinely nothing to say.
  if (!changed.length && !watch.length && !fresh.length) return null;

  const approach = buildApproach(changed, fresh, read);

  return { date: d, day_number: dayNumber, focus, why_today, changed, watch, fresh, approach };
}

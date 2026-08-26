import crypto from "node:crypto";
import { db } from "../db.js";
import { addDaysISO, localDateISO, localDayOfStamp } from "./shared.js";
import { type BrainDecision, type BrainDecisionStatus, normalizeBrainDecision } from "../brain/decision-contract.js";
import {
  type BrainExpectation,
  type ProposedExpectation,
  normalizeBrainExpectation,
  normalizeProposedExpectation,
} from "../brain/expectation-contract.js";
import { withSqliteSavepoint } from "./sqlite-savepoint.js";
import { retireSupersededExpectations } from "./brain/expectation-arbitration.js";

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parsedObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}

/**
 * The LOCAL calendar day a ledger stamp falls on.
 *
 * `created_at`/`applied_at` are INSTANTS — SQLite writes them with `datetime('now')`,
 * which is UTC — while every window below is a local calendar day. Slicing ten
 * characters off the instant answered the question in UTC, and west of Greenwich that
 * is tomorrow for the whole evening: a change applied at 8 PM in Boston was dated a
 * day into the future, so it sorted above changes that landed after it and fell out of
 * the window it belongs to the moment the window's far edge was today.
 *
 * `effective_date` is already a local date and is read as written; only the instants
 * come through here, which is the same rule `localDayOfStamp` documents.
 */
function stampDay(stamp: unknown): string {
  return localDayOfStamp(stamp) ?? "";
}

function hydrateDecision(row: any): BrainDecision | null {
  if (!row) return null;
  return normalizeBrainDecision({
    ...row,
    reversible: !!row.reversible,
    context: parsedObject(row.context_json),
    action: parsedObject(row.action_json),
    specialist: parsedObject(row.specialist_json),
    created_at: isoTimestamp(row.created_at),
    applied_at: isoTimestamp(row.applied_at) ?? null,
    reverted_at: isoTimestamp(row.reverted_at) ?? null,
  });
}

function hydrateExpectation(row: any): BrainExpectation | null {
  if (!row) return null;
  return normalizeBrainExpectation({
    ...row,
    baseline: parsedObject(row.baseline_json),
    target: parsedObject(row.target_json),
    minimum_data: parsedObject(row.minimum_data_json),
    created_at: isoTimestamp(row.created_at),
  });
}

export function getBrainDecision(id: number): BrainDecision | null {
  return hydrateDecision(db.prepare(`SELECT * FROM brain_decisions WHERE id = ?`).get(id));
}

// The receipt that RETIRED an older draft in favour of this one, when this draft was
// written by a regeneration rather than by an ordinary producer run. That receipt is
// the only durable record of the lineage — the replacement row itself is an ordinary
// draft — and reading it back is how the regeneration bound survives a restart: a
// replacement that goes stale in its turn is held the old way, never regenerated again.
export function regenerationReceiptForDraft(proposalId: number): BrainDecision | null {
  const id = Math.trunc(Number(proposalId));
  if (!(id > 0)) return null;
  return hydrateDecision(
    db
      .prepare(
        `SELECT * FROM brain_decisions
          WHERE json_extract(action_json, '$.regenerated_proposal_id') = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(id)
  );
}

export function findBrainDecisionByFingerprint(fingerprint: string): BrainDecision | null {
  const key = String(fingerprint || "")
    .trim()
    .slice(0, 160);
  if (!key) return null;
  return hydrateDecision(db.prepare(`SELECT * FROM brain_decisions WHERE input_fingerprint = ?`).get(key));
}

export function listBrainDecisions(
  opts: { status?: BrainDecisionStatus; domain?: string; kind?: string; limit?: number } = {}
): BrainDecision[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (opts.domain) {
    where.push("domain = ?");
    args.push(String(opts.domain));
  }
  if (opts.kind) {
    where.push("kind = ?");
    args.push(String(opts.kind));
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(opts.limit) || 50)));
  const rows = db
    .prepare(
      `SELECT * FROM brain_decisions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`
    )
    .all(...args, limit) as any[];
  return rows.map(hydrateDecision).filter((row): row is BrainDecision => row != null);
}

// The decision list as an athlete-visible surface reads it: every stored field, plus
// the one sentence written for a person lifted out of the action payload where no
// reader could find it. Additive — existing consumers of the raw rows are unaffected.
export type ReadableBrainDecision = BrainDecision & { user_explanation: string | null };

export function listReadableBrainDecisions(
  opts: { status?: BrainDecisionStatus; domain?: string; kind?: string; limit?: number } = {}
): ReadableBrainDecision[] {
  return listBrainDecisions(opts).map((decision) => ({
    ...decision,
    user_explanation: decisionExplanation(decision),
  }));
}

// ---- forward + rotation readers ---------------------------------------------
// Both feed calm surfaces, so they return small plain shapes, never raw rows.

// The sentence the conductor wrote FOR the athlete. The case conference emits it on
// every path it takes (applied, held, advisory) as `action.user_explanation`, capped
// at 700 chars by its own contract — it is agent-authored per decision, so it passes
// through verbatim rather than rotating through a variant set. Falls back to the
// decision's `rationale`, which is the same register, when no conference wrote one.
export function decisionExplanation(decision: BrainDecision | null | undefined): string | null {
  if (!decision) return null;
  const spoken = (decision.action as any)?.user_explanation;
  const text = typeof spoken === "string" && spoken.trim() ? spoken : decision.rationale;
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed.slice(0, 700) : null;
}

// A queued change the athlete will see land soon: an ANNOUNCED decision, or a
// quiet_apply-tier PENDING one, whose effective_date sits in (asOf, asOf+window].
// Mirrors applyDueAnnouncedDecisions' union with the inequality flipped forward.
export interface UpcomingBrainDecision {
  id: number;
  kind: string;
  domain: string;
  summary: string;
  effective_date: string;
  autonomy_tier: string;
  status: string;
  explanation: string | null;
}

export function upcomingBrainDecisions(windowDays = 10, asOf = localDateISO()): UpcomingBrainDecision[] {
  const horizon = addDaysISO(asOf, Math.max(1, Math.trunc(windowDays))) ?? asOf;
  const candidates = [
    ...listBrainDecisions({ status: "announced", limit: 100 }),
    ...listBrainDecisions({ status: "pending", limit: 100 }).filter((d) => d.autonomy_tier === "quiet_apply"),
  ];
  return candidates
    .filter((d) => !!d.effective_date && d.effective_date > asOf && d.effective_date <= horizon)
    .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)))
    .map((d) => ({
      id: Number(d.id),
      kind: String(d.kind),
      domain: String(d.domain),
      summary: String(d.summary ?? ""),
      effective_date: String(d.effective_date),
      autonomy_tier: String(d.autonomy_tier),
      status: String(d.status),
      explanation: decisionExplanation(d),
    }));
}

// The other half of the same question. upcomingBrainDecisions answers "what is
// COMING"; a change that has already landed dropped out of every surface the moment
// its effective date arrived, which is exactly when the athlete starts asking why
// their week looks different.
export interface LandedBrainDecision extends UpcomingBrainDecision {
  landed_date: string;
}

// A landed change speaks through the thing it changed, so this window is short on
// purpose: it exists to explain a week that just moved, not to build a feed. The
// bound is inclusive at both ends, so the default reads the last seven days plus
// today — "this week and the day it started from", not a rolling seven.
export function landedBrainDecisions(windowDays = 7, asOf = localDateISO()): LandedBrainDecision[] {
  const floor = addDaysISO(asOf, -Math.max(1, Math.trunc(windowDays))) ?? asOf;
  const out: LandedBrainDecision[] = [];
  for (const d of listBrainDecisions({ status: "applied", limit: 100 })) {
    const id = Number(d.id);
    if (!Number.isFinite(id)) continue;
    const landed = String(d.effective_date ?? "").slice(0, 10) || stampDay(d.applied_at) || stampDay(d.created_at);
    if (!landed || landed < floor || landed > asOf) continue;
    out.push({
      id,
      kind: String(d.kind),
      domain: String(d.domain),
      summary: String(d.summary ?? ""),
      effective_date: String(d.effective_date ?? landed),
      landed_date: landed,
      autonomy_tier: String(d.autonomy_tier),
      status: String(d.status),
      explanation: decisionExplanation(d),
    });
  }
  return out.sort((a, b) => b.landed_date.localeCompare(a.landed_date) || b.id - a.id);
}

// A decision that is WAITING — held for the athlete, or observed without acting.
// Deliberately NOT time-windowed, unlike the landed read above: a hold is not an
// event that recedes into history, it is an open question, and one that ages out
// unseen is the failure this exists to prevent. It stays until it transitions.
//
// Included ONLY when a conductor wrote it a sentence FOR the athlete —
// `action.user_explanation`, and nothing else. decisionExplanation's fallback to
// `rationale` is right for the landed list and the general decisions payload, where
// the reader has already asked to see a record; here it admitted almost every
// `review`/`observed` row, including two writers that are pure bookkeeping (the
// per-directive rows propagation re-derives daily, and the underfuelling
// coordination link, whose rationale is machine register about immutability and
// Undo history). Bookkeeping on a "waiting on you" surface is noise, not
// accountability — and machine register on an athlete surface breaks the
// spokenSignalVoice law outright.
//
// Two kinds are additionally never a waiting question, whatever they carry:
// `health_directive` is re-derived from the markers every day and has its own
// surface, and `day_read` is an observation the Brief already speaks. Tier is NOT
// the filter: both `observe` and `clinician` carry genuine conference output.
//
// `review`/`observed` rows carry no effective_date — nothing was scheduled — so they
// are dated by their creation.
export interface AwaitingBrainDecision extends UpcomingBrainDecision {
  decided_date: string;
}

const AWAITING_BOOKKEEPING_KINDS = new Set(["health_directive", "day_read"]);

function awaitingExplanation(decision: BrainDecision): string | null {
  const spoken = (decision.action as any)?.user_explanation;
  const trimmed = typeof spoken === "string" ? spoken.trim() : "";
  return trimmed ? trimmed.slice(0, 700) : null;
}

export function awaitingBrainDecisions(limit = 20): AwaitingBrainDecision[] {
  const out: AwaitingBrainDecision[] = [];
  for (const d of [
    ...listBrainDecisions({ status: "review", limit: 100 }),
    ...listBrainDecisions({ status: "observed", limit: 100 }),
  ]) {
    const id = Number(d.id);
    const explanation = awaitingExplanation(d);
    if (!Number.isFinite(id) || !explanation) continue;
    if (AWAITING_BOOKKEEPING_KINDS.has(String(d.kind))) continue;
    const decided = String(d.effective_date ?? "").slice(0, 10) || stampDay(d.created_at);
    if (!decided) continue;
    out.push({
      id,
      kind: String(d.kind),
      domain: String(d.domain),
      summary: String(d.summary ?? ""),
      effective_date: String(d.effective_date ?? decided),
      decided_date: decided,
      autonomy_tier: String(d.autonomy_tier),
      status: String(d.status),
      explanation,
    });
  }
  const cap = Math.max(1, Math.trunc(Number(limit)) || 20);
  return out.sort((a, b) => b.decided_date.localeCompare(a.decided_date) || b.id - a.id).slice(0, cap);
}

// Exercise rotations the brain (or the athlete) applied recently — the signal
// that a stalled-lift read has already been HANDLED and the conductor should
// speak to the new stimulus instead of re-offering buttons. Prefers the
// structured action.swaps written by recordAppliedProposalDecision; falls back
// to the legacy free-text `context.instruction` ("swap X -> Y") so pre-existing
// ledger rows still count.
export interface AppliedRotation {
  from: string;
  to: string;
  date: string; // applied_at (or created_at) local date
}

const SWAP_INSTRUCTION_RE = /^swap\s+(.+?)\s*(?:->|→)\s*(.+)$/i;

export function recentAppliedRotations(days = 21, asOf = localDateISO()): AppliedRotation[] {
  const cutoff = addDaysISO(asOf, -Math.max(1, Math.trunc(days))) ?? asOf;
  const applied = listBrainDecisions({ status: "applied", domain: "training", limit: 100 });
  const out: AppliedRotation[] = [];
  for (const d of applied) {
    const stamp = stampDay(d.applied_at) || stampDay(d.created_at);
    if (!stamp || stamp < cutoff) continue;
    const swaps = Array.isArray((d.action as any)?.swaps) ? ((d.action as any).swaps as any[]) : [];
    let matched = false;
    for (const s of swaps) {
      const from = String(s?.from ?? "").trim();
      const to = String(s?.to ?? "").trim();
      if (from && to) {
        out.push({ from, to, date: stamp });
        matched = true;
      }
    }
    if (matched) continue;
    const instruction = String((d.context as any)?.instruction ?? "").trim();
    const m = SWAP_INSTRUCTION_RE.exec(instruction);
    if (m) out.push({ from: m[1].trim(), to: m[2].trim(), date: stamp });
  }
  return out;
}

// A recently vetoed decision of this kind. Automatic re-proposal paths consult
// this so one "no" is respected for a bounded window instead of being re-asked
// at the next signal boundary (a rejected nutrition target, then a weigh-in that
// re-triggers the same check-in). created_at is SQLite CURRENT_TIMESTAMP (UTC
// text, e.g. "2026-07-13 19:09:48"), so a datetime() comparison against a
// relative modifier works directly. The window string is built from a sanitized
// integer, never raw input.
//
// Two veto shapes count. `rejected`/`reverted` are the explicit "undo/no". A
// `canceled` row counts ONLY when it carries the user-hold marker
// (context_json.held_by_user) stamped by revertDecision when the athlete taps
// "Hold this" on an announced change — a deliberate "not this, for now". SYSTEM
// cancels (cancelAnnouncementsForProposal firing on a weekly supersede, a fresh
// draft retiring an older one) never carry that marker, so they are correctly NOT
// vetoes. `canceled` is deliberately kept OUT of the demotion counters
// (domainShouldDemote) — this read is only about respecting a recent "no" before
// re-proposing the same kind, never about eroding autonomy.
export function hasRecentDecisionVeto(kind: string, days = 5): boolean {
  const key = String(kind || "").trim();
  if (!key) return false;
  const window = Math.max(1, Math.trunc(Number(days) || 5));
  const row = db
    .prepare(
      `SELECT 1 FROM brain_decisions
       WHERE kind = ?
         AND created_at >= datetime('now', ?)
         AND (
           status IN ('rejected','reverted')
           OR (status = 'canceled' AND json_extract(context_json, '$.held_by_user') = 1)
         )
       LIMIT 1`
    )
    .get(key, `-${window} days`);
  return !!row;
}

export function insertBrainDecision(value: unknown): BrainDecision {
  const normalized = normalizeBrainDecision(value);
  if (!normalized) throw new Error("invalid brain decision");
  const insert = db.prepare(
    `INSERT OR IGNORE INTO brain_decisions
      (effective_date, kind, domain, summary, rationale, source, source_ref_type, source_ref_key,
       status, autonomy_tier, risk_class, reversible, input_fingerprint, context_json, action_json,
       specialist_json, applied_at, reverted_at, superseded_by, evaluator_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = insert.run(
    normalized.effective_date,
    normalized.kind,
    normalized.domain,
    normalized.summary,
    normalized.rationale,
    normalized.source,
    normalized.source_ref_type,
    normalized.source_ref_key,
    normalized.status,
    normalized.autonomy_tier,
    normalized.risk_class,
    normalized.reversible ? 1 : 0,
    normalized.input_fingerprint,
    json(normalized.context),
    json(normalized.action),
    json(normalized.specialist),
    normalized.applied_at,
    normalized.reverted_at,
    normalized.superseded_by,
    normalized.evaluator_version
  );
  const stored =
    Number(info.changes) > 0
      ? getBrainDecision(Number(info.lastInsertRowid))
      : normalized.input_fingerprint
        ? findBrainDecisionByFingerprint(normalized.input_fingerprint)
        : null;
  if (!stored) throw new Error("brain decision was not stored");
  return stored;
}

/**
 * Move a decision to a new lifecycle status, cancelling its live expectations when the
 * status is terminal.
 *
 * `keepExpectations` opts OUT of that cancel, for the one case where retiring the
 * decision does not retire the question it asked: a day-read whose outcome the day has
 * already decided (see dayReadOutcomeLocked in repo/brain/read-adherence.ts). It
 * defaults to false, so every other caller — supersedeReviewDecisionsForProposal, the
 * autonomy layer, revert/reject — keeps its existing semantics exactly.
 */
export function transitionBrainDecision(
  id: number,
  status: BrainDecisionStatus,
  opts: { supersededBy?: number | null; effectiveDate?: string | null; keepExpectations?: boolean } = {}
): BrainDecision | null {
  return withSqliteSavepoint(`transition_decision_${Math.trunc(Number(id))}`, () => {
    const current = getBrainDecision(id);
    if (!current) return null;
    const nowColumn =
      status === "applied"
        ? ", applied_at = COALESCE(applied_at, datetime('now'))"
        : status === "reverted"
          ? ", reverted_at = COALESCE(reverted_at, datetime('now'))"
          : "";
    db.prepare(
      `UPDATE brain_decisions SET status = ?, superseded_by = ?, effective_date = COALESCE(?, effective_date)${nowColumn} WHERE id = ?`
    ).run(status, opts.supersededBy ?? current.superseded_by, opts.effectiveDate ?? null, id);
    if (!opts.keepExpectations && ["reverted", "superseded", "canceled", "rejected"].includes(status)) {
      db.prepare(
        `UPDATE brain_expectations SET status = 'canceled' WHERE decision_id = ? AND status IN ('pending','mature')`
      ).run(id);
    }
    return getBrainDecision(id);
  });
}

// Retire every live `review` brain_decision that holds this plan proposal to
// 'superseded'. A held draft's terminal transition (applied / discarded /
// superseded) makes its outstanding review hold moot — the hold said "wait", and
// the proposal has now landed or been retired — so a dangling open review row must
// never keep reading as an active hold (listReviewHeldProposals / planDraftCandidate).
// Idempotent: a double-call after the rows are already superseded is a no-op. This is
// the shared repo-level implementation; the autonomy layer's supersedePriorReviewHolds
// delegates here so the two never drift.
export function supersedeReviewDecisionsForProposal(proposalId: number): void {
  for (const decision of listBrainDecisions({ status: "review", limit: 100 })) {
    if (
      decision.source_ref_type === "plan_proposal" &&
      decision.source_ref_key === String(proposalId) &&
      decision.id != null
    ) {
      transitionBrainDecision(decision.id, "superseded");
    }
  }
}

export function patchBrainDecision(id: number, patch: Partial<BrainDecision>): BrainDecision | null {
  const current = getBrainDecision(id);
  if (!current) return null;
  const normalized = normalizeBrainDecision({ ...current, ...patch, id: current.id, created_at: current.created_at });
  if (!normalized) throw new Error("invalid brain decision patch");
  db.prepare(
    `UPDATE brain_decisions SET effective_date=?, kind=?, domain=?, summary=?, rationale=?, source=?,
      source_ref_type=?, source_ref_key=?, status=?, autonomy_tier=?, risk_class=?, reversible=?,
      input_fingerprint=?, context_json=?, action_json=?, specialist_json=?, applied_at=?, reverted_at=?,
      superseded_by=?, evaluator_version=? WHERE id=?`
  ).run(
    normalized.effective_date,
    normalized.kind,
    normalized.domain,
    normalized.summary,
    normalized.rationale,
    normalized.source,
    normalized.source_ref_type,
    normalized.source_ref_key,
    normalized.status,
    normalized.autonomy_tier,
    normalized.risk_class,
    normalized.reversible ? 1 : 0,
    normalized.input_fingerprint,
    json(normalized.context),
    json(normalized.action),
    json(normalized.specialist),
    normalized.applied_at,
    normalized.reverted_at,
    normalized.superseded_by,
    normalized.evaluator_version,
    id
  );
  return getBrainDecision(id);
}

export function moveBrainExpectations(fromDecisionId: number, toDecisionId: number): number {
  if (!getBrainDecision(toDecisionId)) throw new Error(`No brain decision ${toDecisionId}`);
  return Number(
    db.prepare(`UPDATE brain_expectations SET decision_id = ? WHERE decision_id = ?`).run(toDecisionId, fromDecisionId)
      .changes
  );
}

// The undo snapshot kinds. 'goal_date' joined them with heads-up autonomy: a goal date
// that adapts from the signals is only allowed to announce because putting it back is
// one tap, so the rollback has to exist before the write does.
export type BrainRollbackKind =
  | "training_plan"
  | "nutrition_target"
  | "meal_plan"
  | "recovery_cycle"
  | "goal_date"
  | "garmin_strength";

const BRAIN_ROLLBACK_KINDS: readonly BrainRollbackKind[] = [
  "training_plan",
  "nutrition_target",
  "meal_plan",
  "recovery_cycle",
  "goal_date",
  "garmin_strength",
];

export function saveBrainRollback(decisionId: number, kind: BrainRollbackKind, payload: unknown): boolean {
  if (!getBrainDecision(decisionId)) return false;
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 256 * 1024) throw new Error("rollback snapshot exceeds 256 KiB");
  db.prepare(
    `INSERT INTO brain_rollbacks (decision_id, kind, payload_json) VALUES (?, ?, ?)
     ON CONFLICT(decision_id) DO UPDATE SET kind=excluded.kind, payload_json=excluded.payload_json, created_at=datetime('now')`
  ).run(decisionId, kind, encoded);
  return true;
}

export function getBrainRollback(decisionId: number): { kind: BrainRollbackKind; payload: any } | null {
  const row = db.prepare(`SELECT kind, payload_json FROM brain_rollbacks WHERE decision_id = ?`).get(decisionId) as any;
  if (!row || !BRAIN_ROLLBACK_KINDS.includes(String(row.kind) as BrainRollbackKind)) return null;
  try {
    return { kind: row.kind, payload: JSON.parse(row.payload_json) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rollback evidence (W3.2): `brain_rollbacks` is written on every reversible
// decision but, until now, was only ever READ BACK to perform the undo itself —
// never as evidence about whether that DECISION KIND belongs in the coaching
// loop at all. A revert is the strongest "no" available: the change already
// applied, and the athlete deliberately walked it back, which is stronger
// evidence than an unprompted day-read verdict the athlete never acted on. So it
// gets a weight NEAR (not above) an applied/kept decision's own weight — an undo
// can never outrank the athlete's affirmative record for the same kind.
//
// This is intentionally a small, standalone read (not folded into
// evaluatedDecisionRows' verdict pipeline): W3.1's kind-weighting table lands in
// parallel and is expected to call/extend this rather than duplicate the query,
// which is why the join and the weight constant live here as one seam.
// ---------------------------------------------------------------------------

// `brain_decisions.kind` grouping — the decision KIND being reverted (e.g.
// 'nutrition_target', 'training_plan_change'), never `brain_rollbacks.kind`
// (the undo-snapshot shape from BrainRollbackKind above — a different vocabulary).
export interface RollbackEvidenceGroup {
  kind: string;
  domain: string;
  count: number;
  last_reverted_at: string | null;
}

// Near-`applied` weight, deliberately just under 1 — see the section doc above.
export const ROLLBACK_EVIDENCE_WEIGHT = 0.9;

// Every decision kind with at least one REVERTED decision that carries a rollback
// snapshot, most-recently-reverted first. Bounded and read-only; callers gate
// their own "is this repeated" threshold (a single revert is a real signal on its
// own — unlike a dismissal, an athlete does not revert idly — but a repeat is
// what the reaction-model producer below actually surfaces).
export function rollbackEvidenceByKind(limit = 200): RollbackEvidenceGroup[] {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT d.kind AS kind, d.domain AS domain, d.reverted_at AS reverted_at
           FROM brain_rollbacks r
           JOIN brain_decisions d ON d.id = r.decision_id
          WHERE d.status = 'reverted'
          ORDER BY d.reverted_at DESC
          LIMIT ?`
      )
      .all(Math.max(1, Math.trunc(limit))) as any[];
  } catch {
    return [];
  }
  const groups = new Map<string, RollbackEvidenceGroup>();
  for (const row of rows) {
    const kind = String(row?.kind ?? "").trim();
    if (!kind) continue;
    const g = groups.get(kind) ?? { kind, domain: String(row?.domain ?? ""), count: 0, last_reverted_at: null };
    g.count++;
    const at = row?.reverted_at ? String(row.reverted_at) : null;
    if (at && (!g.last_reverted_at || at > g.last_reverted_at)) g.last_reverted_at = at;
    groups.set(kind, g);
  }
  return [...groups.values()];
}

export function insertBrainExpectation(decisionId: number, value: ProposedExpectation | unknown): BrainExpectation {
  const proposed = normalizeProposedExpectation(value);
  if (!proposed) throw new Error("invalid brain expectation");
  if (!getBrainDecision(decisionId)) throw new Error(`No brain decision ${decisionId}`);
  const info = db
    .prepare(
      `INSERT INTO brain_expectations
      (decision_id, metric_key, subject_key, direction, baseline_json, target_json, window_start,
       window_end, minimum_data_json, confounder_policy, confidence, status, evaluator, evaluator_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      decisionId,
      proposed.metric_key,
      proposed.subject_key,
      proposed.direction,
      json(proposed.baseline),
      json(proposed.target),
      proposed.window_start,
      proposed.window_end,
      json(proposed.minimum_data),
      proposed.confounder_policy,
      proposed.confidence,
      proposed.evaluator,
      proposed.evaluator_version
    );
  const stored = getBrainExpectation(Number(info.lastInsertRowid));
  if (!stored) throw new Error("brain expectation was not stored");
  // The newest change owns the metric: this window either retires the older ones it
  // overtook or — thawed out of cold storage onto a decision that only just applied —
  // arrives retired behind a newer one. Either way exactly one live window survives per
  // metric + subject, which is what lets the survivor reach a verdict instead of being
  // annihilated into `inconclusive` by the confounder rule. The rule itself lives in
  // ./brain/expectation-arbitration.js, shared with the repair migration that applied it
  // to the rows written before it existed.
  retireSupersededExpectations(db, { expectationId: stored.id! });
  return getBrainExpectation(stored.id!) ?? stored;
}

export function getBrainExpectation(id: number): BrainExpectation | null {
  return hydrateExpectation(db.prepare(`SELECT * FROM brain_expectations WHERE id = ?`).get(id));
}

export function listBrainExpectations(
  opts: { decisionId?: number; status?: string; matureOnOrBefore?: string; limit?: number } = {}
): BrainExpectation[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.decisionId) {
    where.push("decision_id = ?");
    args.push(opts.decisionId);
  }
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (opts.matureOnOrBefore) {
    where.push("window_end <= ?");
    args.push(opts.matureOnOrBefore);
  }
  const limit = Math.max(1, Math.min(1000, Math.trunc(Number(opts.limit) || 100)));
  const rows = db
    .prepare(
      `SELECT * FROM brain_expectations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY window_end, id LIMIT ?`
    )
    .all(...args, limit) as any[];
  return rows.map(hydrateExpectation).filter((row): row is BrainExpectation => row != null);
}

export function setBrainExpectationStatus(id: number, status: BrainExpectation["status"]): BrainExpectation | null {
  db.prepare(`UPDATE brain_expectations SET status = ? WHERE id = ?`).run(status, id);
  return getBrainExpectation(id);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function brainDecisionFingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

// The one write service for decisions and attached expectations. Keeping the
// implementation beside the transaction-owning repository lets existing apply
// paths record synchronously without introducing a repo -> domain dependency;
// src/domain/brain/decision-service.ts is the use-case export for surfaces.
export function recordDecision(
  input: unknown,
  expectations: ProposedExpectation[] = []
): {
  decision: BrainDecision;
  expectations: BrainExpectation[];
} {
  const record = input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : input;
  if (record && typeof record === "object" && !(record as any).input_fingerprint) {
    const rootFingerprint = brainDecisionFingerprint({
      kind: (record as any).kind,
      source_ref_type: (record as any).source_ref_type,
      source_ref_key: (record as any).source_ref_key,
      effective_date: (record as any).effective_date,
      action: (record as any).action,
    });
    let fingerprint = rootFingerprint;
    let existing = findBrainDecisionByFingerprint(fingerprint);
    let lifecycleAfter: number | null = null;
    const scheduling = ["review", "announced", "pending"].includes(String((record as any).status));
    const terminal = new Set(["canceled", "rejected", "reverted", "superseded"]);
    // A terminal row is immutable history, not ownership of a new scheduling
    // attempt. Walk the lifecycle chain until we find either a live owner or a
    // free fingerprint; repeated retries while live remain idempotent.
    while (scheduling && existing && terminal.has(String(existing.status))) {
      lifecycleAfter = Number(existing.id);
      fingerprint = brainDecisionFingerprint({ root_fingerprint: rootFingerprint, lifecycle_after: lifecycleAfter });
      existing = findBrainDecisionByFingerprint(fingerprint);
    }
    (record as any).input_fingerprint = fingerprint;
    if (lifecycleAfter != null) {
      const context =
        (record as any).context &&
        typeof (record as any).context === "object" &&
        !Array.isArray((record as any).context)
          ? (record as any).context
          : {};
      (record as any).context = { ...context, lifecycle_after_decision_id: lifecycleAfter };
    }
  }
  const normalized = normalizeBrainDecision(record);
  if (!normalized) throw new Error("invalid brain decision");
  return withSqliteSavepoint("record_decision", () => {
    const decision = insertBrainDecision(normalized);
    const existing = new Set(
      listBrainExpectations({ decisionId: decision.id! }).map(
        (item) => `${item.metric_key}|${item.subject_key}|${item.window_end}`
      )
    );
    const stored = expectations
      .filter((item) => !existing.has(`${item.metric_key}|${item.subject_key}|${item.window_end}`))
      .map((expectation) => insertBrainExpectation(decision.id!, expectation));
    return { decision, expectations: stored };
  });
}

import crypto from "node:crypto";
import { db } from "../db.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { type BrainDecision, type BrainDecisionStatus, normalizeBrainDecision } from "../brain/decision-contract.js";
import {
  type BrainExpectation,
  type ProposedExpectation,
  normalizeBrainExpectation,
  normalizeProposedExpectation,
} from "../brain/expectation-contract.js";

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

// ---- forward + rotation readers ---------------------------------------------
// Both feed calm surfaces, so they return small plain shapes, never raw rows.

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
    }));
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
    const stamp = String(d.applied_at ?? d.created_at ?? "").slice(0, 10);
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

export function transitionBrainDecision(
  id: number,
  status: BrainDecisionStatus,
  opts: { supersededBy?: number | null; effectiveDate?: string | null } = {}
): BrainDecision | null {
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
  if (["reverted", "superseded", "canceled", "rejected"].includes(status)) {
    db.prepare(
      `UPDATE brain_expectations SET status = 'canceled' WHERE decision_id = ? AND status IN ('pending','mature')`
    ).run(id);
  }
  return getBrainDecision(id);
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

export function saveBrainRollback(
  decisionId: number,
  kind: "training_plan" | "nutrition_target" | "meal_plan",
  payload: unknown
): boolean {
  if (!getBrainDecision(decisionId)) return false;
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 256 * 1024) throw new Error("rollback snapshot exceeds 256 KiB");
  db.prepare(
    `INSERT INTO brain_rollbacks (decision_id, kind, payload_json) VALUES (?, ?, ?)
     ON CONFLICT(decision_id) DO UPDATE SET kind=excluded.kind, payload_json=excluded.payload_json, created_at=datetime('now')`
  ).run(decisionId, kind, encoded);
  return true;
}

export function getBrainRollback(
  decisionId: number
): { kind: "training_plan" | "nutrition_target" | "meal_plan"; payload: any } | null {
  const row = db.prepare(`SELECT kind, payload_json FROM brain_rollbacks WHERE decision_id = ?`).get(decisionId) as any;
  if (!row || !["training_plan", "nutrition_target", "meal_plan"].includes(String(row.kind))) return null;
  try {
    return { kind: row.kind, payload: JSON.parse(row.payload_json) };
  } catch {
    return null;
  }
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
  return stored;
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
    (record as any).input_fingerprint = brainDecisionFingerprint({
      kind: (record as any).kind,
      source_ref_type: (record as any).source_ref_type,
      source_ref_key: (record as any).source_ref_key,
      effective_date: (record as any).effective_date,
      action: (record as any).action,
    });
  }
  const normalized = normalizeBrainDecision(record);
  if (!normalized) throw new Error("invalid brain decision");
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
}

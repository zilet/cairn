// BELIEF DISPOSITIONS — the durable "that's not right" ledger over the coach's
// derived belief sources (learned models, felt-signal correlations, personal-
// response modifiers). See db.ts's belief_dispositions CREATE TABLE for why
// this is its own table rather than a column on the belief rows themselves:
// none of those sources persists rows at all — each is a deterministically
// REBUILT patterns[] cached as JSON in app_state — so a dispute has to live
// somewhere a nightly rebuild can't erase it.
//
// Belief ids are namespaced by source so the same short pattern id (e.g.
// "checkin_energy") can never collide across learned models / felt signals /
// personal-response modifiers: 'learned_model:<pattern.id>',
// 'felt_signal:<pattern.id>', 'personal_modifier:<modifier.key>'.

import { db } from "../db.js";

export type BeliefSource = "learned_model" | "felt_signal" | "personal_modifier";
export type BeliefStatus = "active" | "disputed";

export interface BeliefDisposition {
  id: string;
  source: BeliefSource;
  status: BeliefStatus;
  disputed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function learnedModelBeliefId(patternId: string): string {
  return `learned_model:${patternId}`;
}

export function feltSignalBeliefId(patternId: string): string {
  return `felt_signal:${patternId}`;
}

export function personalModifierBeliefId(modifierKey: string): string {
  return `personal_modifier:${modifierKey}`;
}

// A single map read per belief-consuming call: id -> status. Empty/never-touched
// belief ids are implicitly 'active' (never in this table), so absence from the
// map is exactly "not disputed" — callers never need to special-case a miss.
export function beliefDispositionMap(): Map<string, BeliefStatus> {
  const map = new Map<string, BeliefStatus>();
  try {
    const rows = db.prepare(`SELECT id, status FROM belief_dispositions`).all() as Array<{
      id: string;
      status: BeliefStatus;
    }>;
    for (const r of rows) map.set(r.id, r.status);
  } catch {
    /* a DB predating this table simply has nothing disputed */
  }
  return map;
}

export function isBeliefDisputed(id: string): boolean {
  try {
    const row = db.prepare(`SELECT status FROM belief_dispositions WHERE id = ?`).get(id) as
      | { status: BeliefStatus }
      | undefined;
    return row?.status === "disputed";
  } catch {
    return false;
  }
}

export function listBeliefDispositions(): BeliefDisposition[] {
  try {
    return db
      .prepare(`SELECT id, source, status, disputed_at, created_at, updated_at FROM belief_dispositions ORDER BY id`)
      .all() as unknown as BeliefDisposition[];
  } catch {
    return [];
  }
}

// Mark one belief disputed — "that's not right". Idempotent: re-disputing an
// already-disputed belief just refreshes updated_at. The row is UPSERTed rather
// than requiring a prior 'active' row to exist, because most belief ids never
// get a row at all until the first dispute.
export function setBeliefDisputed(id: string, source: BeliefSource): BeliefDisposition {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO belief_dispositions (id, source, status, disputed_at, created_at, updated_at)
     VALUES (?, ?, 'disputed', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'disputed', disputed_at = excluded.disputed_at, updated_at = excluded.updated_at`
  ).run(id, source, now, now, now);
  return db
    .prepare(`SELECT id, source, status, disputed_at, created_at, updated_at FROM belief_dispositions WHERE id = ?`)
    .get(id) as unknown as BeliefDisposition;
}

// Reverse a dispute — "set aside" is transparent and reversible by design.
export function setBeliefActive(id: string, source: BeliefSource): BeliefDisposition {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO belief_dispositions (id, source, status, disputed_at, created_at, updated_at)
     VALUES (?, ?, 'active', NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = 'active', disputed_at = NULL, updated_at = excluded.updated_at`
  ).run(id, source, now, now);
  return db
    .prepare(`SELECT id, source, status, disputed_at, created_at, updated_at FROM belief_dispositions WHERE id = ?`)
    .get(id) as unknown as BeliefDisposition;
}

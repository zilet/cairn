// ============================================================================
// lift-structural-change.ts — one server-owned structural change per lift per week.
//
// Two server passes edit a lift's prescription by themselves: the volume step (one more
// set, domain/brain/volume-step.ts) and the plateau ladder (a rep range at the held load,
// or an accessory's rotation, domain/brain/unit-plateau-change.ts). Each keeps its own
// "one a week" memory, but neither saw the other, so the same lift could take a set AND a
// new rep range in one week — two changes at once, and no way to tell which one the next
// sessions answered. The coaching rule is one change at a time: change one variable, let it
// be trained, then read it.
//
// This is the shared read both sides ask, at creation AND at landing (their premises): is
// there, from the OTHER pass, a change on this lift that is
//   - open (a draft: held for a yes, announced for a boundary, deferred), or
//   - landed inside this calendar week (applied, not undone)?
// "Whichever came first": a premise passes its own proposal id, and an open change of the
// other pass counts against it only when it was written earlier (a lower id). A landed one
// always counts. Read-only; throws when the read fails (callers fail closed).
// ============================================================================
import { db } from "../db.js";
import { mondayOf } from "../lib/dates.js";
import { normalizedExerciseKey, resolveExerciseName } from "./exercise-canon.js";
import { localDayOfStamp } from "./shared.js";

// The two passes' sources (plan_proposals.agent), restated: a repo read must not import the
// brain services that route through autonomy (volume-step.ts VOLUME_STEP_AGENT,
// unit-plateau.ts UNIT_PLATEAU_AGENT).
export const STRUCTURAL_CHANGE_AGENTS = { volume_step: "volume-step", unit_plateau: "unit-plateau" } as const;
export type StructuralChangeAgent = (typeof STRUCTURAL_CHANGE_AGENTS)[keyof typeof STRUCTURAL_CHANGE_AGENTS];

const LINKED_DECISION = `d.source_ref_type = 'plan_proposal' AND d.source_ref_key = CAST(p.id AS TEXT)`;

/** A lift's identity for this read: its resolved exercise row, else its normalized name. */
export function structuralLiftIdentity(name: string): string {
  const text = String(name ?? "").trim();
  if (!text) return "";
  const id = resolveExerciseName(text).exercise_id;
  return id != null ? `exercise:${Number(id)}` : `movement:${normalizedExerciseKey(text)}`;
}

// The lifts one stored change touches.
function liftsOf(agent: string, parsed: any): string[] {
  if (agent === STRUCTURAL_CHANGE_AGENTS.volume_step) return [String(parsed?.volume_step?.lift ?? "")];
  const step = parsed?.unit_plateau ?? {};
  return [String(step.lift ?? ""), String(step.to_lift ?? "")];
}

/**
 * Does the OTHER pass (any agent of STRUCTURAL_CHANGE_AGENTS but `self`) hold an open change,
 * or a change landed this calendar week (Monday of `date` to `date`), on any of `lifts`?
 * `before`: the asking proposal's id — an open change counts only when written earlier.
 * Throws when the read fails.
 */
export function otherStructuralChangeOnLift(
  lifts: readonly string[],
  date: string,
  opts: { self: StructuralChangeAgent; before?: number | null }
): boolean {
  const wanted = new Set(lifts.map(structuralLiftIdentity).filter(Boolean));
  if (!wanted.size) return false;
  const others = Object.values(STRUCTURAL_CHANGE_AGENTS).filter((agent) => agent !== opts.self);
  if (!others.length) return false;
  const monday = mondayOf(date);
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.agent AS agent, p.status AS status, p.parsed_json AS parsed_json,
              p.created_at AS created_at,
              (SELECT d.effective_date FROM brain_decisions d WHERE ${LINKED_DECISION} AND d.status = 'applied'
                ORDER BY d.id DESC LIMIT 1) AS effective_date,
              (SELECT d.created_at FROM brain_decisions d WHERE ${LINKED_DECISION} AND d.status = 'applied'
                ORDER BY d.id DESC LIMIT 1) AS decided_at,
              EXISTS (SELECT 1 FROM brain_decisions d WHERE ${LINKED_DECISION}
                       AND d.status IN ('reverted', 'rejected')) AS undone
         FROM plan_proposals p
        WHERE p.agent IN (${others.map(() => "?").join(",")}) AND p.status IN ('draft', 'applied')
        ORDER BY p.id DESC LIMIT 120`
    )
    .all(...others) as any[];
  for (const row of rows) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(row.parsed_json ?? "null"));
    } catch {
      continue;
    }
    if (!liftsOf(String(row.agent), parsed).some((name) => wanted.has(structuralLiftIdentity(name)))) continue;
    if (String(row.status) === "draft") {
      if (opts.before == null || Number(row.id) < Number(opts.before)) return true;
      continue;
    }
    if (Number(row.undone) === 1) continue;
    const landed =
      (row.effective_date ? String(row.effective_date).slice(0, 10) : null) ??
      localDayOfStamp(row.decided_at) ??
      localDayOfStamp(row.created_at) ??
      String(row.created_at ?? "").slice(0, 10);
    if (landed >= monday && landed <= date) return true;
  }
  return false;
}

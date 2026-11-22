// Client-facing DTOs for the mobility self-checks (src/repo/mobility-checks.ts): the
// stored reading, the catalog a person reads to do a check, and the standing read.
// No norms, no bands, no grade: a reading is compared only with the athlete's own
// earlier readings. This module imports nothing.

export type MobilityCheckKey = "ankle_knee_to_wall" | "toe_touch" | "shoulder_back_scratch" | "deep_squat_hold";
export type MobilityCheckSide = "left" | "right";
export type MobilityCheckSource = "user" | "chat";

/** One check as a person reads it: what it is and how to do it alone. */
export interface MobilityCheckCatalogEntry {
  key: MobilityCheckKey;
  label: string;
  /** The canonical stored unit: "cm" (a length) or "s" (the squat hold). */
  unit: "cm" | "s";
  per_side: boolean;
  /** Which way is more range: "more" (a bigger number) or "less" (a smaller one). */
  better: "more" | "less";
  how_to: string;
  /** In `unit`: a move smaller than this reads as holding. */
  smallest_change: number;
}

/** One stored reading. */
export interface MobilityCheckRow {
  id: number;
  date: string;
  check_key: MobilityCheckKey;
  side: MobilityCheckSide | null;
  /** Canonical unit; null only for a deep squat reached heels-down but not timed. */
  value: number | null;
  unit: "cm" | "s";
  note: string | null;
  source: MobilityCheckSource;
  created_at: string | null;
  /** "Ankle, left". */
  label: string;
  /** The reading in words, in the athlete's units ("9 cm", "3.5 in", "4 cm past the floor"). */
  value_text: string;
}

export interface MobilityChecksList {
  checks: MobilityCheckRow[];
  catalog: MobilityCheckCatalogEntry[];
}

export type MobilityCheckLogResult = { ok: true; check: MobilityCheckRow } | { ok: false; error: string };

export type MobilityCheckDeleteResult = { ok: true; id: number } | { ok: false; code: "not_found" | "invalid_id"; error: string };

export interface MobilityCheckRead {
  /** A stable key for the check and side ("ankle_knee_to_wall:left"). */
  id: string;
  /** "Ankle, left". */
  label: string;
  /** The latest reading in words ("9 cm"). */
  now_text: string;
  date: string;
  direction: "better" | "holding" | "worse" | null;
  /** "2 cm more than Sep 3"; null with one reading. */
  move_words: string | null;
}

export interface MobilityStanding {
  /** At least one check has been recorded. */
  available: boolean;
  checks: MobilityCheckRead[];
  /** Days with logged mobility work in the last four weeks. */
  practice_days_4wk: number;
  /** The offer that would let this speak, when no (or only old) checks exist; null otherwise. */
  invite: string | null;
}

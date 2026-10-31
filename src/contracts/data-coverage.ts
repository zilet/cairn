// The "Your data" contract: what Cairn reads about the person, one row per source, and
// at most two gaps where more data would most sharpen the reads.
//
// Served by `GET /api/health/data-coverage` (`get_data_coverage`), composed in
// src/domain/health/data-coverage.ts. Every phrase arrives finished; a renderer frames
// it and never works one out. Counts are record counts ("4 blood draws"), never a
// grade, and nothing here asks for a tap: a gap is informational and the list is empty
// on the common day.
//
// Self-contained: src/client/** reads these types through
// `import("../contracts/data-coverage.js")`.

/** The sources, in the order they are always returned. */
export type DataCoverageKey = "labs" | "scans" | "visits" | "garmin" | "apple_health" | "body";

/** Where a row opens: Records, Sources (Settings), Health → Body, or Train → Measurements. */
export type DataCoverageOpens = "records" | "sources" | "body" | "measurements";

export interface DataCoverageRow {
  key: DataCoverageKey;
  /** "Labs", "Scans", "Garmin"… */
  label: string;
  /** One line on what it holds: "4 blood draws", "CT scan", "Sleep, heart rate and activities". */
  holds: string;
  /** `absent`: nothing on file / not connected. The row then shows `cta` in place of a date. */
  state: "present" | "absent";
  /** "Connect" (a wearable) or "Add" (records), only when absent. */
  cta: string | null;
  /** The newest thing this source holds (YYYY-MM-DD), or null. */
  date: string | null;
  /** That date in words: "Aug 24", "today", "Aug 24, 2025". */
  date_words: string | null;
  /**
   * A wearable's last completed sync (UTC ISO), when it synced cleanly and its newest
   * night still counts as current. The client prints it as "synced 2h ago".
   */
  synced_at: string | null;
  /** Connected, but its newest night no longer counts as current (sensor-freshness.ts). */
  quiet: boolean;
  /** The record a Records row opens on (Labs / Scans / Visits), or null. */
  doc_id: number | null;
  opens: DataCoverageOpens;
}

/** What a gap's link does: open the checkup, open Sources, or open the add sheet. */
export type DataCoverageGapAction = "checkup" | "sources" | "add";

export interface DataCoverageGap {
  /** Stable identity (the evidence-wanted key, `source:wearable`, `workup:<key>`…). */
  key: string;
  /** A bold short subject: "Ferritin", "A wearable", "A blood panel". */
  subject: string;
  /** One plain sentence on why it would help. */
  why: string;
  action: DataCoverageGapAction;
  /** The small text link: "See checkup", "Connect", "Add one". */
  action_label: string;
}

export interface DataCoverageRead {
  as_of: string;
  rows: DataCoverageRow[];
  /** At most two; empty when nothing would sharpen the reads. */
  gaps: DataCoverageGap[];
  frame: string;
}

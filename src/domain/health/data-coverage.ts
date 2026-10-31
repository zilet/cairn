// "Your data" — what Cairn reads about the person, one row per source, and the few
// places where more of it would most sharpen the reads.
//
// The rows are coverage and freshness in plain words: the newest lab draw and how many,
// the newest imaging study, visit notes when there are any, each wearable's last sync,
// the newest DEXA or tape measurement. Nothing here grades the record: a count is how
// many records there are, and an empty source reads "Add" / "Connect", never "missing".
//
// The gaps are at most two, and none on the common day. They come from reads that
// already exist, in this order, first two that fire:
//   1. the evidence-wanted line (evidence-wanted.ts: an overdue recheck or rescan);
//   2. no blood panel on file at all;
//   3. no wearable connected, or every connected one gone quiet — "quiet" is the
//      sensor-freshness law (src/repo/sensor-freshness.ts): its newest night no longer
//      counts as current for sleep, HRV or resting HR;
//   4. a never-measured workup a currently-off marker warrants (next-checkup.ts).
// Pull, never push: nothing here notifies, and nothing waits on any of it.
//
// Read-only. Every threshold belongs to its own module; this file only composes.

import type {
  DataCoverageGap,
  DataCoverageKey,
  DataCoverageRead,
  DataCoverageRow,
} from "../../contracts/data-coverage.js";
import { db } from "../../db.js";
import { listAppleHealthConnections } from "../../repo/apple-health.js";
import { dateWords } from "../../repo/display-words.js";
import { isCurrentHealthDocRow } from "../../repo/health.js";
import { normalizeImagingModality } from "../../repo/imaging.js";
import { labDraws, type LabDraw } from "../../repo/lab-draws.js";
import { warrantedWorkups } from "../../repo/next-checkup.js";
import { sensorIsCurrent, type SensorSignal } from "../../repo/sensor-freshness.js";
import { getSettings } from "../../repo/settings.js";
import { localDateISO } from "../../repo/shared.js";
import { isoDate } from "../../lib/dates.js";
import { evidenceWantedRead } from "./evidence-wanted.js";

export type { DataCoverageGap, DataCoverageRead, DataCoverageRow } from "../../contracts/data-coverage.js";

export const DATA_COVERAGE_FRAME =
  "What Cairn reads about you. More of it sharpens the reads; nothing waits on it. Informational, not medical advice.";

/** At most this many gaps, ever: a short list, never a list of debts. */
export const DATA_COVERAGE_MAX_GAPS = 2;

// The document kinds that are a visit's own paper: the note, its after-visit summary,
// a clinical summary, a procedure note.
const VISIT_KINDS = ["visit_note", "after_visit_summary", "clinical_summary", "procedure_note"];

// The overnight signals a wearable night carries. A wearable is current while its
// newest night still speaks for any of them, each at its OWN bound.
const OVERNIGHT_SIGNALS: readonly SensorSignal[] = ["sleep", "hrv", "resting_hr"];

const MODALITY_WORDS: Readonly<Record<string, string>> = {
  CT: "CT scan",
  MR: "MRI",
  XR: "X-ray",
  DX: "X-ray",
  CR: "X-ray",
  RF: "Fluoroscopy",
  XA: "Angiogram",
  US: "Ultrasound",
  MG: "Mammogram",
  PET: "PET scan",
  PT: "PET scan",
  NM: "Nuclear medicine scan",
};

interface DocRow {
  id: number;
  kind: string | null;
  doc_date: string | null;
  created_at: string | null;
  source_doc_id: number | null;
  parsed_json: string | null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const dayOf = (value: unknown): string | null => isoDate(String(value ?? "").slice(0, 10));

/** The record's rows, light: no hydration, and the JSON only where imaging needs it. */
function recordRows(): DocRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, kind, doc_date, created_at, source_doc_id,
                CASE WHEN kind = 'imaging' THEN parsed_json END AS parsed_json
           FROM health_documents
          WHERE COALESCE(enrichment_status,'') != 'pending_confirm'`
      )
      .all() as unknown as DocRow[];
    return rows.filter(isCurrentHealthDocRow);
  } catch {
    return [];
  }
}

function newest(...dates: (string | null | undefined)[]): string | null {
  return dates.filter((d): d is string => !!d).reduce<string | null>((a, b) => (a && a >= b ? a : b), null);
}

function maxDate(sql: string, ...params: string[]): string | null {
  try {
    const row = db.prepare(sql).get(...params) as { d?: unknown } | undefined;
    return dayOf(row?.d);
  } catch {
    return null;
  }
}

function row(
  key: DataCoverageKey,
  label: string,
  holds: string,
  opens: DataCoverageRow["opens"],
  asOf: string,
  extra: Partial<DataCoverageRow> & { date?: string | null }
): DataCoverageRow {
  const date = extra.date ?? null;
  const state = extra.state ?? (date ? "present" : "absent");
  return {
    key,
    label,
    holds,
    state,
    cta: state === "absent" ? (extra.cta ?? "Add") : null,
    date,
    date_words: date ? freshWords(date, asOf) : null,
    synced_at: extra.synced_at ?? null,
    quiet: extra.quiet ?? false,
    doc_id: extra.doc_id ?? null,
    opens,
  };
}

// "today" / "yesterday", else the short date ("May 2", "Aug 24, 2025") — a weekday
// ("last Thursday") is longer than the date it stands for in a narrow right column.
function freshWords(date: string, asOf: string): string {
  const relative = dateWords(date, asOf, "relative");
  return relative === "today" || relative === "yesterday" ? relative : dateWords(date, asOf);
}

function wearableCurrent(date: string | null, asOf: string): boolean {
  return !!date && OVERNIGHT_SIGNALS.some((signal) => sensorIsCurrent(signal, date, asOf));
}

function imagingWord(doc: DocRow | undefined): string {
  try {
    const study = doc?.parsed_json ? JSON.parse(doc.parsed_json)?.imaging_study?.study : null;
    return MODALITY_WORDS[normalizeImagingModality(study?.modality ?? study?.raw_modality)] ?? "Imaging study";
  } catch {
    return "Imaging study";
  }
}

interface Wearable {
  row: DataCoverageRow;
  connected: boolean;
  /** The newest overnight reading it holds, for the quiet test and the gap line. */
  night: string | null;
}

function garmin(asOf: string): Wearable {
  const s = getSettings() as any;
  const credentials = !!(String(s?.garmin_username ?? "").trim() && s?.garmin_password_configured);
  let sourceConnected = false;
  try {
    sourceConnected = !!db.prepare(`SELECT 1 FROM garmin_sources WHERE auth_status = 'connected' LIMIT 1`).get();
  } catch {}
  const night = maxDate(
    `SELECT MAX(date) AS d FROM garmin_daily_metrics
      WHERE date <= ? AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL OR resting_hr IS NOT NULL)`,
    asOf
  );
  const data = newest(
    maxDate(`SELECT MAX(date) AS d FROM garmin_daily_metrics WHERE date <= ?`, asOf),
    maxDate(`SELECT MAX(date) AS d FROM garmin_activities WHERE date <= ?`, asOf)
  );
  const connected = credentials || sourceConnected || data != null;
  const quiet = connected && !wearableCurrent(night ?? data, asOf);
  const syncedOk = /^ok\b/i.test(String(s?.garmin_last_sync_status ?? "")) && !!s?.garmin_last_sync_at;
  return {
    connected,
    night: night ?? data,
    row: row("garmin", "Garmin", "Sleep, heart rate and activities", "sources", asOf, {
      state: connected ? "present" : "absent",
      cta: "Connect",
      date: data,
      synced_at: connected && !quiet && syncedOk ? String(s.garmin_last_sync_at) : null,
      quiet,
    }),
  };
}

function appleHealth(asOf: string): Wearable {
  let linked: { last_used_at: string | null }[] = [];
  try {
    linked = listAppleHealthConnections().filter((c) => c.status === "connected");
  } catch {}
  const night = maxDate(
    `SELECT MAX(date) AS d FROM daily_metrics
      WHERE source IN ('apple','apple_health') AND date <= ?
        AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL OR resting_hr IS NOT NULL)`,
    asOf
  );
  const data = maxDate(
    `SELECT MAX(date) AS d FROM daily_metrics WHERE source IN ('apple','apple_health') AND date <= ?`,
    asOf
  );
  const connected = linked.length > 0 || data != null;
  const quiet = connected && !wearableCurrent(night ?? data, asOf);
  const lastUsed = linked
    .map((c) => c.last_used_at)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  return {
    connected,
    night: night ?? data,
    row: row("apple_health", "Apple Health", "Sleep, steps and heart rate", "sources", asOf, {
      state: connected ? "present" : "absent",
      cta: "Connect",
      date: data,
      synced_at: connected && !quiet && lastUsed ? lastUsed : null,
      quiet,
    }),
  };
}

function wearableGap(wearables: Wearable[], asOf: string): DataCoverageGap | null {
  const connected = wearables.filter((w) => w.connected);
  if (!connected.length) {
    return {
      key: "source:wearable",
      subject: "A wearable",
      why: "Sleep and overnight heart rate would let the daily read see how you're recovering.",
      action: "sources",
      action_label: "Connect",
    };
  }
  if (connected.some((w) => !w.row.quiet)) return null;
  const latest = [...connected].sort((a, b) => String(b.night ?? "").localeCompare(String(a.night ?? "")))[0];
  const since = latest.night ? dateWords(latest.night, asOf) : null;
  return {
    key: `source:${latest.row.key}:quiet`,
    subject: latest.row.label,
    why: since
      ? `The newest night on file is from ${since}; a fresh sync would let the read see how you're recovering.`
      : "A synced night would let the read see how you're recovering.",
    action: "sources",
    action_label: "Open Sources",
  };
}

/** The "Your data" read: one row per source, then at most two gaps. Read-only. */
export function dataCoverageRead(opts: { asOf?: string } = {}): DataCoverageRead {
  const asOf = dayOf(opts.asOf) ?? localDateISO();
  const docs = recordRows();
  const byId = new Map(docs.map((d) => [Number(d.id), d]));
  const draws = labDraws({ docs, today: asOf, through: asOf });
  const ofKind = (kind: string): LabDraw[] => draws.filter((d) => d.kind === kind);

  const labs = ofKind("bloodwork");
  const scans = ofKind("imaging");
  const dexa = ofKind("dexa");

  const visitDocs = docs
    .filter((d) => VISIT_KINDS.includes(String(d.kind)))
    .map((d) => ({ doc: d, date: dayOf(d.doc_date) ?? dayOf(d.created_at) }))
    .filter((v): v is { doc: DocRow; date: string } => !!v.date && v.date <= asOf)
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        Number(a.doc.source_doc_id != null) - Number(b.doc.source_doc_id != null) ||
        Number(b.doc.id) - Number(a.doc.id)
    );
  const visitDays = new Set(visitDocs.map((v) => v.date)).size;

  const tape = maxDate(`SELECT MAX(date) AS d FROM body_measurements WHERE date <= ?`, asOf);
  const dexaDate = dexa[0]?.date ?? null;
  const bodyDate = newest(dexaDate, tape);
  const bodyHolds =
    dexaDate && tape
      ? "DEXA and tape measurements"
      : dexaDate
        ? "DEXA scans"
        : tape
          ? "Tape measurements"
          : "DEXA scans and tape measurements";

  const g = garmin(asOf);
  const a = appleHealth(asOf);

  const rows: DataCoverageRow[] = [
    row("labs", "Labs", labs.length ? plural(labs.length, "blood draw") : "Blood panels you add", "records", asOf, {
      date: labs[0]?.date ?? null,
      doc_id: labs[0]?.doc_id ?? null,
    }),
    row(
      "scans",
      "Scans",
      scans.length
        ? `${imagingWord(byId.get(scans[0].doc_id))}${scans.length > 1 ? ` · ${plural(scans.length, "study", "studies")}` : ""}`
        : "CT, MRI, X-ray and ultrasound reports",
      "records",
      asOf,
      { date: scans[0]?.date ?? null, doc_id: scans[0]?.doc_id ?? null }
    ),
    ...(visitDocs.length
      ? [
          row("visits", "Visits & notes", `Notes from ${plural(visitDays, "visit")}`, "records", asOf, {
            date: visitDocs[0].date,
            doc_id: Number(visitDocs[0].doc.id),
          }),
        ]
      : []),
    g.row,
    a.row,
    row(
      "body",
      "Body",
      bodyHolds,
      dexaDate && (!tape || dexaDate >= tape) ? "body" : tape ? "measurements" : "body",
      asOf,
      {
        date: bodyDate,
      }
    ),
  ];

  const gaps: DataCoverageGap[] = [];
  const push = (gap: DataCoverageGap | null) => {
    if (gap && gaps.length < DATA_COVERAGE_MAX_GAPS && !gaps.some((x) => x.key === gap.key)) gaps.push(gap);
  };
  try {
    const item = evidenceWantedRead({ asOf }).item;
    if (item)
      push({ key: item.key, subject: item.label, why: item.line, action: "checkup", action_label: "See checkup" });
  } catch {}
  if (!labs.length) {
    push({
      key: "labs:none",
      subject: "A blood panel",
      why: "One panel on file lets the team connect your markers to your training and food.",
      action: "add",
      action_label: "Add one",
    });
  }
  push(wearableGap([g, a], asOf));
  if (gaps.length < DATA_COVERAGE_MAX_GAPS && labs.length) {
    try {
      const workup = warrantedWorkups({ asOf })[0];
      if (workup) {
        push({
          key: `workup:${workup.key}`,
          subject: workup.label,
          why: workup.line,
          action: "checkup",
          action_label: "See checkup",
        });
      }
    } catch {}
  }

  return { as_of: asOf, rows, gaps, frame: DATA_COVERAGE_FRAME };
}

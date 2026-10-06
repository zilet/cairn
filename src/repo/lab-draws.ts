// ONE ROW PER DRAW — the season's labs and scans, never the same draw three times.
//
// One lab draw reaches the record as several documents: the uploaded file, the panels
// a CCDA import split out of it (`source_doc_id` → the upload), a re-export of the same
// day. dedupeHealthDocuments (health-dedupe.ts) folds the RECORDS whose readings agree,
// but the parent upload and its derived children stay separate documents on purpose —
// so a list that drew one row per document showed "Aug 24 · Bloodwork" three times on
// the Season. A draw is a (kind, date) pair; this read is that list, one row each:
// the survivor is the uploaded source document (no `source_doc_id`), else the newest,
// and every document of the draw rides along in `doc_ids`.
//
// Read-only; dates travel as machine `date` plus `date_words` for the person.
import { dateWords } from "./display-words.js";
import { listHealthDocuments } from "./health.js";
import { localDateISO } from "./shared.js";

/** The document kinds the Season and the labs lane draw, with their row label. */
export const LAB_DRAW_KINDS: Readonly<Record<string, string>> = {
  bloodwork: "Bloodwork",
  dexa: "DEXA scan",
  imaging: "Imaging",
  metabolic_test: "Metabolic test",
  ecg: "ECG",
};

export interface LabDraw {
  /** The draw's day (YYYY-MM-DD): the document's result date, else its upload day. */
  date: string;
  /** "Aug 24" / "Aug 24, 2025". */
  date_words: string;
  kind: string;
  label: string;
  /** The document a row opens: the uploaded source of the draw, else the newest. */
  doc_id: number;
  /** Every document that is this draw, survivor first. */
  doc_ids: number[];
}

function dayOf(doc: any): string {
  const d = String(doc?.doc_date ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const c = String(doc?.created_at ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(c) ? c : "";
}

/**
 * The record's draws, newest first, one row per (kind, date). `through` (default today)
 * drops a future-dated document; `limit` caps the rows.
 */
export function labDraws(opts: { through?: string; limit?: number; today?: string } = {}): LabDraw[] {
  const today = opts.today ?? localDateISO();
  const through = opts.through ?? today;
  let docs: any[] = [];
  try {
    docs = listHealthDocuments(1000) as any[];
  } catch {
    docs = [];
  }
  const groups = new Map<string, any[]>();
  for (const doc of docs) {
    const kind = String(doc?.kind ?? "");
    if (!Object.hasOwn(LAB_DRAW_KINDS, kind) || doc?.id == null) continue;
    const date = dayOf(doc);
    if (!date || date > through) continue;
    const key = `${kind}|${date}`;
    const list = groups.get(key) ?? [];
    list.push(doc);
    groups.set(key, list);
  }
  const rows: LabDraw[] = [];
  for (const [key, list] of groups) {
    const [kind, date] = key.split("|");
    // The uploaded source of the draw first (a derived panel points at it), then newest.
    const ordered = [...list].sort(
      (a, b) => Number(a?.source_doc_id != null) - Number(b?.source_doc_id != null) || Number(b.id) - Number(a.id)
    );
    rows.push({
      date,
      date_words: dateWords(date, today),
      kind,
      label: LAB_DRAW_KINDS[kind],
      doc_id: Number(ordered[0].id),
      doc_ids: ordered.map((d) => Number(d.id)),
    });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
  return opts.limit != null ? rows.slice(0, Math.max(0, opts.limit)) : rows;
}

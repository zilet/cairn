// Records search — one search across everything the athlete has on file: lab and vital
// markers (weigh-ins and home blood pressure already fold into the marker history as the
// Body Weight / BP series), health documents, visit notes, and body readings (the tape
// sites, which are not markers), grouped one of three ways:
//
//   - out_of_range: what is outside the LAB's range first (the lab flagged it, or its value
//     sits outside the range the lab printed — `labRangeRead`, src/repo/lab-range.ts, the
//     one rule the Records page keys on too), then what is inside the lab's range but
//     outside a trusted optimal band (its own section and its own mark, never folded into
//     the lab's), then the rest the lab ranged, then readings no lab ranged (weigh-ins,
//     home cuff, wearables, a result printed without a range: "Other readings"), then
//     documents, visit notes and body readings.
//   - panel: one section per clinical panel, in MARKER_GROUPS array order (the doctor
//     export's order, src/repo/propagation-data.ts), each panel's markers in the packet's
//     own in-panel order (reportMarkerRank, src/report.ts); then the non-marker sections.
//   - newest: every hit in one section, newest reading first.
//
// Every marker carries its reading's age for its OWN kind of marker
// (src/repo/marker-validity.ts) as a field — a past-validity reading is still listed, and
// says so. The internal priority number prioritizeMarkers ranks by never leaves here: the
// rows come from its public (already stripped) output and are stripped again defensively.
//
// Read-only, deterministic, no agent. Informational, never medical advice.

import type {
  ClientRecordsBodyHit,
  ClientRecordsDocumentHit,
  ClientRecordsGroupMode,
  ClientRecordsHit,
  ClientRecordsMarkerHit,
  ClientRecordsSearchRead,
  ClientRecordsSection,
  ClientReadingFreshness,
} from "../../contracts/health-records.js";
import { healthDocumentKindLabel } from "../../healthDocumentKinds.js";
import { reportMarkerRank } from "../../report.js";
import { listBodyMeasurements } from "../../repo/body-metrics.js";
import { listHealthDocuments } from "../../repo/health.js";
import { wearableWeeklyMarkerRead } from "../../repo/health-focus.js";
import { markerAgingClause, markerValidityClass, readingAgeDays, validityBand } from "../../repo/marker-validity.js";
import { labRangeRead } from "../../repo/lab-range.js";
import { markerGroup, markerGroupRank } from "../../repo/propagation-data.js";
import { prioritizeMarkers } from "../../repo/propagation.js";
import { presentMarkerRow } from "../../repo/lab-display.js";
import { labUnitSystem } from "../../repo/settings.js";
import type { LabUnitSystem } from "../../repo/lab-units.js";
import { localDateISO } from "../../repo/shared.js";
import { isoDate } from "../../lib/dates.js";
import { markerOptimalTrusted, publicMarkerRow } from "./marker-public.js";

export type RecordsGroupMode = ClientRecordsGroupMode;
export type RecordsSearchRead = ClientRecordsSearchRead;

export const RECORDS_GROUP_MODES: readonly RecordsGroupMode[] = ["out_of_range", "panel", "newest"];
export const RECORDS_DEFAULT_GROUP: RecordsGroupMode = "out_of_range";
const QUERY_MAX_CHARS = 120;
const DOC_TEXT_MAX_CHARS = 6000;
const SNIPPET_RADIUS = 70;

export const RECORDS_SEARCH_FRAME =
  "Everything on file in one place. The lab's own flag and the optimal band are two separate marks. Informational, not medical advice.";

const VISIT_NOTE_KINDS = new Set(["visit_note", "after_visit_summary"]);

const BODY_SITES: Array<{ column: string; label: string }> = [
  { column: "waist_in", label: "Waist" },
  { column: "hip_in", label: "Hip" },
  { column: "chest_in", label: "Chest" },
  { column: "shoulder_in", label: "Shoulders" },
  { column: "neck_in", label: "Neck" },
  { column: "upper_arm_in", label: "Upper arm" },
  { column: "forearm_in", label: "Forearm" },
  { column: "thigh_in", label: "Thigh" },
  { column: "calf_in", label: "Calf" },
];

export function parseRecordsGroup(raw: unknown): RecordsGroupMode {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (RECORDS_GROUP_MODES as readonly string[]).includes(s) ? (s as RecordsGroupMode) : RECORDS_DEFAULT_GROUP;
}

// The calendar day a stored date or timestamp names, validated.
const dayOf = (value: unknown): string | null => isoDate(String(value ?? "").slice(0, 10));

function norm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(q: string): string[] {
  return norm(q).split(" ").filter(Boolean);
}

function matches(tokens: string[], haystack: string): boolean {
  if (!tokens.length) return true;
  const hay = norm(haystack);
  return tokens.every((t) => hay.includes(t));
}

// Every string leaf of a parsed document, depth-limited and capped — enough to find a
// word in a visit note's assessment or plan without walking an imaging study whole.
function textLeaves(value: unknown, depth = 0, acc: string[] = [], budget = { left: DOC_TEXT_MAX_CHARS }): string[] {
  if (budget.left <= 0 || depth > 4 || value == null) return acc;
  if (typeof value === "string") {
    const s = value.slice(0, budget.left);
    budget.left -= s.length;
    acc.push(s);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const v of value) textLeaves(v, depth + 1, acc, budget);
    return acc;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) textLeaves(v, depth + 1, acc, budget);
  }
  return acc;
}

function snippetOf(tokens: string[], text: string): string | null {
  if (!tokens.length || !text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

const FRESHNESS: Record<0 | 1 | 2, ClientReadingFreshness> = { 0: "current", 1: "aging", 2: "past" };

// `raw` is the canonical-unit row: every judgement (trust, lab range, side) reads it, and
// only the numbers a person sees are taken from its presentation in `system`.
function markerHit(raw: any, asOf: string, system: LabUnitSystem): ClientRecordsMarkerHit {
  const m = presentMarkerRow(raw, system);
  const name = String(m?.name ?? m?.key ?? "").trim();
  const value = m?.latest?.value ?? null;
  const lab = labRangeRead(raw);
  const trusted = markerOptimalTrusted(raw);
  const optimal = trusted
    ? { low: Number(m.optimal.low), high: Number(m.optimal.high), dir: String(m.optimal.dir ?? "band") }
    : null;
  const outside = trusted && typeof m?.in_optimal === "boolean" ? !m.in_optimal : null;
  const num = typeof value === "number" ? value : Number(value);
  const side =
    outside && optimal && Number.isFinite(num)
      ? num > optimal.high
        ? "above"
        : num < optimal.low
          ? "below"
          : null
      : null;
  const date = dayOf(m?.latest?.date);
  const age = readingAgeDays(date, asOf);
  const groupKey = String(m?.group ?? "") || markerGroup(name).key;
  const groupLabel = String(m?.group_label ?? "") || markerGroup(name).label;
  return {
    type: "marker",
    id: `marker:${String(m?.key ?? name)}`,
    name,
    group: { key: groupKey, label: groupLabel },
    unit: m?.unit ?? null,
    value,
    date,
    lab_flag: lab.flag,
    lab_ranged: lab.state !== "unranged",
    lab_range: lab.state,
    lab_out_of_range: lab.state === "out",
    lab_out_of_range_side: lab.side,
    optimal,
    outside_optimal: outside,
    optimal_side: side,
    staleness: {
      validity_class: markerValidityClass(name),
      age_days: age,
      freshness: age == null ? null : FRESHNESS[validityBand(name, age)],
      note: markerAgingClause(name, date, asOf)?.clause ?? null,
    },
    marker: publicMarkerRow(raw, system),
  };
}

function markerHaystack(m: any): string {
  return [m?.name, m?.key, m?.group_label, ...(Array.isArray(m?.source_names) ? m.source_names : [])].join(" ");
}

function documentHit(d: any, tokens: string[]): ClientRecordsDocumentHit | null {
  const kind = String(d?.kind ?? "other");
  const kindLabel = healthDocumentKindLabel(kind);
  const title = String(d?.original_name ?? "").trim() || kindLabel;
  const summary = d?.summary ? String(d.summary) : null;
  const markers = Array.isArray(d?.parsed?.markers) ? d.parsed.markers : [];
  const markerNames = markers.map((x: any) => String(x?.name ?? "")).filter(Boolean);
  const parsedText = textLeaves(d?.parsed).join(" ");
  const body = [summary ?? "", parsedText].join(" ");
  const date = dayOf(d?.doc_date) ?? dayOf(d?.created_at);
  if (!matches(tokens, [title, kind, kindLabel, date ?? "", markerNames.join(" "), body].join(" "))) return null;
  return {
    type: VISIT_NOTE_KINDS.has(kind) ? "visit_note" : "document",
    id: `doc:${Number(d.id)}`,
    doc_id: Number(d.id),
    kind,
    kind_label: kindLabel,
    title,
    date,
    summary,
    // The summary once: `body` already opens with it, so it is not joined in again.
    snippet: snippetOf(tokens, [summary ?? "", markerNames.join(", "), parsedText].join(" ")),
    marker_count: markers.length,
  };
}

function bodyHits(tokens: string[]): ClientRecordsBodyHit[] {
  const out: ClientRecordsBodyHit[] = [];
  try {
    const rows = listBodyMeasurements() as any[]; // chronological
    for (const site of BODY_SITES) {
      const series = rows.filter(
        (r) => r?.[site.column] != null && Number.isFinite(Number(r[site.column])) && dayOf(r?.date)
      );
      if (!series.length) continue;
      if (!matches(tokens, `${site.label} tape measurement body reading`)) continue;
      const last = series[series.length - 1];
      out.push({
        type: "body",
        id: `body:${site.column.replace(/_in$/, "")}`,
        label: site.label,
        unit: "in",
        value: Number(last[site.column]),
        date: dayOf(last.date)!,
        count: series.length,
      });
    }
  } catch {
    /* no tape readings */
  }
  return out;
}

function byNewest(a: { date: string | null }, b: { date: string | null }): number {
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  return String(b.date ?? "").localeCompare(String(a.date ?? ""));
}

function byPanel(a: ClientRecordsMarkerHit, b: ClientRecordsMarkerHit): number {
  return (
    markerGroupRank(a.group.key) - markerGroupRank(b.group.key) ||
    reportMarkerRank(a.group.key, a.name) - reportMarkerRank(b.group.key, b.name) ||
    a.name.localeCompare(b.name)
  );
}

// The out-of-range grouping, in order. The page (src/client/records-search-model.ts)
// files its catalog by the same fields into the same keys and labels. "Within the lab's
// range" holds only readings a lab actually ranged; everything else is "Other readings".
export type RecordsRangeSection = "lab_out_of_range" | "outside_optimal" | "lab_within_range" | "no_lab_range";
export const RANGE_SECTIONS: ReadonlyArray<{ key: RecordsRangeSection; label: string }> = [
  { key: "lab_out_of_range", label: "Outside the lab's range" },
  { key: "outside_optimal", label: "Outside optimal" },
  { key: "lab_within_range", label: "Within the lab's range" },
  { key: "no_lab_range", label: "Other readings" },
];

export function rangeSectionOf(
  hit: Pick<ClientRecordsMarkerHit, "lab_range" | "outside_optimal">
): RecordsRangeSection {
  if (hit.lab_range === "out") return "lab_out_of_range";
  if (hit.outside_optimal === true) return "outside_optimal";
  return hit.lab_range === "within" ? "lab_within_range" : "no_lab_range";
}

const TYPE_ORDER: Record<ClientRecordsHit["type"], number> = { marker: 0, visit_note: 1, document: 2, body: 3 };

function hitName(h: ClientRecordsHit): string {
  return h.type === "marker" ? h.name : h.type === "body" ? h.label : h.title;
}

function trailingSections(
  documents: ClientRecordsDocumentHit[],
  visitNotes: ClientRecordsDocumentHit[],
  body: ClientRecordsBodyHit[]
): ClientRecordsSection[] {
  return [
    { key: "visit_notes", label: "Visit notes", hits: [...visitNotes].sort(byNewest) },
    { key: "documents", label: "Documents", hits: [...documents].sort(byNewest) },
    // Not `body`: that is the Body Composition panel's MARKER_GROUPS key, and in `panel`
    // mode both sections sit side by side, so one response would carry the key twice.
    { key: "body_readings", label: "Body readings", hits: [...body].sort(byNewest) },
  ];
}

export function searchRecords(opts: { q?: unknown; group?: unknown; asOf?: string } = {}): RecordsSearchRead {
  const q = String(typeof opts.q === "string" ? opts.q : "")
    .slice(0, QUERY_MAX_CHARS)
    .trim();
  const group = parseRecordsGroup(opts.group);
  const asOf = dayOf(opts.asOf) ?? localDateISO();
  const tokens = tokensOf(q);

  let rawMarkers: any[] = [];
  try {
    rawMarkers = ((prioritizeMarkers() as any)?.markers ?? []).map(wearableWeeklyMarkerRead);
  } catch {
    rawMarkers = [];
  }
  const system = labUnitSystem();
  const markers = rawMarkers.filter((m) => matches(tokens, markerHaystack(m))).map((m) => markerHit(m, asOf, system));

  let docs: any[] = [];
  try {
    docs = listHealthDocuments(100000) as any[];
  } catch {
    docs = [];
  }
  const docHits = docs.map((d) => documentHit(d, tokens)).filter((h): h is ClientRecordsDocumentHit => h != null);
  const visitNotes = docHits.filter((h) => h.type === "visit_note");
  const documents = docHits.filter((h) => h.type === "document");
  const body = bodyHits(tokens);

  let sections: ClientRecordsSection[];
  if (group === "newest") {
    const all: ClientRecordsHit[] = [...markers, ...visitNotes, ...documents, ...body];
    all.sort(
      (a, b) => byNewest(a, b) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || hitName(a).localeCompare(hitName(b))
    );
    sections = [{ key: "newest", label: "Newest first", hits: all }];
  } else if (group === "panel") {
    const byGroup = new Map<string, { label: string; hits: ClientRecordsMarkerHit[] }>();
    for (const hit of [...markers].sort(byPanel)) {
      const acc = byGroup.get(hit.group.key) ?? { label: hit.group.label, hits: [] };
      acc.hits.push(hit);
      byGroup.set(hit.group.key, acc);
    }
    sections = [
      ...[...byGroup.entries()].map(([key, v]) => ({ key, label: v.label, hits: v.hits })),
      ...trailingSections(documents, visitNotes, body),
    ];
  } else {
    const ordered = [...markers].sort(byPanel);
    const bucket = new Map<RecordsRangeSection, ClientRecordsMarkerHit[]>(RANGE_SECTIONS.map((s) => [s.key, []]));
    for (const hit of ordered) bucket.get(rangeSectionOf(hit))!.push(hit);
    sections = [
      ...RANGE_SECTIONS.map((s) => ({ key: s.key, label: s.label, hits: bucket.get(s.key)! })),
      ...trailingSections(documents, visitNotes, body),
    ];
  }

  return {
    q,
    group,
    as_of: asOf,
    sections: sections.filter((s) => s.hits.length),
    counts: {
      markers: markers.length,
      documents: documents.length,
      visit_notes: visitNotes.length,
      body: body.length,
      lab_out_of_range: markers.filter((m) => m.lab_out_of_range).length,
      outside_optimal: markers.filter((m) => m.outside_optimal === true).length,
    },
    frame: RECORDS_SEARCH_FRAME,
  };
}

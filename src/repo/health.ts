import { db, todayISO } from "../db.js";
import { listExercises } from "./exercises.js";
import { normalizeMarkerReading, seriesUnitsCompatible } from "./lab-units.js";
import { canonicalMarker } from "./marker-canon.js";
import { capStr } from "./nutrition.js";
import { getPlan } from "./plan.js";
import { type OptimalZone, applyReviewDirectives, markerGroup, matchOptimalZone, optimalDistance, presentGroups } from "./propagation.js";

// A modern comprehensive panel (e.g. Function Health) lists 100+ markers. Cap
// generously so a complete transcription is never silently clipped, while still
// bounding a runaway/garbage response. Shared by both the in-place enrich apply
// path (enrich.ts cleanMarkers) and the derived-panel writer below.
export const MAX_MARKERS_PER_PANEL = 250;

// Coarse, provider-agnostic estimate of how many results a pasted lab panel
// contains. Used ONLY to DETECT a grossly incomplete extraction (a model that
// curated 111 markers down to 44) so the ingest path can re-run with a stricter
// prompt — it is never used to build markers. Counts "value lines": a marker's
// value sits on its own line and starts with a number/comparator, or is one of a
// small set of qualitative results. Section headers and marker NAMES start with a
// letter (and aren't in the qualitative set), and the "In/Above/Below Range" flag
// lines are deliberately excluded — so this approximates one count per marker.
// Deliberately rough (±20% is fine for "is this way short?"); never exact.
// Deliberately excludes flag-ish words (in/above/below range, normal) so a flag
// line is not mistaken for a value line and double-counted.
const QUALITATIVE_RESULT =
  /^(negative|positive|none seen|not seen|detected|not detected|reactive|non[- ]?reactive|clear|cloudy|hazy|turbid|yellow|colorless|straw|amber|trace|rh\(d\)|a|b|ab|o)\b/i;

export function estimateMarkerCandidates(text: string): number {
  if (!text || typeof text !== "string") return 0;
  let n = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // A value line: starts with a number, sign, comparator or decimal point…
    if (/^[<>≤≥=]?\s*[+-]?(\d|\.\d)/.test(line)) { n++; continue; }
    // …or is a short qualitative result (not a flag word, not a sentence).
    if (line.length <= 24 && QUALITATIVE_RESULT.test(line)) n++;
  }
  return n;
}

// ---------- health documents ----------
export function hydrateHealthDoc(row: any) {
  if (!row) return row;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

// Strip the on-disk path from API payloads — it's an internal detail and the
// file is served via a dedicated streaming endpoint, not exposed as a path.
function publicHealthDoc(row: any) {
  if (!row) return row;
  const { file_path, ...rest } = hydrateHealthDoc(row);
  return { ...rest, has_file: !!file_path };
}

export interface HealthDocInput {
  kind?: string;
  doc_date?: string | null;
  original_name?: string | null;
  mime?: string | null;
  file_path?: string | null;
  enrichment_status?: string | null;
  parsed_json?: any;
  summary?: string | null;
  source_doc_id?: number | null;
}

export function addHealthDocument(input: HealthDocInput) {
  const kind = input.kind && ["bloodwork", "dexa", "other"].includes(input.kind) ? input.kind : "other";
  const info = db
    .prepare(
      `INSERT INTO health_documents (kind, doc_date, original_name, mime, file_path, parsed_json, summary, enrichment_status, source_doc_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      input.doc_date ?? null,
      input.original_name ?? null,
      input.mime ?? null,
      input.file_path ?? null,
      input.parsed_json != null ? JSON.stringify(input.parsed_json) : null,
      input.summary ?? null,
      input.enrichment_status ?? null,
      input.source_doc_id ?? null
    );
  return getHealthDocument(Number(info.lastInsertRowid));
}

// A single dated panel split out of a multi-record import (one lab visit, scan
// date, etc.). Coerced/clamped like the enrichment apply path.
export interface HealthPanelInput {
  doc_date?: string | null;
  kind?: string;
  summary?: string | null;
  markers?: any[];
  type?: string | null;
}

// Replace the derived panels of a source upload with a fresh set (used by
// multi-record ingestion + re-analysis). Each panel becomes its own dated row
// pointing back at `sourceId`; the binary stays only on the source row. Returns
// the rows created. `original_name` is carried through for provenance.
export function replaceHealthPanels(sourceId: number, panels: HealthPanelInput[], originalName?: string | null) {
  deleteDerivedHealthDocs(sourceId);
  const created: any[] = [];
  for (const p of Array.isArray(panels) ? panels : []) {
    if (!p || typeof p !== "object") continue;
    const markers = Array.isArray(p.markers)
      ? p.markers
        .filter((m: any) => m && typeof m === "object")
        .slice(0, MAX_MARKERS_PER_PANEL)
        .map((m: any) => ({
          name: String(m.name ?? "").slice(0, 120),
          value: typeof m.value === "number" ? m.value : (m.value == null ? null : String(m.value).slice(0, 80)),
          unit: m.unit == null ? null : String(m.unit).slice(0, 40),
          flag: ["low", "normal", "high"].includes(m.flag) ? m.flag : null,
        }))
        .filter((m: any) => m.name)
      : [];
    const date = typeof p.doc_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.doc_date) ? p.doc_date : null;
    const summary = p.summary == null ? null : String(p.summary).slice(0, 1000);
    if (!markers.length && !summary) continue; // an empty panel is noise
    const parsed: Record<string, any> = { markers };
    if (p.type) parsed.type = String(p.type).slice(0, 80);
    const row = addHealthDocument({
      kind: p.kind && ["bloodwork", "dexa", "other"].includes(p.kind) ? p.kind : "other",
      doc_date: date,
      original_name: originalName ?? null,
      file_path: null,             // the binary lives on the source row only
      parsed_json: parsed,
      summary,
      enrichment_status: "done",
      source_doc_id: sourceId,
    });
    created.push(row);
  }
  return created;
}

function deleteDerivedHealthDocs(sourceId: number) {
  return db.prepare(`DELETE FROM health_documents WHERE source_doc_id = ?`).run(sourceId).changes;
}

// Raw row incl. file_path — for internal use (enrichment, file streaming, delete).
export function getHealthDocumentRaw(id: number) {
  return db.prepare(`SELECT * FROM health_documents WHERE id = ?`).get(id) ?? null;
}

// Hydrated row WITHOUT file_path — for API responses.
export function getHealthDocument(id: number) {
  const row = getHealthDocumentRaw(id) as any;
  return row ? publicHealthDoc(row) : null;
}

export function listHealthDocuments(limit = 50) {
  // Newest results first — order by the effective result date (doc_date, falling
  // back to upload time) so a split multi-year import reads as a clean timeline.
  return (db
    .prepare(`SELECT * FROM health_documents ORDER BY COALESCE(doc_date, substr(created_at,1,10)) DESC, id DESC LIMIT ?`)
    .all(limit) as any[]).map(publicHealthDoc);
}

// The single source of truth for "newest health document date" — the effective
// result date (doc_date, falling back to the upload day), as a YYYY-MM-DD string or
// null when there are no docs. Used to STAMP the health synthesis (source_doc_at) and
// to READ whether it's gone stale, so both sides derive the date the same way.
export function newestHealthDocDate(): string | null {
  try {
    const row = db.prepare(
      `SELECT COALESCE(doc_date, substr(created_at, 1, 10)) AS d
         FROM health_documents
        ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)) DESC, id DESC
        LIMIT 1`
    ).get() as any;
    const d = row?.d ? String(row.d).trim().slice(0, 10) : "";
    return d || null;
  } catch {
    return null; // table absent / no docs
  }
}

export function updateHealthDocFields(id: number, fields: { parsed_json?: any; summary?: string | null; kind?: string | null; doc_date?: string | null }) {
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.parsed_json !== undefined) { sets.push("parsed_json = ?"); vals.push(fields.parsed_json != null ? JSON.stringify(fields.parsed_json) : null); }
  if (fields.summary !== undefined) { sets.push("summary = ?"); vals.push(fields.summary ?? null); }
  if (fields.kind !== undefined) {
    const kind = fields.kind && ["bloodwork", "dexa", "other"].includes(fields.kind) ? fields.kind : "other";
    sets.push("kind = ?");
    vals.push(kind);
  }
  if (fields.doc_date !== undefined) { sets.push("doc_date = ?"); vals.push(fields.doc_date ?? null); }
  if (!sets.length) return getHealthDocument(id);
  vals.push(id);
  db.prepare(`UPDATE health_documents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getHealthDocument(id);
}

export function setHealthDocEnrichStatus(id: number, status: string) {
  db.prepare(`UPDATE health_documents SET enrichment_status = ? WHERE id = ?`).run(status, id);
  return getHealthDocument(id);
}

export function deleteHealthDocument(id: number) {
  // Deleting a source upload takes its derived dated panels with it (they have
  // no binary of their own and are meaningless without the source).
  const derived = deleteDerivedHealthDocs(id);
  const deleted = db.prepare(`DELETE FROM health_documents WHERE id = ?`).run(id).changes;
  return { deleted, derived };
}

// ---------- marker forecasting (least-squares slope → plain-language projection) ----------
// A marker series read as a TREND, not a two-point delta: an ordinary
// least-squares line over the (date→value) points gives a per-day slope that's
// robust to one noisy reading. From the slope plus the optimal band we derive a
// PLAIN-LANGUAGE projection ("trending toward optimal, roughly 6 weeks out" /
// "drifting away from optimal" / "stable") — words and a direction only, NEVER a
// number-as-score (the constitution bans 0-100 grades). `eta_weeks` is kept
// internal for ordering (prioritizeMarkers); only the text is ever surfaced.
interface MarkerForecast {
  // direction RELATIVE TO OPTIMAL: improving = heading toward the band,
  // worsening = drifting away the bad way, stable = no meaningful drift,
  // null = not enough data / no zone to judge against.
  direction: "improving" | "worsening" | "stable" | null;
  eta_text: string | null;      // human ETA to reach (or leave) optimal, or null
  eta_weeks: number | null;     // INTERNAL ordering signal — never surfaced as a grade
  crossing: "entering" | "leaving" | null; // projected to cross the optimal edge
}

// Ordinary least-squares slope (value per DAY) over ascending (date,value)
// points. Returns null with <2 points or a degenerate (single-day) span.
export function lsqSlopePerDay(points: { date: string; value: number }[]): number | null {
  if (!points || points.length < 2) return null;
  const xs = points.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
  const ys = points.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den <= 0) return null;
  return num / den; // value units per day
}

// Plain-language ETA for a count of weeks — words only.
function weeksText(weeks: number): string {
  if (weeks <= 1.5) return "roughly a week out";
  if (weeks <= 8) return `roughly ${Math.round(weeks)} weeks out`;
  if (weeks <= 16) return `a few months out`;
  if (weeks <= 78) return `roughly ${Math.round(weeks / 4.345)} months out`;
  return "well over a year out at this pace";
}

// From a marker's series + its optimal zone, derive a forecast relative to the
// OPTIMAL band (not the lab range). Slope sign vs the "worse" direction decides
// improving / worsening; an ETA is projected only when the line will actually
// cross the relevant edge. No zone (or a flat/short series) → a stable/unknown,
// never a fabricated trend. Everything is plain language + direction. Exported so
// the wearable-fitness marker builder (propagation.ts) reuses the SAME forecast.
export function forecastMarker(
  points: { date: string; value: number }[],
  slopePerDay: number | null,
  zone: OptimalZone | null
): MarkerForecast {
  if (slopePerDay == null || !points.length) {
    return { direction: null, eta_text: null, eta_weeks: null, crossing: null };
  }
  const latest = points[points.length - 1].value;
  const weekly = slopePerDay * 7;
  // Span and spread gate "stable": a slope that won't move the value materially
  // across the series' own window reads as stable, not a trend to act on.
  const xs = points.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
  const spanDays = Math.max(1, xs[xs.length - 1] - xs[0]);
  const projectedMove = Math.abs(slopePerDay) * spanDays;
  const vals = points.map((p) => p.value);
  const spread = Math.max(...vals) - Math.min(...vals);
  // Need a zone to speak "toward / away from optimal".
  if (!zone) {
    if (projectedMove < Math.max(spread * 0.05, 1e-9)) {
      return { direction: "stable", eta_text: null, eta_weeks: null, crossing: null };
    }
    return { direction: null, eta_text: null, eta_weeks: null, crossing: null };
  }
  const [lo, hi] = zone.optimal;
  const width = Math.max(hi - lo, 1);
  // "Stable" when the slope barely moves the value vs the optimal band's width.
  if (projectedMove < width * 0.1 && projectedMove < Math.max(spread * 0.05, 1e-9)) {
    return { direction: "stable", eta_text: null, eta_weeks: null, crossing: null };
  }
  const dist = optimalDistance(latest, zone); // 0 when inside optimal
  const inside = dist === 0;
  // Which way is the value moving, and is that toward or away from optimal?
  // dir 'high' = high is worse, 'low' = low is worse, 'band' = either side worse.
  let improving: boolean;
  let edge: number | null = null; // the optimal edge it would cross
  if (zone.dir === "high") {
    improving = weekly < 0;                 // falling = toward optimal
    edge = hi;                              // crossing the upper edge either way
  } else if (zone.dir === "low") {
    improving = weekly > 0;                 // rising = toward optimal
    edge = lo;
  } else {
    // band: judge against the nearer edge it's heading at.
    if (latest > hi) { improving = weekly < 0; edge = hi; }
    else if (latest < lo) { improving = weekly > 0; edge = lo; }
    else { improving = weekly < 0 ? latest <= (lo + hi) / 2 : latest >= (lo + hi) / 2; edge = weekly > 0 ? hi : lo; }
  }
  // ETA to cross the relevant edge, when the slope actually heads there.
  let eta_weeks: number | null = null;
  let crossing: MarkerForecast["crossing"] = null;
  let eta_text: string | null = null;
  if (edge != null && Math.abs(weekly) > 1e-9) {
    const weeksToEdge = (edge - latest) / weekly;
    if (weeksToEdge > 0 && weeksToEdge < 260) {
      eta_weeks = Math.round(weeksToEdge * 10) / 10;
      crossing = inside ? "leaving" : "entering";
    }
  }
  const direction: MarkerForecast["direction"] = improving ? "improving" : "worsening";
  if (eta_weeks != null) {
    const when = weeksText(eta_weeks);
    eta_text = inside
      ? `drifting toward the edge of optimal, ${when}`
      : improving
        ? `trending toward optimal, ${when}`
        : `drifting further from optimal, ${when}`;
  } else {
    eta_text = inside
      ? "holding within optimal"
      : improving
        ? "trending toward optimal"
        : "drifting away from optimal";
  }
  return { direction, eta_text, eta_weeks, crossing };
}

// ---------- health insights: marker history across all documents ----------
// Aggregates every marker from every health document into one per-marker series.
// Docs are walked in effective-date order (doc_date, falling back to the upload
// date), so "latest" is the most recent reading and points form a time series.
export function getMarkerHistory() {
  const docs = db
    .prepare(
      `SELECT id, kind, doc_date, created_at, parsed_json FROM health_documents
       ORDER BY COALESCE(doc_date, substr(created_at,1,10)) ASC, id ASC`
    )
    .all() as any[];

  interface Reading {
    date: string;
    value: number | string;
    flag: string | null;
    unit: string | null;
    source_value?: number | string | null;
    source_unit?: string | null;
    unit_converted?: boolean;
    unit_mismatch?: boolean;
    expected_unit?: string | null;
    name: string;
    doc_id: number;
    kind: string;
  }
  const byKey = new Map<string, Reading[]>();

  for (const d of docs) {
    let parsed: any = null;
    try { parsed = d.parsed_json ? JSON.parse(d.parsed_json) : null; } catch { parsed = null; }
    const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
    const date = (d.doc_date && String(d.doc_date).trim()) || String(d.created_at ?? "").slice(0, 10);
    for (const m of markers) {
      if (!m || typeof m !== "object") continue;
      const rawName = String(m.name ?? "").replace(/\s+/g, " ").trim();
      if (!rawName) continue;
      // A reading is usable when the value is a finite number, a string with a
      // parseable lab number, or a non-empty qualitative result (e.g. "negative").
      // Recognized markers are normalized to the unit their optimal band expects
      // here, while source_value/source_unit keep the lab transcription inspectable.
      // The series KEY is the CANONICAL marker key (marker-canon.ts): different labs'
      // names for the same analyte ("Glucose (random)"/"Glucose Random"; "Vitamin D"/
      // "25-OH Vitamin D"; "eGFR"/the long form) collapse onto one series. The display
      // NAME stays the lab's own (last.name below), so canonicalization only MERGES —
      // it never relabels what the athlete (or a directive) sees.
      const key = canonicalMarker(rawName).key || rawName.toLowerCase();
      const flag = ["low", "normal", "high"].includes(m.flag) ? m.flag : null;
      const sourceUnit = m.unit !== null && m.unit !== undefined && String(m.unit).trim() ? String(m.unit).trim() : null;
      const normalized = normalizeMarkerReading(rawName, m.value, sourceUnit, matchOptimalZone(rawName));
      if (!normalized) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push({
        date,
        value: normalized.value,
        flag,
        unit: normalized.unit,
        source_value: normalized.source_value,
        source_unit: normalized.source_unit,
        unit_converted: normalized.unit_converted,
        unit_mismatch: normalized.unit_mismatch,
        expected_unit: normalized.expected_unit,
        name: rawName,
        doc_id: d.id,
        kind: d.kind ?? "other",
      });
    }
  }

  const markers = [...byKey.entries()].map(([key, readings]) => {
    const last = readings[readings.length - 1];
    const before = readings.length > 1 ? readings[readings.length - 2] : null;
    // Most recent non-null unit seen for this marker.
    let unit: string | null = null;
    for (let i = readings.length - 1; i >= 0; i--) {
      if (readings[i].unit) { unit = readings[i].unit; break; }
    }
    const sameUnitReadings = readings.filter((r) => seriesUnitsCompatible(r.unit, unit));
    // Readings in an INCOMPATIBLE unit family are kept out of the trend (we never
    // guess a conversion across units we can't safely convert — e.g. Lp(a) in
    // mg/dL vs nmol/L). But dropping them silently truncates the series with no
    // signal, so surface a small non-destructive count: how many older readings
    // sit on a different unit and aren't in the trend below. 0 in the normal case.
    const dropped_other_units = readings.length - sameUnitReadings.length;
    const toPublicReading = (r: Reading, includeKind = false) => {
      const out: any = { value: r.value, date: r.date };
      if (includeKind) {
        out.flag = r.flag;
        out.doc_id = r.doc_id;
        out.kind = r.kind;
      }
      if (r.unit_converted) {
        out.source_value = r.source_value ?? null;
        out.source_unit = r.source_unit ?? null;
        out.unit_converted = true;
      }
      if (r.unit_mismatch) {
        out.source_value = r.source_value ?? r.value;
        out.source_unit = r.source_unit ?? r.unit ?? null;
        out.unit_mismatch = true;
        out.expected_unit = r.expected_unit ?? null;
      }
      return out;
    };
    // Chart points carry NUMERIC values only (a "5.4" string still counts);
    // readings are already ascending by effective date from the SQL ordering. If
    // a marker has incompatible source units we keep only the latest unit family
    // in the series, never mixing e.g. Lp(a) nmol/L and mg/dL in one trend.
    const points = sameUnitReadings
      .map((r) => ({
        date: r.date,
        value: typeof r.value === "number" ? r.value : Number(r.value),
        flag: r.flag,
        doc_id: r.doc_id,
        ...(r.unit_converted ? { source_value: r.source_value ?? null, source_unit: r.source_unit ?? null, unit_converted: true } : {}),
        ...(r.unit_mismatch ? { source_value: r.source_value ?? r.value, source_unit: r.source_unit ?? r.unit ?? null, unit_mismatch: true, expected_unit: r.expected_unit ?? null } : {}),
      }))
      .filter((p) => Number.isFinite(p.value));
    // Deterministic trend over the numeric series (ascending by date). n<2 is
    // unknowable; otherwise dir is 'stable' when the net change is small vs the
    // series' own spread (so a marker that barely moved doesn't read as a trend),
    // else 'rising'/'falling'. No score — just direction + raw change + span.
    const n = points.length;
    const zone = last.unit_mismatch ? null : matchOptimalZone(last.name);
    let trend: {
      dir: "rising" | "falling" | "stable" | null;
      change: number | null;
      span_days: number | null;
      n: number;
      slope_per_week: number | null;        // least-squares slope, value/week (rounded)
      projection: string | null;            // PLAIN-LANGUAGE forecast vs optimal — words, no score
    };
    let forecast: MarkerForecast = { direction: null, eta_text: null, eta_weeks: null, crossing: null };
    if (n < 2) {
      trend = { dir: null, change: null, span_days: null, n, slope_per_week: null, projection: null };
    } else {
      const first = points[0];
      const lastP = points[n - 1];
      // round to 2 decimals so float noise (5.6-5.8 = -0.1999…) never leaks into the JSON/agent prompt
      const change = Math.round((lastP.value - first.value) * 100) / 100;
      const vals = points.map((p) => p.value);
      const range = Math.max(...vals) - Math.min(...vals);
      const span_days = Math.round((Date.parse(lastP.date) - Date.parse(first.date)) / 86_400_000) || 0;
      // Least-squares slope over the whole series (robust to a single noisy
      // reading) — supersedes the two-point delta for direction. `change` (the raw
      // first→last delta) stays for back-compat. dir 'stable' when the line barely
      // moves the value across the series' own window vs its spread.
      const slope = lsqSlopePerDay(points);
      const weekly = slope != null ? slope * 7 : null;
      const projectedMove = slope != null ? Math.abs(slope) * Math.max(1, span_days) : 0;
      const dir: "rising" | "falling" | "stable" | null =
        weekly == null
          ? (range > 0 && Math.abs(change) < range * 0.05 ? "stable" : change > 0 ? "rising" : change < 0 ? "falling" : "stable")
          : projectedMove < Math.max(range * 0.05, 1e-9)
            ? "stable"
            : weekly > 0 ? "rising" : weekly < 0 ? "falling" : "stable";
      // Forecast vs the OPTIMAL band — plain-language projection + eta direction.
      forecast = forecastMarker(points, slope, zone);
      trend = {
        dir,
        change,
        span_days,
        n,
        slope_per_week: weekly == null ? null : Math.round(weekly * 1000) / 1000,
        projection: forecast.eta_text,
      };
    }
    const grp = markerGroup(last.name);
    return {
      key,
      name: last.name, // most recent casing seen
      unit,
      group: grp.key,
      group_label: grp.label,
      latest: toPublicReading(last, true),
      prev: before && seriesUnitsCompatible(before.unit, unit) ? toPublicReading(before) : null,
      trend,
      // Forecast vs the OPTIMAL band: {direction:'improving'|'worsening'|'stable',
      // eta_text (plain language), crossing}. eta_weeks is kept INTERNAL (ordering
      // only) and never surfaced as a grade. Null fields when there's nothing to say.
      forecast: { direction: forecast.direction, eta_text: forecast.eta_text, crossing: forecast.crossing },
      // How many older readings were left OUT of the trend because they sit on an
      // incompatible unit (no safe conversion). 0 when nothing was dropped — so the
      // series is never silently truncated without a signal a consumer can show.
      dropped_other_units,
      points,
    };
  });

  // Flagged-latest markers (low/high) first, then alphabetical by display name.
  markers.sort((a, b) => {
    const af = a.latest.flag === "low" || a.latest.flag === "high" ? 0 : 1;
    const bf = b.latest.flag === "low" || b.latest.flag === "high" ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });

  const sliced = markers.slice(0, 200);
  return { markers: sliced, groups: presentGroups(sliced) };
}

// ---------- health reviews (agentic whole-picture read) ----------
function hydrateHealthReview(row: any) {
  if (!row) return null;
  let parsed: any = null;
  try { parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null; } catch { parsed = null; }
  return { ...row, parsed };
}

// Agent-provided reviews are coerced/clamped before write, same discipline as
// coerceMeal/coerceRecipe. Returns the hydrated row, or null when the parsed
// shape is unusable (headline, focus AND watchlist all empty — e.g. a stray
// coach-proposal response).
export function addHealthReview(parsed: any, agent: string | null, raw?: string) {
  if (!parsed || typeof parsed !== "object") return null;
  const STATUSES = new Set(["low", "high", "watch"]);
  const headline = capStr(parsed.headline, 240);
  const wins = (Array.isArray(parsed.wins) ? parsed.wins : [])
    .map((w: any) => capStr(w, 200))
    .filter(Boolean)
    .slice(0, 5);
  const watchlist = (Array.isArray(parsed.watchlist) ? parsed.watchlist : [])
    .filter((w: any) => w && typeof w === "object")
    .map((w: any) => ({
      marker: capStr(w.marker, 60),
      status: STATUSES.has(String(w.status)) ? String(w.status) : "watch",
      why: capStr(w.why, 240),
      action: capStr(w.action, 240),
    }))
    .filter((w: any) => w.marker)
    .slice(0, 8);
  const focus = (Array.isArray(parsed.focus) ? parsed.focus : [])
    .filter((f: any) => f && typeof f === "object")
    .map((f: any) => ({ title: capStr(f.title, 80), why: capStr(f.why, 240), action: capStr(f.action, 240) }))
    .filter((f: any) => f.title)
    .slice(0, 4);
  const followups = (Array.isArray(parsed.followups) ? parsed.followups : [])
    .filter((f: any) => f && typeof f === "object")
    .map((f: any) => ({ what: capStr(f.what, 200), when: capStr(f.when, 80) }))
    .filter((f: any) => f.what)
    .slice(0, 6);
  const training_impact = capStr(parsed.training_impact, 400);
  const nutrition_impact = capStr(parsed.nutrition_impact, 400);
  // Cross-domain directives the agent emitted (the connected brain). Coerced/
  // clamped like the rest; carried on the review so the propagation engine
  // (Stage-2 T4) can persist them into health_directives. Additive — older
  // consumers ignore it.
  const DOMAINS = new Set(["nutrition", "training", "watch"]);
  const directives = (Array.isArray(parsed.directives) ? parsed.directives : [])
    .filter((d: any) => d && typeof d === "object")
    .map((d: any) => ({
      domain: DOMAINS.has(String(d.domain)) ? String(d.domain) : "watch",
      marker: d.marker != null && String(d.marker).trim() ? capStr(d.marker, 60) : null,
      directive: capStr(d.directive, 600),
      rationale: capStr(d.rationale, 600),
      citation: d.citation == null || String(d.citation).trim() === "" ? null : capStr(d.citation, 600) || null,
    }))
    .filter((d: any) => d.directive)
    .slice(0, 12);
  if (!headline && !focus.length && !watchlist.length) return null;
  const clean = { headline, wins, watchlist, focus, followups, training_impact, nutrition_impact, directives };
  const info = db
    .prepare(`INSERT INTO health_reviews (agent, parsed_json, raw_output) VALUES (?, ?, ?)`)
    .run(agent ?? null, JSON.stringify(clean), raw ?? null);
  // Propagate the review's directives into health_directives (source
  // 'health_review', coexisting with the deterministic 'markers' source).
  // Never auto-applies anything beyond recording the directive for review. Only
  // rewrite when the agent actually addressed directives: an explicit array (even
  // empty = "nothing flagged now") replaces the set; an ABSENT field preserves it.
  if (Array.isArray(parsed.directives)) applyReviewDirectives(directives);
  return hydrateHealthReview(db.prepare(`SELECT * FROM health_reviews WHERE id = ?`).get(info.lastInsertRowid));
}

export function getLatestHealthReview() {
  return hydrateHealthReview(db.prepare(`SELECT * FROM health_reviews ORDER BY id DESC LIMIT 1`).get() ?? null);
}

export function listHealthReviews(limit = 10) {
  return (db.prepare(`SELECT * FROM health_reviews ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(hydrateHealthReview);
}

// ---------- context events (life timeline the coach plans around) ----------
function hydrateContextEvent(row: any) {
  if (!row) return row;
  let meta: any = null;
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
  const { meta_json, ...rest } = row;
  return { ...rest, meta };
}

export interface ContextEventInput {
  kind?: string;
  title?: string | null;
  detail?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  meta?: any;
  archived?: boolean;
}

export function addContextEvent(input: ContextEventInput) {
  const kind = input.kind && ["trip", "injury", "life_event", "family_event"].includes(input.kind) ? input.kind : "life_event";
  const info = db
    .prepare(
      `INSERT INTO context_events (kind, title, detail, start_date, end_date, meta_json, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      kind,
      input.title ?? null,
      input.detail ?? null,
      input.start_date ?? null,
      input.end_date ?? null,
      input.meta != null ? JSON.stringify(input.meta) : null,
      input.archived ? 1 : 0
    );
  return getContextEvent(Number(info.lastInsertRowid));
}

export function listContextEvents(opts: { activeOnly?: boolean } = {}) {
  let rows: any[];
  if (opts.activeOnly) {
    // Active/upcoming = not archived AND (no end_date OR end_date >= today).
    const today = todayISO();
    rows = db
      .prepare(
        `SELECT * FROM context_events
         WHERE archived = 0 AND (end_date IS NULL OR end_date >= ?)
         ORDER BY (start_date IS NULL), start_date, id`
      )
      .all(today) as any[];
  } else {
    rows = db.prepare(`SELECT * FROM context_events ORDER BY (start_date IS NULL), start_date DESC, id DESC`).all() as any[];
  }
  return rows.map(hydrateContextEvent);
}

export function getContextEvent(id: number) {
  const row = db.prepare(`SELECT * FROM context_events WHERE id = ?`).get(id) as any;
  return row ? hydrateContextEvent(row) : null;
}

export function updateContextEvent(id: number, patch: ContextEventInput) {
  const cur = db.prepare(`SELECT * FROM context_events WHERE id = ?`).get(id) as any;
  if (!cur) return null;
  const kind = patch.kind && ["trip", "injury", "life_event", "family_event"].includes(patch.kind) ? patch.kind : cur.kind;
  const merged = {
    kind,
    title: patch.title !== undefined ? patch.title : cur.title,
    detail: patch.detail !== undefined ? patch.detail : cur.detail,
    start_date: patch.start_date !== undefined ? patch.start_date : cur.start_date,
    end_date: patch.end_date !== undefined ? patch.end_date : cur.end_date,
    meta_json: patch.meta !== undefined ? (patch.meta != null ? JSON.stringify(patch.meta) : null) : cur.meta_json,
    archived: patch.archived !== undefined ? (patch.archived ? 1 : 0) : cur.archived,
  };
  db.prepare(
    `UPDATE context_events SET kind=?, title=?, detail=?, start_date=?, end_date=?, meta_json=?, archived=? WHERE id=?`
  ).run(merged.kind, merged.title, merged.detail, merged.start_date, merged.end_date, merged.meta_json, merged.archived, id);
  return getContextEvent(id);
}

export function deleteContextEvent(id: number) {
  return { deleted: db.prepare(`DELETE FROM context_events WHERE id = ?`).run(id).changes };
}

// ============================================================================
// STRUCTURED INJURY TIMELINE — correlate active injuries with the exercises they
// touch, and suggest calm swaps (F3). DETERMINISTIC: works offline, agent-down.
//
// Today an injury is a free-form context_event (kind:'injury', meta {area,
// severity}) and an exercise carries an optional constraint_note — but nothing
// connects them. This is the connective tissue: for each active injury, which
// planned movements load the injured area, and a few safe alternatives for each.
// Suggestions ONLY — never mutates the plan (constitution: suggestion-not-gate).
// ============================================================================

// A body-area vocabulary: each region maps the words an athlete uses for the
// injury (matched against the injury title + detail + meta.area) to the
// muscle_group / exercise-name tokens that LOAD it. Matching mirrors
// matchOptimalZone / markerGroup — lowercased substring, evaluated against both
// the injury text and the exercise's muscle_group + name. Order is not
// significant (an exercise is affected if ANY of a matched region's load-tokens
// hit it). Kept intentionally small and conservative.
interface BodyArea {
  key: string;
  label: string;
  // words in the INJURY text that name this region
  injury: string[];
  // muscle_group / exercise-name tokens that LOAD this region
  load: string[];
}
const BODY_AREAS: BodyArea[] = [
  { key: "knee", label: "knee", injury: ["knee", "patella", "patellar", "acl", "mcl", "meniscus", "quad tendon", "vmo"],
    load: ["leg", "quad", "squat", "lunge", "split squat", "leg extension", "leg press", "step up", "calf"] },
  { key: "hip", label: "hip", injury: ["hip", "glute", "groin", "adductor", "hip flexor"],
    load: ["hip", "glute", "squat", "lunge", "split squat", "deadlift", "hinge", "thrust", "leg"] },
  { key: "lower_back", label: "lower back", injury: ["lower back", "low back", "lumbar", "spine", "disc", "si joint", "sciatic", "back strain"],
    load: ["deadlift", "romanian", "rdl", "hinge", "squat", "good morning", "bent-over row", "barbell row", "posterior", "back extension"] },
  { key: "hamstring", label: "hamstring", injury: ["hamstring", "ham string"],
    load: ["hamstring", "leg curl", "deadlift", "romanian", "rdl", "hinge", "posterior", "good morning"] },
  { key: "calf", label: "calf", injury: ["calf", "achilles", "ankle", "shin"],
    load: ["calf", "calves", "jump", "sprint", "run"] },
  { key: "shoulder", label: "shoulder", injury: ["shoulder", "rotator cuff", "deltoid", "delt", "ac joint", "labrum", "impingement"],
    load: ["shoulder", "delt", "press", "overhead", "bench", "incline", "lateral raise", "chest", "push-up", "dip"] },
  { key: "elbow", label: "elbow", injury: ["elbow", "tricep tendon", "tennis elbow", "golfer", "forearm"],
    load: ["tricep", "bicep", "curl", "pushdown", "press", "pull-up", "chin-up", "row", "extension"] },
  { key: "wrist", label: "wrist", injury: ["wrist", "hand", "thumb", "carpal"],
    load: ["curl", "press", "pull-up", "chin-up", "row", "deadlift", "grip", "front squat"] },
  { key: "chest", label: "chest", injury: ["chest", "pec", "sternum", "rib"],
    load: ["chest", "bench", "incline", "press", "fly", "dip", "push-up"] },
  { key: "neck", label: "neck", injury: ["neck", "cervical", "trap"],
    load: ["overhead", "shrug", "press", "deadlift", "row", "face pull"] },
];

// Tokens drawn from an exercise to match against a body-area's load list:
// its muscle_group + name, lowercased. (constraint_note is matched separately,
// as an independent affected-signal — a hand-noted limit on a movement is itself
// evidence it's risky for whatever it constrains.)
function exerciseTokens(ex: { name?: string; muscle_group?: string | null }): string {
  return `${ex.muscle_group ?? ""} ${ex.name ?? ""}`.toLowerCase();
}

// The injury's searchable text: title + detail + meta.area (the most specific
// signal). meta may arrive parsed (hydrateContextEvent) or as a raw string.
function injuryText(ev: any): string {
  let meta: any = ev?.meta;
  if (meta == null && ev?.meta_json) { try { meta = JSON.parse(ev.meta_json); } catch { meta = null; } }
  const area = meta && typeof meta === "object" ? meta.area : null;
  return `${ev?.title ?? ""} ${ev?.detail ?? ""} ${area ?? ""}`.toLowerCase();
}

// Which body-areas an injury names (an injury can implicate more than one — e.g.
// "knee and hip" — though usually one). Returns the matched BodyArea rows.
function injuryAreas(ev: any): BodyArea[] {
  const text = injuryText(ev);
  return BODY_AREAS.filter((a) => a.injury.some((w) => text.includes(w)));
}

// Does this injury load-affect this exercise? True when any matched area's
// load-token appears in the exercise's muscle_group/name. Exported as the small,
// well-tested deterministic core. `areas` may be precomputed for a batch.
export function injuryAffectsExercise(
  ev: any,
  ex: { name?: string; muscle_group?: string | null },
  areas?: BodyArea[]
): boolean {
  const matched = areas ?? injuryAreas(ev);
  if (!matched.length) return false;
  const toks = exerciseTokens(ex);
  return matched.some((a) => a.load.some((t) => toks.includes(t)));
}

// Suggest up to `limit` safe alternative exercises for an affected one: movements
// from the existing exercise list that do NOT load any of the injury's areas and
// sit in a DIFFERENT muscle group, preferring same-mode (reps↔reps, timed↔timed)
// and an explicitly-uninvolved muscle group. Suggestions only — never applied.
function suggestSwapsFor(
  affected: any,
  areas: BodyArea[],
  allExercises: any[],
  limit = 3
): { name: string; muscle_group: string | null; mode: string; why: string }[] {
  const affectedTokens = exerciseTokens(affected);
  const affectedMode = affected.mode === "timed" ? "timed" : "reps";
  const candidates = allExercises.filter((c) => {
    if (!c || !c.name) return false;
    if (String(c.name).toLowerCase() === String(affected.name ?? "").toLowerCase()) return false;
    // never suggest something that loads the injured area (areas are passed
    // explicitly, so the first arg is unused here)
    if (injuryAffectsExercise(null, c, areas)) return false;
    // skip another exercise that's already constraint-noted (likely also limited)
    if (c.constraint_note && String(c.constraint_note).trim()) return false;
    // a different muscle group than the affected movement
    const cmg = String(c.muscle_group ?? "").toLowerCase();
    if (cmg && affectedTokens.includes(cmg) && cmg.length > 2) {
      // same primary muscle group as the affected lift — only allow if it clearly
      // doesn't load the area (already checked) AND isn't an exact group echo
      return cmg !== String(affected.muscle_group ?? "").toLowerCase();
    }
    return true;
  });
  // rank: same mode first, then those whose muscle group differs from affected,
  // then alphabetical for stable, deterministic output.
  candidates.sort((a, b) => {
    const am = (a.mode === "timed" ? "timed" : "reps") === affectedMode ? 0 : 1;
    const bm = (b.mode === "timed" ? "timed" : "reps") === affectedMode ? 0 : 1;
    if (am !== bm) return am - bm;
    return String(a.name).localeCompare(String(b.name));
  });
  return candidates.slice(0, limit).map((c) => ({
    name: c.name,
    muscle_group: c.muscle_group ?? null,
    mode: c.mode === "timed" ? "timed" : "reps",
    why: c.muscle_group ? `hits ${c.muscle_group}, clear of the area` : "clear of the area",
  }));
}

// The full structured read: for each ACTIVE injury context_event, the planned
// exercises it touches (with where they appear in the plan + any existing
// constraint_note) and a few safe swap suggestions per affected movement. Pure
// read — surfaced calmly in the Life tab / on Today, never auto-applied.
//
// Shape: { injuries: [{ id, title, area, severity, since, areas:[label],
//   affected:[{ exercise, muscle_group, mode, constraint_note, days:[{day_number,
//   day_name}], swaps:[{name,muscle_group,mode,why}] }] }], count }
export function getInjuryImpacts() {
  const injuries = (listContextEvents({ activeOnly: true }) as any[]).filter((e) => e.kind === "injury");
  if (!injuries.length) return { injuries: [], count: 0 };

  const allExercises = listExercises() as any[];
  const plan = getPlan() as any[]; // [{ day_number, name, items:[{exercise, muscle_group, mode, constraint_note, ...}] }]

  // Build a unique set of planned exercises with the days they appear on.
  const plannedByName = new Map<string, { ex: any; days: { day_number: number; day_name: string }[] }>();
  for (const d of plan) {
    for (const it of d.items ?? []) {
      const key = String(it.exercise ?? "").toLowerCase();
      if (!key) continue;
      if (!plannedByName.has(key)) {
        plannedByName.set(key, {
          ex: { name: it.exercise, muscle_group: it.muscle_group ?? null, mode: it.mode ?? "reps", constraint_note: it.constraint_note ?? null },
          days: [],
        });
      }
      plannedByName.get(key)!.days.push({ day_number: d.day_number, day_name: d.name });
    }
  }

  const out = injuries.map((inj) => {
    const areas = injuryAreas(inj);
    let meta: any = inj.meta;
    if (meta == null && inj.meta_json) { try { meta = JSON.parse(inj.meta_json); } catch { meta = null; } }
    meta = meta && typeof meta === "object" ? meta : {};
    const affected = [...plannedByName.values()]
      .filter(({ ex }) =>
        injuryAffectsExercise(inj, ex, areas) ||
        // a constraint_note that names the injured area is itself an affected signal
        (ex.constraint_note && areas.some((a) => String(ex.constraint_note).toLowerCase().includes(a.label) || a.injury.some((w) => String(ex.constraint_note).toLowerCase().includes(w)))))
      .map(({ ex, days }) => ({
        exercise: ex.name,
        muscle_group: ex.muscle_group,
        mode: ex.mode === "timed" ? "timed" : "reps",
        constraint_note: ex.constraint_note || null,
        days,
        swaps: areas.length ? suggestSwapsFor(ex, areas, allExercises) : [],
      }))
      .sort((a, b) => String(a.exercise).localeCompare(String(b.exercise)));
    return {
      id: inj.id,
      title: inj.title || "Injury",
      area: meta.area || (areas[0] ? areas[0].label : null),
      severity: meta.severity || null,
      since: inj.start_date || null,
      areas: areas.map((a) => a.label),
      affected,
    };
  });

  const count = out.reduce((n, i) => n + i.affected.length, 0);
  return { injuries: out, count };
}

// The LAB LOOP — anchoring an applied plan/meal change to the marker it was meant to
// move, and learning (per this athlete) which kind of change coincided with which
// marker direction.
//
// The connected brain already propagates a flagged marker into per-domain directives
// (propagation.ts) that reshape meals & training, and it already records a
// marker-direction expectation on the DIRECTIVE itself (recordActiveDirectiveDecisions).
// What was missing: when the athlete APPLIES a meal plan or training change while such a
// directive is active, nothing tied THAT intervention to the marker — so an outcome
// (the next lab draw) could never be attributed back to the change. This module closes
// that gap in two deterministic, null-safe halves:
//
//   1) markerInterventionRecording() — at apply time, find the marker-sourced directives
//      active in the change's domain, pick the PRIMARY driver (highest-priority marker),
//      and return a falsifiable marker_direction expectation ("<marker> should move toward
//      optimal at the next reading") to attach to the apply's brain decision. The existing
//      zero-evidence -> inconclusive evaluator contract keeps it honest until a new lab lands.
//   2) learnedMarkerResponses() / markerResponseCoachLine() — read the VERDICTS on those
//      intervention-anchored expectations and build a bounded, humble learned pattern:
//      which intervention KIND coincided with which marker direction FOR THIS athlete.
//      Surfaced (pull, never push) as at most ONE calm line in the health-review prompt.
//
// CONSTITUTION (binding): informational, not medical advice; humble correlation framing
// ("coincided with"), never causal certainty; no numeric scores ever cross the boundary;
// suggestion, never a gate. Everything here is deterministic + agent-free.

import { db } from "../db.js";
import { listActiveDirectives } from "./coach.js";
import { canonicalDirectiveMarker, prioritizeMarkers } from "./propagation.js";
import { markerSide, matchOptimalZone } from "./propagation-data.js";
import { addDaysISO } from "./shared.js";
import type { ProposedExpectation } from "../brain/expectation-contract.js";

// The lab horizon: a marker realistically re-reads on the order of months, so the
// expectation window matches the directive-anchored path (recordActiveDirectiveDecisions).
const MARKER_HORIZON_DAYS = 180;
const MARKER_EXPECTATION_VERSION = "intervention-marker-v1";

// Decision kinds that represent an APPLIED plan/meal intervention (not a directive
// observation). Only these anchor + feed the learned response — a directive's own
// marker_direction expectation lives under kind 'health_directive' and is excluded, so
// the learned "what worked" read never double-counts the directive as its own outcome.
const INTERVENTION_DECISION_KINDS = [
  "meal_plan",
  "nutrition_target",
  "training_structure",
  "training_target",
  "exercise_rotation",
] as const;

type InterventionKind = (typeof INTERVENTION_DECISION_KINDS)[number];

// The domain a plan/meal apply touches, mapped to the directive `domain` values. Meal &
// nutrition-target changes are nutrition; strength/structure/rotation changes are training.
type InterventionDomain = "nutrition" | "training";

// Which domain each intervention kind belongs to — used to scope the anchor-time dedup
// when the caller doesn't pass an exact kind.
const KIND_DOMAIN: Record<InterventionKind, InterventionDomain> = {
  meal_plan: "nutrition",
  nutrition_target: "nutrition",
  training_structure: "training",
  training_target: "training",
  exercise_rotation: "training",
};

export interface MarkerInterventionAnchor {
  marker: string; // canonical marker label — the expectation subject_key
  baseline_value: number; // the value when the directive was raised (or the current reading)
  direction: "increase" | "decrease"; // toward optimal
  trigger_side: "low" | "high";
  source: string; // 'markers' | 'health_review'
  priority_rank: number; // 0 = highest-impact; used only to pick the primary driver
}

export interface MarkerInterventionRecording {
  primary: MarkerInterventionAnchor;
  others: string[]; // the other anchored marker labels — recorded in meta, not expectations
  // null when an OPEN (unevaluated) same-marker+kind anchor already exists with no new lab
  // reading since — one lab draw is ONE evidence unit, so the repeat apply records the
  // anchor in meta (deduped) WITHOUT minting a second, near-identical expectation.
  expectation: ProposedExpectation | null;
  meta: {
    anchored_marker: string;
    anchored_markers: string[];
    trigger_side: "low" | "high";
    baseline_value: number;
    directive_source: string;
    deduped?: boolean; // true when the expectation was suppressed as a same-draw repeat
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Build a marker-name -> { rank, value, side } lookup from the live priority snapshot,
// keyed by BOTH the raw marker name and its canonical directive label (lowercased), so a
// directive naming either term resolves. Rank is the snapshot's impact order (0 = top).
function buildMarkerPriorityIndex(): Map<string, { rank: number; value: number | null; side: string | null }> {
  const out = new Map<string, { rank: number; value: number | null; side: string | null }>();
  let markers: any[] = [];
  try {
    markers = prioritizeMarkers().markers;
  } catch {
    return out;
  }
  markers.forEach((m, rank) => {
    const rawName = String(m?.name ?? "").trim();
    if (!rawName) return;
    const value = isFiniteNumber(m?.latest?.value) ? m.latest.value : Number(m?.latest?.value);
    const numeric = Number.isFinite(value) ? value : null;
    const zone = matchOptimalZone(rawName);
    const flag = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
    const side = zone && numeric != null ? markerSide(numeric, zone, flag) : flag;
    const entry = { rank, value: numeric, side: side ?? null };
    const nameKey = rawName.toLowerCase();
    if (!out.has(nameKey)) out.set(nameKey, entry);
    const label = canonicalDirectiveMarker(rawName);
    if (label) {
      const labelKey = label.toLowerCase();
      if (!out.has(labelKey)) out.set(labelKey, entry);
    }
  });
  return out;
}

// Does a marker draw for `marker` exist in health_documents dated strictly AFTER `sinceISO`?
// A new lab reading is what makes a repeat apply a genuinely distinct evidence draw — so its
// presence is what LIFTS the anchor-time dedup below. Bounded + null-safe; matches names the
// way the directive marker was canonicalized (falling back to a raw lowercased compare).
function hasMarkerReadingAfter(marker: string, sinceISO: string): boolean {
  const canon = (name: string): string => (canonicalDirectiveMarker(name) || name).trim().toLowerCase();
  const wanted = canon(marker);
  if (!wanted) return false;
  try {
    const rows = db
      .prepare(
        `SELECT parsed_json FROM health_documents
          WHERE parsed_json IS NOT NULL
            AND COALESCE(doc_date, substr(created_at, 1, 10)) > ?
          ORDER BY COALESCE(doc_date, substr(created_at, 1, 10)) DESC, id DESC
          LIMIT 50`
      )
      .all(sinceISO) as Array<{ parsed_json: string }>;
    for (const row of rows) {
      let parsed: any;
      try {
        parsed = JSON.parse(row.parsed_json);
      } catch {
        continue;
      }
      const markers = Array.isArray(parsed?.markers) ? parsed.markers : [];
      for (const m of markers.slice(0, 400)) {
        const name = String(m?.name ?? m?.marker ?? m?.key ?? "").trim();
        if (name && canon(name) === wanted && Number.isFinite(Number(m?.value))) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// Anchor-time dedup: is there already an OPEN (never-evaluated) marker_direction expectation
// for THIS marker + intervention-label group, applied, with NO new lab reading since it was
// created? If so, a fresh apply within the same draw window must NOT mint a second expectation
// — the next lab draw is one outcome and must count once. A new reading in the meantime lifts
// the block (that later apply is a legitimately distinct draw). Best-effort: never suppress on
// a query error (a missing anchor is safer than a lost one).
function openAnchorSuppresses(marker: string, kind: InterventionKind | undefined, domain: InterventionDomain): boolean {
  // Group kinds the way the learned read does (interventionLabel): a meal-plan re-draft and a
  // nutrition-target change are DIFFERENT interventions even though both are nutrition. When
  // the caller passes no exact kind, fall back to every kind in the domain.
  const groupKinds: readonly InterventionKind[] = kind
    ? INTERVENTION_DECISION_KINDS.filter((k) => interventionLabel(k) === interventionLabel(kind))
    : INTERVENTION_DECISION_KINDS.filter((k) => KIND_DOMAIN[k] === domain);
  if (!groupKinds.length) return false;
  try {
    const placeholders = groupKinds.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT x.window_start AS window_start
           FROM brain_expectations x
           JOIN brain_decisions d ON d.id = x.decision_id
          WHERE x.metric_key = 'marker_direction'
            AND lower(x.subject_key) = lower(?)
            AND d.kind IN (${placeholders})
            AND d.status = 'applied'
            AND NOT EXISTS (SELECT 1 FROM brain_evaluations e WHERE e.expectation_id = x.id)
          ORDER BY x.id DESC
          LIMIT 1`
      )
      .get(marker, ...groupKinds) as { window_start?: string } | undefined;
    const since = row?.window_start ? String(row.window_start).slice(0, 10) : null;
    if (!since) return false; // no open anchor -> a new expectation is legitimate
    // An open anchor exists: only a NEW draw since it was created earns a second expectation.
    return !hasMarkerReadingAfter(marker, since);
  } catch {
    return false;
  }
}

// The falsifiable "<marker> should move toward optimal" expectation, mirroring the shape
// the directive-anchored path (recordActiveDirectiveDecisions) already uses so both feed
// the same evaluator identically.
function markerDirectionExpectation(anchor: MarkerInterventionAnchor, effectiveDate: string): ProposedExpectation {
  return {
    metric_key: "marker_direction",
    subject_key: anchor.marker,
    direction: anchor.direction,
    baseline: { value: anchor.baseline_value },
    target: {},
    window_start: effectiveDate,
    window_end: addDaysISO(effectiveDate, MARKER_HORIZON_DAYS) ?? effectiveDate,
    minimum_data: { marker_draws: 2 },
    confounder_policy: "next_draw",
    // An applied plan is an INDIRECT lever on a marker (unlike the directive itself),
    // so the anchor stays tentative until a verdict repeats.
    confidence: "tentative",
    evaluator: "marker_direction",
    evaluator_version: MARKER_EXPECTATION_VERSION,
  };
}

// At apply time: if any marker-sourced directive ('markers' | 'health_review') is active in
// this change's domain, resolve the PRIMARY marker driver (highest-priority, with a usable
// off-optimal side + baseline value) and return its expectation + anchor meta. Null when
// there is nothing to anchor — preserving today's behavior for an ordinary apply.
export function markerInterventionRecording(
  domain: InterventionDomain,
  effectiveDate: string,
  kind?: InterventionKind
): MarkerInterventionRecording | null {
  let directives: any[] = [];
  try {
    directives = listActiveDirectives();
  } catch {
    return null;
  }
  const relevant = directives.filter(
    (d) =>
      (d?.source === "markers" || d?.source === "health_review") &&
      String(d?.domain) === domain &&
      d?.marker != null &&
      String(d.marker).trim() !== "" &&
      // Cluster markers ("ApoB+LDL-C+Lp(a)") are synthesized cross-marker reads, not a
      // single analyte the evaluator can re-read — never anchor an outcome to one.
      !String(d.marker).includes("+")
  );
  if (!relevant.length) return null;

  const index = buildMarkerPriorityIndex();
  const anchors: MarkerInterventionAnchor[] = [];
  const seen = new Set<string>();
  for (const d of relevant) {
    const marker = String(d.marker).trim().slice(0, 60);
    const markerKey = marker.toLowerCase();
    if (seen.has(markerKey)) continue;
    const snapshot = index.get(markerKey);
    // Prefer the directive's own trigger (the value/side when it was raised) as the true
    // baseline; fall back to the current snapshot when the directive didn't carry one.
    const side =
      d.trigger_side === "low" || d.trigger_side === "high"
        ? d.trigger_side
        : snapshot?.side === "low" || snapshot?.side === "high"
          ? snapshot.side
          : null;
    if (side !== "low" && side !== "high") continue; // no directional target we can falsify
    const baseline = isFiniteNumber(Number(d.trigger_value))
      ? Number(d.trigger_value)
      : isFiniteNumber(snapshot?.value)
        ? (snapshot!.value as number)
        : null;
    if (baseline == null) continue; // no baseline value -> the evaluator can't compute a delta
    seen.add(markerKey);
    anchors.push({
      marker,
      baseline_value: baseline,
      direction: side === "high" ? "decrease" : "increase",
      trigger_side: side,
      source: String(d.source),
      priority_rank: snapshot?.rank ?? Number.MAX_SAFE_INTEGER,
    });
  }
  if (!anchors.length) return null;
  anchors.sort((a, b) => a.priority_rank - b.priority_rank);
  const primary = anchors[0];
  const others = anchors.slice(1).map((a) => a.marker);
  // One lab draw = one evidence unit: suppress the expectation when an open same-marker+kind
  // anchor already awaits its outcome with no new reading since. The anchor still rides in meta.
  const deduped = openAnchorSuppresses(primary.marker, kind, domain);
  return {
    primary,
    others,
    expectation: deduped ? null : markerDirectionExpectation(primary, effectiveDate),
    meta: {
      anchored_marker: primary.marker,
      anchored_markers: anchors.map((a) => a.marker),
      trigger_side: primary.trigger_side,
      baseline_value: primary.baseline_value,
      directive_source: primary.source,
      ...(deduped ? { deduped: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Learned per-marker response — verdicts on the intervention-anchored expectations.
// ---------------------------------------------------------------------------

export interface MarkerResponsePattern {
  marker: string;
  domain: string; // nutrition | training
  intervention_label: string; // plain-language kind ("meal-plan tilt", "training change")
  verdict: "aligned" | "not_aligned";
  statement: string; // humble, correlation-framed, surfaced verbatim
  confidence: "tentative" | "observed";
  evidence_n: number;
  last_observed: string;
}

interface MarkerVerdictRow {
  kind: string;
  domain: string;
  subject_key: string;
  verdict: "aligned" | "not_aligned";
  evaluated_at: string;
  draw_key: string; // identity of the follow-up lab draw this verdict was measured against
}

// The follow-up marker draw a verdict was measured against — the LAST health_documents row in
// the evaluation window (stableEvidence encodes it as the trailing id in "…:ids=<first>-<last>").
// Same-draw duplicate expectations share that follow-up doc, so they collapse to one evidence
// unit; genuinely distinct draws land on different docs and stay separate. Falls back to the
// observed value, then the evaluation date, so a partial/legacy row still yields a stable key.
function drawKeyFor(evidenceJson: string | null, actualJson: string | null, evaluatedAt: string): string {
  try {
    const evidence = evidenceJson ? JSON.parse(evidenceJson) : null;
    const key = Array.isArray(evidence)
      ? evidence.find((k) => typeof k === "string" && k.startsWith("health_documents:"))
      : null;
    const match = key ? /:ids=[^:]*-([^:\s]+)$/.exec(key) : null;
    if (match?.[1] && match[1] !== "-") return `doc:${match[1]}`;
  } catch {
    // fall through to the value/date fallbacks
  }
  try {
    const actual = actualJson ? JSON.parse(actualJson) : null;
    const latest = Number(actual?.latest_value ?? actual?.value);
    if (Number.isFinite(latest)) return `val:${latest}`;
  } catch {
    // fall through to the date fallback
  }
  return `at:${String(evaluatedAt).slice(0, 10)}`;
}

function interventionLabel(kind: string): string {
  switch (kind) {
    case "meal_plan":
      return "meal-plan tilt";
    case "nutrition_target":
      return "nutrition change";
    case "training_structure":
    case "training_target":
    case "exercise_rotation":
      return "training change";
    default:
      return "change";
  }
}

// Latest decisive marker_direction verdicts on INTERVENTION decisions (applied plan/meal
// changes) — one row per expectation, most recent evaluation only, mirroring the
// reaction-model's evaluatedDecisionRows query. Null-safe for partial/imported DBs.
function markerVerdictRows(): MarkerVerdictRow[] {
  try {
    const placeholders = INTERVENTION_DECISION_KINDS.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT d.kind AS kind, d.domain AS domain, x.subject_key AS subject_key,
                e.verdict AS verdict, e.evaluated_at AS evaluated_at,
                e.evidence_json AS evidence_json, e.actual_json AS actual_json
           FROM brain_evaluations e
           JOIN brain_expectations x ON x.id = e.expectation_id
           JOIN brain_decisions d ON d.id = x.decision_id
          WHERE x.metric_key = 'marker_direction'
            AND d.kind IN (${placeholders})
            AND d.status = 'applied'
            AND e.id = (
              SELECT e2.id FROM brain_evaluations e2
               WHERE e2.expectation_id = e.expectation_id
               ORDER BY e2.id DESC LIMIT 1
            )
            AND e.verdict IN ('aligned','not_aligned')
          ORDER BY e.evaluated_at, e.id
          LIMIT 200`
      )
      .all(...INTERVENTION_DECISION_KINDS) as any[];
    return rows
      .map((row): MarkerVerdictRow => {
        const evaluated_at = String(row.evaluated_at ?? "").replace(" ", "T");
        return {
          kind: String(row.kind ?? ""),
          domain: String(row.domain ?? ""),
          subject_key: String(row.subject_key ?? "").trim(),
          verdict: row.verdict === "not_aligned" ? "not_aligned" : "aligned",
          evaluated_at,
          draw_key: drawKeyFor(row.evidence_json ?? null, row.actual_json ?? null, evaluated_at),
        };
      })
      .filter((row) => row.subject_key && row.evaluated_at);
  } catch {
    return [];
  }
}

// Bounded, deterministic learned patterns: for each marker touched by an applied
// intervention, the latest decisive verdict + how the same-kind intervention has fared.
// Humble correlation framing, never causal. At most 4, most-recent first.
export function learnedMarkerResponses(): MarkerResponsePattern[] {
  const rows = markerVerdictRows();
  if (!rows.length) return [];
  // Group by marker + intervention label so "the meal-plan tilt" and a "training change"
  // on the same marker learn separately.
  const groups = new Map<string, MarkerVerdictRow[]>();
  for (const row of rows) {
    const label = interventionLabel(row.kind);
    const key = `${row.subject_key.toLowerCase()}|${label}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const patterns: MarkerResponsePattern[] = [];
  for (const list of groups.values()) {
    const chronological = [...list].sort((a, b) => a.evaluated_at.localeCompare(b.evaluated_at));
    // Belt-and-suspenders for any legacy duplicates already persisted before the anchor-time
    // dedup: N verdicts sharing ONE follow-up draw are ONE outcome, so collapse to a single
    // unit (keep the latest) before counting evidence — a single draw can never reach 'observed'.
    const byDraw = new Map<string, MarkerVerdictRow>();
    for (const row of chronological) byDraw.set(row.draw_key, row); // later (chronological) wins
    const ordered = [...byDraw.values()].sort((a, b) => a.evaluated_at.localeCompare(b.evaluated_at));
    const latest = ordered[ordered.length - 1];
    const label = interventionLabel(latest.kind);
    // Confidence: how many of the most-recent evaluations agree with the latest verdict
    // (a repeated, uncontradicted result earns 'observed'; a single or freshly-flipped one
    // stays 'tentative'). No coefficient ever surfaces — only the WORD.
    let run = 0;
    for (let i = ordered.length - 1; i >= 0 && ordered[i].verdict === latest.verdict; i--) run++;
    const confidence: MarkerResponsePattern["confidence"] = run >= 2 ? "observed" : "tentative";
    const statement =
      latest.verdict === "aligned"
        ? `Last time, the ${label} coincided with ${latest.subject_key} moving toward optimal — worth repeating.`
        : `Last time, the ${label} didn't coincide with ${latest.subject_key} improving — a different tilt may be worth trying.`;
    patterns.push({
      marker: latest.subject_key,
      domain: latest.domain,
      intervention_label: label,
      verdict: latest.verdict,
      statement,
      confidence,
      evidence_n: ordered.length,
      last_observed: latest.evaluated_at,
    });
  }
  return patterns.sort((a, b) => b.last_observed.localeCompare(a.last_observed)).slice(0, 4);
}

// The single calm line surfaced (pull, never push) when a learned marker response exists.
// Optionally filtered to a domain and/or marker. Returns null when nothing has been
// learned yet — so the prompt stays silent rather than inventing a connection.
export function markerResponseCoachLine(opts: { domain?: string; marker?: string } = {}): string | null {
  const wantMarker = opts.marker ? String(opts.marker).trim().toLowerCase() : null;
  const wantDomain = opts.domain ? String(opts.domain).trim().toLowerCase() : null;
  const patterns = learnedMarkerResponses().filter(
    (p) =>
      (!wantDomain || p.domain.toLowerCase() === wantDomain) && (!wantMarker || p.marker.toLowerCase() === wantMarker)
  );
  return patterns.length ? patterns[0].statement : null;
}

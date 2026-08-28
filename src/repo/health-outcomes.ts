import { addInsight, isDuplicateInsight, listDirectives } from "./coach.js";
import {
  type InsightEvidenceEpoch,
  insightFacetForSurface,
  insightIntentCorpus,
  isDuplicateInsightIntent,
  resolveInsightIntent,
} from "./insight-intent.js";
import { brainDecisionFingerprint, recordDecision } from "./brain-decisions.js";
import { getMarkerHistory } from "./health.js";
import { canonicalMarker } from "./marker-canon.js";
import { markerValidityHorizons } from "./marker-validity.js";
import { addMemory } from "./memory.js";
import { capStr } from "./nutrition.js";
import { markerSide, matchOptimalZone, optimalDistance } from "./propagation-data.js";

export type HealthOutcome = "improving" | "unchanged" | "worsening";

export interface HealthOutcomeAnnotation {
  directive_id: number;
  directive_status: string;
  source: string | null;
  domain: string | null;
  marker: string;
  directive: string | null;
  trigger: {
    date: string;
    value: number;
    unit: string | null;
    side: string | null;
  };
  follow_up: {
    date: string;
    value: number;
    unit: string | null;
    flag: string | null;
  };
  outcome: HealthOutcome;
  delta: number;
  percent_change: number | null;
  in_optimal_now: boolean | null;
  summary: string;
  caveat: string;
  next_step: string;
}

export interface HealthOutcomeRead {
  annotations: HealthOutcomeAnnotation[];
  frame: string;
}

export interface RecordedHealthOutcomeRead extends HealthOutcomeRead {
  persisted: {
    insights: number;
    memories: number;
    // Brain-ledger observations written for the EVENT annotations (see
    // healthOutcomeEvents) — the falsifiable trail behind "this came back worse".
    observations: number;
  };
}

interface MarkerSeries {
  key?: string | null;
  name?: string | null;
  unit?: string | null;
  latest?: { value?: unknown; flag?: string | null; date?: string | null } | null;
  points?: Array<{ date?: string | null; value?: unknown; flag?: string | null }>;
}

interface Baseline {
  date: string;
  value: number;
}

function dateOnly(value: unknown): string | null {
  const s = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function folded(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function labelVariants(label: string): string[] {
  const out = new Set<string>();
  const raw = String(label ?? "").trim();
  if (raw) out.add(raw);
  for (const part of raw.split(/\s*\+\s*/).map((x) => x.trim()).filter(Boolean)) out.add(part);
  for (const value of [...out]) {
    const canon = canonicalMarker(value);
    if (canon?.name) out.add(canon.name);
    if (canon?.key) out.add(canon.key);
    const zone = matchOptimalZone(value);
    if (zone?.label) out.add(zone.label);
  }
  return [...out].filter(Boolean);
}

function seriesKeys(series: MarkerSeries): Set<string> {
  const out = new Set<string>();
  for (const value of [series.name, series.key]) {
    if (!value) continue;
    out.add(folded(value));
    const canon = canonicalMarker(String(value));
    out.add(folded(canon.name));
    out.add(folded(canon.key));
    const zone = matchOptimalZone(String(value));
    if (zone?.label) out.add(folded(zone.label));
  }
  return out;
}

function findSeries(marker: string, markers: MarkerSeries[]): MarkerSeries | null {
  const targets = new Set(labelVariants(marker).map(folded).filter(Boolean));
  if (!targets.size) return null;
  for (const series of markers) {
    const keys = seriesKeys(series);
    for (const target of targets) {
      if (keys.has(target)) return series;
    }
  }
  return null;
}

function baselineForDirective(directive: any, series: MarkerSeries): Baseline | null {
  const anchor = dateOnly(directive?.trigger_date) ?? dateOnly(directive?.created_at);
  if (!anchor) return null;
  const trigger = numeric(directive?.trigger_value);
  if (trigger != null) return { date: anchor, value: trigger };
  const prior = [...(series.points ?? [])]
    .filter((p) => {
      const date = dateOnly(p?.date);
      return date != null && date <= anchor && numeric(p?.value) != null;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .at(-1);
  const value = numeric(prior?.value);
  const date = dateOnly(prior?.date);
  return value != null && date ? { date, value } : null;
}

function latestFollowUp(series: MarkerSeries, afterDate: string): { date: string; value: number; flag: string | null } | null {
  const later = (series.points ?? [])
    .map((p) => ({ date: dateOnly(p?.date), value: numeric(p?.value), flag: p?.flag === "low" || p?.flag === "high" ? p.flag : null }))
    .filter((p): p is { date: string; value: number; flag: string | null } => p.date != null && p.date > afterDate && p.value != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  return later.at(-1) ?? null;
}

function meaningfulThreshold(baseline: number, series: MarkerSeries): number {
  const zone = matchOptimalZone(String(series.name ?? series.key ?? ""));
  const pct = Math.abs(baseline) * 0.03;
  const width = zone ? Math.max(0, zone.optimal[1] - zone.optimal[0]) * 0.05 : 0;
  return Math.max(pct, width, 0.01);
}

function classifyOutcome(directive: any, series: MarkerSeries, baseline: number, followUp: number): HealthOutcome | null {
  const zone = matchOptimalZone(String(series.name ?? directive?.marker ?? ""));
  let side = ["low", "high"].includes(String(directive?.trigger_side)) ? String(directive.trigger_side) : null;
  if (!side && zone) side = markerSide(baseline, zone, null);
  const threshold = meaningfulThreshold(baseline, series);
  let movement: number | null = null;
  if (side === "high") movement = baseline - followUp;
  else if (side === "low") movement = followUp - baseline;
  else if (zone) movement = optimalDistance(baseline, zone) - optimalDistance(followUp, zone);
  if (movement == null) return null;
  if (movement > threshold) return "improving";
  if (movement < -threshold) return "worsening";
  return "unchanged";
}

function inOptimal(series: MarkerSeries, value: number): boolean | null {
  const zone = matchOptimalZone(String(series.name ?? series.key ?? ""));
  if (!zone) return null;
  return optimalDistance(value, zone) === 0;
}

function valueText(value: number, unit: string | null): string {
  const rounded = Math.abs(value) >= 100 ? String(Math.round(value)) : String(round1(value));
  return `${rounded}${unit ? ` ${unit}` : ""}`;
}

function buildSummary(marker: string, directive: any, baseline: Baseline, followUp: { date: string; value: number }, unit: string | null, outcome: HealthOutcome): string {
  const domain = directive?.domain ? `${String(directive.domain)} directive` : "related directive";
  const phrase =
    outcome === "improving"
      ? "moved in the intended direction"
      : outcome === "worsening"
        ? "moved further from the intended direction"
        : "has not materially moved yet";
  return capStr(
    `${marker} changed from ${valueText(baseline.value, unit)} on ${baseline.date} to ${valueText(followUp.value, unit)} on ${followUp.date} after the ${domain}; it ${phrase}.`,
    320,
  ) ?? "";
}

function nextStep(outcome: HealthOutcome, inOptimalNow: boolean | null): string {
  if (outcome === "improving" && inOptimalNow) return "Consider marking the related directive resolved if the user and clinician agree the follow-up target is satisfied.";
  if (outcome === "improving") return "Keep this as a working lever and confirm on the next planned draw rather than changing everything at once.";
  if (outcome === "unchanged") return "Review timing, consistency, dose, absorption, or competing factors with a clinician before escalating the lever.";
  return "Treat this as a reason to discuss the plan with a clinician; Cairn should not intensify supplements or medications automatically.";
}

function annotationForDirective(directive: any, markers: MarkerSeries[]): HealthOutcomeAnnotation | null {
  if (!directive?.id || !directive?.marker) return null;
  const markerName = capStr(directive.marker, 120);
  if (!markerName) return null;
  const series = findSeries(markerName, markers);
  if (!series) return null;
  const baseline = baselineForDirective(directive, series);
  if (!baseline) return null;
  const followUp = latestFollowUp(series, baseline.date);
  if (!followUp) return null;
  const outcome = classifyOutcome(directive, series, baseline.value, followUp.value);
  if (!outcome) return null;
  const unit = series.unit == null ? null : String(series.unit).slice(0, 40) || null;
  const label = capStr(series.name ?? markerName, 120) ?? markerName;
  const delta = round2(followUp.value - baseline.value);
  const pct = baseline.value === 0 ? null : round2(((followUp.value - baseline.value) / Math.abs(baseline.value)) * 100);
  const optimalNow = inOptimal(series, followUp.value);
  return {
    directive_id: Number(directive.id),
    directive_status: String(directive.status ?? "active"),
    source: directive.source == null ? null : capStr(directive.source, 80),
    domain: directive.domain == null ? null : capStr(directive.domain, 40),
    marker: label,
    directive: directive.directive == null ? null : capStr(directive.directive, 180),
    trigger: {
      date: baseline.date,
      value: round2(baseline.value),
      unit,
      side: directive.trigger_side == null ? null : capStr(directive.trigger_side, 20),
    },
    follow_up: {
      date: followUp.date,
      value: round2(followUp.value),
      unit,
      flag: followUp.flag,
    },
    outcome,
    delta,
    percent_change: pct,
    in_optimal_now: optimalNow,
    summary: buildSummary(label, directive, baseline, followUp, unit, outcome),
    caveat: "This is a dated association, not proof that the intervention caused the marker change. Use it to frame the next clinician conversation.",
    next_step: nextStep(outcome, optimalNow),
  };
}

function annotationKey(a: HealthOutcomeAnnotation): string {
  return [
    a.directive_id,
    folded(a.marker),
    a.trigger.date,
    a.follow_up.date,
    a.outcome,
  ].join("|");
}

export function healthOutcomeAnnotations(limit = 30): HealthOutcomeRead {
  const markers = (getMarkerHistory() as { markers: MarkerSeries[] }).markers ?? [];
  const directives = listDirectives({ all: true }) as any[];
  const seen = new Set<string>();
  const annotations: HealthOutcomeAnnotation[] = [];
  for (const directive of directives) {
    const annotation = annotationForDirective(directive, markers);
    if (!annotation) continue;
    const key = annotationKey(annotation);
    if (seen.has(key)) continue;
    seen.add(key);
    annotations.push(annotation);
  }
  annotations.sort((a, b) => {
    if (a.follow_up.date !== b.follow_up.date) return b.follow_up.date.localeCompare(a.follow_up.date);
    return b.directive_id - a.directive_id;
  });
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  return {
    annotations: annotations.slice(0, n),
    frame: "Informational, not medical advice. Outcome annotations compare follow-up marker readings after a prior directive/intervention anchor; they describe direction, not causation, and never auto-apply a change.",
  };
}

export function recordHealthOutcomeAnnotations(limit = 12): RecordedHealthOutcomeRead {
  const read = healthOutcomeAnnotations(limit);
  let insights = 0;
  let memories = 0;
  // The pull read also lays down the EVENT trail, so a user-triggered outcome read and
  // the automatic post-ingest pass leave the same ledger. Fingerprint-idempotent.
  const observations = recordHealthOutcomeEvents().observations;
  // The same territory guard the agentic pass uses (src/repo/insight-intent.ts), so
  // an outcome annotation can't re-say a connection either producer already made.
  // These summaries are deterministic and marker-anchored, so derivation is the
  // reliable path here — there is no agent to name a connection object. Newly stored
  // keys join the corpus in-loop, so two annotations on one territory don't both land.
  const keyCorpus = insightIntentCorpus().keys;
  for (const annotation of read.annotations.slice(0, Math.max(1, Math.min(20, Number(limit) || 12)))) {
    const text = annotation.summary;
    const intent = resolveInsightIntent(null, text, annotation.caveat);
    if (text && !isDuplicateInsightIntent(intent.key, keyCorpus) && !isDuplicateInsight(text)) {
      const row = addInsight({
        kind: "health_outcome",
        text,
        rationale: annotation.caveat,
        next_step: annotation.next_step,
        status: "new",
        intent_key: intent.key,
      });
      if (row) {
        insights++;
        if (intent.key) keyCorpus.push(intent.key);
      }
    }
    const memory = addMemory(`${annotation.marker} outcome: ${annotation.summary}`, "learning", "health-outcome");
    if (memory) memories++;
  }
  return { ...read, persisted: { insights, memories, observations } };
}

// ---------------------------------------------------------------------------
// "worse than last time" is an EVENT  (owner ruling R1)
// ---------------------------------------------------------------------------
//
// An outcome annotation is a pull-only read: it describes what a follow-up draw did
// to a marker a directive was anchored on. Most of those readings are unremarkable.
// TWO are events — the panel came back WORSENING, or it came back UNCHANGED after the
// marker's own recheck window had already elapsed, which is the lever having had its
// chance and not taken it. An event is allowed to leave a visible artifact: a brain
// observation in the ledger, and (via healthOutcomeEvidenceEpochs) permission for the
// insight layer to speak about that territory again.
//
// Everything here stays INFORMATIONAL. Nothing changes a plan, a dose, or a target.

export type HealthOutcomeEventReason = "worsening" | "unchanged_past_recheck";

export interface HealthOutcomeEvent {
  annotation: HealthOutcomeAnnotation;
  reason: HealthOutcomeEventReason;
}

function daysApart(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// Which annotations are events, and why. The recheck window is the marker's OWN
// per-class horizon (src/repo/marker-validity.ts) — never a hardcoded number of
// months — so a lipid panel, an acute-phase reactant and a DEXA each get the cadence
// their class actually has.
export function healthOutcomeEventReason(
  annotation: HealthOutcomeAnnotation
): HealthOutcomeEventReason | null {
  if (String(annotation.directive_status) === "dismissed") return null; // waved off by the athlete
  if (annotation.outcome === "worsening") return "worsening";
  if (annotation.outcome !== "unchanged") return null;
  const span = daysApart(annotation.trigger.date, annotation.follow_up.date);
  if (span == null) return null;
  return span >= markerValidityHorizons(annotation.marker).note_days ? "unchanged_past_recheck" : null;
}

export function healthOutcomeEvents(limit = 60): HealthOutcomeEvent[] {
  const out: HealthOutcomeEvent[] = [];
  for (const annotation of healthOutcomeAnnotations(limit).annotations) {
    const reason = healthOutcomeEventReason(annotation);
    if (reason) out.push({ annotation, reason });
  }
  return out;
}

// The bridge into the insight layer's territorial dedupe: one dated epoch per FACET,
// carrying the newest event draw date on it. `at` is the follow-up reading's own date,
// never "now" — an insight said after that draw already knew about it and stays deduped.
export function healthOutcomeEvidenceEpochs(limit = 60): InsightEvidenceEpoch[] {
  const latest = new Map<string, string>();
  for (const { annotation } of healthOutcomeEvents(limit)) {
    const facet = insightFacetForSurface(annotation.marker)?.facet;
    if (!facet) continue;
    const at = String(annotation.follow_up.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) continue;
    const seen = latest.get(facet);
    if (!seen || at > seen) latest.set(facet, at);
  }
  return [...latest.entries()].map(([facet, at]) => ({ facet, at }));
}

function eventSourceRef(annotation: HealthOutcomeAnnotation): string {
  const marker = folded(annotation.marker).replace(/ /g, "-") || "marker";
  return `outcome:${annotation.directive_id}:${marker}:${annotation.follow_up.date}`.slice(0, 120);
}

// Record the event trail. Uses the SAME clinical lane the directive ledger already
// uses (kind 'health_directive', clinician tier, observed status, never reversible) —
// the event is named in `context.event` / `action.outcome` rather than by widening the
// shared decision-kind vocabulary. The fingerprint carries the marker, both readings
// and the reason, so re-running after every document in one upload batch is idempotent
// while a genuinely newer draw becomes a genuinely new row.
export function recordHealthOutcomeEvents(limit = 60): {
  events: HealthOutcomeEvent[];
  observations: number;
} {
  const events = healthOutcomeEvents(limit);
  let observations = 0;
  for (const { annotation, reason } of events) {
    try {
      const domain =
        annotation.domain === "training" ? "training" : annotation.domain === "nutrition" ? "nutrition" : "health";
      recordDecision({
        effective_date: annotation.follow_up.date,
        kind: "health_directive",
        domain,
        summary: capStr(annotation.summary, 300) ?? `${annotation.marker} outcome`,
        rationale: annotation.caveat,
        source: "health_outcome",
        source_ref_type: "directive",
        source_ref_key: eventSourceRef(annotation),
        status: "observed",
        autonomy_tier: "clinician",
        risk_class: "clinical",
        reversible: false,
        input_fingerprint: brainDecisionFingerprint({
          event: "health_outcome",
          directive_id: annotation.directive_id,
          marker: folded(annotation.marker),
          trigger: [annotation.trigger.date, annotation.trigger.value],
          follow_up: [annotation.follow_up.date, annotation.follow_up.value],
          outcome: annotation.outcome,
          reason,
        }),
        context: {
          event: "health_outcome",
          reason,
          outcome: annotation.outcome,
          directive_id: annotation.directive_id,
          directive_status: annotation.directive_status,
          marker: annotation.marker,
          trigger_value: annotation.trigger.value,
          trigger_date: annotation.trigger.date,
          follow_up_value: annotation.follow_up.value,
          follow_up_date: annotation.follow_up.date,
          delta: annotation.delta,
          percent_change: annotation.percent_change,
          in_optimal_now: annotation.in_optimal_now,
        },
        action: { outcome: annotation.outcome, reason, next_step: annotation.next_step },
        specialist: null,
        applied_at: null,
        reverted_at: null,
        superseded_by: null,
        evaluator_version: null,
      });
      observations++;
    } catch {
      // The outcome read is authoritative; the audit trail is best effort — the same
      // posture recordActiveDirectiveDecisions takes in src/repo/propagation.ts.
    }
  }
  return { events, observations };
}

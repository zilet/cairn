import { db } from "../db.js";
import { type ContextEffect, activeContextEffect, markerInTransientWindow } from "./context-effect.js";
import { DIRECTIVE_DOMAINS, addDirective, clearDirectivesForSource, defaultDirectiveKey, hydrateDirective, listActiveDirectives, normalizeDirectiveKey } from "./coach.js";
import { buildSafetyMarkerContext, safetyGate, verifyCitation } from "./evidence.js";
import { activeMedications, forecastMarker, getMarkerHistory, lsqSlopePerDay } from "./health.js";
import { invalidateDayRead } from "./intelligence.js";
import { canonicalMarker } from "./marker-canon.js";
import { getProfile, listWeight } from "./profile.js";
import {
  type MappingDirective,
  type MarkerContext,
  type OptimalZone,
  type ZoneProfile,
  MARKER_MAPPINGS,
  markerGroup,
  markerSide,
  matchOptimalZone,
  medsTreatingZone,
  optimalDistance,
  presentGroups,
} from "./propagation-data.js";

// The sex/age snapshot the connected-brain paths thread into matchOptimalZone so a
// woman / older adult isn't held to the male/generic default band. Null-safe: an
// empty profile (fresh DB) yields the default, so nothing behaves differently until
// the athlete records their sex/age.
function zoneProfile(): ZoneProfile | null {
  try {
    const p = getProfile();
    return p ? { sex: p.sex ?? null, age: p.age ?? null } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// This module is the connected-brain ENGINE: marker prioritization, the
// directive-propagation engine + cross-marker clusters, acute-directive
// freshness, and the coach-facing condensations. The pure static data tables
// it reads (optimal zones, the marker→directive mappings, the group taxonomy)
// live in ./propagation-data.js; supplements, the FHIR-ish health export, and
// the health-focus synthesis substrate live in their own sibling modules.
// Everything is re-exported here so `./repo/propagation.js` keeps its full
// public surface unchanged (repo.ts and many repo modules import from it).
// ---------------------------------------------------------------------------
export {
  MARKER_MAPPINGS,
  OPTIMAL_ZONES,
  cystatinHighBound,
  dheasBand,
  egfrLowBound,
  isNonClinicalMarker,
  markerGroup,
  markerSide,
  matchOptimalZone,
  medsTreatingZone,
  optimalDistance,
  personalizeZone,
  presentGroups,
  psaHighBound,
} from "./propagation-data.js";
export type { OptimalZone, ZoneProfile } from "./propagation-data.js";
export * from "./supplements.js";
export * from "./health-export.js";
export * from "./health-focus.js";

// ============================================================================
// THE CONNECTED BRAIN — marker prioritization + the propagation engine (T4).
// ============================================================================

// Impact-Score ranking over the latest marker readings. Returns the same marker
// objects as getMarkerHistory plus { optimal, distance, in_optimal, actionable,
// impact_score } — most-actionable, furthest-from-optimal first. `flagged_count`
// counts markers the lab flagged low/high. Red-first stays the top-level sort
// (any low/high-flagged marker outranks an in-flag one); within each tier the
// Impact-Score orders most-actionable first.
//
// impact_score is an INTERNAL ordering signal ONLY — never surface it to the
// user as a 0-100 grade (the constitution bans those). The UI shows optimal-zone
// framing (in/out of optimal, the direction), never the number.
// Wearable-derived endurance/fitness markers (v35) as TRENDING marker series, so
// VO2max / resting HR / HRV flow into the SAME connected-brain surfaces as labs
// (priority ranking, trend, forecast, directives) — optimal-ZONE framing only,
// never a score. Built deterministically from the recovery tables: VO2max + a
// distinct daily resting-HR / HRV reading per day (most recent N days). Returns
// marker objects shaped exactly like getMarkerHistory's (key/name/unit/group/
// latest/prev/trend/forecast/points) so prioritizeMarkers can treat them uniformly.
// Empty when there's no wearable data — never throws.
function wearableFitnessMarkers(days = 120): any[] {
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);
  // Each spec: the marker label + the daily-metrics column it reads (Garmin
  // preferred, daily_metrics fallback), and a sane plausibility clamp.
  const specs: { label: string; gCol: string; oCol: string | null; unit: string; lo: number; hi: number }[] = [
    { label: "VO2max", gCol: "vo2max", oCol: null, unit: "mL/kg/min", lo: 15, hi: 90 },
    { label: "Resting HR", gCol: "resting_hr", oCol: "resting_hr", unit: "bpm", lo: 25, hi: 120 },
    { label: "HRV", gCol: "hrv_ms", oCol: "hrv_ms", unit: "ms", lo: 5, hi: 300 },
  ];
  const out: any[] = [];
  for (const spec of specs) {
    // One reading per day: prefer Garmin's value, else the source-agnostic one.
    const byDate = new Map<string, number>();
    const g = db.prepare(
      `SELECT date, ${spec.gCol} AS v FROM garmin_daily_metrics WHERE date >= ? AND ${spec.gCol} IS NOT NULL ORDER BY date`
    ).all(since) as any[];
    for (const r of g) {
      const v = Number(r.v);
      if (Number.isFinite(v) && v >= spec.lo && v <= spec.hi) byDate.set(String(r.date), v);
    }
    if (spec.label === "VO2max") {
      const activityRows = db.prepare(
        `SELECT date, vo2max AS v FROM garmin_activities
         WHERE date >= ? AND vo2max IS NOT NULL
         ORDER BY date, id`
      ).all(since) as any[];
      for (const r of activityRows) {
        const date = String(r.date);
        if (byDate.has(date)) continue;
        const v = Number(r.v);
        if (Number.isFinite(v) && v >= spec.lo && v <= spec.hi) byDate.set(date, v);
      }
    }
    if (spec.oCol) {
      const o = db.prepare(
        `SELECT date, ${spec.oCol} AS v FROM daily_metrics WHERE date >= ? AND ${spec.oCol} IS NOT NULL ORDER BY date`
      ).all(since) as any[];
      for (const r of o) {
        const date = String(r.date);
        if (byDate.has(date)) continue; // Garmin already supplied this day
        const v = Number(r.v);
        if (Number.isFinite(v) && v >= spec.lo && v <= spec.hi) byDate.set(date, v);
      }
    }
    if (!byDate.size) continue;
    const points = [...byDate.entries()]
      .map(([date, value]) => ({ date, value: Math.round(value * 10) / 10, flag: null as null, doc_id: null as null }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = points[points.length - 1];
    const before = points.length > 1 ? points[points.length - 2] : null;
    const zone = matchOptimalZone(spec.label);
    const slope = lsqSlopePerDay(points);
    const n = points.length;
    let trend: any;
    if (n < 2) {
      trend = { dir: null, change: null, span_days: null, n, slope_per_week: null, projection: null };
    } else {
      const change = Math.round((last.value - points[0].value) * 100) / 100;
      const vals = points.map((p) => p.value);
      const range = Math.max(...vals) - Math.min(...vals);
      const span_days = Math.round((Date.parse(last.date) - Date.parse(points[0].date)) / 864e5) || 0;
      const weekly = slope != null ? slope * 7 : null;
      const projectedMove = slope != null ? Math.abs(slope) * Math.max(1, span_days) : 0;
      const dir = weekly == null
        ? (range > 0 && Math.abs(change) < range * 0.05 ? "stable" : change > 0 ? "rising" : change < 0 ? "falling" : "stable")
        : projectedMove < Math.max(range * 0.05, 1e-9) ? "stable" : weekly > 0 ? "rising" : weekly < 0 ? "falling" : "stable";
      const fc = forecastMarker(points, slope, zone);
      trend = { dir, change, span_days, n, slope_per_week: weekly == null ? null : Math.round(weekly * 1000) / 1000, projection: fc.eta_text };
    }
    const grp = markerGroup(spec.label);
    out.push({
      key: spec.label.toLowerCase(),
      name: spec.label,
      unit: spec.unit,
      group: grp.key,
      group_label: grp.label,
      source: "wearable", // provenance hint — these are device-derived, not a lab draw
      latest: { value: last.value, flag: null, date: last.date, doc_id: null, kind: "wearable" },
      prev: before ? { value: before.value, date: before.date } : null,
      trend,
      forecast: forecastMarker(points, slope, zone),
      points,
    });
  }
  return out;
}

// Identity for the wearable/lab fold: the CANONICAL optimal-zone label, not the
// literal marker key. A lab "VO2 Max" canonicalizes to key "vo2 max" while the
// wearable spec emits "vo2max" — keying the dedup on the raw key let BOTH through
// and propagated two "VO2max below optimal" directives. Collapsing on the zone
// label ("VO2max") makes a lab + wearable reading of the same analyte one marker.
// Falls back to the lowercased key when there's no optimal zone to anchor on.
function foldIdentity(m: any): string {
  const z = matchOptimalZone(m?.name);
  return (z ? z.label : String(m?.key ?? m?.name ?? "")).toLowerCase();
}

export function prioritizeMarkers() {
  const { markers: labMarkers } = getMarkerHistory();
  // Fold in wearable fitness markers (VO2max/RHR/HRV) — a LAB reading of the same
  // marker always wins (a blood/test draw supersedes a device estimate). Dedup on
  // the canonical zone label so a lab + wearable VO2max don't BOTH come through.
  const haveKey = new Set(labMarkers.map((m: any) => foldIdentity(m)));
  const wearable = wearableFitnessMarkers().filter((m) => !haveKey.has(foldIdentity(m)));
  const markers = [...labMarkers, ...wearable];
  const profile = zoneProfile(); // personalizes the sex/age-dependent optimal bands
  let flagged_count = 0;
  const enriched = markers.map((m: any) => {
    const flagged = m?.latest?.flag === "low" || m?.latest?.flag === "high";
    if (flagged) flagged_count++;
    const z = matchOptimalZone(m?.name, profile);
    const numericVal = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    const hasNum = Number.isFinite(numericVal);
    const comparable = m?.latest?.unit_mismatch !== true;
    let distance = 0;
    let in_optimal: boolean | null = null;
    let optimal: { low: number; high: number; dir: string } | null = null;
    if (z && comparable) {
      optimal = { low: z.optimal[0], high: z.optimal[1], dir: z.dir };
      if (hasNum) {
        distance = optimalDistance(numericVal, z);
        in_optimal = distance === 0;
      }
    }
    const actionable = z ? z.actionable : false;
    // TRAJECTORY boost: a marker HEADING the wrong way matters more than one
    // sitting stably borderline. The forecast (from getMarkerHistory, vs the
    // OPTIMAL band) tells us direction + whether it's projected to cross an edge,
    // and eta_weeks (INTERNAL only — never surfaced) sharpens "how soon".
    const fc: any = m?.forecast ?? {};
    let trajectory = 0;
    if (fc.direction === "worsening") {
      // Worsening always counts; a near-term projected crossing (within ~12 weeks)
      // out of — or further from — optimal is the strongest pull.
      trajectory = 0.35;
      if (fc.crossing === "leaving") trajectory = 0.7; // inside now, projected to exit optimal
    } else if (fc.direction === "improving") {
      // Genuinely improving earns a small discount — it needs less attention.
      trajectory = -0.15;
    }
    // Impact-Score: distance from optimal (the real signal) weighted up when we
    // have a lever for it, a floor from the lab's own flag, and the trajectory
    // nudge so a marker drifting the wrong way outranks a stable borderline one.
    const impact_score = Math.max(0, distance * (actionable ? 1 : 0.55) + (flagged ? 0.5 : 0) + trajectory);
    return { ...m, optimal, distance, in_optimal, actionable, impact_score };
  });

  enriched.sort((a: any, b: any) => {
    const af = a?.latest?.flag === "low" || a?.latest?.flag === "high" ? 0 : 1;
    const bf = b?.latest?.flag === "low" || b?.latest?.flag === "high" ? 0 : 1;
    if (af !== bf) return af - bf;
    if (b.impact_score !== a.impact_score) return b.impact_score - a.impact_score;
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
  });

  // enriched carries group/group_label/trend via `...m` from getMarkerHistory;
  // recompute the present-groups list in canonical order off the enriched set.
  // Strip the INTERNAL impact_score before it crosses the API/MCP boundary — it's
  // an ordering signal only, NEVER a user-facing grade (constitution: no scores).
  // Mirrors the eta_weeks→eta_text discipline used by getMarkerHistory.
  const publicMarkers = enriched.map(({ impact_score, ...rest }: any) => rest);
  return { flagged_count, markers: publicMarkers, groups: presentGroups(publicMarkers) };
}

// ---------- the propagation engine: derive cross-domain directives (T4) ----------
// Helper: a value is "actionably off" when it's flagged low/high OR sits outside
// its optimal band the worse way.
// Takes the (already profile-personalized) zone object rather than re-looking it up
// by label, so the off-optimal test uses the SAME sex/age-adjusted band the caller
// matched against — not the static male default.
function offOptimal(value: number, zone: OptimalZone | null, flag: string | null): boolean {
  if (flag === "low" || flag === "high") return true;
  if (!zone || !Number.isFinite(value)) return false;
  return optimalDistance(value, zone) > 0;
}

function mappingDirectiveKey(zoneLabel: string, d: MappingDirective): string | null {
  return normalizeDirectiveKey(`${zoneLabel}:${d.domain}:${d.key || d.directive}`);
}

// The plain-language med-interaction clause folded into a directive when the user is
// already on a medication that targets this marker in the direction it's off — so the
// coaching reasons WITH the treatment (dose/adherence/add-on with the doctor) rather
// than treating them as untreated. INFORMATIONAL, never a prescription.
function medInteractionClause(zoneLabel: string, side: MarkerContext["side"], treating: { label: string; names: string[] }): string {
  const sideWord = side === "low" ? "below" : "above";
  const names = treating.names.join(", ");
  return `You're already on ${names} for this, so with ${zoneLabel} still ${sideWord} optimal the highest-leverage step is usually revisiting the dose, adherence, or an add-on with your doctor — not lifestyle change alone.`;
}

function lastDirectiveFeedback(source: string, marker: string | null, domain: string, directiveKey: string | null) {
  if (!directiveKey) return null;
  return hydrateDirective(db.prepare(
    `SELECT * FROM health_directives
     WHERE source = ? AND (marker = ? OR (marker IS NULL AND ? IS NULL)) AND domain = ? AND directive_key = ?
       AND status IN ('resolved', 'dismissed')
       AND status_at IS NOT NULL
     ORDER BY COALESCE(status_at, created_at) DESC, id DESC
     LIMIT 1`
  ).get(source, marker, marker, domain, directiveKey) ?? null);
}

function overageForSide(value: number, zone: OptimalZone, side: MarkerContext["side"]): number {
  if (!Number.isFinite(value)) return 0;
  if (side === "low") return Math.max(0, zone.optimal[0] - value);
  if (side === "high") return Math.max(0, value - zone.optimal[1]);
  return optimalDistance(value, zone) * Math.max(zone.optimal[1] - zone.optimal[0], 1) * 3;
}

function markerMateriallyWorse(feedback: any, ctx: MarkerContext): boolean {
  if (!feedback) return false;
  const oldSide = String(feedback.trigger_side || "unknown");
  if (oldSide !== ctx.side) return true;
  const oldValue = Number(feedback.trigger_value);
  if (!Number.isFinite(oldValue)) return true;
  const width = Math.max(ctx.zone.optimal[1] - ctx.zone.optimal[0], 1);
  const oldOver = overageForSide(oldValue, ctx.zone, ctx.side);
  const newOver = overageForSide(ctx.value, ctx.zone, ctx.side);
  const threshold = Math.max(width * 0.1, Math.abs(oldValue) * 0.05, 1);
  return newOver > oldOver + threshold;
}

function shouldSuppressDirective(feedback: any, ctx: MarkerContext): boolean {
  if (!feedback) return false;
  if (feedback.status === "dismissed") return !markerMateriallyWorse(feedback, ctx);
  if (feedback.status === "resolved") {
    const oldDate = String(feedback.trigger_date || "");
    const newDate = String(ctx.marker?.latest?.date || "");
    return !newDate || oldDate === newDate;
  }
  return false;
}

// THE PROPAGATION ENGINE. A flagged/sub-optimal biomarker propagates into every
// domain it touches — nutrition, training and watch — grounded in reputable
// guideline citations where the lever is well-established, flagged uncertain
// (citation null) where the mapping is real but not settled. Idempotent: clears
// the 'markers' source then re-derives, so directives never pile up across runs.
// Leaves the 'health_review' source untouched. INFORMATIONAL, not medical advice.
// Return shape kept as { source:'markers', derived, directives } for back-compat.
export function deriveDirectives() {
  const SOURCE = "markers";
  clearDirectivesForSource(SOURCE);
  const { markers } = prioritizeMarkers();
  const profile = zoneProfile(); // sex/age-personalized optimal bands (null-safe default)
  let saved = 0;
  // Collect every off-optimal marker as we go — the cluster layer (below) reads
  // this to make markers COMPOUND into one read instead of firing in isolation.
  const offMarkers = new Map<string, MarkerContext>();
  // Dedup within the run: the SAME zone can be reached by several marker entries
  // (name variants like "Glucose" / "Fasting Glucose", or repeat lab rows), which
  // would otherwise emit the identical directive once per entry. A directive is
  // about the zone+domain, so the first (highest-priority) one wins; the rest are
  // skipped. markers are sorted flagged-first then impact-desc, so first == most
  // significant.
  const seen = new Set<string>();
  // Active medications, read ONCE — so the brain can reason WITH a treatment (a marker
  // still off-optimal despite a med that targets it is a dose/adherence conversation,
  // not a naive lifestyle nudge). Empty when no uploaded record carries a med list.
  const meds = (() => { try { return activeMedications(); } catch { return []; } })();
  for (const m of markers) {
    const z = matchOptimalZone(m?.name, profile);
    if (!z) continue;
    const numericVal = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    if (!Number.isFinite(numericVal)) continue;
    const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
    const comparable = m?.latest?.unit_mismatch !== true;
    if (!comparable && !flag) continue;
    if (comparable && !offOptimal(numericVal, z, flag)) continue;
    const ctx: MarkerContext = { value: numericVal, flag, zone: z, side: markerSide(numericVal, z, flag), marker: m };
    if (!offMarkers.has(z.label)) offMarkers.set(z.label, ctx);
    const mapping = MARKER_MAPPINGS.find((x) => x.zone === z.label);
    if (!mapping) continue;
    const derived = mapping.derive(ctx);
    // Med-aware augmentation: if the user is already on a med that targets THIS zone in
    // the direction it's off, fold a "still off despite <med> → discuss dose/adherence"
    // clause into ONE directive (the `watch` one — its "discuss with your doctor" framing
    // fits best — else the first), so the set reasons WITH the treatment instead of
    // repeating the note across domains. It stays the SAME directive (same key), so it
    // never adds a row or trips the read-time collapse. INFORMATIONAL, flagged uncertain.
    const treating = meds.length ? medsTreatingZone(z.label, ctx.side, meds) : null;
    let medAugmentIdx = -1;
    if (treating) {
      medAugmentIdx = derived.findIndex((d) => d.domain === "watch");
      if (medAugmentIdx < 0) medAugmentIdx = 0;
    }
    for (let i = 0; i < derived.length; i++) {
      const d = derived[i];
      const directive_key = mappingDirectiveKey(z.label, d);
      if (directive_key && seen.has(directive_key)) continue; // already emitted this zone+domain directive this run
      const feedback = lastDirectiveFeedback(SOURCE, z.label, d.domain, directive_key);
      if (shouldSuppressDirective(feedback, ctx)) continue;
      const augment = !!treating && i === medAugmentIdx;
      const row = addDirective({
        source: SOURCE,
        domain: d.domain,
        marker: z.label,
        directive_key,
        directive: augment ? `${d.directive} ${medInteractionClause(z.label, ctx.side, treating!)}` : d.directive,
        rationale: d.rationale,
        citation: d.citation ?? null,
        uncertain: d.uncertain || !d.citation || augment,
        trigger_value: numericVal,
        trigger_side: ctx.side,
        trigger_date: m?.latest?.date ?? null,
        resurfaced_from_id: feedback?.id ?? null,
        status: "active",
      });
      if (row) { saved++; if (directive_key) seen.add(directive_key); }
    }
  }

  // ---- generic long-tail fallback ----
  // The mapped loop above only fires for the ~37 analytes with BOTH an optimal zone
  // AND a MARKER_MAPPINGS lever. A lab-FLAGGED marker outside that set (potassium,
  // ALP, PSA, WBC, cortisol, calcium, lipase, …) would otherwise propagate NOTHING —
  // so each is surfaced as ONE soft, clearly-uncertain `watch` note, so nothing the
  // lab flagged goes unnoticed. Informational, never a mapped lever.
  saved += deriveGenericLongTail(SOURCE, markers, seen, profile);

  // ---- cross-marker synthesis (the cluster layer) ----
  // Some findings only make sense TOGETHER: ApoB + Lp(a) + hs-CRP is one
  // elevated-cardiovascular-risk story, not three; low ferritin + low hemoglobin
  // + a low/altered MCV is an anemia PATTERN, not three loose flags. These fire
  // ONE synthesized directive when the cluster is genuinely present, so the brain
  // reasons across markers instead of repeating itself. Still INFORMATIONAL.
  saved += deriveMarkerClusters(SOURCE, offMarkers, seen, profile);

  // Directives just changed → today's cached Brief is stale. Invalidate HERE (the one
  // place every directive change flows through) rather than at each caller — so every
  // path that re-derives (lab ingest, /directives/derive, chat log_health, a doc-date
  // edit, MCP add_health_record) refreshes the read with no per-caller bookkeeping.
  try { invalidateDayRead(); } catch { /* cache bust is best-effort, never block */ }
  return { source: SOURCE, derived: saved, directives: listActiveDirectives() };
}

// Cluster definitions: each names the off-optimal zones (and required sides) that
// together tell one story, plus the synthesized directive. Fires only when the
// cluster's threshold of members is met. The directive_key is namespaced
// ("cluster:<name>:<domain>") so the feedback/suppression machinery treats it
// like any other directive (Done/Dismiss memory still works).
interface MarkerCluster {
  name: string;
  // members: zone label → the side that counts toward the cluster (null = any off side)
  members: { label: string; side?: "low" | "high" }[];
  minHits: number;
  build: (hits: { label: string; ctx: MarkerContext }[]) => MappingDirective[];
}

const MARKER_CLUSTERS: MarkerCluster[] = [
  {
    name: "elevated-cardiovascular-risk",
    members: [
      { label: "ApoB", side: "high" },
      { label: "LDL-C", side: "high" },
      { label: "Non-HDL-C", side: "high" },
      { label: "Lp(a)", side: "high" },
      { label: "hs-CRP", side: "high" },
      { label: "Triglycerides", side: "high" },
    ],
    minHits: 2,
    build: (hits) => {
      const names = hits.map((h) => h.label).join(" + ");
      const hasLpa = hits.some((h) => h.label === "Lp(a)");
      const lpaNote = hasLpa
        ? " Lp(a) is largely genetic and won't move with diet, which makes pushing the modifiable markers (ApoB/LDL) toward optimal matter even more."
        : "";
      return [
        { domain: "watch", directive: `Several cardiovascular markers are elevated together (${names}) — read as one elevated-risk picture, not separate flags. This is the highest-leverage area to address; discuss the combined picture with your doctor.${lpaNote}`, rationale: "Multiple atherogenic / inflammatory markers off-optimal at once compound cardiovascular risk beyond any single value.", citation: "ACC/AHA 2018 Cholesterol Guideline; ESC/EAS 2019 Dyslipidaemia" },
        { domain: "nutrition", directive: "Because several heart markers are elevated together, make the lipid-lowering pattern the priority: cut saturated fat, raise soluble fiber (oats, legumes, psyllium), favor oily fish and olive oil, and trim refined carbs/alcohol.", rationale: "One coherent anti-atherogenic, anti-inflammatory dietary pattern moves this whole cluster at once.", citation: "ACC/AHA 2018 Cholesterol Guideline" },
        { domain: "training", directive: "Keep regular aerobic work in the week — it helps the whole cardiovascular cluster (lipids, inflammation, blood pressure) at once.", rationale: "Aerobic exercise is a shared lever across the atherogenic/inflammatory markers in this cluster.", citation: "ACC/AHA 2018 Cholesterol Guideline", uncertain: true },
      ];
    },
  },
  // The anemia PATTERN (ferritin + hemoglobin + MCV) needs cross-marker reads
  // that aren't all in OPTIMAL_ZONES, so it's handled by buildAnemiaCluster()
  // rather than this declarative table.
];

// Max generic long-tail watch notes per derive — keeps a huge/garbage panel from
// flooding the list. markers arrive flagged-first then impact-desc, so the cap keeps
// the most significant flags.
const MAX_GENERIC_DIRECTIVES = 12;

// Clinical groups whose whole story is ALREADY told end-to-end by the mapping +
// cluster layer, so a flagged marker in them must NOT ALSO spawn a standalone generic
// `watch` note. Today that's Lipids & Cardiovascular: the ApoB / LDL-C / Non-HDL-C /
// Triglycerides / HDL-C / Total-cholesterol MARKER_MAPPINGS plus the
// elevated-cardiovascular-risk cluster cover the panel completely. Without this guard,
// a real lipid panel's dozen sub-fraction / ratio / composite names (LDL Small/Medium/
// Peak Size/Particle Number, "Total Cholesterol / HDL Ratio", …) each fall through
// matchOptimalZone (zoneNameTrustworthy rightly refuses to map a subfraction/ratio to a
// serum band) and would pile ~10 noise rows on top of the mapped directives — turning
// one lipid story into a wall of flags. Group-based (via the shared markerGroup taxonomy)
// rather than a hardcoded name list, so it stays principled and generalizes.
const GROUPS_FULLY_MODELED_BY_MAPPINGS = new Set(["lipids"]);
function groupFullyModeledByMappings(name: string): boolean {
  return GROUPS_FULLY_MODELED_BY_MAPPINGS.has(markerGroup(name).key);
}

// One soft `watch` note per lab-FLAGGED marker that has no mapped lever, so a flagged
// analyte Cairn doesn't model (potassium, ALP, PSA, WBC, cortisol, calcium, lipase, …)
// still surfaces instead of vanishing. Always uncertain:true (no established lever) and
// respects the same dismiss/resolve feedback memory as the mapped path.
function deriveGenericLongTail(source: string, markers: any[], seen: Set<string>, profile?: ZoneProfile | null): number {
  let saved = 0;
  let emitted = 0;
  for (const m of markers) {
    if (emitted >= MAX_GENERIC_DIRECTIVES) break;
    const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
    if (!flag) continue; // generic fallback fires ONLY on an explicit lab flag
    // A marker in a group the mapping/cluster layer already models end-to-end (lipids)
    // must not ALSO emit a standalone generic note — that's the lipid-panel noise
    // blow-up. Skip the whole group; the mapped + cluster directives tell its story.
    if (groupFullyModeledByMappings(String(m?.name ?? ""))) continue;
    const z = matchOptimalZone(m?.name, profile);
    // Skip anything the mapped path already covers (a zone WITH a lever).
    if (z && MARKER_MAPPINGS.some((x) => x.zone === z.label)) continue;
    const name = canonicalMarker(String(m?.name ?? "")).name || String(m?.name ?? "").trim();
    if (!name) continue;
    const directive_key = normalizeDirectiveKey(`generic:${name}:watch`);
    if (directive_key && seen.has(directive_key)) continue;
    const feedback = lastDirectiveFeedback(source, name, "watch", directive_key);
    // Suppress a note the athlete already dismissed/resolved at this same flag, unless the
    // flag direction changed or a newer reading landed (there's no numeric optimal band
    // here to judge "materially worse", so anchor on the flag side + reading date).
    if (feedback) {
      const sameSide = String(feedback.trigger_side || "") === flag;
      const newDate = String(m?.latest?.date ?? "");
      const sameDate = String(feedback.trigger_date || "") === newDate;
      if (feedback.status === "dismissed" && sameSide) continue;
      if (feedback.status === "resolved" && (sameDate || !newDate)) continue;
    }
    const value = m?.latest?.value;
    const valStr = value != null && value !== "" ? ` (${value}${m?.unit ? ` ${m.unit}` : ""})` : "";
    const row = addDirective({
      source,
      domain: "watch",
      marker: name,
      directive_key,
      directive: `Your lab flagged ${name}${valStr} as ${flag}. It isn't one of the levers Cairn maps, so it's worth mentioning at your next visit to understand what's driving it.`,
      rationale: "A flagged marker outside Cairn's mapped levers is surfaced as a soft watch item so nothing the lab flagged goes unnoticed. Informational, not medical advice.",
      citation: null,
      uncertain: true,
      trigger_value: Number.isFinite(Number(value)) ? Number(value) : null,
      trigger_side: flag,
      trigger_date: m?.latest?.date ?? null,
      resurfaced_from_id: feedback?.id ?? null,
      status: "active",
    });
    if (row) { saved++; emitted++; if (directive_key) seen.add(directive_key); }
  }
  return saved;
}

function deriveMarkerClusters(source: string, offMarkers: Map<string, MarkerContext>, seen: Set<string> = new Set(), profile?: ZoneProfile | null): number {
  let saved = 0;
  // anemia pattern needs cross-marker reads (hemoglobin / MCV) that aren't all in
  // OPTIMAL_ZONES, so handle it specially off the marker history rather than the
  // off-optimal map alone.
  const anemia = buildAnemiaCluster(offMarkers, profile);
  const clusters: { name: string; directives: MappingDirective[]; markerLabel: string; ctx: MarkerContext }[] = [];

  for (const c of MARKER_CLUSTERS) {
    const hits = c.members
      .map((mem) => {
        const ctx = offMarkers.get(mem.label);
        if (!ctx) return null;
        if (mem.side && ctx.side !== mem.side) return null;
        return { label: mem.label, ctx };
      })
      .filter(Boolean) as { label: string; ctx: MarkerContext }[];
    if (hits.length < c.minHits) continue;
    clusters.push({ name: c.name, directives: c.build(hits), markerLabel: hits.map((h) => h.label).join("+"), ctx: hits[0].ctx });
  }
  if (anemia) clusters.push(anemia);

  for (const cl of clusters) {
    for (const d of cl.directives) {
      const directive_key = normalizeDirectiveKey(`cluster:${cl.name}:${d.domain}:${d.key || d.directive}`);
      if (directive_key && seen.has(directive_key)) continue; // already emitted this cluster directive this run
      const feedback = lastDirectiveFeedback(source, cl.markerLabel, d.domain, directive_key);
      if (shouldSuppressDirective(feedback, cl.ctx)) continue;
      const row = addDirective({
        source,
        domain: d.domain,
        marker: cl.markerLabel,
        directive_key,
        directive: d.directive,
        rationale: d.rationale,
        citation: d.citation ?? null,
        uncertain: d.uncertain || !d.citation,
        trigger_value: cl.ctx.value,
        trigger_side: cl.ctx.side,
        trigger_date: cl.ctx.marker?.latest?.date ?? null,
        resurfaced_from_id: feedback?.id ?? null,
        status: "active",
      });
      if (row) { saved++; if (directive_key) seen.add(directive_key); }
    }
  }
  return saved;
}

// Anemia is a PATTERN across iron + red-cell indices, not a single zone. Low
// ferritin (depleted stores) alongside low hemoglobin and/or a small MCV reads
// as iron-deficiency anemia; ferritin alone is just low stores. Reads hemoglobin
// & MCV from the full marker history (they aren't all in OPTIMAL_ZONES). Returns
// one synthesized cluster or null.
function buildAnemiaCluster(offMarkers: Map<string, MarkerContext>, profile?: ZoneProfile | null): { name: string; directives: MappingDirective[]; markerLabel: string; ctx: MarkerContext } | null {
  const ferritin = offMarkers.get("Ferritin");
  if (!ferritin || ferritin.side !== "low") return null;
  const { markers } = getMarkerHistory();
  const find = (re: RegExp) => markers.find((m: any) => re.test(String(m?.name ?? "").toLowerCase()));
  const hgbM = find(/\b(hemoglobin|haemoglobin|hgb|hb)\b/);
  const mcvM = find(/\bmcv\b|mean corpuscular volume/);
  const numOf = (m: any): number | null => {
    if (!m) return null;
    const v = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    return Number.isFinite(v) ? v : null;
  };
  // WHO anemia thresholds are sex-specific: hemoglobin < 13 g/dL in men, < 12 in
  // (non-pregnant) women. Using the male 13.0 for a woman would over-call anemia.
  const hgbThreshold = String(profile?.sex || "male").toLowerCase() === "female" ? 12.0 : 13.0;
  const hgbLow = hgbM?.latest?.flag === "low" || (numOf(hgbM) != null && (numOf(hgbM) as number) < hgbThreshold);
  const mcvVal = numOf(mcvM);
  const mcvLow = mcvM?.latest?.flag === "low" || (mcvVal != null && mcvVal < 80);
  // Genuine pattern: low ferritin PLUS (low hemoglobin OR a small/low MCV).
  if (!hgbLow && !mcvLow) return null;
  const bits = ["low ferritin"];
  if (hgbLow) bits.push("low hemoglobin");
  if (mcvLow) bits.push("low MCV");
  const directives: MappingDirective[] = [
    { domain: "watch", directive: `These read together as an iron-deficiency anemia pattern (${bits.join(" + ")}), not separate flags — confirm with iron studies / a full CBC and discuss iron repletion with your doctor before training hard through it.`, rationale: "Low ferritin with low hemoglobin and/or a small MCV is the classic iron-deficiency anemia signature, which needs confirmation and repletion.", citation: "WHO 2020 Ferritin Guideline; BSH iron-deficiency anemia guidance" },
    { domain: "training", directive: "While this anemia pattern is present, hold endurance volume and keep easy days genuinely easy — oxygen transport is limited until iron and hemoglobin recover.", rationale: "Iron and hemoglobin are rate-limiting for oxygen delivery; hard training on an anemia pattern impairs recovery and adaptation.", citation: "IOC consensus on iron in athletes" },
    { domain: "nutrition", directive: "Pair iron-rich foods (red meat, lentils, spinach) with vitamin C, keep tea/coffee away from iron-rich meals, and follow your doctor's guidance on supplemental iron.", rationale: "Dietary and supplemental iron, with absorption-friendly pairing, repletes stores when clinically appropriate.", citation: "WHO 2020 Ferritin Guideline" },
  ];
  return { name: "anemia-pattern", directives, markerLabel: bits.join("+"), ctx: ferritin };
}

// Persist the agent-emitted directives carried on a saved health review. Stored
// under the 'health_review' source so they coexist with the deterministic
// 'markers' directives — each review save clears & rewrites only its own source.
// Never auto-applies anything; this is the review side of propose-review-apply
// for the clinical layer.
// Canonical directive TARGET for a marker name: the OPTIMAL_ZONES label when the name
// maps to a zone (so "LDL Chol Calc (NIH)", "LDL-C" and "LDL Cholesterol" all collapse
// to "LDL-C"; "Non-HDL Cholesterol" → "Non-HDL-C"), else the marker-canon canonical
// display name. The deterministic 'markers' source already stores the zone label; this
// aligns the agent's free-text 'health_review' marker names onto the SAME label so the
// cross-source de-dup (coach.ts dedupeActiveDirectives, keyed on canonicalMarker) folds
// one lipid finding into one coherent directive set instead of two un-aliased copies.
// Cluster markers ("A+B+C") are left untouched — they're a synthesized cross-marker read.
export function canonicalDirectiveMarker(name: string | null | undefined): string | null {
  if (name == null) return null;
  const s = String(name).trim();
  if (!s || s.includes("+")) return s || null;
  const z = matchOptimalZone(s);
  if (z) return z.label;
  return canonicalMarker(s).name || s;
}

export function applyReviewDirectives(directives: any[]) {
  // Replace the health_review directive set with this list (clear + rewrite).
  // An explicit empty array legitimately means "this review flagged nothing now"
  // and SHOULD clear stale directives. The CALLER (addHealthReview) gates this so
  // it's only invoked when the agent actually addressed directives — an ABSENT
  // field (partial / old-shape response) preserves the prior set instead.
  clearDirectivesForSource("health_review");
  const list = Array.isArray(directives) ? directives : [];
  // Loop-invariant: the safety context is a full marker snapshot (scans + parses
  // every health-doc blob). Build it ONCE, not once per directive.
  const safetyCtx = buildSafetyMarkerContext();
  // Resurface guard, mirroring the deterministic 'markers' path. A finding the
  // athlete dismissed/resolved at an earlier value should NOT stay suppressed
  // forever if the marker has since gotten MATERIALLY worse (dismiss ApoB at 95,
  // it must come back at 140). We resolve the current value/side for each named
  // marker ONCE from the live priority snapshot, then reuse markerMateriallyWorse.
  const markerCtxByName = buildReviewMarkerContexts();
  let count = 0;
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const domain = DIRECTIVE_DOMAINS.has(String(d.domain)) ? String(d.domain) : "watch";
    const rawMarker = d.marker == null || String(d.marker).trim() === "" ? null : String(d.marker).trim().slice(0, 60);
    // Canonicalize the agent's free-text marker onto its optimal-zone label so it folds
    // together with the deterministic 'markers' directive for the same finding (de-noising).
    const marker = rawMarker ? (canonicalDirectiveMarker(rawMarker) ?? rawMarker).slice(0, 60) : null;
    const directive = d.directive == null ? null : String(d.directive).trim().slice(0, 600) || null;
    const directive_key = defaultDirectiveKey(marker, domain, directive);
    const feedback = lastDirectiveFeedback("health_review", marker, domain, directive_key);
    // Current context for THIS marker (null when we can't resolve a numeric value
    // or there's no optimal band to judge against — e.g. a watch-only marker).
    const ctx = marker ? markerCtxByName.get(marker.toLowerCase()) ?? null : null;
    // Keep suppressing prior feedback UNLESS the marker is now clearly worse than
    // it was when last handled. Conservative: with no resolvable context we can't
    // prove a worsening, so we honor the prior dismiss/resolve (skip).
    if (feedback && !(ctx && markerMateriallyWorse(feedback, ctx))) continue;
    // Citation verification (Stream 4 — grounding): a medical system must not
    // surface an unverified citation. An agent-emitted citation is accepted only
    // when it matches a recognized guideline body OR a cached evidence_cache row;
    // otherwise the unverifiable string is STRIPPED and the directive downgraded
    // to uncertain (a softer nudge). The directive itself is never dropped.
    const verified = verifyCitation(d.citation ?? null, d.source_url ?? null);
    // Supplement / interaction safety gate: annotate (never block) a supplement
    // suggestion the user's markers contraindicate (e.g. iron with replete ferritin).
    const safe = safetyGate(
      { domain, marker, directive, rationale: d.rationale ?? null },
      safetyCtx
    );
    const row = addDirective({
      source: "health_review",
      domain,
      marker,
      directive_key,
      directive: safe.directive,
      rationale: safe.rationale,
      citation: verified.citation,
      uncertain: verified.uncertain || safe.uncertain,
      // Stamp the current trigger snapshot (when resolvable) so a future review
      // has a baseline to judge a worsening against — same machinery the
      // 'markers' path uses. When this directive RESURFACED a prior dismiss/
      // resolve, link back to it (resurfaced_from_id) for the same audit trail.
      ...(ctx ? { trigger_value: ctx.value, trigger_side: ctx.side, trigger_date: ctx.marker?.latest?.date ?? null } : {}),
      resurfaced_from_id: feedback?.id ?? null,
      status: "active",
    });
    if (row) count++;
  }
  return count;
}

// Build a name→MarkerContext map from the live priority snapshot, so the review
// path can judge whether a previously-handled finding is now materially worse
// (mirrors the deterministic markers path). Keyed by lowercased marker name AND
// by the marker's optimal-zone label, so a review directive that names either the
// lab's own term or the canonical zone ("ApoB") resolves. Only markers with a
// numeric value and an optimal band are included (nothing to compare otherwise).
function buildReviewMarkerContexts(): Map<string, MarkerContext> {
  const out = new Map<string, MarkerContext>();
  let markers: any[] = [];
  try { markers = prioritizeMarkers().markers; } catch { return out; }
  const profile = zoneProfile();
  for (const m of markers) {
    const z = matchOptimalZone(m?.name, profile);
    if (!z) continue;
    const value = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
    if (!Number.isFinite(value)) continue;
    const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
    const ctx: MarkerContext = { value, flag, zone: z, side: markerSide(value, z, flag), marker: m };
    const nameKey = String(m?.name ?? "").trim().toLowerCase();
    if (nameKey && !out.has(nameKey)) out.set(nameKey, ctx);
    const labelKey = z.label.toLowerCase();
    if (!out.has(labelKey)) out.set(labelKey, ctx); // canonical-name fallback
  }
  return out;
}

// Active health directives condensed for the coach: domain + plain-language
// guidance (with its marker, citation and uncertain flag). INFORMATIONAL, not
// medical advice — the coach folds nutrition/training directives into plans and
// surfaces 'watch' items, never treats them as orders. Bounded.
// ---------- acute-marker staleness (Brief recency) ----------
// Some markers are ACUTE-PHASE / point-in-time: a single reading reflects the moment
// (a cold, a hard session, a poor night), not a stable trait. An OLD elevated acute
// reading must NOT drive today's training/nutrition as if it were current — it ages
// into a quiet "worth a recheck" note instead of a daily cap. Chronic/structural
// markers (ApoB, Lp(a), LDL, HbA1c, …) carry NO such decay — they stay relevant.
const ACUTE_MARKER_RE = /\b(hs-?crp|c-?reactive|\bcrp\b|esr|sed(imentation)? rate|wbc|white blood|neutrophil|creatine kinase|\bck\b)\b/i;
// A composite/cluster name dominated by chronic/structural markers (e.g. the lipid+
// inflammation cluster "ApoB+LDL-C+Lp(a)+hs-CRP+Triglycerides") is NOT a point-in-time
// acute reading — it carries durable lipid advice that must never age out just because
// the name happens to mention CRP. Such names are kept OUT of the acute (decaying) class.
// Word-ending tokens keep \b…\b; the paren-ending Lp(a)/lipoprotein(a) are matched
// without a trailing \b (a ")" is already a non-word char, so \b after it never holds).
const CHRONIC_GUARD_RE = /\b(?:apo\s?b|apolipoprotein|ldl|hdl|hba1c|a1c|triglyceride|cholesterol|glucose)\b|lp\s?\(a\)|lipoprotein\s?\(a\)/i;
export function isAcuteMarker(name?: string | null): boolean {
  if (!name) return false;
  const s = String(name);
  if (CHRONIC_GUARD_RE.test(s)) return false;
  return ACUTE_MARKER_RE.test(s);
}
// After this many days an acute marker-derived directive is STALE for daily surfaces.
// Acute-phase reactants (hs-CRP, CK, ESR, WBC) reflect the last several days — a hard
// week of training, an infection, an injury — not a stable trait, and they normalize
// within ~1-2 weeks. So an acute reading older than this must NOT keep capping today's
// training/meals every morning; it ages into a quiet "worth a recheck" note instead.
export const ACUTE_DIRECTIVE_STALE_DAYS = 10;
// Pure, testable freshness read for a directive. `acute` = its marker is acute-phase;
// `ageDays` = days since the data behind it; `stale` = acute AND clearly old. The age
// anchor prefers an explicit reading date (the actual LAB date, passed by callers that
// resolve marker history) → the directive's own trigger_date → its created_at — so even
// a health_review directive that never stamped a trigger_date can still age out (without
// an anchor a stale acute cap would otherwise nag forever — the original bug).
export function directiveFreshness(
  d: any,
  today?: string,
  anchorDate?: string | null
): { acute: boolean; ageDays: number | null; stale: boolean } {
  const acute = isAcuteMarker(d?.marker);
  const anchor = anchorDate || d?.trigger_date || d?.created_at || null;
  let ageDays: number | null = null;
  const td = anchor ? Date.parse(String(anchor)) : Number.NaN;
  if (Number.isFinite(td)) {
    const now = today ? Date.parse(today) : Date.now();
    if (Number.isFinite(now)) ageDays = Math.floor((now - td) / 864e5);
  }
  return { acute, ageDays, stale: acute && ageDays != null && ageDays > ACUTE_DIRECTIVE_STALE_DAYS };
}

// Acute-marker reading-date map (canonical key → latest LAB date), so an acute
// directive's freshness anchors to the analyte's actual most-recent reading rather
// than when the directive was written. One getMarkerHistory pass; degrades to {} with
// no docs — only acute markers are mapped (chronic markers never decay, so no anchor).
export function acuteReadingDateMap(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const { markers } = getMarkerHistory();
    for (const m of (Array.isArray(markers) ? markers : [])) {
      if (m?.key && m?.latest?.date && isAcuteMarker(m?.name)) out[String(m.key)] = String(m.latest.date);
    }
  } catch { /* no docs / parse failure → no anchors */ }
  return out;
}

// ---------- body-composition staleness (a month-old DEXA vs newer weigh-ins) ----------
// A DEXA / body-fat scan is a point-in-time snapshot. A directive derived from a scan
// that's weeks old while the athlete has since actively LOST or GAINED weight (18 logged
// sessions + weigh-ins moving) must NOT assert the stale scan as current — it decays to a
// "worth a fresh scan to confirm" framing, preferring the newer weight-trend evidence.
export const BODY_COMP_STALE_DAYS = 21;
const BODY_COMP_MOVE_LB = 3; // weight moved at least this much since the scan → scan likely outdated

function isBodyCompDirective(marker?: string | null): boolean {
  if (!marker) return false;
  return /body fat|body composition|body comp|dexa|fat mass|lean mass|visceral|almi|ffmi/i.test(String(marker));
}

// Bodyweight change since a scan date, from the weigh-in log: baseline = the weigh-in
// nearest the scan, delta vs the latest. null when there's no NEWER weigh-in to compare.
function weightDeltaSince(scanISO: string | null, weights: any[]): number | null {
  if (!scanISO || !Array.isArray(weights) || !weights.length) return null;
  const scan = Date.parse(String(scanISO));
  if (!Number.isFinite(scan)) return null;
  const latest = weights[weights.length - 1];
  const latestW = Number(latest?.weight_lb);
  const latestDate = Date.parse(String(latest?.date));
  if (!Number.isFinite(latestW) || !Number.isFinite(latestDate) || latestDate <= scan) return null; // no weigh-in after the scan
  let base: any = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const w of weights) {
    const t = Date.parse(String(w?.date));
    if (!Number.isFinite(t)) continue;
    const gap = Math.abs(t - scan);
    if (gap < bestGap) { bestGap = gap; base = w; }
  }
  const baseW = Number(base?.weight_lb);
  if (!Number.isFinite(baseW)) return null;
  return Math.round((latestW - baseW) * 10) / 10;
}

// Deterministic staleness read for a body-comp directive: its source scan is > ~3 weeks
// old AND bodyweight has since moved enough that the scan can't be asserted as current.
// { stale, reason (plain language), delta_lb }. stale=false for non-body-comp directives,
// a recent scan, or a weight that hasn't moved.
export function bodyCompStaleness(d: any, weights: any[], today?: string): { stale: boolean; reason: string | null; delta_lb: number | null } {
  if (!isBodyCompDirective(d?.marker)) return { stale: false, reason: null, delta_lb: null };
  const anchor = d?.trigger_date || d?.created_at || null;
  const t = anchor ? Date.parse(String(anchor)) : Number.NaN;
  if (!Number.isFinite(t)) return { stale: false, reason: null, delta_lb: null };
  const now = today ? Date.parse(today) : Date.now();
  const ageDays = Math.floor((now - t) / 864e5);
  if (ageDays <= BODY_COMP_STALE_DAYS) return { stale: false, reason: null, delta_lb: null };
  const delta = weightDeltaSince(String(anchor).slice(0, 10), weights);
  if (delta == null || Math.abs(delta) < BODY_COMP_MOVE_LB) return { stale: false, reason: null, delta_lb: delta };
  const weeks = Math.max(3, Math.round(ageDays / 7));
  const dirWord = delta < 0 ? "down" : "up";
  const reason = `Based on a body-composition scan ~${weeks} weeks old; your weight is ${dirWord} ~${Math.abs(delta)} lb since, so treat the number as provisional — a fresh scan would confirm before acting on it.`;
  return { stale: true, reason, delta_lb: delta };
}

// Annotate directive rows with their freshness verdict (acute / age_days / stale),
// anchoring acute markers to the real reading date. Every surface that must agree on
// whether an acute finding is still current uses this: the Brief provenance line, the
// connected-brain prompt block, and the API/MCP directive lists. One marker-history pass.
export function annotateDirectiveFreshness(directives: any[], today?: string, eff?: ContextEffect): any[] {
  const rows = Array.isArray(directives) ? directives : [];
  const anyAcute = rows.some((d) => isAcuteMarker(d?.marker));
  const map = anyAcute ? acuteReadingDateMap() : {};
  // Body-comp staleness needs the weigh-in log — fetch ONCE, and only when a body-comp
  // directive is present (the common case has none). Degrades to [] on any read error.
  const anyBodyComp = rows.some((d) => isBodyCompDirective(d?.marker));
  const weights = anyBodyComp ? (() => { try { return listWeight(120); } catch { return []; } })() : [];
  // The active life-context effect (a recent illness / injury / late night / hard block)
  // raises a transient-inflammation window. We only need it when there's an acute
  // directive to test, and we compute it ONCE. A caller may inject `eff` (testing, or a
  // surface that already has it) to skip the DB read; else derive it for `today`.
  // Best-effort — never throws (a missing/erroring effect simply yields no transient flag).
  let effect: ContextEffect | undefined = eff;
  if (anyAcute && !effect) {
    try { effect = activeContextEffect(today); } catch { effect = undefined; }
  }
  return rows.map((d) => {
    let anchor: string | undefined;
    if (isAcuteMarker(d?.marker)) {
      try { anchor = map[canonicalMarker(String(d?.marker ?? "")).key]; } catch { /* unresolved → directiveFreshness falls back */ }
    }
    const f = directiveFreshness(d, today, anchor);
    // TRANSIENT-FLARE verdict (additive — leaves acute/age_days/stale intact): a FRESH
    // acute reading (hs-CRP, ESR, CK, …) drawn while a transient-inflammation context
    // window is active is the flare talking, not a stable finding. So it reads
    // INFORMATIONAL ("drawn during a flare, recheck once it settles") rather than capping
    // training every morning. Gated on FRESH (not stale): an OLD acute reading stays in
    // the existing stale path, and a long-ago reading can never false-positive here.
    let transient = false;
    let transient_reason: string | null = null;
    if (f.acute && !f.stale && effect?.transient_inflammation) {
      const rawDate = anchor || d?.trigger_date || null;
      const readingDate = rawDate ? String(rawDate).slice(0, 10) : null;
      if (readingDate && markerInTransientWindow(readingDate, effect)) {
        const item = effect.active.find((a) => a.transient_inflammation && (!a.decays_on || readingDate <= a.decays_on));
        const flare = item?.title ? `"${String(item.title).trim()}"` : "a recent flare (illness / injury / a hard block)";
        transient = true;
        transient_reason = `${String(d?.marker ?? "this acute marker").trim()} was likely drawn during ${flare} — informational; worth a recheck once it settles before it shapes training.`;
      }
    }
    // Body-comp recency decay (additive): a directive off a month-old DEXA while the
    // athlete's weight has since moved reads as "worth a rescan", not a current fact.
    const bc = anyBodyComp ? bodyCompStaleness(d, weights, today) : { stale: false, reason: null, delta_lb: null };
    return { ...d, acute: f.acute, age_days: f.ageDays, stale: f.stale, transient, transient_reason, stale_measurement: bc.stale, rescan_reason: bc.reason, weight_delta_lb: bc.delta_lb };
  });
}

export function directivesForCoach() {
  // Body-comp recency decay: a directive off a scan that's weeks old while bodyweight
  // has since moved is reframed as provisional ("worth a fresh scan"), so the coach
  // never asserts a stale DEXA as current. Fetch the weigh-in log once.
  const weights = (() => { try { return listWeight(120); } catch { return []; } })();
  return listActiveDirectives().slice(0, 24).map((d: any) => {
    const bc = bodyCompStaleness(d, weights);
    const directive = bc.stale && bc.reason
      ? `${d.directive} [Note: ${bc.reason}]`
      : d.directive;
    return {
      domain: d.domain,
      marker: d.marker,
      directive,
      rationale: d.rationale,
      citation: d.citation,
      uncertain: d.uncertain,
      directive_key: d.directive_key,
      trigger_value: d.trigger_value,
      trigger_side: d.trigger_side,
      trigger_date: d.trigger_date,
      created_at: d.created_at,
      stale_measurement: bc.stale,
      rescan_reason: bc.reason,
    };
  });
}

export function directiveFeedbackForCoach(limit = 12) {
  return (db.prepare(
    `SELECT * FROM health_directives
     WHERE status IN ('resolved', 'dismissed')
       AND status_at IS NOT NULL
     ORDER BY COALESCE(status_at, created_at) DESC, id DESC
     LIMIT ?`
  ).all(limit) as any[]).map(hydrateDirective).map((d: any) => ({
    status: d.status,
    status_at: d.status_at || d.created_at,
    domain: d.domain,
    marker: d.marker,
    directive: d.directive,
    rationale: d.rationale,
    directive_key: d.directive_key,
    trigger_value: d.trigger_value,
    trigger_side: d.trigger_side,
    trigger_date: d.trigger_date,
  }));
}

// ============================================================================
// RESEARCH & GROUNDING (Stream 4). Three layers, all INFORMATIONAL not medical
// advice, all degrading to today's behavior when research is off / unavailable:
//   1. evidence_cache — a host-side store of cited claims (src/research.ts fills
//      it; the health review can inject the retrieved passages and cite them).
//   2. verifyCitation — a directive's citation is accepted only if it matches a
//      recognized guideline body OR a cached evidence row; else it's stripped and
//      the directive is downgraded to uncertain (closing the hallucination surface).
//   3. safetyGate — a curated rule set that annotates (never blocks) a supplement
//      suggestion the user's markers contraindicate.
// NOTE (clean-merge boundary): this layer is implemented as SEPARATE wrapper
// functions called from applyReviewDirectives / coachOps — it does NOT edit
// OPTIMAL_ZONES / MARKER_MAPPINGS / deriveDirectives (Stream 3's territory).

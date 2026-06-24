// The PERSONAL-RESPONSE model — how THIS athlete actually reacts.
//
// This is the keystone the higher coaching layers read from: a deterministic,
// pure, null-safe digest of the patterns the data REVEALS about one person
// (how a deficit moves their weight, whether their hs-CRP tracks training load,
// what late events cost their sleep, which plan days actually land, whether a
// muscle's volume coincides with soreness, whether recovery signal is even
// available, and whether a past intervention preceded a marker change).
//
// CONSTITUTION (binding): no 0-100 scores or numeric grades EVER cross the
// public boundary. Coefficients/correlations stay INTERNAL (the optional
// `params` blob, like impact_score) — only plain words + a confidence WORD
// ('tentative'|'observed'|'strong') are ever surfaced. Suggestion, never a
// gate. Pull, never push. Calm, bounded output: at most a handful of patterns,
// each emitted only when its sparsity guard passes.
//
// CYCLE NOTE: coach.ts imports THIS module, so this module must NOT import
// coach.ts. Recovery deltas are queried straight off garmin_daily_metrics +
// daily_metrics here (the same column shapes getRecoverySummary/latestSleep
// read) rather than calling them.

import { db } from "../db.js";
import { getMarkerHistory } from "./health.js";
import { estimateExpenditure } from "./intelligence.js";
import { normalizedExerciseKey, canonicalGroup, isMobility } from "./exercise-canon.js";
import { getAppState, setAppState } from "./app-state.js";
import { addMemory } from "./memory.js";
// Single sources of truth (function-level cycle, resolved at call time — the same
// pattern coach↔intelligence↔propagation already rely on): the acute-marker classifier
// (with its chronic-cluster guard) and the prior-week training-load helpers.
import { isAcuteMarker } from "./propagation.js";
import { weeklyTonnage, weeklyKm } from "./program-state.js";

export interface ReactionPattern {
  id: string;
  kind: string;
  statement: string;
  confidence: "tentative" | "observed" | "strong";
  evidence_n: number;
  domains: string[];
  last_observed: string | null;
  // INTERNAL only — coefficients/correlations the engine reasons with. NEVER
  // surfaced as a number/grade (the constitution bans 0-100 scores). Higher
  // layers may read these for ordering, but must not render them.
  params?: Record<string, number>;
}

const REACTION_MODEL_VERSION = 1;

// ---- small local helpers (kept in-lane; no cross-layer imports) -------------

function isoDaysAgo(date: string, n: number): string {
  const base = Date.parse(date + "T00:00:00Z");
  return new Date(base - n * 864e5).toISOString().slice(0, 10);
}

// Ordinary least-squares correlation coefficient (Pearson r) over paired points.
// Returns null when degenerate (n<3, or no variance on either axis). INTERNAL —
// the coefficient never crosses the public boundary; only its sign/strength
// shapes the plain-language statement + confidence WORD.
function pearson(pairs: Array<{ x: number; y: number }>): number | null {
  if (!pairs || pairs.length < 3) return null;
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p.x, 0) / n;
  const my = pairs.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pairs) {
    const dx = p.x - mx, dy = p.y - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

// Latest date present in either recovery table for a recovery column, plus a
// "stale by" gap in days vs today. Null when there's no data at all.
function latestRecoveryDate(): { date: string | null; age_days: number | null } {
  try {
    const g = db.prepare(
      `SELECT MAX(date) AS d FROM garmin_daily_metrics WHERE (sleep_min IS NOT NULL AND sleep_min > 0) OR hrv_ms IS NOT NULL`
    ).get() as any;
    const o = db.prepare(
      `SELECT MAX(date) AS d FROM daily_metrics WHERE (sleep_min IS NOT NULL AND sleep_min > 0) OR hrv_ms IS NOT NULL`
    ).get() as any;
    const cands = [g?.d, o?.d].filter((x) => x && String(x).trim()) as string[];
    if (!cands.length) return { date: null, age_days: null };
    const latest = cands.sort().slice(-1)[0];
    const age = Math.round((Date.now() - Date.parse(latest + "T00:00:00Z")) / 864e5);
    return { date: latest, age_days: Number.isFinite(age) ? Math.max(0, age) : null };
  } catch {
    return { date: null, age_days: null };
  }
}

// Per-night sleep/HRV for a date, preferring Garmin (richer), falling back to
// daily_metrics. Null fields when absent. Used by the event-recovery pattern.
function nightRecovery(date: string): { sleep_min: number | null; hrv_ms: number | null } {
  try {
    const g = db.prepare(
      `SELECT sleep_min, hrv_ms FROM garmin_daily_metrics WHERE date = ? AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL) ORDER BY id DESC LIMIT 1`
    ).get(date) as any;
    if (g && (g.sleep_min != null || g.hrv_ms != null)) {
      return { sleep_min: g.sleep_min != null ? Number(g.sleep_min) : null, hrv_ms: g.hrv_ms != null ? Number(g.hrv_ms) : null };
    }
    const o = db.prepare(
      `SELECT sleep_min, hrv_ms FROM daily_metrics WHERE date = ? AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL) ORDER BY updated_at DESC, id DESC LIMIT 1`
    ).get(date) as any;
    if (o && (o.sleep_min != null || o.hrv_ms != null)) {
      return { sleep_min: o.sleep_min != null ? Number(o.sleep_min) : null, hrv_ms: o.hrv_ms != null ? Number(o.hrv_ms) : null };
    }
  } catch { /* fall through */ }
  return { sleep_min: null, hrv_ms: null };
}

// Athlete's ~30-day sleep baseline (avg minutes), preferring Garmin. Null when
// there isn't enough data to anchor an event comparison against.
function sleepBaseline(): { avg_min: number | null; n: number } {
  try {
    const since = isoDaysAgo(new Date().toISOString().slice(0, 10), 30);
    const g = db.prepare(
      `SELECT ROUND(AVG(sleep_min),1) AS a, COUNT(*) AS n FROM garmin_daily_metrics WHERE date >= ? AND sleep_min IS NOT NULL AND sleep_min > 0`
    ).get(since) as any;
    if (g && g.n >= 5 && g.a != null) return { avg_min: Number(g.a), n: Number(g.n) };
    const o = db.prepare(
      `SELECT ROUND(AVG(sleep_min),1) AS a, COUNT(*) AS n FROM daily_metrics WHERE date >= ? AND sleep_min IS NOT NULL AND sleep_min > 0`
    ).get(since) as any;
    if (o && o.n >= 5 && o.a != null) return { avg_min: Number(o.a), n: Number(o.n) };
    return { avg_min: null, n: 0 };
  } catch {
    return { avg_min: null, n: 0 };
  }
}

const ENDURANCE_PATTERNS = ["run", "ride", "cycl", "bike", "swim", "row", "walk", "hike"];

// weeklyTonnage / weeklyKm (prior-week training load) are imported from program-state
// (their canonical home — weeklyKm there uses the shared sport matcher, not a raw LIKE).

// ---------------------------------------------------------------------------
// 1) deficit_response — revealed kcal-per-lb sensitivity, off the expenditure
//    engine's recency-weighted weight slope + intake avg + confidence ladder.
// ---------------------------------------------------------------------------
function deficitResponse(): ReactionPattern | null {
  const exp = estimateExpenditure(21);
  // Reuse the engine's confidence ladder — only speak at medium/high.
  if (exp.confidence !== "medium" && exp.confidence !== "high") return null;
  if (exp.tdee == null || exp.intake_avg_kcal == null || exp.trend_lb_wk == null) return null;
  // Revealed deficit = TDEE − intake (a positive number means eating under
  // maintenance). The measured weekly weight change is the response to it.
  const deficit = Math.round(exp.tdee - exp.intake_avg_kcal);
  const lbWk = exp.trend_lb_wk; // negative = losing
  // Only speak when there's a real deficit AND a real direction to it — a
  // maintenance week (tiny deficit, flat scale) has no sensitivity to reveal.
  if (Math.abs(deficit) < 150 || Math.abs(lbWk) < 0.1) return null;
  const dir = lbWk < 0 ? "down" : "up";
  const absLb = round(Math.abs(lbWk), 2);
  const statement = deficit > 0
    ? `A roughly ${Math.abs(deficit)} kcal/day deficit has been moving your weight ${dir} about ${absLb} lb/wk.`
    : `A roughly ${Math.abs(deficit)} kcal/day surplus has been moving your weight ${dir} about ${absLb} lb/wk.`;
  return {
    id: "deficit_response",
    kind: "nutrition_response",
    statement,
    confidence: exp.confidence === "high" ? "strong" : "observed",
    evidence_n: exp.points,
    domains: ["nutrition"],
    last_observed: new Date().toISOString().slice(0, 10),
    params: { deficit_kcal: deficit, lb_per_wk: lbWk, points: exp.points },
  };
}

// ---------------------------------------------------------------------------
// 2) load_crp — does hs-CRP / ESR move ALONGSIDE prior-week training load?
//    Observational ONLY (likely training-induced, never causal/red-flag).
// ---------------------------------------------------------------------------
function loadCrp(): ReactionPattern | null {
  let hist: any;
  try { hist = getMarkerHistory(); } catch { return null; }
  const markers: any[] = Array.isArray(hist?.markers) ? hist.markers : [];
  // Acute inflammation markers with dated numeric readings.
  const acute = markers.filter((m) => m && isAcuteMarker(m.name) && Array.isArray(m.points) && m.points.length);
  if (!acute.length) return null;
  // Use the marker with the most readings (typically hs-CRP).
  acute.sort((a, b) => (b.points?.length ?? 0) - (a.points?.length ?? 0));
  const m = acute[0];
  const points: Array<{ date: string; value: number }> = (m.points as any[])
    .map((p) => ({ date: String(p.date), value: Number(p.value) }))
    .filter((p) => p.date && Number.isFinite(p.value));
  if (points.length < 3) return null; // gate: >=3 readings
  // For each reading, the prior-7d training load (tonnage + endurance km).
  const pairs = points.map((p) => {
    const load = weeklyTonnage(p.date, 0) + weeklyKm(p.date, 0, ENDURANCE_PATTERNS) * 100; // scale km onto the tonnage axis (internal only)
    return { x: load, y: p.value };
  });
  const r = pearson(pairs);
  if (r == null) return null;
  // Only speak when the marker actually moves WITH load (positive correlation).
  if (r < 0.4) return null;
  const confidence: ReactionPattern["confidence"] = r >= 0.75 && points.length >= 4 ? "strong" : r >= 0.6 ? "observed" : "tentative";
  const display = String(m.name || "hs-CRP");
  const statement = `Your ${display} tends to move alongside your training load — likely training-induced inflammation, not a red flag. Recheck it on a lighter week before reading anything into a single high value.`;
  return {
    id: "load_crp",
    kind: "marker_response",
    statement,
    confidence,
    evidence_n: points.length,
    domains: ["watch", "training"],
    last_observed: points[points.length - 1].date,
    params: { r: round(r, 3), readings: points.length },
  };
}

// ---------------------------------------------------------------------------
// 3) event_recovery — late / loud life events vs the athlete's sleep baseline.
//    Compares the event night + next 1-2 nights against the ~30d sleep norm.
//    Gate: >=2 events WITH recovery data (often 0 right now → omit).
// ---------------------------------------------------------------------------
function eventRecovery(): ReactionPattern | null {
  const base = sleepBaseline();
  if (base.avg_min == null) return null;
  let events: any[];
  try {
    events = db.prepare(
      `SELECT title, detail, start_date FROM context_events
        WHERE start_date IS NOT NULL AND start_date != '' AND COALESCE(archived,0) = 0
          AND kind = 'life_event'
        ORDER BY start_date DESC LIMIT 24`
    ).all() as any[];
  } catch { return null; }
  if (!events.length) return null;
  const deficits: number[] = [];
  let lastObserved: string | null = null;
  for (const ev of events) {
    const start = String(ev.start_date).slice(0, 10);
    // The event night + the next two nights.
    const nights = [start, isoDaysAgo(start, -1), isoDaysAgo(start, -2)];
    const sleeps = nights
      .map((d) => nightRecovery(d).sleep_min)
      .filter((s): s is number => s != null && Number.isFinite(s));
    if (!sleeps.length) continue;
    const minSleep = Math.min(...sleeps); // the worst night around the event
    const def = base.avg_min - minSleep; // minutes BELOW baseline (positive = lost sleep)
    if (def > 15) {
      deficits.push(def);
      if (!lastObserved || start > lastObserved) lastObserved = start;
    }
  }
  if (deficits.length < 2) return null; // gate: >=2 events WITH usable recovery data
  const avgDefMin = deficits.reduce((a, b) => a + b, 0) / deficits.length;
  const avgDefHrs = round(avgDefMin / 60, 1);
  const confidence: ReactionPattern["confidence"] = deficits.length >= 4 ? "observed" : "tentative";
  const statement = `Late events tend to cost you about ${avgDefHrs}h of sleep — worth planning a lighter morning after one.`;
  return {
    id: "event_recovery",
    kind: "recovery_response",
    statement,
    confidence,
    evidence_n: deficits.length,
    domains: ["recovery", "training"],
    last_observed: lastObserved,
    params: { avg_deficit_min: round(avgDefMin, 0), events: deficits.length },
  };
}

// ---------------------------------------------------------------------------
// 4) adherence — which plan days land, and which exercises get skipped.
//    Gate: >=4 weeks of training history.
// ---------------------------------------------------------------------------
function adherence(): ReactionPattern | null {
  let span: any;
  try {
    span = db.prepare(
      `SELECT MIN(date) AS first, MAX(date) AS last, COUNT(DISTINCT date) AS days FROM sessions`
    ).get() as any;
  } catch { return null; }
  if (!span?.first || !span?.last) return null;
  const weeks = (Date.parse(span.last + "T00:00:00Z") - Date.parse(span.first + "T00:00:00Z")) / (7 * 864e5);
  if (weeks < 4) return null; // gate: >=4 weeks history
  const weeksRound = Math.max(1, Math.round(weeks));

  // Per plan day: how many distinct sessions landed on it.
  let landed: any[] = [];
  try {
    landed = db.prepare(
      `SELECT pd.day_number AS dn, pd.name AS name, COUNT(DISTINCT s.id) AS n
         FROM plan_days pd LEFT JOIN sessions s ON s.plan_day_id = pd.id
        GROUP BY pd.id ORDER BY pd.day_number ASC`
    ).all() as any[];
  } catch { landed = []; }

  // Skips by exercise (deduped via the canonical movement key), most-skipped first.
  let skips: any[] = [];
  try {
    skips = db.prepare(`SELECT exercise FROM session_skips`).all() as any[];
  } catch { skips = []; }
  const skipCount = new Map<string, { display: string; n: number }>();
  for (const row of skips) {
    const name = String(row.exercise ?? "").trim();
    if (!name) continue;
    const key = normalizedExerciseKey(name) || name.toLowerCase();
    const cur = skipCount.get(key);
    if (cur) cur.n++;
    else skipCount.set(key, { display: name, n: 1 });
  }

  // Nothing to say if there's neither a landing pattern nor a skip pattern.
  const reliable = landed.filter((d) => Number(d.n) >= Math.max(2, weeksRound * 0.6));
  const topSkip = [...skipCount.values()].sort((a, b) => b.n - a.n)[0];
  if (!reliable.length && !(topSkip && topSkip.n >= 2)) return null;

  const parts: string[] = [];
  if (reliable.length) {
    const names = reliable.slice(0, 2).map((d) => String(d.name || `Day ${d.dn}`));
    parts.push(`your ${names.join(" and ")} day${names.length > 1 ? "s" : ""} land most weeks`);
  }
  if (topSkip && topSkip.n >= 2) {
    parts.push(`${topSkip.display} gets skipped the most`);
  }
  if (!parts.length) return null;
  const joined = parts.join("; ");
  const statement = (joined.charAt(0).toUpperCase() + joined.slice(1)) + ".";
  return {
    id: "adherence",
    kind: "adherence",
    statement,
    confidence: weeksRound >= 8 ? "strong" : "observed",
    evidence_n: weeksRound,
    domains: ["training"],
    last_observed: span.last,
    params: { weeks: weeksRound, reliable_days: reliable.length, top_skip_n: topSkip?.n ?? 0 },
  };
}

// ---------------------------------------------------------------------------
// 5) volume_soreness — weeks where a muscle's high set-volume coincides with a
//    self-reported soreness / joint-pain flag (>=4 on the 1-5 scale, or a
//    free-text joint flag). Gate: a real coincidence.
// ---------------------------------------------------------------------------
function volumeSoreness(): ReactionPattern | null {
  let flagged: any[] = [];
  try {
    flagged = db.prepare(
      `SELECT id, date, soreness, joint_pain FROM sessions
        WHERE (soreness IS NOT NULL AND soreness >= 4) OR (joint_pain IS NOT NULL AND TRIM(joint_pain) != '')
        ORDER BY date DESC LIMIT 40`
    ).all() as any[];
  } catch { return null; }
  if (!flagged.length) return null;

  // For each flagged session, find the muscle group that carried the most sets
  // that week (the prior 7 days through the session date). A coincidence is a
  // group that shows up as the top-volume group on >=2 flagged weeks.
  const groupHits = new Map<string, number>();
  let lastObserved: string | null = null;
  for (const s of flagged) {
    const date = String(s.date).slice(0, 10);
    const start = isoDaysAgo(date, 6);
    let rows: any[] = [];
    try {
      rows = db.prepare(
        `SELECT e.muscle_group AS mg, COUNT(*) AS sets
           FROM logged_sets ls JOIN sessions ss ON ss.id = ls.session_id JOIN exercises e ON e.id = ls.exercise_id
          WHERE ss.date >= ? AND ss.date <= ?
          GROUP BY e.id`
      ).all(start, date) as any[];
    } catch { rows = []; }
    const byGroup = new Map<string, number>();
    for (const r of rows) {
      const g = canonicalGroup(r.mg) ?? null;
      if (!g || isMobility(g)) continue;
      byGroup.set(g, (byGroup.get(g) ?? 0) + Number(r.sets || 0));
    }
    const top = [...byGroup.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 8) {
      groupHits.set(top[0], (groupHits.get(top[0]) ?? 0) + 1);
      if (!lastObserved || date > lastObserved) lastObserved = date;
    }
  }
  const coincident = [...groupHits.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  if (!coincident) return null; // gate: a real coincidence
  const [group, n] = coincident;
  const statement = `Heavy ${group} weeks tend to line up with the days you flag soreness — easing volume there a touch may help.`;
  return {
    id: "volume_soreness",
    kind: "training_response",
    statement,
    confidence: n >= 3 ? "observed" : "tentative",
    evidence_n: n,
    domains: ["training", "recovery"],
    last_observed: lastObserved,
    params: { coincident_weeks: n },
  };
}

// ---------------------------------------------------------------------------
// 6) data_gap — FIRST-CLASS: when synced sleep/HRV is stale or absent, say so,
//    so the coach never fabricates a recovery read it can't actually see.
// ---------------------------------------------------------------------------
function dataGap(): ReactionPattern | null {
  const { date, age_days } = latestRecoveryDate();
  if (date == null || age_days == null) {
    return {
      id: "data_gap",
      kind: "data_gap",
      statement: "No synced sleep or HRV right now — recovery signal is dark, so reads lean on how you say you feel rather than a number.",
      confidence: "observed",
      evidence_n: 0,
      domains: ["recovery"],
      last_observed: null,
      params: { age_days: -1 },
    };
  }
  if (age_days > 2) {
    return {
      id: "data_gap",
      kind: "data_gap",
      statement: `Your last synced sleep/HRV is about ${age_days} days old — recovery signal has gone quiet, so today's read can't lean on it.`,
      confidence: "observed",
      evidence_n: 0,
      domains: ["recovery"],
      last_observed: date,
      params: { age_days },
    };
  }
  return null; // fresh data → nothing to flag
}

// ---------------------------------------------------------------------------
// 7) intervention_marker (best-effort) — an applied plan/meal proposal or a
//    resolved health_directive that PREDATES a new reading of its target
//    marker → before→after delta + plain forecast direction.
//    Gate: a reading strictly AFTER the intervention + >=1 prior reading.
// ---------------------------------------------------------------------------
function interventionMarker(): ReactionPattern | null {
  let hist: any;
  try { hist = getMarkerHistory(); } catch { return null; }
  const markers: any[] = Array.isArray(hist?.markers) ? hist.markers : [];
  if (!markers.length) return null;

  // Candidate interventions, each with an effective date + the marker it targets.
  interface Interv { date: string; marker: string | null; label: string }
  const intervs: Interv[] = [];
  try {
    const dirs = db.prepare(
      `SELECT marker, status_at, directive FROM health_directives
        WHERE status = 'resolved' AND status_at IS NOT NULL AND marker IS NOT NULL`
    ).all() as any[];
    for (const d of dirs) {
      const dt = String(d.status_at).slice(0, 10);
      if (dt) intervs.push({ date: dt, marker: String(d.marker), label: "a resolved finding" });
    }
  } catch { /* table may be absent */ }
  try {
    const props = db.prepare(
      `SELECT created_at FROM plan_proposals WHERE status = 'applied' ORDER BY created_at DESC LIMIT 6`
    ).all() as any[];
    const meals = db.prepare(
      `SELECT created_at FROM meal_plans WHERE status = 'applied' ORDER BY created_at DESC LIMIT 6`
    ).all() as any[];
    // Plan/meal applies aren't tied to a specific marker — recorded but
    // marker-less, so they can't anchor a marker series on their own here.
    for (const p of [...props, ...meals]) {
      const dt = String(p.created_at ?? "").slice(0, 10);
      if (dt) intervs.push({ date: dt, marker: null, label: "a plan change" });
    }
  } catch { /* ignore */ }
  if (!intervs.length) return null;

  // Match a marker-targeted intervention to its marker series, requiring a
  // reading STRICTLY AFTER the intervention and >=1 prior reading.
  for (const iv of intervs) {
    if (!iv.marker) continue;
    const m = markers.find((mm) => {
      const key = String(mm.key || mm.name || "").toLowerCase();
      const nm = String(mm.name || "").toLowerCase();
      const t = String(iv.marker).toLowerCase();
      return key === t || nm === t || key.includes(t) || nm.includes(t) || t.includes(key);
    });
    if (!m || !Array.isArray(m.points) || m.points.length < 2) continue;
    const pts: Array<{ date: string; value: number }> = (m.points as any[])
      .map((p) => ({ date: String(p.date), value: Number(p.value) }))
      .filter((p) => p.date && Number.isFinite(p.value));
    const prior = pts.filter((p) => p.date <= iv.date);
    const after = pts.filter((p) => p.date > iv.date);
    if (prior.length < 1 || after.length < 1) continue; // gate
    const before = prior[prior.length - 1];
    const latest = after[after.length - 1];
    const delta = round(latest.value - before.value, 2);
    if (Math.abs(delta) < 1e-6) continue;
    const dirWord = delta < 0 ? "down" : "up";
    const fdir = m.forecast?.direction; // 'improving' | 'worsening' | 'stable' | null — plain word, no number
    const fclause = fdir === "improving" ? ", and it's still trending toward optimal"
      : fdir === "worsening" ? ", though it's since drifting the wrong way"
        : "";
    const statement = `Since ${iv.label}, your ${m.name} has moved ${dirWord} (from ${before.value} to ${latest.value})${fclause}.`;
    return {
      id: "intervention_marker",
      kind: "intervention_response",
      statement,
      confidence: after.length >= 2 ? "observed" : "tentative",
      evidence_n: prior.length + after.length,
      domains: ["watch", "nutrition"],
      last_observed: latest.date,
      params: { before: before.value, after: latest.value, delta },
    };
  }
  return null;
}

// ---- assembly ---------------------------------------------------------------

export function buildReactionModel(): { version: number; patterns: ReactionPattern[]; built_at_note?: string } {
  const candidates: Array<ReactionPattern | null> = [];
  // Each builder is independently fail-safe — wrap so one bad query never sinks
  // the whole model (deterministic + never throws on missing data).
  const safe = (fn: () => ReactionPattern | null): ReactionPattern | null => {
    try { return fn(); } catch { return null; }
  };
  candidates.push(safe(deficitResponse));
  candidates.push(safe(loadCrp));
  candidates.push(safe(eventRecovery));
  candidates.push(safe(adherence));
  candidates.push(safe(volumeSoreness));
  candidates.push(safe(dataGap));
  candidates.push(safe(interventionMarker));

  const patterns = candidates.filter((p): p is ReactionPattern => p != null);
  return { version: REACTION_MODEL_VERSION, patterns };
}

const CONF_RANK: Record<ReactionPattern["confidence"], number> = { strong: 3, observed: 2, tentative: 1 };

// Strip the INTERNAL params blob — a defensive guard so the surfaced read can
// NEVER leak a coefficient/score even if a future caller serializes it raw.
function publicPattern(p: ReactionPattern): ReactionPattern {
  const { params, ...rest } = p;
  return rest;
}

export function reactionModelForCoach(): {
  patterns: ReactionPattern[];
  narrative: string | null;
  built_at: string | null;
  source: "cache" | "deterministic";
} {
  let patterns: ReactionPattern[] = [];
  let narrative: string | null = null;
  let builtAt: string | null = null;
  let source: "cache" | "deterministic" = "deterministic";

  const cached = getAppState("reaction_model");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.patterns)) {
        patterns = parsed.patterns as ReactionPattern[];
        source = "cache";
        narrative = getAppState("reaction_model_narrative");
        builtAt = getAppState("reaction_model_built_at");
      }
    } catch { /* corrupt cache → rebuild */ }
  }
  if (source !== "cache") {
    patterns = buildReactionModel().patterns;
  }

  // Strongest first (by confidence WORD, then evidence_n), capped at 6 — calm,
  // bounded output. Public shape strips the internal params number blob.
  const ranked = [...patterns]
    .sort((a, b) => (CONF_RANK[b.confidence] ?? 0) - (CONF_RANK[a.confidence] ?? 0) || (b.evidence_n ?? 0) - (a.evidence_n ?? 0))
    .slice(0, 6)
    .map(publicPattern);

  return { patterns: ranked, narrative, built_at: builtAt, source };
}

export function saveReactionModel(): void {
  const model = buildReactionModel();
  const builtAt = new Date().toISOString();
  setAppState("reaction_model", JSON.stringify(model));
  setAppState("reaction_model_built_at", builtAt);
  // Promote the load-bearing patterns into coach memory so the agent has them in
  // its working context even outside the structured read. Only strong/observed —
  // a tentative pattern isn't durable enough to memorialize. addMemory dedupes.
  for (const p of model.patterns) {
    if (p.confidence === "strong" || p.confidence === "observed") {
      try { addMemory(p.statement, "reaction", "reaction-model"); } catch { /* best-effort */ }
    }
  }
}

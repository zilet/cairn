import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { listActiveDirectives } from "./coach.js";
import { newestHealthDocDate } from "./health.js";
import { markerGroup } from "./propagation-data.js";
import { readingAgeDays, readingPastValidity } from "./marker-validity.js";
import {
  ACUTE_DIRECTIVE_STALE_DAYS,
  annotateDirectiveFreshness,
  isAcuteMarker,
  prioritizeMarkers,
} from "./propagation.js";
import { localDateISO } from "./shared.js";

// ============================================================================
// HEALTH FOCUS — the prioritization/synthesis substrate (elite-coach layer).
// The propagation engine emits one directive per (marker × domain); on a real
// panel that's 30+ flat items — a flood, not coaching. healthFocus() collapses
// them into a handful of TIERED, deduped, connected priorities: each health
// "story" (a marker group) with its tier (act now / track / maintain-ish), the
// markers driving it, and the LEAD move per domain. Deterministic, no scores —
// the tier is plain words, the order is the priority. This is what the Health → Read view
// renders and what the agentic health-story synthesis reasons over.
// ============================================================================
export type FocusTier = "act_now" | "track";
export interface FocusReading {
  name: string;
  value: number | string | null;
  unit: string | null;
  flag: string | null; // lab flag (low/high) or null
  optimal: [number, number] | null; // evidence-based optimal band
  in_optimal: boolean | null;
  trend: string | null; // rising/falling/stable
  projection: string | null; // plain-language forecast vs optimal
}
export interface FocusPriority {
  group: string; // group label, e.g. "Lipids & Cardiovascular"
  tier: FocusTier;
  markers: string[]; // off-optimal marker names in this group, priority order
  readings: FocusReading[]; // the QUANTITATIVE detail (value/band/trend) — so the synthesis reasons on numbers, not names
  flagged: boolean; // the lab itself flagged one low/high
  compounding: boolean; // ≥2 markers off here (or a cross-marker cluster directive)
  worsening: boolean; // a marker in this group is trending the wrong way
  moves: { nutrition?: string; training?: string; watch?: string }; // the LEAD directive per domain
  uncertain: boolean; // the levers here are real-but-unsettled (softer nudge)
  why: string; // one plain clause
}
export interface HealthFocus {
  priorities: FocusPriority[]; // act_now first, then track; deduped to one per group (the FULL set, for the Health → Read view)
  surfaced: FocusPriority[]; // the CAPPED daily set (≤3 act-now + ≤2 track) — what every daily surface shows, so it's never a flood
  lead: FocusPriority | null; // the single most important priority — the spine of the one coach voice everywhere
  act_now: number;
  track: number;
  headline: string; // deterministic plain lead ("Lipids are the priority right now")
}

export function healthFocus(): HealthFocus {
  const { markers } = prioritizeMarkers(); // ordered: flagged-first then furthest-from-optimal
  // Is this marker's own latest reading past the window its KIND of marker stays current
  // for (src/repo/marker-validity.ts)? Per-marker, so a group mixing a current finding
  // with an aged one still leads on the current one.
  const markerPastValidity = (m: any): boolean =>
    readingPastValidity(m?.name, readingAgeDays(m?.latest?.date ?? null));
  // Off-optimal markers, in priority order, bucketed by health group (preserving rank).
  // `currentRank` is the panel position of the group's best still-in-date marker — an aged
  // reading must not lend the group its place near the top of the priority order either.
  const groups = new Map<string, { markers: any[]; rank: number; currentRank: number }>();
  markers.forEach((m: any, i: number) => {
    // Admit a marker when it sits OUT of its optimal band (in_optimal === false) OR
    // the lab itself flagged it low/high. A lab-flagged marker with NO optimal zone
    // (in_optimal === null) was previously dropped here — a flagged finding that
    // never reached the Brain. Only skip a clean in-optimal marker, or an
    // unflagged one we have no optimal band for (nothing to say).
    const flagged = m?.latest?.flag === "low" || m?.latest?.flag === "high";
    if (m?.in_optimal === true) return; // clearly in optimal — clean
    if (m?.in_optimal == null && !flagged) return; // no band + not flagged — nothing to say
    const label = m.group_label || markerGroup(m?.name || "").label;
    if (!groups.has(label)) groups.set(label, { markers: [], rank: i, currentRank: Number.POSITIVE_INFINITY });
    const g = groups.get(label)!;
    g.markers.push(m);
    if (!markerPastValidity(m) && i < g.currentRank) g.currentRank = i;
  });

  // The active directives, bucketed to the same groups, so each priority carries
  // the lead actionable move per domain (a non-uncertain one wins over uncertain).
  const dirByGroup = new Map<string, any[]>();
  for (const d of annotateDirectiveFreshness(listActiveDirectives() as any[])) {
    if (d.stale) continue; // a stale acute directive (e.g. an old hs-CRP) no longer drives a move/tier
    // …and neither does one whose reading is past what its OWN kind of marker stays
    // current for. The connected-brain prompt already tells the coach not to act on these;
    // letting one supply a group's lead MOVE would contradict that on the same page.
    if (d.past_validity) continue;
    const label = markerGroup(String(d.marker || "")).label;
    if (!dirByGroup.has(label)) dirByGroup.set(label, []);
    dirByGroup.get(label)!.push(d);
  }
  const leadMove = (dirs: any[], domain: string): { text?: string; uncertain: boolean } => {
    const inDomain = dirs.filter((d) => d.domain === domain);
    if (!inDomain.length) return { uncertain: false };
    const lead = inDomain.find((d) => !d.uncertain) || inDomain[0];
    return {
      text: String(lead.directive || "")
        .trim()
        .slice(0, 240),
      uncertain: !!lead.uncertain,
    };
  };

  const priorities: FocusPriority[] = [];
  for (const [label, { markers: ms, currentRank }] of groups) {
    const dirs = dirByGroup.get(label) || [];
    // EVERY act-now input is scoped to evidence still inside its own marker's window —
    // the flag weight, whether this reads as a compounding picture, how far out it sits,
    // whether it's drifting, and the group's place in the panel order. An aged reading
    // cannot lend weight to a priority the connected-brain block on the same page says
    // not to act on. (`dirs` is already past-window-free, so its cluster check is too.)
    const currentMs = ms.filter((m) => !markerPastValidity(m));
    // …but `flagged` stays FACTUAL: the lab did flag it, and the surfaces render that
    // truthfully alongside whatever tier the current evidence earns.
    const flagged = ms.some((m) => m?.latest?.flag === "low" || m?.latest?.flag === "high");
    const flaggedCurrent = currentMs.some((m) => m?.latest?.flag === "low" || m?.latest?.flag === "high");
    const compounding = currentMs.length >= 2 || dirs.some((d) => String(d.marker || "").includes("+"));
    const worsening = currentMs.some((m) => m?.forecast?.direction === "worsening");
    const maxDistance = currentMs.reduce((mx, m) => Math.max(mx, Number(m?.distance) || 0), 0);

    // The LEAD actionable move per domain (a non-uncertain directive wins). Computed
    // BEFORE the tier so an act-now requires real substance to act on (the gate below).
    const nut = leadMove(dirs, "nutrition");
    const trn = leadMove(dirs, "training");
    const wch = leadMove(dirs, "watch");
    const moves: FocusPriority["moves"] = {};
    if (nut.text) moves.nutrition = nut.text;
    if (trn.text) moves.training = trn.text;
    if (wch.text) moves.watch = wch.text;
    const anyActionable = !!(nut.text && !nut.uncertain) || !!(trn.text && !trn.uncertain);
    const uncertain = !anyActionable && (nut.uncertain || trn.uncertain || wch.uncertain);

    // AGING ACUTE: a group whose off-optimal markers are ALL acute-phase (hs-CRP, ESR…)
    // AND old is a point-in-time reading, not a current priority — it never leads act-now
    // (mirrors the connected-brain "aging lab findings" treatment); it stays a quiet track.
    const allAcuteStale =
      ms.length > 0 &&
      ms.every((m) => {
        if (!isAcuteMarker(m?.name)) return false;
        const dt = m?.latest?.date ? Date.parse(String(m.latest.date)) : Number.NaN;
        return Number.isFinite(dt) && (Date.now() - dt) / 864e5 > ACUTE_DIRECTIVE_STALE_DAYS;
      });

    // PAST ITS WINDOW: the same treatment, generalized per marker class — a group whose
    // off-optimal markers are ALL reading older than their own kind stays current for is
    // a picture from a while ago, not a current priority. It stays a quiet track item, so
    // the Brief can never headline "X is the priority right now" off evidence the
    // connected-brain block on the same page says not to act on.
    const allPastValidity = ms.length > 0 && currentMs.length === 0;

    // Tier score — flagged + compounding + how far out + worsening + near the top of the
    // panel's priority order. ≥3 ⇒ act now; else track. A lab flag is a STRONG floor (the
    // lab calling a value low/high is itself an act-now signal). No score is surfaced —
    // this only decides the plain-words tier.
    let score = 0;
    if (flaggedCurrent) score += 3;
    if (compounding) score += 2;
    if (maxDistance >= 0.4) score += 2;
    else if (maxDistance >= 0.2) score += 1;
    if (worsening) score += 1;
    if (currentRank < 6) score += 1; // among the panel's most-pressing CURRENT markers
    let tier: FocusTier = score >= 3 ? "act_now" : "track";
    // SUBSTANCE GATE: don't surface an ACT-NOW the athlete can't actually act on — a
    // compounding-but-moveless, unflagged, not-worsening group (e.g. an "Other Markers"
    // bucket) is a quiet track item, not a loud priority. Aging-acute is always track.
    if (tier === "act_now" && !flaggedCurrent && !anyActionable && !worsening) tier = "track";
    if (allAcuteStale || allPastValidity) tier = "track";

    // The athlete-facing clause names only what it is entitled to name: the two all-aged
    // branches speak ABOUT the old reading, and every other branch speaks about evidence
    // that is still current — never "Fasting Glucose and HbA1c sit off together" when the
    // glucose draw is one the same page says not to act on. (`named` falls back to `ms`
    // defensively; the branches below only run when currentMs is non-empty.)
    const named = currentMs.length ? currentMs : ms;
    const why = allAcuteStale
      ? `${ms[0]?.name} reads off, but it's a point-in-time marker from a while ago — worth a recheck before it shapes anything`
      : allPastValidity
        ? `${ms[0]?.name} reads off, but the reading behind it is older than this kind of marker stays current for — worth a recheck before it shapes anything`
        : compounding
          ? `${named[0]?.name}${named[1] ? ` and ${named[1]?.name}` : ""} sit off together — they move as one picture, so the same change shifts several at once`
          : flaggedCurrent
            ? `the lab flagged ${named[0]?.name}`
            : worsening
              ? `${named[0]?.name} has been drifting the wrong way`
              : `${named[0]?.name} is sitting outside its optimal range`;

    const readings: FocusReading[] = ms.slice(0, 4).map((m: any) => ({
      name: m.name,
      value: m?.latest?.value ?? null,
      unit: m.unit ?? null,
      flag: m?.latest?.flag ?? null,
      optimal: m.optimal ? [m.optimal.low, m.optimal.high] : null,
      in_optimal: m.in_optimal ?? null,
      trend: m?.trend?.dir ?? null,
      projection: m?.forecast?.eta_text ?? m?.trend?.projection ?? null,
    }));
    priorities.push({
      group: label,
      tier,
      markers: ms.map((m) => m.name),
      readings,
      flagged,
      compounding,
      worsening,
      moves,
      uncertain,
      why,
    });
  }

  // act_now first, then track; within a tier keep panel priority order (the Map
  // preserves first-seen rank, which is the marker order).
  priorities.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "act_now" ? -1 : 1));
  const actNow = priorities.filter((p) => p.tier === "act_now");
  const headline = actNow.length
    ? actNow.length === 1
      ? `${actNow[0].group} is the priority right now.`
      : `${actNow[0].group} and ${actNow[1].group.toLowerCase()} are the priorities right now.`
    : priorities.length
      ? "Nothing urgent — a few markers worth tracking."
      : "Your markers are reading clean.";

  // The CAPPED daily set: at most 3 act-now + 2 track, so every daily surface shows the
  // few things that matter, never a 9-item wall. The full set stays in `priorities` for
  // the deep Health → Read view; `lead` is the single most-important priority (the one voice).
  const surfaced = [...actNow.slice(0, 3), ...priorities.filter((p) => p.tier === "track").slice(0, 2)];
  return {
    priorities,
    surfaced,
    lead: priorities[0] ?? null,
    act_now: actNow.length,
    track: priorities.length - actNow.length,
    headline,
  };
}

// The latest agentic health-story synthesis (the elite-coach whole-picture read),
// cached in app_state so the Health → Read view opens instantly. coachOps.synthesizeHealth
// writes it; it's a pull artifact, refreshed on demand / when the picture changes.
const HEALTH_SYNTHESIS_KEY = "health_synthesis";

// ----------------------------------------------------------------------------
// DRIFT SIGNATURE — a cheap snapshot of the non-lab picture (training, recovery,
// directives, injuries) stamped onto the synthesis at save time so a LATER read
// can notice the whole picture moved, not just that a new document landed.
// Every component is either content-keyed or bucketed on purpose:
//  - directive_keys uses the STABLE `directive_key` family key, never the raw
//    autoincrement id — deriveDirectives() idempotently clears + rewrites the
//    'markers' source on every call, so identical content gets a brand-new id
//    each time; keying on id would read as constant "drift" for no real reason.
//  - session_count compares via a THRESHOLD (~a training week), not equality —
//    a single new session is normal, not a picture change.
//  - weight_bucket is a coarse up/down/flat/none read (least-squares slope over
//    21 days, ±0.75 lb/wk dead-band) so a 0.1 lb wiggle can't flip it.
//  - injury_ids is the active-injury id set (opens/closes are real events, not
//    daily churn).
// Deliberately excluded: daily_metrics, check-ins, and anything else that moves
// every single day by design — including those would make "stale" permanent,
// which is a constitution violation (this is a pull affordance, never a nag).
// Additive: an older cached synthesis with no `drift_sig` compares as "can't
// tell" → never reads stale from drift (only the pre-existing doc-date check
// can still flag it).
// ----------------------------------------------------------------------------
export interface HealthDriftSignature {
  directive_keys: string[];
  latest_review_id: number | null;
  session_count: number;
  weight_bucket: "up" | "down" | "flat" | "none";
  injury_ids: number[];
  nutrition_target: {
    id: number;
    effective_date: string;
    target_kcal: number | null;
    protein_g: number | null;
  } | null;
}

function latestNutritionTargetForDrift(today = localDateISO()): any | null {
  try {
    return db
      .prepare(
        `SELECT id, effective_date, target_kcal, protein_g, created_at
           FROM nutrition_targets WHERE effective_date <= ?
          ORDER BY effective_date DESC, id DESC LIMIT 1`
      )
      .get(today) as any;
  } catch {
    return null;
  }
}

function materialNutritionTargetChange(a: any, b: any): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  const kcalA = Number(a.target_kcal);
  const kcalB = Number(b.target_kcal);
  const proteinA = Number(a.protein_g);
  const proteinB = Number(b.protein_g);
  const kcalChanged = Number.isFinite(kcalA) && Number.isFinite(kcalB) ? Math.abs(kcalA - kcalB) >= 75 : kcalA !== kcalB;
  const proteinChanged = Number.isFinite(proteinA) && Number.isFinite(proteinB)
    ? Math.abs(proteinA - proteinB) >= 10
    : proteinA !== proteinB;
  return kcalChanged || proteinChanged;
}

function sqliteTime(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  return Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
}

// Backward-compatible bridge for syntheses saved before nutrition_target joined
// the drift signature. A materially different accepted target written after the
// synthesis makes its old kcal advice ineligible immediately.
function newerMaterialNutritionTargetThan(synthesis: any): boolean {
  const generated = sqliteTime(synthesis?.generated_at);
  if (!Number.isFinite(generated)) return false;
  try {
    const rows = db
      .prepare(
        `SELECT id, effective_date, target_kcal, protein_g, created_at
           FROM nutrition_targets
          ORDER BY effective_date DESC, id DESC LIMIT 2`
      )
      .all() as any[];
    const current = rows[0] ?? null;
    if (!current || sqliteTime(current.created_at) <= generated) return false;
    return materialNutritionTargetChange(current, rows[1] ?? null);
  } catch {
    return false;
  }
}

// Least-squares bodyweight trend over the last 21 days, bucketed. Mirrors the
// slope math in repo/sessions.ts getWeeklyStats but stays self-contained here
// (a separate leaf computation, not a shared import) so this file's drift
// signature has no coupling to that module's shape.
function weightTrendBucket(today: string): "up" | "down" | "flat" | "none" {
  const since = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const pts = db
    .prepare(`SELECT date, weight_lb FROM bodyweight_log WHERE date >= ? AND date <= ? ORDER BY date, id`)
    .all(since, today) as any[];
  if (pts.length < 2) return "none";
  const xs = pts.map((p) => Date.parse(String(p.date) + "T00:00:00Z") / 864e5);
  const ys = pts.map((p) => Number(p.weight_lb));
  if (xs[xs.length - 1] - xs[0] < 3) return "none"; // need ≥3 days of span to mean anything
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (!(den > 0)) return "none";
  const trendLbWk = (num / den) * 7; // lb/day -> lb/wk
  const BAND = 0.75; // lb/wk dead-band — a small wiggle must not flip the bucket
  return trendLbWk > BAND ? "up" : trendLbWk < -BAND ? "down" : "flat";
}

// Snapshot the non-lab picture right now. Never throws (a read failure just means
// "can't tell" — treated as no drift, never as manufactured staleness).
export function computeHealthDriftSignature(): HealthDriftSignature | null {
  try {
    const today = localDateISO();
    const directive_keys = (listActiveDirectives() as any[])
      .map((d) =>
        String(d?.directive_key || `${d?.domain || ""}:${d?.marker || ""}`)
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
      .sort();
    const reviewRow = db.prepare(`SELECT MAX(id) AS id FROM health_reviews`).get() as any;
    const latest_review_id = reviewRow?.id != null ? Number(reviewRow.id) : null;
    const sessRow = db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as any;
    const session_count = Number(sessRow?.c ?? 0);
    const weight_bucket = weightTrendBucket(today);
    const injury_ids = (
      db
        .prepare(
          `SELECT id FROM context_events
           WHERE kind = 'injury' AND archived = 0 AND (resolved_at IS NULL OR resolved_at > ?) AND (end_date IS NULL OR end_date >= ?)
           ORDER BY id`
        )
        .all(today, today) as any[]
    ).map((r) => Number(r.id));
    const target = latestNutritionTargetForDrift(today);
    const nutrition_target = target
      ? {
          id: Number(target.id),
          effective_date: String(target.effective_date),
          target_kcal: target.target_kcal == null ? null : Number(target.target_kcal),
          protein_g: target.protein_g == null ? null : Number(target.protein_g),
        }
      : null;
    return { directive_keys, latest_review_id, session_count, weight_bucket, injury_ids, nutrition_target };
  } catch {
    return null;
  }
}

const SESSION_DRIFT_THRESHOLD = 7; // ~a training week; a single new session must not flag

function sortedArraysDiffer(a: unknown, b: unknown): boolean {
  const sa = Array.isArray(a) ? [...a].sort() : [];
  const sb = Array.isArray(b) ? [...b].sort() : [];
  return JSON.stringify(sa) !== JSON.stringify(sb);
}

// Conservative, threshold-biased comparison between the signature stamped at
// generation time and the picture right now. Any single true trigger is enough
// (each one is already a meaningfully-sized change on its own — see the
// signature doc comment above for why each shape was chosen).
function hasMeaningfulDrift(saved: any): boolean {
  if (!saved || typeof saved !== "object") return false; // legacy synthesis, no signature → can't tell, not stale
  const current = computeHealthDriftSignature();
  if (!current) return false; // couldn't read the DB right now → can't tell, not stale

  if (sortedArraysDiffer(saved.directive_keys, current.directive_keys)) return true;
  if (sortedArraysDiffer(saved.injury_ids, current.injury_ids)) return true;
  if (
    Object.hasOwn(saved, "nutrition_target") &&
    Number(saved?.nutrition_target?.id ?? 0) !== Number(current?.nutrition_target?.id ?? 0) &&
    materialNutritionTargetChange(saved.nutrition_target, current.nutrition_target)
  ) {
    return true;
  }

  const savedSessions = Number(saved.session_count);
  if (Number.isFinite(savedSessions) && current.session_count - savedSessions >= SESSION_DRIFT_THRESHOLD) return true;

  const savedReview = saved.latest_review_id;
  if (
    typeof current.latest_review_id === "number" &&
    (typeof savedReview !== "number" || current.latest_review_id > savedReview)
  ) {
    return true;
  }

  // Only a flip BETWEEN two directional readings counts — crossing the minimum-data
  // floor (from 'none' to a real bucket, or the reverse) isn't itself a drift signal.
  const DIRECTIONAL = new Set(["up", "down", "flat"]);
  if (
    DIRECTIONAL.has(saved.weight_bucket) &&
    DIRECTIONAL.has(current.weight_bucket) &&
    saved.weight_bucket !== current.weight_bucket
  ) {
    return true;
  }

  return false;
}

export function saveHealthSynthesis(obj: any): void {
  try {
    setAppState(HEALTH_SYNTHESIS_KEY, JSON.stringify({ ...obj, drift_sig: computeHealthDriftSignature() }));
  } catch {
    /* never block */
  }
}
export function getHealthSynthesis(): any | null {
  const raw = getAppState(HEALTH_SYNTHESIS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function synthesisForStalePresentation(synthesis: any, reason: "new_labs" | "drift"): any {
  const priorities = Array.isArray(synthesis?.priorities)
    ? synthesis.priorities.map((priority: any) =>
        priority && typeof priority === "object" ? { ...priority, the_move: null } : priority
      )
    : synthesis?.priorities;
  return {
    ...synthesis,
    ...(priorities !== undefined ? { priorities } : {}),
    one_change: null,
    stale_note:
      reason === "new_labs"
        ? "New health results are in. Refresh this read before using its earlier action advice."
        : "Your current plan or signals have moved since this read. Refresh it before using its earlier action advice.",
  };
}

function staleSynthesisView(synthesis: any, reason: "new_labs" | "drift") {
  return { synthesis: synthesisForStalePresentation(synthesis, reason), stale: true, stale_reason: reason } as const;
}

// The cached synthesis plus a FRESHNESS verdict for the PWA. `stale` is true when
// EITHER: (1) a health document exists whose effective date is NEWER than the
// synthesis was last written against (source_doc_at, falling back to generated_at)
// — i.e. new labs have landed since the story was told (reason 'new_labs'); OR
// (2) the non-lab picture (training/recovery/directives/injuries) has drifted
// past a conservative threshold since generation (reason 'drift' — see
// hasMeaningfulDrift). Either way the Health → Read view can offer "re-read your
// picture". `stale_reason` is additive (existing consumers only read `stale`).
// false when there's no synthesis or nothing meaningfully newer. Never throws.
export function getHealthSynthesisView(): {
  synthesis: any | null;
  stale: boolean;
  stale_reason: "new_labs" | "drift" | null;
} {
  const synthesis = getHealthSynthesis();
  if (!synthesis) return { synthesis: null, stale: false, stale_reason: null };
  // Same source of truth the synthesis was stamped against (see coachOps), so the
  // stale comparison can't drift from how source_doc_at was derived.
  const newestDoc = newestHealthDocDate();
  // Compare on the day string. source_doc_at is a date (YYYY-MM-DD); generated_at is
  // an ISO timestamp — slice it to a day so a same-day generate doesn't read stale.
  const against =
    typeof synthesis.source_doc_at === "string" && synthesis.source_doc_at.trim()
      ? synthesis.source_doc_at.trim().slice(0, 10)
      : String(synthesis.generated_at ?? "").slice(0, 10);
  if (newestDoc && against && newestDoc > against) {
    return staleSynthesisView(synthesis, "new_labs");
  }
  if (newerMaterialNutritionTargetThan(synthesis)) {
    return staleSynthesisView(synthesis, "drift");
  }
  const drift = hasMeaningfulDrift(synthesis?.drift_sig);
  return drift ? staleSynthesisView(synthesis, "drift") : { synthesis, stale: false, stale_reason: null };
}

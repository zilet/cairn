import { getAppState, setAppState } from "./app-state.js";
import { listActiveDirectives } from "./coach.js";
import { newestHealthDocDate } from "./health.js";
import { markerGroup } from "./propagation-data.js";
import { ACUTE_DIRECTIVE_STALE_DAYS, annotateDirectiveFreshness, isAcuteMarker, prioritizeMarkers } from "./propagation.js";

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
  flag: string | null;            // lab flag (low/high) or null
  optimal: [number, number] | null; // evidence-based optimal band
  in_optimal: boolean | null;
  trend: string | null;           // rising/falling/stable
  projection: string | null;      // plain-language forecast vs optimal
}
export interface FocusPriority {
  group: string;                 // group label, e.g. "Lipids & Cardiovascular"
  tier: FocusTier;
  markers: string[];             // off-optimal marker names in this group, priority order
  readings: FocusReading[];      // the QUANTITATIVE detail (value/band/trend) — so the synthesis reasons on numbers, not names
  flagged: boolean;              // the lab itself flagged one low/high
  compounding: boolean;          // ≥2 markers off here (or a cross-marker cluster directive)
  worsening: boolean;            // a marker in this group is trending the wrong way
  moves: { nutrition?: string; training?: string; watch?: string }; // the LEAD directive per domain
  uncertain: boolean;            // the levers here are real-but-unsettled (softer nudge)
  why: string;                   // one plain clause
}
export interface HealthFocus {
  priorities: FocusPriority[];   // act_now first, then track; deduped to one per group (the FULL set, for the Health → Read view)
  surfaced: FocusPriority[];     // the CAPPED daily set (≤3 act-now + ≤2 track) — what every daily surface shows, so it's never a flood
  lead: FocusPriority | null;    // the single most important priority — the spine of the one coach voice everywhere
  act_now: number;
  track: number;
  headline: string;              // deterministic plain lead ("Lipids are the priority right now")
}

export function healthFocus(): HealthFocus {
  const { markers } = prioritizeMarkers(); // ordered: flagged-first then furthest-from-optimal
  // Off-optimal markers, in priority order, bucketed by health group (preserving rank).
  const groups = new Map<string, { markers: any[]; rank: number }>();
  markers.forEach((m: any, i: number) => {
    // Admit a marker when it sits OUT of its optimal band (in_optimal === false) OR
    // the lab itself flagged it low/high. A lab-flagged marker with NO optimal zone
    // (in_optimal === null) was previously dropped here — a flagged finding that
    // never reached the Brain. Only skip a clean in-optimal marker, or an
    // unflagged one we have no optimal band for (nothing to say).
    const flagged = m?.latest?.flag === "low" || m?.latest?.flag === "high";
    if (m?.in_optimal === true) return;                 // clearly in optimal — clean
    if (m?.in_optimal == null && !flagged) return;      // no band + not flagged — nothing to say
    const label = m.group_label || markerGroup(m?.name || "").label;
    if (!groups.has(label)) groups.set(label, { markers: [], rank: i });
    groups.get(label)!.markers.push(m);
  });

  // The active directives, bucketed to the same groups, so each priority carries
  // the lead actionable move per domain (a non-uncertain one wins over uncertain).
  const dirByGroup = new Map<string, any[]>();
  for (const d of annotateDirectiveFreshness(listActiveDirectives() as any[])) {
    if (d.stale) continue; // a stale acute directive (e.g. an old hs-CRP) no longer drives a move/tier
    const label = markerGroup(String(d.marker || "")).label;
    if (!dirByGroup.has(label)) dirByGroup.set(label, []);
    dirByGroup.get(label)!.push(d);
  }
  const leadMove = (dirs: any[], domain: string): { text?: string; uncertain: boolean } => {
    const inDomain = dirs.filter((d) => d.domain === domain);
    if (!inDomain.length) return { uncertain: false };
    const lead = inDomain.find((d) => !d.uncertain) || inDomain[0];
    return { text: String(lead.directive || "").trim().slice(0, 240), uncertain: !!lead.uncertain };
  };

  const priorities: FocusPriority[] = [];
  for (const [label, { markers: ms, rank }] of groups) {
    const dirs = dirByGroup.get(label) || [];
    const flagged = ms.some((m) => m?.latest?.flag === "low" || m?.latest?.flag === "high");
    const compounding = ms.length >= 2 || dirs.some((d) => String(d.marker || "").includes("+"));
    const worsening = ms.some((m) => m?.forecast?.direction === "worsening");
    const maxDistance = ms.reduce((mx, m) => Math.max(mx, Number(m?.distance) || 0), 0);

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
    const allAcuteStale = ms.length > 0 && ms.every((m) => {
      if (!isAcuteMarker(m?.name)) return false;
      const dt = m?.latest?.date ? Date.parse(String(m.latest.date)) : Number.NaN;
      return Number.isFinite(dt) && (Date.now() - dt) / 864e5 > ACUTE_DIRECTIVE_STALE_DAYS;
    });

    // Tier score — flagged + compounding + how far out + worsening + near the top of the
    // panel's priority order. ≥3 ⇒ act now; else track. A lab flag is a STRONG floor (the
    // lab calling a value low/high is itself an act-now signal). No score is surfaced —
    // this only decides the plain-words tier.
    let score = 0;
    if (flagged) score += 3;
    if (compounding) score += 2;
    if (maxDistance >= 0.4) score += 2; else if (maxDistance >= 0.2) score += 1;
    if (worsening) score += 1;
    if (rank < 6) score += 1; // among the panel's most-pressing markers
    let tier: FocusTier = score >= 3 ? "act_now" : "track";
    // SUBSTANCE GATE: don't surface an ACT-NOW the athlete can't actually act on — a
    // compounding-but-moveless, unflagged, not-worsening group (e.g. an "Other Markers"
    // bucket) is a quiet track item, not a loud priority. Aging-acute is always track.
    if (tier === "act_now" && !flagged && !anyActionable && !worsening) tier = "track";
    if (allAcuteStale) tier = "track";

    const why = allAcuteStale
      ? `${ms[0]?.name} reads off, but it's a point-in-time marker from a while ago — worth a recheck before it shapes anything`
      : compounding
        ? `${ms[0]?.name}${ms[1] ? ` and ${ms[1]?.name}` : ""} sit off together — they move as one picture, so the same change shifts several at once`
        : flagged
          ? `the lab flagged ${ms[0]?.name}`
          : worsening
            ? `${ms[0]?.name} has been drifting the wrong way`
            : `${ms[0]?.name} is sitting outside its optimal range`;

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
    priorities.push({ group: label, tier, markers: ms.map((m) => m.name), readings, flagged, compounding, worsening, moves, uncertain, why });
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
  return { priorities, surfaced, lead: priorities[0] ?? null, act_now: actNow.length, track: priorities.length - actNow.length, headline };
}

// The latest agentic health-story synthesis (the elite-coach whole-picture read),
// cached in app_state so the Health → Read view opens instantly. coachOps.synthesizeHealth
// writes it; it's a pull artifact, refreshed on demand / when the picture changes.
const HEALTH_SYNTHESIS_KEY = "health_synthesis";
export function saveHealthSynthesis(obj: any): void {
  try { setAppState(HEALTH_SYNTHESIS_KEY, JSON.stringify(obj)); } catch { /* never block */ }
}
export function getHealthSynthesis(): any | null {
  const raw = getAppState(HEALTH_SYNTHESIS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// The cached synthesis plus a FRESHNESS verdict for the PWA. `stale` is true when a
// health document exists whose effective date is NEWER than the synthesis was last
// written against (source_doc_at, falling back to generated_at) — i.e. new labs have
// landed since the story was told, so the Health → Read view can offer "re-read your picture".
// false when there's no synthesis or nothing newer. Reads the health_documents table
// directly (same db.prepare pattern as the rest of this file). Never throws.
export function getHealthSynthesisView(): { synthesis: any | null; stale: boolean } {
  const synthesis = getHealthSynthesis();
  if (!synthesis) return { synthesis: null, stale: false };
  // Same source of truth the synthesis was stamped against (see coachOps), so the
  // stale comparison can't drift from how source_doc_at was derived.
  const newestDoc = newestHealthDocDate();
  if (!newestDoc) return { synthesis, stale: false };
  // Compare on the day string. source_doc_at is a date (YYYY-MM-DD); generated_at is
  // an ISO timestamp — slice it to a day so a same-day generate doesn't read stale.
  const against = (typeof synthesis.source_doc_at === "string" && synthesis.source_doc_at.trim())
    ? synthesis.source_doc_at.trim().slice(0, 10)
    : String(synthesis.generated_at ?? "").slice(0, 10);
  const stale = !!against && newestDoc > against;
  return { synthesis, stale };
}

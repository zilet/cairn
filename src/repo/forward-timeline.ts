// The road ahead: ONE deterministic, dated forward-looking read.
//
// Everything the athlete is heading toward is scattered across the app — a goal
// date buried in the profile, phase projections inside the recomposition read,
// lab/strength re-check windows living only in the attention schedule, DEXA
// baselines nobody re-scans, strength standards a lift is drifting toward. This
// composes them into one ordered timeline of dated checkpoints, soft windows,
// and undated "on the horizon" direction-of-travel entries.
//
// Constitution: this is a calm plan, never a countdown or a verdict. No score,
// no percent-complete, no urgency geometry. An entry NEVER fabricates a date it
// does not have — a projection is a WINDOW, a standards milestone is undated.
import { effectiveGoalMode, getProfile, normalizeEnduranceGoal } from "./profile.js";
import { getActiveBlock } from "./program-blocks.js";
import { getProgramState, type ProgramState } from "./program-state.js";
import { activeJourneyPhase } from "./journey.js";
import { recompositionRead, type RecompositionRead } from "./recomposition.js";
import { EXPECTATION_FOLLOWUP_SOURCE, listAttentionSchedule, type AttentionScheduleEntry } from "./attention.js";
import { getMarkerHistory } from "./health.js";
import { matchOptimalZone } from "./propagation-data.js";
import { canonicalMarker } from "./marker-canon.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { currentLiftCapacities } from "./performance.js";
import { strengthBenchmarkMilestones, type StrengthMilestoneInput } from "./training-milestones.js";
import { followupLabel, markerSlugFromSignalKey } from "./attention-labels.js";
import { dexaRescanWindow, latestDexaDate } from "./dexa-window.js";
import { addDaysISO, clipText, daysBetweenISO, localDateISO } from "./shared.js";

export type ForwardTimelineKind = "goal" | "phase" | "recheck" | "retest" | "rescan" | "milestone" | "block";

export interface ForwardTimelineWhen {
  // An exact calendar date, when one is actually known (a declared goal date, a
  // scheduled attention re-check, a program block boundary).
  date?: string | null;
  // A soft band for an estimate that must never read as a promise (a phase-end
  // projection, a "worth considering" DEXA re-scan window).
  window?: { start: string; end: string } | null;
}

export interface ForwardTimelineEntry {
  id: string;
  kind: ForwardTimelineKind;
  when: ForwardTimelineWhen;
  label: string;
  detail: string | null;
  // Confidence expressed in words, never a number — how firm the date/window is.
  basis: string;
}

interface ForwardTimelineOpts {
  // Reuse an already-computed recomposition read (the journey surface has one) so
  // the phase projection is not recomputed. Omit to compute a fresh read.
  recomposition?: RecompositionRead;
  programState?: ProgramState;
  profile?: any;
}

// How far ahead scheduled attention checkpoints are pulled in. Beyond this the
// road is too speculative to plan calmly. A recently-passed due date is still
// actionable, so a small backward grace is allowed.
const HORIZON_DAYS = 210;
const OVERDUE_GRACE_DAYS = 30;
const MAX_RECHECKS = 3;
const MAX_RETESTS = 3;
const MAX_MILESTONES = 2;

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clip(text: unknown, max = 200): string {
  return clipText(text, max, { collapseWhitespace: true, ellipsis: "..." });
}

// Mirror of doctor-loop's health signal slug so a `marker:<slug>` key resolves
// back to its display label, and training-milestones' lift slug so a
// `training:strength:<slug>` key resolves back to the exercise.
function healthSlug(value: unknown): string {
  return (
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "signal"
  );
}

function liftSlug(text: string): string {
  return (
    normalizedExerciseKey(text || "benchmark")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "benchmark"
  );
}

function prettifySlug(slug: string): string {
  const acronyms: Record<string, string> = {
    apob: "ApoB",
    ldl: "LDL-C",
    "ldl-c": "LDL-C",
    hdl: "HDL-C",
    "hdl-c": "HDL-C",
    hba1c: "HbA1c",
    "hs-crp": "hs-CRP",
    crp: "hs-CRP",
    tsh: "TSH",
    egfr: "eGFR",
    alt: "ALT",
    ast: "AST",
    ggt: "GGT",
    "lp-a": "Lp(a)",
    lpa: "Lp(a)",
    vo2max: "VO2max",
  };
  if (acronyms[slug]) return acronyms[slug];
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => (acronyms[part] ? acronyms[part] : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

// Reproduce doctor-loop's markerLabel from the marker rows on file so a health
// attention entry keyed by `marker:<slug>` gets its real, cased display name.
function healthLabelMap(): Map<string, string> {
  const map = new Map<string, string>();
  let markers: any[] = [];
  try {
    markers = (getMarkerHistory().markers as any[]) ?? [];
  } catch {
    markers = [];
  }
  for (const marker of markers) {
    const raw = String(marker?.name ?? marker?.key ?? "");
    if (!raw) continue;
    const label = matchOptimalZone(raw)?.label ?? canonicalMarker(raw).name ?? raw;
    const key = `marker:${healthSlug(label)}`;
    if (!map.has(key)) map.set(key, label);
  }
  return map;
}

function liftLabelMap(programState: ProgramState): Map<string, string> {
  const map = new Map<string, string>();
  for (const lift of programState.lifts || []) {
    const name = String((lift as any)?.exercise ?? "").trim();
    if (!name) continue;
    const key = `training:strength:${liftSlug(name)}`;
    if (!map.has(key)) map.set(key, name);
  }
  return map;
}

// A scheduled attention checkpoint is on the road ahead when its next_due sits
// inside the forward horizon (a small backward grace keeps a just-passed re-check
// visible instead of silently dropping it).
function inHorizon(nextDue: string | null, today: string): boolean {
  const d = iso(nextDue);
  if (!d) return false;
  const delta = daysBetweenISO(d, today);
  return delta != null && delta >= -OVERDUE_GRACE_DAYS && delta <= HORIZON_DAYS;
}

function attentionBasis(entry: AttentionScheduleEntry, today: string): string {
  const d = iso(entry.next_due);
  const delta = d ? daysBetweenISO(d, today) : null;
  if (delta != null && delta <= 0) return "due now, on your checkpoint list";
  if (entry.tier === "active") return "on the active follow-up cadence";
  return "a scheduled checkpoint, not urgent";
}

function attentionDetail(entry: AttentionScheduleEntry): string | null {
  const reason = clip(entry.reason, 180);
  return reason || null;
}

// A sort key for chronological ordering: dated entries by their date, window
// entries by the window start, undated (horizon) entries always last.
function sortKey(entry: ForwardTimelineEntry): string {
  return entry.when.date ?? entry.when.window?.start ?? "9999-12-31";
}

const KIND_RANK: Record<ForwardTimelineKind, number> = {
  recheck: 0,
  retest: 1,
  rescan: 2,
  block: 3,
  phase: 4,
  goal: 5,
  milestone: 9,
};

export function forwardTimeline(today = localDateISO(), opts: ForwardTimelineOpts = {}): ForwardTimelineEntry[] {
  const profile = opts.profile ?? getProfile();
  if (!profile) return [];

  const programState = opts.programState ?? getProgramState(today);
  const mode = effectiveGoalMode(profile);
  const activePhase = (() => {
    try {
      return activeJourneyPhase();
    } catch {
      return null;
    }
  })();
  const recomposition =
    opts.recomposition ??
    (() => {
      try {
        return recompositionRead(today, { activePhase, programState });
      } catch {
        return null;
      }
    })();

  const dated: ForwardTimelineEntry[] = [];
  const horizon: ForwardTimelineEntry[] = [];

  // ---- the declared goal (a commitment, only when a real date exists) --------
  const goalDate = iso(profile.goal_date);
  const goalWeight = Number(profile.goal_weight_lb);
  if (goalDate && Number.isFinite(goalWeight) && goalWeight > 0 && mode === "lose") {
    const delta = daysBetweenISO(goalDate, today);
    if (delta != null && delta >= -OVERDUE_GRACE_DAYS) {
      dated.push({
        id: "goal:weight",
        kind: "goal",
        when: { date: goalDate },
        label: `Goal: ${round1(goalWeight)} lb`,
        detail: "The target date you set for yourself.",
        basis: "your declared goal date",
      });
    }
  }

  // A dated endurance event is a temporary calendar overlay, not the athlete's
  // durable training identity. Keeping it on the road ahead makes the event
  // visible without letting it silently redefine what all training is for.
  const enduranceGoal = normalizeEnduranceGoal(profile.endurance_goal_json);
  if (enduranceGoal?.mode === "race" && enduranceGoal.date) {
    const delta = daysBetweenISO(enduranceGoal.date, today);
    if (delta != null && delta >= -OVERDUE_GRACE_DAYS) {
      const distance =
        enduranceGoal.distance_km != null ? `${round1(enduranceGoal.distance_km)} km` : null;
      const target = enduranceGoal.target ? clip(enduranceGoal.target, 60) : null;
      dated.push({
        id: "goal:endurance-race",
        kind: "goal",
        when: { date: enduranceGoal.date },
        label: enduranceGoal.event ? clip(enduranceGoal.event, 80) : "Endurance event",
        detail:
          [distance, target].filter(Boolean).join(" · ") ||
          "A temporary event goal within your longer-term training direction.",
        basis: "your declared event date",
      });
    }
  }

  // ---- the phase projection (a WINDOW, never a promise) ----------------------
  const timeline = recomposition?.progress?.timeline ?? null;
  const projGoal = recomposition?.progress?.goal_weight_lb ?? null;
  if (timeline && timeline.latest_weeks > 0) {
    const start = addDaysISO(today, timeline.earliest_weeks * 7);
    const end = addDaysISO(today, timeline.latest_weeks * 7);
    if (start && end) {
      const confidence = timeline.confidence;
      const basis =
        confidence === "high"
          ? "a firm estimate at the current pace"
          : confidence === "medium"
            ? "an estimate at the current pace"
            : "an early estimate, still settling";
      dated.push({
        id: "phase:projection",
        kind: "phase",
        when: { window: { start, end } },
        label: projGoal != null ? `On pace toward ${round1(projGoal)} lb` : "On pace toward your target",
        detail: `About ${timeline.earliest_weeks}–${timeline.latest_weeks} weeks out${
          timeline.includes_stabilization ? ", including room to stabilize at the end" : ""
        }.`,
        basis,
      });
    }
  }

  // ---- DEXA re-scan window (computed from the baseline, worth considering) ----
  let markers: any[] = [];
  try {
    markers = (getMarkerHistory().markers as any[]) ?? [];
  } catch {
    markers = [];
  }
  const dexaBaseline = latestDexaDate(markers);
  const stageKind = recomposition?.stage?.kind ?? null;
  const rescanWarranted =
    mode === "lose" || stageKind === "early_cut" || stageKind === "mid_cut" || stageKind === "leaning_out";
  const rescanWindow = dexaBaseline ? dexaRescanWindow(dexaBaseline) : null;
  if (rescanWindow && rescanWarranted) {
    const { start, end } = rescanWindow;
    const endDelta = daysBetweenISO(end, today);
    if (endDelta != null && endDelta >= -OVERDUE_GRACE_DAYS) {
      dated.push({
        id: "rescan:dexa",
        kind: "rescan",
        when: { window: { start, end } },
        label: "DEXA re-scan worth considering",
        detail:
          "Roughly 12–16 weeks on from your last body-composition scan — a good moment to re-anchor fat and lean mass. Worth planning, not a deadline.",
        basis: "worth considering, not a deadline",
      });
    }
  }

  // ---- program block boundary -------------------------------------------------
  try {
    const block = getActiveBlock();
    if (block && Number(block.total_weeks) > 0 && Number(block.week_index) < Number(block.total_weeks)) {
      const started = iso(block.started_at) ?? String(block.started_at ?? "").slice(0, 10);
      const end = started ? addDaysISO(started, Number(block.total_weeks) * 7) : null;
      const delta = end ? daysBetweenISO(end, today) : null;
      if (end && delta != null && delta >= -OVERDUE_GRACE_DAYS) {
        dated.push({
          id: "block:boundary",
          kind: "block",
          when: { date: end },
          label: "Training block wraps up",
          detail: `Week ${Number(block.week_index)} of ${Number(block.total_weeks)} · ${clip(block.focus, 40)} focus.`,
          basis: "your program block schedule",
        });
      }
    }
  } catch {
    /* no active block */
  }

  // ---- scheduled lab re-checks (attention_schedule, health domain) -----------
  const labels = healthLabelMap();
  const healthEntries = listAttentionSchedule({ domain: "health", limit: 60 })
    .filter((entry) => inHorizon(entry.next_due, today))
    .sort((a, b) => String(a.next_due).localeCompare(String(b.next_due)));
  const seenRecheck = new Set<string>();
  for (const entry of healthEntries) {
    if (dated.filter((e) => e.kind === "recheck").length >= MAX_RECHECKS) break;
    const isFollowup = entry.signal_key.startsWith("review-followup:");
    const label = isFollowup
      ? (followupLabel(entry.reason) ?? "Lab follow-up from your last review")
      : `${labels.get(entry.signal_key) ?? prettifySlug(entry.signal_key.replace(/^marker:/, ""))} re-check`;
    // Dedupe at the MARKER level, not the display label: a marker's periodic cadence
    // recheck (`marker:hs-crp`) and a review follow-up on that same marker
    // (`review-followup:hs-crp:…`) carry different labels but are one story. Entries
    // are ascending by next_due, so the first seen (soonest) wins. A signal with no
    // real marker slug (a dexa signal, or a sentinel non-marker follow-up) falls back to
    // its FULL signal_key so distinct follow-ups are never collapsed into one.
    const dedupeKey = markerSlugFromSignalKey(entry.signal_key) ?? entry.signal_key;
    if (seenRecheck.has(dedupeKey)) continue;
    seenRecheck.add(dedupeKey);
    dated.push({
      id: `recheck:${entry.signal_key}`,
      kind: "recheck",
      when: { date: iso(entry.next_due) },
      label,
      detail: attentionDetail(entry),
      basis: attentionBasis(entry, today),
    });
  }

  // ---- scheduled strength / endurance re-tests (training + running) ----------
  const lifts = liftLabelMap(programState);
  const retestSlugs = new Set<string>();
  const trainingEntries = [
    ...listAttentionSchedule({ domain: "training", limit: 40 }),
    ...listAttentionSchedule({ domain: "running", limit: 15 }),
  ]
    // A "that change hasn't landed" follow-up rides the same schedule but is not a
    // scheduled re-test — it has no benchmark to redo and no date to plan around.
    // It speaks through the coach's watch list instead of this dated horizon.
    .filter((entry) => entry.source !== EXPECTATION_FOLLOWUP_SOURCE)
    .filter((entry) => inHorizon(entry.next_due, today))
    .sort((a, b) => String(a.next_due).localeCompare(String(b.next_due)));
  const seenRetest = new Set<string>();
  for (const entry of trainingEntries) {
    if (dated.filter((e) => e.kind === "retest").length >= MAX_RETESTS) break;
    let label: string;
    if (entry.signal_key === "training:strength:test-week") label = "Strength test week";
    else if (entry.signal_key === "training:endurance:benchmark") label = "Endurance benchmark";
    else if (entry.signal_key.startsWith("training:strength:")) {
      const slug = entry.signal_key.slice("training:strength:".length);
      retestSlugs.add(slug);
      label = `${lifts.get(entry.signal_key) ?? prettifySlug(slug)} re-test`;
    } else label = prettifySlug(entry.signal_key.replace(/^.*:/, ""));
    if (seenRetest.has(label)) continue;
    seenRetest.add(label);
    dated.push({
      id: `retest:${entry.signal_key}`,
      kind: "retest",
      when: { date: iso(entry.next_due) },
      label,
      detail: attentionDetail(entry),
      basis: attentionBasis(entry, today),
    });
  }

  // ---- nearest strength standards (undated, direction of travel) -------------
  try {
    const capacities = currentLiftCapacities({ programState });
    const milestones = strengthBenchmarkMilestones(capacities as unknown as StrengthMilestoneInput[]);
    for (const milestone of milestones) {
      if (horizon.length >= MAX_MILESTONES) break;
      const slug = milestone.exercise ? liftSlug(milestone.exercise) : "";
      if (slug && retestSlugs.has(slug)) continue; // already dated as a re-test
      horizon.push({
        id: `milestone:${milestone.id}`,
        kind: "milestone",
        when: {},
        label: clip(milestone.title, 80),
        detail: clip(milestone.why, 200) || null,
        basis: "direction of travel, not a deadline",
      });
    }
  } catch {
    /* capacities unavailable → no horizon milestones */
  }

  dated.sort((a, b) => {
    const byDate = sortKey(a).localeCompare(sortKey(b));
    if (byDate !== 0) return byDate;
    return KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.label.localeCompare(b.label);
  });

  return [...dated, ...horizon];
}

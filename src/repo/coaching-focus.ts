// ============================================================================
// coaching-focus.ts — THE CONDUCTOR. The whole-athlete analog of healthFocus().
//
// Cairn holds the whole picture (training capacity, running, DEXA body comp, labs,
// recovery, nutrition, the long game) and each domain read is excellent — but until
// now nothing arbitrated ACROSS them. Health had healthFocus() (act_now/track tiers,
// one lead); training/running/DEXA/nutrition/recovery never did, so every plan prompt
// concatenated ~14 self-asserting "lead with me" blocks with no conductor.
//
// An elite coach does the opposite of a dashboard: holds everything, ACTS on 1-3
// SEQUENCED priorities, CONNECTS the domains, and says out loud what's DEFERRED
// ("we'll retest the squat at week 8"). This module is that conductor: a pure,
// deterministic pass over the already-computed domain reads that emits ONE lead lever,
// 1-2 things handled in parallel (usually through a different lever, e.g. diet), an
// explicit "later" sequence, the cross-domain connections, and ONE batched retest
// checkpoint — so the brain and the interface can both LEAD with the same focus.
//
// Constitution: leverage is INTERNAL ordering only (never surfaced — like marker
// impact_score). Plain words, no 0-100 score. Suggestion, never a gate. Everything
// is consumed via opts (the reads getCoachContext already built once) so this never
// recomputes a heavy view, and every field is read null-safe so it degrades to
// {available:false} on a thin athlete.
// ============================================================================

export type FocusDomain = "training" | "running" | "nutrition" | "health" | "recovery" | "body";

export interface FocusItem {
  domain: FocusDomain;
  title: string;
  why: string;
  move?: string;
}

export interface CoachingRetest {
  in_weeks: number | null; // 0 = a check-in week is due now
  focus: string[]; // the batched things to re-test (lifts + a run test), not piecemeal
  why: string;
}

export interface CoachingFocus {
  available: boolean;
  headline: string; // where you are + the through-line, one sentence
  lead: FocusItem | null; // THE single highest-leverage lever this block
  parallel: FocusItem[]; // 1-2 handled simultaneously, usually via a different lever
  later: { domain: FocusDomain; title: string }[]; // explicitly deferred — the sequence
  connections: string[]; // 1-2 plain cross-domain ties
  retest: CoachingRetest | null; // ONE batched check-in, not four nag feeds
  horizon_weeks: number | null;
}

export interface CoachingFocusInput {
  discipline?: any;
  enduranceGoal?: any;
  goalMode?: string;
  programState?: any;
  recovery?: any;
  healthFocus?: any;
  performance?: any;
  programAdjustments?: any[];
  runPlan?: any;
  runVariety?: any;
  dexa?: any;
  groupsTrajectory?: any;
  trajectory?: any;
  testWeek?: any;
  enduranceTests?: any[];
}

interface Candidate {
  item: FocusItem;
  leverage: number; // INTERNAL ordering only — never surfaced
  slot: "lead" | "parallel" | "later";
  key: string;
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function lc(s: any): string {
  return String(s ?? "").trim().toLowerCase();
}
function clip(s: any, n: number): string {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

// ---- candidate generation: one read per domain, each scored for internal ranking ----

function recoveryCandidate(inp: CoachingFocusInput): Candidate | null {
  const meso = inp.programState?.mesocycle;
  const phase = lc(meso?.phase);
  const deloadDue = phase.includes("deload");
  const hrv = num(inp.recovery?.delta?.hrv);
  const rhr = num(inp.recovery?.delta?.rhr);
  const recoveringDown = hrv != null && hrv < 0 && rhr != null && rhr > 2;
  if (!deloadDue && !recoveringDown) return null;
  return {
    key: "recovery-deload",
    leverage: 5,
    slot: "lead",
    item: {
      domain: "recovery",
      title: "Take an earned recovery week",
      why:
        meso?.note ||
        "Your recent load and recovery signals say a lighter week now pays off — back volume off ~40%, keep the intensity crisp, and you'll come back stronger. This is the performance-building choice, not a step back.",
    },
  };
}

function trainingCandidate(inp: CoachingFocusInput): Candidate | null {
  // A genuinely STALLED canonical group with a concrete swap menu is the most
  // coach-like training lead (the athlete's own "which groups stall" framing).
  const groups: any[] = Array.isArray(inp.groupsTrajectory?.groups) ? inp.groupsTrajectory.groups : [];
  const stalled = groups.find((g) => lc(g?.verdict) === "stalling" && (g?.lead_lift || g?.label));
  if (stalled) {
    // vary_options are {name, why} objects — pull the movement NAME (a bare
    // String(o) renders "[object Object]"). Tolerate a plain-string option too.
    const opts = (Array.isArray(stalled.vary_options) ? stalled.vary_options : [])
      .slice(0, 2)
      .map((o: any) => (o && typeof o === "object" ? o.name : o))
      .filter(Boolean)
      .map((s: any) => String(s));
    const label = lc(stalled.label || stalled.group);
    return {
      key: "training-stall",
      leverage: 4.2,
      slot: "lead",
      item: {
        domain: "training",
        title: `Break the plateau on your ${label}`,
        why: `${stalled.lead_lift || label} has stalled${stalled.stalled_signal ? ` (${lc(stalled.stalled_signal)})` : ""} — change the stimulus rather than grinding the same load.`,
        move: opts.length ? `Rotate in ${opts.join(" or ")} for a few weeks.` : undefined,
      },
    };
  }
  // Else the capacity laggard (the one lift furthest behind for the athlete's age).
  const lever = inp.performance?.lever;
  if (lever?.headline) {
    return {
      key: "training-lever",
      leverage: 3.8,
      slot: "lead",
      item: {
        domain: "training",
        title: String(lever.headline),
        why: String(lever.why || "Focused volume on your furthest-behind lift is where the easiest, most motivating progress is."),
        move: lever.target ? String(lever.target) : undefined,
      },
    };
  }
  return null;
}

function runningCandidate(inp: CoachingFocusInput): Candidate | null {
  const goal = inp.enduranceGoal;
  const end = inp.performance?.endurance;
  const phase = lc(goal?.phase);
  // A dated race in build/sharpen is time-bound — high leverage, lead-eligible.
  // (getEnduranceGoal discriminates on `is_race`/`mode`, never a `kind` field.)
  if (goal?.is_race && (phase === "build" || phase === "sharpen")) {
    return {
      key: "running-race",
      leverage: 4.0,
      slot: "lead",
      item: {
        domain: "running",
        title: phase === "sharpen" ? "Sharpen for your race" : "Build toward your race",
        why:
          inp.runPlan?.why ||
          `You're in the ${phase} phase — this week's mix matters: the quality session drives fitness, the long run builds durability, the easy runs protect recovery.`,
        move: inp.runPlan?.quality_focus ? `This week's quality focus: ${lc(inp.runPlan.quality_focus)}.` : undefined,
      },
    };
  }
  // A low aerobic base is the single biggest endurance + longevity lever.
  if (lc(end?.tone) === "watch") {
    return {
      key: "running-aerobic",
      leverage: 3.6,
      slot: "lead",
      item: {
        domain: "running",
        title: "Lift your aerobic base",
        why: "VO2max is the biggest single lever you have for both endurance and longevity — one weekly quality session moves it while the easy runs build the engine underneath.",
        move: inp.runPlan?.quality_focus ? `Start with ${lc(inp.runPlan.quality_focus)} this week.` : undefined,
      },
    };
  }
  // Otherwise the week's quality run rides alongside whatever leads (a parallel item).
  if (inp.runPlan?.available && inp.runPlan?.quality_focus) {
    return {
      key: "running-quality",
      leverage: 2.4,
      slot: "parallel",
      item: {
        domain: "running",
        title: `This week's quality run: ${lc(inp.runPlan.quality_focus)}`,
        why: clip(inp.runPlan.why || inp.runPlan.mix_summary || "Keep the easy runs easy so the one quality session lands.", 200),
      },
    };
  }
  return null;
}

function healthCandidate(inp: CoachingFocusInput): Candidate | null {
  const lead = inp.healthFocus?.lead;
  if (!lead?.group) return null;
  const actNow = lc(lead.tier) === "act_now";
  const moves = lead.moves || {};
  const move = moves.nutrition || moves.training || moves.watch;
  const viaNutrition = !!moves.nutrition;
  return {
    key: "health-lead",
    leverage: actNow ? 4.0 : 2.6,
    // Health is usually addressed through diet/lifestyle, so it runs PARALLEL to
    // training rather than displacing it — but a true act_now with no training lead
    // can be promoted to lead by the selector below.
    slot: "parallel",
    item: {
      domain: viaNutrition ? "nutrition" : "health",
      title: `Move your ${lc(lead.group)}`,
      why: clip(lead.why || (inp.healthFocus?.headline ?? ""), 220),
      move: move ? clip(move, 240) : undefined,
    },
  };
}

function dexaCandidate(inp: CoachingFocusInput): Candidate | null {
  const d = inp.dexa;
  if (!d?.available || !d.lead) return null;
  // If the performance lever already promoted THIS DEXA signal to the training lead
  // (a training-domain bone/lean target), don't also surface it as a parallel item —
  // the conductor's whole job is to dedupe a finding across domains, not echo it.
  if (lc(inp.performance?.lever?.headline).startsWith("from your dexa")) return null;
  const t = d.lead;
  const sig = lc(t.signal);
  const bone = /bmd|bone|osteo|t-?score|z-?score/.test(sig) || /bone|bmd/.test(lc(t.area));
  const visceral = /visceral|android|trunk|central/.test(sig) || lc(t.domain) === "nutrition";
  const domain: FocusDomain = visceral ? "nutrition" : bone ? "health" : "training";
  return {
    key: "dexa-lead",
    leverage: bone ? 3.4 : visceral ? 2.8 : 2.6,
    slot: "parallel",
    item: {
      domain,
      title: `From your DEXA: ${clip(t.area, 60)}`,
      why: clip(t.bias || t.signal || "", 220),
      move: t.path ? clip(t.path, 240) : undefined,
    },
  };
}

function bodyCandidate(inp: CoachingFocusInput): Candidate | null {
  if (lc(inp.goalMode) !== "lose") return null;
  return {
    key: "body-deficit",
    leverage: 2.0,
    slot: "parallel",
    item: {
      domain: "nutrition",
      title: "Hold a lean-safe deficit",
      why: "Keep the deficit modest and protein high so the weight that comes off is fat, not the muscle you're working to build.",
    },
  };
}

function laterCandidates(inp: CoachingFocusInput): Candidate[] {
  const out: Candidate[] = [];
  // Mono-stimulus running → add variety, but only once the lead/parallel is set.
  if (inp.runVariety?.note) {
    out.push({ key: "later-run-variety", leverage: 1.6, slot: "later", item: { domain: "running", title: "Add variety to your runs", why: clip(inp.runVariety.note, 180) } });
  }
  // A second stalled/building group beyond the lead.
  const groups: any[] = Array.isArray(inp.groupsTrajectory?.groups) ? inp.groupsTrajectory.groups : [];
  const stalledOthers = groups.filter((g) => lc(g?.verdict) === "stalling");
  if (stalledOthers.length > 1) {
    const g = stalledOthers[1];
    out.push({ key: "later-group", leverage: 1.5, slot: "later", item: { domain: "training", title: `Then revisit your ${lc(g.label || g.group)}`, why: "Address it after the lead lift is moving again — one plateau at a time." } });
  }
  // The widest strength imbalance (rounding-out work, deferred).
  const imb = Array.isArray(inp.performance?.imbalances) ? inp.performance.imbalances[0] : null;
  if (imb?.title) {
    out.push({ key: "later-imbalance", leverage: 1.4, slot: "later", item: { domain: "training", title: clip(imb.title, 60), why: clip(imb.why || "", 180) } });
  }
  // A "due" muscle group from the balance digest.
  const dueAdj = (inp.programAdjustments || []).find((a: any) => a?.kind === "balance" && /due/i.test(String(a?.title || "")));
  if (dueAdj) {
    out.push({ key: "later-due", leverage: 1.3, slot: "later", item: { domain: "training", title: clip(dueAdj.title, 60), why: clip(dueAdj.why || "", 180) } });
  }
  return out;
}

// ---- the cross-domain connections: how an elite coach ties the levers together ----

function buildConnections(lead: FocusItem | null, parallel: FocusItem[], inp: CoachingFocusInput): string[] {
  const out: string[] = [];
  const all = [lead, ...parallel].filter(Boolean) as FocusItem[];
  const has = (d: FocusDomain) => all.some((x) => x.domain === d);
  const titles = all.map((x) => lc(x.title)).join(" ");

  // Lipids/metabolic via diet, while a deficit is also running → one change, two wins.
  if (has("nutrition") && /lipid|cholesterol|apob|glucose|hba1c|triglyceride|metabolic/.test(`${titles} ${lc(inp.healthFocus?.lead?.group)}`) && lc(inp.goalMode) === "lose") {
    out.push("The higher-fiber, oily-fish eating that runs your deficit is the same lever that moves your lipids — one change, two wins.");
  }
  // Aerobic work doubles as the biggest longevity lever.
  if (has("running")) {
    out.push("Your aerobic work is doing double duty here — it's race/endurance fitness AND the single biggest longevity lever you have.");
  }
  // DEXA-flagged low lean ↔ the leg/strength work that's leading.
  if (has("training") && inp.dexa?.available && /lean/.test(lc(inp.dexa?.lead?.signal))) {
    out.push("The strength work leading this block also rebuilds the lean mass your DEXA flagged — same effort, two payoffs.");
  }
  // Strength leads, running rides alongside as easy volume.
  if (lead?.domain === "training" && has("running") && out.length < 2) {
    out.push("Strength leads this block; the running sits alongside as mostly-easy aerobic volume so it builds you without stealing recovery from the lifts.");
  }
  return out.slice(0, 2);
}

// ---- the unified retest checkpoint (batched, not four separate nag feeds) ----

function buildRetest(inp: CoachingFocusInput): CoachingRetest | null {
  const focus: string[] = [];
  if (inp.testWeek?.due) {
    for (const l of inp.testWeek.key_lifts || []) focus.push(String(l));
  }
  for (const t of inp.enduranceTests || []) {
    if (t?.exercise) focus.push(String(t.exercise));
  }
  for (const t of inp.performance?.tests_due || []) {
    if (t?.exercise && t.kind !== "endurance") focus.push(String(t.exercise));
  }
  const dedup = [...new Set(focus.map((f) => f.trim()).filter(Boolean))].slice(0, 4);
  if (!dedup.length) return null;
  return {
    in_weeks: inp.testWeek?.due ? 0 : 1,
    focus: dedup,
    why: "Batch these into one check-in week so you're re-testing every ~6–8 weeks — enough to see real change, not so often it interrupts the work.",
  };
}

// ---- the conductor ----------------------------------------------------------

export function coachingFocus(input: CoachingFocusInput = {}): CoachingFocus {
  const candidates: Candidate[] = [
    recoveryCandidate(input),
    trainingCandidate(input),
    runningCandidate(input),
    healthCandidate(input),
    dexaCandidate(input),
    bodyCandidate(input),
    ...laterCandidates(input),
  ].filter((c): c is Candidate => c != null);

  // LEAD: the single highest-leverage lead-eligible candidate. Tie-break order is
  // baked into the leverage scores (recovery-deload > training stall > running >
  // health act_now). If nothing is lead-eligible but a strong parallel exists
  // (e.g. a health act_now on an otherwise-steady athlete), promote it.
  const leadEligible = candidates.filter((c) => c.slot === "lead").sort((a, b) => b.leverage - a.leverage);
  let lead = leadEligible[0] ?? null;
  if (!lead) {
    const strong = candidates.filter((c) => c.leverage >= 3.5).sort((a, b) => b.leverage - a.leverage)[0];
    lead = strong ?? null;
  }
  const leadKey = lead?.key;
  const leadDomain = lead?.item.domain;

  // PARALLEL: up to 2 of the rest, on a DIFFERENT lever than the lead (so they can
  // genuinely be worked simultaneously — e.g. diet handles lipids while you train).
  const parallel = candidates
    .filter((c) => c.key !== leadKey && c.slot !== "later" && c.item.domain !== leadDomain && c.leverage >= 2.0)
    .sort((a, b) => b.leverage - a.leverage)
    .slice(0, 2);

  const used = new Set<string>([leadKey, ...parallel.map((c) => c.key)].filter(Boolean) as string[]);
  // LATER: the explicit deferral — what we are NOT doing yet, in priority order.
  const later = candidates
    .filter((c) => !used.has(c.key))
    .sort((a, b) => b.leverage - a.leverage)
    .slice(0, 3)
    .map((c) => ({ domain: c.item.domain, title: c.item.title }));

  const leadItem = lead?.item ?? null;
  const parallelItems = parallel.map((c) => c.item);
  const connections = leadItem ? buildConnections(leadItem, parallelItems, input) : [];
  const retest = buildRetest(input);
  const horizon_weeks = num(input.trajectory?.horizon_weeks) ?? num(input.enduranceGoal?.weeks_to_race) ?? null;

  // HEADLINE: where you are (reuse performance's honest one-liner) + the through-line.
  const where = clip(input.performance?.hero?.headline || "", 110);
  let headline: string;
  if (!leadItem) {
    headline = where || "Log a few sessions and Cairn will set your focus for the block.";
  } else {
    const tail = parallelItems.length
      ? ` — with ${parallelItems.map((p) => lc(p.domain)).filter((d, i, a) => a.indexOf(d) === i).join(" + ")} handled alongside`
      : "";
    const stem = `This block, ${lc(leadItem.title)} leads${tail}.`;
    headline = where ? `${where}. ${stem}` : stem;
  }

  return {
    available: leadItem != null,
    headline: clip(headline, 240),
    lead: leadItem,
    parallel: parallelItems,
    later,
    connections,
    retest,
    horizon_weeks,
  };
}

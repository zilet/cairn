// Shared prompt helpers: the cross-cutting guardrail blocks, discipline /
// endurance framing, the connected-brain + recovery renderer, and the exported
// render* conductor / program-state / performance helpers. Imported by the
// per-domain prompt modules and re-exported (with the public render* helpers +
// COACHING_STANCE) through the src/prompt.ts barrel. Behavior-preserving split.
import * as repo from "../repo.js";
import type { PartialCoachContext } from "../repo/coach-context.js";

// Personal-context guardrails, shared by the coach / chat / meal-plan prompts.
// The coach reads `health` and `context_events` from the DATA snapshot and is
// expected to plan AROUND the athlete's real life.
export const CONTEXT_GUARDRAILS = `PERSONAL-CONTEXT GUARDRAILS (use the "context_events" and "health" data):
- TRIPS: for any dates that overlap an active/upcoming trip, plan a travel-friendly / deload
  approach (bodyweight or minimal-equipment work, reduced volume) rather than normal loading.
  Surface upcoming trips so the athlete can plan around them.
- INJURIES: NEVER program loaded movements through an injured area. De-load or swap the affected
  exercises for pain-free alternatives, and respect every exercise's existing constraint_note. The
  app already correlates each active injury with the planned exercises that load that area (and offers
  safe swaps) — honor that link: prefer an alternative that doesn't load the injured region.
- LIFE EVENTS: during flagged high-stress, poor-sleep, or illness windows, reduce volume and
  intensity — recovery comes first.
- FAMILY: plan AROUND family commitments (kids' schedules / family_event entries) — keep sessions
  shorter and more flexible on busy family days, and let "family" + "profile.about_me" personalize
  tone and choices. Stay calm and plain-language; this is supportive, never intrusive.
- HEALTH MARKERS: factor relevant flags into recommendations (e.g. low ferritin/iron → be cautious
  adding endurance volume; low testosterone → emphasize recovery). This is informational, NOT a
  medical diagnosis — note that it is not medical advice and defer to a clinician for anything
  clinical.
- HEALTH REVIEW: when "health_review" is present in DATA, factor its focus areas and watchlist
  actions into training plans and meals (e.g. iron-supporting foods while ferritin is on the
  watchlist, recovery emphasis while a marker is being retested).
- HEALTH DIRECTIVES (the connected brain): when "directives" is present in DATA, treat them as the
  cross-domain consequences of this person's flagged labs already propagated into each domain. FOLD
  the nutrition and training directives directly into the plans/meals you produce (e.g. raise soluble
  fiber and lean toward oily fish while ApoB is elevated; keep aerobic work in the week for blood
  pressure), and RESPECT every "watch" directive (surface the re-check, don't program around it).
  A directive flagged "uncertain" or lacking a citation is a softer nudge, not a hard rule. This is
  informational, NOT medical advice — defer anything clinical to a clinician.`;

// Discipline framing (v35), rendered into the plan-shaping prompts. The athlete's
// primary discipline (strength | endurance | hybrid) decides whether endurance
// progression is a FIRST-CLASS driver or supporting context. Defaults to
// 'strength' (today's behavior) when nothing is set. Returns a compact block.
export function disciplineOf(ctx: any): "strength" | "endurance" | "hybrid" {
  const d = String(ctx?.discipline?.primary ?? ctx?.profile?.primary_discipline ?? "strength").toLowerCase();
  return d === "endurance" || d === "hybrid" ? (d as "endurance" | "hybrid") : "strength";
}

function enduranceSportOf(ctx: any): string | null {
  const s = ctx?.discipline?.endurance_sport ?? ctx?.profile?.endurance_sport ?? null;
  return s ? String(s).trim() || null : null;
}

// `focus` tailors the line to the consuming prompt: 'training' for the coach/session,
// 'nutrition' for meals, 'day' for the Brief. Returns "" for a strength athlete in
// the training/day case (no behavior change) so the existing prompts read identically.
// The current local clock, stated plainly so the agent anchors every
// time-relative word ("today", "tonight", "this morning", "last night") to
// reality instead of the stale conversation thread. ctx.now is set by
// getCoachContext(); "" when it's somehow absent so callers can append blindly.
export function renderNow(ctx: any): string {
  const n = ctx?.now;
  if (!n?.time) return "";
  return `\nRIGHT NOW: ${n.weekday}, ${n.time} (${n.part_of_day}). Anchor every time-relative word to this clock — "today", "tonight", "this morning", "yesterday", "last night" must match it. Don't ask about something that hasn't happened yet (at 5 PM dinner is still ahead — ask how the day's going, not how dinner landed), and don't re-ask about a meal or moment already covered earlier in this conversation.\n`;
}

export function renderDiscipline(ctx: any, focus: "training" | "nutrition" | "day"): string {
  const disc = disciplineOf(ctx);
  const sport = enduranceSportOf(ctx);
  const sportTxt = sport ? ` (${sport})` : "";
  if (disc === "strength") {
    // Meals still want one explicit line so an endurance-leaning athlete isn't
    // assumed; for training/day a strength athlete is the default — say nothing.
    if (focus === "nutrition") return `\nPRIMARY DISCIPLINE: strength-first — fuel for lifting + recovery; a lean-safe deficit is appropriate when fat loss is the goal.\n`;
    return "";
  }
  const lead = disc === "endurance"
    ? `PRIMARY DISCIPLINE: ENDURANCE-first${sportTxt}. Endurance progression is the PRIMARY driver, not a brake — lifting is SUPPORTIVE (strength maintenance, durability, injury-proofing), not the center.`
    : `PRIMARY DISCIPLINE: HYBRID${sportTxt}. Balance endurance and strength as co-equal goals — progress BOTH, and let recovery/scheduling arbitrate when they compete.`;
  if (focus === "nutrition") {
    return `\n${lead}
ENDURANCE FUELING (binding for this athlete):
- PROTECT CARBOHYDRATE for fueling — carbs power endurance work; do NOT slash them to chase a deficit.
- Do NOT force a calorie deficit unless fat loss is an explicit goal. For an endurance athlete eating to
  TRAIN and PERFORM, anchor to maintenance (or a small surplus on the biggest weeks), not a cut.
- PERIODIZE carbs around the week: more carbs on/around LONG and QUALITY (tempo/interval) sessions,
  lighter on easy/rest days. Time a real pre-/during-/post-long-session carb intake.
- Keep protein adequate for recovery; fat fills the rest. Fuel the work, don't starve it.\n`;
  }
  if (focus === "day") {
    return `\n${lead}
Read the day in endurance terms when it fits: a session can be EASY/recovery, a LONG run/ride, a
TEMPO/threshold day, INTERVALS, or genuine REST — not only lift/easy/rest. Protect easy days as easy
and hard days as hard (polarized), and guard earned recovery after long or quality efforts.\n`;
  }
  // training
  return `\n${lead}
- Make endurance progression FIRST-CLASS: build the aerobic base, periodize easy vs quality work
  (long / tempo / threshold / intervals), and progress volume and quality CONSERVATIVELY (the ~10%/week
  rule of thumb for mileage; don't stack hard days).
- Lifting is the SUPPORT here — keep it brief and durability-focused (it should not compromise the key
  endurance sessions). Hold or trim lifting volume on big endurance weeks.
- Read runs/rides as the MAIN training stress, not just "cardio-load context": fatigue, soreness and
  readiness flow largely from the endurance work.\n`;
}

// The endurance OBJECTIVE (v37), rendered for a prompt. Orthogonal to discipline:
// a RACE goal makes the coach periodize a conservative ramp + taper toward a date;
// a STANDING goal makes it maintain readiness (no peak/taper). Both ask the coach to
// prescribe THIS WEEK's runs concretely so a runner/hybrid athlete gets an actionable
// plan, not just prose. `focus` tailors it to the consuming prompt. Returns "" when
// there's no endurance goal (today's behavior unchanged).
export function renderEnduranceGoal(ctx: any, focus: "training" | "nutrition" | "day"): string {
  const g = ctx?.endurance_goal;
  if (!g || !g.mode) return "";
  const dist = g.distance_km ? `${g.distance_km} km` : null;
  if (g.mode === "race") {
    const when = g.weeks_to_race != null
      ? (g.weeks_to_race <= 0 ? "this week" : `~${g.weeks_to_race} week${g.weeks_to_race === 1 ? "" : "s"} out`)
      : "upcoming";
    const head = `ENDURANCE GOAL — RACE: ${g.event || "a race"}${dist ? ` (${dist})` : ""}${g.target ? `, target ${g.target}` : ""}, ${when}${g.date ? ` (${g.date})` : ""}. Phase hint: ${g.phase || "build"}.`;
    if (focus === "nutrition") {
      return `\n${head}\n- Fuel the build: periodize carbs to the week's long/quality runs; don't cut into fueling. In race week, top up carbs and ease off any deficit.\n`;
    }
    if (focus === "day") {
      return `\n${head}\n- Read today's run against this phase (base→build→sharpen→taper). In the taper (final ~2 weeks) protect freshness — shorter & sharper, more rest — and guard the long run's recovery.\n`;
    }
    return `\n${head}
- PERIODIZE toward the date: build the aerobic base, add quality (tempo/threshold/intervals) through the build, sharpen near the race, then TAPER the final ~2 weeks (cut volume, keep some intensity, arrive fresh).
- Progress run volume CONSERVATIVELY (~10%/week; a down week every ~4th). Honor the phase hint above unless the athlete's actual base says to hold.
- Prescribe THIS WEEK's runs concretely (easy / long / quality, each with a zone + a distance or duration) — this is the headline output for a runner, alongside any lifting tweaks. Keep lifting supportive so it doesn't compromise the key runs.\n`;
  }
  // standing
  const head = `ENDURANCE GOAL — STANDING: stay ${g.label || (dist ? `${dist}-ready` : "race-ready")}.${g.weekly_km ? ` Aim ~${g.weekly_km} km/wk.` : ""}`;
  if (focus === "nutrition") {
    return `\n${head}\n- No peak to fuel for — anchor to maintenance and keep carbs adequate for steady aerobic work. A lean-safe deficit is fine only if fat loss is an explicit goal.\n`;
  }
  if (focus === "day") {
    return `\n${head}\n- No taper or peak — keep runs steady and sustainable (mostly easy aerobic, one quality touch a week). Today's run maintains readiness, it doesn't chase a date.\n`;
  }
  return `\n${head}
- MAINTAIN rather than ramp to a date: a steady, sustainable base (mostly easy) + one quality session/week keeps the athlete ${dist ? `${dist}-ready` : "ready"} at any time. Consistency over peaking.
- Prescribe THIS WEEK's runs concretely (easy + one quality), conservative volume. Keep lifting per the discipline.\n`;
}

// Close the race-build feedback loop (Coach loop). Reads ctx.run_compliance —
// the deterministic prescribed-vs-actual running tally for THIS week — and folds
// it into the running-week prompts so the coach adapts next week's runs against
// what ACTUALLY happened (per Garmin/logged activities), conservatively. `pct_km`
// is an INTERNAL proportion — NEVER surfaced as a score; we speak in plain words
// ("ran X of Y km"). Quiet by default: returns "" when there's NO endurance goal
// AND nothing was prescribed (a strength-only athlete sees nothing new). `focus`
// tailors the binding guidance to the consuming prompt.
export function renderRunCompliance(ctx: any, focus: "training" | "day" | "weekly"): string {
  const rc = ctx?.run_compliance;
  if (!rc) return "";
  const hasGoal = !!(ctx?.endurance_goal && ctx.endurance_goal.mode);
  const prescribed = Number(rc.prescribed_sessions) > 0;
  // Quiet by default: with no endurance goal AND nothing prescribed, say nothing.
  if (!hasGoal && !prescribed) return "";

  // Did the actual running fall short of, meet, or exceed what was prescribed?
  // Prefer distance (the runner's native unit); fall back to session count.
  let shortfall: "short" | "met" | "over" | "unknown" = "unknown";
  if (prescribed && Number(rc.prescribed_km) > 0 && rc.pct_km != null) {
    if (rc.pct_km < 0.85) shortfall = "short";
    else if (rc.pct_km > 1.1) shortfall = "over";
    else shortfall = "met";
  } else if (prescribed) {
    const a = Number(rc.actual_sessions) || 0;
    const p = Number(rc.prescribed_sessions) || 0;
    if (a < p) shortfall = "short";
    else if (a > p) shortfall = "over";
    else shortfall = "met";
  }

  const lines: string[] = [];
  lines.push(`THIS WEEK'S RUNNING — PRESCRIBED vs ACTUAL (deterministic, from logged/Garmin activities): ${String(rc.in_words ?? "").trim() || "no running data this week"}.`);
  if (focus === "weekly") {
    lines.push(
      "- When running is the story of the week, let the ONE change you suggest REFLECT this prescribed-vs-actual gap, in plain words (never a number wall, never a score)."
    );
    if (shortfall === "short")
      lines.push("- Actual fell short of what was prescribed: the calm suggestion is to HOLD or only GENTLY progress next week — do NOT pile the missed volume onto next week, and never jump more than ~10%/week. A lighter week is information, not a failure.");
    else if (shortfall === "over")
      lines.push("- Actual met or exceeded the prescription comfortably: a small conservative progression next week is fine, but watch for stacked hard days and protect earned recovery — don't reward a big week with a bigger one if recovery is slipping.");
    else
      lines.push("- Actual roughly matched the prescription: steady is good — a small conservative progression is OK only if recovery looks fine; otherwise holding is a perfectly healthy call.");
  } else if (focus === "training") {
    lines.push("- ADAPT next week's runs to what ACTUALLY happened, conservatively:");
    if (shortfall === "short")
      lines.push("  - Actual fell short of prescribed → HOLD or only GENTLY progress next week. Do NOT pile the missed mileage onto next week to 'catch up' — never jump more than ~10%/week. Carry forward roughly the volume they actually ran, not the one they missed.");
    else if (shortfall === "over")
      lines.push("  - Actual met/exceeded prescribed comfortably → a SMALL conservative progression (~≤10% mileage) is OK. Don't stack quality on top of a big volume week.");
    else
      lines.push("  - Actual roughly matched prescribed → a small conservative progression is OK if recovery is good; otherwise hold.");
    lines.push("  - Either way: protect easy/hard polarization (keep easy easy, quality sparing) and guard earned recovery after long or hard efforts.");
  } else {
    // day — a light touch only: today's run in the context of the week's progress.
    lines.push("- Light touch only: read today's run against where the week stands (above) — if they're already short on the week, a calm easy/short option is fine; if they're on track, no need to pile on. Never frame a behind week as falling behind.");
  }
  return `\n${lines.join("\n")}\n`;
}

// The connected brain, rendered for a prompt. Pulls the active cross-domain
// directives (deriveDirectives writes them from flagged labs) plus the unified
// recovery view, and folds them into a compact, plain-language block so labs
// already shape meals & training. Filterable by domain so the meal prompt sees
// nutrition directives first and the coach prompt sees training/watch first.
// Returns "" when there is nothing to say — graceful, quiet by default.
// A directive shows its VERIFIED citation when it has one; otherwise we attach an
// OFFLINE trusted-guideline citation (the bundled guidelines pack — Era 2, §12 item
// 2) as a FLOOR, so the connected brain's notes can cite a recognized body even with
// host-side research disabled. Verified citation always wins. INFORMATIONAL, never a
// hard rule; returns "" when neither is available (quiet by default).
function directiveCitationTag(d: any): string {
  if (d?.citation) return ` [${String(d.citation).trim()}]`;
  const g = d?.marker ? repo.guidelineFor(String(d.marker)) : null;
  return g ? ` [general guidance · ${g.source}]` : "";
}

export function renderConnectedBrain(ctx: any, opts: { domains?: ("nutrition" | "training" | "watch")[] } = {}): string {
  const directives = Array.isArray(ctx?.directives) ? ctx.directives : [];
  const wanted = opts.domains;
  const relevant = directives.filter((d: any) => d && (!wanted || wanted.includes(d.domain)));
  const lines: string[] = [];

  // LEAD with the prioritized focus (the elite-coach tiering), so the plan serves
  // what matters MOST first — not a flat directive list. act-now items first; the
  // move shown is the one for this prompt's domain when there is one.
  const focus = ctx?.health_focus;
  const fps = focus && Array.isArray(focus.priorities) ? focus.priorities : [];
  const relFocus = fps.filter((p: any) =>
    !wanted || p.tier === "act_now" || wanted.some((d) => p?.moves && p.moves[d])
  );
  if (relFocus.length) {
    lines.push("PRIORITIZED HEALTH FOCUS (the connected brain — evidence for the block focus above; act-now items before track):");
    for (const p of relFocus.slice(0, 6)) {
      const tier = p.tier === "act_now" ? "ACT NOW" : "track";
      const move = wanted ? wanted.map((d) => p?.moves?.[d]).find(Boolean) : (p?.moves?.nutrition || p?.moves?.training || p?.moves?.watch);
      const tags = `${p.compounding ? " · several markers together" : ""}${p.uncertain ? " · lever unsettled (softer nudge)" : ""}`;
      lines.push(`  - [${tier}] ${p.group}${tags}: ${move ? String(move).trim() : String(p.why ?? "").trim()}`);
    }
  }

  if (relevant.length) {
    // Acute-phase findings (hs-CRP, ESR, …) are point-in-time: a stale one must NOT be
    // honored as a current daily cap (the bug — a 2-week-old hs-CRP capping today's
    // intervals every morning). Split fresh (honor) from aging-acute (a soft, clearly
    // dated "recheck" note the agent must NOT turn into a daily cap).
    // annotateDirectiveFreshness anchors each acute finding to its actual LAB reading
    // date (not when the review ran), so a 2-week-old hs-CRP ages out instead of capping
    // training every morning. Chronic markers (ApoB/LDL/Lp(a)) never decay → stay fresh.
    const annotated = repo.annotateDirectiveFreshness(relevant);
    // A TRANSIENT acute finding (a fresh hs-CRP/ESR drawn during an active illness/
    // injury/hard-block window) is informational the same way an aging one is — it
    // must NOT cap today's training. Split it out of "honor these" alongside stale.
    const fresh = annotated.filter((d: any) => !d.stale && !d.transient);
    const agingAcute = annotated.filter((d: any) => d.stale && !d.transient);
    const transient = annotated.filter((d: any) => d.transient && !d.stale);
    if (fresh.length) {
      const byDomain: Record<string, string[]> = {};
      for (const d of fresh) {
        const dom = String(d.domain ?? "watch");
        (byDomain[dom] ||= []).push(
          `  - ${String(d.directive ?? "").trim()}${d.rationale ? ` (why: ${String(d.rationale).trim()})` : ""}${directiveCitationTag(d)}`
        );
      }
      lines.push("DERIVED HEALTH DIRECTIVES (the connected brain — your labs propagated into this domain; honor these):");
      for (const dom of ["nutrition", "training", "watch"]) {
        if (byDomain[dom]?.length) lines.push(` ${dom.toUpperCase()}:`, ...byDomain[dom]);
      }
    }
    if (agingAcute.length) {
      lines.push("AGING LAB FINDINGS (acute, point-in-time markers from a while ago — INFORMATIONAL ONLY: do NOT cap today's training or meals on these; at most a gentle 'worth a recheck' if it naturally fits):");
      for (const d of agingAcute) {
        const wks = d.age_days != null ? Math.max(1, Math.round(d.age_days / 7)) : null;
        const age = wks != null ? `~${wks} week${wks === 1 ? "" : "s"} ago` : "a while ago";
        lines.push(`  - ${String(d.marker ?? "a marker").trim()}: ${String(d.directive ?? "").trim()} (reading ${age} — point-in-time; recheck before it shapes anything)`);
      }
    }
    if (transient.length) {
      lines.push("DRAWN DURING A FLARE (an acute marker likely bumped by a recent illness / injury / hard training block — INFORMATIONAL ONLY: do NOT cap today's training or meals on it; recheck once things settle):");
      for (const d of transient) {
        lines.push(`  - ${String(d.marker ?? "a marker").trim()}: ${String(d.directive ?? "").trim()}${d.transient_reason ? ` (${String(d.transient_reason).trim()})` : ""}`);
      }
    }
  }

  // SYMPTOM ↔ MARKER connections (the connected brain reaching across logs): a
  // symptom the athlete mentioned co-occurring with a genuinely off-marker. Purely
  // informational — a "worth raising with your clinician" nudge, NEVER a diagnosis.
  const symLinks = Array.isArray(ctx?.symptom_links) ? ctx.symptom_links : [];
  if (symLinks.length && (!wanted || wanted.includes("watch") || wanted.includes("training"))) {
    lines.push("SYMPTOM ↔ LAB CONNECTIONS (something the athlete noted lines up with an out-of-range marker — mention it gently as worth raising with their doctor; informational, never a diagnosis, never alarmist):");
    for (const s of symLinks.slice(0, 3)) {
      const mk = Array.isArray(s.markers) ? s.markers.map((m: any) => `${m.name} ${m.value ?? ""} (${m.side})`.trim()).join(", ") : "";
      lines.push(`  - ${String(s.note ?? `${s.symptom} alongside ${mk}`).trim()}`);
    }
  }
  const feedback = Array.isArray(ctx?.directive_feedback) ? ctx.directive_feedback : [];
  const relevantFeedback = feedback.filter((d: any) => d && (!wanted || wanted.includes(d.domain))).slice(0, 8);
  if (relevantFeedback.length) {
    lines.push("DIRECTIVE FEEDBACK MEMORY (use this to avoid stale repeats; only reintroduce if the marker materially changed or the user asks):");
    for (const d of relevantFeedback) {
      const status = d.status === "dismissed" ? "dismissed by athlete" : "marked done/handled";
      const marker = d.marker ? `${String(d.marker).trim()} · ` : "";
      const snap = [d.trigger_side, d.trigger_value, d.trigger_date].filter((x: any) => x != null && x !== "").join(" ");
      lines.push(`  - ${status}: ${marker}${String(d.directive ?? "").trim()}${snap ? ` (marker snapshot: ${snap})` : ""}`);
    }
  }
  const rec = ctx?.recovery?.recovery;
  if (ctx?.recovery?.has_data && rec) {
    const bits: string[] = [];
    if (rec.avg_sleep_min != null) {
      let sleep = `avg sleep ~${Math.round(rec.avg_sleep_min)} min`;
      if (rec.avg_deep_sleep_min != null || rec.avg_rem_sleep_min != null) {
        const stages = [
          rec.avg_deep_sleep_min != null ? `${Math.round(rec.avg_deep_sleep_min)} deep` : null,
          rec.avg_rem_sleep_min != null ? `${Math.round(rec.avg_rem_sleep_min)} REM` : null,
        ].filter(Boolean).join(", ");
        if (stages) sleep += ` (${stages})`;
      }
      bits.push(sleep);
    }
    if (rec.avg_resting_hr != null) bits.push(`resting HR ~${rec.avg_resting_hr}`);
    if (rec.avg_hrv_ms != null) bits.push(`HRV ~${rec.avg_hrv_ms} ms${rec.hrv_status ? ` (${String(rec.hrv_status).toLowerCase()})` : ""}`);
    if (rec.avg_stress != null) bits.push(`stress ~${rec.avg_stress}`);
    if (rec.avg_body_battery != null) bits.push(`body battery ~${rec.avg_body_battery}`);
    if (rec.avg_respiration != null) bits.push(`respiration ~${rec.avg_respiration}/min`);
    if (rec.avg_spo2 != null) bits.push(`SpO2 ~${rec.avg_spo2}%`);
    if (rec.skin_temp_dev_c != null) bits.push(`skin-temp dev ${rec.skin_temp_dev_c > 0 ? "+" : ""}${rec.skin_temp_dev_c}°C`);
    if (rec.avg_training_readiness != null) {
      const tr = Math.round(rec.avg_training_readiness);
      const word = tr < 40 ? "low" : tr <= 65 ? "moderate" : "high";
      bits.push(`${word} training readiness`);
    }
    if (rec.acute_load != null) bits.push(`acute training load ~${Math.round(rec.acute_load)}`);
    if (rec.vo2max != null) bits.push(`VO2max ${rec.vo2max}`);
    if (rec.fitness_age != null) bits.push(`fitness age ~${Math.round(rec.fitness_age)}`);
    if (rec.training_status) bits.push(`status: ${String(rec.training_status).toLowerCase()}`);
    if (rec.avg_steps != null) bits.push(`~${Math.round(rec.avg_steps)} steps/day`);
    if (rec.avg_vigorous_min != null && rec.avg_vigorous_min > 0) bits.push(`~${Math.round(rec.avg_vigorous_min)} vigorous min/day`);
    const body: string[] = [];
    if (rec.weight_kg != null) body.push(`weight ${rec.weight_kg} kg`);
    if (rec.body_fat_pct != null) body.push(`body fat ${rec.body_fat_pct}%`);
    if (rec.muscle_mass_kg != null) body.push(`muscle ${rec.muscle_mass_kg} kg`);
    if (bits.length) lines.push(`RECOVERY (last ${ctx.recovery.days}d, ${(ctx.recovery.sources || []).join("+") || "no source"}): ${bits.join(", ")} — read the WHOLE picture; bias toward recovery when sleep/HRV/readiness are low or resting HR/stress are elevated vs their norm.`);
    // Acute-vs-chronic baseline: the last 7 days against the 30-day norm, so the
    // agent compares the athlete to THEIR OWN baseline (not a population number).
    const dl = ctx?.recovery?.delta;
    const rc = ctx?.recovery?.recent;
    const bl = ctx?.recovery?.baseline;
    if (dl && rc && bl) {
      const cmp: string[] = [];
      if (rc.sleep != null && bl.sleep != null && dl.sleep != null)
        cmp.push(`sleep ${Math.round(rc.sleep)} min vs ~${Math.round(bl.sleep)} norm (${dl.sleep >= 0 ? "+" : ""}${Math.round(dl.sleep)})`);
      if (rc.hrv != null && bl.hrv != null && dl.hrv != null)
        cmp.push(`HRV ${rc.hrv} vs ~${bl.hrv} norm (${dl.hrv >= 0 ? "+" : ""}${dl.hrv})`);
      if (rc.rhr != null && bl.rhr != null && dl.rhr != null)
        cmp.push(`resting HR ${rc.rhr} vs ~${bl.rhr} norm (${dl.rhr >= 0 ? "+" : ""}${dl.rhr})`);
      if (cmp.length) lines.push(`RECOVERY vs THEIR NORM (last 7d against 30d baseline): ${cmp.join("; ")} — lower sleep/HRV or a raised resting HR vs their own norm means lean toward recovery; this is the comparison that matters, not absolute numbers.`);
    }
    if (body.length) lines.push(`BODY COMPOSITION (latest): ${body.join(", ")}.`);
  }
  // Supplements the athlete already takes — relevant across domains (whey ↔ protein
  // floor, creatine ↔ recovery/eGFR, D3/omega-3 ↔ markers). Always folded in when
  // present so the coach doesn't re-suggest what they're on and can connect a
  // supplement to the marker it touches.
  const supps = Array.isArray(ctx?.supplements) ? ctx.supplements : [];
  if (supps.length) {
    lines.push("SUPPLEMENTS THE ATHLETE ALREADY TAKES (factor in; don't re-suggest what they're on — whey counts toward the protein floor; a supplement overlapping a now-replete marker is worth a gentle note, never alarm):");
    for (const s of supps) {
      const dose = s.dose ? ` ${s.dose}` : "";
      const freq = s.frequency ? `, ${s.frequency}` : "";
      const touches = Array.isArray(s.related_markers) && s.related_markers.length ? ` — relates to ${s.related_markers.join("/")}` : "";
      lines.push(`  - ${s.name}${dose}${freq}${touches}`);
    }
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// Render the deterministic training signals (repo.trainingSignals, carried on
// ctx.training_signals) as a plain-language block. This is the inference the prompt
// used to ask the agent to do over raw recent_sessions — now pre-computed so the
// athlete's own logged sets + 1-tap feedback VISIBLY steer the next recommendation.
// Returns "" when there's nothing load-bearing to say.
export function renderTrainingSignals(ctx: any): string {
  const ts = ctx?.training_signals;
  if (!ts) return "";
  const prog = Array.isArray(ts.progression) ? ts.progression : [];
  const ready = prog.filter((p: any) => p?.progress_ready);
  const stalled = prog.filter((p: any) => p && !p.progress_ready && p.last_logged && p.est_1rm_trend === "down");
  const lines: string[] = [];
  if (ready.length) {
    lines.push("PROGRESSION-READY (recent logs met the top of the rep range at low RIR — the small conservative step up is EARNED here; apply the normal +5 / +5-10 lb step):");
    for (const p of ready) {
      const tr = p.est_1rm_trend === "up" ? ", est-1RM trending up" : "";
      lines.push(`  - ${p.exercise}: ${p.reason}${tr}`);
    }
  }
  if (stalled.length) {
    lines.push("STALLED / EASE OFF (est-1RM slipping — hold the load or rotate the movement rather than adding):");
    for (const p of stalled) lines.push(`  - ${p.exercise}: ${p.reason}`);
  }
  if (ts.autoregulation?.note) lines.push(`AUTOREGULATION (recent 1-tap body feedback): ${ts.autoregulation.note}`);
  if (!lines.length) return "";
  return `\nLOGGED-PERFORMANCE SIGNALS (deterministic, from the athlete's OWN recent sets + feedback — evidence for whether a lift earned a bump, so the plan visibly reflects what they actually did):\n${lines.join("\n")}\n`;
}

// Active injury areas drawn from context_events (an injury's title/detail/meta.area
// in plain words), so a variation/swap menu can FILTER out movements that load an
// injured region — the concrete list the agent picks from must agree with the
// "never load an injured area" rule, not just the prose. [] when injury-free.
export function activeInjuryAreas(ctx: any): string[] {
  const evts = Array.isArray(ctx?.context_events) ? ctx.context_events : [];
  const out: string[] = [];
  for (const e of evts) {
    if (e?.kind !== "injury" || e?.end_date) continue;
    const txt = `${e?.title ?? ""} ${e?.detail ?? ""} ${e?.meta?.area ?? ""}`.toLowerCase();
    for (const [tag, canon] of [["knee", "knee"], ["shoulder", "shoulder"], ["back", "lower-back"], ["lumbar", "lower-back"], ["elbow", "elbow"], ["wrist", "wrist"], ["hip", "hip"], ["ankle", "ankle"]] as const) {
      if (txt.includes(tag)) out.push(canon);
    }
  }
  return [...new Set(out)];
}

// ---- the "knows-me" layer: render the personal coaching team into the one voice ----
// All four return "" when there's nothing to say (calm by default), surface plain words
// + a confidence WORD only (never a number/score), and are suggestions never gates.

// HOW THIS ATHLETE RESPONDS — the personalization spine. Carries the standing principle
// that prevents the engine's hard-won fixes from regressing in the agent's own prose.
export function renderReactionModel(ctx: any): string {
  const rm = ctx?.reaction_model;
  const pats = rm && Array.isArray(rm.patterns) ? rm.patterns : [];
  const lines = pats.slice(0, 5)
    .map((p: any) => `  - [${p.confidence}] ${String(p.statement || "").trim()}`)
    .filter((l: string) => l.trim().length > 10);
  if (!lines.length) return "";
  const narr = rm.narrative ? `\n${String(rm.narrative).trim()}` : "";
  return `\nHOW THIS ATHLETE RESPONDS (learned from their OWN logged history — personalize your defaults to this; a suggestion, never a gate. Trust their LOGGED loads over any stale plan number, and read a grip/form note as a technique cue, not a load cap):${narr}\n${lines.join("\n")}\n`;
}

// THE ARC — where today sits on the path to their goals. One clause, never a date wall.
export function renderTrajectory(ctx: any): string {
  const t = ctx?.trajectory;
  if (!t || !t.line) return "";
  return `\nTHE ARC (where today sits on the path to their goals — voice at most ONE natural clause when it fits, never a milestone list-dump or a date wall): ${String(t.line).trim()}\n`;
}

// LIFE CONTEXT — a one-mention event shaping today, then fading. Never a forced rest.
export function renderActiveContext(ctx: any): string {
  const c = ctx?.context_today;
  if (!c || !c.any) return "";
  const items = Array.isArray(c.active) ? c.active : [];
  const bits = items.slice(0, 3).map((a: any) => String(a.reason || a.title || "").trim()).filter(Boolean);
  const flags: string[] = [];
  if (c.expect_worse_sleep) flags.push("their sleep likely ran short");
  if (c.transient_inflammation) flags.push("a transient inflammation bump is likely — do NOT alarm on an acute marker or cap training for it");
  if (c.reduce_load) flags.push("ease the load a touch");
  if (c.fueling_disrupted) flags.push("fueling/scale may be disrupted — lean conservative, don't re-target on noise");
  if (!bits.length && !flags.length) return "";
  return `\nLIFE CONTEXT RIGHT NOW (${bits.join("; ") || "an active life event"}): ${flags.join("; ")}. Plan AROUND it kindly — it fades on its own; never a verdict, never a forced rest.\n`;
}

export function renderTodayFuel(ctx: any): string {
  const intake = ctx?.day_intake;
  const entries = Array.isArray(intake?.entries) ? intake.entries : [];
  const count = Number(intake?.count ?? entries.length);
  if (!intake || !entries.length || !Number.isFinite(count) || count <= 0) return "";

  const num = (v: any) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const macroBits = (src: any) => {
    const bits: string[] = [];
    const kcal = num(src?.kcal);
    const protein = num(src?.protein_g);
    const carbs = num(src?.carbs_g);
    const fat = num(src?.fat_g);
    if (kcal && kcal > 0) bits.push(`~${kcal} kcal`);
    if (protein && protein > 0) bits.push(`${protein}g protein`);
    if (carbs && carbs > 0) bits.push(`${carbs}g carbs`);
    if (fat && fat > 0) bits.push(`${fat}g fat`);
    return bits;
  };
  const total = macroBits(intake.totals);
  const lines = [
    `TODAY'S FUEL (persisted food log for ${intake.date || "today"} in the athlete's LOCAL day — survives chat resets; use it as current context, never as a capture nudge):`,
    `- TOTAL SO FAR: ${entries.length} item${entries.length === 1 ? "" : "s"}${total.length ? ` · ${total.join(" · ")}` : " · macros not estimated yet"}.`,
  ];

  const rem = intake.remaining || null;
  if (intake.target && rem) {
    const remBits: string[] = [];
    const kcal = num(rem.kcal);
    const protein = num(rem.protein_g);
    if (kcal != null) {
      if (kcal > 100) remBits.push(`~${kcal} kcal remaining`);
      else if (kcal < -100) remBits.push(`~${Math.abs(kcal)} kcal over target`);
      else remBits.push("near calorie target");
    }
    if (protein != null) {
      if (protein > 5) remBits.push(`~${protein}g protein remaining`);
      else if (protein < -5) remBits.push("protein target met");
      else remBits.push("near protein target");
    }
    if (remBits.length) lines.push(`- TARGET CONTEXT: ${remBits.join(" · ")} (${intake.target.mode || "goal"} mode).`);
  }

  lines.push("- LOGGED ENTRIES (ids are editable rows; do not duplicate these):");
  for (const e of entries.slice(0, 6)) {
    const entryBits = macroBits(e);
    const status = e?.enrichment_status === "pending"
      ? " · estimate still pending"
      : e?.enrichment_status === "error"
        ? " · estimate uncertain"
        : "";
    lines.push(`  - id ${e.id}: ${e.meal || "meal"} — ${String(e.summary || "Food").trim()}${entryBits.length ? ` (${entryBits.join(" · ")})` : ""}${e.logged_at ? ` at ${e.logged_at}` : ""}${status}`);
  }
  if (entries.length > 6) lines.push(`  - plus ${entries.length - 6} more item${entries.length - 6 === 1 ? "" : "s"} in DATA.day_intake.entries.`);
  lines.push("FOOD USE: reference this when answering about today, fuel, recovery, or training readiness. In chat, if the athlete corrects one of these rows, use update_food_note with the existing id; if they mention the same meal again, do not log a duplicate. Treat this as a single-day snapshot, not a weekly retarget signal by itself.");
  return `\n${lines.join("\n")}\n`;
}

// The elite PROGRAM-STATE read, rendered for a plan-shaping prompt. Mirrors
// renderConnectedBrain: a compact, plain-language block from program_state +
// program_balance + program_adjustments so EVERY strength prompt sees how each
// lift is trending, where the volume is skewed, and the concrete adaptations due
// — never a flat session dump, never a score. Returns "" when there's nothing to
// say (quiet by default). `opts.brief` trims it for the day-read (one calm
// summary line) vs the full block for the coach/session/week-ahead.
// The COACHING STANCE — the conductor's instruction. Lifted from the health-synthesis
// constitution that already makes the day-read and synthesis read like one human coach,
// and applied to the PLAN prompts (coach/session/evolution/week-ahead), which had ~14
// self-asserting blocks and no instruction to prioritize, sequence, or speak as one voice.
export const COACHING_STANCE = `COACH LIKE ONE PERSON, NOT A DASHBOARD:
- Lead with the SINGLE highest-leverage change in the focus above. Build the plan to SERVE it.
- Change 1-3 things, never everything. The domain blocks below are your EVIDENCE — read them, don't recite them.
- SEQUENCE: act on the lead + the parallel levers; name what's deferred ("we'll re-test the squat in a few weeks"), don't pile it on now.
- CONNECT the domains in plain words (a lab shapes food AND training; recovery shapes today's intensity; aerobic work is fitness AND longevity).
- Speak in ONE warm, direct voice — no metric walls, no checklists, no scores.`;

// renderCoachingFocus — the conductor block. Rendered FIRST in every plan prompt, above
// all the domain reads, so the agent leads with ONE sequenced focus (lead + parallel +
// later + connections + the batched retest) instead of a flood of co-equal blocks. The
// `brief` form (for the day-read) shows only the lead line. Returns "" when there's no
// focus (a thin athlete) so it degrades exactly like the other render* helpers.
export function renderCoachingFocus(ctx: PartialCoachContext, opts: { brief?: boolean } = {}): string {
  const cf = ctx?.coaching_focus as any;
  if (!cf || !cf.available || !cf.lead) return "";
  const lead = cf.lead;
  if (opts.brief) {
    return `THIS BLOCK'S ONE FOCUS: ${lead.title} — ${lead.why}${lead.move ? ` (${lead.move})` : ""}\n`;
  }
  const lines: string[] = [];
  lines.push("THIS BLOCK — THE FOCUS (the conductor; LEAD with this — everything below it is evidence, not a checklist):");
  lines.push(`  ▸ LEAD: ${lead.title} — ${lead.why}${lead.move ? ` ${lead.move}` : ""}`);
  for (const p of cf.parallel || []) lines.push(`  ▸ ALONGSIDE (${p.domain}, handled via a different lever): ${p.title} — ${p.why}${p.move ? ` ${p.move}` : ""}`);
  if ((cf.later || []).length) lines.push(`  ▸ LATER (say it's deferred — do NOT act on it yet): ${cf.later.map((l: any) => l.title).join("; ")}`);
  for (const c of cf.connections || []) lines.push(`  ▸ CONNECT: ${c}`);
  if (cf.retest) lines.push(`  ▸ NEXT CHECK-IN${cf.retest.in_weeks === 0 ? " (due now)" : ""}: re-test ${cf.retest.focus.join(", ")} — ${cf.retest.why}`);
  return `${lines.join("\n")}\n\n`;
}

export function renderProgramState(ctx: PartialCoachContext, opts: { brief?: boolean } = {}): string {
  const st = ctx?.program_state as any;
  const bal = ctx?.program_balance as any;
  const adj = Array.isArray(ctx?.program_adjustments) ? ctx.program_adjustments : [];
  if (!st && !bal && !adj.length) return "";
  const lines: string[] = [];

  // Headline — the one-sentence program read, always safe to show.
  if (st?.headline) lines.push(`PROGRAM STATE (deterministic read of the logged history — evidence for the block focus above; plain words, no scores): ${st.headline}`);

  // ACUTE recovery — which muscles are smoked from the last day or two (a long
  // ride/run that never touched logged_sets, or a heavy session). The coach must
  // plan AROUND these, never recommend them for the next session even when the
  // weekly ledger says they're due. This is the connected read that keeps the
  // next-day pick honest (legs are toast after a 3 h ride → train something fresh).
  const recentLoad: any[] = Array.isArray(ctx?.recent_load) ? ctx.recent_load as any[] : [];
  const heavy = recentLoad.filter((r: any) => r?.heavy);
  const recoveringSet = new Set<string>(heavy.map((r: any) => String(r.group)));
  let recoveringLine = "";
  if (heavy.length) {
    const groups = [...recoveringSet];
    const lead = heavy.find((r: any) => r.activity) ?? heavy[0];
    const ago = (d: number) => (d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`);
    const cause = lead?.activity
      ? `${lead.detail ? `${lead.detail} ` : ""}${lead.activity} ${ago(Number(lead.days_ago) || 0)}`
      : `a heavy session ${ago(Number(lead?.days_ago) || 0)}`;
    recoveringLine = `ACUTELY LOADED — RECOVERING (do NOT program these for the next session even if "due"; they're freshly torched — plan AROUND them and let them recover): ${groups.join(", ")} (${cause}).`;
  }

  if (opts.brief) {
    // Day-read: the headline, the acute recovery read (so today bends around smoked
    // muscles), and the single most-actionable adaptation.
    if (recoveringLine) lines.push(recoveringLine);
    const top = adj[0];
    if (top?.title) lines.push(`- One thing the program could use: ${top.title}${top.why ? ` — ${top.why}` : ""}`);
    return lines.length ? `\n${lines.join("\n")}\n` : "";
  }

  // Per-lift trajectory — lead with what needs action (stalled / slipping), so the
  // coach's changes target the lifts that earned them.
  const lifts = Array.isArray(st?.lifts) ? st.lifts : [];
  const needsAction = lifts.filter((l: any) => l.status === "plateaued" || l.status === "regressing");
  const climbing = lifts.filter((l: any) => l.status === "progressing");
  if (needsAction.length) {
    lines.push("LIFTS THAT NEED A CALL (act on these — the suggested_action is the deterministic read):");
    for (const l of needsAction.slice(0, 8)) {
      const tells = Array.isArray(l.stall_signals) && l.stall_signals.length ? ` (${l.stall_signals.join("; ")})` : "";
      lines.push(`  - ${l.exercise} [${l.status}] → ${l.suggested_action}${tells}: ${String(l.why ?? "").trim()}`);
    }
  }
  if (climbing.length) {
    lines.push(`PROGRESSING (push the next conservative step here): ${climbing.slice(0, 6).map((l: any) => l.exercise).join(", ")}.`);
  }

  // The full block leads its volume read with the acute recovery line (computed above).
  if (recoveringLine) lines.push(recoveringLine);

  // Volume balance — which groups are due / running high, in plain words. DUE is
  // split by acute freshness so the coach knows which due groups are good next
  // picks vs which are recovering and must wait.
  if (bal && (bal.summary || (Array.isArray(bal.due) && bal.due.length) || (Array.isArray(bal.over) && bal.over.length))) {
    const pieces: string[] = [];
    if (Array.isArray(bal.due) && bal.due.length) {
      const fresh = bal.due.filter((g: string) => !recoveringSet.has(g));
      const rec = bal.due.filter((g: string) => recoveringSet.has(g));
      if (fresh.length) pieces.push(`DUE & FRESH (good next picks): ${fresh.join(", ")}`);
      if (rec.length) pieces.push(`DUE BUT RECOVERING (don't program next session): ${rec.join(", ")}`);
    }
    if (Array.isArray(bal.over) && bal.over.length) pieces.push(`RUNNING HIGH (room to redirect): ${bal.over.join(", ")}`);
    lines.push(`VOLUME BALANCE (working sets per muscle group, last 2 weeks — bring DUE & FRESH groups up, don't pile onto HIGH or RECOVERING ones; plain words, never numbers as a grade):${pieces.length ? ` ${pieces.join("; ")}.` : ` ${bal.summary}`}`);
  }

  // Mesocycle position (deload timing) when program-state carries it.
  if (st?.mesocycle?.note) lines.push(`MESOCYCLE: ${st.mesocycle.note}`);
  // Endurance trajectory (hybrid/endurance athletes) — the conservative read.
  if (st?.endurance?.why) lines.push(`ENDURANCE TRAJECTORY: ${st.endurance.why}`);

  // The concrete adaptations digest — the "what to change & why" the coach should
  // realize as proposed plan changes (most-actionable first, already deduped).
  if (adj.length) {
    lines.push("ADAPTATIONS DUE (concrete, most-actionable first — evidence supporting the focus above; realize the relevant ones as conservative proposals):");
    for (const a of adj.slice(0, 6)) lines.push(`  - ${a.title}${a.why ? `: ${a.why}` : ""}`);
  }

  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// renderPerformance: the TRAINING-INTELLIGENCE read — where the athlete actually
// STANDS (capacity), not just whether last week trended up. Benchmarked against
// sex/age strength standards + VO2max norms, the strength imbalances, the single
// biggest lever, the lifts worth re-TESTING, and a variety nudge. Folded into every
// strength prompt so the coach LEADS with where the athlete is and balances their
// development — bring laggards up, fix imbalances, re-measure stale lifts, rotate a
// movement. Plain words / percentile-level reference reads, never a 0-100 score.
// Returns "" when there's nothing benchmarked yet (quiet by default).
export function renderPerformance(ctx: PartialCoachContext, opts: { brief?: boolean } = {}): string {
  const p = ctx?.performance as any;
  if (!p) return "";
  const caps = Array.isArray(p.capacities) ? p.capacities : [];
  const imb = Array.isArray(p.imbalances) ? p.imbalances : [];
  const tests = Array.isArray(p.tests_due) ? p.tests_due : [];
  const lever = p.lever;
  if (!caps.length && !p.endurance && !lever) return "";

  if (opts.brief) {
    // Day-read: the hero + the single lever, one calm line (no per-lift dump).
    const bits: string[] = [];
    if (p.hero?.headline) bits.push(p.hero.headline);
    if (lever?.headline) bits.push(`today's lever: ${String(lever.headline).toLowerCase()}`);
    return bits.length
      ? `\nWHERE YOU STAND (capacity benchmarked against proven sex/age standards — a reference read, never a grade): ${bits.join("; ")}.\n`
      : "";
  }

  const lines: string[] = [];
  if (p.hero?.headline) {
    lines.push(
      `PERFORMANCE STANDING (the deterministic CAPACITY read — where the athlete genuinely stands vs proven sex/age strength standards + VO2max norms; percentile/level are recognized reference reads, NEVER a score; evidence for the focus above): ${p.hero.headline}.`,
    );
  }
  if (caps.length) {
    lines.push("CAPACITY BY MOVEMENT (level for THEIR age — program to bring the laggards up, don't only push what's already strong):");
    for (const c of caps.slice(0, 6)) {
      const nxt = c.to_next ? ` (~+${c.to_next.lb} lb → ${c.to_next.level})` : "";
      lines.push(`  - ${c.label}: ${c.level} for their ${c.age_band} — ${c.exercise} est 1RM ~${c.est_1rm} lb${nxt}.`);
    }
  }
  if (imb.length) {
    lines.push("IMBALANCES TO ADDRESS (program the under-developed side UP — structural balance + injury prevention is a first-class coaching job here, not an afterthought):");
    for (const i of imb) lines.push(`  - ${i.title}: ${i.why}`);
  }
  if (lever?.headline) {
    lines.push(`THE ONE LEVER (single highest-leverage training focus right now): ${lever.headline}${lever.why ? ` — ${lever.why}` : ""}${lever.target ? ` (${lever.target})` : ""}.`);
  }
  if (tests.length) {
    lines.push("WORTH RE-TESTING (occasionally program a heavy low-rep test or a max hold to RE-MEASURE true capacity — variety and honest re-measurement beat the same submax work every week):");
    for (const t of tests) lines.push(`  - ${t.exercise} (${t.kind}): ${t.why}`);
  }
  if (p.variety?.note) {
    lines.push(`VARIETY (training shouldn't be the identical rotation forever): ${p.variety.note}${Array.isArray(p.variety.suggestions) && p.variety.suggestions.length ? ` Options: ${p.variety.suggestions.join(", ")}.` : ""}`);
  }
  if (p.endurance?.headline && (p.discipline === "endurance" || p.discipline === "hybrid")) {
    lines.push(`AEROBIC CAPACITY: ${p.endurance.headline}`);
  }
  if (p.balance_note) lines.push(`BALANCE & LIFE (honor recovery and the life around training — never push past what's sustainable): ${p.balance_note}`);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// renderRunZones: the athlete's Z1–Z5 bpm bands grounded in real physiology
// (max-HR + resting HR), so the agent prescribes runs to an actual pulse instead
// of a vague "easy". Quiet by default — "" when no zones are available (no age +
// no Garmin HR). Plain words + concrete bpm, never a score.
export function renderRunZones(ctx: PartialCoachContext): string {
  const z = ctx?.run_zones as any;
  if (!z || !z.available || !Array.isArray(z.zones) || !z.zones.length) return "";
  const bands = z.zones
    .map((b: any) => `${b.zone} ${b.label} ${b.low_bpm}–${b.high_bpm} bpm (${b.feel})`)
    .join("; ");
  return `\nRUN HR ZONES (the athlete's real bpm bands — prescribe runs to these, not a vague effort): ${bands}.${z.note ? ` ${z.note}` : ""}\n`;
}

// renderRunPlan: this week's PERIODIZED run mix from the deterministic engine —
// the FLOOR the agent REFINES, never reinvents (exactly as renderProgramState
// floors the strength evolution). Folds the mix summary, the quality focus, the
// long run, and any interval structure into the running prompts, plus the two
// sibling running reads (mono-stimulus VARIETY nudge + a due endurance RE-TEST)
// so they reach every running prompt, not just the conductor's terse deferral.
// Quiet by default — "" when there's nothing running to say.
export function renderRunPlan(ctx: PartialCoachContext): string {
  const rp = ctx?.run_plan as any;
  const variety = ctx?.run_variety as any;
  const tests = Array.isArray(ctx?.endurance_tests) ? ctx.endurance_tests : [];
  const lines: string[] = [];
  if (rp?.available && Array.isArray(rp.runs) && rp.runs.length) {
    lines.push(
      `THIS WEEK'S RUN PLAN (deterministic, periodized FLOOR — trust it as the starting structure and REFINE it, never reinvent; ${rp.why}):`,
    );
    if (rp.mix_summary) lines.push(`  Mix: ${rp.mix_summary}${rp.quality_focus ? ` · quality focus: ${rp.quality_focus}` : ""}.`);
    for (const r of rp.runs) {
      const dist = r.target_distance_km != null ? `${r.target_distance_km} km` : (r.target_duration_min != null ? `${r.target_duration_min} min` : "");
      const zone = r.target_zone ? ` @ ${r.target_zone}` : "";
      let ivl = "";
      if (Array.isArray(r.interval) && r.interval.length) {
        ivl = ` — ${r.interval.map((iv: any) => `${iv.reps} × ${iv.on}${iv.zone ? ` @ ${iv.zone}` : ""}, ${iv.off} recovery`).join("; ")}`;
      }
      lines.push(`  - Day ${r.day_number}: ${r.label || "Run"}${dist ? ` ${dist}` : ""}${zone}${ivl}.`);
    }
    if (Array.isArray(rp.rationale) && rp.rationale.length) {
      lines.push(`  Why this week: ${rp.rationale.join(" ")}`);
    }
    lines.push("  Keep lifting supportive so it doesn't compromise the key runs. Apply via the run-plan apply path (a draft, never auto-applied).");
  }
  // Mono-stimulus running → a gentle variety nudge (only fires with enough history).
  if (variety?.note) {
    const sugg = Array.isArray(variety.suggestions) && variety.suggestions.length ? ` Options: ${variety.suggestions.join(", ")}.` : "";
    lines.push(`RUN VARIETY (a nudge, never a rule): ${variety.note}${sugg}`);
  }
  // A cadenced endurance benchmark is due — invite it, never force it.
  if (tests.length) {
    lines.push(`ENDURANCE RE-TEST (a benchmark is due — invite it, never force it): ${tests.map((t: any) => `${t.exercise} (${t.why})`).join("; ")}.`);
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// renderMuscleGroups: the per-canonical-group ADVANCING vs STALLING read (the
// athlete's own mental model), plus — when a group is stalling — the MENU of
// same-pattern variations to rotate in. Optionally a short TEST WEEK line when a
// cadenced re-test is due. Quiet by default — "" when nothing's logged to read.
export function renderMuscleGroups(ctx: PartialCoachContext): string {
  const gt = ctx?.groups_trajectory as any;
  const tw = ctx?.test_week as any;
  const lines: string[] = [];
  if (gt?.available && Array.isArray(gt.groups) && gt.groups.length) {
    lines.push(`MUSCLE GROUPS — ADVANCING vs STALLING (the athlete thinks in groups; plain words, no scores): ${gt.headline}`);
    for (const g of gt.groups) {
      let line = `  - ${g.label} [${g.verdict}]${g.lead_lift ? ` — ${g.lead_lift}` : ""}: ${g.note}`;
      if (g.verdict === "stalling" && Array.isArray(g.vary_options) && g.vary_options.length) {
        line += ` Rotate one in: ${g.vary_options.map((v: any) => v.name).join(", ")}.`;
      }
      lines.push(line);
    }
  }
  if (tw?.due && Array.isArray(tw.key_lifts) && tw.key_lifts.length) {
    lines.push(`TEST WEEK (a cadenced re-test is due — invite it, never force it): ${tw.why} Key lifts to re-test: ${tw.key_lifts.join(", ")}.`);
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// renderDexaTargeting: the "FROM YOUR DEXA" block — maps the body scan's regional
// read (lean asymmetry, low ALMI/FFMI, low BMD, visceral/central fat) to concrete
// training (and one nutrition) targets, each with a plain "path to the next scan".
// `focus` routes the right targets to the right prompt: 'training' folds the
// training targets into the strength prompts; 'nutrition' folds the visceral/central
// fat target into the meal prompts. BMD/visceral stay INFORMATIONAL (clinician-
// framed), never a score. Quiet by default — "" with no DEXA / no relevant target.
export function renderDexaTargeting(ctx: PartialCoachContext, focus: "training" | "nutrition"): string {
  const dt = ctx?.dexa_targeting as any;
  if (!dt || !dt.available || !Array.isArray(dt.targets) || !dt.targets.length) return "";
  const want = dt.targets.filter((t: any) => t.domain === focus);
  if (!want.length) return "";
  const lines: string[] = [];
  lines.push(
    focus === "training"
      ? "FROM YOUR DEXA (the body scan's regional read → where to point the volume; T/Z-scores + ALMI are recognized reference reads, never a score; BMD targets are informational — worth raising with the clinician):"
      : "FROM YOUR DEXA (body-composition read → a nutrition nudge, worth keeping an eye on, never a hard rule):",
  );
  for (const t of want) {
    const moves = Array.isArray(t.moves) && t.moves.length ? ` Moves: ${t.moves.join(", ")}.` : "";
    lines.push(`  - ${t.area}: ${t.signal} → ${t.bias}.${moves} Path: ${t.path}`);
  }
  return `\n${lines.join("\n")}\n`;
}

// Elite-coach + longevity guardrails for the STRENGTH prompts — the
// programming-quality floor this athlete's history demands, in plain,
// suggestion-framed words (no scores). Folded into the coach / session /
// week-ahead prompts so core, grip, mobility and ankle work are treated as
// first-class, cumulative elbow load is managed, and earned rest is protected.
// The GENERIC elite-programming block — true for ANY athlete, no personal specifics.
// buildEliteGuardrails(ctx) below layers this athlete's DERIVED specifics on top
// (injuries, an endurance goal, flagged labs). Kept as a plain constant because the
// Brief (day.ts) and health-review (health.ts) prompts embed it without a ctx —
// they get the correct-for-everyone floor; only the coach prompts personalize it.
export const ELITE_STRENGTH_GUARDRAILS = `ELITE PROGRAMMING GUARDRAILS (longevity-minded; a complete program, not just the big lifts — all suggestions, never gates, no scores):
- CORE is first-class: program anti-extension / anti-rotation work (planks, pallof press, dead bugs) and LOADED CARRIES — they build trunk stability, posture and bone density. Don't leave them as an afterthought.
- GRIP / FOREARM work is first-class too: dead hangs and loaded carries build grip and protect the elbow, and carry over to every pull. If none is programmed, work some in.
- MOBILITY / ANKLE / calf / tibialis resilience matters: a few minutes of ankle + hip prep and direct calf/tibialis work protect the joints under running and lifting. Mobility is tracked but never counts as working volume.
- MANAGE CUMULATIVE GRIP + ELBOW LOAD as a SHARED BUDGET across RDLs, heavy pulls/rows, and dead hangs. Don't stack a heavy pulling day, an RDL session and long hangs back-to-back; use straps on the heaviest pulls when grip is the limiter, and spread elbow-intensive work out.
- BALANCE PUSHING vs PULLING and CHEST vs SHOULDERS: don't let lateral raises run ~2×/week while chest gets a single movement. Give horizontal pressing at least the volume the side delts get.
- WEIGHT EARNED REST as a strong choice: when recovery is drifting or several loading days have stacked, lean toward a genuine rest/deload — frame it as the strong, earned choice, never as falling behind.`;

// Derive THIS athlete's elite guardrails from context — injuries, endurance goal,
// flagged labs, stated preferences — instead of hard-coding one person's specifics
// into every committed prompt (which is simply wrong for any OTHER user). Layers the
// GENERIC block above with the specifics that actually apply. An empty profile yields
// exactly the generic block; seed data with an ankle history + a half-marathon goal +
// low free-T surfaces those representative specifics. Constitution: suggestions, no
// scores; health flags are informational, not medical advice.
export function buildEliteGuardrails(ctx: any): string {
  const extra: string[] = [];

  // One lowercased haystack of the free-text context sources that name injuries,
  // preferences, and flagged findings. Bounded + defensive — any missing key is "".
  const injuries = injuryText(ctx);
  const haystack = [
    injuries,
    stringifySafe(ctx?.about_me ?? ctx?.profile?.about_me),
    stringifySafe(ctx?.memory),
    stringifySafe(ctx?.directives),
    stringifySafe(ctx?.health),
    stringifySafe(ctx?.health_review),
  ].join(" \n ").toLowerCase();

  const has = (...needles: string[]) => needles.some((n) => haystack.includes(n));
  const injuryHas = (...needles: string[]) => needles.some((n) => injuries.toLowerCase().includes(n));

  // Endurance goal / returning-runner framing (drives the ankle+calf emphasis).
  const goal = ctx?.endurance_goal ?? null;
  const disc = String(ctx?.discipline?.primary ?? ctx?.profile?.primary_discipline ?? "").toLowerCase();
  const enduranceSport = String(ctx?.discipline?.endurance_sport ?? ctx?.profile?.endurance_sport ?? "").toLowerCase();
  const runningFocus = disc === "endurance" || disc === "hybrid" || /run|jog|marathon/.test(enduranceSport) || (goal && (goal.is_race || goal.event));
  const raceEvent = goal && goal.event ? String(goal.event).slice(0, 60) : null;

  // Lower-limb / running-joint history → an ankle/calf/tibialis resilience emphasis
  // that names the actual reason (injury history and/or a running goal).
  const lowerLimb = injuryHas("ankle", "foot", "achilles", "calf", "shin", "tibial", "plantar");
  if (lowerLimb || runningFocus) {
    const why = lowerLimb && runningFocus
      ? "a lower-limb history and a return to running"
      : lowerLimb ? "a lower-limb injury history" : "a return to running";
    const race = raceEvent ? ` toward ${raceEvent}` : "";
    extra.push(`- ANKLE + CALF/TIBIALIS RESILIENCE is a priority here given ${why}${race}: keep a few minutes of ankle + hip prep and direct calf/tibialis work in every relevant session — it protects the joints under running load.`);
  }

  // Elbow / cubital-tunnel / wrist sensitivity → tighten the grip+elbow shared-budget.
  if (injuryHas("elbow", "cubital", "wrist", "forearm", "tendin") || has("cubital", "epicondyl")) {
    extra.push(`- ELBOW SENSITIVITY on record: treat grip- and elbow-intensive work (RDLs, heavy rows/pulls, long dead hangs) as a shared budget — don't stack them back-to-back, use straps when grip is the limiter, and keep supinated/curl load conservative.`);
  }

  // Low testosterone / free-T flag → recovery emphasis on top of earned rest.
  if (has("free t", "free-t", "testosterone", "low t ")) {
    extra.push(`- RECOVERY MATTERS MORE HERE: testosterone reads on the low side, so protect sleep and earned rest even harder — when in doubt, take the deload; it's the strong choice, not falling behind.`);
  }

  // A named upper-body preference tailors the balance emphasis (e.g. prefers barbell bench).
  if (has("barbell bench", "prefers bench", "bench press") && !extra.some((e) => e.includes("BENCH PREFERENCE"))) {
    // Only when it reads as a genuine preference, not just any mention.
    if (has("prefer") && has("bench")) {
      extra.push(`- BENCH PREFERENCE noted: they favour barbell bench — anchor horizontal pressing there, but keep chest volume in balance with the side-delt work rather than letting laterals outpace pressing.`);
    }
  }

  if (!extra.length) return ELITE_STRENGTH_GUARDRAILS;
  return `${ELITE_STRENGTH_GUARDRAILS}\n\nSPECIFIC TO THIS ATHLETE (derived from their context — injuries, goal, labs; informational, not medical advice):\n${extra.join("\n")}`;
}

// Pull active injury free-text out of context_events (kind:'injury') for the derivation.
function injuryText(ctx: any): string {
  const events = Array.isArray(ctx?.context_events) ? ctx.context_events : [];
  const parts: string[] = [];
  for (const ev of events) {
    if (ev?.kind !== "injury") continue;
    const meta = ev?.meta && typeof ev.meta === "object" ? ev.meta : null;
    for (const s of [ev?.title, ev?.detail, meta?.area]) if (s) parts.push(String(s));
  }
  return parts.join(" ");
}

function stringifySafe(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return ""; }
}

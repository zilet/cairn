// Day-driver prompts: the Brief day-read, the on-demand session, the quiet
// cross-domain insight, and the standing weekly read.
import * as repo from "../repo.js";
import type { CoachContext } from "../repo/coach-context.js";
import {
  activeInjuryAreas,
  COACHING_STANCE,
  CONTEXT_GUARDRAILS,
  ELITE_STRENGTH_GUARDRAILS,
  renderActiveContext,
  renderCoachingFocus,
  renderBodyComp,
  renderConnectedBrain,
  renderDexaTargeting,
  renderDiscipline,
  renderEnduranceGoal,
  renderMuscleGroups,
  renderNow,
  renderPerformance,
  renderProgramState,
  renderReactionModel,
  renderRunCompliance,
  renderRunPlan,
  renderRunZones,
  renderTodayFuel,
  renderTrainingSignals,
  renderTrajectory,
  renderStreamingContract,
  CAIRN_PERSONA,
} from "./shared.js";

// ---------- the day read (Phase 1A — the soul) ----------
const DAY_READ_SCHEMA = `{
  "kind": "train|easy|rest|done",
  "headline": "<2-5 word plain-language state. Prospective when train/easy/rest ('Long run today.'); past-tense acknowledgement when done ('Long run done.')>",
  "why": "<one warm, plain sentence — what you saw and why; NO numbers, NO scores>",
  "focus": "<train: the session character. For a LIFTING day this is the muscle focus ('Lower body'); for an ENDURANCE user it can be the run/ride character — 'Easy', 'Long', 'Tempo', 'Intervals', 'Recovery'. null on rest.>",
  "est_minutes": <rough minutes for the suggestion, or null>
}`;

// A compact, deterministic read of the training history so the agent grasps the
// RHYTHM (frequency, freshness, recent emphasis, sore/joint flags) without having
// to reconstruct it from the raw session blob — this is what makes the Brief feel
// like it "remembers everything you've done", not just today's signals.
function trainingRhythmLine(allSessions: any[], date?: string): string {
  const sessions = Array.isArray(allSessions) ? allSessions : [];
  if (!sessions.length) return "(no training logged yet — ease in)";
  const dayMs = 864e5;
  const ref = date ? new Date(date + "T00:00:00Z").getTime() : Date.now();
  const ageDays = (d?: string) => (d ? Math.floor((ref - new Date(d + "T00:00:00Z").getTime()) / dayMs) : null);
  const trained = sessions.filter((s) => Array.isArray(s?.sets) && s.sets.length);
  const last = trained[0] || sessions[0];
  const since = ageDays(last?.date);
  const within = (days: number) =>
    sessions.filter((s) => { const a = ageDays(s?.date); return a != null && a >= 0 && a < days; }).length;
  const last7 = within(7);
  const last28 = within(28);
  const recentFocus = [...new Set(sessions.slice(0, 3).map((s) => s?.title || s?.day_name).filter(Boolean))];
  const jointFlags = [...new Set(sessions.slice(0, 4).map((s) => s?.joint_pain).filter(Boolean))];
  const sore = sessions.slice(0, 3).filter((s) => s?.soreness != null && Number(s.soreness) >= 4).length;
  const bits: string[] = [];
  bits.push(since == null ? "no dated sessions" : since <= 0 ? "trained today already" : since === 1 ? "last trained yesterday" : `last trained ${since} days ago`);
  bits.push(`${last7} session${last7 === 1 ? "" : "s"} in the last 7 days · ${last28} in 28`);
  if (recentFocus.length) bits.push(`recent emphasis: ${recentFocus.join(" → ")}`);
  if (jointFlags.length) bits.push(`flagged joints recently: ${jointFlags.join(", ")}`);
  if (sore) bits.push(`reported sore after ${sore} of the last 3`);
  return bits.join("; ") + ".";
}

// A QUIET standing-health line for the Brief: the elite-coach synthesis headline +
// the one change, offered as optional pull — the day-read may fold ONE calm clause
// in when it naturally fits today, but usually leaves it unsaid (the Brief is about
// today's training, not a health lecture). "" when there's no synthesis yet.
function renderHealthLead(ctx: any): string {
  const s = ctx?.health_synthesis;
  if (!s || !(s.headline || s.one_change)) return "";
  const bits = [s.headline, s.one_change ? `the one change worth holding: ${s.one_change}` : null].filter(Boolean);
  return `\nSTANDING HEALTH FOCUS (their whole-picture read — surface at most ONE quiet clause and ONLY if it fits today, in a friend's voice, never alarming; usually leave it unsaid): ${bits.join(" — ")}\n`;
}

// The single agentic judgment at the heart of the product: given the whole
// picture, what KIND of day should this be? Honors the constitution — it's a
// SUGGESTION, never a verdict; kind, never anxious; plain language, never a
// score. repo.dayRead computes deterministic signals first; this builder asks
// the agent to make the nuanced call and write the human sentence. opts let the
// caller pass an escape-hatch override ("rough night" / "short on time").
// The deterministic facts behind a post-session DEBRIEF (the "done" read): what was
// trained today (top set per lift), how it fits the week, what the next session leans
// toward + what's due, and where fuel sits. Plain facts only — the agent turns them
// into a warm debrief. Every read is its own try/catch so a missing surface degrades
// to fewer facts, never throws. Returns "" when there's nothing concrete to say.
function debriefFacts(date: string): string {
  const lines: string[] = [];
  // 1) Today's session — the top set per lift + the volume done.
  try {
    const sess: any = repo.getSessionByDate(date);
    const sets: any[] = Array.isArray(sess?.sets) ? sess.sets : [];
    if (sets.length) {
      const top = new Map<string, any>();
      for (const s of sets) {
        const score = s.mode === "timed" ? (Number(s.duration_sec) || 0) : (Number(s.weight) || 0) * 1000 + (Number(s.reps) || 0);
        const cur = top.get(s.exercise);
        if (!cur || score > cur._score) top.set(s.exercise, { ...s, _score: score });
      }
      const fmtSet = (s: any): string => {
        if (s.mode === "timed" && s.duration_sec != null) return `${s.duration_sec}s`;
        if (s.weight == null && s.reps != null) return `${s.reps} reps (bodyweight)`;
        if (s.weight != null && s.reps != null) {
          const w = Number(s.weight);
          const load = w < 0 ? `bw−${-w} lb` : w === 0 ? "bodyweight" : `${w} lb`;
          const rir = s.rir != null ? ` @RIR${s.rir}` : "";
          return `${load} × ${s.reps}${rir}`;
        }
        return "logged";
      };
      const lifts = [...top.entries()].slice(0, 8).map(([name, s]) => `${name} ${fmtSet(s)}`);
      const sum: any = repo.sessionSummary?.(sess.id) ?? null;
      const vol = sum && sum.tonnage > 0 ? ` (${sum.sets} sets · ${Math.round(sum.tonnage).toLocaleString()} lb)` : sum ? ` (${sum.sets} sets)` : "";
      lines.push(`SESSION TODAY${sess.title ? ` — ${sess.title}` : ""}${vol}: ${lifts.join("; ")}.`);
    }
  } catch { /* no session detail → skip */ }
  // 1b) Today's CARDIO — a synced/logged run or ride, with the physiology that's
  // actually there (distance · moving time · avg HR · pace), so the agent debriefs the
  // REAL effort instead of guessing ("an easy run" when it was a hard one). Plain
  // numbers, never a score; skip silently when nothing endurance was logged today.
  try {
    const cardio: any[] = repo.getCardioForDate?.(date) ?? [];
    for (const c of cardio.slice(0, 2)) {
      const bits: string[] = [];
      if (c?.distance_km != null) bits.push(`${Math.round(Number(c.distance_km) * 10) / 10} km`);
      if (c?.duration_min != null) bits.push(`${Math.round(Number(c.duration_min))} min`);
      if (c?.avg_hr != null) bits.push(`avg HR ${Math.round(Number(c.avg_hr))}`);
      if (c?.pace) bits.push(String(c.pace));
      const label = c?.type && c.type !== "other" ? String(c.type) : "cardio";
      if (bits.length) lines.push(`CARDIO TODAY — ${label}: ${bits.join(" · ")}${c?.source === "garmin" ? " (synced)" : ""}.`);
    }
  } catch { /* no cardio → skip */ }
  // 2) Forward — the day-ahead (the SAME forwardLook the Brief's forward line uses).
  try {
    const fwd: any = repo.forwardLook(date);
    if (fwd?.next_focus) lines.push(`NEXT SESSION leans toward: ${fwd.next_focus}.`);
    if (Array.isArray(fwd?.due) && fwd.due.length) {
      lines.push(`DUE THIS WEEK (under its productive range — a good forward focus): ${fwd.due.join(", ")}.`);
    }
  } catch { /* no forward look → skip */ }
  // 3) Fuel — only a real protein gap (or a clean "in") is worth a word; never a score.
  try {
    const intake: any = repo.getDayIntake(date);
    if (intake?.target && intake?.remaining) {
      const pr = Math.round(Number(intake.remaining.protein_g));
      if (Number.isFinite(pr)) {
        if (pr >= 25) lines.push(`FUEL: protein is ~${pr} g short of today's target so far — a brief refuel nudge fits.`);
        else if (pr <= -10) lines.push(`FUEL: protein target comfortably met today — no nudge needed.`);
        else lines.push(`FUEL: protein is on track today — no nudge needed.`);
      }
    }
  } catch { /* no nutrition target → no fuel line */ }
  return lines.length ? `\nDEBRIEF FACTS (deterministic — weave only what's true, drop the rest):\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}

export function buildDayReadPrompt(ctx?: CoachContext, opts: { override?: string; date?: string } = {}): string {
  const context = ctx ?? repo.getCoachContext();
  const baseline = repo.dayRead(opts.date);
  const overrideBlock = opts.override?.trim()
    ? `\nUSER OVERRIDE (honor this — they're steering): "${opts.override.trim()}". Reshape the read accordingly (e.g. "rough night" → lean easy/rest; "short on time" → a compressed session; "I want to train anyway" → a train read even if the baseline leaned rest, kept appropriately light).\n`
    : "";
  // A compact recent-training summary so the agent reads the rhythm without
  // digging through the raw DATA blob — last few sessions + days since each,
  // plus the whole-history rhythm line (frequency / freshness / emphasis).
  const allSessions = Array.isArray(context?.recent_sessions) ? context.recent_sessions : [];
  const sessions = allSessions.slice(0, 6);
  const sessionLine = sessions.length
    ? sessions.map((s: any) => { const nm = s?.title || s?.day_name; return `${s?.date ?? "?"}${nm ? ` (${nm})` : ""}`; }).join(", ")
    : "(no recent sessions logged)";
  const rhythmLine = trainingRhythmLine(allSessions, opts.date);
  // What's already on the board for today — a logged session and/or activities.
  // Surfaced explicitly so the agent reflects it ("nice, you've already moved")
  // instead of suggesting a fresh session as if the day were blank.
  const lt: any = baseline.signals && (baseline.signals as any).logged_today;
  const ltActs: any[] = Array.isArray(lt?.activities) ? lt.activities : [];
  const ltBits: string[] = [];
  if (lt && Number(lt.sets) > 0) ltBits.push(`${lt.sets} set${Number(lt.sets) === 1 ? "" : "s"} logged`);
  for (const a of ltActs) {
    const parts = [a?.type && a.type !== "other" ? String(a.type) : "activity"];
    if (a?.duration_min != null) parts.push(`${a.duration_min} min`);
    if (a?.distance_km != null) parts.push(`${a.distance_km} km`);
    ltBits.push(parts.join(" "));
  }
  const todayLine = ltBits.length
    ? `\nALREADY LOGGED TODAY: ${ltBits.join("; ")}. Acknowledge what they've already done and reflect it in the read — do NOT suggest a fresh session as if the day were blank.`
    : "";
  // Last night's sleep architecture + HRV in plain words (it's inside the signals
  // blob already, but called out so the agent actually voices it when it matters).
  const ln: any = baseline.signals && (baseline.signals as any).last_night;
  const lastNightLine = ln && ln.text
    ? `\nLAST NIGHT: ${ln.text}. When it's worth a mention, name last night in plain words — one calm clause in a friend's voice ("you slept well", "a bit light on deep sleep", "HRV's a touch below your norm") — never a number wall or a score, and let how they actually feel override it.`
    : `\nSLEEP/RECOVERY: no recent sleep or HRV data has synced. Do NOT claim or imply how they slept ("you slept fine", "well-rested", etc.) — you have no sleep signal for last night. Speak only to what the data actually shows (training, recovery trend, the day ahead).`;
  // The user has ALREADY completed a real, loading session today (a deterministic
  // fact). This becomes a post-session DEBRIEF, not a fresh suggestion: acknowledge the
  // specific work, place it in the week, give ONE forward focus, and nudge refuel only
  // if there's a real gap. The facts below are deterministic; the agent writes the prose.
  const doneBlock = baseline.kind === "done"
    ? `\nDEBRIEF MODE (a real, loading session is already logged today — this is a post-session debrief, NOT a fresh suggestion):
- Do NOT propose more training unless they ask. The day's work is in.
- "headline": acknowledge the WORK specifically — name what they actually did (a standout lift from SESSION TODAY, or the run/ride from CARDIO TODAY with its real effort) like a friend who watched you train, e.g. "Strong push session." / "Solid 6 km — you pushed that one.". If CARDIO TODAY shows a hard effort (high avg HR), don't call it "easy".
- "why": for a DONE day you MAY use 2-3 short sentences (the one exception to one-sentence): (1) how today fits the week's rhythm, (2) ONE forward focus — what the next session leans toward / what's DUE, (3) a brief refuel nudge ONLY if FUEL shows a real protein gap. Warm, plain, never a number-wall or a score.
- Output "kind":"done", "focus":null, "est_minutes":null. DONE is a factual temporal state, not another easy-day recommendation.${debriefFacts(opts.date || context.now?.date || new Date().toISOString().slice(0, 10))}`
    : "";
  return `${CAIRN_PERSONA}

This is the Brief — today's day-read. Read their WHOLE picture and
judge what kind of day today should be: a real session, easy movement, or rest. This opens their
app — it is the first and often only thing they see.
${renderNow(context)}
THE CONSTITUTION (binding):
- It is a SUGGESTION you offer, never a verdict you impose. The user drives; you navigate.
- Be KIND and never anxious. Rest is wisdom, not failure. A low signal is information, never a
  judgement; their felt experience overrides any number.
- CALM and plain. No 0-100 scores, no metric dump — numbers are vanity. Say the one true thing in
  a friend's voice. Three lines on a good day.
- Protect rest when it's earned (several hard days running, short sleep, run-down) — do NOT default
  to opening a lifting plan every morning. Never insist on rest either. When you suggest rest, frame
  it as the wise, earned choice ("rest is wisdom"), never as falling behind.
- ANTICIPATE fatigue, don't just react to it. When the signals carry a "fatigue" block with
  anticipate_deload=true, recovery is drifting below the user's OWN norm (HRV down / resting HR up
  / sleep short vs baseline) while training days stack up — so today can still be a GREEN-LIGHT to
  train, but add a gentle forward-looking heads-up in a friend's voice ("you're good today, but a
  couple more hard days and you'll likely want a reset"). It's a kind early warning, never a brake or
  a verdict — the user still drives.

DETERMINISTIC SIGNALS already computed (use them, but you make the final nuanced call):
${JSON.stringify(baseline.signals)}
A rules-only baseline suggested: kind="${baseline.kind}", focus=${JSON.stringify(baseline.focus)}.
You MAY disagree with the baseline when the whole picture warrants it — it is a floor, not a ceiling.
RECENT TRAINING (most recent first): ${sessionLine}.
TRAINING RHYTHM (read the whole history, not just today): ${rhythmLine}${todayLine}${doneBlock}${lastNightLine}
${CONTEXT_GUARDRAILS}
${renderCoachingFocus(context, { brief: true })}${renderDiscipline(context, "day")}${renderEnduranceGoal(context, "day")}${renderRunCompliance(context, "day")}${renderRunZones(context)}${renderRunPlan(context)}${renderConnectedBrain(context, { domains: ["training", "watch"] })}${renderProgramState(context, { brief: true })}${renderMuscleGroups(context)}${renderPerformance(context, { brief: true })}${renderDexaTargeting(context, "training")}${renderBodyComp(context)}${renderHealthLead(context)}${renderReactionModel(context)}${renderTrajectory(context)}${renderActiveContext(context)}${renderTodayFuel(context)}${overrideBlock}
OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${DAY_READ_SCHEMA}

DATA:
${JSON.stringify(context)}`;
}

// ---------- on-demand session ("build me a session for today" — Phase 1D) ----------
const SESSION_SUGGEST_SCHEMA = `{
  "name": "<short session name, e.g. 'Lower body — quad focus' or 'Easy Z2 run'>",
  "focus": "<muscle/quality focus>",
  "est_minutes": <total minutes, number>,
  "why": "<one plain sentence on why this fits today>",
  "items": [
    { "exercise": "<exact name; reuse plan/exercise names where sensible>",
      "sets": <number>, "rep_low": <number|null>, "rep_high": <number|null>,
      "target_weight": <number|null>, "target_seconds": <number|null>,
      "mode": "reps|timed", "note": "<short cue / why, optional>" },
    { "kind": "cardio", "exercise": "<the activity, e.g. 'Easy run' / 'Z2 ride'>",
      "target_distance_km": <number|null>, "target_duration_min": <number|null>,
      "target_zone": "<'Z2' | 'tempo' | 'easy' | null>", "note": "<optional — interval structure / cue>" }
  ],
  "notes": "<optional — swaps, equipment, anything to flag>"
}`;

// "Ask it for a session right now." An on-demand agentic call that honors the
// user's constraints (a time budget, an injury, available equipment) and the
// day read, returning a session SUGGESTION for review (you drive — nothing is
// applied). opts carry the constraints the launchpad chips pass through.
export function buildSessionPrompt(ctx?: CoachContext, opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string } = {}): string {
  const context = ctx ?? repo.getCoachContext();
  const read = repo.dayRead(opts.date);
  const wants: string[] = [];
  if (opts.minutes) wants.push(`TIME BUDGET: about ${Math.round(opts.minutes)} minutes — fit the whole session in that (drop accessories before compounds).`);
  if (opts.focus) wants.push(`FOCUS REQUESTED: ${opts.focus.trim()}.`);
  if (opts.equipment) wants.push(`EQUIPMENT AVAILABLE: ${opts.equipment.trim()} — only program what this allows.`);
  if (opts.constraints) wants.push(`WHAT THEY SAID (free text — read it like a coach and adapt): "${opts.constraints.trim()}". Honor the spirit: a sore/tired area → de-load or SWAP it for a different pattern / lower-impact option (see the swap menu); "easier" → lighter loads + shorter; "no <equipment>" → only what's available.`);
  // When the user asks for something specific (a sore area, a focus, an
  // equipment limit), hand the agent a concrete SWAP MENU from the variation
  // library so it trades a movement for a real same-pattern alternative instead of
  // inventing one. Bounded; only when there's a request to adapt to.
  let swapMenu = "";
  if (opts.constraints || opts.focus) {
    const injuryAreas = activeInjuryAreas(context);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const day of Array.isArray(context?.plan) ? context.plan as any[] : []) {
      for (const it of Array.isArray(day?.items) ? day.items : []) {
        const name = it?.exercise;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        // Injury-aware swaps so "easier on the legs" with a bad knee never offers a
        // knee-loading alternative.
        const alts = (repo.suggestAlternatives(name, { limit: 3, injuryAreas }) as any[]).map((v) => v.name);
        if (alts.length) lines.push(`- ${name} → ${alts.join(", ")}`);
        if (lines.length >= 12) break;
      }
      if (lines.length >= 12) break;
    }
    if (lines.length) {
      swapMenu = `\nSWAP MENU (same-pattern alternatives for the plan's movements — use these to honor the request: trade a sore-area or off-limits lift for a different pattern or a lower-impact option, keeping loads conservative; you may also program something not listed):\n${lines.join("\n")}\n`;
    }
  }
  return `${CAIRN_PERSONA}

Right now you're the strength & conditioning coach. Build ONE session for today,
on demand, honoring their real constraints and whole picture. This is a SUGGESTION for them to
review — nothing is applied automatically (they drive).
${renderNow(context)}
GUARDRAILS:
- Conservative loading; respect every exercise constraint_note (e.g. injury limits)
  and any active injury in context_events — never program loaded movement through an injured area.
- Assisted movements use NEGATIVE target_weight; bodyweight uses null. TIMED work (plank, dead hang)
  uses target_seconds + mode:"timed", never load.
- Carry over sensible working weights from the plan / recent logs where they fit. Thin data → start
  light with a "NEW — start light, log actual" note.
- Honor the day read: if today reads as rest/easy (kind="${read.kind}"), keep this session light and
  short unless the user explicitly asked to train hard.

${ELITE_STRENGTH_GUARDRAILS}

${CONTEXT_GUARDRAILS}
${renderCoachingFocus(context)}${COACHING_STANCE}

${renderDiscipline(context, "training")}${renderEnduranceGoal(context, "training")}${renderRunZones(context)}${renderRunPlan(context)}${renderConnectedBrain(context, { domains: ["training", "watch"] })}${renderTrainingSignals(context)}${renderProgramState(context)}${renderMuscleGroups(context)}${renderPerformance(context)}${renderDexaTargeting(context, "training")}${renderBodyComp(context)}${renderReactionModel(context)}${renderActiveContext(context)}${renderTodayFuel(context)}${wants.length ? `
WHAT THE USER ASKED FOR:
${wants.join("\n")}
` : ""}${swapMenu}
${renderStreamingContract(
    "write ONE or two plain sentences on why this session fits them today (the same thought that goes in the JSON's \"why\")",
    SESSION_SUGGEST_SCHEMA,
  )}

DATA:
${JSON.stringify(context)}`;
}

// ---------- quiet cross-domain insight (Phase 6A — pull, never push) ----------
const INSIGHT_SCHEMA = `{
  "kind": "connection",
  "found": true,
  "text": "<the ONE connection, one or two plain sentences in a friend's voice — NO numbers as scores, NO alarm>",
  "rationale": "<ONE short sentence (≤240 chars) of plain-language reasoning that backs the connection — speak TO the user ('your recent labs show…'), never narrate the data structures you were given>",
  "next_step": "<OPTIONAL: one concrete, low-friction next step (a food swap, a retest to consider) in ≤140 chars, or null — calm, never a directive>"
}`;

// The quiet-intelligence pass. Hunts the user's WHOLE picture for ONE genuine
// cross-domain connection they couldn't easily make themselves — the kind a
// friend who knew their labs, training, food and life would notice ("ferritin
// ran low in spring and your volume's been down since — could be iron-limited").
// It runs on demand / periodically and the result waits in-app; NOTHING is
// pushed. Honors the constitution: at most one real thing, plainly, kindly, or
// nothing at all. recent[] are insights already surfaced — do NOT repeat them.

export function buildInsightPrompt(ctx?: CoachContext, recent: string[] = []): string {
  const context = ctx ?? repo.getCoachContext();
  const recentBlock = recent.length
    ? `\nALREADY SAID (do NOT repeat or reword any of these — find something genuinely new, or return found:false):\n${recent.map((r) => `  - ${r}`).join("\n")}\n`
    : "";
  return `${CAIRN_PERSONA}

Look across their WHOLE picture
and find the ONE genuine cross-domain connection they likely couldn't make themselves — a thread that
links two domains (a lab marker and their training, their sleep/recovery and their nutrition, a life
event and a dip in volume). The kind of thing a sharp friend who quietly knew everything about them
would mention — once, when they happen to open the app.

THE CONSTITUTION (binding):
- PULL, never push. This waits in-app; it is never a notification, never a nag, never urgent.
- Exactly ONE connection, or NOTHING. If there isn't a real, data-grounded thread worth saying,
  return {"found": false} — silence is the right answer far more often than not. Do not manufacture
  an insight to fill the space.
- GROUNDED in their ACTUAL data only (recovery, markers/directives, training, nutrition, life/family
  context below). Never generic wellness advice; never a connection the data doesn't support.
- CALM and KIND. Plain language, a friend's voice. NO 0-100 scores, no metric dump, no alarm, no
  "you should" — offer a thought and an optional next step, never a verdict or a gate. Health findings
  are informational, NOT medical advice; defer anything clinical to a clinician.
- BRIEF and HUMAN. The headline carries the point; the rationale is ONE short sentence, not a
  paragraph. Speak TO the user in everyday words — NEVER narrate the data you were handed or name
  its internal fields (no "the health_review confirms…", "recent_sessions show…", "the goal object").
  No grocery-list of evidence; one plain reason is enough.
- It is a suggestion, never pressure. Rest and a quiet week are healthy, not problems to solve.
${recentBlock}
${renderTodayFuel(context)}
OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences.
When there's nothing real to say: {"found": false}
When there is exactly one genuine connection:
${INSIGHT_SCHEMA}

DATA:
${JSON.stringify(context)}`;
}

// ---------- standing weekly read (Phase 6B — a read that waits, not a nag) ----------
const WEEKLY_READ_SCHEMA = `{
  "kind": "weekly_read",
  "found": true,
  "text": "<how the week actually went, one or two warm plain sentences — a rest week reads as a rest week, not a failure; NO scores>",
  "rationale": "<OPTIONAL: ONE short sentence (≤240 chars) of plain reasoning for the suggestion below, in a friend's voice — never narrate internal data fields. Empty when the week needs no change>",
  "next_step": "<OPTIONAL: the ONE change worth considering next week, ≤140 chars, or null — a suggestion to consider, never a directive>"
}`;

// A standing "here's how your week went + the one change I'd suggest" that WAITS
// in-app for the user to read whenever they like — pull, never push. Stored
// as an insight with kind:'weekly_read' so the Brief can surface it like any
// other quiet line. Same calm voice as the cross-domain pass; honest continuity
// (six steady weeks is "nice", a light week is fine), never streak pressure.
export function buildWeeklyReadPrompt(ctx?: CoachContext): string {
  const base = ctx ?? repo.getCoachContext();
  // "At most ONE calm accountability verdict" is enforced here, not just asked of
  // the model: the weekly read's data carries only the single most recently
  // evaluated decisive outcome, so a second verdict cannot be mentioned. Other
  // surfaces (chat) keep the full per-decision outcomes.
  const decisions = Array.isArray((base as any).recent_decisions) ? (base as any).recent_decisions : [];
  const decisiveAt = (row: any) =>
    row?.latest_outcome && ["aligned", "not_aligned"].includes(row.latest_outcome.verdict)
      ? String(row.latest_outcome.evaluated_at ?? "")
      : null;
  const keep = decisions.reduce(
    (best: any, row: any) => (String(decisiveAt(row) ?? "") > String(decisiveAt(best) ?? "") ? row : best),
    null
  );
  const context = {
    ...base,
    recent_decisions: decisions.map((row: any) =>
      row === keep || !decisiveAt(row) ? row : { ...row, latest_outcome: null }
    ),
  };
  return `${CAIRN_PERSONA}

Prepare a short standing read of
how THIS WEEK actually went and the ONE change — if any — worth considering next week. It waits in the
app for them to read when they like; it is NEVER pushed at them.

THE CONSTITUTION (binding):
- CALM, KIND, plain language, a friend's voice. NO 0-100 scores, no metric wall, no judgement.
- Honest continuity, NOT streaks. A week with two rest days and a trip is a HEALTHY week — say so.
  Rest is wisdom, not a gap. Never imply a chain to keep or a failure to fix.
- At most ONE suggested change, plainly justified from what the data shows actually happened — and it
  is a suggestion to consider, never a directive. If the week went well and nothing needs changing,
  say that warmly and leave rationale and next_step empty. If there's genuinely nothing to report,
  return {"found": false}.
- If DATA.recent_decisions contains a mature latest_outcome worth mentioning, include AT MOST ONE calm
  accountability verdict: "that moved as expected", "that did not match what I expected", or "we cannot
  tell yet". Never claim causation, never list every check, and never turn it into a grade.
- BRIEF and HUMAN. The headline carries the read; rationale is ONE short sentence, never a paragraph.
  Speak TO the user in everyday words — NEVER narrate the data you were handed or name its internal
  fields. The one change, if any, goes in next_step.
- Grounded in their ACTUAL recent data only (training, recovery, nutrition, life context below).
${renderRunCompliance(context, "weekly")}
${renderTodayFuel(context)}
${renderStreamingContract(
    "write how their week actually went in ONE or two warm plain sentences (the same reading that goes in the JSON's \"text\")",
    WEEKLY_READ_SCHEMA,
    { emptyAnswer: '{"found": false}' },
  )}

DATA:
${JSON.stringify(context)}`;
}

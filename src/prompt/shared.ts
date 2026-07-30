// Shared prompt helpers: the cross-cutting guardrail blocks, discipline /
// endurance framing, the connected-brain + recovery renderer, and the exported
// render* conductor / program-state / performance helpers. Imported by the
// per-domain prompt modules and re-exported (with the public render* helpers +
// COACHING_STANCE) through the src/prompt.ts barrel. Behavior-preserving split.
import * as repo from "../repo.js";
import { extractJson } from "../agents.js";
import type { CoachContext, PartialCoachContext } from "../repo/coach-context.js";
import { type SensorSignal, sensorIsCurrent } from "../repo/sensor-freshness.js";
import { localDateISO } from "../repo/shared.js";

// getCoachContext deliberately describes the host's current local day. Dated
// prompts are historical/forward planning surfaces, so patch only their compact
// location view rather than changing that global contract.
export function dateScopedPromptContext(context: CoachContext, date?: string): CoachContext {
  if (!date) return context;
  try {
    return { ...context, location: repo.getLocationContext({ on: date }) };
  } catch {
    return context;
  }
}

// ---- prose-first reply contract (shared by chat AND the streaming job ops) ----
// The reply STREAMS, so the contract is prose-first: the model writes a marker, the
// athlete-facing prose (rendered live, token by token), then a data marker, then the
// structured JSON. Everything before the reply marker (an autonomous CLI's tool-step
// narration) is dropped; everything after the data marker is the JSON the op parses.
// These live here (a leaf module every prompt builder already imports) so ONE gate +
// parser serves chat (parseChatReply) and jobs (extractMarkedJson / renderStreamingContract).
export const CHAT_ACTION_SENTINEL = "===CAIRN_ACTIONS===";
export const CHAT_REPLY_SENTINEL = "===CAIRN_REPLY===";

// Marker-aware JSON extraction for the STREAMING job ops. The prose lives between the
// reply and data markers; the JSON follows the data marker — so we extractJson ONLY on
// the clean tail after the data marker, immune to a stray brace in the prose. Backward
// compatible: an agent that ignores the contract and emits the bare JSON (no markers)
// still parses via extractJson over the whole text, exactly the pre-contract behavior.
export function extractMarkedJson(text: string): any | null {
  const raw = (text ?? "").toString();
  const rIdx = raw.lastIndexOf(CHAT_REPLY_SENTINEL);
  const afterReply = rIdx !== -1 ? raw.slice(rIdx + CHAT_REPLY_SENTINEL.length) : raw;
  const dIdx = afterReply.lastIndexOf(CHAT_ACTION_SENTINEL);
  const jsonSource = dIdx !== -1 ? afterReply.slice(dIdx + CHAT_ACTION_SENTINEL.length) : afterReply;
  return extractJson(jsonSource);
}

// Render the prose-first OUTPUT CONTRACT for a streaming job op. `proseGuide` names what
// to write between the markers (the same reading that also goes in the JSON's prose
// field, kept authoritative); `schema` is the op's existing JSON contract, emitted
// verbatim after the data marker so the op's parse/sanity checks are unchanged. When an
// op has a "nothing to say" answer (found:false), pass `emptyAnswer` so the model can
// skip the prose entirely — extractMarkedJson still parses the bare object.
export function renderStreamingContract(proseGuide: string, schema: string, opts: { emptyAnswer?: string } = {}): string {
  const empty = opts.emptyAnswer
    ? `\nIf there is genuinely nothing to say, skip the prose and both markers and emit only: ${opts.emptyAnswer}\n`
    : "";
  return `OUTPUT CONTRACT — write it in TWO parts so your reading streams into their card as you write it:
1. Put this marker on its OWN line, exactly:
${CHAT_REPLY_SENTINEL}
2. AFTER it, ${proseGuide} — plain, warm prose only (no JSON, no code fence, no headers). This is shown to them live, word by word, so write it for a human.
3. THEN put this marker on its OWN line, exactly:
${CHAT_ACTION_SENTINEL}
4. Immediately after it, ONE JSON object exactly as specified below — no prose, no fences:
${schema}${empty}`;
}

// The non-streaming counterpart to renderStreamingContract: ONE canonical "return
// only JSON" preamble. ~25 hand-written variants had drifted into two wordings ("no
// fences" vs the stricter "ONE bare JSON object only — no markdown fences"), so the
// bar an op set depended on which builder its author copied. The strictest wording
// wins here. Op-specific clauses are options rather than a reason to hand-write the
// preamble again: `note` extends the contract sentence, `lead` introduces the schema
// (an alternative "nothing to say" answer), `after` follows it.
export function renderJsonContract(
  schema: string,
  opts: { note?: string; lead?: string; after?: string } = {}
): string {
  const note = opts.note ? ` ${opts.note.trim()}` : "";
  const lead = opts.lead ? `\n${opts.lead.trim()}` : "";
  const after = opts.after ? `\n${opts.after.trim()}` : "";
  return `OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences.${note}${lead}
${schema}${after}`;
}

// The two mechanical ENCODINGS every plan-shaping prompt has to state. These are
// storage contracts (see src/repo), not coaching taste — a prompt that words them
// loosely is a prompt that can corrupt a row — so they live here instead of being
// restated at ~8 sites. A site that adds its own elaboration (a step size, a "don't
// corrupt these", a Garmin-specific "leave that sign intact") keeps it BESIDE this
// block; only the shared core moved. The weight sentence names both field spellings
// because the prescribing prompts write `target_weight` while chat's log_set writes
// `weight`, and either wording alone would silently narrow the rule at the other site.
export const MECHANICS_ENCODING = `- Assisted movements use NEGATIVE weight (target_weight when prescribing, weight when logging); bodyweight uses null.
- TIMED exercises (mode:'timed', e.g. plank, dead hang) log duration_sec and are prescribed via
  target_seconds — progression is in seconds (+5-15s/step), never load.`;

// The target FALLBACK, stated once per prompt instead of re-derived at every kcal /
// protein reference. `effective_target` is the accepted or coordinated target the
// adaptive-nutrition loop persisted; `recommended` is the re-derived formula. A site
// that names only one of them either ignores an accepted target or pins a stale one,
// which is exactly the drift this collapses. `path` is how THIS prompt addresses the
// goal object — chat points at `DATA.goal` because its guardrails address the DATA
// block by name, the nutrition prompts use the bare `goal` their other rules use.
export function renderGoalTargetFallback(path = "goal", opts: { label?: boolean } = {}): string {
  const rule = `or EVERY kcal or protein target reference, use ${path}.effective_target first (the accepted/coordinated target when one exists), falling back to ${path}.recommended only when effective_target is absent.`;
  // label:false yields a standalone sentence for mid-bullet use; the default
  // keeps the TARGETS: heading the block-style call sites rely on.
  return opts.label === false ? `F${rule}` : `TARGETS: f${rule}`;
}

// The marker-transcription rules the health-document INGEST and the single-document
// ENRICH prompt both have to state. They read the same kind of source and write the
// same marker rows, and both copies had already been edited into byte-identical text
// — which is the point at which a third edit lands in only one of them. Same
// one-home pattern as src/foodCapture.ts. Neither rule is trimmed here; they moved.
export const MARKER_UNITS_RULE = `- Preserve the source units exactly as printed (US or SI/EU units are both fine). Do NOT convert
  units yourself; Cairn normalizes recognized marker units deterministically after import.`;
export const MYCHART_VITALS_RULE = `- Do not skip MyChart vitals/basic measurements: blood pressure, pulse/heart rate, weight, BMI,
  height, SpO2, temperature. If BP is printed as 124/78, emit two markers: Systolic BP 124 mmHg
  and Diastolic BP 78 mmHg.`;
// The adjacent pair, for the enrich prompt that states them together.
export const HEALTH_TRANSCRIPTION_RULES = `${MARKER_UNITS_RULE}
${MYCHART_VITALS_RULE}`;

// The ONE unified identity every coaching prompt opens with. Cairn is a single
// intelligence — at once a longevity-minded coach, a preventive-medicine-literate
// reader of labs, a nutritionist, and a life-aware buddy — that adapts its
// specialization to the task while speaking in one calm voice. Each builder appends
// its task-specific framing AFTER this block instead of declaring a divergent "You
// are a …" identity. Bound to the constitution (calm, suggestion-not-a-gate, no
// numeric scores, you-drive, pull-never-push, health findings informational).
export const CAIRN_PERSONA = `You are Cairn — one calm, unified coaching intelligence for a single person's whole health and training life. You are all of these at once, shifting to whichever the moment needs:
- a longevity-minded strength & conditioning COACH,
- a preventive-medicine-literate reader of LABS & health markers,
- a whole-foods NUTRITIONIST,
- and a life-aware, everyday BUDDY who knows this person.
You see the person's WHOLE picture together — training, food, labs, recovery, sleep, body, and real life — and you understand timing (time of day, where they are in the week or training block) and how things change over time (trends, not just today's number). You speak in ONE voice: calm, plain-language, human — never a dashboard, never clinical jargon dumped on them.
Constitution (non-negotiable): every read is a SUGGESTION, never a gate or a verdict — the person drives. NO numeric scores or 0-100 grades, ever. Insights are PULL, not push — they wait to be opened, they never nag. Health findings are INFORMATIONAL, not medical advice — defer anything clinical to a clinician.`;

// Personal-context guardrails, shared by the coach / chat / meal-plan prompts.
// The coach reads `health` and `context_events` from the DATA snapshot and is
// expected to plan AROUND the user's real life.
export const CONTEXT_GUARDRAILS = `PERSONAL-CONTEXT GUARDRAILS (use the "context_events" and "health" data):
- TRIPS: for any dates that overlap an active/upcoming trip, plan a travel-friendly / deload
  approach (bodyweight or minimal-equipment work, reduced volume) rather than normal loading.
  Surface upcoming trips so the user can plan around them.
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
- IMAGING: the separate "imaging" array preserves the written report and any clearly-labeled
  image_ai observations. Treat the radiologist report as authoritative. Never turn an unconfirmed
  image_ai observation into an injury event, diagnosis, restriction, or quiet plan change. Any
  training/care implication from imaging is informational and must be asked/clinician-tier, not
  silently applied; preserve source distinctions when explaining it.
- HEALTH DIRECTIVES (the connected brain): when "directives" is present in DATA, treat them as the
  cross-domain consequences of this person's flagged labs already propagated into each domain. FOLD
  the nutrition and training directives directly into the plans/meals you produce (e.g. raise soluble
  fiber and lean toward oily fish while ApoB is elevated; keep aerobic work in the week for blood
  pressure), and RESPECT every "watch" directive (surface the re-check, don't program around it).
  A directive flagged "uncertain" or lacking a citation is a softer nudge, not a hard rule. This is
  informational, NOT medical advice — defer anything clinical to a clinician.`;

// Discipline framing (v35), rendered into the plan-shaping prompts. The user's
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
// 'nutrition' for meals, 'day' for the Brief. The ordered intent is always stated
// so every plan-shaped prompt resolves competing goals the same way.
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
  const intent = ctx?.training_intent;
  const priorities = Array.isArray(intent?.priorities)
    ? intent.priorities.map((priority: unknown) => String(priority).trim().toLowerCase()).filter(Boolean).slice(0, 5)
    : [];
  const role = String(
    intent?.endurance_role ?? (disc === "endurance" ? "primary" : disc === "hybrid" ? "co_primary" : "none")
  ).toLowerCase();
  const capability = intent?.endurance_capacity;
  const capacityRead = ctx?.endurance_capacity;
  const durable = priorities.length
    ? `DURABLE ATHLETE INTENT (ordered, first matters most): ${priorities.join(" → ")}.`
    : `DURABLE ATHLETE INTENT: use the legacy ${disc} discipline until the athlete states an ordered hierarchy.`;
  const roleLine =
    role === "primary"
      ? `ENDURANCE ROLE: PRIMARY${sportTxt}. Endurance progression is lead-eligible; lifting protects strength, muscle and durability.`
      : role === "co_primary"
        ? `ENDURANCE ROLE: CO-PRIMARY${sportTxt}. Strength/muscle and endurance may both lead; arbitrate by the ordered intent plus actual recovery and performance.`
        : role === "supporting"
          ? `ENDURANCE ROLE: SUPPORTING${sportTxt}. Aerobic work is a parallel lever for capacity/longevity and must not silently displace higher durable strength or muscle goals.`
          : `ENDURANCE ROLE: NONE. Do not invent endurance work. A separately stated active race may be acknowledged, but it does not rewrite durable identity.`;
  const capabilityLine =
    capability?.sport && Number(capability?.target_duration_min) > 0
      ? `CAPABILITY TARGET: stay able to do ${Math.round(Number(capability.target_duration_min))} minutes of ${String(capability.sport)}${capability.context ? ` (${String(capability.context)})` : ""}. ${capacityRead?.summary ? `Current read: ${String(capacityRead.summary)}` : "Treat this as a durable capability, not a race countdown."}`
      : "";
  const rawAge = ctx?.profile?.age;
  const age = rawAge == null || rawAge === "" ? null : Number(rawAge);
  const ageLine = age != null && Number.isFinite(age)
    ? `AGE CONTEXT: age ${Math.round(age)} informs the long view, but is never an automatic brake and never implies fragility. Progress from actual recovery, performance, soreness, joint/tendon feedback and history; preserve muscle and aerobic capacity.`
    : `AGE CONTEXT: do not assume fragility. Progress from actual recovery, performance, soreness, joint/tendon feedback and history; preserve muscle and aerobic capacity.`;
  const athleteContext = [
    sport,
    capability?.sport,
    capability?.context,
    ...(Array.isArray(ctx?.memory) ? ctx.memory.map((row: any) => row?.content) : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const sportContext = /\b(?:mountain bik(?:e|ing)|mtb|trail rid(?:e|ing)|ski|skiing|nordic|backcountry)\b/.test(
    athleteContext
  )
    ? `\nSPORT CONTEXT: preserve the athlete's stated subtype and terrain. Trail or cross-country MTB means mixed climbing and descending, never downhill-only. Honor stated seasonal sport switches without rewriting the durable priority order; off-season work is minimum-effective maintenance, not identity loss. If a skiing subtype is not stated, keep it generic — do not assume alpine, Nordic or touring.`
    : "";
  // Structured location (home_location / active trip) must always surface a PLACE
  // line when effective is set — even with empty memory. Keyword hits on memory may
  // still add seasonal color, but are never required for the base place line.
  const placeContext = (() => {
    const loc = ctx?.location;
    const effective =
      typeof loc?.effective === "string" ? loc.effective.trim() : "";
    const memoryPlace =
      /\b(?:location|live(?:s|d)? in|weather|season|seasonal|winter|springtime|summer|autumn|fall season)\b/.test(
        athleteContext
      );
    if (effective) {
      const source = String(loc?.source ?? "unknown");
      let sourceBit = "";
      if (source === "home") {
        sourceBit = " (home base)";
      } else if (source === "trip") {
        const title =
          typeof loc?.trip_title === "string"
            ? loc.trip_title.trim().replace(/\s+/g, " ").slice(0, 160)
            : "";
        sourceBit = title ? ` (active trip: ${title})` : " (active trip)";
      }
      const seasonal = memoryPlace
        ? " Season facts in memory may also inform practical options and known seasonal changes."
        : "";
      return `\nPLACE & WEATHER: effective place is ${effective}${sourceBit}. planning_role is context_only — practical context, never a constraint or training gate. Weather is unavailable; do not invent weather without a fresh weather source.${seasonal}`;
    }
    if (memoryPlace) {
      return `\nPLACE & WEATHER: location and season facts in memory may inform practical options and known seasonal changes. Never invent current weather without a fresh weather source, and never treat weather or location as a gate.`;
    }
    return "";
  })();
  const head = `\n${durable}\n${roleLine}${capabilityLine ? `\n${capabilityLine}` : ""}\n${ageLine}${sportContext}${placeContext}`;
  if (focus === "nutrition") {
    if (role === "none") {
      return `${head}
NUTRITION FRAMING: serve the ordered durable goals. Protect protein and lean mass; use a lean-safe deficit only when leanness/fat loss is actually part of the goal.\n`;
    }
    return `${head}
ENDURANCE FUELING (binding for this user):
- When endurance is supporting/co-primary/primary, PROTECT CARBOHYDRATE around the work; do not slash it to chase a deficit.
- Do NOT force a calorie deficit unless fat loss is explicit in goal_mode/body context; a "leanness"
  priority can mean staying lean at maintenance. When fat loss is explicit, keep the deficit lean-safe
  and periodize fuel around the work; endurance's supporting role must not silently erase a higher
  body-composition priority. For endurance-first athletes without a fat-loss goal, anchor to
  maintenance (or a small surplus on the biggest weeks), not a cut.
- PERIODIZE carbs around the week: more carbs on/around LONG and QUALITY (tempo/interval) sessions,
  lighter on easy/rest days. Time a real pre-/during-/post-long-session carb intake.
- Keep protein adequate for recovery; fat fills the rest. Fuel the work, don't starve it.\n`;
  }
  if (focus === "day") {
    return `${head}
When endurance has a role, read the day in endurance terms when it fits: a session can be EASY/recovery, a LONG run/ride, a
TEMPO/threshold day, INTERVALS, or genuine REST — not only lift/easy/rest. Protect easy days as easy
and hard days as hard (polarized), and guard earned recovery after long or quality efforts.\n`;
  }
  // training
  return `${head}
- Make endurance progression FIRST-CLASS only when its explicit role is co-primary/primary; when supporting, keep it a parallel capability lever; when none, stay silent unless an active race was explicitly stated.
- Where endurance has a role, build the aerobic base and periodize easy vs quality work
  (long / tempo / threshold / intervals), and progress volume and quality CONSERVATIVELY (the ~10%/week
  rule of thumb for mileage; don't stack hard days).
- Let the ordered durable priorities decide which modality gets protected when they compete; never infer co-equality from the legacy word "hybrid" alone.
- Treat logged runs/rides as real training stress, scaled to endurance's stated role.\n`;
}

// The endurance OBJECTIVE (v37), rendered for a prompt. Orthogonal to discipline:
// a RACE goal makes the coach periodize a conservative ramp + taper toward a date;
// a STANDING goal makes it maintain readiness (no peak/taper). Both ask the coach to
// prescribe THIS WEEK's runs concretely so a runner/hybrid user gets an actionable
// plan, not just prose. `focus` tailors it to the consuming prompt. Returns "" when
// there's no endurance goal (today's behavior unchanged).
export function renderEnduranceGoal(ctx: any, focus: "training" | "nutrition" | "day"): string {
  const g = ctx?.endurance_goal;
  if (!g || !g.mode) return "";
  const enduranceRole = String(ctx?.training_intent?.endurance_role ?? "").toLowerCase();
  const enduranceLeads = enduranceRole === "primary" || enduranceRole === "co_primary";
  const supportingEvent = enduranceRole === "supporting" || enduranceRole === "none";
  const dist = g.distance_km ? `${g.distance_km} km` : null;
  if (g.mode === "race") {
    if (g.phase === "past") {
      return `\nTEMPORARY ENDURANCE EVENT — COMPLETED/PAST: ${g.event || "the race"}${g.date ? ` (${g.date})` : ""}. Keep it as historical context only. It does not overwrite the ordered durable athlete intent, create a new endurance priority, or trigger a build/taper now.\n`;
    }
    const when = g.weeks_to_race != null
      ? (g.weeks_to_race <= 0 ? "this week" : `~${g.weeks_to_race} week${g.weeks_to_race === 1 ? "" : "s"} out`)
      : "upcoming";
    const head = `TEMPORARY ENDURANCE EVENT — RACE: ${g.event || "a race"}${dist ? ` (${dist})` : ""}${g.target ? `, target ${g.target}` : ""}, ${when}${g.date ? ` (${g.date})` : ""}. Phase hint: ${g.phase || "build"}. This event stays separate from — and must not silently overwrite — the ordered durable athlete intent.`;
    if (focus === "nutrition") {
      return `\n${head}\n- Fuel the build: periodize carbs to the week's long/quality runs; don't cut into fueling. In race week, top up carbs and ease off any deficit.\n`;
    }
    if (focus === "day") {
      return `\n${head}\n- Read today's run against this phase (base→build→sharpen→taper). In the taper (final ~2 weeks) protect freshness — shorter & sharper, more rest — and guard the long run's recovery.${supportingEvent ? " Keep the event as a parallel commitment; it does not automatically outrank the athlete's higher durable priorities." : ""}\n`;
    }
    return `\n${head}
- PERIODIZE toward the date: build the aerobic base, add quality (tempo/threshold/intervals) through the build, sharpen near the race, then TAPER the final ~2 weeks (cut volume, keep some intensity, arrive fresh).
- Progress run volume CONSERVATIVELY (~10%/week; a down week every ~4th). Honor the phase hint above unless the user's actual base says to hold.
- Prescribe THIS WEEK's runs concretely (easy / long / quality, each with a zone + a distance or duration).
${enduranceLeads
  ? "- Endurance is lead-eligible for this athlete: protect the key runs and fit lifting around them without abandoning muscle, strength, or durability."
  : "- Endurance is supporting or event-only for this athlete: use the minimum effective run dose for the event and fit it around higher durable priorities. Do not automatically make running the headline or demote lifting."}\n`;
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
- MAINTAIN rather than ramp to a date: a steady, sustainable base (mostly easy) + one quality session/week keeps the user ${dist ? `${dist}-ready` : "ready"} at any time. Consistency over peaking.
- Prescribe THIS WEEK's runs concretely (easy + one quality), conservative volume. Keep lifting per the discipline.\n`;
}

// Close the race-build feedback loop (Coach loop). Reads ctx.run_compliance —
// the deterministic prescribed-vs-actual running tally for THIS week — and folds
// it into the running-week prompts so the coach adapts next week's runs against
// what ACTUALLY happened (per Garmin/logged activities), conservatively. `pct_km`
// is an INTERNAL proportion — NEVER surfaced as a score; we speak in plain words
// ("ran X of Y km"). Quiet by default: returns "" when there's NO endurance goal
// AND nothing was prescribed (a strength-only user sees nothing new). `focus`
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
  // symptom the user mentioned co-occurring with a genuinely off-marker. Purely
  // informational — a "worth raising with your clinician" nudge, NEVER a diagnosis.
  const symLinks = Array.isArray(ctx?.symptom_links) ? ctx.symptom_links : [];
  if (symLinks.length && (!wanted || wanted.includes("watch") || wanted.includes("training"))) {
    lines.push("SYMPTOM ↔ LAB CONNECTIONS (something the user noted lines up with an out-of-range marker — mention it gently as worth raising with their doctor; informational, never a diagnosis, never alarmist):");
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
      const status = d.status === "dismissed" ? "dismissed by user" : "marked done/handled";
      const marker = d.marker ? `${String(d.marker).trim()} · ` : "";
      const snap = [d.trigger_side, d.trigger_value, d.trigger_date].filter((x: any) => x != null && x !== "").join(" ");
      lines.push(`  - ${status}: ${marker}${String(d.directive ?? "").trim()}${snap ? ` (marker snapshot: ${snap})` : ""}`);
    }
  }
  const rec = ctx?.recovery?.recovery;
  if (ctx?.recovery?.has_data && rec) {
    // The `avg_*` figures below are honestly labelled window averages. The rest are
    // POINT-IN-TIME readings, and getRecoverySummary resolves each as "the newest
    // non-null row in the window" — so a watch left in a drawer kept handing this
    // block a fortnight-old training status, VO2max or skin-temp deviation, printed
    // beside today's averages with nothing to say how old it was. Past its signal's
    // age bound a point reading is simply not printed: stale sensor data behaves as
    // absent, which is the one thing the coach already knows how to handle.
    const quality = rec.quality ?? ctx?.recovery?.quality ?? {};
    const asOf = String(ctx?.now?.date || "").slice(0, 10) || localDateISO();
    const current = <T>(signal: SensorSignal, field: string, value: T): T | null =>
      value != null && sensorIsCurrent(signal, quality?.[field]?.latest_date ?? null, asOf) ? value : null;
    const hrvStatus = current("hrv", "hrv_status", rec.hrv_status);
    const skinTempDev = current("sleep", "skin_temp_dev_c", rec.skin_temp_dev_c);
    const acuteLoad = current("training_load", "acute_load", rec.acute_load);
    const trainingStatus = current("training_load", "training_status", rec.training_status);
    const vo2max = current("fitness_marker", "vo2max", rec.vo2max);
    const fitnessAge = current("fitness_marker", "fitness_age", rec.fitness_age);
    // An average with no n behind it reads as a settled fact. "avg sleep ~430 min"
    // off two nights and off fourteen are the same eleven characters, and the
    // agent has no way to tell them apart — so the three figures a recovery call
    // actually turns on carry their sample count. Follows the honest precedent in
    // the Brief's READINESS line ("from 4/14 days"). Machine register: this is a
    // DATA block, and the count must never reach athlete-facing prose.
    const nOf = (field: string): string => {
      const q = quality?.[field];
      const samples = Number(q?.sample_count);
      const window = Number(q?.window_days ?? q?.expected_days);
      if (!Number.isFinite(samples) || samples <= 0) return "";
      return Number.isFinite(window) && window > 0 ? ` [${samples} readings/${Math.round(window)}d]` : ` [${samples} readings]`;
    };
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
      bits.push(sleep + nOf("sleep_min"));
    }
    if (rec.avg_resting_hr != null) bits.push(`resting HR ~${rec.avg_resting_hr}${nOf("resting_hr")}`);
    if (rec.avg_hrv_ms != null) bits.push(`HRV ~${rec.avg_hrv_ms} ms${hrvStatus ? ` (${String(hrvStatus).toLowerCase()})` : ""}${nOf("hrv_ms")}`);
    if (rec.avg_stress != null) bits.push(`stress ~${rec.avg_stress}`);
    if (rec.avg_body_battery != null) bits.push(`body battery ~${rec.avg_body_battery}`);
    if (rec.avg_respiration != null) bits.push(`respiration ~${rec.avg_respiration}/min`);
    if (rec.avg_spo2 != null) bits.push(`SpO2 ~${rec.avg_spo2}%`);
    if (skinTempDev != null) bits.push(`skin-temp dev ${skinTempDev > 0 ? "+" : ""}${skinTempDev}°C`);
    if (rec.avg_training_readiness != null) {
      const tr = Math.round(rec.avg_training_readiness);
      const word = tr < 40 ? "low" : tr <= 65 ? "moderate" : "high";
      bits.push(`${word} training readiness`);
    }
    if (acuteLoad != null) bits.push(`acute training load ~${Math.round(acuteLoad)}`);
    if (vo2max != null) bits.push(`VO2max ${vo2max}`);
    if (fitnessAge != null) bits.push(`fitness age ~${Math.round(fitnessAge)}`);
    if (trainingStatus) bits.push(`status: ${String(trainingStatus).toLowerCase()}`);
    if (rec.avg_steps != null) bits.push(`~${Math.round(rec.avg_steps)} steps/day`);
    if (rec.avg_vigorous_min != null && rec.avg_vigorous_min > 0) bits.push(`~${Math.round(rec.avg_vigorous_min)} vigorous min/day`);
    const body: string[] = [];
    if (rec.weight_kg != null) body.push(`weight ${rec.weight_kg} kg`);
    if (rec.body_fat_pct != null) body.push(`body fat ${rec.body_fat_pct}%`);
    if (rec.muscle_mass_kg != null) body.push(`muscle ${rec.muscle_mass_kg} kg`);
    if (bits.length) lines.push(`RECOVERY (last ${ctx.recovery.days}d, ${(ctx.recovery.sources || []).join("+") || "no source"}): ${bits.join(", ")} — read the WHOLE picture; bias toward recovery when sleep/HRV/readiness are low or resting HR/stress are elevated vs their norm.`);
    // Acute-vs-chronic baseline: the last 7 days against the 30-day norm, so the
    // agent compares the user to THEIR OWN baseline (not a population number).
    // A delta only EXISTS once its two windows cleared their coverage floors in
    // getRecoverySummary (3 recent / 5 baseline readings) — below that it is null
    // and the field is simply not compared here. That is why this block prints
    // per-field and never as an all-or-nothing set: an athlete can have enough
    // HRV nights to compare and not enough resting-HR ones, and saying so is more
    // honest than either inventing the second or dropping the first.
    const dl = ctx?.recovery?.delta;
    const rc = ctx?.recovery?.recent;
    const bl = ctx?.recovery?.baseline;
    const nVs = (field: string): string => {
      const q = quality?.[field];
      const recentN = Number(q?.recent_n);
      const baselineN = Number(q?.baseline_n);
      return Number.isFinite(recentN) && Number.isFinite(baselineN) ? `, ${recentN} vs ${baselineN} readings` : "";
    };
    if (dl && rc && bl) {
      const cmp: string[] = [];
      if (rc.sleep != null && bl.sleep != null && dl.sleep != null)
        cmp.push(`sleep ${Math.round(rc.sleep)} min vs ~${Math.round(bl.sleep)} norm (${dl.sleep >= 0 ? "+" : ""}${Math.round(dl.sleep)}${nVs("sleep_min")})`);
      if (rc.hrv != null && bl.hrv != null && dl.hrv != null)
        cmp.push(`HRV ${rc.hrv} vs ~${bl.hrv} norm (${dl.hrv >= 0 ? "+" : ""}${dl.hrv}${nVs("hrv_ms")})`);
      if (rc.rhr != null && bl.rhr != null && dl.rhr != null)
        cmp.push(`resting HR ${rc.rhr} vs ~${bl.rhr} norm (${dl.rhr >= 0 ? "+" : ""}${dl.rhr}${nVs("resting_hr")})`);
      if (cmp.length) lines.push(`RECOVERY vs THEIR NORM (last 7d against 30d baseline): ${cmp.join("; ")} — lower sleep/HRV or a raised resting HR vs their own norm means lean toward recovery; this is the comparison that matters, not absolute numbers.`);
    }
    // How the athlete actually WEARS the sensor. An episodic wearer — the watch
    // goes on for the run and the odd baseline night — has a real series and a
    // real norm, but it is a scatter of spot checks rather than a daily record,
    // and a metric measured every ten days cannot carry "this week vs last".
    // Naming the cadence is the honest alternative to silently trusting it.
    // Absence of a line here is not a claim either way.
    const CADENCE_FIELDS: [string, string][] = [
      ["sleep_min", "sleep"],
      ["hrv_ms", "HRV"],
      ["resting_hr", "resting HR"],
    ];
    const episodic = CADENCE_FIELDS.map(([field, label]) => {
      const cadence = quality?.[field]?.cadence;
      const pattern = String(cadence?.pattern ?? "");
      if (pattern !== "spot_check" && pattern !== "intermittent") return null;
      const gap = Number(cadence?.median_gap_days);
      const rhythm = Number.isFinite(gap) && gap > 0 ? `, typically every ${gap} days` : "";
      const last = cadence?.last_reading_date ? `, last on ${cadence.last_reading_date}` : "";
      return `${label} on ${cadence?.readings ?? 0} of the last ${cadence?.window_days ?? 90} days${rhythm}${last}`;
    }).filter(Boolean) as string[];
    if (episodic.length)
      lines.push(`WEARABLE CADENCE (this athlete measures episodically, not daily — ${episodic.join("; ")}): treat these as spot checks. Each reading is real for its own day; a run of them is not automatically a trend, and a quiet stretch is a watch off the wrist, not a signal.`);
    // When the readings cluster on days they trained, the "norm" is built from
    // post-exertion mornings — so a raised resting HR or a dipped HRV against it
    // is partly the sampling, not the athlete. ANNOTATION ONLY: nothing upstream
    // branches on this, and it must not become a reason to hold anyone back.
    const biased = CADENCE_FIELDS.filter(([field]) => quality?.[field]?.training_day_biased === true).map(
      ([, label]) => label
    );
    if (biased.length)
      lines.push(`SAMPLING NOTE: recent ${biased.join(" and ")} readings cluster on days with logged training; norm comparisons may run hot. Weigh them as softer evidence, and do NOT let this alone move the day toward rest.`);
    if (body.length) lines.push(`BODY COMPOSITION (latest): ${body.join(", ")}.`);
  }
  // Supplements the user already takes — relevant across domains (whey ↔ protein
  // floor, creatine ↔ recovery/eGFR, D3/omega-3 ↔ markers). Always folded in when
  // present so the coach doesn't re-suggest what they're on and can connect a
  // supplement to the marker it touches.
  const supps = Array.isArray(ctx?.supplements) ? ctx.supplements : [];
  if (supps.length) {
    lines.push("SUPPLEMENTS THE USER ALREADY TAKES (factor in; don't re-suggest what they're on — whey counts toward the protein floor; a supplement overlapping a now-replete marker is worth a gentle note, never alarm):");
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
// user's own logged sets + 1-tap feedback VISIBLY steer the next recommendation.
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
  return `\nLOGGED-PERFORMANCE SIGNALS (deterministic, from the user's OWN recent sets + feedback — evidence for whether a lift earned a bump, so the plan visibly reflects what they actually did):\n${lines.join("\n")}\n`;
}

// One explicit anchor-lift journey. It informs exercise selection and supporting
// work, but the daily recovery/safety posture above it always wins. Projection is
// already conservatively gated in the repo; prompts must not invent one when absent.
export function renderStrengthJourney(ctx: any): string {
  const journey = ctx?.strength_journey;
  const objective = journey?.objective;
  if (!journey?.available || !objective?.exercise) return "";
  const current = journey.current?.est_1rm != null ? `${journey.current.est_1rm} lb` : "not established yet";
  const target = `${objective.target_est_1rm} lb`;
  const support = Array.isArray(journey.planned_support)
    ? journey.planned_support.slice(0, 3).map((item: any) => `${item.role}: ${item.exercise} (${item.why})`).join("; ")
    : "";
  const next = journey.next_prescription;
  const nextLine = next?.suggested
    ? ` Next safe anchor prescription: ${next.exercise} — ${next.delta_text}; ${next.why}`
    : "";
  const projection = journey.projection
    ? ` Evidence-supported planning range: ${journey.projection.earliest_weeks}-${journey.projection.latest_weeks} weeks (${journey.projection.caveat})`
    : ` Do not invent a date or timeline: ${journey.projection_withheld_reason || "the evidence gate is not met"}`;
  return `\nSTRENGTH COMEBACK JOURNEY (athlete-selected anchor; exact exercise only): ${objective.exercise}, current ${current}, snapped target ${target}, phase ${journey.phase || "establishing"}.${nextLine}${support ? ` Support roles (max three; assistance, not extra competing main presses): ${support}.` : ""}${projection}
BOUNDARY: Recovery, active pain/injury, load constraints, and the unified daily planning posture outrank this journey. Use it to organize the anchor plus support work; never chase the target through pain, add a duplicate same-angle press, promise an outcome, or create a numeric score.\n`;
}

// The single planning posture produced by the unified deterministic signal state.
// Dimensions stay separate; this compact block tells agents which posture owns the
// day and names conflicts without exposing the internal arbitration index.
export function renderSignalState(ctx: any): string {
  const state = ctx?.signal_state;
  if (!state?.action) return "";
  const labels: Record<string, string> = {
    recovery_capacity: "Recovery capacity",
    training_load_tolerance: "Training load / tolerance",
    energy_fueling: "Energy / fueling",
    health_constraints: "Health constraints",
    life_capacity: "Life capacity / schedule",
  };
  const lines = Object.entries(state.dimensions ?? {}).map(([key, raw]: [string, any]) => {
    const latest = raw?.latest_date ? `; latest ${raw.latest_date}` : "";
    return `  - ${labels[key] || key}: ${raw?.status || "unknown"} (${raw?.confidence || "none"} confidence${latest}) — ${raw?.reason || "no current evidence"}`;
  });
  const conflicts = Array.isArray(state.conflicts) && state.conflicts.length
    ? `\nCONFLICTS TO HOLD (do not average them away): ${state.conflicts.join(" | ")}`
    : "";
  const directives = state.action.directives
    ? `\nPLANNING DIRECTIVES: training=${state.action.directives.training}; fueling=${state.action.directives.fueling}; schedule=${state.action.directives.schedule}. Fueling/schedule can change without downgrading the training posture.`
    : "";
  return `\nUNIFIED DAILY PLANNING STATE (deterministic; this posture is the shared planning default, still a suggestion and the athlete's felt experience wins):\nPOSTURE: ${String(state.action.posture).toUpperCase()} — ${state.action.reason}\n${lines.join("\n")}${directives}${conflicts}\n`;
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

// HOW THIS USER RESPONDS — the personalization spine. Carries the standing principle
// that prevents the engine's hard-won fixes from regressing in the agent's own prose.
// `what_works_for_you` has shipped in the DATA block at EVERY site for a while (it is
// in context-projection's PERSON bundle), and no prompt narrative ever said what it
// was — so the agent was handed the one structure in the payload that records how this
// person's past decisions actually turned out, with no reason to open it. One tight
// sentence, here, because every prompt that renders the reaction model is already in
// the "how this person responds" frame and this is the checked half of that frame.
function renderWhatWorksForYou(ctx: any): string {
  const learnings = Array.isArray(ctx?.what_works_for_you?.learnings) ? ctx.what_works_for_you.learnings : [];
  if (!learnings.length) return "";
  return `\nWHAT WORKS FOR YOU (DATA.what_works_for_you): outcomes Cairn has already checked against this user — what it expected, what actually happened, and how confident that pattern is. Lean on it before any generic default; it is observed evidence about THIS person, and like everything else here a suggestion, never a gate.\n`;
}

export function renderReactionModel(ctx: any): string {
  const rm = ctx?.reaction_model;
  const pats = rm && Array.isArray(rm.patterns) ? rm.patterns : [];
  const lines = pats.slice(0, 5)
    .map((p: any) => `  - [${p.confidence}] ${String(p.statement || "").trim()}`)
    .filter((l: string) => l.trim().length > 10);
  // The checked-outcome pointer stands on its own: a user with no reaction patterns
  // yet can still have several closed decisions behind them.
  if (!lines.length) return renderWhatWorksForYou(ctx);
  const narr = rm.narrative ? `\n${String(rm.narrative).trim()}` : "";
  return `\nHOW THIS USER RESPONDS (learned from their OWN logged history — personalize your defaults to this; a suggestion, never a gate. Trust their LOGGED loads over any stale plan number, and read a grip/form note as a technique cue, not a load cap):${narr}\n${lines.join("\n")}\n${renderWhatWorksForYou(ctx)}`;
}

// THE ARC — where today sits on the path to their goals. One clause, never a date wall.
export function renderTrajectory(ctx: any): string {
  const t = ctx?.trajectory;
  const line = t?.line ? String(t.line).trim() : "";
  const journey = ctx?.journey;
  const jBits: string[] = [];
  const phase = journey?.active_phase;
  if (phase?.kind) {
    jBits.push(`active phase: ${String(phase.kind).replace(/_/g, " ")}`);
  }
  const milestone = Array.isArray(journey?.milestones) ? journey.milestones[0] : null;
  if (milestone?.label) {
    jBits.push(`latest milestone: ${String(milestone.label).trim()}`);
  }
  const suggestion = journey?.transition_suggestion;
  if (suggestion?.kind) {
    jBits.push(`next phase to consider: ${String(suggestion.kind).replace(/_/g, " ")}`);
  }
  if (!line && !jBits.length) return "";
  const journeyLine = jBits.length
    ? ` Journey context: ${jBits.join("; ")}. Treat this as context only — nothing auto-applies.`
    : "";
  return `\nTHE ARC (where today sits on the path to their goals — voice at most ONE natural clause when it fits, never a milestone list-dump or a date wall): ${line}${journeyLine}\n`;
}

// LIFE CONTEXT — a one-mention event shaping today, then fading. Never a forced rest.
export function renderActiveContext(ctx: any): string {
  const c = ctx?.context_today;
  if (!c) return "";
  const out: string[] = [];
  const items = Array.isArray(c.active) ? c.active : [];
  const bits = items.slice(0, 3).map((a: any) => String(a.reason || a.title || "").trim()).filter(Boolean);
  const flags: string[] = [];
  if (c.expect_worse_sleep) flags.push("their sleep likely ran short");
  if (c.transient_inflammation) flags.push("a transient inflammation bump is likely — do NOT alarm on an acute marker or cap training for it");
  if (c.reduce_load) flags.push("ease the load a touch");
  if (c.fueling_disrupted) flags.push("fueling/scale may be disrupted — lean conservative, don't re-target on noise");
  if (c.any && (bits.length || flags.length)) {
    out.push(`LIFE CONTEXT RIGHT NOW (${bits.join("; ") || "an active life event"}): ${flags.join("; ")}. Plan AROUND it kindly — it fades on its own; never a verdict, never a forced rest.`);
  }
  // A past-window injury that hasn't been confirmed healed → invite ONE gentle
  // confirm (pull, never nag). If it's already likely-resolved, say so softly; a
  // "yes it's healed" closes it (resolve_context_event) in one tap/one sentence.
  const rc = Array.isArray(c.resolve_candidates) ? c.resolve_candidates : [];
  if (rc.length) {
    const cand = rc[0];
    const healed = cand.likely_resolved ? " (it looks healed from the training since)" : "";
    out.push(`HEALING CHECK (informational, ask at most ONCE, never a nag): the "${String(cand.title).trim()}" injury is past its expected recovery window${healed}. If it comes up naturally, gently confirm whether it's still bothering them — if they say it's fine, mark it resolved (resolve_context_event) so the plan stops working around it. Do NOT keep programming around it as a hard constraint.`);
  }
  if (!out.length) return "";
  return `\n${out.join("\n")}\n`;
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
    `TODAY'S FUEL (persisted food log for ${intake.date || "today"} in the user's LOCAL day — survives chat resets; use it as current context, never as a capture nudge):`,
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
    // "eaten at" and "logged at" are different facts, and the difference matters: a
    // dinner remembered the next morning was EATEN at 9 PM and LOGGED at 8:40 AM. Say
    // which one this is, so the coach never reads a capture time as a meal time. An
    // entry with neither says nothing at all rather than guessing.
    const whenBit = e?.eaten_at ? ` eaten at ${e.eaten_at}` : e?.logged_at ? ` logged at ${e.logged_at}` : "";
    lines.push(`  - id ${e.id}: ${e.meal || "meal"} — ${String(e.summary || "Food").trim()}${entryBits.length ? ` (${entryBits.join(" · ")})` : ""}${whenBit}${status}`);
  }
  if (entries.length > 6) lines.push(`  - plus ${entries.length - 6} more item${entries.length - 6 === 1 ? "" : "s"} in DATA.day_intake.entries.`);
  lines.push("FOOD USE: reference this when answering about today, fuel, recovery, or training readiness. In chat, if the user corrects one of these rows, use update_food_note with the existing id; if they mention the same meal again, do not log a duplicate. Treat this as a single-day snapshot, not a weekly retarget signal by itself.");
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

// A conductor item whose `day_posture` is set is THE DETERMINISTIC FLOOR SPEAKING, and
// its `why` is the exact sentence the Brief prints — same voice, same key, same date, on
// purpose, so one signal reads as one observation on the athlete's screen
// (src/repo/coaching-focus.ts). Handing that sentence to the agent as "the one focus" is
// the parroting the prompt-context projection already guards against by dropping
// `day_read` from every DATA block; it just leaked back in through the conductor. So a
// day-posture item shows WHAT the conductor points at (title, move) and the GROUNDS it
// pointed on — `based_on`, the machine register — and never the phrasing. The agent
// still has the signals blob (avg_sleep_min, low_sleep, fatigue.sleep_vs_norm,
// last_night) and the READINESS / LAST NIGHT lines, so it must reach its own words. The
// client does the same on Today: a `day_posture` lead renders no conductor thread at all
// (src/client/coaching-focus-client.ts).
function focusWhy(item: any): string {
  if (item?.day_posture) return "";
  return item?.why ? ` — ${item.why}` : "";
}

function focusGrounds(item: any): string {
  if (!item?.day_posture) return "";
  const grounds = (Array.isArray(item.based_on) ? item.based_on : []).map((g: any) => String(g ?? "").trim()).filter(Boolean);
  return grounds.length ? `GROUNDS (evidence, not phrasing — say it in your own words): ${grounds.join("; ")}` : "";
}

// The caveat's label. It used to read "(injury/soreness)" at both call sites, but the
// conductor selects the caveat by CAUSE — health constraints, fueling, recovery capacity,
// accumulated training load or life capacity — so four of the five causes were announced
// to the model as an injury that did not exist ("EASE AROUND (injury/soreness): your fuel
// has been running behind…"). The label is derived from whatever cause the conductor
// publishes on its own output and is otherwise NEUTRAL: the caveat text always ends in
// its own concrete instruction, and the prompt layer must NOT keep a second copy of that
// cause taxonomy. `caveat_cause` is the conductor's own label, published beside the
// caveat text precisely so this layer never has to re-derive it — the cause is otherwise
// module-private, and two of the three paths that produce a caveat carry no provenance
// line to read it from. Falls back to the neutral label if a caller omits it.
function caveatLine(cf: any): string {
  if (!cf?.caveat) return "";
  const cause = String(cf.caveat_cause ?? "").trim().replace(/_/g, " ");
  return `EASE AROUND${cause ? ` (${cause})` : ""}: ${cf.caveat}`;
}

// renderCoachingFocus — the conductor block. Rendered FIRST in every plan prompt, above
// all the domain reads, so the agent leads with ONE sequenced focus (lead + parallel +
// later + connections + the batched retest) instead of a flood of co-equal blocks. The
// `brief` form (for the day-read) shows only the lead line. Returns "" when there's no
// focus (a thin user) so it degrades exactly like the other render* helpers.
export function renderCoachingFocus(ctx: PartialCoachContext, opts: { brief?: boolean } = {}): string {
  const cf = ctx?.coaching_focus as any;
  if (!cf || !cf.available || !cf.lead) return "";
  const lead = cf.lead;
  const caveat = caveatLine(cf);
  if (opts.brief) {
    const grounds = focusGrounds(lead);
    return `THIS BLOCK'S ONE FOCUS: ${lead.title}${focusWhy(lead)}${lead.move ? ` (${lead.move})` : ""}${grounds ? `\n${grounds}` : ""}${caveat ? `\n${caveat}` : ""}\n`;
  }
  const lines: string[] = [];
  lines.push("THIS BLOCK — THE FOCUS (the conductor; LEAD with this — everything below it is evidence, not a checklist):");
  lines.push(`  ▸ LEAD: ${lead.title}${focusWhy(lead)}${lead.move ? ` ${lead.move}` : ""}`);
  const leadGrounds = focusGrounds(lead);
  if (leadGrounds) lines.push(`  ▸ ${leadGrounds}`);
  for (const p of cf.parallel || []) {
    lines.push(`  ▸ ALONGSIDE (${p.domain}, handled via a different lever): ${p.title}${focusWhy(p)}${p.move ? ` ${p.move}` : ""}`);
    const parallelGrounds = focusGrounds(p);
    if (parallelGrounds) lines.push(`  ▸ ${parallelGrounds}`);
  }
  if ((cf.later || []).length) lines.push(`  ▸ LATER (say it's deferred — do NOT act on it yet): ${cf.later.map((l: any) => l.title).join("; ")}`);
  for (const c of cf.connections || []) lines.push(`  ▸ CONNECT: ${c}`);
  // The work-around caveat: a training lever that runs into a flagged constraint is
  // worked AROUND, never pushed through — plain words, a suggestion not a gate.
  if (caveat) lines.push(`  ▸ ${caveat}`);
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
  // Endurance trajectory (hybrid/endurance users) — the conservative read.
  if (st?.endurance?.why) lines.push(`ENDURANCE TRAJECTORY: ${st.endurance.why}`);
  if (st?.hybrid?.headline) {
    const h = st.hybrid;
    lines.push(`HYBRID INTERFERENCE (strength and endurance share recovery; do not stack hard lower-body lifting right after hard/long runs/rides): ${h.headline}`);
    if (h.next_strength?.why) lines.push(`NEXT STRENGTH DECISION: ${h.next_strength.why}`);
    if (h.fuel?.risk && h.fuel.risk !== "low" && h.fuel.why) lines.push(`FUEL / WEIGHT-LOSS RISK: ${h.fuel.why}`);
  }

  // The concrete adaptations digest — the "what to change & why" the coach should
  // realize as proposed plan changes (most-actionable first, already deduped).
  if (adj.length) {
    lines.push("ADAPTATIONS DUE (concrete, most-actionable first — evidence supporting the focus above; realize the relevant ones as conservative proposals):");
    for (const a of adj.slice(0, 6)) lines.push(`  - ${a.title}${a.why ? `: ${a.why}` : ""}`);
  }

  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// renderPerformance: the TRAINING-INTELLIGENCE read — where the user actually
// STANDS (capacity), not just whether last week trended up. Benchmarked against
// sex/age strength standards + VO2max norms, the strength imbalances, the single
// biggest lever, the lifts worth re-TESTING, and a variety nudge. Folded into every
// strength prompt so the coach LEADS with where the user is and balances their
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
      `PERFORMANCE STANDING (the deterministic CAPACITY read — where the user genuinely stands vs proven sex/age strength standards + VO2max norms; percentile/level are recognized reference reads, NEVER a score; evidence for the focus above): ${p.hero.headline}.`,
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

// renderRunZones: the user's Z1–Z5 bpm bands grounded in real physiology
// (max-HR + resting HR), so the agent prescribes runs to an actual pulse instead
// of a vague "easy". Quiet by default — "" when no zones are available (no age +
// no Garmin HR). Plain words + concrete bpm, never a score.
export function renderRunZones(ctx: PartialCoachContext): string {
  const z = ctx?.run_zones as any;
  if (!z || !z.available || !Array.isArray(z.zones) || !z.zones.length) return "";
  const bands = z.zones
    .map((b: any) => `${b.zone} ${b.label} ${b.low_bpm}–${b.high_bpm} bpm (${b.feel})`)
    .join("; ");
  return `\nRUN HR ZONES (the user's real bpm bands — prescribe runs to these, not a vague effort): ${bands}.${z.note ? ` ${z.note}` : ""}\n`;
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
      lines.push(`  - Provisional day ${r.day_number}: ${r.label || "Run"}${dist ? ` ${dist}` : ""}${zone}${ivl}.`);
    }
    if (Array.isArray(rp.rationale) && rp.rationale.length) {
      lines.push(`  Why this week: ${rp.rationale.join(" ")}`);
    }
    lines.push(
      "  Plan day numbers are provisional anchors, not fixed-day obligations. Actual logs and the rolling read control completion and the next opening; never call an off-day run missed, never repeat a completed intention, and never add catch-up volume."
    );
    lines.push("  Keep lifting supportive so it doesn't compromise the key runs. Apply via the run-plan apply path (a draft, never auto-applied).");
  }
  const agenda = ctx?.flexible_training_agenda as any;
  if (agenda?.available && Array.isArray(agenda.intents)) {
    lines.push(`ROLLING RUN AGENDA (actual logs control; dates remain suggestions): ${agenda.why || "Fit the remaining intentions into the cleanest openings."}`);
    for (const intent of agenda.intents) {
      const target =
        intent.target_distance_km != null
          ? `${intent.target_distance_km} km`
          : intent.target_duration_min != null
            ? `${intent.target_duration_min} min`
            : "";
      if (intent.status === "completed") {
        const evidence = intent.completion;
        const dose = evidence?.distance_km != null
          ? `${evidence.distance_km} km`
          : evidence?.duration_min != null
            ? `${evidence.duration_min} min`
            : "logged run";
        lines.push(`  - ${intent.kind}: COMPLETED on ${evidence?.date || "a logged date"} (${dose}); do not recommend it again.`);
      } else {
        const window = intent.window_start && intent.window_end ? `${intent.window_start} to ${intent.window_end}` : "this week";
        lines.push(
          `  - ${intent.kind}: OPEN${target ? ` · ${target}` : ""}; flexible window ${window}${intent.suggested_date ? `, current best opening ${intent.suggested_date}` : ""}.`
        );
      }
    }
    if (agenda.next?.guidance) lines.push(`  Next: ${agenda.next.guidance}`);
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

// renderHybridSequencing: the runner+lifter interference/synergy note for the on-demand
// session builder. A concurrent runner+lifter loads the SAME legs from two directions, so
// today's session is SEQUENCED against yesterday's cardio, tomorrow's key run, and any run
// already in today. Callers should pass a HybridDayContext already run through
// withFlexibleRunLookahead so KEY RUN TOMORROW agrees with the Brief (template-only
// hybridDayContext is the fallback when the agenda is unavailable). Suggestion
// words, never a gate; no scores. "" when nothing fires (the quiet-by-default pattern).
// `today` anchors the "tomorrow" check so a key run several days out doesn't fire it.
const HYBRID_SPORT_NOUN: Record<string, string> = { run: "run", ride: "ride", swim: "swim", row: "row", walk: "hike" };
export function renderHybridSequencing(hc: any, today?: string): string {
  if (!hc) return "";
  const lines: string[] = [];
  // Same-day double — TIERED so a short errand walk never reads as a competing stimulus:
  //   (a) a genuinely HARD outing → the full "one stimulus, lift first, fuel both" framing;
  //   (b) a real-but-easy endurance outing (run/ride/swim/row, or ≥40 sustained min) → ONE
  //       soft fuel-around-both line; (c) anything shorter/lighter → no note at all.
  const ct = hc.cardio_today;
  if (ct) {
    const noun = HYBRID_SPORT_NOUN[String(ct.sport)] || "session";
    const mins = ct.minutes ? `, ${ct.minutes} min` : "";
    const realEndurance =
      ["run", "ride", "swim", "row"].includes(String(ct.sport)) || (ct.minutes != null && Number(ct.minutes) >= 40);
    if (ct.hard) {
      lines.push(
        `  - DOUBLE DAY: a ${noun} is already in today${mins}. Treat the day as ONE stimulus — for a strength goal put the quality lifting work FIRST and keep it crisp, and fuel around BOTH efforts (protein + carbs protected). Don't let the ${noun}'s fatigue quietly gut the lift.`,
      );
    } else if (realEndurance) {
      lines.push(`  - DOUBLE DAY: you've also got a ${noun} in today${mins} — fuel around both.`);
    }
  }
  if (hc.hard_cardio_yesterday) {
    lines.push(
      `  - HARD CARDIO YESTERDAY (${String(hc.hard_cardio_yesterday.why || "a hard effort yesterday")}): keep lower-body loading MODERATE today — quality over volume, leave a rep or two in reserve on the big leg work.`,
    );
  }
  // A quality/long run landing TOMORROW protects today's heavy leg work. STRICT: with no
  // valid `today` we can't know it's tomorrow, so we stay quiet rather than over-fire.
  const nr = hc.planned_run_next;
  const tomorrow =
    today && /^\d{4}-\d{2}-\d{2}$/.test(today)
      ? new Date(new Date(`${today}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10)
      : null;
  if (nr && nr.kind && nr.kind !== "easy" && tomorrow && nr.date === tomorrow) {
    const km = nr.km != null ? ` (~${nr.km} km)` : "";
    lines.push(
      `  - KEY RUN TOMORROW: a ${nr.kind} run${km} is on deck tomorrow. Protect the legs — keep heavy lower work shy of failure today so tomorrow's quality run isn't compromised.`,
    );
  }
  return lines.length
    ? `\nHYBRID SEQUENCING (runner + lifter — sequence the two so they don't compete; a suggestion, never a gate):\n${lines.join("\n")}\n`
    : "";
}

// renderMuscleGroups: the per-canonical-group ADVANCING vs STALLING read (the
// user's own mental model), plus — when a group is stalling — the MENU of
// same-pattern variations to rotate in. Optionally a short TEST WEEK line when a
// cadenced re-test is due. Quiet by default — "" when nothing's logged to read.
export function renderMuscleGroups(ctx: PartialCoachContext): string {
  const gt = ctx?.groups_trajectory as any;
  const tw = ctx?.test_week as any;
  const lines: string[] = [];
  if (gt?.available && Array.isArray(gt.groups) && gt.groups.length) {
    lines.push(`MUSCLE GROUPS — ADVANCING vs STALLING (the user thinks in groups; plain words, no scores): ${gt.headline}`);
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

// renderBodyComp: the "BODY MEASUREMENTS" block — folds the at-home tape picture
// (latest circumferences, the derived clinical indicators, the waist trend) into
// the plan-shaping prompts so the connected brain reasons over it explicitly,
// alongside DEXA and labs, in training AND nutrition. The tape body-fat is an
// ESTIMATE and the ratios are recognized clinical measures — plain words, never a
// Cairn-invented score. Quiet by default: "" when nothing has been logged.
const BODY_COMP_SITE_WORDS: Record<string, string> = {
  neck_in: "neck",
  shoulder_in: "shoulders",
  chest_in: "chest",
  waist_in: "waist",
  hip_in: "hips",
  thigh_in: "thigh",
  calf_in: "calf",
  upper_arm_in: "upper arm",
  forearm_in: "forearm",
};

export function renderBodyComp(ctx: any): string {
  const bm = ctx?.body_metrics;
  const bc = ctx?.body_composition;
  if (!bm && !bc) return "";
  const lines: string[] = [];
  const hasTapeBodyFat = Array.isArray(bm?.indicators)
    && bm.indicators.some((ind: any) => String(ind?.label || "").toLowerCase() === "body fat" && ind?.estimate && ind?.value != null);
  if (bc) {
    const measured = bc.measured ?? {};
    const estimated = bc.estimated ?? null;
    const fat = bc.fat_mass ?? null;
    const weight = bc.weight ?? null;
    if (estimated?.value != null && !hasTapeBodyFat) {
      lines.push(`  - DEXA-derived current estimate: ~${estimated.value}% body fat${estimated.as_of ? ` as of ${estimated.as_of}` : ""}; anchored to measured ${measured.value ?? "?"}%${measured.date ? ` on ${measured.date}` : ""}.`);
    } else if (measured?.value != null) {
      const tapeNote = hasTapeBodyFat ? " Use the tape estimate below as the between-scan current signal." : " Treat as historical if weight has moved since then.";
      lines.push(`  - DEXA body fat anchor: ${measured.value}%${measured.date ? ` measured on ${measured.date}` : ""}.${tapeNote}`);
    }
    if (!hasTapeBodyFat && (fat?.est_now != null || fat?.dexa != null)) {
      lines.push(`  - Fat mass: ${fat.est_now != null ? `~${fat.est_now} lb current estimate` : ""}${fat.est_now != null && fat.dexa != null ? "; " : ""}${fat.dexa != null ? `${fat.dexa} lb at DEXA` : ""}${fat.delta_lbs != null ? ` (${fat.delta_lbs >= 0 ? "+" : ""}${fat.delta_lbs} lb vs DEXA)` : ""}.`);
    } else if (hasTapeBodyFat && fat?.dexa != null) {
      lines.push(`  - DEXA fat mass anchor: ${fat.dexa} lb${measured.date ? ` measured on ${measured.date}` : ""}; do not treat this as current if tape/weight have moved.`);
    }
    if (weight?.current != null || weight?.at_scan != null) {
      lines.push(`  - Weight context: ${weight.current != null ? `${weight.current} lb current` : ""}${weight.current != null && weight.at_scan != null ? "; " : ""}${weight.at_scan != null ? `${weight.at_scan} lb at scan` : ""}.`);
    }
    if (bc.note && !hasTapeBodyFat) lines.push(`  - Estimate note: ${String(bc.note).trim()}`);
  }
  const m = bm?.measurements ?? {};
  const parts: string[] = [];
  for (const [key, word] of Object.entries(BODY_COMP_SITE_WORDS)) {
    const v = (m as any)[key];
    if (v != null && Number.isFinite(Number(v))) parts.push(`${word} ${v} in`);
  }
  if (parts.length) {
    // Recency in human words (never a raw date in prose).
    let age = "";
    const t = Date.parse(String(bm?.latest_date || ""));
    if (Number.isFinite(t)) {
      const d = Math.max(0, Math.round((Date.now() - t) / 864e5));
      age =
        d === 0 ? "today" : d === 1 ? "yesterday" : d < 14 ? `${d} days ago` : d < 70 ? `~${Math.round(d / 7)} weeks ago` : `~${Math.round(d / 30.4)} months ago`;
    }
    lines.push(`  - Latest tape session${age ? ` (${age})` : ""}: ${parts.join(", ")}.`);
  }
  for (const ind of Array.isArray(bm?.indicators) ? bm.indicators : []) {
    if (ind?.value == null) continue;
    const zone = ind.zone ? ` (${ind.zone})` : "";
    const est = ind.estimate ? " — a tape ESTIMATE; trust the trend, not the decimal" : "";
    lines.push(`  - ${ind.label}: ${ind.value}${ind.unit || ""}${zone}${est}.`);
  }
  if (bm?.waist_trend) lines.push(`  - ${String(bm.waist_trend).trim()}`);
  if (bm?.heading) lines.push(`  - Where it's heading: ${String(bm.heading).trim()}`);
  if (bm?.focus_line) lines.push(`  - The one lever (deterministic, shown on their Body card — stay consistent with it): ${String(bm.focus_line).trim()}`);
  if (!lines.length) return "";
  lines.unshift(
    "BODY COMPOSITION / MEASUREMENTS (DEXA is a dated anchor; current-weight projections and at-home tape trends are the between-scan signal. Estimates are estimates; trends over single readings; never a score):"
  );
  lines.push(
    "  Use it across the whole picture: a waist drifting up while weight holds → tighten food quality / energy balance and read it alongside the lipid & glucose markers; arms or thighs growing while the waist holds → recomposition is working, protect the training volume driving it; waist-to-height creeping toward 0.5 → it outranks scale weight as the health lever. Trends over single readings; suggestions, never verdicts."
  );
  return `\n${lines.join("\n")}\n`;
}

// Elite-coach + longevity guardrails for the STRENGTH prompts — the
// programming-quality floor this user's history demands, in plain,
// suggestion-framed words (no scores). Folded into the coach / session /
// week-ahead prompts so core, grip, mobility and ankle work are treated as
// first-class, cumulative elbow load is managed, and earned rest is protected.
// The GENERIC elite-programming block — true for ANY user, no personal specifics.
// buildEliteGuardrails(ctx) below layers this user's DERIVED specifics on top
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

// Derive THIS user's elite guardrails from context — injuries, endurance goal,
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
  return `${ELITE_STRENGTH_GUARDRAILS}\n\nSPECIFIC TO THIS USER (derived from their context — injuries, goal, labs; informational, not medical advice):\n${extra.join("\n")}`;
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

import * as repo from "./repo.js";

const PLAN_SCHEMA = `{
  "summary": "one or two sentences on the overall adjustment",
  "changes": [
    { "day_number": <1-5>, "exercise": "<exact exercise name>", "target_weight": <number>, "reason": "<why>" },
    { "day_number": <1-5>, "exercise": "<exact exercise name>", "target_seconds": <number>, "reason": "<why — ONLY for mode:'timed' exercises>" }
  ],
  "notes": "<optional coaching notes, may be empty>"
}`;

const MEAL_SCHEMA = `{
  "summary": "approach for the week, and the daily kcal / protein target used",
  "daily_kcal": <number>,
  "daily_protein_g": <number>,
  "days": [
    { "day": "Mon",
      "note": "<optional one-liner: carb timing / prep hint for this day, e.g. 'training day — carbs front-loaded'>",
      "meals": [ { "name": "<dish name, e.g. Chicken & rice bowl>", "items": "short ingredient list", "kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number> } ] }
  ],
  "shopping": ["item", "item"],
  "notes": "<flags, swaps, anything the athlete should know>"
}`;

// Personal-context guardrails, shared by the coach / chat / meal-plan prompts.
// The coach reads `health` and `context_events` from the DATA snapshot and is
// expected to plan AROUND the athlete's real life.
const CONTEXT_GUARDRAILS = `PERSONAL-CONTEXT GUARDRAILS (use the "context_events" and "health" data):
- TRIPS: for any dates that overlap an active/upcoming trip, plan a travel-friendly / deload
  approach (bodyweight or minimal-equipment work, reduced volume) rather than normal loading.
  Surface upcoming trips so the athlete can plan around them.
- INJURIES: NEVER program loaded movements through an injured area. De-load or swap the affected
  exercises for pain-free alternatives, and respect every exercise's existing constraint_note.
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

// The connected brain, rendered for a prompt. Pulls the active cross-domain
// directives (deriveDirectives writes them from flagged labs) plus the unified
// recovery view, and folds them into a compact, plain-language block so labs
// already shape meals & training. Filterable by domain so the meal prompt sees
// nutrition directives first and the coach prompt sees training/watch first.
// Returns "" when there is nothing to say — graceful, quiet by default.
function renderConnectedBrain(ctx: any, opts: { domains?: ("nutrition" | "training" | "watch")[] } = {}): string {
  const directives = Array.isArray(ctx?.directives) ? ctx.directives : [];
  const wanted = opts.domains;
  const relevant = directives.filter((d: any) => d && (!wanted || wanted.includes(d.domain)));
  const lines: string[] = [];
  if (relevant.length) {
    const byDomain: Record<string, string[]> = {};
    for (const d of relevant) {
      const dom = String(d.domain ?? "watch");
      (byDomain[dom] ||= []).push(
        `  - ${String(d.directive ?? "").trim()}${d.rationale ? ` (why: ${String(d.rationale).trim()})` : ""}${d.citation ? ` [${String(d.citation).trim()}]` : ""}`
      );
    }
    lines.push("DERIVED HEALTH DIRECTIVES (the connected brain — your labs propagated into this domain; honor these):");
    for (const dom of ["nutrition", "training", "watch"]) {
      if (byDomain[dom]?.length) lines.push(` ${dom.toUpperCase()}:`, ...byDomain[dom]);
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
    if (rec.avg_training_readiness != null) bits.push(`training readiness ~${Math.round(rec.avg_training_readiness)}/100`);
    if (rec.vo2max != null) bits.push(`VO2max ${rec.vo2max}`);
    if (rec.training_status) bits.push(`status: ${String(rec.training_status).toLowerCase()}`);
    if (rec.avg_steps != null) bits.push(`~${Math.round(rec.avg_steps)} steps/day`);
    if (rec.avg_vigorous_min != null && rec.avg_vigorous_min > 0) bits.push(`~${Math.round(rec.avg_vigorous_min)} vigorous min/day`);
    const body: string[] = [];
    if (rec.weight_kg != null) body.push(`weight ${rec.weight_kg} kg`);
    if (rec.body_fat_pct != null) body.push(`body fat ${rec.body_fat_pct}%`);
    if (rec.muscle_mass_kg != null) body.push(`muscle ${rec.muscle_mass_kg} kg`);
    if (bits.length) lines.push(`RECOVERY (last ${ctx.recovery.days}d, ${(ctx.recovery.sources || []).join("+") || "no source"}): ${bits.join(", ")} — read the WHOLE picture; bias toward recovery when sleep/HRV/readiness are low or resting HR/stress are elevated vs their norm.`);
    if (body.length) lines.push(`BODY COMPOSITION (latest): ${body.join(", ")}.`);
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// Training-target proposal prompt (existing coach).
export function buildCoachPrompt(userInstruction?: string): string {
  const ctx = repo.getCoachContext();
  return `You are a strength coach updating a training plan. The athlete's profile, goal check,
current plan, recent training sessions, recent cardio/activities, and accumulated memory are in
the DATA section below.

NON-NEGOTIABLE GUARDRAILS:
- Progress is capped by tissue and nerve recovery, NOT by how easy a weight feels. Be conservative.
- Upper-body increases: at most +5 lb/step. Lower-body: at most +5-10 lb/step.
- Only raise a target if recent sessions hit the TOP of the rep range on ALL sets at RIR 2-3.
- Respect every exercise's constraint_note (e.g. injury limits). Never contradict them.
- Account for cardio load: if recent runs/rides are heavy, lean toward holding rather than adding.
- Treat Garmin as a context source, not the plan authority. Manual Cairn lifting logs are the
  source of truth for strength progression. Use Garmin's endurance/recovery signals through the
  athlete's stated focus: strength-first athletes use runs/rides mainly as recovery/cardio-load
  context; runner/cyclist-first athletes make endurance progression central and keep lifting
  supportive.
- Assisted movements use NEGATIVE target_weight. Small steps. Thin/absent data -> do not change.
- TIMED exercises (mode:'timed', e.g. plank, dead hang) are prescribed in SECONDS (target_seconds)
  and logged as duration_sec, not load. Progress them in seconds (+5-15s/step) and ONLY when recent
  durations comfortably meet the current target; never propose target_weight for a timed exercise.

KEEP TRAINING FRESH (anti-staleness — a plan that never changes gets abandoned):
- Main lifts that are progressing stay put. But when an ACCESSORY has been unchanged for ~3-4 weeks,
  has stalled, or the program is starting to read repetitive, swap in ONE OR TWO new exercises that
  hit the same muscle (e.g. leg press ↔ hack squat, cable row variations, incline ↔ machine press).
- Every new exercise MUST respect the constraint_notes (e.g. injury limits — honor whatever each
  note specifies), fit the equipment implied by the current plan, and start at a
  conservative load with a short intro note ("NEW — start light, log actual").
- Small novelty often (1-2 swaps in a normal week) beats wholesale rewrites; restructure the split
  only when frequency or recovery clearly calls for it.
- You may also rotate rep ranges on accessories (e.g. 3x12 -> 4x10) as a lighter form of novelty.

AUTOREGULATION — let the plan bend to how the body actually responded (read each session's
"soreness" 1-5, "performance" 1-5, and free-text "joint_pain" in recent_sessions; many sessions will
have none — that's fine, just use what's there):
- HIGH SORENESS (4-5) or LOW PERFORMANCE (1-2) across recent sessions for a muscle/pattern → pull
  VOLUME or LOAD back there: hold the target (don't add), trim a set, or program a lighter deload week
  rather than progressing. Recovery debt is real; do not push through it.
- A "joint_pain" area named in a recent session (e.g. "left knee", "right shoulder") → DE-LOAD or SWAP
  the movements that load that area for a pain-free alternative, exactly as you would for an injury
  constraint_note. Note the swap kindly; never program loaded movement into a painful joint.
- Recovery signals INFORM selection; they NEVER override progressive overload. When soreness and
  performance are good (low soreness, performance 3-5) and the rep targets were met, the normal
  conservative progression rules above still apply — autoregulation is a brake, not the driver.
- This is kind, not anxious: a rough session is information, not failure. Easing off is the plan
  working as designed, never a penalty.

${CONTEXT_GUARDRAILS}
${renderConnectedBrain(ctx, { domains: ["training", "watch"] })}
TASK: ${userInstruction?.trim() || "Review recent training and propose conservative target adjustments for next week."}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${PLAN_SCHEMA}

DATA:
${JSON.stringify(ctx)}`;
}

const CHAT_SCHEMA = `{
  "reply": "<concise, friendly answer to the athlete>",
  "actions": [
    // zero or more — ONLY when the athlete clearly asked to log or change something.
    { "type": "log_activity", "text": "ran 50 min @ 5:30/km" },
    { "type": "log_set", "exercise": "Back Squat", "weight": 195, "reps": 8, "rir": 2, "day_number": 1 },
    { "type": "log_set", "exercise": "Dead Hang", "duration_sec": 45, "exercise_mode": "timed" },
    { "type": "set_profile", "weight_lb": 176 },
    { "type": "add_memory", "content": "Prefers morning training", "kind": "preference" },
    { "type": "log_food", "meal": "breakfast|lunch|dinner|snack", "summary": "<clean dish name>",
      "items": ["<component>"], "ingredients": [
        { "item": "<ingredient>", "amount": "<qty>", "kcal": <number|null>, "protein_g": <number|null>, "carbs_g": <number|null>, "fat_g": <number|null> } ],
      "kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "fiber_g": <number|null>, "notes": <string|null> },
    { "type": "plan_update", "summary": "...", "changes": [
      { "day_number": 1, "exercise": "Back Squat", "target_weight": 195, "reason": "..." },
      { "day_number": 1, "exercise": "Plank", "target_seconds": 60, "reason": "timed exercises progress in seconds" } ] },
    { "type": "plan_restructure", "summary": "move to 5 days", "days": [
      { "day_number": 1, "name": "Lower A", "focus": "Quad", "items": [
        { "exercise": "Back Squat", "sets": 3, "rep_low": 8, "rep_high": 10, "target_weight": 190, "note": "" },
        { "exercise": "Plank", "sets": 3, "target_seconds": 45, "mode": "timed", "note": "" } ] } ] },
    { "type": "log_health", "kind": "bloodwork|dexa|other", "doc_date": "YYYY-MM-DD|null",
      "summary": "<plain-language 1-2 sentence read on the results>",
      "markers": [ { "name": "Ferritin", "value": 45, "unit": "ng/mL", "flag": "low|high|normal|null" } ] },
    { "type": "add_context_event", "kind": "trip|injury|life_event|family_event", "title": "<short>",
      "detail": "<optional>", "start_date": "YYYY-MM-DD|null", "end_date": "YYYY-MM-DD|null",
      "meta": { "area": "<injuries: knee / lower back>", "severity": "mild|moderate|severe", "location": "<trips>", "member": "<family_event: who>", "recurrence": "<family_event: e.g. Tue 17:00>" } }
  ]
}`;

// Conversational coach. Sees all data; may emit actions the server applies/drafts.
// imagePath: absolute path of a photo the athlete attached this turn — the agent
// CLIs (Claude Code / Codex) can open local files, same trick as health docs.
export function buildChatPrompt(history: { role: string; content: string }[], message: string, imagePath?: string): string {
  const ctx = repo.getCoachContext();
  const convo = (history || [])
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`)
    .join("\n");
  const photoBlock = imagePath ? `
ATTACHED PHOTO — the athlete attached a photo with this message, saved locally at this ABSOLUTE path:
${imagePath}
Open and LOOK at that image file directly before answering.
- If it shows food (a plate, meal, snack, packaged item): identify the dish, estimate portion sizes
  and macros from ordinary servings (rough is fine — never invent precision), emit ONE "log_food"
  action with the estimate, and summarize it in "reply" (dish · ~kcal · protein).
- If it is not food (gym equipment, a form-check frame, a menu, a label): just use what you see to
  answer their message; only log when they clearly want something logged.
` : "";
  return `You are Cairn, the athlete's personal strength & nutrition coach, chatting inside their app.
You can SEE all their data (DATA section) and can ACT by emitting actions.

GUARDRAILS:
- Conservative progression. Respect every exercise constraint_note (e.g. injury limits); never contradict them.
- For weight loss, follow the lean-safe goal math (goal.recommended); never endorse a crash deficit.
- Treat Garmin as a context source, not the plan authority. Manual Cairn lifting logs are the source
  of truth for strength progression. Adapt recommendations to the athlete's stated focus: strength-first
  means Garmin runs/rides mainly influence recovery and conditioning; runner/cyclist-first means
  endurance progression is central and lifting supports it.
- Assisted lifts use NEGATIVE weight; bodyweight uses null.
- TIMED exercises (mode:'timed', e.g. plank, dead hang) log duration_sec and are prescribed via
  target_seconds — progression is in seconds (+5-15s/step), never load.
- Keep training fresh: when the athlete sounds bored or an accessory has stalled for weeks, suggest
  swapping in a new same-muscle exercise (within their constraints, conservative starting load)
  rather than grinding the same movement forever.
- PROGRESSIVE UNDERSTANDING: if the DATA shows an obvious gap (no profile.about_me, an unknown
  training-time or food like/dislike) you MAY ask ONE brief, low-friction question when it fits the
  conversation naturally — never a questionnaire, never more than one per turn — and emit an
  add_memory action capturing any durable answer they give. If nothing fits naturally, skip it.

${CONTEXT_GUARDRAILS}

ACTIONS — only when the athlete clearly asks to log or change something:
- log_activity, log_set, set_profile, add_memory, log_food, log_health, add_context_event are APPLIED immediately.
- log_food records a meal estimate (food note) — use it when the athlete reports something they
  ate or attaches a plate photo. Estimate macros from ordinary serving sizes; null when too unsure.
- log_health records lab/bloodwork/DEXA results the athlete reports in chat — pull out EVERY marker
  with its value, unit and a low/high/normal flag vs the usual range, plus a short plain-language
  summary. Lands straight in their Health records (Me → Health) and feeds the marker trends. Use it
  whenever they tell you numbers or paste results; never invent a value. Informational, not medical advice.
- add_context_event records a trip, injury/niggle, major life event, or family commitment onto their
  timeline (Me → Life) so the plan adapts around it — ease off an injured area, plan travel-friendly
  weeks, dial volume back during a stressful stretch, keep family days shorter/more flexible. Use
  "injury" for any pain/niggle they mention, "trip" for travel, "family_event" for a recurring
  family/kids commitment (meta {member, recurrence}, e.g. "Tue 17:00 soccer"), "life_event" otherwise.
  Set start/end dates when known.
- plan_update (target tweaks) and plan_restructure (changing the split or days-per-week) are saved as a
  DRAFT for the athlete to review and apply — never assume they're live. When they ask for "5 days a
  week" etc., propose a full plan_restructure with sensible exercises that honor their constraints,
  carrying over weights where it makes sense.
- If they're just asking a question, return "actions": [].

Keep "reply" short and human; confirm what you logged or drafted.

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${CHAT_SCHEMA}
${photoBlock}
CONVERSATION SO FAR:
${convo || "(new conversation)"}

ATHLETE'S MESSAGE: ${message}

DATA:
${JSON.stringify(ctx)}`;
}

const DISTILL_SCHEMA = `{
  "memories": [
    { "content": "<one short, self-contained durable fact>", "kind": "preference|constraint|decision|injury|milestone|observation" }
  ],
  "farewell": "<optional single warm sentence closing the conversation out>"
}`;

// "Fresh start" distillation: one call that reads the conversation about to be
// archived and extracts only the durable facts worth carrying into the memory
// table. The reset never blocks on this — an agent failure still archives.
export function buildChatDistillPrompt(history: { role: string; content: string }[]): string {
  const known = (repo.listMemory(60) as any[]).map((m) => `- ${m.content}`).join("\n");
  const convo = (history || [])
    .slice(-80)
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${String(m.content ?? "").slice(0, 600)}`)
    .join("\n");
  return `You are Cairn's coaching memory. The athlete is archiving this chat conversation and starting fresh.
Distill ONLY the durable facts from it that their coach should still know weeks from now:
- preferences (training style, schedule, food likes/dislikes), constraints (equipment, time, pain/injury rules),
  decisions made together (plan changes agreed to, goals set), milestones, and genuinely notable observations.
- NOT trivia, NOT one-off logs (sets, meals and weigh-ins are already stored), NOT anything recomputable
  from the data, NOT advice the coach gave unless the athlete clearly adopted it.
- Each memory is one short, self-contained sentence. An empty list is a perfectly good answer.

ALREADY REMEMBERED (do not repeat or restate any of these):
${known || "(nothing yet)"}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${DISTILL_SCHEMA}

CONVERSATION BEING ARCHIVED:
${convo || "(empty)"}`;
}

const ENRICH_ACTIVITY_SCHEMA = `{
  "structured": {
    "type": "ride|run|swim|hike|other",
    "duration_min": <number|null>,
    "distance_km": <number|null>,
    "pace": <string|null>,
    "rpe": <number|null>,
    "notes": <string|null>
  },
  "memory": [
    { "content": "<short durable fact>", "kind": "observation|preference|injury|milestone" }
  ]
}`;

const ENRICH_FOOD_SCHEMA = `{
  "structured": {
    "summary": "<clean meal name or short description>",
    "items": [<string>],
    "ingredients": [
      { "item": "<ingredient>", "amount": "<quantity from note or estimate>", "kcal": <number|null>, "protein_g": <number|null>, "carbs_g": <number|null>, "fat_g": <number|null> }
    ],
    "kcal": <number|null>,
    "protein_g": <number|null>,
    "carbs_g": <number|null>,
    "fat_g": <number|null>,
    "fiber_g": <number|null>,
    "notes": <string|null>
  },
  "memory": [
    { "content": "<short durable fact>", "kind": "observation|preference|injury|milestone" }
  ]
}`;

// Background enrichment of a free-text log into cleaner structured data, plus
// distilling genuinely notable durable facts into memory. Light context only.
export function buildEnrichPrompt(kind: "activity" | "food", raw: string): string {
  const profile = repo.getProfile();
  const goal = repo.computeGoalCheck();
  const recentMemory = (repo.listMemory(40) as any[]).map((m) => m.content);

  const guardrails = `GUARDRAILS:
- Never invent numbers. Use null for anything not stated or not reasonably inferable.
- "memory" is [] UNLESS there is a genuinely notable, durable fact (an injury/niggle, a clear
  preference, a milestone/PR, or a meaningful recurring pattern). Do NOT log routine entries.
- Do NOT repeat anything already present in EXISTING MEMORY below — only add genuinely new facts.
- Keep memory items short and factual. Respect any constraints/preferences already on record.`;

  if (kind === "activity") {
    const recentActivities = repo.listActivities(10);
    return `You enrich a single free-text cardio/activity log into clean structured data for a
training tracker. A fast offline regex already produced a rough parse; your job is to improve it
and extract any durable fact worth remembering.

${guardrails}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${ENRICH_ACTIVITY_SCHEMA}

CONTEXT:
profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}
recent_activities: ${JSON.stringify(recentActivities)}
EXISTING MEMORY (do not repeat): ${JSON.stringify(recentMemory)}

RAW ACTIVITY LOG TO ENRICH:
${raw}`;
  }

  return `You enrich a single free-text food/meal note into a clean structured estimate for a
nutrition tracker, and extract any durable fact worth remembering.

${guardrails}
- Correct obvious typos in ingredient names, but preserve the user's meaning.
- Expand the note into ingredient-level rows with quantities when stated or reasonably inferable.
- Nutrition estimates are rough. Fill totals and per-ingredient macros when you can reasonably estimate
  them from ordinary serving sizes; use null for values that are too uncertain.

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${ENRICH_FOOD_SCHEMA}

CONTEXT:
profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}
EXISTING MEMORY (do not repeat): ${JSON.stringify(recentMemory)}

RAW FOOD NOTE TO ENRICH:
${raw}`;
}

const ENRICH_HEALTH_SCHEMA = `{
  "kind": "bloodwork|dexa|other",
  "doc_date": "YYYY-MM-DD|null",
  "structured": {
    "markers": [
      { "name": "<marker name, e.g. 'Ferritin'>", "value": <number|string>, "unit": "<unit, e.g. 'ng/mL'>", "flag": "low|normal|high|null" }
    ],
    "type": "bloodwork|dexa|other"
  },
  "summary": "<plain-language summary, 1-3 sentences>",
  "memory": [
    { "content": "<durable notable fact, e.g. 'ferritin low-normal — recheck in 3mo'>", "kind": "observation|injury|milestone" }
  ]
}`;

// Health-document analysis. The agent (Claude Code / Codex CLI) can open local
// files, so we hand it the ABSOLUTE path and instruct it to read the file there.
export function buildHealthEnrichPrompt(absPath: string, kind: string): string {
  const profile = repo.getProfile();
  const recentMemory = (repo.listMemory(40) as any[]).map((m) => m.content);

  return `You analyze a single uploaded health document (a lab report, DEXA/body-composition
scan, or similar) for a training & nutrition tracker. The document is a local file — an image or
a PDF — saved on this machine.

READ THE FILE AT THIS ABSOLUTE PATH:
${absPath}

Open and read that file directly (it is a local ${kind} document). Extract the test markers /
measurements and the date the results apply to, then output a clean structured result plus a
short plain-language summary and any durable facts worth remembering.

GUARDRAILS:
- This is informational structuring, NOT medical diagnosis or advice. Do not diagnose, prescribe,
  or recommend treatment. Just transcribe and summarize what the document shows.
- Never invent values. Only include markers you can actually read from the file. Use null for any
  flag you cannot determine (e.g. when no reference range is shown).
- Infer top-level "kind" from the document itself. Do not rely on the upload label.
- Infer top-level "doc_date" from the collection date, test date, exam date, scan date, or report
  date printed in the document. Prefer the specimen/scan date over a final-report date. If no
  date is visible, return null.
- Prefer the reference ranges printed on the document to set "flag" (low/normal/high). If none is
  shown, set flag to null rather than guessing.
- "memory" is [] UNLESS there is a genuinely notable, durable fact (a clearly out-of-range marker
  worth tracking, a meaningful body-composition change, an injury-relevant finding). Keep items
  short and factual. Do NOT repeat anything already in EXISTING MEMORY below.

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${ENRICH_HEALTH_SCHEMA}

CONTEXT:
profile: ${JSON.stringify(profile)}
EXISTING MEMORY (do not repeat): ${JSON.stringify(recentMemory)}`;
}

const HEALTH_INGEST_SCHEMA = `{
  "panels": [
    // ONE entry per distinct test/collection/scan DATE found anywhere in the source.
    // A multi-year lab export becomes many panels — split every dated result out.
    {
      "doc_date": "YYYY-MM-DD",
      "kind": "bloodwork|dexa|other",
      "summary": "<1-2 sentence plain-language read for THIS date's results>",
      "markers": [
        { "name": "<e.g. 'LDL-C'>", "value": <number|string>, "unit": "<e.g. 'mg/dL'>", "flag": "low|normal|high|null" }
      ]
    }
  ],
  "summary": "<1-3 sentence read across the WHOLE import: span of dates, what stands out>",
  "memory": [
    { "content": "<durable notable fact, e.g. 'LDL-C trending up since 2022, 207 mg/dL in 2026'>", "kind": "observation|injury|milestone" }
  ]
}`;

// Multi-record ingestion. The source can be a single file OR a folder of files
// (a MyChart/CCDA export we unzipped): CCDA XML, HTML summaries, lab PDFs, scans.
// The agent reads everything under the path and SPLITS it into one panel per
// distinct test date — so a years-long history lands as properly dated records.
export function buildHealthIngestPrompt(absPath: string, isDir: boolean, kindHint: string): string {
  const profile = repo.getProfile();
  const recentMemory = (repo.listMemory(40) as any[]).map((m) => m.content);
  const target = isDir
    ? `READ EVERY RELEVANT FILE IN THIS FOLDER (recursively):
${absPath}

It is an unpacked health-records export (likely a MyChart / CCDA / "IHE_XDM" bundle). Look at the
CCDA XML documents (the structured lab/result data — richest source), the HTML summary, and any
lab/scan PDFs. Ignore stylesheets, logos, and boilerplate. When the same result appears in more
than one file, record it ONCE.`
    : `READ THE FILE AT THIS ABSOLUTE PATH:
${absPath}

It is a local health document (${kindHint}) — a PDF, image, HTML, or text export. Open and read it
directly.`;

  return `You ingest an athlete's health records into a training & nutrition tracker. The source may
contain a LONG history spanning many dates and years. Your job is to extract EVERY dated set of
results and split them into one "panel" per distinct test/collection/scan date.

${target}

SPLIT BY DATE: a single export often holds lipid panels, CBCs, metabolic panels, vitamin levels,
DEXA scans etc. from MANY different dates. Group markers by the date they were collected and emit
ONE panel per date. Do NOT collapse different dates together. Do NOT merge unrelated dates.

GUARDRAILS:
- This is informational structuring, NOT medical diagnosis or advice. Transcribe and summarize only.
- Never invent values. Include only markers you can actually read. Use null for a flag when no
  reference range is shown — don't guess.
- doc_date is the specimen/collection/scan date (prefer it over a final-report date), YYYY-MM-DD.
  Drop any panel whose date you genuinely cannot determine.
- Infer each panel's "kind" from its content (a lab panel is "bloodwork", a body-composition/bone
  scan is "dexa", else "other").
- Prefer real, decision-useful markers (lipids, ApoB, A1c, glucose, insulin, vitamin D, ferritin,
  thyroid, CRP, body-composition figures). Skip pure administrative/document metadata.
- "memory" is [] unless there is a genuinely durable, notable fact (a clear out-of-range trend, a
  meaningful body-composition change). Keep items short. Do NOT repeat anything in EXISTING MEMORY.
- It is fine to return many panels (dozens). If the source truly has only one date, return one panel.

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${HEALTH_INGEST_SCHEMA}

CONTEXT:
profile: ${JSON.stringify(profile)}
EXISTING MEMORY (do not repeat): ${JSON.stringify(recentMemory)}`;
}

const HEALTH_REVIEW_SCHEMA = `{
  "headline": "<one-sentence whole-picture read, plain language>",
  "wins": ["<what's going well>"],
  "watchlist": [{"marker": "Ferritin", "status": "low|high|watch", "why": "<plain words>", "action": "<concrete food/training/lifestyle step>", "citation": "<source for the guidance when you consulted one, else null>"}],
  "focus": [{"title": "<short focus area>", "why": "...", "action": "<this week's concrete step>"}],
  "followups": [{"what": "<e.g. retest ferritin>", "when": "<e.g. in 8-12 weeks>"}],
  "training_impact": "<how this should shape training, 1-2 sentences>",
  "nutrition_impact": "<how this should shape eating, 1-2 sentences>",
  "directives": [
    // CROSS-DOMAIN directives the connected brain stores so a flagged finding
    // reshapes meals & training automatically. ONE per real consequence; empty
    // when nothing is out of optimal. domain ∈ nutrition|training|watch.
    { "domain": "nutrition", "marker": "<the source marker this came from, e.g. 'LDL-C', or null>", "directive": "<concrete cross-domain instruction, e.g. 'emphasize oily fish & poultry over red meat, raise soluble fiber'>", "rationale": "<plain-language why, tied to the finding>", "citation": "<current clinical guidance you consulted, or null>" }
  ]
}`;

// Whole-picture health review: a longevity/wellness coach reads the full coach
// context PLUS the aggregated marker history (every uploaded lab/scan, deduped
// per marker with trends) and produces one structured, plain-language review.
// Stored via repo.addHealthReview (coerced/clamped) and fed back into
// getCoachContext() as `health_review`.
export function buildHealthReviewPrompt(): string {
  const ctx = repo.getCoachContext();
  const markers = repo.getMarkerHistory();
  // Impact-ranked view (distance from OPTIMAL, most-actionable first) so the
  // review LEADS with the highest-impact markers, not just lab-flagged ones.
  const priority = repo.prioritizeMarkers();
  // Plain-language "how recent" from a YYYY-MM-DD reading date — so the agent
  // can say "3 months ago" rather than restate a raw date.
  const recencyOf = (date?: string | null): string | null => {
    if (!date) return null;
    const t = Date.parse(date);
    if (!Number.isFinite(t)) return null;
    const days = Math.max(0, Math.round((Date.now() - t) / 86_400_000));
    if (days <= 1) return "today";
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    if (days < 365) return `${Math.round(days / 30)} months ago`;
    const yrs = Math.round(days / 365);
    return yrs <= 1 ? "about a year ago" : `${yrs} years ago`;
  };
  const topMarkers = priority.markers.slice(0, 8).map((m: any) => ({
    name: m.name,
    group: m.group ?? null,
    latest: m.latest?.value ?? null,
    flag: m.latest?.flag ?? null,
    optimal: m.optimal ?? null,
    in_optimal: m.in_optimal ?? null,
    actionable: m.actionable ?? false,
    // Direction over time + how recent the latest reading is — speak to these.
    trend: m.trend ? { dir: m.trend.dir, change: m.trend.change } : null,
    recency: recencyOf(m.latest?.date),
  }));
  return `You are a longevity & wellness coach reviewing this person's WHOLE health picture for
their training/nutrition tracker: every lab marker they have uploaded (with trends across
documents), their body composition, training, nutrition, goals, and life context.

NON-NEGOTIABLE FRAMING:
- This is informational coaching, NOT medical diagnosis or medical advice. Never diagnose or
  prescribe. For anything clinical (a clearly out-of-range marker, a concerning trend), the
  "action"/"why" should say it is worth discussing with their doctor.
- Plain language only — write for the athlete, not a clinician. No jargon without a translation.
- Ground every statement in the DATA / MARKER HISTORY below. Never invent values or trends.
- Actions must be concrete food/training/lifestyle steps the athlete can actually take this week
  (e.g. "add 2 servings of oily fish", "keep easy runs easy while ferritin recovers"), respecting
  the lean-safe goal math and every exercise constraint_note.
- Use the marker trends: a marker moving in the right direction is a win; one drifting the wrong
  way belongs on the watchlist even if still in range.
- SPEAK TO THE TREND, not just the latest value: each PRIORITY MARKER carries a trend (rising /
  falling / stable, with the net change and over what span) and a recency (e.g. "3 months ago").
  Say where a marker is heading and roughly how long ago it was measured — a stale reading deserves
  a recheck, and a clear direction is more informative than a single number.
- You MAY organize findings by health group (each marker carries a group — Lipids &
  Cardiovascular, Metabolic & Glucose, Iron & Red Blood, …) so related markers read as one story.
- DATES: don't restate the latest panel's date in every line — the UI shows recency once. Write
  values plainly ("LDL-C is 207 mg/dL") and only name a date when contrasting an earlier reading,
  in plain month/year form ("up from 135 in Apr 2024"). Never emit raw YYYY-MM-DD dates in prose.

LEAD WITH IMPACT: the PRIORITY MARKERS block below is pre-ranked by how far each value sits from its
OPTIMAL zone (not just the lab's normal range) and how actionable it is. Open the review and the focus
list with the highest-impact, most-actionable markers first; a value sitting "in range" but well
outside optimal still deserves attention. Never show or invent a numeric grade/score — speak in plain
"in / out of optimal" terms.

EVIDENCE & THE CONNECTED BRAIN (this is what makes the review act across the whole picture):
- When a finding is CONSEQUENTIAL (a clearly out-of-range or out-of-optimal marker, a concerning
  trend) or the right action is genuinely UNCERTAIN, consult CURRENT clinical guidance / recent
  literature rather than trusting stale assumptions, and CITE what you used (a "citation" string on
  the relevant watchlist item and/or directive). If you cannot look it up, lean on best current
  knowledge and leave citation null — never invent a source.
- EMIT CROSS-DOMAIN DIRECTIVES in "directives": for each out-of-optimal finding, write the concrete
  consequence in every domain it touches — nutrition (food tilts), training (volume/intensity caps,
  watch-items) and watch (what to re-check) — so the propagation engine can store them and they
  reshape meals & training automatically. Examples: high LDL/ApoB → nutrition "emphasize oily fish
  & poultry over red meat, raise soluble fiber, cap saturated fat" + training "note cardiovascular
  load"; low ferritin → training "hold endurance volume, watch fatigue" + nutrition "iron-rich foods
  paired with vitamin C". Keep "directives" empty when nothing is out of optimal — silence on good markers.

${CONTEXT_GUARDRAILS}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${HEALTH_REVIEW_SCHEMA}

PRIORITY MARKERS (impact-ranked: distance from OPTIMAL, most-actionable first — lead with these):
${JSON.stringify(topMarkers)}

MARKER HISTORY (aggregated across all uploaded health documents; flagged markers first):
${JSON.stringify(markers)}

DATA:
${JSON.stringify(ctx)}`;
}

// ---------- the day read (Phase 1A — the soul) ----------
const DAY_READ_SCHEMA = `{
  "kind": "train|easy|rest",
  "headline": "<2-4 word plain-language state, e.g. 'Lower body.' or 'Rest today.'>",
  "why": "<one warm, plain sentence — what you saw and why; NO numbers, NO scores>",
  "focus": "<train: the focus, e.g. 'Lower body' / null on rest>",
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
  const recentFocus = [...new Set(sessions.slice(0, 3).map((s) => s?.day_name).filter(Boolean))];
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

// The single agentic judgment at the heart of the product: given the whole
// picture, what KIND of day should this be? Honors the constitution — it's a
// SUGGESTION, never a verdict; kind, never anxious; plain language, never a
// score. repo.dayRead computes deterministic signals first; this builder asks
// the agent to make the nuanced call and write the human sentence. opts let the
// caller pass an escape-hatch override ("rough night" / "short on time").
export function buildDayReadPrompt(ctx?: any, opts: { override?: string; date?: string } = {}): string {
  const context = ctx ?? repo.getCoachContext();
  const baseline = repo.dayRead(opts.date);
  const overrideBlock = opts.override?.trim()
    ? `\nATHLETE OVERRIDE (honor this — they're steering): "${opts.override.trim()}". Reshape the read accordingly (e.g. "rough night" → lean easy/rest; "short on time" → a compressed session; "I want to train anyway" → a train read even if the baseline leaned rest, kept appropriately light).\n`
    : "";
  // A compact recent-training summary so the agent reads the rhythm without
  // digging through the raw DATA blob — last few sessions + days since each,
  // plus the whole-history rhythm line (frequency / freshness / emphasis).
  const allSessions = Array.isArray(context?.recent_sessions) ? context.recent_sessions : [];
  const sessions = allSessions.slice(0, 6);
  const sessionLine = sessions.length
    ? sessions.map((s: any) => `${s?.date ?? "?"}${s?.day_name ? ` (${s.day_name})` : ""}`).join(", ")
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
  return `You are Cairn, the athlete's calm health & training buddy. Read their WHOLE picture and
judge what kind of day today should be: a real session, easy movement, or rest. This opens their
app — it is the first and often only thing they see.

THE CONSTITUTION (binding):
- It is a SUGGESTION you offer, never a verdict you impose. The athlete drives; you navigate.
- Be KIND and never anxious. Rest is wisdom, not failure. A low signal is information, never a
  judgement; their felt experience overrides any number.
- CALM and plain. No 0-100 scores, no metric dump — numbers are vanity. Say the one true thing in
  a friend's voice. Three lines on a good day.
- Protect rest when it's earned (several hard days running, short sleep, run-down) — do NOT default
  to opening a lifting plan every morning. Never insist on rest either. When you suggest rest, frame
  it as the wise, earned choice ("rest is wisdom"), never as falling behind.

DETERMINISTIC SIGNALS already computed (use them, but you make the final nuanced call):
${JSON.stringify(baseline.signals)}
A rules-only baseline suggested: kind="${baseline.kind}", focus=${JSON.stringify(baseline.focus)}.
You MAY disagree with the baseline when the whole picture warrants it — it is a floor, not a ceiling.
RECENT TRAINING (most recent first): ${sessionLine}.
TRAINING RHYTHM (read the whole history, not just today): ${rhythmLine}${todayLine}
${CONTEXT_GUARDRAILS}
${renderConnectedBrain(context, { domains: ["training", "watch"] })}${overrideBlock}
OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${DAY_READ_SCHEMA}

DATA:
${JSON.stringify(context)}`;
}

// ---------- on-demand session ("build me a session for today" — Phase 1D) ----------
const SESSION_SUGGEST_SCHEMA = `{
  "name": "<short session name, e.g. 'Lower body — quad focus'>",
  "focus": "<muscle/quality focus>",
  "est_minutes": <total minutes, number>,
  "why": "<one plain sentence on why this fits today>",
  "items": [
    { "exercise": "<exact name; reuse plan/exercise names where sensible>",
      "sets": <number>, "rep_low": <number|null>, "rep_high": <number|null>,
      "target_weight": <number|null>, "target_seconds": <number|null>,
      "mode": "reps|timed", "note": "<short cue / why, optional>" }
  ],
  "notes": "<optional — swaps, equipment, anything to flag>"
}`;

// "Ask it for a session right now." An on-demand agentic call that honors the
// athlete's constraints (a time budget, an injury, available equipment) and the
// day read, returning a session SUGGESTION for review (you drive — nothing is
// applied). opts carry the constraints the launchpad chips pass through.
export function buildSessionPrompt(ctx?: any, opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string } = {}): string {
  const context = ctx ?? repo.getCoachContext();
  const read = repo.dayRead(opts.date);
  const wants: string[] = [];
  if (opts.minutes) wants.push(`TIME BUDGET: about ${Math.round(opts.minutes)} minutes — fit the whole session in that (drop accessories before compounds).`);
  if (opts.focus) wants.push(`FOCUS REQUESTED: ${opts.focus.trim()}.`);
  if (opts.equipment) wants.push(`EQUIPMENT AVAILABLE: ${opts.equipment.trim()} — only program what this allows.`);
  if (opts.constraints) wants.push(`CONSTRAINTS: ${opts.constraints.trim()}.`);
  return `You are Cairn, the athlete's strength & conditioning coach. Build ONE session for today,
on demand, honoring their real constraints and whole picture. This is a SUGGESTION for them to
review — nothing is applied automatically (they drive).

GUARDRAILS:
- Conservative loading; respect every exercise constraint_note (e.g. injury limits)
  and any active injury in context_events — never program loaded movement through an injured area.
- Assisted movements use NEGATIVE target_weight; bodyweight uses null. TIMED work (plank, dead hang)
  uses target_seconds + mode:"timed", never load.
- Carry over sensible working weights from the plan / recent logs where they fit. Thin data → start
  light with a "NEW — start light, log actual" note.
- Honor the day read: if today reads as rest/easy (kind="${read.kind}"), keep this session light and
  short unless the athlete explicitly asked to train hard.

${CONTEXT_GUARDRAILS}
${renderConnectedBrain(context, { domains: ["training", "watch"] })}${wants.length ? `
WHAT THE ATHLETE ASKED FOR:
${wants.join("\n")}
` : ""}
OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${SESSION_SUGGEST_SCHEMA}

DATA:
${JSON.stringify(context)}`;
}

// ---------- Garmin strength reconciliation (match → enrich → extrapolate) ----------
const GARMIN_STRENGTH_SCHEMA = `{
  "summary": "<one calm plain sentence on how the body responded — HR / time-in-zone / effort. No scores, no numbers-as-vanity.>",
  "intensity": "easy" | "moderate" | "hard" | null,
  "sets": [
    // ONE entry per detected set you are confident about, in order. EMPTY when there's
    // nothing reliable to log (then extrapolated=false).
    { "exercise": "<exact ALREADY-KNOWN or PLAN exercise name when it clearly matches, else a clean human name from the Garmin category>",
      "weight": <number|null>,        // lb; null = bodyweight; negative = assisted
      "reps": <number|null>,
      "duration_sec": <number|null>,  // timed holds only (plank, dead hang)
      "mode": "reps" | "timed" }
  ],
  "extrapolated": true | false        // true iff you emitted any sets
}`;

// Reconstruct what a Garmin-recorded strength workout was, and how the body
// reacted, so it lands as ONE enriched Cairn session. This is INFORMATIONAL
// reconstruction of a workout that already happened — not coaching, not a plan
// change, no scores. The deterministic layer (repo.reconcileGarminStrength) has
// already attached the physiology; this fills the narrative + the exercises Garmin
// detected that the athlete did NOT already log by hand.
export function buildGarminStrengthPrompt(garminActivity: any): string {
  const ga = garminActivity ?? {};
  const date = ga.date || "";
  const session = date ? repo.getSessionByDate(date) : null;
  const logged = Array.isArray((session as any)?.sets) ? (session as any).sets : [];
  // What the athlete already logged by hand for this day — NEVER duplicate these.
  const loggedExercises = [...new Set(logged.map((s: any) => s.exercise).filter(Boolean))];
  const exercises = (repo.listExercises() as any[]).map((e) => ({ name: e.name, mode: e.mode || "reps", muscle_group: e.muscle_group || null }));
  const plan = (repo.getPlan() as any[]).map((d) => ({
    day: d.name, focus: d.focus || null,
    exercises: (d.items || []).map((it: any) => it.exercise),
  }));
  const profile = repo.getProfile();

  // The physiology + detected sets Garmin gave us for THIS activity.
  const activity = {
    type: ga.type ?? null,
    date,
    duration_min: ga.duration_min ?? null,
    avg_hr: ga.avg_hr ?? null,
    max_hr: ga.max_hr ?? null,
    calories: ga.calories ?? null,
    training_effect: ga.training_effect ?? null,
    aerobic_te: ga.aerobic_te ?? null,
    anaerobic_te: ga.anaerobic_te ?? null,
    hr_zones: ga.hr_zones ?? null,
    exercise_sets: ga.exercise_sets ?? null,
  };

  return `You reconcile a Garmin-recorded STRENGTH workout into the athlete's training log. The
workout already happened; your job is (a) a one-line read of how the body responded, and (b) the
exercises Garmin detected, cleaned up and converted to the athlete's units — but ONLY the ones the
athlete did not already log by hand.

THE CONSTITUTION (binding):
- This is informational RECONSTRUCTION of a past session, not coaching and not a plan change.
- No 0-100 scores, no metric dump. The summary is one calm, plain sentence in a friend's voice.

GUARDRAILS:
- Use ONLY Garmin's detected "exercise_sets". NEVER invent exercises, reps, or weights. If
  exercise_sets is empty/missing, return "sets": [] and "extrapolated": false and just summarize the
  physiology.
- DO NOT emit a set for any exercise already in ALREADY LOGGED — the athlete logged those by hand and
  they are the source of truth. Fill in only the OTHER detected exercises.
- Map each Garmin category (e.g. "BENCH_PRESS", "BARBELL_DEADLIFT") to an exact KNOWN EXERCISE or
  PLAN exercise name when it clearly matches; otherwise use a clean, human exercise name derived from
  the category (Title Case, e.g. "Barbell Bench Press"). Prefer reusing existing names.
- Weights in exercise_sets are in KG (weight_kg). Convert to POUNDS and round to a plausible gym
  increment (2.5 / 5 lb). weight = null means bodyweight (push-ups, pull-ups, dips); use a NEGATIVE
  weight only for assisted movements.
- Timed holds (plank, dead hang, wall sit) → set "duration_sec" + "mode":"timed" with weight null;
  everything else → "mode":"reps" with reps (and weight when loaded).
- Group consecutive identical detected sets faithfully — one entry per working set, in order.
- "extrapolated" is true iff you emitted at least one set.

THIS GARMIN STRENGTH ACTIVITY:
${JSON.stringify(activity)}

ALREADY LOGGED (by hand, this day — do NOT duplicate): ${JSON.stringify(loggedExercises)}
KNOWN EXERCISES (reuse these names + their mode): ${JSON.stringify(exercises)}
TRAINING PLAN (map categories to these where they fit): ${JSON.stringify(plan)}
PROFILE (units are POUNDS): ${JSON.stringify(profile)}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${GARMIN_STRENGTH_SCHEMA}`;
}

// Longevity + lean guardrails shared by the weekly meal-plan and meal-swap prompts.
// Framing: super-healthy, getting-lean, longevity coach — not just a macro calculator.
const LONGEVITY_GUARDRAILS = `LONGEVITY & LEAN GUARDRAILS:
- Anchor EVERY meal on protein; total ~0.7-1 g per lb bodyweight per day (use goal.recommended.protein_g).
- 30g+ fiber per day: vegetables, legumes, fruit, whole grains.
- Build meals from mostly whole, single-ingredient foods; minimize ultra-processed food, added
  sugar, and alcohol.
- Oily fish 2-3x/week (salmon, sardines, mackerel) or another omega-3 source.
- Lean-safe deficit ONLY (respect goal.recommended) — never a crash deficit.
- Keep the last meal of the day moderate, not enormous or very late.`;

// Meal slots are flexible — the plan must bend around the athlete's real training schedule,
// not assume a textbook pre/post-workout sandwich.
const MEAL_TIMING_RULES = `MEAL TIMING — slots are FLEXIBLE, schedule around the athlete's stated training times:
- Meal labels (breakfast/lunch/...) are suggestions, not a fixed template. Adapt count and timing
  to the USER SCHEDULE & MEAL PREFERENCES section (when present) and the training plan.
- If the athlete trains FASTED in the morning, do NOT emit a pre-workout meal — give them a
  substantial post-training breakfast instead.
- Use each day's "note" field to explain the timing choices for that day.`;

// Goal-aware weekly meal-plan prompt.
export function buildMealPlanPrompt(userInstruction?: string): string {
  const ctx = repo.getCoachContext();
  const prefs = (repo.getSettings().meal_prefs || "").trim();
  const split = (ctx.plan as any[]).map((d: any) => `Day ${d.day_number}: ${d.name}${d.focus ? ` (${d.focus})` : ""}`).join("; ");
  return `You are a super-healthy, getting-lean, longevity-focused nutrition coach building a 7-day
meal plan to support body recomposition (lose fat, preserve lean mass, eat for healthspan). The
athlete's profile, goal check (with computed TDEE and a lean-safe recommended intake), training
plan, recent activities, and food preferences in memory are in the DATA section.

HARD RULES:
- Use the RECOMMENDED intake from goal.recommended (lean-safe), NOT an aggressive crash deficit,
  even if the athlete's requested timeline implies a bigger deficit. If their goal is aggressive,
  build the lean-safe plan and say so in notes.
- Hit the protein target (goal.recommended.protein_g). Protein is the lever that protects muscle.
- Never propose intake below ~1500 kcal for this athlete regardless of math.
- Favor whole foods; respect any preferences/constraints in memory.
- Time more carbs around training days; keep it practical and repeatable, not 7 unique gourmet days.

${LONGEVITY_GUARDRAILS}

${MEAL_TIMING_RULES}

TRAINING SPLIT (plan the week's meals around these training days): ${split || "(no plan days)"}
${prefs ? `
USER SCHEDULE & MEAL PREFERENCES (follow these — they override generic templates):
${prefs}
` : ""}
${CONTEXT_GUARDRAILS}
- TRIPS specifically: for weeks overlapping a trip, lean on portable, travel-friendly meals and
  flag that the athlete will be eating out.
- HEALTH MARKERS specifically: e.g. low ferritin/iron → emphasize iron-rich foods; flag any
  marker-driven food emphasis in notes. Not medical advice.
${renderConnectedBrain(ctx, { domains: ["nutrition"] })}
TASK: ${userInstruction?.trim() || "Build next week's meal plan aligned to the recommended deficit and protein target."}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${MEAL_SCHEMA}

DATA:
${JSON.stringify(ctx)}`;
}

// ---------- T3: adaptive nutrition check-in (MacroFactor-style retarget) ----------
// A nutrition target CHANGE, drafted as a PROPOSAL the athlete reviews — never
// auto-applied. "no_change" is a first-class, common answer: most weeks nothing
// has really moved and the calm thing is to stay quiet.
const NUTRITION_CHECKIN_SCHEMA = `{
  "change": true | false,
  "summary": "<one or two plain sentences: what the data shows and what you'd suggest — or, if change is false, why staying put is right>",
  "nutrition": {
    "target_kcal": <number — the suggested new daily calorie target>,
    "protein_g": <number — daily protein target, hold or raise; never drop protein under a deficit>,
    "carbs_g": <number|null>,
    "fat_g": <number|null>,
    "prev_target_kcal": <number|null — the target this replaces, if known>,
    "reason": "<short, kind, trend-grounded reason; never about 'being good' or adherence>"
  },
  "notes": "<optional — anything to flag, may be empty>"
}`;

// Adaptive-nutrition check-in (Phase 3A). Given the real derived expenditure and
// the current target, ask the agent to either propose a single calm calorie/
// macro target change OR explicitly decline (change:false) when nothing has
// meaningfully moved. The caller only ever drafts a proposal when change:true —
// this prompt is the judgement layer, and the loop is adherence-NEUTRAL: a thin
// logging week is a reason for LESS confidence, never a target cut and never a
// scold. Macro floors: protect protein first, then fat, then carbs flex.
export function buildNutritionCheckinPrompt(ctx?: any, opts: { windowDays?: number } = {}): string {
  const context = ctx ?? repo.getCoachContext();
  const exp = repo.estimateExpenditure(opts.windowDays ?? 21);
  const goal: any = (context as any)?.goal ?? repo.computeGoalCheck();
  const profile: any = (context as any)?.profile ?? repo.getProfile();
  // The current target the athlete is (notionally) eating to: the requested
  // deficit target if set, else the lean-safe recommended one.
  const currentTarget = goal?.ok
    ? (goal.requested?.target_intake_kcal ?? goal.recommended?.target_intake_kcal ?? null)
    : null;
  const proteinTarget = goal?.ok ? (goal.recommended?.protein_g ?? null) : null;
  return `You are Cairn, the athlete's calm, getting-lean, longevity-focused nutrition buddy running a
quiet adaptive-nutrition check-in (MacroFactor-style). Their REAL energy expenditure has been derived
from logged intake and the bodyweight trend, adherence-neutral — it does NOT care whether they "were
good." Decide whether their calorie/macro target should change, and if so propose ONE calm adjustment
for them to review. NOTHING is applied automatically — they drive.

THE CONSTITUTION (binding):
- Adherence-NEUTRAL and kind. NEVER mention logging gaps, willpower, "being good/bad", or guilt. A
  thin data week is a reason for LOWER confidence, never a target cut.
- Plain language, no 0-100 scores. Frame food as "remaining", never "consumed"; there are no good or
  bad foods. Calm, never alarmist.
- A SUGGESTION, never a verdict. Only propose a change when the trend has GENUINELY moved away from
  the goal — otherwise set change:false and stay quiet (the common, correct answer most weeks).

DERIVED EXPENDITURE (real TDEE from intake − weighted weight trend):
${JSON.stringify(exp)}

CURRENT TARGET: ${currentTarget != null ? `~${currentTarget} kcal/day` : "(none set)"}, protein ~${proteinTarget != null ? `${proteinTarget} g/day` : "(unset)"}.
GOAL CHECK (lean-safe recommendation): ${JSON.stringify(goal)}

WHEN TO PROPOSE A CHANGE (else change:false):
- Confidence must be at least "medium" AND the trend must have drifted meaningfully off the goal pace
  (e.g. weight flat or rising while the goal is to lose, or losing far faster than the lean-safe
  ceiling so a small calorie RAISE keeps it sustainable).
- Keep any change SMALL and lean-safe: nudge calories by roughly ±100-250 kcal toward the goal pace,
  never a crash cut. Respect goal.recommended (lean-safe) as the floor — never below ~1500 kcal.
- MACRO FLOORS under a deficit: protect PROTEIN first (hold or raise — protein_g >= the current
  protein target), then fat to a healthy minimum, and let CARBS take the adjustment.
- If an active trip/illness window is in the data, prefer change:false — the data is disrupted; wait.

${CONTEXT_GUARDRAILS}
${renderConnectedBrain(context, { domains: ["nutrition"] })}
ATHLETE: profile: ${JSON.stringify(profile)}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${NUTRITION_CHECKIN_SCHEMA}`;
}

const SWAP_SCHEMA = `{ "name": "<dish>", "items": "<short ingredient list>", "kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number> }`;

// Agentic single-meal swap: replace ONE meal in an existing drafted plan,
// honoring an optional free-text hint ("let's go with fish").
export function buildMealSwapPrompt(args: { plan: any; day: string; mealIndex: number; hint?: string }): string {
  const { plan, day, mealIndex, hint } = args;
  const parsed = plan?.parsed ?? {};
  const dayObj = (Array.isArray(parsed.days) ? parsed.days : []).find(
    (d: any) => String(d?.day ?? "").trim().toLowerCase() === String(day ?? "").trim().toLowerCase()
  );
  const meals = Array.isArray(dayObj?.meals) ? dayObj.meals : [];
  const current = meals[mealIndex];
  const profile = repo.getProfile();
  const goal = repo.computeGoalCheck();
  const prefs = (repo.getSettings().meal_prefs || "").trim();
  // The connected brain must reach the swap too — otherwise a flagged marker's
  // nutrition directive (e.g. "tilt toward fish/poultry, lower saturated fat")
  // is silently ignored and the replacement can reintroduce a steered-away food.
  // renderConnectedBrain returns "" when there are no active directives.
  const ctx = repo.getCoachContext();
  const dayMeals = meals
    .map((m: any, i: number) => `${i === mealIndex ? ">>> SWAP THIS ONE >>> " : ""}[${i}] ${m?.name ?? "?"} — ${m?.items ?? ""} (${m?.kcal ?? "?"} kcal, ${m?.protein_g ?? "?"}g protein, ${m?.carbs_g ?? "?"}g carbs, ${m?.fat_g ?? "?"}g fat)`)
    .join("\n");
  return `You are a super-healthy, getting-lean, longevity-focused nutrition coach. The athlete wants
to SWAP one meal in their drafted meal plan for a different dish. Propose exactly ONE replacement.

THE DAY (${dayObj?.day ?? day}) — its meals, with the one to replace marked:
${dayMeals || "(no meals found)"}

PLAN DAILY TARGET: ${parsed.daily_kcal ?? "?"} kcal / ${parsed.daily_protein_g ?? "?"}g protein per day.

REPLACEMENT RULES:
- Keep the new meal within ±10% of the replaced meal's kcal (${current?.kcal ?? "?"}) and protein
  (${current?.protein_g ?? "?"}g) — UNLESS the athlete's hint clearly asks otherwise.
- It must fit the rest of the day (don't duplicate another meal's main protein/dish).

${LONGEVITY_GUARDRAILS}
${renderConnectedBrain(ctx, { domains: ["nutrition"] })}
${prefs ? `
USER SCHEDULE & MEAL PREFERENCES (follow these):
${prefs}
` : ""}${hint?.trim() ? `
ATHLETE'S HINT (honor this): ${hint.trim()}
` : ""}
ATHLETE: profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}

OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences:
${SWAP_SCHEMA}`;
}

const RECIPE_SCHEMA = `{ "summary": "<1-2 sentences: how this meal serves the getting-lean / longevity goal>",
  "time_min": <total prep+cook minutes, number>,
  "servings": <number>,
  "ingredients": [{"item": "<ingredient>", "qty": "<amount>"}],
  "steps": ["<ordered, practical step>"],
  "tips": ["<2-4 prep-ahead / swap / seasoning hints>"] }`;

// Agentic recipe for ONE planned meal — the result is cached on the meal
// inside the plan's parsed_json (see repo.setMealRecipe).
export function buildRecipePrompt(args: { plan: any; day: string; mealIndex: number }): string {
  const { plan, day, mealIndex } = args;
  const parsed = plan?.parsed ?? {};
  const dayObj = (Array.isArray(parsed.days) ? parsed.days : []).find(
    (d: any) => String(d?.day ?? "").trim().toLowerCase() === String(day ?? "").trim().toLowerCase()
  );
  const meals = Array.isArray(dayObj?.meals) ? dayObj.meals : [];
  const current = meals[mealIndex];
  const profile = repo.getProfile();
  const goal = repo.computeGoalCheck();
  const prefs = (repo.getSettings().meal_prefs || "").trim();
  return `You are a super-healthy, getting-lean, longevity-focused nutrition coach. Write a practical,
home-cook recipe for ONE meal from the athlete's drafted meal plan.

THE MEAL (${dayObj?.day ?? day}, meal [${mealIndex}]):
${current ? `${current?.name ?? "?"} — ${current?.items ?? ""} (${current?.kcal ?? "?"} kcal, ${current?.protein_g ?? "?"}g protein, ${current?.carbs_g ?? "?"}g carbs, ${current?.fat_g ?? "?"}g fat)` : "(meal not found)"}

PLAN DAILY TARGET: ${parsed.daily_kcal ?? "?"} kcal / ${parsed.daily_protein_g ?? "?"}g protein per day.

RECIPE RULES:
- Use EXACTLY the meal's listed items as the base of the recipe (plus pantry staples: oil,
  salt, pepper, herbs, spices, vinegar, stock).
- Keep the finished dish consistent with the meal's kcal and macros above.
- Steps must be ordered and practical for a weeknight home cook.

${LONGEVITY_GUARDRAILS}
${prefs ? `
USER SCHEDULE & MEAL PREFERENCES (respect these):
${prefs}
` : ""}
ATHLETE: profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}

OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences:
${RECIPE_SCHEMA}`;
}

// ---------- quiet cross-domain insight (Phase 6A — pull, never push) ----------
const INSIGHT_SCHEMA = `{
  "kind": "connection",
  "found": true,
  "text": "<the ONE connection, one or two plain sentences in a friend's voice — NO numbers as scores, NO alarm>",
  "rationale": "<ONE short sentence (≤240 chars) of plain-language reasoning that backs the connection — speak TO the athlete ('your recent labs show…'), never narrate the data structures you were given>",
  "next_step": "<OPTIONAL: one concrete, low-friction next step (a food swap, a retest to consider) in ≤140 chars, or null — calm, never a directive>"
}`;

// The quiet-intelligence pass. Hunts the athlete's WHOLE picture for ONE genuine
// cross-domain connection they couldn't easily make themselves — the kind a
// friend who knew their labs, training, food and life would notice ("ferritin
// ran low in spring and your volume's been down since — could be iron-limited").
// It runs on demand / periodically and the result waits in-app; NOTHING is
// pushed. Honors the constitution: at most one real thing, plainly, kindly, or
// nothing at all. recent[] are insights already surfaced — do NOT repeat them.
export function buildInsightPrompt(ctx?: any, recent: string[] = []): string {
  const context = ctx ?? repo.getCoachContext();
  const recentBlock = recent.length
    ? `\nALREADY SAID (do NOT repeat or reword any of these — find something genuinely new, or return found:false):\n${recent.map((r) => `  - ${r}`).join("\n")}\n`
    : "";
  return `You are Cairn, the athlete's calm health & longevity buddy. Look across their WHOLE picture
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
  paragraph. Speak TO the athlete in everyday words — NEVER narrate the data you were handed or name
  its internal fields (no "the health_review confirms…", "recent_sessions show…", "the goal object").
  No grocery-list of evidence; one plain reason is enough.
- It is a suggestion, never pressure. Rest and a quiet week are healthy, not problems to solve.
${recentBlock}
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
// in-app for the athlete to read whenever they like — pull, never push. Stored
// as an insight with kind:'weekly_read' so the Brief can surface it like any
// other quiet line. Same calm voice as the cross-domain pass; honest continuity
// (six steady weeks is "nice", a light week is fine), never streak pressure.
export function buildWeeklyReadPrompt(ctx?: any): string {
  const context = ctx ?? repo.getCoachContext();
  return `You are Cairn, the athlete's calm health & training buddy. Prepare a short standing read of
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
- BRIEF and HUMAN. The headline carries the read; rationale is ONE short sentence, never a paragraph.
  Speak TO the athlete in everyday words — NEVER narrate the data you were handed or name its internal
  fields. The one change, if any, goes in next_step.
- Grounded in their ACTUAL recent data only (training, recovery, nutrition, life context below).

OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences.
Nothing worth saying: {"found": false}
Otherwise:
${WEEKLY_READ_SCHEMA}

DATA:
${JSON.stringify(context)}`;
}

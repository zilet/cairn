// Program-facing prompts: the exercise how-to explanation, the exercise-name
// reconciliation, and the free-text onboarding extraction.
import { CAIRN_PERSONA } from "./shared.js";

const EXERCISE_EXPLANATION_SCHEMA = `{
  "setup": "<how to get into position, max 140 chars>",
  "move": "<the main execution cue, max 140 chars>",
  "feel": "<where it should be felt or what good reps feel like, max 140 chars>",
  "avoid": "<one safety/common-mistake cue, max 140 chars>"
}`;

// Frictionless onboarding: the user wrote ONE short free-text intro instead of
// filling a form. Extract a calm structured starting picture — never ask anything
// back. Only fill what they actually said; everything else stays null and Cairn
// learns it as they go (progressive understanding). Informational, never medical.
const ONBOARD_SCHEMA = `{
  "about_me": "<a clean 1-3 sentence summary of who they are, what they're training for, and any constraints — factual, in plain language>",
  "profile": { "sex": "male|female|null", "age": <int|null>, "height_cm": <number|null>, "weight_lb": <number|null>, "goal_weight_lb": <number|null>, "goal_date": "YYYY-MM-DD|null", "days_per_week": <int|null> },
  "goal": "lose|maintain|gain|recomp|null",
  "supplements": [ { "name": "Creatine monohydrate", "dose": "5 g", "frequency": "daily", "category": "performance", "related_markers": ["eGFR"] } ],
  "memories": [ { "content": "<durable preference or fact, e.g. trains fasted in the mornings>", "kind": "preference|constraint|decision|goal|observation" } ],
  "context_events": [ { "kind": "injury|trip|life_event", "title": "<short>", "detail": "<optional>", "meta": { "area": "<injury area>", "severity": "mild|moderate|severe" } } ]
}`;

export function buildOnboardPrompt(text: string): string {
  return `${CAIRN_PERSONA}

You're meeting the user for the FIRST time. They wrote a short intro about themselves.
Turn it into a calm, structured starting picture so the app is ready for them. DO NOT ask anything back —
this is a one-shot setup. Fill ONLY what they actually said or clearly implied; leave everything else
null/empty (Cairn learns the rest naturally over time). Approximate supplements sensibly (creatine →
~5 g/day; "some D" → Vitamin D3; whey → counts toward protein). Capture injuries as context_events. No
medical advice. Respond with ONE JSON object, no prose, no fences:
${ONBOARD_SCHEMA}

USER'S INTRO:
"""${String(text ?? "").slice(0, 4000)}"""`;
}

export function buildExerciseExplanationPrompt(detail: any): string {
  const ex = {
    name: detail?.name ?? "",
    muscle_group: detail?.muscle_group ?? null,
    mode: detail?.mode ?? "reps",
    constraint_note: detail?.constraint_note ?? null,
    cues: detail?.cues ?? null,
    appears: (Array.isArray(detail?.appears) ? detail.appears : []).map((a: any) => ({
      day: a?.day_number ?? null,
      day_name: a?.day_name ?? null,
      sets: a?.sets ?? null,
      reps: a?.rep_low != null || a?.rep_high != null ? [a?.rep_low ?? null, a?.rep_high ?? null] : null,
      seconds: a?.target_seconds ?? null,
      note: a?.note ?? null,
    })),
    recent: (Array.isArray(detail?.recent) ? detail.recent : []).slice(0, 5).map((r: any) => ({
      date: r?.date ?? null,
      weight: r?.weight ?? null,
      reps: r?.reps ?? null,
      rir: r?.rir ?? null,
      duration_sec: r?.duration_sec ?? null,
    })),
  };

  return `You write compact exercise detail text inside a strength training app.

Rules:
- Return only one JSON object, no prose and no markdown fences.
- Four short fields: setup, move, feel, avoid. Each field must be useful and <= 140 characters.
- Use plain coaching language for an intermediate lifter. No anatomy lecture.
- Respect constraint_note and existing cues. Never tell the user to push through pain.
- If mode is "timed", describe position and hold quality. If mode is "reps", describe repeatable reps.
- Informational only; do not diagnose or make clinical claims.

OUTPUT CONTRACT:
${EXERCISE_EXPLANATION_SCHEMA}

EXERCISE DETAIL:
${JSON.stringify(ex)}`;
}

// Single-exercise classification for the background 'exercise' enrichment job
// (src/enrich.ts). When an athlete adds an off-plan movement, the deterministic
// canon already cleaned the name + guessed a group/mode; this refines that ONE
// entry so the app can file it, write a how-to, and generate good art. It only
// tidies metadata — it NEVER touches logged numbers, and it must NOT turn the
// movement into a different exercise (a different implement/angle/grip IS a
// different exercise). The apply path is conservative (fills gaps, never clobbers).
const EXERCISE_ENRICH_SCHEMA = `{
  "canonical": "<the clean, canonical Title-Case name of THIS SAME movement (fix casing/typos/junk, keep the implement + angle); return it unchanged if already clean>",
  "muscle_group": "<primary muscle group, ONE of: chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, forearms, rear delts, mobility — or null if genuinely unclear>",
  "mode": "reps|timed",
  "equipment": "<short phrase for the main implement, e.g. 'a cable machine', 'a barbell', 'dumbbells', 'a resistance band', 'bodyweight' — or null if unclear>"
}`;

export function buildExerciseEnrichPrompt(detail: any): string {
  const ex = {
    name: detail?.name ?? "",
    muscle_group: detail?.muscle_group ?? null,
    mode: detail?.mode ?? "reps",
    constraint_note: detail?.constraint_note ?? null,
  };
  return `You are a strength-training data librarian tidying ONE exercise a user just added to their log.
Classify this single movement so the app can file it cleanly. Do NOT invent or substitute a different exercise.

RULES:
- Return only one JSON object, no prose and no markdown fences.
- "canonical": the cleanest real Title-Case name of THIS SAME movement — fix casing, typos, and junk words, but keep the implement and angle. If the name is already clean, return it unchanged. NEVER change it into a different movement.
- "muscle_group": the primary muscle group it trains, from the allowed list, or null if genuinely unclear.
- "mode": "timed" for a held position measured in seconds (plank, dead hang, wall sit, a stretch); "reps" for anything counted in reps.
- "equipment": a short phrase naming the main implement, or null if unclear.
- Plain words, no scores. Informational only; never diagnose or make clinical claims.

OUTPUT CONTRACT:
${EXERCISE_ENRICH_SCHEMA}

EXERCISE:
${JSON.stringify(ex)}`;
}

// Agentic exercise reconciliation — the clean-naming layer over the deterministic
// canonicalizer (src/repo/exercise-canon.ts). Users (and chat/import) name the
// same movement many ways and leave messy, descriptive titles ("incline db press
// lol 3x10"); the offline normalizer folds the obvious cases, but the long tail
// (a duplicate worded differently, a throwaway phrase that needs cleaning) is
// where a model helps. It clusters ONLY same-MOVEMENT names and profiles each to a
// clean canonical + muscle group + mode. This only tidies NAMES and tags groups
// for reuse — it NEVER touches the user's logged numbers — so a conservative
// miss is harmless; an over-merge (folding two different movements together) is
// the only real risk. Hence: when unsure, do NOT merge.
export function buildExerciseReconcilePrompt(
  items: Array<{ name: string; group: string | null; sets: number }>
): string {
  const list = items
    .map((it) => `  - "${it.name}" [${it.group ? it.group : "no group"}, ${it.sets} logged set${it.sets === 1 ? "" : "s"}]`)
    .join("\n");
  return `${CAIRN_PERSONA}

Right now you're acting as a strength-training data librarian. Below is a list of EXERCISE NAMES from one
user's training log — many are messy, descriptive, or the same movement worded different ways.
Your job: cluster names that are the SAME MOVEMENT to a clean canonical title and profile each (muscle
group + mode), so the app can reuse one tidy entry per movement.

RULES (a wrong merge folds two different movements together — be CONSERVATIVE):
- Group two names ONLY if they are unambiguously the SAME MOVEMENT. A different IMPLEMENT or ANGLE is a
  DIFFERENT exercise — do NOT merge across them:
    • barbell vs dumbbell ("Barbell Bench Press" ≠ "Dumbbell Bench Press")
    • incline vs flat vs decline ("Incline DB Press" ≠ "Flat DB Press")
    • machine vs free-weight, cable vs barbell, smith vs barbell
- CORRECT merges are the SAME movement reworded: "incline db press" = "incline dumbbell press" =
  "Incline DB Press". When unsure, do NOT merge — keep them separate.
- A single messy/descriptive title with NO duplicate is STILL a valid group IF it needs cleaning —
  emit it alone with a cleaned canonical (e.g. "incline db press lol 3x10" → canonical "Incline DB
  Press", members: ["incline db press lol 3x10"]). Skip a name that is already clean and unique.
- "members" = the EXACT names from the list (verbatim) that belong to the group. Every member must be a
  string copied from the list below.
- "canonical" = the cleanest real form of the movement, Title Case, no rep schemes / no junk words
  (e.g. "Romanian Deadlift", "Incline DB Press") — the cleanest existing member is fine.
- "group" = the muscle group this movement primarily trains, ONE of: chest, back, shoulders, biceps,
  triceps, quads, hamstrings, glutes, calves, core, forearms, rear delts, mobility — or null if truly
  unclear. Use "mobility" for stretches/mobility drills, "core" for ab/anti-rotation work.
- "mode" = "timed" for held positions measured in seconds (plank, dead hang, wall sit, a stretch);
  "reps" for everything counted in reps.

This ONLY tidies names and tags muscle groups for reuse — it NEVER changes the user's logged numbers
(weights, reps, dates). Plain words, no scores.

OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences:
{"groups": [{"members": ["<verbatim name>", "<verbatim name>", ...], "canonical": "<clean Title-Case name>", "group": "<one group above or null>", "mode": "reps|timed"}]}
If nothing should be tidied or merged, return {"groups": []}.

EXERCISE NAMES (${items.length}):
${list}`;
}

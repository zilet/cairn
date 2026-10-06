// ---------- the what-if (v2 wave 5, "Ask") ----------
// The athlete asks a hypothetical in their own words; the team answers with ONE
// proposed change and its ripple across the six stones. The answer is a READ: nothing
// here changes the plan, and "Do it" is a separate server path through the autonomy
// policy (src/coachOps/whatif.ts). The stones' current words come from the server's
// own projection (src/domain/today/today-stones.ts) and are handed in, so the model
// reasons FROM where each stone stands rather than re-deriving it.
import type { WhatIfHint } from "../contracts/what-if.js";
import type { TodayStone } from "../contracts/today-stones.js";
import { getCoachContext } from "../repo/coach.js";
import type { CoachContext } from "../repo/coach-context.js";
import { promptData } from "./context-projection.js";
import { CAIRN_PERSONA, renderJsonContract, renderTrainingDriveLine } from "./shared.js";

// Prose twin of agent-contracts.ts WHAT_IF_SCHEMA. Keep the two in step.
const WHAT_IF_PROSE_SCHEMA = `{
  "change": {
    "kind": "training|nutrition|goal|other",
    "summary": "<the ONE change their question implies, in plain words, one sentence — a suggestion, never an order>",
    "changes": [
      {"day_number": 1, "exercise": "<a lift already on that plan day>", "sets": 3, "rep_low": 8, "rep_high": 10,
       "target_weight": 135, "reason": "<one plain clause>"}
    ],
    "nutrition": {"target_kcal": 2200, "protein_g": 160}
  },
  "ripple": [
    {"stone": "strength|endurance|fuel|recovery|body|heart",
     "direction": "helps|costs|steady|mixed",
     "why": "<ONE plain sentence, athlete-facing, no score>",
     "confidence": "likely|possible|unsure"}
  ]
}`;

function renderStones(stones: readonly TodayStone[]): string {
  if (!stones.length) return "";
  const lines = stones.map((s) => `  - ${s.label} (${s.key}): "${s.word}"${s.line ? ` — ${s.line}` : ""}`);
  return `WHERE THE SIX STONES STAND TODAY (the server's own words; reason from these):\n${lines.join("\n")}\n`;
}

function renderHint(hint: WhatIfHint | null | undefined): string {
  if (!hint?.area && !hint?.direction) return "";
  const bits = [hint.area ? `area: ${hint.area}` : "", hint.direction ? `direction: ${hint.direction}` : ""].filter(
    Boolean
  );
  return `THE SURFACE'S STRUCTURED HINT (their words still decide): ${bits.join(", ")}\n`;
}

export function buildWhatIfPrompt(
  question: string,
  opts: { stones?: readonly TodayStone[]; hint?: WhatIfHint | null; ctx?: CoachContext } = {}
): string {
  const context = opts.ctx ?? getCoachContext();
  return `${CAIRN_PERSONA}

The athlete is asking a WHAT-IF — a hypothetical, not a request to change anything yet:
"${question.replace(/"/g, "'").slice(0, 1000)}"

Answer the way an elite coaching team would talk it through at the table: name the ONE concrete
change their question implies, then say how it would ripple across the six stones of their picture
(Strength, Endurance, Fuel, Recovery, Body, Heart).

THE CONSTITUTION (binding):
- This is a READ. Nothing changes because of it; the athlete decides whether to hand it to the team.
- NO scores. No 0-100, no percent grades, no points. Direction and confidence are the closed words in
  the schema — never a number in their place. A "why" may name a real quantity ("about 10 km more a
  week") but never a grade.
- A suggestion, never a gate: no "you must", no "you can't", no alarm. Plain everyday words; never
  name internal data fields.
- Silence is QUIET, never bad: a stone with nothing fresh to read is "steady" with confidence
  "unsure", never "costs". A thin logging day is absent, never low.
- Health findings are informational, never medical advice. Anything touching an injury, imaging or a
  clinician is the athlete's and their clinician's call — describe the ripple, never prescribe care.
- Be honest about uncertainty: "likely" only when their own recent data carries it; otherwise
  "possible" or "unsure".

THE CHANGE:
- kind "training": a concrete edit to lifts ALREADY on their plan (DATA.plan), as changes[] with the
  plan's own day_number. Plan days hold strength only — never put a run in changes[]; a run-volume
  question is kind "other" (runs follow their stated run days and the run engine).
  Name only the fields you change and leave the rest out — never null to mean "unchanged". To take a
  lift off the day, use "remove": true.
- kind "nutrition": a calorie and protein target in nutrition{} (name both; if only one moves, carry
  the other at its current target). Protein comes first; never trade
  protein away to fit calories, and never propose a surplus during a cut.
- kind "goal": the question changes WHAT they are aiming at (a goal weight, a race). Summarize it; no
  changes[] — a goal is theirs to name.
- kind "other": anything else. Summarize it; no changes[].

THE RIPPLE: one entry per stone the change would genuinely touch (all six is fine). Each "why" is ONE
short sentence in a friend's voice, grounded in their actual data.

${renderStones(opts.stones ?? [])}${renderHint(opts.hint)}${renderTrainingDriveLine(context)}
${renderJsonContract(WHAT_IF_PROSE_SCHEMA)}

DATA:
${promptData(context, "what_if")}`;
}

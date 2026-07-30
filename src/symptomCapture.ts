// The ONE symptom-capture contract.
//
// Same role src/foodCapture.ts plays for meals, and for the same reason: the moment
// a second surface re-declares this JSON shape inline, the two drift and one of them
// quietly stops emitting a field the rest of the system reads. So the shape, the
// prompt that asks for it, and the validation every returned payload crosses all
// live here, once.
//
// WHAT THIS LANE IS FOR. The athlete reports pain in their own words — a session
// note, a chat message, a feedback line. Those words are already stored verbatim
// (src/repo/symptom-reports.ts) before anything here runs. This module turns them
// into the STRUCTURE the training loop can act on: which watch they are about,
// whether it got better or worse, and which movements they named.
//
// THE RULES THAT MAKE IT SAFE TO LET A MODEL DO THIS AT ALL:
//
//  1. The model never picks an id. It echoes an AREA LABEL; the deterministic side
//     matches that label to an existing event through symptomAreaKey. A model that
//     hallucinates a label simply matches nothing and opens a new watch — it can
//     never redirect a report onto somebody else's record.
//  2. The model never invents a movement. It may only name movements from the list
//     it was given, and the deterministic side re-matches every name against that
//     same list; an unmatched name fails the payload rather than creating a lift.
//  3. `quote` must be the athlete's actual words — validation requires it to appear
//     in the source text. That is what keeps coaching prose, a score, or a verdict
//     from riding into a field the surface renders as if the athlete wrote it.
//  4. Failure is free. A rejected payload marks the report 'failed' and changes
//     nothing else; the words stay stored and displayed. Extraction is an
//     enhancement, never a gatekeeper.

import { SYMPTOM_AREA_MAX } from "./repo/symptom-area.js";

export const SYMPTOM_CHANGE_VALUES = ["new", "worse", "same", "better", "resolved"] as const;
export type SymptomChange = (typeof SYMPTOM_CHANGE_VALUES)[number];

export const SYMPTOM_CAPTURE_SCOPES = ["area", "systemic"] as const;
export type SymptomCaptureScope = (typeof SYMPTOM_CAPTURE_SCOPES)[number];

export const SYMPTOM_MOVEMENT_OUTCOMES = ["pain_free", "pain_present"] as const;
export type SymptomMovementOutcome = (typeof SYMPTOM_MOVEMENT_OUTCOMES)[number];

export const SYMPTOM_QUOTE_MAX = 500;
const MAX_REPORTS = 6;
const MAX_MOVEMENTS = 12;

export interface SymptomCaptureMovement {
  name: string;
  outcome: SymptomMovementOutcome;
}

export interface SymptomCaptureReport {
  quote: string;
  area_label: string | null;
  scope: SymptomCaptureScope;
  change: SymptomChange;
  movements: SymptomCaptureMovement[];
}

export interface SymptomCaptureResult {
  found: boolean;
  reports: SymptomCaptureReport[];
}

/** One open watch, as the model is allowed to see it: a label and a scope, no id. */
export interface SymptomCaptureEvent {
  id: number;
  area_label: string;
  scope: SymptomCaptureScope;
}

export interface SymptomCaptureContext {
  /** The athlete's verbatim words. */
  text: string;
  reported_on: string;
  active_events: SymptomCaptureEvent[];
  /** Movements logged in the day's session — the ones a report can be about. */
  session_movements: string[];
  /** Other movements recently trained, so a named lift outside today still matches. */
  recent_movements: string[];
}

// ---- cheap prefilter -----------------------------------------------------------

// Words that make a note worth an agent call. Deliberately generous on the body/pain
// side and deliberately CHEAP: this runs on every session note, and "great session,
// felt strong" must never cost a CLI invocation. A false positive costs one small
// call; a false negative costs nothing but a missed structuring, because the words
// are stored either way.
const BODY_TERMS =
  /\b(pain|painful|pains|ache|aches|aching|ached|hurt|hurts|hurting|sore|soreness|stiff|stiffness|tight|tightness|tender|niggle|niggly|twinge|twinges|strain|strained|sprain|sprained|tweak|tweaked|flare|flared|flare[- ]?up|inflam\w*|swollen|swelling|numb|numbness|tingl\w*|pinch\w*|discomfort|unpleasant|unpleasent|injur\w*|impinge\w*|throb\w*|burning)\b/i;
const BODY_PARTS =
  /\b(knee|knees|shoulder|shoulders|elbow|elbows|wrist|wrists|hand|hands|finger|fingers|hip|hips|groin|glute|glutes|back|lumbar|spine|neck|ankle|ankles|achilles|calf|calves|shin|shins|foot|feet|toe|toes|forearm|forearms|bicep|biceps|tricep|triceps|hamstring|hamstrings|quad|quads|pec|pecs|chest|rib|ribs|sternum|joint|joints|tendon|tendons|rotator cuff|si joint|ac joint|plantar)\b/i;
// "Everything feels off" names no part and no clinical term, and it is exactly the
// report the old UI had nowhere to put. It must reach the lane.
const SYSTEMIC_TERMS =
  /\b(everything (?:feels?|is|was|hurts?)|whole body|all over|body feels? (?:off|wrong|rough|beat|wrecked)|feel(?:ing)? (?:off|rough|wrecked|beat up|run down)|nothing feels? right|generally (?:sore|achy|off))\b/i;

/**
 * Whether a free-text note plausibly says something about the athlete's body.
 * Deterministic, allocation-cheap, and the only thing standing between "logged a
 * good session" and an agent invocation.
 */
export function symptomTextMentionsBody(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (SYSTEMIC_TERMS.test(text)) return true;
  return BODY_TERMS.test(text) || (BODY_PARTS.test(text) && /\b(feel|feels|felt|bother\w*|off|weird|odd)\b/i.test(text));
}

// ---- prompt --------------------------------------------------------------------

export const SYMPTOM_CAPTURE_SCHEMA = `{
  "found": <true|false>,
  "reports": [
    {
      "quote": "<the athlete's OWN words about this one thing, copied exactly from their text>",
      "area_label": "<short place, e.g. 'right wrist' / 'outside of left knee'; null for a whole-body report>",
      "scope": "${SYMPTOM_CAPTURE_SCOPES.join("|")}",
      "change": "${SYMPTOM_CHANGE_VALUES.join("|")}",
      "movements": [{ "name": "<exact name from the movement list>", "outcome": "${SYMPTOM_MOVEMENT_OUTCOMES.join("|")}" }]
    }
  ]
}`;

export const SYMPTOM_CAPTURE_GUARDRAILS = [
  `"quote" must be COPIED from the athlete's text, word for word. Do not paraphrase, tidy, translate or summarize it, and never write a sentence of your own there.`,
  `"area_label" is a short PLACE — two or three words naming where it is. It is not a sentence, not a diagnosis, and never carries a number, a rating or advice. Use null when the report names no place.`,
  `Use scope "systemic" only when the report is genuinely about the whole body ("everything feels off") rather than one place. A systemic report has area_label null and no movements.`,
  `To say a report is about a watch already open, echo that watch's label EXACTLY as it appears in the open-watches list. Do not invent ids and do not merge two different places into one report.`,
  `"movements" may only name movements from the movement list given below, spelled as they appear there. If the athlete named something that is not on the list, leave movements empty rather than guessing.`,
  `"change" describes what the athlete said about this report relative to before: new, worse, same, better, or resolved. Say "same" when they mention it without saying which way it moved.`,
  `Never write a severity score, a 0-10 rating, a percentage, or an instruction about what to train. You are recording what they said, not judging it or deciding anything.`,
  `Return {"found": false, "reports": []} when the text says nothing about the body. That is a correct, common answer.`,
] as const;

function movementList(ctx: SymptomCaptureContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...ctx.session_movements, ...ctx.recent_movements]) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * The prompt. Deliberately BOUNDED: the athlete's words, the open watches, and the
 * movements they could plausibly mean. It does not get the coach context and must
 * not — this is a reading task over a paragraph, not a coaching decision.
 */
export function buildSymptomCapturePrompt(ctx: SymptomCaptureContext): string {
  const movements = movementList(ctx);
  const watches = ctx.active_events.map(
    (event) => `- ${event.area_label}${event.scope === "systemic" ? " (whole body)" : ""}`
  );
  return [
    `You are reading one thing an athlete wrote about their body and recording what it says. You are not coaching, not diagnosing, and not deciding anything about their training.`,
    ``,
    `THEIR WORDS (${ctx.reported_on}):`,
    `"""`,
    String(ctx.text ?? "").slice(0, 8000),
    `"""`,
    ``,
    watches.length
      ? `WATCHES ALREADY OPEN (echo a label exactly to say the report is about that one):\n${watches.join("\n")}`
      : `WATCHES ALREADY OPEN: none.`,
    ``,
    movements.length
      ? `MOVEMENTS YOU MAY NAME (use these spellings, nothing else):\n${movements.map((name) => `- ${name}`).join("\n")}`
      : `MOVEMENTS YOU MAY NAME: none — leave every "movements" array empty.`,
    ``,
    `Return ONLY this JSON, no prose around it:`,
    SYMPTOM_CAPTURE_SCHEMA,
    ``,
    `Rules:`,
    SYMPTOM_CAPTURE_GUARDRAILS.map((line) => `- ${line}`).join("\n"),
  ].join("\n");
}

// ---- validation ----------------------------------------------------------------

export type SymptomCaptureValidation =
  | { ok: true; result: SymptomCaptureResult }
  | { ok: false; reason: string };

function normalizeForMatch(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A score in any of the forms a model actually emits. Applied to the model-authored
// label only — the athlete's own "7/10" inside a quote is their words and stays.
const SCORE_RE = /\b\d+\s*(?:\/\s*\d+|%|out of \d+)|\b(?:score|rating|severity|grade)\b|\b(?:pain|nrs|vas)\s*[:=]?\s*\d/i;
// Gate language: the one register a capture must never enter (docs/VISION.md — a
// read is a suggestion, never a verdict, and this is not even a read).
const GATE_RE =
  /\b(?:you must|you need to|you should|do not train|don'?t train|stop training|avoid all|not cleared|must not|is contraindicated|no (?:lifting|training) until)\b/i;

/** Deterministic movement matching. The model names; this decides. */
export function matchSymptomMovement(name: unknown, candidates: string[]): string | null {
  const wanted = normalizeForMatch(name);
  if (!wanted) return null;
  let best: { name: string; score: number } | null = null;
  for (const candidate of candidates) {
    const normalized = normalizeForMatch(candidate);
    if (!normalized) continue;
    if (normalized === wanted) return candidate;
    // A contained name is the common near-miss ("landmine press" for "Landmine
    // Press (Left)"). Prefer the tightest containment so a short generic term
    // cannot beat the specific lift the athlete actually trained.
    const contains = normalized.includes(wanted) || wanted.includes(normalized);
    if (!contains) continue;
    const score = Math.abs(normalized.length - wanted.length);
    if (!best || score < best.score) best = { name: candidate, score };
  }
  return best?.name ?? null;
}

/**
 * Coerce and VALIDATE one agent payload. Strict by design: a violation fails the
 * whole extraction rather than being repaired, because a half-trusted structure
 * written over an athlete's health record is worse than no structure at all — and
 * the cost of failing is zero, since their words are already stored.
 */
export function coerceSymptomCapture(value: unknown, ctx: SymptomCaptureContext): SymptomCaptureValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "payload is not an object" };
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.found !== "boolean") return { ok: false, reason: "found must be a boolean" };
  const rawReports = payload.reports;
  if (rawReports != null && !Array.isArray(rawReports)) return { ok: false, reason: "reports must be an array" };
  const reportsIn = Array.isArray(rawReports) ? rawReports : [];
  if (reportsIn.length > MAX_REPORTS) return { ok: false, reason: "too many reports" };
  if (!payload.found) return { ok: true, result: { found: false, reports: [] } };
  if (!reportsIn.length) return { ok: false, reason: "found is true but no reports were returned" };

  const source = normalizeForMatch(ctx.text);
  const candidates = movementList(ctx);
  const reports: SymptomCaptureReport[] = [];

  for (const raw of reportsIn) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "report is not an object" };
    const row = raw as Record<string, unknown>;

    const quote = String(row.quote ?? "").trim();
    if (!quote) return { ok: false, reason: "report is missing the athlete's words" };
    if (quote.length > SYMPTOM_QUOTE_MAX) return { ok: false, reason: "quote is longer than the athlete's report" };
    // The one check that makes `quote` trustworthy on a surface: it has to be
    // something they actually wrote.
    if (!source.includes(normalizeForMatch(quote))) {
      return { ok: false, reason: "quote is not the athlete's own words" };
    }

    if (row.scope != null && !(SYMPTOM_CAPTURE_SCOPES as readonly string[]).includes(String(row.scope))) {
      return { ok: false, reason: "scope is not a recognized value" };
    }
    const scope: SymptomCaptureScope = row.scope === "systemic" ? "systemic" : "area";

    const change = String(row.change ?? "same");
    if (!(SYMPTOM_CHANGE_VALUES as readonly string[]).includes(change)) {
      return { ok: false, reason: "change is not a recognized value" };
    }

    let areaLabel: string | null = row.area_label == null ? null : String(row.area_label).trim();
    if (areaLabel === "") areaLabel = null;
    if (areaLabel != null) {
      if (areaLabel.length > SYMPTOM_AREA_MAX) return { ok: false, reason: "area_label is prose, not a place" };
      if (SCORE_RE.test(areaLabel)) return { ok: false, reason: "area_label carries a score" };
      if (GATE_RE.test(areaLabel)) return { ok: false, reason: "area_label carries gate language" };
    }
    if (scope === "area" && !areaLabel) return { ok: false, reason: "an area report must name a place" };

    const rawMovements = row.movements;
    if (rawMovements != null && !Array.isArray(rawMovements)) {
      return { ok: false, reason: "movements must be an array" };
    }
    const movementsIn = Array.isArray(rawMovements) ? rawMovements : [];
    if (movementsIn.length > MAX_MOVEMENTS) return { ok: false, reason: "too many movements" };
    if (scope === "systemic" && movementsIn.length) {
      return { ok: false, reason: "a whole-body report cannot name movements" };
    }
    const movements: SymptomCaptureMovement[] = [];
    const seen = new Set<string>();
    for (const entry of movementsIn) {
      if (!entry || typeof entry !== "object") return { ok: false, reason: "movement entry is not an object" };
      const movementRow = entry as Record<string, unknown>;
      const outcome = String(movementRow.outcome ?? "");
      if (!(SYMPTOM_MOVEMENT_OUTCOMES as readonly string[]).includes(outcome)) {
        return { ok: false, reason: "movement outcome is not a recognized value" };
      }
      const matched = matchSymptomMovement(movementRow.name, candidates);
      if (!matched) return { ok: false, reason: `movement "${String(movementRow.name ?? "")}" is not one of theirs` };
      if (seen.has(matched)) continue;
      seen.add(matched);
      movements.push({ name: matched, outcome: outcome as SymptomMovementOutcome });
    }

    reports.push({ quote, area_label: areaLabel, scope, change: change as SymptomChange, movements });
  }

  return { ok: true, result: { found: true, reports } };
}

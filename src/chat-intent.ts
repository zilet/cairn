// Pure intent classification for chat turns — the regex/text gates that decide what a
// single athlete sentence AUTHORIZES, extracted verbatim from chatTurns.ts so they can
// be read and tested on their own. Every function here is a pure function of its
// arguments: no db, no repo, no clock. Anything that needs stored state (the goal
// negotiation window's own message history, a decision lookup, the lab-paste marker
// estimate) stays in chatTurns.ts, which composes these gates with the reads they need.
//
// chatTurns.ts re-exports every public name below, so existing importers are unchanged.
import { chatMessageRequestsCoaching, type ChatRoutingDecision } from "./chatRouting.js";

const INSTANT_FOOD_ALLOWED_REASONS = new Set(["explicit_food_log", "photo_food_default", "explicit_fast_request"]);
const QUESTION_LEAD_RE = /^(?:what|why|how|when|where|who|which|did|does|do|is|are|was|were|should|could|would|can)\b/i;

// Does this message place the meal in TIME at all? Deliberately a coarse "is there
// a when here", NOT a parser — the actual resolution of "last night" into a date and
// an hour is the agent's job, over DATA.now, one layer down. All this decides is
// which lane gets the sentence.
//
// It has to exist because the instant-capture lane runs with NO agent: it is a
// receipt path that stamps the note with today and no time. That is exactly right
// for "just had a protein shake" and exactly wrong for "I had a late dinner last
// night around 9", which the bypass would have silently filed under today. So any
// temporal reference disqualifies the bypass and the turn goes to the full lane,
// where the model reads the whole sentence and resolves the day and the hour.
// Erring toward the full lane is cheap (one ordinary chat turn); erring the other
// way writes the wrong day into the athlete's log.
const MENTIONS_WHEN_RE = new RegExp(
  [
    // named days and relative days
    String.raw`\b(?:yesterday|last\s+night|tonight|this\s+morning|this\s+afternoon|this\s+evening|earlier|later)\b`,
    String.raw`\b(?:last|past|previous)\s+(?:night|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)\b`,
    String.raw`\b(?:on\s+)?(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b`,
    // elapsed time ("a couple hours ago", "20 min ago")
    String.raw`\b(?:\d+|a|an|a\s+couple(?:\s+of)?|a\s+few|several)\s+(?:min(?:ute)?s?|hours?|hrs?|days?)\s+ago\b`,
    // explicit clock times ("at 8", "around 9pm", "8:30")
    String.raw`\b(?:at|around|about|near|by|before|after|since)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|o'?clock)?\b`,
    String.raw`\b\d{1,2}:\d{2}\s*(?:am|pm)?\b`,
    String.raw`\b\d{1,2}\s*(?:am|pm)\b`,
    // an explicit calendar date
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
  ].join("|"),
  "i"
);

export function mentionsWhen(message: string | null | undefined): boolean {
  return MENTIONS_WHEN_RE.test(String(message ?? ""));
}

export function isInstantFoodCaptureDecision(
  decision: ChatRoutingDecision | null | undefined,
  message: string | null | undefined
): boolean {
  if (!decision || decision.lane !== "capture") return false;
  const reasons = decision.reason_codes;
  // A bare photo is cheap to classify in the capture lane, but it is not consent
  // to log food. The receipt-only bypass requires explicit food-log language.
  if (!reasons.includes("explicit_food_log")) return false;
  if (reasons.some((reason) => !INSTANT_FOOD_ALLOWED_REASONS.has(reason))) return false;
  const text = String(message ?? "").trim();
  if (chatMessageRequestsCoaching(text)) return false;
  if (text && (text.includes("?") || QUESTION_LEAD_RE.test(text))) return false;
  // A meal placed in time is a remembering, not a receipt — let the agent read it.
  if (mentionsWhen(text)) return false;
  return true;
}

const PHOTO_FOOD_HINT_RE =
  /\b(food|meal|breakfast|lunch|dinner|snack|plate|bowl|ate|eating|calor(?:y|ies)|macro|protein|carb|fat|fiber|weigh(?:ed)?|grams?|oz|serving|portion|recipe|restaurant|label|packag(?:e|ing)|menu)\b/i;
const PHOTO_NON_FOOD_HINT_RE =
  /\b(physique|body|mirror|pose|form|equipment|bike|run|shoe|injur(?:y|ed)?|pain|dexa|scan|lab|blood|chart|screenshot)\b/i;

export function shouldCreatePhotoFoodPlaceholder(message: string | null | undefined): boolean {
  const s = (message ?? "").toString().trim();
  if (!s) return false; // a bare photo must be identified by vision before any food write
  if (PHOTO_FOOD_HINT_RE.test(s)) return true;
  if (PHOTO_NON_FOOD_HINT_RE.test(s)) return false;
  return false;
}

// A meal is useful recovery/fuel context, but it is not by itself evidence that a
// lift should change. This backstop prevents an overreaching chat model from
// turning a food capture into a surprise training intervention. If the athlete
// also reports a training, recovery, pain, or life signal, the targeted coaching
// path remains available.
const FOOD_TURN_RE =
  /\b(food|meal|breakfast|lunch|dinner|snack|plate|bowl|salad|chicken|restaurant|cafe|café|ate|eating|calor(?:y|ies)|macro|protein|carb|fat|fiber|portion|recipe|menu)\b/i;
const TRAINING_SIGNAL_RE =
  /\b(workout|train(?:ing|ed)?|lift(?:ing|ed)?|session|exercise|bench|squat|deadlift|press|row|run|ride|cycle|pain|sore|soreness|injur(?:y|ed)|recovery|sleep|hrv|fatigue|travel|trip|ill|sick)\b/i;
export function isFoodOnlyTurn(message: string | null | undefined, imagePath?: string | null): boolean {
  const text = String(message ?? "");
  return (Boolean(imagePath) || FOOD_TURN_RE.test(text)) && !TRAINING_SIGNAL_RE.test(text);
}

// Identity-level goals must come from an explicit athlete statement, never from
// a coach inference or an answer to a "what should my goal be?" question.
function isExploratoryGoalQuestion(text: string): boolean {
  return /\b(?:what|which)\b.{0,30}\b(?:goals?|targets?|priorities)\b|\b(?:should|could|would)\s+i\b.{0,30}\b(?:goals?|targets?|weigh|train|run|race)\b|\b(?:should|could|would)\s+i\b.{0,40}\b(?:get|drop|come|cut|slim|lean|lose|gain)\b/i.test(
    text
  );
}

export function hasExplicitGoalIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (isExploratoryGoalQuestion(text)) return false;
  return (
    /\bmy\s+(?:new\s+)?(?:goal|goals|priorities)\s+(?:is|are|will be)\b/i.test(text) ||
    /\b(?:set|change|update)\s+(?:my\s+)?(?:goals?|targets?|priorities|discipline)\b/i.test(text) ||
    /\bi\s+(?:want|plan|aim|intend|am going)\s+to\b.{0,80}\b(?:weigh|lose|gain|maintain|run|race|train|lift|cycle|ride|swim|complete|finish)\b/i.test(
      text
    ) ||
    /\b(?:train(?:ing)?\s+for|signed?\s+up\s+for|keep\s+me\b.{0,40}\bready)\b/i.test(text) ||
    // A stated bodyweight DESTINATION is a goal even without the word "goal":
    // "get down to 170 lb", "drop to 170 lbs by October". The unit is required so
    // "drop down to 135" about a barbell load never reads as a bodyweight goal.
    /\b(?:get|drop|come|cut|slim|lean|bring\s+(?:it|me|this))\s+(?:back\s+)?(?:down\s+)?to\s+\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds|kg)\b/i.test(
      text
    ) ||
    /\block(?:ing|ed)?\s+(?:it\s+|that\s+)?in\b.{0,60}\b\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds|kg)\b|\b\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds|kg)\b.{0,40}\block(?:ing|ed)?\s+(?:it\s+|that\s+)?in\b/i.test(
      text
    ) ||
    /\b(?:my|the)\s+goal\b.{0,30}\b\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds|kg)\b/i.test(text)
  );
}

// A short message that AGREES or refines a number/date rather than restating the
// whole goal — the shape a confirmation takes at the end of a negotiation ("154 by
// October 20th, then", "okay, let's lock that in"). Never a question.
function carriesGoalAffirmation(text: string): boolean {
  if (!text || isExploratoryGoalQuestion(text)) return false;
  return (
    /\b(?:ok(?:ay)?|yes|yep|yeah|sure|sounds\s+good|deal|agreed?|do\s+that|go\s+with|let'?s|lock(?:ing)?\s+(?:it\s+|that\s+)?in|make\s+it|confirm(?:ed)?|that\s+works)\b/i.test(
      text
    ) ||
    /\b\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds|kg)\b/i.test(text) ||
    /\bby\s+(?:early\s+|mid[-\s]?|late\s+|end\s+of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(
      text
    ) ||
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(text)
  );
}

// Goal negotiation is a CONVERSATION, not one sentence: the athlete states the goal,
// the coach pushes back on the timeline, the athlete confirms a refined number/date.
// A per-message gate reads that final confirmation as inexplicit and silently drops
// the write the athlete believes just happened. So a confirmation-shaped message may
// carry forward an explicit statement from the athlete's OWN recent messages — never
// from the coach's suggestion text, which is not searched at all. A "fresh start"
// archives the thread and closes the window.
export function hasExplicitGoalIntentInContext(
  message: string | null | undefined,
  recentAthleteMessages: readonly string[]
): boolean {
  if (hasExplicitGoalIntent(message)) return true;
  const text = String(message ?? "").trim();
  if (!text || !carriesGoalAffirmation(text)) return false;
  return recentAthleteMessages.some((m) => hasExplicitGoalIntent(m));
}

// Strength objectives are narrower than general profile/race goals: one named lift
// plus a chosen return-to-best or numeric destination. Exploratory "what should I"
// questions and broad comeback talk never create durable state.
export function hasExplicitStrengthObjectiveIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (
    /\b(?:what|which|how (?:much|heavy))\b.{0,45}\b(?:goal|target|lift|bench|squat|deadlift|press)\b|\b(?:should|could|would)\s+i\b/i.test(
      text
    )
  )
    return false;
  const namedLift =
    /\b(?:bench(?: press)?|squat|deadlift|overhead press|ohp|barbell press|dumbbell press|db press|row|pull[- ]?up)\b/i.test(
      text
    );
  if (!namedLift) return false;
  return (
    /\b(?:set|change|update)\s+(?:my\s+)?(?:strength\s+)?(?:goal|target|objective)\b/i.test(text) ||
    /\b(?:set|change|update)\s+(?:my\s+)?(?:bench(?: press)?|squat|deadlift|overhead press|ohp|barbell press|dumbbell press|db press|row|pull[- ]?up)\s+(?:goal|target|objective)\b/i.test(
      text
    ) ||
    /\b(?:my\s+(?:strength\s+)?goal\s+is|i\s+(?:want|aim|plan|intend)\s+to)\b.{0,100}\b(?:return|get back|build|reach|hit)\b/i.test(
      text
    ) ||
    /\b(?:return|get back)\b.{0,80}\b(?:personal best|\bpb\b|\bpr\b|old max|previous max)\b/i.test(text) ||
    /\bi\s+(?:want|aim|plan|intend)\s+to\b.{0,120}\bback\s+to\s+(?:my\s+)?(?:personal best|\bpb\b|\bpr\b|old max|previous max)\b/i.test(
      text
    )
  );
}

// A question is a conversation, not an authorization. The coach may still PROPOSE the
// change; it just doesn't carry the athlete's own word with it, so autonomy policy
// decides on its ordinary terms instead of on `explicit_user_request`.
//
// ONE guard for every training-edit gate below. It used to sit on the run gate alone,
// which meant the identical sentence ("Can you make tomorrow's run 8k?") quiet-applied
// through plan_update and held through set_run. Where the two gates disagreed, the
// conservative reading is the one that survives.
// `will` belongs here for the same reason `would` does: the revert gate's own
// per-sentence strip already treats "will you " as the same politeness wrapper as
// "can|could|would you ", so leaving it out of this alternation made one modal flip
// the outcome — "Would you undo that?" was conversation while "Will you undo that?"
// was a veto. Adding it also makes "Will you make tomorrow's run 8k?" a question to
// the plan/run edit gates, which is the point: one reading for one sentence form.
export function isLeadingQuestion(text: string): boolean {
  return /^(?:should|could|would|will|can|what|how|why|is|do|does)\b/i.test(text) && /\?\s*$/.test(text);
}

const PLAN_EDIT_VERB_RE =
  /\b(adjust|update|change|edit|fix|make|move|restructure|reshape|rebuild|switch|optimi[sz]e|remove|delete|drop|skip|replace|swap|add)\b/i;
const PLAN_EDIT_OBJECT_RE =
  /\b(plan|program|split|session|workout|today['’]?s|today|tonight|exercise|movement|sets?|reps?|bench|press|squat|deadlift|row|run|ride|cardio|lift)\b/i;

// The APPLY half of the athlete's vocabulary. Designing a session with the coach and
// then saying "ok apply it to my program for today" is the most direct instruction
// this gate will ever see, and it used to read as a background signal because none of
// those words were verbs here — the change was drafted, announced, and scheduled onto
// a LATER day whose premise the athlete never agreed to.
//
// Two vocabularies, because they carry different weight:
//   * STRONG apply verbs — "apply", "implement", "go with", "lock in" — mean putting a
//     change into the plan and nothing else, so a pronoun object is enough ("apply it").
//   * CONVERSATIONAL verbs — "use", "put", "set", "load", "make" — are ALSO the ordinary
//     English of REPORTING a session: "I use that machine a lot", "I had to use it with
//     less weight", "my set felt heavy". A pronoun is never enough for them. They need a
//     plan object (plan/program/session/workout/today), an imperative or future frame
//     ("use this for today", "let's use it today"), and a clause that is not narrating
//     something already done.
// Plus the phrases that ARE the whole instruction and name no object ("go ahead", "do
// it") — those say what to do without saying what to do it to, so they only mean
// something beside a proposal (see hasExplicitPlanEditIntentInContext).
const PLAN_APPLY_STRONG_VERB_RE = /\b(?:apply|implement|go\s+with|lock\s+in)\b/i;
const PLAN_APPLY_CONVERSATIONAL_VERB_RE = /\b(?:use|put|set|load|make)\b/i;
const PLAN_APPLY_OBJECT_NOUN_RE = /\b(?:plan|program|programme|split|session|workout|routine|today|tonight)\b/i;
// Imperative ("use this for today", "put that in my plan") or future ("let's use it
// today", "I'll put that in my plan") — never the bare present-tense report, which is
// the same words with the athlete as the subject ("I use that machine a lot").
const PLAN_APPLY_IMPERATIVE_FRAME_RE =
  /^(?:(?:ok(?:ay)?|yes|yeah|yep|sure|please|and|then|now|so|also|just)\s+)*(?:use|put|set|load|make)\b|\b(?:let'?s|we'll|we\s+will|we\s+can|i'll|i\s+will|going\s+to|gonna|please)\s+(?:just\s+)?(?:use|put|set|load|make)\b/i;
// Narration, not instruction: "That was brutal", "I had to use it", "I used the machine".
// A clause that reports is never an authorization, whatever verbs it happens to contain.
const PLAN_APPLY_PAST_NARRATIVE_RE =
  /\b(?:was|were|had|has\s+been|have\s+been)\b|^\s*i\s+(?:\w+ed|used|put|set|made|did|felt|went|ran|took|got|kept|tried)\b/i;
const PLAN_APPLY_STANDALONE_RE =
  /\b(?:go\s+ahead|go\s+for\s+it|do\s+it|lock\s+(?:it|that|this)\s+in|let'?s\s+do\s+(?:it|that|this))\b/i;
const PLAN_APPLY_PRONOUN_RE = /\b(?:it|that|this|these|those|them)\b/i;

function normalizePlanIntentText(message: string | null | undefined): string {
  return String(message ?? "")
    .replace(/[‘’]/g, "'")
    .trim();
}

// One clause at a time, because a single message mixes registers: "That was brutal. I
// had to use it with less weight." narrates in both of its clauses, while "use it today,
// I had a rough morning" instructs in the first and narrates in the second. Whether the
// verb sits in a narrating clause or an instructing one IS the question.
function planIntentClauses(text: string): string[] {
  return text
    .split(/[.!?;,\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

// Does this clause name an apply instruction AND the thing it applies to? This is the
// reading that stands on its own, with no coach message beside it.
function clauseNamesPlanApply(clause: string): boolean {
  if (PLAN_APPLY_PAST_NARRATIVE_RE.test(clause)) return false;
  if (PLAN_APPLY_STRONG_VERB_RE.test(clause) && PLAN_EDIT_OBJECT_RE.test(clause)) return true;
  return (
    PLAN_APPLY_CONVERSATIONAL_VERB_RE.test(clause) &&
    PLAN_APPLY_OBJECT_NOUN_RE.test(clause) &&
    PLAN_APPLY_IMPERATIVE_FRAME_RE.test(clause)
  );
}

// A go-ahead with no object of its own: "go ahead", "do it", "apply it", "go with that".
function clauseCarriesGoAhead(clause: string): boolean {
  if (PLAN_APPLY_PAST_NARRATIVE_RE.test(clause)) return false;
  if (PLAN_APPLY_STANDALONE_RE.test(clause)) return true;
  return PLAN_APPLY_STRONG_VERB_RE.test(clause) && PLAN_APPLY_PRONOUN_RE.test(clause);
}

// The athlete's sentence naming its OWN instruction: an edit verb with a concrete object
// ("remove Incline Bench"), or an apply verb with a plan object ("apply it to my program
// for today"). Nothing here needs the coach's previous message to be understood, which is
// why this — not the go-ahead shapes below — is what the apply path short-circuits on.
export function hasSelfContainedPlanEditIntent(message: string | null | undefined): boolean {
  const text = normalizePlanIntentText(message);
  if (!text) return false;
  if (isLeadingQuestion(text)) return false;
  if (PLAN_EDIT_VERB_RE.test(text) && PLAN_EDIT_OBJECT_RE.test(text)) return true;
  return planIntentClauses(text).some(clauseNamesPlanApply);
}

export function hasExplicitPlanEditIntent(message: string | null | undefined): boolean {
  const text = normalizePlanIntentText(message);
  if (!text) return false;
  if (isLeadingQuestion(text)) return false;
  if (hasSelfContainedPlanEditIntent(text)) return true;
  return planIntentClauses(text).some(clauseCarriesGoAhead);
}

// A go-ahead in a conversation — the coach laid out a session, the athlete said yes — is
// the athlete's own instruction even though the sentence names no object. But a go-ahead
// is only a go-ahead when it says what to DO. "ok", "great", "thanks", "yeah that was
// rough", "I felt strong on it" are SENTIMENT: the ordinary noise of talking about a
// session that already happened, and reading them as consent let an acknowledgment reach
// into the plan. So the message must carry an apply phrase of its own ("apply it", "go
// ahead", "do it", "lock it in", "set it up"); the agreement words that usually wrap it
// ("ok", "sounds good", "that works", "yes") are optional decoration, never the signal.
// Still deliberately narrow beyond that: short, not a question, nothing that reverses it.
const PLAN_AFFIRMATION_MAX_CHARS = 120;
const PLAN_APPLY_PHRASE_RE =
  /\b(?:apply|implement|go\s+ahead|go\s+for\s+it|do\s+it|do\s+that|let'?s\s+do\s+(?:it|that|this)|lock\s+(?:it|that|this)\s+in|go\s+with\s+(?:it|that|this)|(?:set|put|queue|line)\s+(?:it|that|this)\s+up|put\s+(?:it|that|this)\s+in|run\s+with\s+(?:it|that)|make\s+it\s+happen)\b/i;
const PLAN_AFFIRMATION_REVERSAL_RE = /\b(?:not|don'?t|do\s+not|never|hold\s+off|wait|later|maybe|instead|but)\b/i;

export function carriesPlanApplyAffirmation(message: string | null | undefined): boolean {
  const text = normalizePlanIntentText(String(message ?? "").replace(/\s+/g, " "));
  if (!text || text.length > PLAN_AFFIRMATION_MAX_CHARS) return false;
  if (text.includes("?") || isLeadingQuestion(text)) return false;
  if (PLAN_AFFIRMATION_REVERSAL_RE.test(text)) return false;
  return PLAN_APPLY_PHRASE_RE.test(text);
}

// Does the coach's message spell out a session at all? Deterministic and server-side on
// purpose: what turns a go-ahead into the athlete's own instruction is the shape of what
// they are agreeing to, never the model's own claim about it. Two or more prescription
// lines ("Deadlift 3×5 @ 165", "Split squat 2x10–12") is a spelled-out session; one stray
// number in prose is not. Whether that session is PROPOSED or merely read back is a
// second question, asked by readsAsSessionProposal below.
const SESSION_PRESCRIPTION_LINE_RE = /\b\d{1,2}\s*[x×*]\s*\d{1,2}(?:\s*(?:[-–—]|to)\s*\d{1,2})?\b/i;
const SESSION_PRESCRIPTION_MIN_LINES = 2;

export function draftsSessionPrescription(message: string | null | undefined): boolean {
  const lines = String(message ?? "").split(/\r?\n/);
  let matched = 0;
  for (const line of lines) {
    if (!SESSION_PRESCRIPTION_LINE_RE.test(line)) continue;
    matched += 1;
    if (matched >= SESSION_PRESCRIPTION_MIN_LINES) return true;
  }
  return false;
}

// Prescription lines alone are not a proposal. Three of them is simply how the coach
// describes ANY training day, including the one the athlete just finished — so a
// read-back followed by "ok, thanks" would have satisfied the go-ahead path. A proposal
// also FRAMES the lines as something not yet done ("here's the session", "here's what
// I'd run", "proposed", "queued", "want me to apply this?").
const SESSION_PROPOSAL_FRAME_RE = new RegExp(
  [
    String.raw`\bhere(?:'s| is)\s+(?:the|a|an|your|today'?s?|tomorrow'?s?|what)\b`,
    String.raw`\bi(?:'d| would)\s+(?:suggest|recommend|go|run|keep|swap|start|do|put)\b`,
    String.raw`\bpropos(?:e|es|ed|al|ing)\b`,
    String.raw`\bsuggest(?:s|ion|ed|ing)?\b`,
    String.raw`\bqueued?\b`,
    String.raw`\bdraft(?:s|ed|ing)?\b`,
    String.raw`\bfor\s+today\s*:`,
    String.raw`\bwant\s+me\s+to\b`,
    String.raw`\bshall\s+i\b`,
    String.raw`\b(?:apply|set|lock|queue)\s+(?:this|that|it)\s*(?:up|in)?\s*\?`,
    String.raw`\bhow(?:'s| does| do)\s+(?:this|that|these)\s+(?:look|sound)\b`,
  ].join("|"),
  "i"
);
// …and it is never a report of work already logged. This is the read-back the athlete
// answers with "ok thanks" or "yeah that was rough", and nothing in it is on the table.
const COMPLETED_SESSION_READBACK_RE = new RegExp(
  [
    String.raw`\byou\s+(?:did|hit|logged|finished|completed|ran|lifted|knocked)\b`,
    String.raw`\byou'?ve\s+(?:logged|done|finished|completed|hit)\b`,
    String.raw`^\s*today'?s\s+session\s*:`,
    String.raw`\bnice\s+work\b`,
    String.raw`\bthat'?s\s+(?:logged|in\s+the\s+books)\b`,
    String.raw`\blogged\s+(?:today|this\s+morning|earlier)\b`,
  ].join("|"),
  "im"
);

export function readsAsSessionProposal(message: string | null | undefined): boolean {
  const text = normalizePlanIntentText(message);
  if (!text) return false;
  if (!draftsSessionPrescription(text)) return false;
  if (COMPLETED_SESSION_READBACK_RE.test(text)) return false;
  return SESSION_PROPOSAL_FRAME_RE.test(text);
}

// The plan-edit gate read across the turn boundary, and the ONLY path a go-ahead takes.
// It asks two questions, and needs both: did the athlete say something apply-shaped
// ("ok apply it", never a bare "ok thanks"), and was there a PROPOSAL to apply?
// `priorAssistantMessage` is the coach's immediately preceding message in the live thread
// and `priorAssistantDrafted` is the server's own record that the same turn stored a plan
// draft; either one answers the second question. The model cannot reach any of these
// inputs, so it can never grant itself explicit status.
//
// A sentence that names its own instruction ("apply it to my program for today") skips
// the whole thing — but a bare "apply it" does not, because what it applies to lives in
// the coach's message, and if that message was a read-back there is nothing to apply.
export function hasExplicitPlanEditIntentInContext(
  message: string | null | undefined,
  priorAssistantMessage: string | null | undefined,
  priorAssistantDrafted = false
): boolean {
  if (hasSelfContainedPlanEditIntent(message)) return true;
  if (!carriesPlanApplyAffirmation(message)) return false;
  return priorAssistantDrafted || readsAsSessionProposal(priorAssistantMessage);
}

// A run prescription is durable training state, so the athlete's own words are what
// authorize writing it directly (explicit_user_request).
export function hasExplicitRunEditIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .trim();
  if (!text) return false;
  if (isLeadingQuestion(text)) return false;
  const verb =
    /\b(?:make|set|change|adjust|update|move|drop|cut|shorten|lengthen|extend|bump|raise|lower|swap|replace|add|turn|keep)\b/i;
  const object =
    /\b(?:runs?|running|jog|jogging|mileage|tempo|intervals?|long run|easy run|quality run|threshold|shakeout)\b/i;
  return verb.test(text) && object.test(text);
}

// A symptom record is a bounded factual capture, but still durable health-adjacent
// state. The model may only write it when the athlete independently asks Cairn to
// record it; merely mentioning pain or asking a question is not mutation authority.
export function hasExplicitSymptomReportIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  const write = /\b(?:log|record|note|track|save|add|report)\b/i;
  const symptom = /\b(?:pain|painful|ache|aching|aches|hurt|hurts|sore|soreness|discomfort|niggle)\b/i;
  const resolvedOrNegated =
    /\b(?:resolved|pain[- ]free|no longer (?:hurts?|aching|aches|sore|painful)|not (?:in pain|hurting|aching|sore|painful)|(?:does(?:n't|nt| not)|did(?:n't|nt| not)) (?:hurt|ache)|(?:is(?:n't|nt| not)|was(?:n't|nt| not)) (?:hurting|aching|sore|painful)|(?:pain|ache|aching|soreness|discomfort|niggle) (?:(?:is|has|feels?) (?:gone|resolved|cleared)|(?:went|has gone) away)|no (?:pain|ache|aching|soreness|discomfort|niggle))\b/i;
  const negatedWrite =
    /\b(?:do not|don't|dont|never|stop|avoid)\b[\s\S]{0,32}\b(?:log|record|note|track|save|add|report)\b/i;
  return write.test(text) && symptom.test(text) && !resolvedOrNegated.test(text) && !negatedWrite.test(text);
}

// Closing a pain note is the athlete's call, not the coach's read. The model may
// only close one when they say so in this turn — a good session, a week of silence,
// or a question about how it's going is never authority to close the record.
export function hasExplicitSymptomResolveIntent(message: string | null | undefined): boolean {
  const text = String(message ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (/\?\s*$/.test(text)) return false;
  const subject =
    /\b(?:pain|painful|ache|aching|aches|hurt|hurts|hurting|sore|soreness|discomfort|niggle|symptom|injury|knee|knees|shoulder|shoulders|elbow|elbows|wrist|hip|hips|groin|glute|back|lumbar|ankle|ankles|achilles|calf|calves|shin|foot|feet|forearm|note)\b/i;
  const closeCommand =
    /\b(?:close|resolve|clear)\b|\bmark(?:\s+(?:it|that|them))?\s+(?:as\s+)?(?:resolved|healed|better|fine|done)\b/i;
  const healed =
    /\b(?:healed|all better|resolved|pain[- ]free|no longer (?:hurts?|hurting|aching|sore|painful|bothering)|(?:is|has|are) (?:gone|cleared)|cleared up|went away|no (?:more )?(?:pain|ache|aching|soreness|discomfort|niggle))\b/i;
  const negated = /\b(?:do not|don't|dont|never|not|stop)\b[\s\S]{0,24}\b(?:close|resolve|clear|mark)\b/i;
  if (negated.test(text)) return false;
  return subject.test(text) && (closeCommand.test(text) || healed.test(text));
}

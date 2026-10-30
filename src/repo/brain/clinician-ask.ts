// A CLINICIAN ASK, SPOKEN TO THE ATHLETE.
//
// A decision the team holds for the athlete and their doctor (`for_clinician` on
// awaitingBrainDecisions — a clinician-floor hold, or a conference's clinical note) carries
// sentences an agent wrote. A conference's parallel actions are written for the TEAM, and
// live one read as a clinician's note about the athlete in the third person ("Facilitate
// athlete coordination with <a named physician> regarding …"), which the ask card and the
// visit questions then printed verbatim, clipped mid-word. Nothing here rewrites what is
// stored; this is the athlete-register projection every surface reads instead:
//
//   - the VISIT QUESTION is one short question the athlete would ask their doctor: the
//     clinical topics the decision names, from a fixed vocabulary ("Should we talk about a
//     statin and a carotid ultrasound?"), else its athlete-facing title ("Can we talk about
//     <title>?"), else nothing — the ask still lives on the ask card.
//   - the ASK CARD keeps a sentence that was written for the athlete; one in the
//     clinician's register is replaced by that question.
//
// Cairn wording never introduces a clinician's personal name: the vocabulary names none,
// and agent text that does is not the athlete's own words, so it never passes through.

import { clipText, joinList } from "../shared.js";
import { violatesReadingGrammar } from "../day-read-grammar.js";

// Producer labels the ledger prefixes a summary with ("Auto: …", "Case conference: …").
// Shared with the changes feed (src/domain/brain/changes-feed.ts), which holds its titles
// and whys to the same athlete line.
export const MACHINE_PREFIX = /^\s*(?:auto|case conference|chat|background|nutrition):\s/i;

/**
 * Text as an athlete-facing line: whitespace collapsed, clipped on a sentence or word
 * boundary, and null when it opens on a producer label or breaks the reading grammar.
 */
export function athleteLine(text: unknown, max: number): string | null {
  const value = clipText(text, max, { collapseWhitespace: true, wordBoundary: true, sentenceBoundary: true });
  if (!value || MACHINE_PREFIX.test(value) || violatesReadingGrammar(value)) return null;
  return value;
}

// The clinician's register, and a clinician's personal name. Either one means the text was
// written ABOUT the athlete for someone else, never to them.
const CLINICIAN_REGISTER: readonly RegExp[] = [
  /\bathletes?(?:'s?)?\b/i,
  /\b(?:the )?(?:patient|client)s?\b/i,
  /\bDr\.?\s+[A-Z]/,
  /\bDoctor\s+[A-Z][a-z]/,
  /\bfacilitat|\bcoordinat|\bpharmacotherap|\bauthori[sz]|\boutpatient\b|\bper (?:physician|provider|clinician|doctor)\b|\bclinically indicated\b/i,
];

/** True when the text reads as written TO the athlete (no clinician register, no named clinician). */
export function athleteRegister(text: unknown): boolean {
  const value = String(text ?? "");
  return !!value.trim() && !CLINICIAN_REGISTER.some((pattern) => pattern.test(value));
}

// The clinical topics a question may name, in the order a question lists them. Each phrase
// is the athlete's own noun ("a statin", "vitamin D"), never a clinician's. A general
// topic stands down when a more specific one it covers is named too.
interface AskTopic {
  key: string;
  phrase: string;
  pattern: RegExp;
  coveredBy?: readonly string[];
  // A scan topic's whole noun phrase ("carotid ultrasound imaging", "coronary calcium
  // scan"). When the record answers the topic, this phrase leaves the text, so a generic
  // topic it covered comes back only when the text names ANOTHER scan ("… and a knee MRI").
  span?: RegExp;
}

const SCAN_NOUN = String.raw`(?:\s+(?:artery|arteries|doppler|duplex|ultrasounds?|us|imaging|scans?|scoring|score|ct|tests?|study|studies|intima[- ]media thickness))*`;

const SPECIALISTS = ["lipid_specialist", "cardiology", "endocrinology", "nephrology", "hematology"];
const SCANS = ["cac", "carotid", "dexa", "echo"];

const ASK_TOPICS: readonly AskTopic[] = [
  { key: "statin", phrase: "a statin", pattern: /\bstatins?\b/i },
  {
    key: "lipid_drug",
    phrase: "cholesterol-lowering medication",
    pattern: /ezetimibe|pcsk9|\b(?:lipid|cholesterol)[- ]lowering (?:medications?|therap(?:y|ies)|drugs?)\b/i,
    coveredBy: ["statin"],
  },
  {
    key: "medication",
    phrase: "my medication",
    pattern: /\bmedications?\b|\bmedicines?\b|\bdrugs?\b|\bpharmac|\bdosage\b|\bprescription\b/i,
    coveredBy: ["statin", "lipid_drug"],
  },
  {
    key: "cac",
    phrase: "a coronary calcium (CAC) scan",
    pattern: /\bcac\b|coronary (?:artery )?calcium/i,
    span: new RegExp(String.raw`(?:\bcac\b|coronary (?:artery )?calcium)${SCAN_NOUN}`, "gi"),
  },
  {
    key: "carotid",
    phrase: "a carotid ultrasound",
    pattern: /\bcarotid\b/i,
    span: new RegExp(String.raw`\bcarotid${SCAN_NOUN}`, "gi"),
  },
  {
    key: "dexa",
    phrase: "a DEXA scan",
    pattern: /\bdexa\b|\bdxa\b/i,
    span: new RegExp(String.raw`\b(?:dexa|dxa)${SCAN_NOUN}`, "gi"),
  },
  {
    key: "ecg",
    phrase: "an ECG",
    pattern: /\b(?:ecg|ekg)\b|\belectrocardiogra/i,
    span: new RegExp(String.raw`(?:\b(?:ecg|ekg)\b|\belectrocardiogra\w*)${SCAN_NOUN}`, "gi"),
  },
  {
    key: "echo",
    phrase: "an echocardiogram",
    pattern: /\bechocardiogra/i,
    span: new RegExp(String.raw`\bechocardiogra\w*${SCAN_NOUN}`, "gi"),
  },
  { key: "stress_test", phrase: "a stress test", pattern: /\bstress test/i },
  {
    key: "imaging",
    phrase: "imaging",
    pattern: /\bimaging\b|\bultrasound\b|\bmri\b|\bct scan\b|\bx-?rays?\b/i,
    coveredBy: SCANS,
  },
  {
    key: "labs",
    phrase: "repeat blood work",
    pattern: /\b(?:lab|blood) ?(?:tests?|work|panels?|draws?)\b|\bretest|\brecheck|\bnext draw\b/i,
  },
  { key: "lipid_specialist", phrase: "a lipid specialist", pattern: /\blipid (?:specialist|clinic)|\blipidolog/i },
  { key: "cardiology", phrase: "a cardiologist", pattern: /\bcardiolog/i },
  { key: "endocrinology", phrase: "an endocrinologist", pattern: /\bendocrinolog/i },
  { key: "nephrology", phrase: "a nephrologist", pattern: /\bnephrolog/i },
  { key: "hematology", phrase: "a hematologist", pattern: /\bhematolog|\bhaematolog/i },
  { key: "referral", phrase: "a referral", pattern: /\breferr/i, coveredBy: SPECIALISTS },
  { key: "vitamin_d", phrase: "vitamin D", pattern: /\bvitamin d\d?\b/i },
  { key: "iron", phrase: "iron", pattern: /\biron\b|\bferritin\b/i },
  { key: "blood_pressure", phrase: "my blood pressure", pattern: /\bblood pressure\b|\bhypertens/i },
  { key: "thyroid", phrase: "my thyroid", pattern: /\bthyroid\b|\btsh\b/i },
  { key: "glucose", phrase: "my blood sugar", pattern: /\bglucose\b|\ba1c\b|\binsulin\b|\bblood sugar\b/i },
  {
    key: "lipids",
    phrase: "my cholesterol",
    pattern: /\bapo ?b\b|\bldl\b|\bcholesterol\b|\blipids?\b|\blp\(a\)|\blipoprotein/i,
    coveredBy: ["statin", "lipid_drug", "lipid_specialist"],
  },
];

const MAX_TOPICS = 5;
const QUESTION_MAX_CHARS = 160;
const TITLE_MAX_CHARS = 100;
// A plan-day number and an arrow are the ledger's shorthand, never a title.
const LABEL_SHAPE = /\bday \d+\b|→|->/i;

/** The visit question's basis: why this is on the list at all. */
export const CLINICIAN_ASK_BASIS = "The team flagged this for a clinician rather than deciding it.";

/** The ask card's sentence when nothing athlete-facing survives. */
export const CLINICIAN_ASK_FALLBACK = "The team flagged something here for your doctor rather than deciding it.";

// The topics a clinical text names. An answered scan topic's whole phrase leaves the text
// first, so a generic topic it covered ("imaging") stays down when the text named only that
// scan, and comes back when it names another one too ("a CAC scan and a knee MRI").
function namedTopics(texts: readonly unknown[], answered: ReadonlySet<string> = new Set()): AskTopic[] {
  let hay = texts.map((text) => String(text ?? "")).join("\n");
  if (!hay.trim()) return [];
  for (const topic of ASK_TOPICS) {
    if (answered.has(topic.key) && topic.span) hay = hay.replace(topic.span, " ");
  }
  const matched = ASK_TOPICS.filter((topic) => !answered.has(topic.key) && topic.pattern.test(hay));
  const keys = new Set(matched.map((topic) => topic.key));
  return matched.filter((topic) => !topic.coveredBy?.some((key) => keys.has(key)));
}

/** The athlete-register topics a clinical text names, in question order. */
export function clinicianAskTopics(texts: readonly unknown[], answered: ReadonlySet<string> = new Set()): string[] {
  return namedTopics(texts, answered)
    .map((topic) => topic.phrase)
    .slice(0, MAX_TOPICS);
}

/**
 * The scan topics a record on file already answers for an ask raised on `askDate`: a
 * matching record dated on or after the ask (`scansOnFile`: topic key → newest record
 * date, src/repo/scans-on-file.ts). A scan from before the ask leaves the topic standing.
 */
export function answeredScanTopics(
  askDate: string | null | undefined,
  scansOnFile: ReadonlyMap<string, string> | null | undefined
): Set<string> {
  const out = new Set<string>();
  const day = String(askDate ?? "").slice(0, 10);
  if (!day || !scansOnFile) return out;
  for (const [topic, date] of scansOnFile) if (date >= day) out.add(topic);
  return out;
}

function topicQuestion(texts: readonly unknown[], answered: ReadonlySet<string> = new Set()): string | null {
  const topics = clinicianAskTopics(texts, answered);
  // One sentence, never clipped: a topic that does not fit is left off, never cut.
  while (topics.length) {
    const question = `Should we talk about ${joinList(topics)}?`;
    if (question.length <= QUESTION_MAX_CHARS) return question;
    topics.pop();
  }
  return null;
}

function normalized(text: unknown): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/(?:…|\.\.\.)$/, "")
    .trim()
    .toLowerCase();
}

// A plain capitalised first word reads lower mid-question; an analyte (ApoB, LDL) keeps its case.
function lowerLead(text: string): string {
  const first = text.split(" ")[0] ?? "";
  return /^[A-Z][a-z]+$/.test(first) ? text[0].toLowerCase() + text.slice(1) : text;
}

// The decision's own athlete-facing title: its summary, when that is one short phrase in
// the athlete's register and not a copy of the agent's note. Never clipped — a title too
// long to print whole is not a title.
function athleteTitle(summary: unknown, agentTexts: readonly unknown[]): string | null {
  const raw = String(summary ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw || raw.length > TITLE_MAX_CHARS || /[.!?;]\s/.test(raw)) return null;
  if (LABEL_SHAPE.test(raw) || !athleteRegister(raw) || athleteLine(raw, TITLE_MAX_CHARS) !== raw) return null;
  const key = normalized(raw);
  if (agentTexts.some((text) => normalized(text).startsWith(key))) return null;
  return raw.replace(/[\s.!?…:;,]+$/, "") || null;
}

export interface ClinicianAskDecisionLike {
  summary?: unknown;
  action?: unknown;
}

export interface ClinicianAskVoice {
  /** One short question for the next visit, or null when nothing athlete-facing exists. */
  question: string | null;
  /** The ask card's line above the sentence ("" when there is no athlete-facing title). */
  line: string;
  /** The ask card's sentence: the athlete's own register, else the question, else a plain fallback. */
  explanation: string;
}

/**
 * The athlete-register projection of a decision held for the athlete and their doctor.
 * `answered` names topic keys the record already answers (answeredScanTopics): they leave
 * the question, and an ask whose every topic is answered asks nothing.
 */
export function clinicianAskVoice(
  decision: ClinicianAskDecisionLike,
  answered: ReadonlySet<string> = new Set()
): ClinicianAskVoice {
  const action = (decision.action ?? {}) as Record<string, unknown>;
  const spoken = String(action.user_explanation ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const notes = Array.isArray(action.clinician_notes) ? action.clinician_notes.map((note) => String(note ?? "")) : [];
  const agentTexts = [spoken, ...notes];
  const title = athleteTitle(decision.summary, agentTexts);
  const texts = [...notes, spoken, decision.summary];
  // Every topic the text named is answered by the record, and nothing else is left.
  const allAnswered = namedTopics(texts).length > 0 && namedTopics(texts, answered).length === 0;
  const question = allAnswered
    ? null
    : (topicQuestion(texts, answered) ?? (title ? `Can we talk about ${lowerLead(title)}?` : null));
  // A sentence written to the athlete stays theirs to read, whole; one written about them
  // for someone else is replaced by the question.
  const athleteSentence =
    spoken && athleteRegister(spoken) && !MACHINE_PREFIX.test(spoken) && !violatesReadingGrammar(spoken)
      ? spoken.slice(0, 700)
      : null;
  const explanation = athleteSentence ?? question ?? CLINICIAN_ASK_FALLBACK;
  // The title rides above the athlete's own sentence; above the question it would only
  // say the same thing twice.
  const line = title && athleteSentence && !normalized(athleteSentence).startsWith(normalized(title)) ? title : "";
  return { question, line, explanation };
}

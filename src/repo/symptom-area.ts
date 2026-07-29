// The ONE shape of an athlete-facing pain/injury AREA label. Every write path —
// surface, MCP, chat, session feedback, the legacy importer — funnels through
// normalizeSymptomArea, because a paragraph stored in `area_text` is not merely
// ugly: pain-relevance matches substrings, so one coach paragraph naming "back",
// "press" and "row" loads nearly every lift and makes every training outcome
// permanently non-comparable. A label is short, single-clause, and says WHERE.
//
// Deliberately dependency-free so every layer (repo, routes, MCP, chat) can hold
// the same contract without an import cycle.

export const SYMPTOM_AREA_MAX = 60;

// A label ends at the first sentence terminator or prose dash. Everything after
// it is narration ("left knee — I backed off the squats and it settled").
const CLAUSE_BREAK = /[.!?;\n\r]|\s[—–]\s|\s--\s/;
const TRAILING_NOISE = /[\s,;:.\-–—]+$/;

/** Collapse to a short single-clause area label. Returns "" for empty input. */
export function normalizeSymptomArea(value: unknown): string {
  const collapsed = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  const clause = collapsed.split(CLAUSE_BREAK)[0].replace(TRAILING_NOISE, "").trim();
  if (!clause) return "";
  if (clause.length <= SYMPTOM_AREA_MAX) return clause;
  const cut = clause.slice(0, SYMPTOM_AREA_MAX + 1);
  const boundary = cut.lastIndexOf(" ");
  const capped = boundary > 0 ? cut.slice(0, boundary) : clause.slice(0, SYMPTOM_AREA_MAX);
  return capped.replace(TRAILING_NOISE, "").trim();
}

// The joint/area vocabulary, mirroring the relevance map in pain-relevance.ts.
// Ordered most-specific-first; the EARLIEST match in the text wins, so "lower
// back" beats the bare "back" inside it.
const AREA_TERMS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\blower ?back\b/, label: "lower back" },
  { re: /\blumbar\b/, label: "lower back" },
  // Distinct from each other and from the bare "back": collapsing them would let a
  // "mid back" report ADOPT an "upper back" row and inherit tolerance evidence for
  // a different place. They keep the bare "back" relevance (pain-relevance matches
  // \bback\b inside each label) — only their identity is separated.
  { re: /\bupper ?back\b/, label: "upper back" },
  { re: /\bmid(?:dle)? ?back\b/, label: "mid back" },
  { re: /\bsacro\w*\b|\bsi joint\b|\bsi\b/, label: "SI joint" },
  // pain-relevance maps \bac\b to the pressing/rowing group, so the vocabulary has
  // to recognize it too — otherwise the relevance gate silently drops the mapping.
  { re: /\bac joint\b|\bacromioclavicular\b|\bac\b/, label: "AC joint" },
  { re: /\brotator cuff\b/, label: "rotator cuff" },
  { re: /\bknee\b|\bknees\b/, label: "knee" },
  { re: /\bshoulder\b|\bshoulders\b|\bdelt\w*\b/, label: "shoulder" },
  { re: /\belbow\b|\belbows\b|\bcubital\b/, label: "elbow" },
  { re: /\bforearm\b|\bforearms\b/, label: "forearm" },
  { re: /\bwrist\b|\bwrists\b/, label: "wrist" },
  { re: /\bhip\b|\bhips\b/, label: "hip" },
  { re: /\bgroin\b/, label: "groin" },
  { re: /\bglute\w*\b/, label: "glute" },
  { re: /\bachilles\b/, label: "Achilles" },
  { re: /\bankle\b|\bankles\b/, label: "ankle" },
  { re: /\bcalf\b|\bcalves\b/, label: "calf" },
  { re: /\bplantar\b/, label: "plantar fascia" },
  { re: /\bfoot\b|\bfeet\b/, label: "foot" },
  { re: /\bshin\b|\bshins\b|\btib(?:ialis)?\b/, label: "shin" },
  { re: /\bsternum\b/, label: "sternum" },
  { re: /\brib\b|\bribs\b/, label: "rib" },
  { re: /\bpec\w*\b/, label: "chest" },
  { re: /\bchest\b/, label: "chest" },
  { re: /\bspine\b/, label: "back" },
  { re: /\bback\b/, label: "back" },
];

const SIDE_RE = /\b(left|right|both|bilateral)\b[^a-z0-9]*$/;

/**
 * The canonical area label named anywhere in `value`, with its side when one sits
 * just before it ("outside of the left knee" -> "left knee"). Null when the text
 * names no area Cairn recognizes — the honest answer, and the one that keeps an
 * unmapped note from driving movement relevance.
 */
export function symptomAreaVocabularyLabel(value: unknown): string | null {
  const text = String(value ?? "").toLowerCase();
  if (!text) return null;
  let best: { index: number; label: string } | null = null;
  for (const term of AREA_TERMS) {
    const match = term.re.exec(text);
    if (!match) continue;
    if (!best || match.index < best.index) best = { index: match.index, label: term.label };
  }
  if (!best) return null;
  const side = SIDE_RE.exec(text.slice(Math.max(0, best.index - 24), best.index));
  return side ? `${side[1]} ${best.label}` : best.label;
}

/**
 * A short label extracted from free text — what the legacy importer stores instead
 * of the whole session note. Null when nothing recognizable is in there.
 */
export function extractSymptomAreaLabel(value: unknown): string | null {
  const label = symptomAreaVocabularyLabel(value);
  return label ? normalizeSymptomArea(label) : null;
}

/**
 * Whether this text is short enough AND specific enough to say where it hurts.
 * Relevance checks gate on this: over-long or unrecognized text matches nothing.
 */
export function isRecognizedSymptomArea(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text || text.length > SYMPTOM_AREA_MAX) return false;
  return symptomAreaVocabularyLabel(text) != null;
}

/**
 * The comparison key two reports of the same place share, so "Left Knee" and
 * "left knee" (and a legacy import that extracted "left knee") dedupe together
 * regardless of which surface wrote them.
 */
export function symptomAreaKey(value: unknown): string {
  // Scan the WHOLE text, exactly as the legacy importer does when it extracts a
  // label — otherwise a resolved symptom stored as "left knee" would not match the
  // untrimmed session note it came from, and the closed area would keep speaking.
  const label = symptomAreaVocabularyLabel(value);
  return (label ?? normalizeSymptomArea(value)).toLowerCase();
}

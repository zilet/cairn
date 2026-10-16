import { db } from "../../db.js";
import { extractSymptomAreaLabel, symptomAreaVocabularyLabels } from "../symptom-area.js";
import { painAreaLoadsExercise } from "../pain-relevance.js";

// WHERE A STATED PAIN ACTUALLY LIVES NOW.
//
// The joint-pain guard (joint_pain_or_soreness) and the baseline it is written
// against both read `sessions.joint_pain` — the old session-feedback box. Pain has
// been REPORTED IN WORDS since the mini-UIs were removed: the athlete's sentence lands
// verbatim in `symptom_reports`, and the box is no longer filled (a live audit found
// one row in four months, beside four real pain episodes). Read alone, the box made
// "no joint pain was reported" a statement about a retired instrument, so the guard
// could only ever come back `aligned` — a verdict about nothing.
//
// One reader, shared by the writer's baseline and the evaluator, so the two count the
// SAME thing: a stated pain OCCASION — one per session (or per day for a report not
// tied to a session) — from the verbatim reports and the legacy box together. A
// systemic watch (`scope='systemic'`, a report that names no place) is not joint pain
// and is left out, as it is everywhere movement relevance is read.

export interface StatedPainOccasion {
  /** One occasion per session, or per day for a report with no session. */
  key: string;
  date: string;
  session_id: number | null;
  /** The place, as stored: the watch's area label(s), else the legacy note. Null when unknown. */
  area: string | null;
  /** The athlete's own words, for area matching when no label was extracted yet. */
  text: string;
  /** When it was written down — used to keep a report made before a change off it. */
  reported_at: string | null;
}

function occasionKey(sessionId: number | null, date: string): string {
  return sessionId != null ? `session:${sessionId}` : `day:${date}`;
}

export function statedPainOccasions(start: string, end: string): StatedPainOccasion[] {
  const byKey = new Map<string, StatedPainOccasion>();
  const add = (occasion: StatedPainOccasion) => {
    const existing = byKey.get(occasion.key);
    if (!existing) {
      byKey.set(occasion.key, occasion);
      return;
    }
    // Two records of one occasion (the legacy box and a verbatim report) merge; the
    // place they name is the union, and the earliest write is when it was said.
    existing.area = [existing.area, occasion.area].filter(Boolean).join("; ") || null;
    existing.text = [existing.text, occasion.text].filter(Boolean).join(" ");
    if (occasion.reported_at && (!existing.reported_at || occasion.reported_at < existing.reported_at))
      existing.reported_at = occasion.reported_at;
  };
  try {
    const legacy = db
      .prepare(
        `SELECT id, date, joint_pain, COALESCE(finished_at, created_at) AS reported_at FROM sessions
          WHERE date BETWEEN ? AND ? AND TRIM(COALESCE(joint_pain, '')) <> ''
          ORDER BY date, id LIMIT 500`
      )
      .all(start, end) as Array<{ id: number; date: string; joint_pain: string; reported_at: string | null }>;
    for (const row of legacy) {
      add({
        key: occasionKey(Number(row.id), String(row.date)),
        date: String(row.date),
        session_id: Number(row.id),
        area: String(row.joint_pain),
        text: String(row.joint_pain),
        reported_at: row.reported_at ?? null,
      });
    }
  } catch {
    // No sessions table is no legacy pain, never an error.
  }
  try {
    const reports = db
      .prepare(
        `SELECT r.id, r.session_id, r.reported_on, r.text, r.created_at,
                (SELECT GROUP_CONCAT(e.area_text, '; ') FROM training_symptom_events e
                  WHERE (e.id = r.symptom_event_id
                         OR e.id IN (SELECT symptom_event_id FROM symptom_report_events WHERE symptom_report_id = r.id))
                    AND COALESCE(e.scope, 'area') <> 'systemic') AS area,
                (SELECT COUNT(*) FROM training_symptom_events e
                  WHERE (e.id = r.symptom_event_id
                         OR e.id IN (SELECT symptom_event_id FROM symptom_report_events WHERE symptom_report_id = r.id))) AS linked
           FROM symptom_reports r
          WHERE r.reported_on BETWEEN ? AND ?
          ORDER BY r.reported_on, r.id LIMIT 500`
      )
      .all(start, end) as Array<{
      id: number;
      session_id: number | null;
      reported_on: string;
      text: string;
      created_at: string | null;
      area: string | null;
      linked: number;
    }>;
    for (const row of reports) {
      // Linked ONLY to systemic watches: a report that names no place is not joint pain.
      if (Number(row.linked) > 0 && !row.area) continue;
      const sessionId = row.session_id == null ? null : Number(row.session_id);
      add({
        key: occasionKey(sessionId, String(row.reported_on)),
        date: String(row.reported_on),
        session_id: sessionId,
        area: row.area ? String(row.area) : null,
        text: String(row.text ?? ""),
        reported_at: row.created_at ?? null,
      });
    }
  } catch {
    // A DB without the verbatim-report tables has only the legacy box to read.
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

export type PainAttribution = "attributed" | "elsewhere" | "unknown";

// Words that say nothing about WHERE.
const NON_PLACE_WORDS = new Set([
  "right",
  "left",
  "both",
  "joint",
  "joints",
  "pain",
  "painful",
  "area",
  "side",
  "below",
  "above",
  "after",
  "feeling",
  "slight",
  "unpleasant",
  "unpleasent",
  "with",
  "from",
  "and",
  "the",
]);

function placeWords(text: string): Set<string> {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 4 && !NON_PLACE_WORDS.has(word))
  );
}

/**
 * Is this pain occasion about the expectation's subject? Three answers, because the
 * guard must be able to tell "about this" from "about somewhere else" from "can't say":
 *
 *   • no subject → every stated pain counts (the guard is about pain at all);
 *   • a MOVEMENT → the shared conservative relevance map (pain-relevance.ts) decides
 *     whether the reported place loads that lift; a place it cannot recognize is
 *     `unknown`, never silently "not this lift";
 *   • a free-text AREA → the vocabulary labels when both sides name one, else the
 *     place words they share; no recognizable overlap and no recognizable mismatch is
 *     `unknown`.
 */
export function attributePain(
  occasion: StatedPainOccasion,
  subject: { exercise: { name: string; muscle_group: string | null } | null; area: string | null }
): PainAttribution {
  if (!subject.exercise && !subject.area) return "attributed";
  const place = occasion.area || occasion.text;
  if (subject.exercise) {
    const labels = [occasion.area, occasion.text]
      .filter(Boolean)
      .flatMap((text) => String(text).split(";"))
      .map((text) => extractSymptomAreaLabel(text))
      .filter((label): label is string => !!label);
    if (!labels.length) return "unknown";
    return labels.some((label) => painAreaLoadsExercise(label, subject.exercise!)) ? "attributed" : "elsewhere";
  }
  const subjectLabels = symptomAreaVocabularyLabels(subject.area);
  const placeLabels = symptomAreaVocabularyLabels(place);
  if (subjectLabels.length && placeLabels.length) {
    if (placeLabels.some((label) => subjectLabels.includes(label))) return "attributed";
  }
  const subjectWords = placeWords(String(subject.area));
  for (const word of placeWords(place)) if (subjectWords.has(word)) return "attributed";
  return subjectLabels.length && placeLabels.length ? "elsewhere" : "unknown";
}

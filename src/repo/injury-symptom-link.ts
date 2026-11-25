import { db } from "../db.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { addDaysISO } from "./shared.js";
import { symptomAreaSpokenWord, symptomAreaVocabularyLabel, symptomAreaVocabularyLabels } from "./symptom-area.js";

// ============================================================================
// RESOLVED MEANS RESOLVED — one pain, two records.
//
// The same complaint routinely lands twice: the session note becomes a training
// symptom (the lifecycle the athlete closes with "Resolved"), and the chat turn that
// heard it files an `injury` context event for the timeline. The athlete then closes
// the one they can see — the symptom — and the injury event, which nothing ties to it,
// kept producing a protective hard constraint every morning: a flank note resolved on
// Monday was still excluding lifts and reading the day as "working around" it on
// Tuesday.
//
// This is the tie, and it is READ-SIDE on purpose. Nothing is stamped or deleted: an
// open injury event whose twin symptom the athlete resolved simply reads as resolved,
// and the day that symptom comes back (recurTrainingSymptom reopens the row) the event
// reads as open again with it. No data moves, so no migration is needed for rows that
// already exist.
//
// The link is deliberately narrow — a false tie would silently drop a real injury:
//   • the event is an `injury`, and the symptom an AREA symptom (a systemic "everything
//     feels off" names no place, so it can never stand for one),
//   • the SAME EPISODE: the symptom's onset sits within EPISODE_WINDOW_DAYS of the
//     event's start, and it was resolved on/after that start (a resolution that
//     predates the event cannot speak for it — that is a NEW episode),
//   • the SAME PLACE: no side conflict (left vs right), and either the same area
//     vocabulary label or a shared place word once the narration is stripped.
// ============================================================================

const EPISODE_WINDOW_DAYS = 3;

// Narration and severity words that say nothing about WHERE.
const NON_PLACE_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "my",
  "of",
  "in",
  "on",
  "at",
  "or",
  "to",
  "with",
  "after",
  "below",
  "above",
  "under",
  "over",
  "near",
  "around",
  "behind",
  "inside",
  "outside",
  "upper",
  "lower",
  "left",
  "right",
  "both",
  "side",
  "area",
  "region",
  "pain",
  "painful",
  "discomfort",
  "ache",
  "aching",
  "achy",
  "sore",
  "soreness",
  "tight",
  "tightness",
  "strain",
  "strained",
  "tweak",
  "tweaked",
  "niggle",
  "injury",
  "mild",
  "slight",
  "minor",
  "feeling",
  "unpleasant",
  "sharp",
  "dull",
  // Tissue words name WHAT, never WHERE: "post-run muscle soreness" and "muscle
  // soreness legs" share a word and not a place.
  "muscle",
  "muscular",
  "tendon",
  "tendinitis",
  "tendinopathy",
  "joint",
  "ligament",
  "bone",
  "nerve",
  "post",
  "run",
  "running",
]);

// A structural injury — torn, broken, sprained, a named ligament or cartilage — is
// closed on its own record (by the athlete, or after a clinician says so), never by a
// soreness symptom in the same place: "right knee soreness" resolving does not mend a
// meniscus. Read over the event's WHOLE text, detail included, because this only ever
// refuses a tie.
const STRUCTURAL_INJURY =
  /\b(?:tear|tears|torn|rupture\w*|fractur\w*|broken|sprain\w*|dislocat\w*|subluxat\w*|meniscus|menisci|acl|mcl|pcl|lcl|labrum|labral|herniat\w*|bulg\w*|stress reaction)\b/;

function sideOf(text: string): "left" | "right" | null {
  const left = /\bleft\b/.test(text);
  const right = /\bright\b/.test(text);
  if (left === right) return null; // neither, or both — no side claim to conflict with
  return left ? "left" : "right";
}

function placeWords(text: string): Set<string> {
  return new Set(
    text
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 3 && !NON_PLACE_WORDS.has(word))
      .map((word) => word.replace(/s$/, ""))
      // …and again once a plural is gone ("muscles", "tendons").
      .filter((word) => !NON_PLACE_WORDS.has(word))
  );
}

/** Whether an injury event's place text and a symptom's area label name the same place. */
export function samePlace(injuryPlace: string, symptomArea: string): boolean {
  const a = String(injuryPlace ?? "").toLowerCase();
  const b = String(symptomArea ?? "").toLowerCase();
  if (!a.trim() || !b.trim()) return false;
  const sideA = sideOf(a);
  const sideB = sideOf(b);
  if (sideA && sideB && sideA !== sideB) return false;
  // An event naming MORE places than the symptom ("knee and hip pain" vs "left knee")
  // is more than that one symptom: closing the knee must not close the hip with it.
  const placesA = symptomAreaVocabularyLabels(a);
  if (placesA.length >= 2 && placesA.length > symptomAreaVocabularyLabels(b).length) return false;
  const labelA = symptomAreaVocabularyLabel(a);
  const labelB = symptomAreaVocabularyLabel(b);
  // Two recognized places are compared by their labels alone: "upper back" and "lower
  // back" share a word and are still two places.
  if (labelA && labelB) {
    const bare = (label: string) => label.replace(/^(?:left|right|both|bilateral) /, "");
    return bare(labelA) === bare(labelB);
  }
  const wordsB = placeWords(b);
  for (const word of placeWords(a)) if (wordsB.has(word)) return true;
  return false;
}

function injuryPlaceText(ev: any): string {
  let meta: any = ev?.meta;
  if (meta == null && ev?.meta_json) {
    try {
      meta = JSON.parse(ev.meta_json);
    } catch {
      meta = null;
    }
  }
  const area = meta && typeof meta === "object" && meta.area ? String(meta.area) : "";
  // The title and the structured area — never the detail, which is narration ("dead
  // hang felt okay") and would tie the event to whatever else the sentence mentions.
  return `${ev?.title ?? ""} ${area}`;
}

function eventStart(ev: any): string | null {
  const start = String(ev?.start_date ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  const created = String(ev?.created_at ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : null;
}

export interface SymptomResolution {
  symptom_id: number;
  resolved_on: string;
}

interface ResolvedAreaSymptom {
  id: number;
  area_text: string;
  onset_on: string;
  resolved_on: string;
}

/**
 * Area symptoms resolved on/before `on` whose resolution still stands — a resolved
 * episode that came BACK (reopened as a new row carrying `recurrence:<parent id>`) no
 * longer speaks for the place while any descendant is open on `on`. Newest resolution
 * first; null when the tables cannot be read (a fresh DB mid-boot).
 */
function resolvedAreaSymptomsOn(on: string): ResolvedAreaSymptom[] | null {
  let symptoms: any[];
  let lineage: any[];
  try {
    symptoms = db
      .prepare(
        `SELECT id, area_text, onset_on, resolved_on FROM training_symptom_events
         WHERE status = 'resolved' AND resolved_on IS NOT NULL AND resolved_on <= ?
           AND scope = 'area' AND legacy_unconfirmed = 0
         ORDER BY resolved_on DESC, id DESC`
      )
      .all(on) as any[];
    lineage = db
      .prepare(
        `SELECT id, source_kind, onset_on, resolved_on FROM training_symptom_events
         WHERE source_kind LIKE 'recurrence:%'`
      )
      .all() as any[];
  } catch {
    return null; // a fresh DB mid-boot: no link is the honest answer
  }
  if (!symptoms.length) return [];
  const parentOf = new Map<number, number>();
  for (const row of lineage) {
    const parent = Number(String(row.source_kind).slice("recurrence:".length));
    if (Number.isFinite(parent)) parentOf.set(Number(row.id), parent);
  }
  const reopened = new Set<number>();
  for (const row of lineage) {
    const open = String(row.onset_on) <= on && (row.resolved_on == null || String(row.resolved_on) > on);
    if (!open) continue;
    let cursor = parentOf.get(Number(row.id));
    for (let hops = 0; cursor != null && hops < 32 && !reopened.has(cursor); hops++) {
      reopened.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  return symptoms
    .filter((symptom) => !reopened.has(Number(symptom.id)))
    .map((symptom) => ({
      id: Number(symptom.id),
      area_text: String(symptom.area_text ?? ""),
      onset_on: String(symptom.onset_on),
      resolved_on: String(symptom.resolved_on),
    }));
}

/**
 * For each OPEN injury event in `events`, the resolved training symptom (if any) that
 * closes it as of `on`. Events that are not open injuries are never in the map. One
 * query for the whole batch.
 */
export function injuriesResolvedBySymptoms(events: any[], on: string): Map<number, SymptomResolution> {
  const out = new Map<number, SymptomResolution>();
  const open = events.filter(
    (ev) =>
      ev?.kind === "injury" &&
      Number.isFinite(Number(ev?.id)) &&
      !(ev?.resolved_at && String(ev.resolved_at).slice(0, 10) <= on)
  );
  if (!open.length || !/^\d{4}-\d{2}-\d{2}$/.test(on)) return out;
  const symptoms = resolvedAreaSymptomsOn(on);
  if (!symptoms?.length) return out;
  for (const ev of open) {
    const start = eventStart(ev);
    if (!start) continue;
    const from = addDaysISO(start, -EPISODE_WINDOW_DAYS);
    const to = addDaysISO(start, EPISODE_WINDOW_DAYS);
    if (!from || !to) continue;
    if (STRUCTURAL_INJURY.test(`${ev?.title ?? ""} ${ev?.detail ?? ""} ${injuryPlaceText(ev)}`.toLowerCase())) continue;
    const place = injuryPlaceText(ev);
    const match = symptoms.find(
      (symptom) =>
        String(symptom.onset_on) >= from &&
        String(symptom.onset_on) <= to &&
        String(symptom.resolved_on) >= start &&
        samePlace(place, String(symptom.area_text ?? ""))
    );
    if (match) out.set(Number(ev.id), { symptom_id: Number(match.id), resolved_on: String(match.resolved_on) });
  }
  return out;
}

// ---- one answer for every reader ----
//
// `listContextEvents` / `getContextEvent` carry the tie on their own. Everything that
// reads `context_events` straight from SQL — the run-day pain read, the refusal
// reopen, the health drift signature, the evaluation confounders, the coach agent's
// life window, the proposal fingerprint — asks here instead of trusting a bare
// `resolved_at`, so the timeline, the Brief and the agent never disagree about one
// injury. Still read-side: the symptom's own resolution date is the event's
// effective one, and a recurrence reopens both.

/** Every open injury event closed by a resolved twin symptom as of `on`. One query; never throws. */
export function injuryClosuresOn(on: string): Map<number, SymptomResolution> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on ?? ""))) return new Map();
  try {
    const rows = db
      .prepare(
        `SELECT id, kind, title, detail, start_date, created_at, meta_json, resolved_at FROM context_events
          WHERE kind = 'injury' AND COALESCE(archived, 0) = 0
            AND (resolved_at IS NULL OR substr(resolved_at, 1, 10) > ?)`
      )
      .all(on) as any[];
    return injuriesResolvedBySymptoms(rows, on);
  } catch {
    return new Map();
  }
}

/**
 * Raw `context_events` rows with a symptom-closed injury's `resolved_at` filled in from
 * its twin symptom's resolution (and `resolved_by_symptom` naming it). Rows are copied,
 * never mutated; a row the athlete closed directly keeps its own date.
 */
export function withSymptomClosures<T extends Record<string, any>>(
  rows: T[],
  on: string,
  closures: Map<number, SymptomResolution> = injuryClosuresOn(on)
): T[] {
  if (!closures.size) return rows;
  return rows.map((row) => {
    const closure = closures.get(Number(row?.id));
    if (!closure || row?.resolved_at) return row;
    return { ...row, resolved_at: closure.resolved_on, resolved_by_symptom: closure };
  });
}

// ---- a settled place: words about a pain whose place has since resolved ----
//
// The same tie, read in the other direction. A memory the chat distilled ("acute
// right lateral flank pain triggered by a Pallof press") and a draft a conference
// wrote to protect that place ("cap the Pallof press to protect the healing right
// flank") are both WORDS ABOUT ONE EPISODE — and the athlete closes the episode on
// the symptom, never on the words. Live, a monthly conference read the memory as
// current four days after the flank settled and capped a load "to protect" it.
//
// So: text that talks about pain at a place, whose same-place symptom has resolved
// and stands resolved, and where NOTHING open — no active symptom, no injury event
// the tie leaves open — names that place, reads as HISTORY. Read-side, like the tie
// above: a recurrence reopens the symptom row (or adds an open descendant), the
// settled reading disappears with it, and the words are current again. The same
// narrow matcher decides the place (`samePlace`, side-aware, never a looser one), and
// a structural injury is never settled by a symptom.

// Words that say the text is about pain, an injury, or protecting a place from one.
const PAIN_TALK =
  /\b(?:pain\w*|hurt\w*|ach(?:e|es|ing|y)|sore\w*|discomfort|irritat\w*|injur\w*|strain\w*|tweak\w*|niggle\w*|heal\w*|protect\w*|flare\w*|twinge\w*|tender\w*)\b/;

export interface SettledPainPlace {
  symptom_id: number;
  area_text: string;
  onset_on: string;
  resolved_on: string;
  /** The place as a person would say it ("right flank"); null when nothing clean reads. */
  spoken_place: string | null;
}

export interface SettledPainReadOptions {
  /**
   * How many days AFTER the resolution the text may have been written and still be
   * about that episode. 0 for a memory (a note written after the pain settled is a
   * recap, and stays current); a few weeks for a draft, which a conference may write
   * off a stale reading after the athlete has already closed the symptom.
   */
  written_after_resolution_days?: number;
}

function spokenPlace(text: string, area: string): string | null {
  const word = symptomAreaSpokenWord(area) ?? symptomAreaSpokenWord(text);
  if (!word) return null;
  const side = sideOf(area.toLowerCase()) ?? sideOf(text.toLowerCase());
  return side && !word.startsWith(side) ? `${side} ${word}` : word;
}

/**
 * Every place something OPEN still names on `on`: active area symptoms (an unconfirmed
 * legacy row included — for "does anything open still name this place" the
 * conservative answer counts it) and injury events the symptom tie leaves open. Null
 * when the tables cannot be read.
 */
function openPainPlacesOn(on: string): string[] | null {
  try {
    const openSymptoms = db
      .prepare(
        `SELECT area_text FROM training_symptom_events
          WHERE status = 'active' AND resolved_on IS NULL AND scope = 'area' AND onset_on <= ?`
      )
      .all(on) as any[];
    const closures = injuryClosuresOn(on);
    const openInjuries = (
      db
        .prepare(
          `SELECT id, title, start_date, created_at, meta_json FROM context_events
            WHERE kind = 'injury' AND COALESCE(archived, 0) = 0
              AND (resolved_at IS NULL OR substr(resolved_at, 1, 10) > ?)`
        )
        .all(on) as any[]
    ).filter((ev) => !closures.has(Number(ev.id)) && (eventStart(ev) ?? "") <= on);
    return [
      ...openSymptoms.map((row) => String(row.area_text ?? "")),
      ...openInjuries.map((ev) => injuryPlaceText(ev)),
    ].filter((place) => place.trim());
  } catch {
    return null;
  }
}

function placeStillOpen(openPlaces: readonly string[], text: string): boolean {
  return openPlaces.some((place) => samePlace(text, place) || samePlace(place, text));
}

export interface SettledPlace {
  symptom_id: number;
  area_text: string;
  resolved_on: string;
  spoken_place: string | null;
}

/**
 * Area symptoms that settled within the last `days` days and stay settled — nothing
 * open names the place again. The "history, not current" list a planning prompt reads
 * beside the open symptoms, so an old note about the pain is never read as live.
 */
export function recentlySettledPlaces(on: string, days = 28): SettledPlace[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on ?? ""))) return [];
  const floor = addDaysISO(on, -Math.max(0, Math.trunc(days)));
  const resolved = resolvedAreaSymptomsOn(on);
  const open = openPainPlacesOn(on);
  if (!resolved?.length || open == null || !floor) return [];
  const out: SettledPlace[] = [];
  const seen = new Set<string>();
  for (const symptom of resolved) {
    if (symptom.resolved_on < floor) continue;
    if (placeStillOpen(open, symptom.area_text)) continue;
    const key = symptom.area_text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      symptom_id: symptom.id,
      area_text: symptom.area_text,
      resolved_on: symptom.resolved_on,
      spoken_place: spokenPlace("", symptom.area_text),
    });
  }
  return out;
}

// ---- the pain a change was made around: still open, settled, or not tied to one ----
//
// A plan change made around pain (a race adaptation that rested a lift for a sore knee)
// comes back on its own only once THAT pain has settled (autonomy-service.ts
// returnPainAdaptations). The same reads as above, asked of the change's own words:
//   - open: anything open — an active area symptom (a legacy unconfirmed row counts), or
//     an injury the symptom tie leaves open — names the place the words name, OR loads a
//     lift the return would bring back. The lifecycle decides, never a freshness ladder:
//     a symptom is open until the athlete closes it, however long ago they last spoke.
//   - settled: nothing is open there, and the symptom the change's provenance names (else
//     a resolved same-place symptom from the SAME episode — written no earlier than just
//     before its onset and no later than its resolution) stands resolved.
//   - untied: nothing open, and no resolved symptom the words can be tied to — absence is
//     never the evidence that closes a pain, so the caller does not treat this as settled.
// Null when a table could not be read: the caller changes nothing on it.
export type PainEpisodeState = { state: "open" } | { state: "settled"; place: SettledPainPlace } | { state: "untied" };

export function painEpisodeState(input: {
  texts: readonly string[];
  written_on: string | null;
  /** Symptom ids the change's own reason provenance names; they decide when all exist. */
  symptom_ids?: readonly number[];
  lifts: ReadonlyArray<{ name?: string | null; muscle_group?: string | null }>;
  on: string;
}): PainEpisodeState | null {
  const on = String(input.on ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return null;
  const openPlaces = openPainPlacesOn(on);
  if (openPlaces == null) return null;
  const texts = input.texts.map((t) => String(t ?? "")).filter((t) => t.trim());
  for (const place of openPlaces) {
    if (texts.some((text) => samePlace(text, place) || samePlace(place, text))) return { state: "open" };
    if (input.lifts.some((lift) => lift?.name && painAreaLoadsExercise(place, lift))) return { state: "open" };
  }
  // The change's own provenance names its symptom: that row decides, never a lookalike.
  const namedIds = [...new Set((input.symptom_ids ?? []).map(Number).filter((id) => id > 0))];
  if (namedIds.length) {
    let named: any[];
    try {
      named = db
        .prepare(
          `SELECT id, area_text, status, onset_on, resolved_on FROM training_symptom_events
            WHERE id IN (${namedIds.map(() => "?").join(", ")})`
        )
        .all(...namedIds) as any[];
    } catch {
      return null;
    }
    if (named.length === namedIds.length) {
      const stillOpen = named.some(
        (row) => String(row.status) === "active" || row.resolved_on == null || String(row.resolved_on) > on
      );
      if (stillOpen) return { state: "open" };
      const latest = [...named].sort((a, b) => String(b.resolved_on).localeCompare(String(a.resolved_on)))[0];
      return {
        state: "settled",
        place: {
          symptom_id: Number(latest.id),
          area_text: String(latest.area_text ?? ""),
          onset_on: String(latest.onset_on ?? ""),
          resolved_on: String(latest.resolved_on ?? ""),
          spoken_place: spokenPlace(texts[0] ?? "", String(latest.area_text ?? "")),
        },
      };
    }
  }
  const resolved = resolvedAreaSymptomsOn(on);
  if (resolved == null) return null;
  const writtenOn = String(input.written_on ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(writtenOn)) return { state: "untied" };
  for (const text of texts) {
    const lower = text.toLowerCase();
    if (!PAIN_TALK.test(lower) || STRUCTURAL_INJURY.test(lower)) continue;
    // The SAME episode: the change was written during it — after (just before) its onset
    // and no later than its resolution. A same-place symptom that had already settled
    // when the change was written is an earlier episode, and says nothing about this one.
    const match = resolved.find((symptom) => {
      const from = addDaysISO(symptom.onset_on, -EPISODE_WINDOW_DAYS);
      if (!from || writtenOn < from || writtenOn > symptom.resolved_on) return false;
      return samePlace(text, symptom.area_text);
    });
    if (match) {
      return {
        state: "settled",
        place: {
          symptom_id: match.id,
          area_text: match.area_text,
          onset_on: match.onset_on,
          resolved_on: match.resolved_on,
          spoken_place: spokenPlace(text, match.area_text),
        },
      };
    }
  }
  return { state: "untied" };
}

/**
 * A reader over one day's symptom/injury state: `(text, writtenOn)` answers the
 * resolved same-place symptom the text's pain talk is about, or null when the text
 * is not pain talk, names no settled place, or ANYTHING open still names that place.
 * One read of the tables per reader; never throws (a failed read answers null —
 * absence is never the evidence that closes a pain).
 */
export function settledPainPlaceReader(
  on: string
): (text: string, writtenOn: string, options?: SettledPainReadOptions) => SettledPainPlace | null {
  const none = () => null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(on ?? ""))) return none;
  const resolved = resolvedAreaSymptomsOn(on);
  if (!resolved?.length) return none;
  const openPlaces = openPainPlacesOn(on);
  if (openPlaces == null) return none;
  return (text, writtenOn, options = {}) => {
    const body = String(text ?? "");
    const lower = body.toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(writtenOn ?? "")) || !PAIN_TALK.test(lower)) return null;
    if (STRUCTURAL_INJURY.test(lower)) return null;
    // Anything open at this place — in either reading direction — keeps the words current.
    if (placeStillOpen(openPlaces, body)) return null;
    const after = Math.max(0, Math.trunc(Number(options.written_after_resolution_days) || 0));
    const match = resolved.find((symptom) => {
      // The SAME EPISODE: written no earlier than just before the onset, and no later
      // than the resolution (plus the caller's allowance).
      const from = addDaysISO(symptom.onset_on, -EPISODE_WINDOW_DAYS);
      const to = addDaysISO(symptom.resolved_on, after);
      if (!from || !to || writtenOn < from || writtenOn > to) return false;
      return samePlace(body, symptom.area_text);
    });
    if (!match) return null;
    return {
      symptom_id: match.id,
      area_text: match.area_text,
      onset_on: match.onset_on,
      resolved_on: match.resolved_on,
      spoken_place: spokenPlace(body, match.area_text),
    };
  };
}

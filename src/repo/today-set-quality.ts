// ============================================================================
// today-set-quality.ts — the plateau ladder's effort lever, handed to today's card.
//
// Composition takes the ladder's `set_quality` lifts as a PRE-COMPUTED input
// (composition-set-quality.ts, `ComposeSessionOptions.setQuality`); this is the one place
// the live Today paths (adaptive-session.ts, coachOps/training.ts) get it from.
//
// Read only on a TRAIN read (an easy or rest day takes no effort cue), once per date per
// request (request-memoized), and failing closed: anything that throws is no note, and the
// card is composed exactly as without it.
//
// COST. The ladder is not computed here. Program state's capability pass already computes
// it for its date whenever an in-plan movement holds with nothing to explain it — the only
// units the ladder gives a lever to, `set_quality` included — and keeps it beside the state
// (program-state.ts `finishedPlateauLadder`). Today's open reads program state anyway, so
// the note costs a memoized program-state read and a copy of the ladder, never a second
// ladder (a capability read plus an engine pass per holding unit). When program state did
// not compute one, no unit can be on the effort rung, and the answer is no note.
//
// CYCLE. The ladder asks the progression engine about plan lifts, and a card is composed
// from those prescriptions; so this read is refused inside a ladder read
// (`unitLadderInFlight`) and while it is itself being read, and never starts a ladder.
// ============================================================================
import { type SetQualityLifts, setQualityLiftsFromLadder } from "./composition-set-quality.js";
import { finishedPlateauLadder } from "./program-state.js";
import { requestMemo } from "./request-memo.js";
import { localDateISO } from "./shared.js";
import { currentTrainingDataVersion } from "./training-cache.js";
import { unitLadderInFlight } from "./unit-plateau.js";

let reading = 0;

/** The plan lifts whose movement's next lever is effort, for a train read on `date`; null otherwise or on any failure. */
export function todaySetQualityLifts(
  date: string | null | undefined,
  envelope: { kind?: unknown } | null | undefined
): SetQualityLifts | null {
  if (envelope?.kind !== "train") return null;
  const d = typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null;
  if (!d || reading > 0) return null;
  reading++;
  try {
    if (unitLadderInFlight()) return null;
    const lifts = requestMemo(
      `today_set_quality:${d}:${localDateISO()}:${currentTrainingDataVersion()}`,
      () => [...setQualityLiftsFromLadder(finishedPlateauLadder(d))],
      (keys) => [...keys]
    );
    return lifts.length ? new Set(lifts) : null;
  } catch {
    return null;
  } finally {
    reading--;
  }
}

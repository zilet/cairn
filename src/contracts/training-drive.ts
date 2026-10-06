// The athlete's training DRIVE, as one UI-ready read (src/repo/training-drive-read.ts).
// Served by GET /api/training-drive and MCP get_training_drive, and attached as `push`
// to the Brief (ClientDayRead) and the conductor (ClientCoachingFocus). Plain words
// only — no score, no number about the athlete beyond dates and day counts.
//
// Two layers, both the athlete's own word: the STANDING toggle (Settings, steady|push)
// and a DATED push stance on top of it ("push me until the block ends"). The stance
// always has an end date; past it the drive goes back to what it was, with no write.
//
// This module is the client-facing contract and imports nothing outside src/contracts/.

export type ClientTrainingDrive = "steady" | "push";

export interface ClientPushStance {
  since: string; // YYYY-MM-DD the athlete said it
  until: string; // YYYY-MM-DD its last day (inclusive)
  scope: "block" | "date"; // "block" = until is the active block's last day
  words: string | null; // the athlete's own sentence, verbatim
  days_left: number; // calendar days after today still covered (0 on its last day)
  decision_id: number | null; // the ledger row; POST /api/brain/decisions/:id/revert is its one-tap Undo
  line: string; // "Pushing through Oct 31, as you asked on Oct 6."
}

export interface ClientTrainingDriveHold {
  // Machine key for styling / analytics; the athlete reads `words`.
  code:
    | "quiet_day" // the day itself reads easy/rest — `words` is that read's own reason
    | "deload" // a deload / recovery week the evidence earned
    | "signal" // a fresh deciding brake on the board (named in words)
    | "soreness"
    | "underpowered"
    | "recovery_low"
    | "injury" // working around a reported injury / symptom
    | "fueling" // fueling keeps the reach in the working sets
    | "recovering_group" // the day's main lift group is still deeply recovering
    | "not_vouched" // nothing has vouched for the day yet (no rated session, recovery read, or clean stated week)
    | "stance_harm" // a day in the last three cost something: the stance's extra room waits
    | "stack_ceiling" // the run of days reached the stance's own ceiling
    | "preference" // the athlete's own priority ordering (longevity first) holds the load
    | "lift_hold"; // a lift on today's card is holding its load — `words` names it and why
  words: string;
}

export interface ClientTrainingDriveToday {
  date: string;
  // The day licenses a challenge top set and nothing has parked it (fueling, or a composed
  // card with no lift moving enough to host one).
  reaching: boolean;
  // Top sets the day licensed: 0 (no reach), 1, or 2 under a stance.
  reach_hosts: number;
  // What is holding the day back, plain words, most decisive first (≤ 4). Empty = nothing.
  holding: ClientTrainingDriveHold[];
  // The honest "why not more" sentence, or null when nothing holds the day back.
  line: string | null;
}

export interface ClientTrainingDriveRead {
  date: string;
  drive: ClientTrainingDrive; // in force on `date`
  standing: ClientTrainingDrive; // what the Settings toggle holds
  stance: ClientPushStance | null; // the dated stance covering `date`
  // A stance that has run out (said, never silently dropped).
  ended: { until: string; line: string } | null;
  // What the drive in force opens, plain words. Empty when steady.
  licenses: string[];
  // What no drive or stance ever overrides, plain words.
  never_overrides: string[];
  // What a dated push WOULD open, plain words, whatever is in force — so a steady athlete
  // reads what Push means before choosing it (Settings). Optional: an older payload has none.
  push_opens?: string[];
  // Today's answer: present only when push is in force and `date` is today or later.
  today: ClientTrainingDriveToday | null;
  // The coach's open question "want to open the throttle?" — present only while the
  // drive is steady, no floor holds the day, and the athlete has not answered it.
  // Pull, never push: it waits here (and so on the Brief and the conductor).
  offer: ClientPushOffer | null;
}

// An ASK, never a change: the log says the athlete is carrying the program with room to
// spare (src/repo/push-offer.ts). Accepting calls the same setTrainingDrive as saying it;
// "Not now" is remembered for four weeks.
export interface ClientPushOffer {
  decision_id: number; // the ledger row holding the offer and its falsifiable expectations
  offered_on: string; // YYYY-MM-DD
  evidence: string[]; // plain-words witnesses ("Bench Press and Back Squat keep stepping up on what you complete")
  line: string; // "You're carrying this well — …. Want to open the throttle for the next two weeks?"
  until: string; // YYYY-MM-DD the stance would run through if accepted today
  accept_label: string; // "Push me for two weeks"
  dismiss_label: string; // "Not now"
}

// POST /api/training-drive/offer/accept and /dismiss (MCP accept_push_offer /
// dismiss_push_offer). Always HTTP 200; a refusal is ok:false with an athlete-facing error.
export interface ClientPushOfferAnswerResponse {
  ok: boolean;
  error?: string;
  // accept: the stance's own ledger row (its one-tap Undo); dismiss: the offer's row.
  decision_id?: number | null;
  read?: ClientTrainingDriveRead;
}

// PUT /api/training-drive body (MCP set_training_drive / chat set_training_drive mirror it).
export interface ClientSetTrainingDriveBody {
  drive: ClientTrainingDrive;
  until?: string | null; // YYYY-MM-DD; with drive "push" — wins over `scope`
  scope?: "block" | "date" | null; // "block" = through the active block's last day
  words?: string | null; // the athlete's sentence, kept verbatim
}

// Always HTTP 200: a refusal arrives as ok:false with an athlete-facing `error`.
export interface ClientSetTrainingDriveResponse {
  ok: boolean;
  error?: string;
  // Plain-words notes about what was resolved ("This block ends Sunday, so the push runs through Oct 11.").
  notes?: string[];
  decision_id?: number | null;
  read?: ClientTrainingDriveRead;
}

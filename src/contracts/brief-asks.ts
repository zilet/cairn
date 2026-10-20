// The Brief's quiet questions — GET /api/today-asks, POST /api/today-asks/answer
// (`get_today_asks` / `answer_today_ask`), composed in src/domain/today/brief-asks.ts.
//
// PULL, NEVER PUSH: a question here waits on the Brief for the athlete to open it — no
// notification, no badge, no nag — and each one is asked at most ONCE:
//   - `trip_lift`: the evening before a planned lift day inside a trip, "Lifting on the
//     trip?" — yes (nothing changes) / easier (a bodyweight version for that one day) /
//     skip it (the day rests). Remembered on the trip, per day.
//   - `adaptation_return`: a race adaptation made around pain whose return went
//     unanswered comes back once, on the one day it was stamped for; left unanswered it
//     settles to keeping the adaptation (src/repo/plan-adaptation-asks.ts).
// Never a gate: every answer is optional, and the day goes on as planned without one.

export type BriefAskKind = "trip_lift" | "adaptation_return";
export type BriefAskAnswerKey = "yes" | "easier" | "skip" | "bring_back" | "keep";

export interface BriefAskAnswer {
  key: BriefAskAnswerKey;
  /** The button's words ("Easier — bodyweight"). */
  label: string;
}

export interface BriefAsk {
  /** Stable id: "trip_lift:2026-10-23", "adaptation_return:812". */
  key: string;
  kind: BriefAskKind;
  /** The question itself ("Lifting on the trip?"). */
  question: string;
  /** One calm line of context ("Friday's Lower lands on your Clearwater trip."); null with none. */
  detail: string | null;
  /** The day the question is about. */
  date: string;
  answers: BriefAskAnswer[];
}

export interface BriefAsks {
  date: string;
  asks: BriefAsk[];
}

export interface BriefAskAnswerResult {
  ok: boolean;
  key?: string;
  answer?: BriefAskAnswerKey;
  /** What happened, in a sentence the Brief can toast. */
  message?: string;
  /** Why it could not be answered (ok:false at HTTP 200, the designed failure signal). */
  error?: string;
  /** The context event a "skip it" wrote (the day held as rest). */
  event_id?: number | null;
  /** The draft an "easier" landed (a one-day adaptation), or the answered draft. */
  proposal_id?: number | null;
}

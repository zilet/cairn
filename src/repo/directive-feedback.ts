import type { DirectiveInput } from "./directives.js";
import { type MarkerContext, type OptimalZone, optimalDistance } from "./propagation-data.js";

// ---------------------------------------------------------------------------
// WHAT THE ATHLETE'S WORD ON A DIRECTIVE MEANS — the one owner of the status /
// status_at semantics. Pure and DB-free: directives.ts (the writer), directives-read.ts
// (hydration) and propagation.ts (the engine) all read the rules from here.
//
//   active,   status_at NULL — a to-do: in effect and in front of the athlete.
//   active,   status_at set  — ACKNOWLEDGED: the athlete's Done ("Got it") on a trigger
//                              that still stands. In effect for coaching, off the to-do
//                              surfaces. No extra column carries it.
//   resolved, status_at set  — the athlete's Done (feedback the engine reads).
//   dismissed,status_at set  — the athlete's Dismiss: suppress until materially worse.
//   resolved, status_at NULL — a MACHINE soft-resolve; never feedback.
// ---------------------------------------------------------------------------

// The stored stamp's width — datetime('now') or a carried-over athlete stamp.
const STATUS_STAMP_MAX = 40;

// Normalize a status_at for storage and comparison: trimmed, bounded, blank = none.
export function directiveStatusStamp(v: unknown): string | null {
  return v == null ? null : String(v).trim().slice(0, STATUS_STAMP_MAX) || null;
}

// Whether a status flip stamps status_at as the athlete's feedback. A flip back to
// ACTIVE is the athlete un-hiding a row: it is a to-do again, so it carries no stamp —
// an un-hide is not an acknowledgement.
export function statusFlipIsFeedback(nextStatus: string): boolean {
  return nextStatus !== "active";
}

type DirectiveStatusRow = { status?: unknown; status_at?: unknown };

// ACKNOWLEDGED — the athlete tapped "Got it" (Done) on a directive whose trigger still
// stands. The guidance stays IN EFFECT (status 'active', so every coaching read keeps
// seeing it); `status_at` records when they acknowledged it, which is what takes it off
// the athlete's to-do surfaces. An active row carries a status_at ONLY through that
// acknowledgement (the propagation engine re-activates a Done'd row whose reading has
// not changed; a flip back to active clears the stamp). It retires when a newer reading
// no longer calls for it, or the athlete dismisses it.
export function isAcknowledgedDirective(row: DirectiveStatusRow | null | undefined): boolean {
  return !!row && row.status === "active" && directiveStatusStamp(row.status_at) != null;
}

// A Done, whether it still sits resolved or the engine already kept it in effect as an
// acknowledged row — the same word from the athlete either way.
function isDoneFeedback(row: DirectiveStatusRow): boolean {
  return row.status === "resolved" || isAcknowledgedDirective(row);
}

// The last user feedback row the engine judges a pass against (lastDirectiveFeedback).
export interface DirectiveFeedback {
  id?: number | null;
  status?: string | null;
  status_at?: string | null;
  trigger_value?: number | string | null;
  trigger_side?: string | null;
  trigger_date?: string | null;
}

export function isWearableContext(ctx: MarkerContext | null | undefined): boolean {
  return ctx?.marker?.source === "wearable";
}

function overageForSide(value: number, zone: OptimalZone, side: MarkerContext["side"]): number {
  if (!Number.isFinite(value)) return 0;
  if (side === "low") return Math.max(0, zone.optimal[0] - value);
  if (side === "high") return Math.max(0, value - zone.optimal[1]);
  return optimalDistance(value, zone) * Math.max(zone.optimal[1] - zone.optimal[0], 1) * 3;
}

export function markerMateriallyWorse(
  feedback: Pick<DirectiveFeedback, "trigger_side" | "trigger_value"> | null,
  ctx: MarkerContext
): boolean {
  if (!feedback) return false;
  const oldSide = String(feedback.trigger_side || "unknown");
  if (oldSide !== ctx.side) return true;
  const oldValue = Number(feedback.trigger_value);
  if (!Number.isFinite(oldValue)) return true;
  const width = Math.max(ctx.zone.optimal[1] - ctx.zone.optimal[0], 1);
  const oldOver = overageForSide(oldValue, ctx.zone, ctx.side);
  const newOver = overageForSide(ctx.value, ctx.zone, ctx.side);
  const threshold = Math.max(width * 0.1, Math.abs(oldValue) * 0.05, 1);
  return newOver > oldOver + threshold;
}

// What the athlete's last word on a directive means for THIS pass.
//   suppress    — a Dismiss ("not relevant"), until the marker gets materially worse.
//   acknowledge — a Done ("got it") while the trigger still stands: the guidance stays IN
//                 EFFECT for coaching, carried as an acknowledged row (never a new to-do,
//                 never a fresh insert each pass). A lab's trigger stands until the NEXT
//                 DRAW; a wearable series "draws" every morning, so its Done holds until a
//                 materially worse week — never re-born with each sync.
//   emit        — no feedback, or news since it: a newer draw (lab) or a materially worse
//                 reading (wearable / dismissed) puts it back in front of the athlete.
// A reading back inside optimal never reaches this question: buildOffMarkers drops it,
// the pass no longer desires the directive, and the reconcile retires it.
export type FeedbackVerdict = "suppress" | "acknowledge" | "emit";

export function directiveFeedbackVerdict(feedback: DirectiveFeedback | null, ctx: MarkerContext): FeedbackVerdict {
  if (!feedback) return "emit";
  if (feedback.status === "dismissed") return markerMateriallyWorse(feedback, ctx) ? "emit" : "suppress";
  if (!isDoneFeedback(feedback)) return "emit";
  if (isWearableContext(ctx)) return markerMateriallyWorse(feedback, ctx) ? "emit" : "acknowledge";
  const oldDate = String(feedback.trigger_date || "");
  const newDate = String(ctx.marker?.latest?.date || "");
  return !newDate || oldDate === newDate ? "acknowledge" : "emit";
}

// The same question for a generic long-tail lab flag: there's no numeric optimal band
// here to judge "materially worse", so anchor on the flag side + reading date. A Dismiss
// at this same flag suppresses; a Done at this same reading stays in effect
// (acknowledged); a changed flag direction or a newer reading is news.
export function flagFeedbackVerdict(
  feedback: DirectiveFeedback | null,
  flag: string,
  latestDate: string | null | undefined
): FeedbackVerdict {
  if (!feedback) return "emit";
  const sameSide = String(feedback.trigger_side || "") === flag;
  const newDate = String(latestDate ?? "");
  const sameDate = String(feedback.trigger_date || "") === newDate;
  if (feedback.status === "dismissed" && sameSide) return "suppress";
  if (isDoneFeedback(feedback) && (sameDate || !newDate)) return "acknowledge";
  return "emit";
}

// The same question for an agent-emitted review directive: keep honoring prior feedback
// UNLESS the marker is now clearly worse than it was when last handled. A Done on the
// SAME reading stays in effect as an acknowledged row (the engine's verdict); anything
// else is suppressed. Conservative: with no resolvable context we can't prove the
// trigger still stands or a worsening, so the prior dismiss/resolve is honored.
export function reviewFeedbackVerdict(feedback: DirectiveFeedback | null, ctx: MarkerContext | null): FeedbackVerdict {
  if (!feedback) return "emit";
  if (ctx && markerMateriallyWorse(feedback, ctx)) return "emit";
  if (ctx && directiveFeedbackVerdict(feedback, ctx) === "acknowledge") return "acknowledge";
  return "suppress";
}

// Fold the verdict into a desired directive. An acknowledged one carries the athlete's
// stamp and the trigger BASELINE they acknowledged (value and side) — the baseline a later
// "materially worse" is judged against must not creep forward one wearable sync at a
// time — and no resurfaced link (it never left). Anything emitted carries NO stamp, so a
// re-opened acknowledgement (a newer draw) reads as a to-do again, linked to the feedback
// it follows.
//
// The DATE is a different fact. For a lab, an acknowledgement only ever stands on the
// same draw, so the acknowledged date IS the live one. A wearable series "draws" every
// morning, and trigger_date is what the card's "measured N ago" and the directive's
// validity read (annotateDirectiveFreshness → readingPastValidity, the fast HRV/RHR
// class) are judged on: frozen, a still-standing acknowledged HRV directive would read
// as weeks old and drop out of what the coach honors while the watch kept confirming it.
// So a wearable's date tracks the live reading; only the baseline stays put.
export function withFeedback(
  input: DirectiveInput,
  feedback: DirectiveFeedback | null,
  verdict: FeedbackVerdict,
  opts: { wearable?: boolean } = {}
): DirectiveInput {
  const series = opts.wearable ? { live_series: true } : {};
  if (verdict !== "acknowledge" || !feedback)
    return { ...input, ...series, status_at: null, resurfaced_from_id: feedback?.id ?? null };
  const frozen =
    feedback.trigger_value != null &&
    Number.isFinite(Number(feedback.trigger_value)) &&
    feedback.trigger_side &&
    feedback.trigger_date
      ? {
          trigger_value: Number(feedback.trigger_value),
          trigger_side: feedback.trigger_side,
          trigger_date: opts.wearable && input.trigger_date ? input.trigger_date : feedback.trigger_date,
        }
      : {};
  return { ...input, ...series, ...frozen, status_at: feedback.status_at, resurfaced_from_id: undefined };
}

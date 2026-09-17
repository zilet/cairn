// What happened to the last Garmin strength write-back, recorded where someone can
// actually find it.
//
// The write-back is deliberately quiet: every failure is a no-op, because the Cairn
// log is the record of truth and a PUT that didn't land costs nothing but a retry.
// That quiet had no floor, though — a PUT failing every time left one `log.warn` per
// attempt and nothing else. The athlete's Cairn history looked complete, Garmin held
// nothing, and there was no surface anywhere that could have said so.
//
// So every ATTEMPT now leaves two traces: a `diagnostic_events` row for the operator
// view, fingerprinted by error class so a repeated failure reads as one issue with a
// count rather than fifty, and a one-line status on `settings` that the PWA's sync
// surfaces can speak. Routine no-ops — the toggle off, no credentials — write neither:
// a feature that is switched off is not an outcome.
import { recordDiagnosticEvent } from "./diagnostics.js";
import { setGarminExportStatus } from "./settings.js";

export interface GarminExportOutcome {
  ok: boolean;
  skipped?: string;
  activity_id?: string;
  mode?: string;
  error?: string;
  exported_sets?: number;
  skipped_sets?: number;
  skipped_exercises?: string[];
}

/** The two skips that mean "this feature is not turned on", not "this attempt did X". */
const CONFIGURATION_SKIPS = new Set(["export_disabled", "garmin_not_configured"]);

/**
 * A bounded, low-cardinality name for WHY a write failed. The raw message is kept on
 * the event too (sanitized); this is what the fingerprint keys on, so a connector that
 * has been timing out for a day is one issue rather than one per session.
 */
export function garminExportErrorClass(message: string | null | undefined): string {
  const text = String(message ?? "");
  if (!text.trim()) return "unknown";
  if (/timed out|timeout|ETIMEDOUT/i.test(text)) return "timeout";
  if (/\b(401|403)\b|unauthoriz|forbidden|credential|login/i.test(text)) return "auth";
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return "rate_limited";
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|network/i.test(text)) return "network";
  if (/\b5\d\d\b/.test(text)) return "garmin_error";
  if (/\b4\d\d\b/.test(text)) return "rejected";
  if (/no Garmin activity|no session|returned no activity id/i.test(text)) return "no_target";
  return "unknown";
}

/** The calm one-liner the PWA reads back. Never an id, never a count of activities. */
function statusLine(outcome: GarminExportOutcome): string {
  if (!outcome.ok) return `failed: ${garminExportErrorClass(outcome.error)}`;
  if (outcome.skipped) {
    if (outcome.skipped === "unchanged") return "ok: already up to date";
    if (outcome.skipped === "garmin_owns_sets") return "ok: Garmin owns that day";
    if (outcome.skipped.startsWith("no_logged_sets") || outcome.skipped.startsWith("no_mapped_exercises"))
      return "ok: nothing to send";
    return `ok: ${outcome.skipped.replace(/_/g, " ")}`;
  }
  const exported = Number(outcome.exported_sets);
  const skipped = Number(outcome.skipped_sets);
  if (Number.isFinite(exported) && Number.isFinite(skipped) && skipped > 0) {
    return `ok: ${exported} of ${exported + skipped} sets`;
  }
  if (Number.isFinite(exported)) return `ok: ${exported} set${exported === 1 ? "" : "s"}`;
  return "ok";
}

/**
 * Record one write-back attempt. Never throws — telemetry must not be able to fail an
 * export, which already succeeded or already failed by the time we are called.
 */
export function recordGarminExportOutcome(sessionId: number, outcome: GarminExportOutcome): void {
  try {
    if (outcome.skipped && CONFIGURATION_SKIPS.has(outcome.skipped)) return;
    const errorClass = outcome.ok ? null : garminExportErrorClass(outcome.error);
    setGarminExportStatus(statusLine(outcome));
    recordDiagnosticEvent({
      source: "worker",
      kind: "garmin_export",
      level: outcome.ok ? "info" : "error",
      operation: outcome.ok ? (outcome.skipped ? `skipped:${outcome.skipped}` : (outcome.mode ?? "write")) : "write",
      fingerprint: outcome.ok
        ? `garmin_export:${outcome.skipped ? `skipped:${outcome.skipped}` : (outcome.mode ?? "write")}`
        : `garmin_export:failed:${errorClass}`,
      message: outcome.ok ? statusLine(outcome) : (outcome.error ?? "Garmin write-back failed"),
      metadata: {
        session: sessionId,
        activity: outcome.activity_id ?? null,
        exported_sets: Number.isFinite(Number(outcome.exported_sets)) ? Number(outcome.exported_sets) : null,
        skipped_sets: Number.isFinite(Number(outcome.skipped_sets)) ? Number(outcome.skipped_sets) : null,
        unmapped: outcome.skipped_exercises?.length ? outcome.skipped_exercises.join(", ") : null,
        error_class: errorClass,
      },
    });
  } catch {
    /* telemetry must never break the write-back path */
  }
}

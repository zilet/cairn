/** Shared low-cardinality privacy contract for operator telemetry. */

const ERROR_CLASSES = new Set([
  "abort_error",
  "auth_required",
  "payment_required",
  "permission_denied",
  "quota_exhausted",
  "rate_limited",
  "empty_output",
  "invalid_contract",
  "invalid_json",
  "invalid_output",
  "process_error",
  "process_exit",
  "timeout",
  "unknown_error",
]);

export function telemetryIdentifier(value: unknown, max = 80, fallback = "unknown"): string {
  const text = typeof value === "string" ? value.trim() : "";
  const safe = text.replace(/[^A-Za-z0-9_.:/-]/g, "_").slice(0, max);
  return safe || fallback;
}

/** Provider model identifiers only; reject provider-prefixed domain labels. */
export function telemetryModelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.:/-]{0,119}$/.test(model)) return null;
  const bare = model.replace(/^(?:anthropic|openai|google|xai)\//i, "");
  if (/^o[134](?:[-.:/][A-Za-z0-9][A-Za-z0-9.:/-]*)?$/i.test(bare)) return model;
  if (/^codex-mini-latest$/i.test(bare)) return model;
  return /^(?:claude|gpt|gemini|grok|codex)(?=[-.:/].*\d)[-.:/][A-Za-z0-9][A-Za-z0-9.:/-]*$/i.test(bare)
    ? model
    : null;
}

/**
 * A raw request path is UNTRUSTED input (an Express route TEMPLATE is trusted; a path
 * the caller typed is not), so it never reaches telemetry verbatim. This reduces one to
 * a bounded, low-cardinality label: the query string and fragment are dropped whole
 * (they carry values), numeric segments collapse to `:id` the way a route template
 * writes them, every remaining character is allowlisted, and the result is capped. Used
 * only for the 404 fall-through, where the operator otherwise cannot tell WHICH path missed.
 */
export function telemetryRequestPathLabel(value: unknown, max = 80): string {
  const raw = typeof value === "string" ? value : "";
  const path = raw.split("?")[0].split("#")[0].trim();
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => (/^\d+$/.test(segment) ? ":id" : segment.replace(/[^A-Za-z0-9_.:-]/g, "_")));
  if (!segments.length) return "/";
  const label = `/${segments.join("/")}`.slice(0, Math.max(1, max));
  return label.length > 1 ? label.replace(/\/+$/, "") || "/" : label;
}

export function telemetryErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  const name = String(error.name || "").trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}Error$/.test(name) || name === "Error" ? name : "Error";
}

/** V8's first lines may contain arbitrary Error.message text. Keep frames only. */
export function telemetryStackFrames(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null;
  const frames = error.stack
    .split(/\r?\n/)
    .filter((line) => /^\s*at\s+/.test(line))
    .slice(0, 20)
    .join("\n")
    .trim();
  return frames || null;
}

/** Agent errors are taxonomy-only: raw CLI output is never a telemetry input. */
export function agentErrorClass(status: unknown, errorClass: unknown): string | null {
  const raw = telemetryIdentifier(errorClass || status, 64, "unknown_error").toLowerCase();
  if (raw === "ok" || raw === "success") return null;
  if (ERROR_CLASSES.has(raw)) return raw;
  // Provider availability is read BEFORE the generic buckets: "usage limit" must
  // not be swallowed by the auth keyword, and a 402 is not a rate limit.
  if (raw.includes("quota") || raw.includes("limit_reached") || raw.includes("usage_limit") || raw.includes("weekly"))
    return "quota_exhausted";
  if (raw.includes("402") || raw.includes("payment") || raw.includes("billing") || raw.includes("credit"))
    return "payment_required";
  if (raw.includes("429") || raw.includes("rate") || raw.includes("throttle") || raw.includes("overload"))
    return "rate_limited";
  if (raw.includes("permission") || raw.includes("denied")) return "permission_denied";
  if (raw.includes("limit")) return "quota_exhausted";
  if (raw.includes("auth")) return "auth_required";
  if (raw.includes("timeout") || raw.includes("timed_out")) return "timeout";
  if (raw.includes("json")) return "invalid_json";
  if (raw.includes("output") || raw.includes("parse")) return "invalid_output";
  if (raw.includes("exit") || raw.includes("process")) return "process_error";
  if (raw.includes("abort") || raw.includes("cancel")) return "abort_error";
  return "unknown_error";
}

export function genericFailureMessage(scope: string, error: unknown): string {
  return `${telemetryErrorName(error)}: ${telemetryIdentifier(scope, 60, "operation")} failed`;
}

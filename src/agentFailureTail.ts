// What a FAILED agent CLI run said, made safe for the server log and the local
// agent_runs row.
//
// Before this existed a CLI that exited non-zero with words no classifier knew left
// nothing behind: the bubble said "Agent process exited", the log said nothing, and a
// fresh install that had just signed in could not be diagnosed. So a failed attempt now
// keeps a SHORT tail of what the CLI printed — stderr first (that is where CLIs put
// their errors), else the error the CLI reported inside its structured stdout, else
// stdout itself — single-lined and scrubbed of anything credential-shaped.
//
// This is the one sanctioned exception to "raw CLI output is never a log field"
// (src/log.ts, src/telemetry-privacy.ts): only for a run that FAILED, only its last
// FAILURE_TAIL_MAX characters, only after redactCliText. The prompt is never an input.
//
// Dependency-light on purpose (agents.ts and the repo layer both import it): the only
// import is the env denylist, itself a leaf module.
import { AGENT_ENV_DENYLIST } from "./agentExecution.js";

/** How much of a failed run's output survives into a log line or an agent_runs row. */
export const FAILURE_TAIL_MAX = 400;
/** How much of a stream's raw stdout is scanned for a structured error report. */
const STRUCTURED_SCAN_BYTES = 64 * 1024;
/** Bound on the unredacted error text kept on a result for classification only. */
const ERROR_TEXT_MAX = 4 * 1024;

/**
 * Scrub credential-shaped text: the values of Cairn's own secret env vars, bearer/basic
 * credentials, provider keys (`sk-…`, `xai-…`, `AIza…`, GitHub tokens), JWTs,
 * `token=…`-style pairs, URL query strings, emails, and long hex/base64 runs.
 * Conservative by design — a false positive costs a few characters of a log line.
 */
export function redactCliText(value: unknown): string {
  let out = String(value ?? "");
  for (const key of AGENT_ENV_DENYLIST) {
    const secret = process.env[key];
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'`]+/gi, "$1 [redacted]")
    .replace(/\b(?:sk|pk|rk|xai|gsk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(?:sk-ant|sk-proj)-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|npm)_[A-Za-z0-9_]{12,}/g, "[redacted]")
    .replace(
      /\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)[\w-]*)(["']?\s*[:=]\s*["']?)([^\s,;"'`&}]+)/gi,
      "$1$2[redacted]"
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'`]+)[?#][^\s"'`)]+/gi, "$1?[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]")
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, "[redacted]")
    .replace(/(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{48,}={0,2}/g, "[redacted]");
}

/** Collapse to one line and keep the END (a CLI's error is its last words). */
function singleLineTail(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `…${line.slice(line.length - (max - 1))}`;
}

function pickMessage(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "data"]) {
      if (typeof v[key] === "string" && String(v[key]).trim()) return String(v[key]).trim();
    }
    if (v.error && typeof v.error === "object") return pickMessage(v.error);
  }
  return null;
}

function assistantText(message: unknown): string | null {
  const content = (message as any)?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part: any) => (part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  return text || null;
}

/**
 * The error a CLI REPORTED inside its JSON/NDJSON stdout. A streamed chat run keeps
 * only assistant text deltas as `raw`, so without this claude's own error line —
 * `{"type":"result","is_error":true,"result":"There's an issue with the selected
 * model …"}` — was dropped before anything could read it. Reads the shapes the four
 * CLIs emit (claude result/assistant-error lines, `{"type":"error"}` events, agy's
 * `status:"ERROR"` envelope, `{"error":{…}}` API envelopes), plus any non-JSON line a
 * CLI printed among its JSON (a plain error banner on stdout). Never assistant prose
 * from a healthy event.
 */
export function structuredErrorText(stdout: string): string {
  const text = String(stdout ?? "");
  if (!text.trim()) return "";
  const scan = text.length > STRUCTURED_SCAN_BYTES ? text.slice(text.length - STRUCTURED_SCAN_BYTES) : text;
  const found: string[] = [];
  const plain: string[] = [];
  let sawJson = false;
  for (const line of scan.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("{")) {
      plain.push(t);
      continue;
    }
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    sawJson = true;
    if (!o || typeof o !== "object") continue;
    if (o.type === "result") {
      if (o.is_error === true || /error/i.test(String(o.subtype ?? ""))) {
        const errors = Array.isArray(o.errors) ? o.errors.map(pickMessage).filter(Boolean).join("; ") : "";
        const msg = pickMessage(o.result) ?? pickMessage(o.error) ?? (errors || null) ?? String(o.subtype ?? "");
        if (msg) found.push(msg);
      }
      continue;
    }
    if (o.type === "assistant") {
      if (o.error) {
        const msg = [pickMessage(o.error), assistantText(o.message)].filter(Boolean).join(": ");
        if (msg) found.push(msg);
      }
      continue;
    }
    if (o.type === "error" || /^error$/i.test(String(o.status ?? "")) || (o.error && !o.type)) {
      const msg = pickMessage(o.error) ?? pickMessage(o.message) ?? pickMessage(o.data) ?? pickMessage(o.response);
      if (msg) found.push(msg);
    }
  }
  // A JSON-speaking CLI that also printed plain lines: those lines are its banner.
  if (!found.length && sawJson && plain.length) found.push(...plain.slice(-4));
  const joined = found.join("\n");
  return joined.length > ERROR_TEXT_MAX ? joined.slice(joined.length - ERROR_TEXT_MAX) : joined;
}

/**
 * The redacted, single-line tail of a failed run: stderr when the CLI wrote any, else
 * the error it reported in structured stdout, else the end of stdout. Null when the
 * run printed nothing at all (itself a clue: the log line then says so).
 */
export function failureTail(
  r: { stderr?: string | null; stdout?: string | null; error_text?: string | null },
  max = FAILURE_TAIL_MAX
): string | null {
  const stderr = String(r.stderr ?? "");
  const stdout = String(r.stdout ?? "");
  const errorText = String(r.error_text ?? "");
  const source = stderr.trim() ? stderr : errorText.trim() ? errorText : stdout;
  if (!source.trim()) return null;
  // Scrub BEFORE cutting so a credential straddling the cut can't survive as a
  // fragment; only the last few KB can reach the tail, so only they are scrubbed.
  const window = source.length > 8 * 1024 ? source.slice(source.length - 8 * 1024) : source;
  const tail = singleLineTail(redactCliText(window), Math.max(16, max));
  return tail || null;
}

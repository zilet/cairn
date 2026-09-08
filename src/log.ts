/**
 * One logging path for the server.
 *
 * Cairn runs as a single process in a container, so the only sink that matters is
 * stdout/stderr and the only consumer is `docker logs` piped through grep. This is
 * therefore deliberately thin: level filtering, a stable one-line text shape, and
 * structured fields rendered as `key=value` so a line stays greppable.
 *
 * Level comes from `CAIRN_LOG_LEVEL` and is read ONCE, at module load — a level that
 * could change mid-process would make a missing line ambiguous (was it filtered, or
 * did the code path not run?). `CAIRN_LOG_JSON=1` switches the same record to one
 * line of JSON for a log shipper that wants to parse rather than grep.
 *
 * IMPORT DISCIPLINE: this module imports NOTHING from the app (no repo, no db, no
 * prompt) and never will. Everything logs, so anything it imported would become a
 * cycle the moment that module wanted to log.
 *
 * PRIVACY: log lines land in a container log an operator reads. Cairn's telemetry
 * rules apply here too — never pass a raw `Error.message`, agent output, or athlete
 * text as a field. Pass an error NAME and a scrubbed stack (see telemetry-privacy.ts).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;
export type LogFields = Record<string, unknown>;

function parseLevel(raw: string | undefined): LogLevel {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

const THRESHOLD = LEVELS[parseLevel(process.env.CAIRN_LOG_LEVEL)];
const AS_JSON = process.env.CAIRN_LOG_JSON === "1";

/** The level this process was started at. Exported for diagnostics/tests only. */
export const activeLogLevel: LogLevel = parseLevel(process.env.CAIRN_LOG_LEVEL);

/** A value is quoted only when it would otherwise break `key=value` grepping. */
function renderValue(value: unknown): string {
  if (value instanceof Error) return JSON.stringify(value.name);
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return /^[A-Za-z0-9_./:@+-]*$/.test(text) && text.length > 0 ? text : JSON.stringify(text);
}

function renderFields(fields: LogFields | undefined): string {
  if (!fields) return "";
  let out = "";
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out += ` ${key}=${renderValue(value)}`;
  }
  return out;
}

function jsonSafe(value: unknown): unknown {
  return value instanceof Error ? value.name : value;
}

// The ONE console sink for the request/scheduler/enrichment path. Everything on that
// path routes through here, so a future sink change (a file, a shipper) is a single
// edit. warn/error go to stderr via console.warn/console.error, which also keeps them
// capturable by the existing tests that stub those two functions. migrate.ts and the
// CLI entrypoints (seed.ts, demoSeed.ts, buildSeedArt.ts, garmin.ts's CLI arm) print
// directly on purpose — they are one-shot commands, not the running server process.
function emit(level: LogLevel, scope: string | undefined, message: string, fields?: LogFields): void {
  if (LEVELS[level] < THRESHOLD) return;
  let line: string;
  if (AS_JSON) {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: message };
    if (scope) record.scope = scope;
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (value !== undefined) record[key] = jsonSafe(value);
    }
    line = JSON.stringify(record);
  } else {
    const prefix = scope ? `[${scope}] ` : "";
    line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}${message}${renderFields(fields)}`;
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Whether a level would actually print — guard an expensive field computation. */
  enabled(level: LogLevel): boolean;
  /** A logger that prefixes every line with `[scope]`. */
  child(scope: string): Logger;
}

export function createLogger(scope?: string): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, fields),
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
    enabled: (level) => LEVELS[level] >= THRESHOLD,
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const log = createLogger();

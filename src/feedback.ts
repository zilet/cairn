import { randomUUID } from "node:crypto";
import { getBuildInfo } from "./build-info.js";
import { detectPlatform, updateMethodFor } from "./hosting.js";
import { getAppState, setAppState } from "./repo/app-state.js";
import { getDiagnostics } from "./repo/diagnostics.js";
import { getVersion } from "./version.js";

// In-app feedback, and the shared plumbing the opt-in usage ping (usagePing.ts) rides.
//
// Privacy contract: a feedback message carries exactly what the person typed, plus —
// ONLY when they tick "Include anonymous diagnostics" — the bounded operational
// snapshot below: version, build, platform, CPU arch, Node, and the coalesced
// diagnostic issue rows (fingerprints, kinds, route templates, counts). Diagnostics
// are taxonomy-only by construction (telemetry-privacy.ts): no health data, no chat
// text, no names, no free-text error messages. Nothing is sent on a schedule.
//
// Feedback goes to the project's feedback service (DEFAULT_FEEDBACK_URL) only when the
// person presses Send. With CAIRN_FEEDBACK_URL="" no service is configured and nothing
// leaves the instance at all: the route returns a prefilled GitHub new-issue URL and the
// person's own browser opens it.

/**
 * The project's hosted feedback service (services/feedback, deployed by the maintainer).
 * CAIRN_FEEDBACK_URL always overrides it: point it at your own deployment, or set it
 * to "" for "no service" (feedback then falls back to a prefilled GitHub issue and the
 * opt-in usage ping stays inert).
 */
export const DEFAULT_FEEDBACK_URL = "https://feedback.cairn.fit";

export const FEEDBACK_KINDS = ["bug", "idea", "praise", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTACT_MAX = 200;
export const FEEDBACK_DIAGNOSTICS_MAX_BYTES = 32 * 1024;
const FEEDBACK_TIMEOUT_MS = 10_000;
const GITHUB_REPO = "zilet/cairn";
const GITHUB_BODY_MAX = 6000;
const INSTANCE_ID_KEY = "instance_id";

type Env = Record<string, string | undefined>;

/** The feedback service base URL (no trailing slash), or null when none is configured. */
export function feedbackBaseUrl(env: Env = process.env): string | null {
  const raw = String(env.CAIRN_FEEDBACK_URL ?? DEFAULT_FEEDBACK_URL).trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** A random install id, created lazily on first use and shared by feedback and the ping. */
export function getInstanceId(): string {
  const existing = getAppState(INSTANCE_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const id = randomUUID();
  setAppState(INSTANCE_ID_KEY, id);
  return id;
}

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  contact: string | null;
  include_diagnostics: boolean;
}

/** Pure: validate a request body. A message is required; an oversize one is refused, never silently cut. */
export function parseFeedbackInput(body: unknown): { ok: true; value: FeedbackInput } | { ok: false; error: string } {
  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const kind = String(row.kind ?? "other")
    .trim()
    .toLowerCase();
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind))
    return { ok: false, error: "kind must be bug, idea, praise or other" };
  const message = typeof row.message === "string" ? row.message.trim() : "";
  if (!message) return { ok: false, error: "message is required" };
  if (message.length > FEEDBACK_MESSAGE_MAX)
    return { ok: false, error: `message is longer than ${FEEDBACK_MESSAGE_MAX} characters` };
  const contactRaw = typeof row.contact === "string" ? row.contact.trim() : "";
  if (contactRaw.length > FEEDBACK_CONTACT_MAX)
    return { ok: false, error: `contact is longer than ${FEEDBACK_CONTACT_MAX} characters` };
  return {
    ok: true,
    value: {
      kind: kind as FeedbackKind,
      message,
      contact: contactRaw || null,
      include_diagnostics: row.include_diagnostics === true,
    },
  };
}

export interface FeedbackDiagnostics {
  version: string;
  build_id: string;
  platform: string;
  update_method: string;
  arch: string;
  node: string;
  uptime_hours: number;
  window_days: number;
  issues: Array<Record<string, unknown>>;
  issues_omitted?: number;
}

/** Pure: drop issue rows from the end until the serialized snapshot fits the byte cap. */
export function boundDiagnostics(
  snapshot: FeedbackDiagnostics,
  maxBytes = FEEDBACK_DIAGNOSTICS_MAX_BYTES
): FeedbackDiagnostics {
  const out: FeedbackDiagnostics = { ...snapshot, issues: [...snapshot.issues] };
  const total = out.issues.length;
  const size = () => Buffer.byteLength(JSON.stringify(out), "utf8");
  while (out.issues.length && size() > maxBytes) {
    out.issues.pop();
    out.issues_omitted = total - out.issues.length;
  }
  return out;
}

/**
 * The anonymous operational snapshot — exactly what "Include anonymous diagnostics"
 * attaches, and what the preview shows. Issue rows keep only taxonomy fields; the
 * stored `message` is left out even though it is already scrubbed.
 */
export function feedbackDiagnostics(env: Env = process.env): FeedbackDiagnostics {
  const build = getBuildInfo();
  const platform = detectPlatform(env);
  let issues: Array<Record<string, unknown>> = [];
  try {
    issues = getDiagnostics({ days: 7, recent: 1 })
      .issues.slice(0, 40)
      .map((issue) => ({
        fingerprint: String(issue.fingerprint ?? "").slice(0, 160),
        source: issue.source,
        kind: issue.kind,
        level: issue.level,
        route: issue.route,
        status: issue.status,
        count: issue.count,
        last_seen: issue.last_seen,
      }));
  } catch {
    issues = [];
  }
  return boundDiagnostics({
    version: getVersion(),
    build_id: String(build.build_id ?? "").slice(0, 80),
    platform,
    update_method: updateMethodFor(platform, env),
    arch: process.arch,
    node: process.version,
    uptime_hours: Math.round(process.uptime() / 360) / 10,
    window_days: 7,
    issues,
  });
}

export interface FeedbackPayload {
  kind: FeedbackKind;
  message: string;
  contact?: string;
  version: string;
  platform: string;
  instance_id: string;
  diagnostics?: FeedbackDiagnostics;
}

/** Pure: the service request body. */
export function buildFeedbackPayload(
  input: FeedbackInput,
  ctx: { version: string; platform: string; instance_id: string; diagnostics?: FeedbackDiagnostics | null }
): FeedbackPayload {
  const payload: FeedbackPayload = {
    kind: input.kind,
    message: input.message.slice(0, FEEDBACK_MESSAGE_MAX),
    version: ctx.version,
    platform: ctx.platform,
    instance_id: ctx.instance_id,
  };
  if (input.contact) payload.contact = input.contact.slice(0, FEEDBACK_CONTACT_MAX);
  if (input.include_diagnostics && ctx.diagnostics) payload.diagnostics = boundDiagnostics(ctx.diagnostics);
  return payload;
}

const KIND_TITLES: Record<FeedbackKind, string> = { bug: "Bug", idea: "Idea", praise: "Praise", other: "Feedback" };

/**
 * Pure: a prefilled GitHub new-issue URL. A GitHub issue is public, so the contact
 * field is never placed in it (the person files as themselves) and the body is capped
 * so the URL stays well under what browsers and GitHub accept.
 */
export function githubIssueUrl(
  payload: Pick<FeedbackPayload, "kind" | "message" | "version" | "platform" | "diagnostics">
): string {
  const firstLine = payload.message.split(/\r?\n/).find((line) => line.trim()) || payload.message;
  const title = `${KIND_TITLES[payload.kind]}: ${firstLine.trim().slice(0, 80)}`;
  const footer = `\n\n---\nCairn ${payload.version} · ${payload.platform}`;
  let diagnostics = "";
  if (payload.diagnostics) {
    diagnostics = `\n\n<details><summary>Anonymous diagnostics</summary>\n\n\`\`\`json\n${JSON.stringify(payload.diagnostics)}\n\`\`\`\n</details>`;
  }
  let message = payload.message;
  const room = GITHUB_BODY_MAX - footer.length;
  if (message.length + diagnostics.length > room) {
    // The person's words come first; diagnostics give way before the message does.
    if (message.length > room) {
      message = `${message.slice(0, Math.max(0, room - 1))}…`;
      diagnostics = "";
    } else {
      diagnostics = message.length + 60 <= room ? "\n\n(Diagnostics were too long to include here.)" : "";
    }
  }
  const body = `${message}${diagnostics}${footer}`;
  const query = new URLSearchParams({ title, body });
  return `https://github.com/${GITHUB_REPO}/issues/new?${query.toString()}`;
}

export type SendFeedbackResult =
  | { ok: true; method: "service"; id: string | null; message: string }
  | { ok: true; method: "github"; url: string; message: string }
  | { ok: false; method: "service"; error: string; url: string };

export interface SendFeedbackOptions {
  env?: Env;
  fetch?: typeof fetch;
  instanceId?: () => string;
  diagnostics?: () => FeedbackDiagnostics;
}

/** Deliver feedback to the configured service, or hand back a GitHub issue URL. Never throws. */
export async function sendFeedback(
  input: FeedbackInput,
  options: SendFeedbackOptions = {}
): Promise<SendFeedbackResult> {
  const env = options.env ?? process.env;
  const base = feedbackBaseUrl(env);
  const diagnostics = input.include_diagnostics ? (options.diagnostics ?? (() => feedbackDiagnostics(env)))() : null;
  const instance_id = (options.instanceId ?? getInstanceId)();
  const payload = buildFeedbackPayload(input, {
    version: getVersion(),
    platform: detectPlatform(env),
    instance_id,
    diagnostics,
  });
  const fallback = githubIssueUrl(payload);
  if (!base) {
    return {
      ok: true,
      method: "github",
      url: fallback,
      message: "Opening a prefilled GitHub issue — review it there before you submit.",
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEEDBACK_TIMEOUT_MS);
  try {
    const res = await (options.fetch ?? fetch)(`${base}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "cairn-feedback" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok)
      return {
        ok: false,
        method: "service",
        error: `The feedback service answered HTTP ${res.status}.`,
        url: fallback,
      };
    let id: string | null = null;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      id = typeof body?.id === "string" || typeof body?.id === "number" ? String(body.id).slice(0, 80) : null;
    } catch {
      id = null;
    }
    return { ok: true, method: "service", id, message: "Thanks — your feedback was sent." };
  } catch (error: any) {
    const why = error?.name === "AbortError" ? "didn't answer in time" : "couldn't be reached";
    return { ok: false, method: "service", error: `The feedback service ${why}.`, url: fallback };
  } finally {
    clearTimeout(timer);
  }
}

/** What the sheet's expandable preview shows, and where a message would go. */
export function feedbackPreview(env: Env = process.env) {
  return {
    destination: feedbackBaseUrl(env) ? ("service" as const) : ("github" as const),
    diagnostics: feedbackDiagnostics(env),
  };
}

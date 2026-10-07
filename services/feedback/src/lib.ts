// Pure, dependency-free logic: validation, rate-limit policy, GitHub formatting.
// Kept free of Workers globals so `node --test` can exercise it directly.

export const KINDS = ["bug", "idea", "praise", "other"] as const;
export type Kind = (typeof KINDS)[number];

export const MAX_BODY_BYTES = 48 * 1024;
export const MAX_DIAGNOSTICS_BYTES = 32 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FeedbackInput {
  kind: Kind;
  message: string;
  contact: string | null;
  version: string;
  platform: string;
  instance_id: string;
  diagnostics: string | null; // serialized JSON
}
export interface PingInput {
  instance_id: string;
  version: string;
  platform: string;
  arch: string;
  node: string;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const err = (error: string): { ok: false; error: string } => ({ ok: false, error });

function str(o: Record<string, unknown>, k: string, min: number, max: number): Result<string> {
  const v = o[k];
  if (typeof v !== "string") return err(`${k} must be a string`);
  if (v.length < min || v.length > max) return err(`${k} must be ${min}..${max} characters`);
  return { ok: true, value: v };
}

function asObject(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function isJsonContentType(h: string | null): boolean {
  return !!h && /^application\/json\s*(;|$)/i.test(h.trim());
}

export function validateFeedback(raw: unknown): Result<FeedbackInput> {
  const o = asObject(raw);
  if (!o) return err("body must be a JSON object");
  if (typeof o.kind !== "string" || !(KINDS as readonly string[]).includes(o.kind)) {
    return err("kind must be one of bug, idea, praise, other");
  }
  const message = str(o, "message", 1, 4000);
  if (!message.ok) return message;
  if (message.value.trim().length === 0) return err("message must not be blank");
  let contact: string | null = null;
  if (o.contact !== undefined && o.contact !== null) {
    const c = str(o, "contact", 0, 200);
    if (!c.ok) return c;
    contact = c.value.trim() || null;
  }
  const version = str(o, "version", 1, 40);
  if (!version.ok) return version;
  const platform = str(o, "platform", 1, 20);
  if (!platform.ok) return platform;
  const id = str(o, "instance_id", 36, 36);
  if (!id.ok || !UUID_RE.test(id.value)) return err("instance_id must be a uuid");
  let diagnostics: string | null = null;
  if (o.diagnostics !== undefined && o.diagnostics !== null) {
    if (!asObject(o.diagnostics)) return err("diagnostics must be an object");
    const s = JSON.stringify(o.diagnostics);
    if (byteLength(s) > MAX_DIAGNOSTICS_BYTES) return err("diagnostics too large (max 32KB)");
    diagnostics = s;
  }
  return {
    ok: true,
    value: {
      kind: o.kind as Kind,
      message: message.value,
      contact,
      version: version.value,
      platform: platform.value,
      instance_id: id.value.toLowerCase(),
      diagnostics,
    },
  };
}

export function validatePing(raw: unknown): Result<PingInput> {
  const o = asObject(raw);
  if (!o) return err("body must be a JSON object");
  const id = str(o, "instance_id", 36, 36);
  if (!id.ok || !UUID_RE.test(id.value)) return err("instance_id must be a uuid");
  const out: Record<string, string> = {};
  for (const [k, max] of [
    ["version", 40],
    ["platform", 20],
    ["arch", 20],
    ["node", 20],
  ] as const) {
    const r = str(o, k, 1, max);
    if (!r.ok) return r;
    out[k] = r.value;
  }
  return {
    ok: true,
    value: {
      instance_id: id.value.toLowerCase(),
      version: out.version,
      platform: out.platform,
      arch: out.arch,
      node: out.node,
    },
  };
}

// ---- rate limiting -------------------------------------------------------

export const LIMITS = {
  feedbackPerInstanceHour: 10,
  feedbackPerIpHour: 5,
  pingPerInstanceDay: 2,
} as const;

export const hourBucket = (now: number): string => new Date(now).toISOString().slice(0, 13); // YYYY-MM-DDTHH
export const dayBucket = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** `count` is the value AFTER this request was counted. */
export const exceeds = (count: number, limit: number): boolean => count > limit;

/** Counters to bump for a request; the caller checks each against its limit. */
export function rateChecks(
  route: "feedback" | "ping",
  instanceId: string,
  ipHash: string | null,
  now: number,
): { key: string; bucket: string; limit: number }[] {
  if (route === "ping") {
    return [{ key: `ping:i:${instanceId}`, bucket: dayBucket(now), limit: LIMITS.pingPerInstanceDay }];
  }
  const checks: { key: string; bucket: string; limit: number }[] = [{ key: `fb:i:${instanceId}`, bucket: hourBucket(now), limit: LIMITS.feedbackPerInstanceHour }];
  if (ipHash) checks.push({ key: `fb:ip:${ipHash}`, bucket: hourBucket(now), limit: LIMITS.feedbackPerIpHour });
  return checks;
}

// ---- GitHub / webhook formatting ----------------------------------------

/** Defuse @mentions so user text cannot ping people. */
export const neutralize = (s: string): string => s.replace(/@(?=[A-Za-z0-9])/g, "@​");

export function issueTitle(kind: Kind, message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  const head = flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}...` : flat;
  return `[${kind}] ${neutralize(head)}`;
}

function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

export function issueBody(
  f: Pick<FeedbackInput, "kind" | "message" | "version" | "platform" | "diagnostics">,
): string {
  const lines = [
    neutralize(f.message),
    "",
    "---",
    `- **Kind:** ${f.kind}`,
    `- **Version:** ${neutralize(f.version)}`,
    `- **Platform:** ${neutralize(f.platform)}`,
  ];
  // `contact` is deliberately never rendered: it stays in the D1 row (admin API only).
  if (f.diagnostics) {
    let pretty = f.diagnostics;
    try {
      pretty = JSON.stringify(JSON.parse(f.diagnostics), null, 2);
    } catch {
      /* keep raw */
    }
    const fence = fenceFor(pretty);
    lines.push("", "<details><summary>Diagnostics</summary>", "", `${fence}json`, pretty, fence, "", "</details>");
  }
  return lines.join("\n");
}

export function issuePayload(f: FeedbackInput): { title: string; body: string; labels: string[] } {
  return { title: issueTitle(f.kind, f.message), body: issueBody(f), labels: ["feedback", f.kind] };
}

/** Generic webhook body: `text` (Slack-style) and `content` (Discord) carry the same summary. */
export function webhookPayload(id: number | string, f: FeedbackInput): Record<string, unknown> {
  const summary = `[${f.kind}] ${f.message.replace(/\s+/g, " ").slice(0, 300)} (v${f.version}, ${f.platform})`;
  return { text: summary, content: summary, id, kind: f.kind, version: f.version, platform: f.platform };
}

// ---- daily forward caps --------------------------------------------------

export const DEFAULT_FORWARD_CAP = 50;
export type ForwardChannel = "github" | "webhook";

/** Parses a cap from an env string; falls back to the default on anything but a non-negative integer. */
export function parseCap(raw: string | undefined, fallback: number = DEFAULT_FORWARD_CAP): number {
  if (raw === undefined || !/^\d{1,6}$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

/** `count` is the value AFTER this forward was counted; true while it is still within the cap. */
export const withinForwardCap = (count: number, cap: number): boolean => count <= cap;

/** Extracts the token from an `Authorization: Bearer x` header, or null. */
export function bearerToken(header: string | null): string | null {
  const m = header ? /^Bearer (.+)$/.exec(header) : null;
  return m ? m[1] : null;
}

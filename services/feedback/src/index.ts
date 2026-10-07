import {
  type FeedbackInput,
  type ForwardChannel,
  MAX_BODY_BYTES,
  bearerToken,
  byteLength,
  dayBucket,
  exceeds,
  isJsonContentType,
  issuePayload,
  parseCap,
  rateChecks,
  validateFeedback,
  validatePing,
  webhookPayload,
  withinForwardCap,
} from "./lib.ts";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  RATE_SALT?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  NOTIFY_WEBHOOK_URL?: string;
  /** Global daily caps on forwards (default 50 each). */
  GITHUB_DAILY_CAP?: string;
  WEBHOOK_DAILY_CAP?: string;
}

const DAY = 86_400_000;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const bad = (error: string, status = 400): Response => json(status, { ok: false, error });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison: compare fixed-length digests without early exit. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/** The IP is only ever used as sha256(secret|date|ip); the raw value is never stored or logged. */
async function ipHash(req: Request, env: Env, now: number): Promise<string | null> {
  const ip = req.headers.get("CF-Connecting-IP");
  if (!ip) return null;
  return (await sha256Hex(`${env.RATE_SALT ?? env.ADMIN_TOKEN ?? ""}|${dayBucket(now)}|${ip}`)).slice(0, 32);
}

/** Bump counters (D1 upsert per check); true when any limit is exceeded. */
async function limited(env: Env, checks: { key: string; bucket: string; limit: number }[]): Promise<boolean> {
  for (const c of checks) {
    const row = await env.DB.prepare(
      "INSERT INTO rate (key, bucket, n) VALUES (?1, ?2, 1) ON CONFLICT(key, bucket) DO UPDATE SET n = n + 1 RETURNING n",
    )
      .bind(c.key, c.bucket)
      .first<{ n: number }>();
    if (row && exceeds(row.n, c.limit)) return true;
  }
  return false;
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  if (!isJsonContentType(req.headers.get("content-type"))) {
    return { ok: false, res: bad("Content-Type must be application/json", 415) };
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, res: bad("body too large", 413) };
  const text = await req.text();
  if (byteLength(text) > MAX_BODY_BYTES) return { ok: false, res: bad("body too large", 413) };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, res: bad("invalid JSON") };
  }
}

/** Atomically counts one forward for today; true while the channel is still under its global daily cap. */
async function underForwardCap(env: Env, channel: ForwardChannel, cap: number): Promise<boolean> {
  const row = await env.DB.prepare(
    "INSERT INTO forward_counts (day, channel, count) VALUES (?1, ?2, 1) ON CONFLICT(day, channel) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(dayBucket(Date.now()), channel)
    .first<{ count: number }>();
  return !!row && withinForwardCap(row.count, cap);
}

/** Optional forwarding; every failure is logged and swallowed. */
async function forward(env: Env, id: number, f: FeedbackInput): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (env.GITHUB_TOKEN && env.GITHUB_REPO && (await underForwardCap(env, "github", parseCap(env.GITHUB_DAILY_CAP)))) {
    jobs.push(
      fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "user-agent": "cairn-feedback-worker",
          "content-type": "application/json",
        },
        body: JSON.stringify(issuePayload(f)),
      }).then((r) => {
        if (!r.ok) console.error(`github issue failed: ${r.status}`);
      }),
    );
  }
  if (env.NOTIFY_WEBHOOK_URL && (await underForwardCap(env, "webhook", parseCap(env.WEBHOOK_DAILY_CAP)))) {
    jobs.push(
      fetch(env.NOTIFY_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookPayload(id, f)),
      }).then((r) => {
        if (!r.ok) console.error(`webhook failed: ${r.status}`);
      }),
    );
  }
  for (const s of await Promise.allSettled(jobs)) {
    if (s.status === "rejected") console.error("forward failed", String(s.reason));
  }
}

async function admin(req: Request, env: Env, url: URL): Promise<Response> {
  const token = bearerToken(req.headers.get("authorization"));
  if (!env.ADMIN_TOKEN || !token || !(await safeEqual(token, env.ADMIN_TOKEN))) return bad("unauthorized", 401);
  const now = Date.now();
  if (url.pathname === "/v1/admin/feedback") {
    const since = Number(url.searchParams.get("since") ?? "0");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 200);
    const { results } = await env.DB.prepare(
      "SELECT id, created_at, kind, message, contact, version, platform, instance_id, diagnostics FROM feedback WHERE created_at > ?1 ORDER BY created_at DESC LIMIT ?2",
    )
      .bind(Number.isFinite(since) ? since : 0, limit)
      .all();
    return json(200, { ok: true, feedback: results });
  }
  if (url.pathname === "/v1/admin/stats") {
    const active = async (days: number) =>
      (
        await env.DB.prepare(
          "SELECT version, platform, COUNT(*) AS n FROM instances WHERE last_seen > ?1 GROUP BY version, platform ORDER BY n DESC",
        )
          .bind(now - days * DAY)
          .all()
      ).results;
    const kinds = (await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM feedback GROUP BY kind").all()).results;
    return json(200, { ok: true, active_7d: await active(7), active_30d: await active(30), feedback_by_kind: kinds });
  }
  return bad("not found", 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const now = Date.now();
    try {
      if (url.pathname === "/v1/health" && req.method === "GET") return json(200, { ok: true });
      if (url.pathname.startsWith("/v1/admin/") && req.method === "GET") return await admin(req, env, url);

      if (url.pathname === "/v1/feedback" && req.method === "POST") {
        const body = await readJson(req);
        if (!body.ok) return body.res;
        const v = validateFeedback(body.value);
        if (!v.ok) return bad(v.error);
        const f = v.value;
        if (await limited(env, rateChecks("feedback", f.instance_id, await ipHash(req, env, now), now))) {
          return bad("rate limited", 429);
        }
        const row = await env.DB.prepare(
          "INSERT INTO feedback (created_at, kind, message, contact, version, platform, instance_id, diagnostics) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) RETURNING id",
        )
          .bind(now, f.kind, f.message, f.contact, f.version, f.platform, f.instance_id, f.diagnostics)
          .first<{ id: number }>();
        const id = row?.id ?? 0;
        ctx.waitUntil(forward(env, id, f));
        return json(200, { ok: true, id });
      }

      if (url.pathname === "/v1/ping" && req.method === "POST") {
        const body = await readJson(req);
        if (!body.ok) return body.res;
        const v = validatePing(body.value);
        if (!v.ok) return bad(v.error);
        const p = v.value;
        if (await limited(env, rateChecks("ping", p.instance_id, null, now))) return bad("rate limited", 429);
        await env.DB.prepare(
          `INSERT INTO instances (instance_id, first_seen, last_seen, version, platform, arch, node)
           VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(instance_id) DO UPDATE SET last_seen = ?2, version = ?3, platform = ?4, arch = ?5, node = ?6`,
        )
          .bind(p.instance_id, now, p.version, p.platform, p.arch, p.node)
          .run();
        return new Response(null, { status: 204 });
      }

      return bad("not found", 404);
    } catch (e) {
      console.error("unhandled", e instanceof Error ? e.message : String(e));
      return bad("internal error", 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM instances WHERE last_seen < ?1").bind(now - 180 * DAY),
      env.DB.prepare("UPDATE feedback SET diagnostics = NULL WHERE diagnostics IS NOT NULL AND created_at < ?1").bind(
        now - 90 * DAY,
      ),
      env.DB.prepare("DELETE FROM rate WHERE bucket < ?1").bind(dayBucket(now - 2 * DAY)),
      env.DB.prepare("DELETE FROM forward_counts WHERE day < ?1").bind(dayBucket(now - 2 * DAY)),
    ]);
  },
};

import { Router } from "express";
import type { Request, Response } from "express";
import { authEnabled } from "../auth.js";
import { getUpdateStatus, checkForUpdate } from "../updateCheck.js";
import { applyUpdate } from "../hosting.js";
import { feedbackPreview, parseFeedbackInput, sendFeedback } from "../feedback.js";
import { getVersion } from "../version.js";
import { db } from "../db.js";
import { getBuildInfo } from "../build-info.js";
import { currentShellVersion } from "../swVersion.js";
import { passkeyCount, firstVisitHelp, neverSignedIn } from "../repo/auth-devices.js";
import { detectPlatform } from "../hosting.js";

export const systemRouter = Router();

// `shell` is the derived service-worker cache name this server hands out; Settings
// shows the one the device's worker holds, so a deploy can be checked on the phone.
// `auth_methods` is the sign-in screen's only hint, and only a boolean: whether
// offering "Sign in with passkey" can succeed at all. Never a count, never an id.
export function healthBody() {
  let passkeys = false;
  try {
    passkeys = authEnabled && passkeyCount() > 0;
  } catch {
    passkeys = false; // a liveness probe never fails on an auth-table read
  }
  // Present ONLY while nobody has ever signed in (the boot's first-sign-in condition):
  // where to find the access token. No secret, no code.
  let firstVisit: ReturnType<typeof firstVisitHelp> = null;
  try {
    firstVisit = neverSignedIn() ? firstVisitHelp({ authEnabled, platform: detectPlatform() }) : null;
  } catch {
    firstVisit = null;
  }
  return {
    ok: true,
    auth_required: authEnabled,
    auth_methods: { passkeys },
    ...(firstVisit ? { first_visit: firstVisit } : {}),
    version: getVersion(),
    build: getBuildInfo(),
    shell: currentShellVersion(),
  };
}

// Liveness only: process identity, exact build provenance and the app shell it serves.
// It deliberately does not probe optional coaching CLIs or other external providers.
systemRouter.get("/health", (_req, res) => res.json(healthBody()));

function ageSeconds(value: unknown, nowMs = Date.now()): number | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(time) ? Math.max(0, Math.round((nowMs - time) / 1_000)) : null;
}

export function schedulerReadiness(lastAt: unknown, options: { now_ms?: number; uptime_sec?: number; stale_after_sec?: number } = {}) {
  const age_sec = ageSeconds(lastAt, options.now_ms ?? Date.now());
  const staleAfter = options.stale_after_sec ?? 180;
  const status = age_sec == null
    ? ((options.uptime_sec ?? process.uptime()) < staleAfter ? "starting" : "stale")
    : (age_sec <= staleAfter ? "fresh" : "stale");
  return { status, age_sec, ok: status !== "stale" } as const;
}

export function readinessHandler(_req: Request, res: Response) {
  try {
    db.prepare("SELECT 1 AS ok").get();
    const queue = (table: "agent_jobs" | "chat_turns") => {
      const rows = db.prepare(
        `SELECT status, COUNT(*) AS count, MIN(COALESCE(started_at,created_at)) AS oldest_at
           FROM ${table} WHERE status IN ('queued','running') GROUP BY status`
      ).all() as Array<{ status: string; count: number; oldest_at: string | null }>;
      const counts = { queued: 0, running: 0, oldest_age_sec: null as number | null, failed_24h: 0 };
      for (const row of rows) {
        if (row.status === "queued" || row.status === "running") counts[row.status] = Number(row.count);
        const age = ageSeconds(row.oldest_at);
        if (age != null) counts.oldest_age_sec = Math.max(counts.oldest_age_sec ?? 0, age);
      }
      counts.failed_24h = Number(
        (db.prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE status='error' AND finished_at >= datetime('now','-1 day')`
        ).get() as any)?.n ?? 0
      );
      return counts;
    };
    const heartbeat = db.prepare(`SELECT value,updated_at FROM app_state WHERE key='scheduler_heartbeat'`).get() as any;
    const scheduler = schedulerReadiness(heartbeat?.value ?? heartbeat?.updated_at);
    const ok = scheduler.ok;
    return res.status(ok ? 200 : 503).json({
      ok,
      database: "ok",
      build: getBuildInfo(),
      queues: { agent_jobs: queue("agent_jobs"), chat_turns: queue("chat_turns") },
      scheduler: { status: scheduler.status, last_at: heartbeat?.value ?? null, age_sec: scheduler.age_sec },
    });
  } catch {
    return res.status(503).json({ ok: false, database: "unavailable" });
  }
}

// Readiness is stronger than liveness: prove SQLite is readable and expose only
// compact durable queue counts/ages/failures plus scheduler freshness and build
// provenance. Optional coaching providers never gate readiness.
systemRouter.get("/ready", readinessHandler);

// Semantic version plus exact build SHA/build id for deploy correlation.
systemRouter.get("/version", (_req, res) => res.json({ version: getVersion(), build: getBuildInfo() }));
// Cached release status; the scheduler refreshes it and POST performs an
// explicit operator-pulled check.
systemRouter.get("/update-status", (_req, res) => res.json(getUpdateStatus()));
systemRouter.post("/update-check", async (_req, res) => {
  // checkForUpdate never throws; network failures fold into status.error.
  res.json(await checkForUpdate());
});

// Start this host's update method (src/hosting.ts): POST the platform's deploy hook,
// or write the trigger file the installer's updater watches. A host that updates
// itself (Railway) or only by hand answers 409 with the sentence explaining how; a
// hook the host refused or never answered is a 502. The hook URL never leaves the
// server.
systemRouter.post("/update/apply", async (_req, res) => {
  const result = await applyUpdate();
  if (result.ok) return res.json(result);
  const manualOnly = result.method === "automatic" || result.method === "manual";
  return res.status(manualOnly ? 409 : result.method === "deploy_hook" ? 502 : 500).json(result);
});

// The anonymous diagnostics snapshot "Include anonymous diagnostics" would attach —
// exactly what the feedback sheet previews — and where a message would go.
systemRouter.get("/feedback/preview", (_req, res) => res.json(feedbackPreview()));

// Forward feedback to the configured service, or hand back a prefilled GitHub issue
// URL the browser opens instead (nothing leaves the instance without a service).
systemRouter.post("/feedback", async (req, res) => {
  const parsed = parseFeedbackInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  const result = await sendFeedback(parsed.value);
  return res.status(result.ok ? 200 : 502).json(result);
});

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { api, apiErrorHandler } from "./api.js";
import { handleMcpPost, methodNotAllowed } from "./mcp.js";
import { seedIfEmpty } from "./seed.js";
import { startScheduler } from "./scheduler.js";
import { catchUpExerciseEnrichment, recoverPendingEnrich } from "./enrich.js";
import { recoverChatTurns, abortAllTurns } from "./chatTurns.js";
import { recoverAgentJobs, abortAllJobs } from "./agentJobs.js";
import { recoverDicomImports } from "./dicomImports.js";
import { startBrainReviewJobSubscriber } from "./brainReviewJobs.js";
import { warmArt } from "./art.js";
import { maybeScheduleAgentCliAutoUpdate } from "./agentCliUpdates.js";
import { authGuard, authEnabled, requireAuth, authStartupError, rateLimitGuard, rateLimitEnabled, tokenMatches, checkRateLimit } from "./auth.js";
import { setAgentRunSink, loadAgents, invalidateAgentConfigured, warmAgentProbes } from "./agents.js";
import { startLoginSession, killActiveLoginSession } from "./agentLogin.js";
import { reportScriptCspHash } from "./report.js";
import { runWithTimeZone } from "./tz.js";
import { runWithBrainSnapshot } from "./brain/snapshot.js";
import * as repo from "./repo.js";
import { apiDiagnosticMiddleware, registerProcessDiagnosticHandlers } from "./diagnostics.js";
import { installSmokeLifetime } from "./smoke-lifetime.js";
import { jsonCompression, precompressedStatic } from "./staticCompression.js";
import { serviceWorkerScript } from "./swVersion.js";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

// Process failures share the same bounded local diagnostic sink. A rejection is
// recorded while the process stays available; an uncaught exception records and
// exits so Docker can restart the single-process service from a known state.
registerProcessDiagnosticHandlers();
installSmokeLifetime();

// Register the agent-run telemetry sink at boot, BEFORE anything can run an agent
// (recoverChatTurns / recoverAgentJobs re-enqueue work that may fire immediately).
// agents.ts can't import repo.ts (circular), so it emits through this sink; the
// scheduler also sets it, but doing it here first means early runs aren't dropped.
// recordAgentRun is itself failure-safe.
setAgentRunSink((r) => repo.recordAgentRun(r));

if (await seedIfEmpty()) {
  log.info(
    process.env.CAIRN_SEED_DEMO === "1"
      ? "Database was empty — seeded with the full-coverage demo dataset (CAIRN_SEED_DEMO=1)."
      : "Database was empty — seeded with the default plan."
  );
}

const app = express();
app.disable("x-powered-by");

function contentSecurityPolicy(pathname: string): string {
  const scriptSources = ["'self'"];
  if (pathname === "/api/health-report") scriptSources.push(reportScriptCspHash());

  return (
    "default-src 'self'; img-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; " +
    `script-src ${scriptSources.join(" ")}; connect-src 'self'; object-src 'none'; ` +
    "base-uri 'self'; frame-ancestors 'none'"
  );
}

// Conservative security headers (no extra dependency). The app shell loads
// same-origin assets only; inline style remains for dynamic UI layout/animation.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", contentSecurityPolicy(_req.path));
  next();
});

// Correlation precedes rate-limit/auth so EVERY API response carries an id.
app.use("/api", apiDiagnosticMiddleware);

// Optional rate limiting (defense in depth) — in front of auth so it also blunts
// token-guessing. No-op unless CAIRN_AUTH_TOKEN is set and CAIRN_RATE_LIMIT > 0.
app.use(rateLimitGuard);

// Optional shared-token auth (no-op unless CAIRN_AUTH_TOKEN is set).
app.use(authGuard);

// Body parsing: a tight 1mb default, with a 25mb window only on the health-doc
// upload route (base64 of a ~15MB image/PDF). Chat photo capture gets a smaller
// scoped window; every other endpoint stays at 1mb to shrink the DoS surface.
app.use("/api/health-docs", express.json({ limit: "25mb" }));
app.use("/api/chat", express.json({ limit: "8mb" }));
app.use(express.json({ limit: "1mb" }));

// "One local clock that follows the device": the PWA sends its live IANA zone as
// X-Cairn-TZ, and the rest of the request runs inside it so every "local" framing
// (the Brief's RIGHT NOW, the day a meal/activity is keyed to, log timestamps)
// follows the traveling owner WITHOUT touching the server's own TZ. Invalid /
// absent header → no override (server-local), exactly as before. Covers /api and
// /mcp (both mounted below). Logs stay UTC instants; only the framing moves.
app.use((req, _res, next) => {
  const tz = req.get("X-Cairn-TZ");
  // Remember the device's zone (cheap: writes only on change) so the scheduler's
  // boot-warm + nightly Brief precompute — which run OUTSIDE any request — compute
  // "today" in the device's calendar, not the server's. Best-effort; never blocks.
  // Best-effort: the zone is a convenience for out-of-request work (see above), so a
  // write failure must never fail the request that carried the header.
  try { repo.recordClientTimeZone(tz); } catch (err) { log.debug("[tz] could not record the client time zone", { error: err }); }
  return runWithBrainSnapshot(() => runWithTimeZone(tz, () => next()));
});

// gzip JSON bodies over ~1KB when the caller accepts it. Mounted immediately in
// front of the router so it wraps res.json for every REST route and nothing else:
// SSE streams write through res.write and are untouched.
app.use("/api", jsonCompression);

// REST API
app.use("/api", api);

// MCP over Streamable HTTP (stateless)
app.post("/mcp", handleMcpPost);
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// The service worker is SERVED, not shipped verbatim: its cache name is a content
// hash over the shell it precaches (src/swVersion.ts), so a deploy can never land
// with a stale cache version nobody remembered to bump. Mounted ahead of both
// static layers so this substituted body is the only /sw.js reachable; sw.js is
// deliberately never precompressed, so no `.br`/`.gz` sibling can shadow it.
app.get("/sw.js", serviceWorkerScript(PUBLIC_DIR));

// PWA (static). The precompressed layer goes FIRST: it hands a capable browser the
// `.br`/`.gz` sibling the build wrote, and falls through to express.static for
// everything else (no sibling, no Accept-Encoding, a range request, an icon).
app.use(precompressedStatic(PUBLIC_DIR));
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === "manifest.json") {
        // Always revalidate: an install-capable browser (Chrome/Android/desktop)
        // re-reads the manifest to refresh the home-screen icon, so a bumped icon
        // set must never be served stale from an HTTP cache. (sw.js gets the
        // same treatment one level up, from the derived-version handler above —
        // the browser's periodic/registration.update() re-fetch must see the new
        // cache name immediately, not a browser-HTTP-cached copy of the old one.)
        res.setHeader("Cache-Control", "no-cache");
      } else if (filePath.includes(`${path.sep}icons${path.sep}`) && /\.v\d+\./.test(base)) {
        // Versioned icon urls (…v2.*) are immutable — the filename changes when the
        // bytes do — so they can be cached hard. A future icon change ships under a
        // new url and is fetched fresh regardless.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

// PWA deep links. The client owns `/app/<tab>/<section>` route state; the server
// returns the app shell so copied/bookmarked links hydrate in-place. API/MCP and
// real static assets are mounted above this, so this fallback stays narrow.
app.get(/^\/app(?:\/.*)?$/, (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  // Pass the workspace path as `root` and the shell as a relative filename.
  // send's dotfile guard would otherwise reject an absolute path when Cairn is
  // checked out below a hidden directory (for example `.codex/worktrees`).
  res.sendFile("index.html", { root: PUBLIC_DIR, dotfiles: "deny" });
});

// The SAME JSON error handler the /api router ends with, registered once more at the
// app level. Body parsing and the static/deep-link layers run OUTSIDE that router, so
// a payload-too-large or malformed-JSON body would otherwise reach Express's default
// handler and answer HTML — which the PWA's api() helper cannot read.
app.use(apiErrorHandler);

// Fail closed before binding: if the operator demanded auth (CAIRN_REQUIRE_AUTH)
// but no token is set, refuse to start rather than serve an open instance.
const startupAuthError = authStartupError({ requireAuth, authEnabled });
if (startupAuthError) {
  log.error(`SECURITY: ${startupAuthError}`);
  process.exit(1);
}

const server = app.listen(PORT, HOST, () => {
  log.info(`Cairn running:`);
  log.info(`  app  -> http://${HOST}:${PORT}/`);
  log.info(`  api  -> http://${HOST}:${PORT}/api/plan`);
  log.info(`  mcp  -> http://${HOST}:${PORT}/mcp  (POST, Streamable HTTP)`);
  log.info(
    authEnabled
      ? `  auth -> CAIRN_AUTH_TOKEN set: /api and /mcp require the token`
      : `  auth -> none (set CAIRN_AUTH_TOKEN to gate /api and /mcp; keep the port private)`
  );
  if (rateLimitEnabled) log.info(`  rate -> per-IP limit active on /api and /mcp`);
  // Subscribe before any scheduler/recovery work can emit a material signal.
  // The callback only persists a bounded job and queues its async worker.
  startBrainReviewJobSubscriber();
  startScheduler();
  // v96 may have abandoned a week-1/2 auto-derived endurance-base block.
  // ensureActiveBlock is otherwise only the weekly scheduler + two routes, so
  // re-open here rather than leave the live DB with no active block for up to
  // a week. Idempotent; fail-soft so a ledger hiccup cannot block boot.
  // Gated on a non-empty plan, as the scheduler's slot is — a fresh install
  // with nothing planned does not get a block opened for it.
  try {
    const hasPlan = (repo.getPlan() as any[]).some((d) => Array.isArray(d.items) && d.items.length);
    if (hasPlan) repo.ensureActiveBlock();
  } catch (err) {
    log.error("[boot] ensureActiveBlock failed", { error: err });
  }
  maybeScheduleAgentCliAutoUpdate();
  // Probe the coaching CLIs here instead of leaving it to the first request that
  // asks for the rotation — which was the first Brief after every restart, and
  // paid several seconds of `--version` spawns for it. Staggered and best-effort.
  warmAgentProbes();
  // A stored exercise name lands its casing the moment the app is up — a legacy
  // "Dead hang" never waits for someone to notice — and every movement the athlete
  // actually trains gets its one librarian pass if it never had one.
  try {
    const { retitled } = repo.normalizeExerciseTitles();
    if (retitled.length) log.info("[boot] exercise titles normalized", { retitled });
  } catch (err) {
    log.error("[boot] normalizeExerciseTitles failed", { error: err });
  }
  // Re-process any free-text entries left 'pending' by a prior restart.
  recoverPendingEnrich();
  try {
    const queued = catchUpExerciseEnrichment();
    if (queued) log.info("[boot] exercise enrichment catch-up", { queued });
  } catch (err) {
    log.error("[boot] catchUpExerciseEnrichment failed", { error: err });
  }
  // Re-drain queued chat turns and fail any interrupted mid-flight (their actions
  // may have partially applied — see recoverChatTurns) so the thread isn't stuck.
  recoverChatTurns();
  // Same for the durable agent-job spine: re-enqueue queued ops, fail interrupted
  // ones (their coachOp may have partially persisted a draft — see recoverAgentJobs).
  recoverAgentJobs();
  // DICOM archives are durable staged jobs. A crash only resets running work to
  // queued; the serial importer re-validates the source before writing records.
  recoverDicomImports();
  // Warm the generated-art cache shortly after boot so PWA tiles have photos
  // immediately. requestArt() no-ops without a Gemini key / art_enabled.
  setTimeout(() => {
    try {
      const { queued, skipped } = warmArt();
      if (queued > 0) log.info(`[art] cache warm-up: queued ${queued}, skipped ${skipped}`);
    } catch (err) {
      log.warn("[art] cache warm-up failed", { error: err });
    }
  }, 5000);
});

// ---------- in-app agent login (PTY bridge over WebSocket) ----------
// Lets the browser drive an interactive coaching-CLI login (claude / codex /
// grok / agy) inside Cairn, rendered in an embedded terminal. The login command
// is chosen SERVER-SIDE from the agents.json allowlist; the client supplies only
// `agent` (validated) + keystrokes. See src/agentLogin.ts for the PTY session.
//
// noServer mode: we handle the HTTP upgrade ourselves and only claim our own
// path, so Express's static/route handling and any other potential upgrade are
// left untouched.
const wss = new WebSocketServer({ noServer: true });
const LOGIN_WS_PATH = "/api/agent-login/ws";

// An agent is loginable if it's a known agents.json entry with a command. (The
// presence of an interactive login flow is validated again in startLoginSession,
// which also covers the fallback-login map for agents predating Stream B's
// `login` field.)
function isKnownAgent(name: string | null | undefined): boolean {
  if (!name) return false;
  const def = loadAgents()[name];
  return !!(def && def.command);
}

server.on("upgrade", (req, socket, head) => {
  // Only claim our login path — leave every other upgrade alone (do NOT destroy
  // sockets we don't own; another handler / the default may want them).
  let url: URL;
  try {
    url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  } catch {
    return;
  }
  if (url.pathname !== LOGIN_WS_PATH) return;

  // Rate-limit the upgrade BEFORE auth (mirrors rateLimitGuard sitting in front of
  // authGuard) so a token-guessing flood on this pre-auth entry point is throttled.
  // WS upgrades bypass Express, so we apply the shared per-IP window here directly.
  const ip = req.socket.remoteAddress || "unknown";
  if (!checkRateLimit(ip).allowed) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  // Auth: mirror the rest of the app via the shared timing-safe check. WebSocket
  // can't set headers, so the token rides the query string (same pattern as the
  // chat SSE stream). No token configured = open (loopback/trusted-network model).
  const token = url.searchParams.get("token");
  if (!tokenMatches(token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const agent = url.searchParams.get("agent") || "";
  // The PTY window is fixed at spawn (see agentLogin.ts), so the client sends its
  // fitted terminal size up front; clamping happens in startLoginSession.
  const cols = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Invalid/disallowed agent: we upgraded, so signal cleanly over the socket
    // then close with a policy-violation code rather than starting a session.
    if (!isKnownAgent(agent)) {
      try {
        ws.send(JSON.stringify({ t: "error", message: "unknown agent" }));
      } catch {
        /* the peer may already be gone; the close below is what matters */
      }
      ws.close(1008, "unknown agent");
      return;
    }

    let session: { write(d: Buffer | string): void; resize(c: number, r: number): void; kill(): void } | null = null;
    try {
      session = startLoginSession({
        agent,
        cols,
        rows,
        // Raw PTY bytes → binary frames; xterm writes them verbatim.
        onData: (buf) => {
          try {
            ws.send(buf, { binary: true });
          } catch {
            /* a closed socket drops PTY output by design — ws.on("close") kills the session */
          }
        },
        onExit: (code) => {
          // The login may have just written this agent's auth state — drop the
          // cached "configured" verdict so the next /api/settings re-probes and the
          // card flips Installed → Connected without a server restart.
          try {
            invalidateAgentConfigured(agent);
          } catch (err) {
            log.warn("[agent-login] could not invalidate the cached configured verdict", { agent, error: err });
          }
          try {
            ws.send(JSON.stringify({ t: "exit", code }));
          } catch {
            /* peer already gone — nothing to tell it */
          }
          ws.close();
        },
        onError: (err) => {
          log.warn("[agent-login] session error", { agent });
          try {
            ws.send(JSON.stringify({ t: "error", message: String(err?.message || err) }));
          } catch {
            /* peer already gone — nothing to tell it */
          }
          ws.close();
        },
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // A second concurrent connect hits the single-session guard.
      if (msg.startsWith("BUSY")) {
        try {
          ws.send(JSON.stringify({ t: "busy" }));
        } catch {
          /* peer already gone — nothing to tell it */
        }
      } else {
        log.warn("[agent-login] could not start the login session", { agent });
        try {
          ws.send(JSON.stringify({ t: "error", message: msg }));
        } catch {
          /* peer already gone — nothing to tell it */
        }
      }
      ws.close();
      return;
    }

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      const s = session;
      if (!s) return;
      // A text frame starting with "{" is a control message (resize). Anything
      // else is keystrokes → straight to the PTY stdin.
      if (!isBinary) {
        const str = data.toString("utf8");
        const trimmed = str.trimStart();
        if (trimmed.startsWith("{")) {
          try {
            const msg = JSON.parse(trimmed);
            if (msg && msg.t === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              s.resize(Number(msg.cols), Number(msg.rows));
              return;
            }
          } catch {
            /* not JSON — fall through and treat as keystrokes */
          }
        }
        s.write(str);
        return;
      }
      s.write(data);
    });

    // Socket closed (Cancel / navigate away / network drop) → guaranteed SIGKILL
    // of the login subprocess (no orphan `script`/CLI process).
    ws.on("close", () => {
      try {
        session?.kill();
      } catch {
        /* already dead is the outcome we wanted */
      }
    });
    ws.on("error", () => {
      try {
        session?.kill();
      } catch {
        /* already dead is the outcome we wanted */
      }
    });
  });
});

// ---------- graceful shutdown ----------
// `docker compose down` / a redeploy sends SIGTERM (Ctrl-C sends SIGINT). Close
// the HTTP listener so no new connections land, abort any in-flight agent CLI
// subprocess (chat turns + agent jobs) so a redeploy stops cleanly instead of
// orphaning them, then exit. Every turn/job is also durable in SQLite, so a
// half-finished one is recovered on the next boot (recoverChatTurns /
// recoverAgentJobs) — the abort just makes the stop immediate and tidy. A short
// watchdog forces exit if `server.close` ever hangs on a lingering keep-alive.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return; // a second signal during teardown — let the watchdog handle it
  shuttingDown = true;
  log.info(`[server] ${signal} received — shutting down cleanly.`);
  const force = setTimeout(() => {
    log.warn("[server] shutdown timed out — forcing exit.");
    process.exit(0);
  }, 8000);
  force.unref?.();
  try { abortAllTurns(); abortAllJobs(); killActiveLoginSession(); } catch { /* best effort */ }
  try {
    server.close(() => {
      clearTimeout(force);
      log.info("[server] HTTP server closed.");
      process.exit(0);
    });
  } catch {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { api } from "./api.js";
import { handleMcpPost, methodNotAllowed } from "./mcp.js";
import { seedIfEmpty } from "./seed.js";
import { startScheduler } from "./scheduler.js";
import { recoverPendingEnrich } from "./enrich.js";
import { recoverChatTurns, abortAllTurns } from "./chatTurns.js";
import { recoverAgentJobs, abortAllJobs } from "./agentJobs.js";
import { warmArt } from "./art.js";
import { maybeScheduleAgentCliAutoUpdate } from "./agentCliUpdates.js";
import { authGuard, authEnabled, rateLimitGuard, rateLimitEnabled, tokenMatches, checkRateLimit } from "./auth.js";
import { setAgentRunSink, loadAgents, invalidateAgentConfigured } from "./agents.js";
import { startLoginSession, killActiveLoginSession } from "./agentLogin.js";
import * as repo from "./repo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

// Process safety net: a single stray rejection or thrown error from any of the
// four surfaces (PWA / API / MCP / scheduler) running in this one process must
// NOT take the whole server down. LOG and keep serving — calm degradation over a
// hard crash. (Truly fatal states — OOM, etc. — still terminate via the runtime.)
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection (kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException (kept alive):", err);
});

// Register the agent-run telemetry sink at boot, BEFORE anything can run an agent
// (recoverChatTurns / recoverAgentJobs re-enqueue work that may fire immediately).
// agents.ts can't import repo.ts (circular), so it emits through this sink; the
// scheduler also sets it, but doing it here first means early runs aren't dropped.
// recordAgentRun is itself failure-safe.
setAgentRunSink((r) => repo.recordAgentRun(r));

if (seedIfEmpty()) console.log("Database was empty — seeded with the default plan.");

const app = express();
app.disable("x-powered-by");

// Conservative security headers (no extra dependency). The PWA only loads its
// own same-origin assets and inline styles/handlers, so a tight CSP is safe.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; " +
      // The Atelier type system (Fraunces + Schibsted Grotesk) loads from the Google
      // Fonts CDN — the stylesheet from fonts.googleapis.com, the font files from
      // fonts.gstatic.com. Without these the display type silently falls back to
      // system fonts on a cold (uncached) client. This is the canonical Google Fonts CSP.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; " +
      "base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});

// Optional rate limiting (defense in depth) — in front of auth so it also blunts
// token-guessing. No-op unless CAIRN_AUTH_TOKEN is set and CAIRN_RATE_LIMIT > 0.
app.use(rateLimitGuard);

// Optional shared-token auth (no-op unless CAIRN_AUTH_TOKEN is set).
app.use(authGuard);

// Body parsing: a tight 1mb default, with a 25mb window only on the health-doc
// upload route (base64 of a ~15MB image/PDF). Keeping the large limit off every
// other endpoint shrinks the unauthenticated-DoS surface.
app.use("/api/health-docs", express.json({ limit: "25mb" }));
app.use(express.json({ limit: "1mb" }));

// REST API
app.use("/api", api);

// MCP over Streamable HTTP (stateless)
app.post("/mcp", handleMcpPost);
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// PWA (static)
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === "manifest.json") {
        // Always revalidate: an install-capable browser (Chrome/Android/desktop)
        // re-reads the manifest to refresh the home-screen icon, so a bumped icon
        // set must never be served stale from an HTTP cache.
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

const server = app.listen(PORT, HOST, () => {
  console.log(`Cairn running:`);
  console.log(`  app  -> http://${HOST}:${PORT}/`);
  console.log(`  api  -> http://${HOST}:${PORT}/api/plan`);
  console.log(`  mcp  -> http://${HOST}:${PORT}/mcp  (POST, Streamable HTTP)`);
  console.log(
    authEnabled
      ? `  auth -> CAIRN_AUTH_TOKEN set: /api and /mcp require the token`
      : `  auth -> none (set CAIRN_AUTH_TOKEN to gate /api and /mcp; keep the port private)`
  );
  if (rateLimitEnabled) console.log(`  rate -> per-IP limit active on /api and /mcp`);
  startScheduler();
  maybeScheduleAgentCliAutoUpdate();
  // Re-process any free-text entries left 'pending' by a prior restart.
  recoverPendingEnrich();
  // Re-drain queued chat turns and fail any interrupted mid-flight (their actions
  // may have partially applied — see recoverChatTurns) so the thread isn't stuck.
  recoverChatTurns();
  // Same for the durable agent-job spine: re-enqueue queued ops, fail interrupted
  // ones (their coachOp may have partially persisted a draft — see recoverAgentJobs).
  recoverAgentJobs();
  // Warm the generated-art cache shortly after boot so PWA tiles have photos
  // immediately. requestArt() no-ops without a Gemini key / art_enabled.
  setTimeout(() => {
    try {
      const { queued, skipped } = warmArt();
      if (queued > 0) console.log(`[art] cache warm-up: queued ${queued}, skipped ${skipped}`);
    } catch {}
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

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Invalid/disallowed agent: we upgraded, so signal cleanly over the socket
    // then close with a policy-violation code rather than starting a session.
    if (!isKnownAgent(agent)) {
      try {
        ws.send(JSON.stringify({ t: "error", message: "unknown agent" }));
      } catch {}
      ws.close(1008, "unknown agent");
      return;
    }

    let session: { write(d: Buffer | string): void; resize(c: number, r: number): void; kill(): void } | null = null;
    try {
      session = startLoginSession({
        agent,
        // Raw PTY bytes → binary frames; xterm writes them verbatim.
        onData: (buf) => {
          try {
            ws.send(buf, { binary: true });
          } catch {}
        },
        onExit: (code) => {
          // The login may have just written this agent's auth state — drop the
          // cached "configured" verdict so the next /api/settings re-probes and the
          // card flips Installed → Connected without a server restart.
          try {
            invalidateAgentConfigured(agent);
          } catch {}
          try {
            ws.send(JSON.stringify({ t: "exit", code }));
          } catch {}
          ws.close();
        },
        onError: (err) => {
          try {
            ws.send(JSON.stringify({ t: "error", message: String(err?.message || err) }));
          } catch {}
          ws.close();
        },
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // A second concurrent connect hits the single-session guard.
      if (msg.startsWith("BUSY")) {
        try {
          ws.send(JSON.stringify({ t: "busy" }));
        } catch {}
      } else {
        try {
          ws.send(JSON.stringify({ t: "error", message: msg }));
        } catch {}
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
      } catch {}
    });
    ws.on("error", () => {
      try {
        session?.kill();
      } catch {}
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
  console.log(`[server] ${signal} received — shutting down cleanly.`);
  const force = setTimeout(() => {
    console.warn("[server] shutdown timed out — forcing exit.");
    process.exit(0);
  }, 8000);
  force.unref?.();
  try { abortAllTurns(); abortAllJobs(); killActiveLoginSession(); } catch { /* best effort */ }
  try {
    server.close(() => {
      clearTimeout(force);
      console.log("[server] HTTP server closed.");
      process.exit(0);
    });
  } catch {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

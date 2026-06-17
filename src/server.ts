import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./api.js";
import { handleMcpPost, methodNotAllowed } from "./mcp.js";
import { seedIfEmpty } from "./seed.js";
import { startScheduler } from "./scheduler.js";
import { recoverPendingEnrich } from "./enrich.js";
import { recoverChatTurns, abortAllTurns } from "./chatTurns.js";
import { recoverAgentJobs, abortAllJobs } from "./agentJobs.js";
import { warmArt } from "./art.js";
import { maybeScheduleAgentCliAutoUpdate } from "./agentCliUpdates.js";
import { authGuard, authEnabled, rateLimitGuard, rateLimitEnabled } from "./auth.js";
import { setAgentRunSink } from "./agents.js";
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
app.use(express.static(path.join(__dirname, "..", "public")));

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
  try { abortAllTurns(); abortAllJobs(); } catch { /* best effort */ }
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

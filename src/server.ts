import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./api.js";
import { handleMcpPost, methodNotAllowed } from "./mcp.js";
import { seedIfEmpty } from "./seed.js";
import { startScheduler } from "./scheduler.js";
import { recoverPendingEnrich } from "./enrich.js";
import { recoverChatTurns } from "./chatTurns.js";
import { recoverAgentJobs } from "./agentJobs.js";
import { warmArt } from "./art.js";
import { maybeScheduleAgentCliAutoUpdate } from "./agentCliUpdates.js";
import { authGuard, authEnabled } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

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
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; " +
      "base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});

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

app.listen(PORT, HOST, () => {
  console.log(`Cairn running:`);
  console.log(`  app  -> http://${HOST}:${PORT}/`);
  console.log(`  api  -> http://${HOST}:${PORT}/api/plan`);
  console.log(`  mcp  -> http://${HOST}:${PORT}/mcp  (POST, Streamable HTTP)`);
  console.log(
    authEnabled
      ? `  auth -> CAIRN_AUTH_TOKEN set: /api and /mcp require the token`
      : `  auth -> none (set CAIRN_AUTH_TOKEN to gate /api and /mcp; keep the port private)`
  );
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

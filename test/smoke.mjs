// Lightweight HTTP smoke test for Cairn's REST surface.
//
// Boots the BUILT server (dist/server.js) against throwaway temp DBs — the same
// DATA_DIR / DB_PATH isolation `test/run.mjs` uses, so it never touches the real
// data/cairn.db — waits for GET /api/health, then drives a few key flows end to
// end over HTTP with the built-in fetch (no browser, no extra dependency, no
// network beyond loopback). It exercises the API/PWA contract the offline unit
// tests don't: the deterministic day-read, plan CRUD, set logging, export, and
// CAIRN_AUTH_TOKEN runtime behavior.
//
// Deliberately kept OUT of `npm test` (which must stay deterministic/offline/fast
// and not spawn a server). Run it with `npm run smoke` — the `presmoke` script
// builds dist/ first, exactly like `pretest` does for the unit suite.
//
// Agent: the `stub` backend is configured but no flow here needs it — every
// asserted endpoint is deterministic and agent-independent (today-read falls back
// to its deterministic floor when no agent is reachable), so the smoke run stays
// offline. Exits non-zero on the first failed assertion or a boot timeout.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverEntry = path.join(root, "dist", "server.js");

// Use a random high loopback port by default so smoke can run beside a dev
// server or another smoke run. Avoid a pre-bind "find free port" probe: some
// sandboxes deny listen(0), while the server under test can still bind a normal
// explicit port. SMOKE_PORT stays available for deterministic debugging.
const requestedPort = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : 0;
const usedPorts = new Set();
const AUTH_TOKEN = "cairn-smoke-auth-token";

let passed = 0;
function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    throw new Error(`assertion failed: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function pickPort(offset = 0, attempt = 0) {
  if (requestedPort) {
    const port = requestedPort + offset + attempt;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid SMOKE_PORT-derived port: ${port}`);
    }
    return port;
  }
  for (let i = 0; i < 100; i++) {
    const port = 18000 + Math.floor(Math.random() * 10000);
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error("could not choose a unique smoke port");
}

async function getJson(base, p, init) {
  const res = await fetch(`${base}${p}`, init);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// Poll GET /api/health until the server is listening (or give up).
async function waitForHealth(ctx, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = ctx.serverLog();
    if (/EADDRINUSE|EACCES/.test(log)) return { ok: false, retryable: true };
    if (log.includes("Cairn running:")) {
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true };
    }
    try {
      const res = await fetch(`${ctx.base}/api/health`);
      if (res.ok) return { ok: true };
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, retryable: false };
}

async function stopServer(ctx) {
  try {
    if (ctx.child.exitCode == null && ctx.child.signalCode == null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        ctx.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        ctx.child.kill("SIGKILL");
      });
    }
  } finally {
    try { rmSync(ctx.dir, { recursive: true, force: true }); } catch {}
  }
}

async function startBuiltServer({ label, authToken = "", portOffset = 0 }) {
  let lastLog = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = pickPort(portOffset, attempt);
    const base = `http://127.0.0.1:${port}`;
    // Fresh, empty temp DB per server — boots through the full migration ladder
    // and gets auto-seeded with the default plan by seedIfEmpty() at startup.
    const dir = mkdtempSync(path.join(tmpdir(), `cairn-smoke-${label}-`));
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dir,
      DB_PATH: path.join(dir, "cairn-smoke.db"),
      // Auth is explicit per smoke pass. Rate limiting is off so auth-gate
      // assertions cannot be masked by per-IP fixed-window state.
      CAIRN_AUTH_TOKEN: authToken,
      CAIRN_RATE_LIMIT: "0",
      GEMINI_API_KEY: "",
      GOOGLE_AI_KEY: "",
      GARMIN_USERNAME: "",
      GARMIN_PASSWORD: "",
      // Keep the scheduler quiet during the short-lived smoke boot.
      COACH_ENABLED: "0",
    };

    const child = spawn(process.execPath, [serverEntry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });

    let serverLog = "";
    child.stdout.on("data", (d) => { serverLog += d.toString(); });
    child.stderr.on("data", (d) => { serverLog += d.toString(); });

    const ctx = { label, port, base, dir, child, serverLog: () => serverLog };
    const ready = await waitForHealth(ctx);
    if (ready.ok) return ctx;

    lastLog = serverLog;
    await stopServer(ctx);
    if (!ready.retryable) break;
  }

  const tail = lastLog.trim() ? `\n--- server output (tail) ---\n${lastLog.split("\n").slice(-20).join("\n")}` : "";
  throw new Error(`${label} server did not become healthy within the timeout${tail}`);
}

async function withServer(opts, fn) {
  const ctx = await startBuiltServer(opts);
  try {
    console.log(`Cairn smoke: ${ctx.label} server up on ${ctx.base} (temp DB at ${ctx.dir})`);
    await fn(ctx);
  } catch (e) {
    e.serverLog = ctx.serverLog();
    throw e;
  } finally {
    await stopServer(ctx);
  }
}

async function runOpenSmoke(ctx) {
  const base = ctx.base;
  // 1) Health — the readiness gate and a basic shape check.
  {
    const { status, body } = await getJson(base, "/api/health");
    ok(status === 200, "GET /api/health → 200", `got ${status}`);
    ok(body && body.ok === true, "health body has ok:true", JSON.stringify(body));
    ok(body && "auth_required" in body, "health reports auth_required", JSON.stringify(body));
  }

  // 2) The Brief — the deterministic day-read always returns a REAL read, even
  //    with no agent reachable (it falls back to the deterministic floor).
  {
    const { status, body } = await getJson(base, "/api/today-read");
    ok(status === 200, "GET /api/today-read → 200", `got ${status}`);
    ok(body && ["train", "easy", "rest"].includes(body.kind), "day-read has a valid kind", JSON.stringify(body?.kind));
    ok(body && typeof body.headline === "string" && body.headline.length > 0, "day-read has a headline", JSON.stringify(body?.headline));
  }

  // 3) Plan — the server auto-seeds 5 default days; confirm they're listed.
  {
    const { status, body } = await getJson(base, "/api/plan");
    ok(status === 200, "GET /api/plan → 200", `got ${status}`);
    ok(Array.isArray(body) && body.length > 0, "plan lists seeded days", `len ${body?.length}`);
  }

  // 4) Settings metadata — the Settings route controls are server-owned metadata,
  //    not duplicated labels in the PWA.
  {
    const { status, body } = await getJson(base, "/api/settings");
    ok(status === 200, "GET /api/settings → 200", `got ${status}`);
    ok(body && body.settings && body.agents, "settings returns settings + agents", JSON.stringify(Object.keys(body || {})));
    const routeTasks = body?.route_tasks || [];
    ok(Array.isArray(routeTasks) && routeTasks.some((r) => r.key === "health_synthesis" && r.label), "settings returns route task metadata", JSON.stringify(routeTasks));
  }

  // 5) Static PWA split asset — route-list helper loads as a standalone cached file.
  {
    const res = await fetch(`${base}/js/settings-routes.js`);
    ok(res.status === 200, "GET /js/settings-routes.js → 200", `got ${res.status}`);
    const text = await res.text();
    ok(/settingsRouteTasks/.test(text) && /settingsRouteRowsHtml/.test(text), "settings route helper exposes expected functions");
  }

  // 6) Create a plan day end-to-end (PUT /plan/:day), then read it back. Uses a
  //    high day_number so it never clobbers a seeded day.
  const smokeDay = 91;
  {
    const put = await getJson(base, `/api/plan/${smokeDay}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Smoke Day",
        focus: "smoke",
        items: [{ exercise: "Smoke Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 }],
      }),
    });
    ok(put.status === 200, "PUT /api/plan/91 → 200", `got ${put.status}`);
    ok(put.body && put.body.day_number === smokeDay, "created day echoes day_number", JSON.stringify(put.body?.day_number));
    ok(Array.isArray(put.body?.items) && put.body.items.some((i) => i.exercise === "Smoke Squat"), "created day has the item", JSON.stringify(put.body?.items));

    const get = await getJson(base, `/api/plan/${smokeDay}`);
    ok(get.status === 200 && get.body?.name === "Smoke Day", "GET /api/plan/91 reads it back", JSON.stringify(get.body?.name));
  }

  // 7) Log a set, then read it back via the session-by-date lookup. Asserts the
  //    logged_set round-trips with the right exercise/weight/reps and est-1RM.
  const today = new Date().toISOString().slice(0, 10);
  {
    const post = await getJson(base, "/api/sets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exercise: "Smoke Squat", weight: 135, reps: 5, date: today }),
    });
    ok(post.status === 200, "POST /api/sets → 200", `got ${post.status}`);
    ok(post.body && post.body.exercise === "Smoke Squat" && post.body.weight === 135 && post.body.reps === 5, "logged set echoes its fields", JSON.stringify(post.body));
    ok(post.body && typeof post.body.est_1rm === "number" && post.body.est_1rm > 135, "logged set computes est-1RM (Epley)", JSON.stringify(post.body?.est_1rm));

    const session = await getJson(base, `/api/sessions?date=${today}`);
    ok(session.status === 200 && session.body, "GET /api/sessions?date= returns a session", JSON.stringify(session.body?.id));
    const sets = session.body?.sets || [];
    ok(sets.some((s) => s.exercise === "Smoke Squat" && s.reps === 5), "the logged set is in today's session", JSON.stringify(sets));
  }

  // 8) Export — the JSON backup the whole DB serializes to.
  {
    const res = await fetch(`${base}/api/export`);
    ok(res.status === 200, "GET /api/export → 200", `got ${res.status}`);
    const data = await res.json();
    ok(data && typeof data === "object" && "exported_at" in data, "export has exported_at", JSON.stringify(Object.keys(data || {}).slice(0, 6)));
    ok(Array.isArray(data?.exercises) && data.exercises.length > 0, "export carries exercises", JSON.stringify(data?.exercises?.length));
    ok("plan" in data && "profile" in data && "settings" in data, "export carries the core tables", JSON.stringify(Object.keys(data || {}).slice(0, 12)));
  }
}

async function runAuthSmoke(ctx) {
  const base = ctx.base;
  const bearer = { authorization: `Bearer ${AUTH_TOKEN}` };
  const q = encodeURIComponent(AUTH_TOKEN);

  // 9) Health remains public, but reports that auth is enforced.
  {
    const { status, body } = await getJson(base, "/api/health");
    ok(status === 200, "auth: GET /api/health remains public", `got ${status}`);
    ok(body && body.auth_required === true, "auth: health reports auth_required:true", JSON.stringify(body));
  }

  // 10) Protected API rejects without a token.
  {
    const { status, body } = await getJson(base, "/api/plan");
    ok(status === 401, "auth: unauthenticated GET /api/plan → 401", `got ${status}`);
    ok(body && body.error === "unauthorized", "auth: unauthenticated body is unauthorized", JSON.stringify(body));
  }

  // 11) Authorization: Bearer succeeds on the same protected API.
  {
    const { status, body } = await getJson(base, "/api/plan", { headers: bearer });
    ok(status === 200, "auth: Bearer token GET /api/plan → 200", `got ${status}`);
    ok(Array.isArray(body) && body.length > 0, "auth: Bearer token can read seeded plan", `len ${body?.length}`);
  }

  // 12) Query-token auth is intentionally refused on normal JSON API routes.
  {
    const { status, body } = await getJson(base, `/api/plan?token=${q}`);
    ok(status === 401, "auth: query token rejected for normal API route", `got ${status}`);
    ok(body && body.error === "unauthorized", "auth: rejected query-token API body is unauthorized", JSON.stringify(body));
  }

  // 13) Query-token auth is allowed for browser-only download surfaces.
  {
    const res = await fetch(`${base}/api/export?token=${q}`);
    ok(res.status === 200, "auth: query token GET /api/export → 200", `got ${res.status}`);
    ok((res.headers.get("content-disposition") || "").includes("attachment"), "auth: export remains an attachment");
    const data = await res.json();
    ok(data && typeof data === "object" && "exported_at" in data, "auth: query-token export returns JSON backup", JSON.stringify(Object.keys(data || {}).slice(0, 6)));
  }

  // 14) Query-token auth is allowed for EventSource-style stream surfaces. Use a
  //     non-existent id so the route authenticates, emits one error event, and ends.
  {
    const res = await fetch(`${base}/api/chat/turns/0/stream?token=${q}`);
    const text = await res.text();
    ok(res.status === 200, "auth: query token GET /api/chat/turns/0/stream → 200", `got ${res.status}`);
    ok((res.headers.get("content-type") || "").includes("text/event-stream"), "auth: stream uses text/event-stream");
    ok(/event: error/.test(text) && /no such turn/.test(text), "auth: stream route emitted the expected terminal error event", JSON.stringify(text));
  }
}

if (!existsSync(serverEntry)) {
  console.error(`✗ ${serverEntry} is missing — run \`npm run build\` first (presmoke does this).`);
  process.exit(1);
}

let exitCode = 1;
try {
  await withServer({ label: "open", authToken: "", portOffset: 0 }, runOpenSmoke);
  await withServer({ label: "auth", authToken: AUTH_TOKEN, portOffset: 1 }, runAuthSmoke);
  console.log(`\nSmoke OK — ${passed} assertions passed.`);
  exitCode = 0;
} catch (e) {
  console.error(`\n✗ Smoke FAILED: ${e.message}`);
  const serverLog = e.serverLog || "";
  if (serverLog.trim()) {
    console.error("--- server output (tail) ---");
    console.error(serverLog.split("\n").slice(-20).join("\n"));
  }
  exitCode = 1;
}

process.exit(exitCode);

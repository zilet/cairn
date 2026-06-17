// Lightweight HTTP smoke test for Cairn's REST surface.
//
// Boots the BUILT server (dist/server.js) against a throwaway temp DB — the same
// DATA_DIR / DB_PATH isolation `test/run.mjs` uses, so it never touches the real
// data/cairn.db — waits for GET /api/health, then drives a few key flows end to
// end over HTTP with the built-in fetch (no browser, no extra dependency, no
// network beyond loopback). It exercises the API/PWA contract the offline unit
// tests don't: the deterministic day-read, plan CRUD, set logging, and export.
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

// A high, uncommon port to avoid clashing with a real dev server on 8787.
const PORT = Number(process.env.SMOKE_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;

// Fresh, empty temp DB per run — boots through the full migration ladder and gets
// auto-seeded with the default plan by the server's seedIfEmpty() at startup.
const dir = mkdtempSync(path.join(tmpdir(), "cairn-smoke-"));

let passed = 0;
function ok(cond, label, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    throw new Error(`assertion failed: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function getJson(p, init) {
  const res = await fetch(`${BASE}${p}`, init);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

// Poll GET /api/health until the server is listening (or give up).
async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function run() {
  // 1) Health — the readiness gate and a basic shape check.
  {
    const { status, body } = await getJson("/api/health");
    ok(status === 200, "GET /api/health → 200", `got ${status}`);
    ok(body && body.ok === true, "health body has ok:true", JSON.stringify(body));
    ok(body && "auth_required" in body, "health reports auth_required", JSON.stringify(body));
  }

  // 2) The Brief — the deterministic day-read always returns a REAL read, even
  //    with no agent reachable (it falls back to the deterministic floor).
  {
    const { status, body } = await getJson("/api/today-read");
    ok(status === 200, "GET /api/today-read → 200", `got ${status}`);
    ok(body && ["train", "easy", "rest"].includes(body.kind), "day-read has a valid kind", JSON.stringify(body?.kind));
    ok(body && typeof body.headline === "string" && body.headline.length > 0, "day-read has a headline", JSON.stringify(body?.headline));
  }

  // 3) Plan — the server auto-seeds 5 default days; confirm they're listed.
  {
    const { status, body } = await getJson("/api/plan");
    ok(status === 200, "GET /api/plan → 200", `got ${status}`);
    ok(Array.isArray(body) && body.length > 0, "plan lists seeded days", `len ${body?.length}`);
  }

  // 4) Create a plan day end-to-end (PUT /plan/:day), then read it back. Uses a
  //    high day_number so it never clobbers a seeded day.
  const smokeDay = 91;
  {
    const put = await getJson(`/api/plan/${smokeDay}`, {
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

    const get = await getJson(`/api/plan/${smokeDay}`);
    ok(get.status === 200 && get.body?.name === "Smoke Day", "GET /api/plan/91 reads it back", JSON.stringify(get.body?.name));
  }

  // 5) Log a set, then read it back via the session-by-date lookup. Asserts the
  //    logged_set round-trips with the right exercise/weight/reps and est-1RM.
  const today = new Date().toISOString().slice(0, 10);
  {
    const post = await getJson("/api/sets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exercise: "Smoke Squat", weight: 135, reps: 5, date: today }),
    });
    ok(post.status === 200, "POST /api/sets → 200", `got ${post.status}`);
    ok(post.body && post.body.exercise === "Smoke Squat" && post.body.weight === 135 && post.body.reps === 5, "logged set echoes its fields", JSON.stringify(post.body));
    ok(post.body && typeof post.body.est_1rm === "number" && post.body.est_1rm > 135, "logged set computes est-1RM (Epley)", JSON.stringify(post.body?.est_1rm));

    const session = await getJson(`/api/sessions?date=${today}`);
    ok(session.status === 200 && session.body, "GET /api/sessions?date= returns a session", JSON.stringify(session.body?.id));
    const sets = session.body?.sets || [];
    ok(sets.some((s) => s.exercise === "Smoke Squat" && s.reps === 5), "the logged set is in today's session", JSON.stringify(sets));
  }

  // 6) Export — the JSON backup the whole DB serializes to.
  {
    const res = await fetch(`${BASE}/api/export`);
    ok(res.status === 200, "GET /api/export → 200", `got ${res.status}`);
    const data = await res.json();
    ok(data && typeof data === "object" && "exported_at" in data, "export has exported_at", JSON.stringify(Object.keys(data || {}).slice(0, 6)));
    ok(Array.isArray(data?.exercises) && data.exercises.length > 0, "export carries exercises", JSON.stringify(data?.exercises?.length));
    ok("plan" in data && "profile" in data && "settings" in data, "export carries the core tables", JSON.stringify(Object.keys(data || {}).slice(0, 12)));
  }
}

if (!existsSync(serverEntry)) {
  console.error(`✗ ${serverEntry} is missing — run \`npm run build\` first (presmoke does this).`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  DATA_DIR: dir,
  DB_PATH: path.join(dir, "cairn-smoke.db"),
  // No auth, no agent creds, no connector creds leaking into the smoke run.
  CAIRN_AUTH_TOKEN: "",
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

let exitCode = 1;
try {
  const up = await waitForHealth();
  if (!up) {
    throw new Error("server did not become healthy within the timeout");
  }
  console.log(`Cairn smoke: server up on ${BASE} (temp DB at ${dir})`);
  await run();
  console.log(`\nSmoke OK — ${passed} assertions passed.`);
  exitCode = 0;
} catch (e) {
  console.error(`\n✗ Smoke FAILED: ${e.message}`);
  if (serverLog.trim()) {
    console.error("--- server output (tail) ---");
    console.error(serverLog.split("\n").slice(-20).join("\n"));
  }
  exitCode = 1;
} finally {
  child.kill("SIGKILL");
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

process.exit(exitCode);

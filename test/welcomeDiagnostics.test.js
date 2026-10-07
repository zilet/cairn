// Every failure path of the welcome flow leaves exactly one privacy-safe diagnostic:
// step + provider + taxonomy code (+ HTTP status), never a message, a prompt, the
// person's words, a coach reply, a token or CLI output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadClientModule } from "./_dom.mjs";
import { db } from "../dist/db.js";
import {
  ingestClientDiagnosticEvents,
  parseClientDiagnosticBatch,
  WELCOME_FAILURE_CODES,
  WELCOME_FAILURE_STEPS,
} from "../dist/repo/diagnostics.js";

const PROVIDERS = new Set(["claude", "codex", "antigravity", "grok"]);

function load() {
  const storage = new Map();
  const timers = [];
  const ctx = loadClientModule(["client-diagnostics", "welcome-model"], {
    globals: {
      window: { addEventListener() {} },
      navigator: { onLine: true },
      localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)) },
      fetch: async () => ({ status: 204 }),
      setTimeout: (fn, delay) => (timers.push({ fn, delay }), timers.length),
    },
  });
  return ctx;
}

const SECRET = "SECRET-TOKEN-hunter2 my knee hurts, I weigh 180 lb";

test("a welcome failure is one bounded event built only from allowlisted tokens", () => {
  const { CairnWelcomeModel: m, CairnClientDiagnostics: d } = load();
  const before = d.pending().length;
  assert.equal(m.reportFailure("connect.signin", "codex", "login_connection", 502), true);
  const queued = d.pending().slice(before);
  assert.equal(queued.length, 1);
  const [event] = queued;
  assert.deepEqual(JSON.parse(JSON.stringify(event.welcome)), { step: "connect.signin", provider: "codex", code: "login_connection" });
  assert.equal(event.route, "/api/welcome");
  assert.equal(event.status, 502);
  assert.equal(event.message, "welcome connect.signin login_connection");
  // The same failure again inside the dedupe window is not a second event.
  assert.equal(m.reportFailure("connect.signin", "codex", "login_connection", 502), false);
  assert.equal(d.pending().length, before + 1);
});

test("no free text can ride a welcome event: hostile provider/code/step are bounded or dropped", () => {
  const { CairnWelcomeModel: m, CairnClientDiagnostics: d } = load();
  const base = d.pending().length;
  // An unknown provider string becomes "other"; free text never reaches the queue.
  assert.equal(m.reportFailure("meet", SECRET, "job_failed"), true);
  // A hostile code or step fails the reporter's own token check and is not queued.
  assert.equal(m.reportFailure("meet", "claude", SECRET), false);
  assert.equal(m.reportFailure(SECRET, "claude", "job_failed"), false);
  assert.equal(d.pending().length, base + 1);
  assert.doesNotMatch(JSON.stringify(d.pending()), /SECRET|hunter2|knee|180/);
  assert.equal(d.pending()[base].welcome.provider, "other");
});

test("the server keeps taxonomy only: unknown codes are dropped, unknown providers read as other", () => {
  const event = (welcome, extra = {}) => ({
    kind: "api_failure",
    level: "warning",
    message: SECRET,
    route: "/api/welcome",
    status: 500,
    fingerprint: SECRET,
    welcome,
    ...extra,
  });
  const parsed = parseClientDiagnosticBatch(
    {
      events: [
        event({ step: "connect.verify", provider: "claude", code: "verify_failed", extra: SECRET }),
        event({ step: "meet", provider: SECRET, code: "job_error" }),
        event({ step: "meet", provider: "claude", code: SECRET }),
        event({ step: SECRET, provider: "claude", code: "job_error" }),
      ],
    },
    { providers: PROVIDERS },
  );
  assert.equal(parsed.length, 2, "bad step/code events are dropped, their neighbours land");
  assert.equal(parsed[0].welcome.provider, "claude");
  assert.equal(parsed[1].welcome.provider, "other");
  ingestClientDiagnosticEvents(parsed);
  const rows = db.prepare("SELECT * FROM diagnostic_events ORDER BY id").all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.message, "Welcome step failed");
    assert.match(row.fingerprint, /^client:welcome:(connect\.verify|meet):(claude|other):(verify_failed|job_error):500$/);
    assert.doesNotMatch(JSON.stringify(row), /SECRET|hunter2|knee|180/);
  }
  const meta = JSON.parse(rows[0].metadata_json);
  assert.equal(meta.welcome_step, "connect.verify");
  assert.equal(meta.welcome_provider, "claude");
  assert.equal(meta.welcome_code, "verify_failed");
  assert.deepEqual(
    Object.keys(meta).filter((k) => k.startsWith("welcome_")).sort(),
    ["welcome_code", "welcome_provider", "welcome_step"],
  );
});

test("every failure path of the welcome controllers records a code the server accepts", () => {
  const sources = ["welcome-connect-controller", "welcome-meet-controller", "welcome-screen"]
    .map((name) => readFileSync(new URL(`../src/client/${name}.ts`, import.meta.url), "utf8"))
    .join("\n");
  const literal = [
    ...[...sources.matchAll(/\bnote\(\s*(?:"[a-z.]+"|from),\s*"([a-z_]+)"/g)].map((m) => m[1]),
    ...[...sources.matchAll(/\bnote\("([a-z_]+)"\)/g)].map((m) => m[1]),
    ...[...sources.matchAll(/reportFailure\("[a-z.]+", [a-zA-Z.]+, "([a-z_]+)"/g)].map((m) => m[1]),
  ];
  assert.ok(literal.length >= 10, `expected the paths to be wired, found ${literal.length}`);
  for (const code of literal) assert.ok(WELCOME_FAILURE_CODES.has(code), `${code} is in the server allowlist`);
  // The dynamic sign-in code is login_<reason>; each reason has an allowlisted code.
  for (const reason of ["terminal", "connection", "incomplete", "error", "disconnected"]) {
    assert.ok(WELCOME_FAILURE_CODES.has(`login_${reason}`), reason);
  }
  for (const step of ["hello", "connect.install", "connect.signin", "connect.verify", "meet"]) {
    assert.ok(WELCOME_FAILURE_STEPS.has(step), step);
  }
  // The five failure surfaces named by the maintainer are all instrumented.
  for (const code of ["install_failed", "login_busy", "verify_failed", "job_failed", "job_error", "enqueue_failed", "unreachable"]) {
    assert.ok(sources.includes(`"${code}"`), `${code} is recorded somewhere`);
  }
});

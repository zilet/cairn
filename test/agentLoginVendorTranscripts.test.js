// The in-app sign-in against what the CURRENT vendor CLIs actually print.
//
// The transcripts below were captured on 2026-10-07 from grok 1.0.46 and agy 1.3.1
// (installed into a throwaway HOME, signed out). They pin three things:
//   - the panel's URL / device-code scan finds grok's device-auth link and code;
//   - a login CLI that exits non-zero says WHY (loginExitDetail → the exit frame's
//     `detail` → "The sign-in didn't finish. Grok said: …"), never a silent failure;
//   - the shipped login argv still matches what each CLI accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import "./_seed.js";
import { loginExitDetail, resolveLoginArgv } from "../dist/agentLogin.js";
import { loadAgents } from "../dist/agents.js";
import { loadClientModule } from "./_dom.mjs";

process.env.AGENTS_CONFIG = path.join(import.meta.dirname, "..", "agents.json");

// grok 1.0.46 `grok login --device-auth`, no TTY, signed out (code is a sample).
const GROK_DEVICE_AUTH = [
  "",
  "To sign in, open this URL in your browser:",
  "",
  "  https://accounts.x.ai/oauth2/device?user_code=CA5S-J2KP",
  "",
  "  (Could not open browser automatically — open the URL above manually.)",
  "",
  "Confirm this code in your browser:",
  "",
  "  CA5S-J2KP",
  "",
  "\u001b[90mOnly continue with a code you requested. Don't share it with anyone.\u001b[0m",
  "",
  "Waiting for authorization...",
];

// agy 1.3.1 `-p /quota --output-format json`, signed out, after its 60s wait ran out.
const AGY_PRINT_AUTH_TIMEOUT = [
  "Authentication required. Please visit the URL to log in:",
  "  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com&response_type=code&state=abc",
  "",
  "Waiting for authentication (timeout 60s)...",
  "Or, paste the authorization code here and press Enter:",
  "",
  "Error: authentication interrupted.",
  "error: authentication failed or timed out",
  '{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out"}',
].join("\r\n");

test("shipped login argv matches the current CLIs (grok device-auth, agy bare)", () => {
  assert.deepEqual(resolveLoginArgv("grok"), ["grok", "login", "--device-auth"]);
  // agy 1.3.1 has no login subcommand: launching it bare IS the sign-in.
  assert.deepEqual(resolveLoginArgv("antigravity"), ["agy"]);
  const agents = loadAgents();
  assert.match(agents.grok.login_note, /1\.0\.46/);
  assert.match(agents.antigravity.login_note, /1\.3\.1/);
});

test("the sign-in panel scan finds grok 1.0.46's device-auth link and code", () => {
  const win = loadClientModule(["agent-login-model-client", "agent-login-session-client"], { globals: {} });
  const session = win.CairnAgentLoginSession;
  assert.equal(session.findAuthUrl(GROK_DEVICE_AUTH), "https://accounts.x.ai/oauth2/device?user_code=CA5S-J2KP");
  assert.equal(session.findDeviceCode(GROK_DEVICE_AUTH), "CA5S-J2KP");
});

test("the scan finds agy 1.3.1's Google sign-in link, even hard-wrapped in a box", () => {
  const win = loadClientModule(["agent-login-model-client", "agent-login-session-client"], { globals: {} });
  const session = win.CairnAgentLoginSession;
  const url =
    "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com&code_challenge=gx6l&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=4OTX";
  assert.equal(session.findAuthUrl(AGY_PRINT_AUTH_TIMEOUT.split("\r\n")), AGY_PRINT_AUTH_TIMEOUT.split("\r\n")[1].trim());
  // A full-screen TUI wraps the same link across bordered lines.
  const wrapped = ["│ Authentication required. Please visit the URL to log in: │", `│ ${url.slice(0, 70)} │`, `│ ${url.slice(70, 140)} │`, `│ ${url.slice(140)} │`];
  assert.equal(session.findAuthUrl(wrapped), url);
});

test("loginExitDetail keeps the CLI's own last error line, plain and bounded", () => {
  assert.equal(loginExitDetail(AGY_PRINT_AUTH_TIMEOUT), "error: authentication failed or timed out");
  assert.equal(
    loginExitDetail("\u001b[31merror:\u001b[0m unexpected argument '--device-auth' found\r\n\r\nUsage: grok login [OPTIONS]\r\n"),
    "error: unexpected argument '--device-auth' found"
  );
  // No error wording: the last meaningful line, never a bare URL or box art.
  assert.equal(loginExitDetail("Signing in…\nhttps://example.test/x\n╭────╮\n"), "Signing in…");
  assert.equal(loginExitDetail(""), null);
  assert.equal(loginExitDetail("\u001b[2J\u001b[H"), null);
  assert.ok(loginExitDetail(`Error: ${"x".repeat(500)}`).length <= 200);
});

// A minimal xterm + socket pair so the real session client runs end to end.
function sessionHarness() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }
  class FakeTerminal {
    constructor() {
      this.cols = 100;
      this.rows = 32;
      this.buffer = { active: { length: 0, getLine: () => null } };
    }
    loadAddon() {}
    open() {}
    write() {}
    resize() {}
    dispose() {}
    onData() {}
    onResize() {}
  }
  class FakeFit {
    fit() {}
  }
  const win = loadClientModule(["agent-login-model-client", "agent-login-session-client"], {
    globals: {
      WebSocket: FakeWebSocket,
      location: { protocol: "http:", host: "cairn.test" },
      CairnAgentLoginAssets: { load: async () => {}, globals: () => ({ Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFit } }) },
    },
  });
  return { win, sockets };
}

async function runExit(frame) {
  const { win, sockets } = sessionHarness();
  const events = [];
  const host = {
    termHost: win.document.createElement("div"),
    emit: (e) => events.push(e),
    alive: () => true,
  };
  await win.CairnAgentLoginSession.start("grok", host);
  assert.equal(sockets.length, 1);
  sockets[0].onmessage({ data: JSON.stringify(frame) });
  // The client runs in its own vm realm: compare plain data, not cross-realm objects.
  return JSON.parse(JSON.stringify(events.filter((e) => e.t === "failed" || e.t === "connected")));
}

test("a login CLI that exits at once with an error says why, in plain words first", async () => {
  const failed = await runExit({ t: "exit", code: 2, detail: "error: unexpected argument '--device-auth' found" });
  assert.deepEqual(failed, [
    {
      t: "failed",
      reason: "incomplete",
      message: "The sign-in didn't finish. Grok said: error: unexpected argument '--device-auth' found",
    },
  ]);
  // Without a detail the headline stands alone; a clean exit is still a sign-in.
  assert.deepEqual(await runExit({ t: "exit", code: 1 }), [
    { t: "failed", reason: "incomplete", message: "The sign-in didn't finish." },
  ]);
  assert.deepEqual(await runExit({ t: "exit", code: 0 }), [{ t: "connected" }]);
});

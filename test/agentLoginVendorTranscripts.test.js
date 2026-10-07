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

test("shipped login argv matches the current CLIs (grok device-auth, agy print mode)", () => {
  assert.deepEqual(resolveLoginArgv("grok"), ["grok", "login", "--device-auth"]);
  // agy 1.3.1 has no login subcommand. Print mode prints the whole URL on one line and
  // takes the pasted code with no menu first; bare `agy` opened a numbered menu and a
  // TUI that cut the URL on a phone.
  assert.deepEqual(resolveLoginArgv("antigravity"), ["agy", "-p", "/quota"]);
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

// The verified print-mode sign-in, as a 40-column phone PTY delivers it: the URL is
// ONE line in the stream; xterm soft-wraps it (isWrapped) across many rows.
const AGY_URL =
  "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com&code_challenge=gx6lQ2&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&state=4OTX";
const AGY_PRINT_AUTH = [
  "Authentication required. Please visit the URL to log in:",
  `  ${AGY_URL}`,
  "",
  "Waiting for authentication (timeout 60s)...",
  "Or, paste the authorization code here and press Enter:",
  "",
].join("\r\n");

function wrapAt(text, cols) {
  const rows = [];
  for (const line of text.split("\r\n")) {
    if (!line) rows.push({ text: "", wrapped: false });
    for (let i = 0; i < line.length; i += cols) rows.push({ text: line.slice(i, i + cols), wrapped: i > 0 });
  }
  return rows;
}

test("agy's print-mode URL is taken whole at 40 columns, response_type and all", () => {
  const win = loadClientModule(["agent-login-model-client", "agent-login-session-client"], { globals: {} });
  const session = win.CairnAgentLoginSession;
  // The raw stream never wraps.
  assert.equal(session.findStreamAuthUrl(`\u001b[1m${AGY_PRINT_AUTH}\u001b[0m`), AGY_URL);
  // The terminal buffer, soft-wrapped at 40 columns, joined back by isWrapped.
  const rows = wrapAt(AGY_PRINT_AUTH, 40);
  const lines = [];
  for (const row of rows) {
    if (row.wrapped && lines.length) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  assert.equal(session.findAuthUrl(lines), AGY_URL);
  // The bare TUI's failure: rows cut before response_type are never offered.
  const cut = AGY_URL.slice(0, AGY_URL.indexOf("&response_type"));
  assert.equal(session.findAuthUrl(["Please visit:", cut, "(1–16 of 35 lines) shift+up/down Navigate"]), "");
  assert.equal(session.findStreamAuthUrl(`${cut}\r\n(1–16 of 35 lines)`), "");
  // A URL still arriving (nothing after it yet) is not whole; the longer copy wins.
  assert.equal(session.findStreamAuthUrl(`visit:\r\n  ${AGY_URL.slice(0, -4)}`), "");
  assert.equal(session.findAuthUrl([AGY_URL, "Or, paste the code:", AGY_URL.slice(0, -5)]), AGY_URL);
  // An OSC 8 hyperlink carries the full URI even when the visible text is cut.
  assert.equal(session.findStreamAuthUrl(`\u001b]8;;${AGY_URL}\u0007Sign in\u001b]8;;\u0007`), AGY_URL);
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
      // The debounced buffer rescan never fires here: the stream path must stand alone.
      setTimeout: () => 0,
      clearTimeout: () => {},
      location: { protocol: "http:", host: "cairn.test" },
      CairnAgentLoginAssets: { load: async () => {}, globals: () => ({ Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFit } }) },
    },
  });
  return { win, sockets };
}

async function runExit(frame, agent = "grok") {
  const { win, sockets } = sessionHarness();
  const events = [];
  const host = {
    termHost: win.document.createElement("div"),
    emit: (e) => events.push(e),
    alive: () => true,
  };
  await win.CairnAgentLoginSession.start(agent, host);
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

test("agy's print-mode stream yields the whole link at once, a pasted code goes in with Enter", async () => {
  const { win, sockets } = sessionHarness();
  const events = [];
  const host = { termHost: win.document.createElement("div"), emit: (e) => events.push(e), alive: () => true };
  const handle = await win.CairnAgentLoginSession.start("antigravity", host);
  const bytes = new TextEncoder().encode(AGY_PRINT_AUTH);
  // Split mid-URL across two frames: nothing is offered until the URL is whole.
  const cut = AGY_PRINT_AUTH.indexOf("&state=");
  sockets[0].onmessage({ data: bytes.slice(0, cut).buffer });
  assert.equal(events.filter((e) => e.t === "link").length, 0);
  sockets[0].onmessage({ data: bytes.slice(cut).buffer });
  const links = JSON.parse(JSON.stringify(events.filter((e) => e.t === "link")));
  assert.deepEqual(links, [{ t: "link", url: AGY_URL }]);
  assert.equal(handle.send(" 4/0AVG-code "), true);
  assert.equal(sockets[0].sent.at(-1), "4/0AVG-code\r");
});

test("agy's 60-second window running out reads as expired (a fresh link), not a failure", async () => {
  const detail = loginExitDetail(AGY_PRINT_AUTH_TIMEOUT);
  assert.deepEqual(await runExit({ t: "exit", code: 1, detail }, "antigravity"), [
    { t: "failed", reason: "expired", message: "The sign-in didn't finish. Google said: error: authentication failed or timed out" },
  ]);
  assert.deepEqual(await runExit({ t: "exit", code: 0 }, "antigravity"), [{ t: "connected" }]);
});

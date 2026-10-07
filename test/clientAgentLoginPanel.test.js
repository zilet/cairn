// The friendly AI sign-in panel (agent-login-panel-client.ts) and what the session
// reads out of a CLI's terminal (agent-login-session-client.ts). The panel never looks
// like a terminal: a sign-in link becomes one "Open <Provider> sign-in" button, a
// device code is shown large, Claude's code is pasted into a plain field, and the raw
// terminal waits folded under "Show details".
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule } from "./_dom.mjs";

function load() {
  let host = null;
  const sent = [];
  let closed = 0;
  const session = {
    start: async (name, h) => {
      host = h;
      return {
        send: (text) => {
          sent.push(text);
          return true;
        },
        close: () => {
          closed += 1;
        },
      };
    },
    findAuthUrl: () => "",
    findDeviceCode: () => "",
  };
  const win = loadClientModule(["html-utils", "agent-login-model-client", "agent-login-panel-client"], {
    globals: {
      navigator: { maxTouchPoints: 0 },
      CairnAgentLoginSession: session,
      setTimeout: () => 0,
    },
  });
  const slot = win.document.createElement("div");
  win.document.body.appendChild(slot);
  return { win, slot, emit: (e) => host.emit(e), sent, closed: () => closed, alive: () => host.alive() };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a sign-in link becomes the one primary action, set as a property never as markup", async () => {
  const env = load();
  const events = [];
  env.win.CairnAgentLoginPanel.mount(env.slot, { name: "codex", label: "ChatGPT", onConnected: () => events.push("connected") });
  await flush();
  assert.equal(env.slot.querySelector(".alp-link").hidden, true, "no link until the CLI prints one");
  env.emit({ t: "link", url: "https://auth.openai.com/codex/device" });
  const open = env.slot.querySelector(".alp-open");
  assert.equal(env.slot.querySelector(".alp-link").hidden, false);
  assert.equal(open.textContent, "Open ChatGPT sign-in");
  assert.equal(open.href, "https://auth.openai.com/codex/device");
  env.emit({ t: "code", code: "WDJB-MJHT2" });
  assert.equal(env.slot.querySelector(".alp-code").hidden, false);
  assert.equal(env.slot.querySelector(".alp-code-val").textContent, "WDJB-MJHT2");
  env.emit({ t: "connected" });
  assert.deepEqual(events, ["connected"]);
  assert.match(env.slot.querySelector(".alp-status").textContent, /Signed in to ChatGPT/);
});

test("Claude's code is pasted into a plain field and sent to the CLI as typed", async () => {
  const env = load();
  env.win.CairnAgentLoginPanel.mount(env.slot, { name: "claude", label: "Claude" });
  await flush();
  const form = env.slot.querySelector("form.alp-paste");
  assert.ok(form, "Claude gets a paste field");
  assert.equal(form.hidden, true, "shown once the sign-in page is open");
  env.emit({ t: "link", url: "https://claude.ai/oauth/authorize?code=true" });
  assert.equal(form.hidden, false);
  assert.match(form.querySelector("label").textContent, /Paste the code Claude shows you/);
  form.querySelector("input").value = "  abc-123#state ";
  form.dispatchEvent(new env.win.Event("submit", { bubbles: true, cancelable: true }));
  assert.deepEqual(env.sent, ["  abc-123#state "]);
  assert.match(env.slot.querySelector(".alp-status").textContent, /Checking the code/);
});

test("the terminal waits folded under details", async () => {
  const env = load();
  env.win.CairnAgentLoginPanel.mount(env.slot, { name: "grok", label: "Grok" });
  await flush();
  const more = env.slot.querySelector(".alp-more-btn");
  const details = env.slot.querySelector(".alp-details");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  assert.equal(details.classList.contains("is-open"), false);
  assert.ok(details.querySelector(".alp-term"), "the terminal is mounted, only folded");
  more.click();
  assert.equal(more.getAttribute("aria-expanded"), "true");
  assert.equal(details.classList.contains("is-open"), true);
  assert.equal(more.textContent, "Hide details");
});

test("a failure is said in plain words and closing tears the session down once", async () => {
  const env = load();
  const failed = [];
  const handle = env.win.CairnAgentLoginPanel.mount(env.slot, {
    name: "codex",
    label: "ChatGPT",
    onFailed: (message, reason) => failed.push([message, reason]),
  });
  await flush();
  env.emit({ t: "failed", reason: "incomplete", message: "The sign-in didn't finish." });
  assert.deepEqual(failed, [["The sign-in didn't finish.", "incomplete"]]);
  assert.ok(env.slot.querySelector(".alp-status").classList.contains("is-err"));
  handle.close();
  handle.close();
  assert.equal(env.closed(), 1);
  assert.equal(env.alive(), false);
});

test("the session reads the sign-in URL and a device code out of terminal lines", () => {
  const win = loadClientModule(["agent-login-model-client", "agent-login-session-client"], { globals: {} });
  const session = win.CairnAgentLoginSession;
  const lines = [
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "1. Open this link in your browser",
    "   https://auth.openai.com/codex/device",
    "2. Enter this one-time code (expires in 15 minutes)",
    "   WDJB-MJHT2",
  ];
  assert.equal(session.findAuthUrl(lines), "https://auth.openai.com/codex/device");
  assert.equal(session.findDeviceCode(lines), "WDJB-MJHT2");
  // A wrapped URL continues across a box border; words that merely look like a code do not count.
  assert.equal(
    session.findAuthUrl(["│ https://claude.ai/oauth/authorize?code=true&client_", "│ id=9d1c250a&response_type=code&state=xyz │"]),
    "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&state=xyz"
  );
  assert.equal(session.findDeviceCode(["Use HTTP-ONLY cookies for this flow"]), "");
});

// Google (agy print mode) waits a fixed 60s for the pasted code, so its sign-in starts
// on the tap — never on render — and a window that closed offers a fresh one.
function loadGoogle() {
  const starts = [];
  const sent = [];
  const tabs = [];
  const session = {
    start: async (name, h) => {
      const entry = { name, host: h, closed: 0 };
      starts.push(entry);
      return {
        send: (text) => {
          sent.push(text);
          return true;
        },
        close: () => {
          entry.closed += 1;
        },
      };
    },
    findAuthUrl: () => "",
    findDeviceCode: () => "",
  };
  const win = loadClientModule(["html-utils", "agent-login-model-client", "agent-login-panel-client"], {
    globals: {
      navigator: { maxTouchPoints: 5 },
      CairnAgentLoginSession: session,
      setTimeout: () => 0,
      open: (href, target) => {
        const tab = { href, target, closed: false, opener: {}, location: { href: "about:blank" }, close() { this.closed = true; } };
        tabs.push(tab);
        return tab;
      },
    },
  });
  const slot = win.document.createElement("div");
  win.document.body.appendChild(slot);
  return { win, slot, starts, sent, tabs };
}

const GOOGLE_URL =
  "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1-x.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=4OTX";

test("Google's sign-in starts on the tap, opens its tab inside the tap, and takes the pasted code", async () => {
  const env = loadGoogle();
  const connected = [];
  env.win.CairnAgentLoginPanel.mount(env.slot, { name: "antigravity", label: "Google", onConnected: () => connected.push(1) });
  await flush();
  assert.equal(env.starts.length, 0, "rendering the step never starts the 60-second CLI");
  assert.equal(env.slot.querySelector(".alp-details").classList.contains("is-open"), false);
  assert.equal(env.slot.querySelector("[data-alp-done]"), null, "no self-report: exit 0 is the signal");
  const launch = env.slot.querySelector("[data-alp-launch]");
  assert.equal(launch.textContent, "Open Google sign-in");
  assert.equal(launch.hidden, false);

  await launch.click();
  await flush();
  assert.equal(env.starts.length, 1, "the tap spawns the sign-in");
  assert.equal(env.tabs.length, 1, "a blank tab opened synchronously inside the tap");
  assert.equal(env.tabs[0].href, "");
  assert.equal(env.tabs[0].opener, null);

  env.starts[0].host.emit({ t: "link", url: GOOGLE_URL });
  assert.equal(env.tabs[0].location.href, GOOGLE_URL, "the waiting tab is pointed at the sign-in");
  const form = env.slot.querySelector("form.alp-paste");
  assert.equal(form.hidden, false);
  assert.match(form.querySelector("label").textContent, /Paste the code Google shows you/);
  assert.equal(form.querySelector("button[type=submit]").textContent, "Sign in");
  assert.equal(env.slot.querySelector(".alp-type"), null, "the code field replaces the terminal type line");
  assert.equal(env.slot.querySelector(".alp-hint").hidden, false);
  assert.match(env.slot.querySelector(".alp-hint").textContent, /about a minute/);
  assert.match(env.slot.querySelector(".alp-left").textContent, /1:00 left|0:59 left/);

  form.querySelector("input").value = "4/0AVG-code";
  form.dispatchEvent(new env.win.Event("submit", { bubbles: true, cancelable: true }));
  assert.deepEqual(env.sent, ["4/0AVG-code"]);
  env.starts[0].host.emit({ t: "connected" });
  assert.deepEqual(connected, [1]);
});

test("with no tab handle, the whole link is the button; a closed window offers a fresh one", async () => {
  const env = loadGoogle();
  env.win.open = () => null;
  const failed = [];
  env.win.CairnAgentLoginPanel.mount(env.slot, { name: "antigravity", label: "Google", onFailed: (m) => failed.push(m) });
  await flush();
  await env.slot.querySelector("[data-alp-launch]").click();
  await flush();
  env.starts[0].host.emit({ t: "link", url: GOOGLE_URL });
  const open = env.slot.querySelector("a.alp-open");
  assert.equal(open.hidden, false);
  assert.equal(open.href, GOOGLE_URL);
  assert.equal(open.textContent, "Open Google sign-in");
  assert.equal(env.slot.querySelector('[data-alp-copy="link"]').hidden, false);

  // agy's 60s ran out: the old link and code are dead.
  env.starts[0].host.emit({ t: "failed", reason: "expired", message: "The sign-in didn't finish. Google said: error: authentication failed or timed out" });
  assert.deepEqual(failed, [], "a closed window is not a failure to report");
  assert.equal(env.starts[0].closed, 1);
  assert.match(env.slot.querySelector(".alp-status").textContent, /That sign-in window closed\. Open a fresh one/);
  assert.equal(env.slot.querySelector(".alp-status").classList.contains("is-err"), false);
  assert.equal(env.slot.querySelector("a.alp-open").hidden, true);
  assert.equal(env.slot.querySelector("form.alp-paste").hidden, true);
  const launch = env.slot.querySelector("[data-alp-launch]");
  assert.equal(launch.hidden, false);
  await launch.click();
  await flush();
  assert.equal(env.starts.length, 2, "Open again spawns a fresh sign-in (a new URL)");
  // A late frame from the dead window never repaints the fresh one.
  env.starts[0].host.emit({ t: "link", url: "https://accounts.google.com/stale" });
  assert.equal(env.slot.querySelector("a.alp-open").hidden, true);
});

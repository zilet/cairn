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

test("the terminal waits folded under details; Antigravity's starts unfolded", async () => {
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

  const agy = load();
  agy.win.CairnAgentLoginPanel.mount(agy.slot, { name: "antigravity", label: "Google", detailsOpen: true });
  await flush();
  assert.equal(agy.slot.querySelector(".alp-details").classList.contains("is-open"), true);
  assert.ok(agy.slot.querySelector("[data-alp-done]"), "Antigravity never exits on its own: the person says when");
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
    session.findAuthUrl(["│ https://claude.ai/oauth/authorize?code=true&client_", "│ id=9d1c250a&state=xyz │"]),
    "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&state=xyz"
  );
  assert.equal(session.findDeviceCode(["Use HTTP-ONLY cookies for this flow"]), "");
});

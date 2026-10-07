// "Connected" is a positive verdict, never a guess.
//
// A fresh hosted user never signed in to anything, yet the welcome said "Already
// signed in to Claude" and the boot dropped them into Meet, where every message
// failed: the login probe could not answer (a cold CLI on a small container timed
// out), the server kept that undetectable login in the rotation (`usable`, which is
// right for coaching runs), and every first-run surface read `usable` as signed in.
// These pin the split: the welcome, the boot's Meet routing and Today's hello read
// `signed_in` (a positive verdict or an answered hello) and never `usable` alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadClientModule, renderHtml } from "./_dom.mjs";
import { agentConfigured, invalidateAgentConfigured, loadAgents } from "../dist/agents.js";
import { getAgentConfig } from "../dist/repo/settings.js";

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------- server: the evidence ----------

test("claude's auth_state is a file only a completed login writes, never what any run creates", () => {
  const claude = loadAgents().claude;
  assert.deepEqual(claude.auth_state, [".claude/.credentials.json"]);
  for (const rel of [".claude.json", ".claude"]) assert.ok(!claude.auth_state.includes(rel), `${rel} is not evidence`);
});

test("a probe that cannot be read, in a HOME holding only what a claude run creates, is unknown — never signed in", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-home-"));
  const before = process.env.HOME;
  const command = loadAgents().claude.command;
  try {
    process.env.HOME = home;
    // A stand-in CLI on the agent PATH that behaves like a cold claude whose status
    // could not be read: it creates its config file and dir (as every claude run does)
    // and prints nothing the status parser recognises.
    const bin = path.join(home, ".cairn-tools", "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, command),
      `#!/bin/sh\necho '{}' > "$HOME/.claude.json"\nmkdir -p "$HOME/.claude"\necho 'Checking for updates...'\n`,
      { mode: 0o755 }
    );
    invalidateAgentConfigured("claude");
    assert.equal(agentConfigured("claude"), null, "a config file and dir are not a sign-in");
    assert.ok(fs.existsSync(path.join(home, ".claude.json")), "the probe itself created them");
    const row = getAgentConfig().find((a) => a.name === "claude");
    assert.ok(row);
    assert.equal(row.usable || !row.enabled, true, "still in the rotation: an unknown never excludes");
    assert.equal(row.signed_in, false, "never signed in from an unknown");

    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
    invalidateAgentConfigured("claude");
    assert.equal(agentConfigured("claude"), true, "the credentials file a login writes is evidence");
    assert.equal(getAgentConfig().find((a) => a.name === "claude").signed_in, true);
  } finally {
    process.env.HOME = before;
    invalidateAgentConfigured("claude");
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("every agent row carries signed_in, and it is never true while the login is undetectable", () => {
  for (const row of getAgentConfig()) {
    assert.equal(typeof row.signed_in, "boolean", `${row.name}.signed_in`);
    if (row.configured !== true) assert.equal(row.signed_in, false, `${row.name}: configured ${row.configured}`);
  }
});

// ---------- client: the coach link and the boot ----------

const ROWS = [
  { name: "claude", label: "Claude", plan: "Claude Pro or Max", present: true, installable: true, can_login: true },
  { name: "codex", label: "ChatGPT", plan: "Sign in with ChatGPT", present: true, installable: true, can_login: true },
];

// An undetectable login: in the rotation (usable) but not signed in.
function unknownLoginBody() {
  return {
    settings: { onboarded: false, coach_welcomed: false },
    agents: ROWS.map((a) => ({ ...a, usable: true, configured: null, signed_in: false })),
  };
}

test("the coach link: an undetectable login is usable for the rotation but never ready", () => {
  const win = loadClientModule(["coach-link-client"]);
  const model = win.CairnCoachLink.model(unknownLoginBody());
  assert.deepEqual(plain(model.usable.map((p) => p.name)), ["claude", "codex"]);
  assert.deepEqual(plain(model.ready), [], "nobody is called connected");
  assert.ok(model.providers.every((p) => p.signedIn === false));
  // An older server without signed_in: only an explicit configured:true counts.
  const older = win.CairnCoachLink.model({
    settings: {},
    agents: [
      { ...ROWS[0], usable: true, configured: null },
      { ...ROWS[1], usable: true, configured: true },
    ],
  });
  assert.deepEqual(plain(older.ready.map((p) => p.name)), ["codex"]);
});

test("the boot never lands a fresh install on Meet through an undetectable login", async () => {
  const opened = [];
  const body = unknownLoginBody();
  const win = loadClientModule(["coach-link-client", "app-onboarding"], {
    globals: {
      location: { pathname: "/", search: "", href: "http://cairn.local/" },
      api: async () => body,
      artEnabled: true,
      withBundle: (_name, fn) => fn(),
      CairnWelcome: { open: (opts) => opened.push(plain(opts)) },
      swrSet: () => {},
      peekCached: () => null,
      cachedApi: async () => body,
      swrInvalidate: () => {},
      setTimeout: () => 0,
    },
  });
  await win.maybeOnboard();
  assert.deepEqual(opened, [{ stage: "hello", replace: true }]);
});

// ---------- client: the Connect stage ----------

const STEP_KEYS = ["setup", "signin", "hello"];

function connectHost(win) {
  const steps = STEP_KEYS.map(
    (key) =>
      `<li data-wel-step="${key}" data-state="waiting"><p class="wel-step-s"></p><div class="wel-step-x"></div></li>`
  ).join("");
  return renderHtml(`<div class="wel-connect"><ol>${steps}</ol></div>`, { document: win.document }).querySelector(
    ".wel-connect"
  );
}

function mountConnect(provider, { verify = { ok: true } } = {}) {
  const calls = { panels: 0, verify: 0, connected: [] };
  const fresh = () => ({ providers: [provider], usable: [provider], ready: [], onboarded: false, welcomed: false });
  const win = loadClientModule(["html-utils", "welcome-connect-controller"], {
    globals: {
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      reducedMotion: () => true,
      api: async (url) => {
        if (/\/verify$/.test(url)) {
          calls.verify++;
          return verify;
        }
        throw new Error(`unexpected ${url}`);
      },
      CairnCoachLink: { invalidate: () => {}, read: async () => fresh() },
      CairnWelcomeModel: {
        STEPS: STEP_KEYS.map((key) => ({ key, title: key })),
        reportFailure: () => true,
        humanMessage: (raw, fallback) => (typeof raw === "string" && raw ? raw : fallback),
      },
      CairnAgentLoginPanel: {
        mount: () => {
          calls.panels++;
          return { close: () => {} };
        },
      },
    },
  });
  win.escHtml ??= win.CairnHtmlUtils?.escHtml;
  win.escAttr ??= win.CairnHtmlUtils?.escAttr;
  const host = connectHost(win);
  win.CairnWelcomeConnect.mount(host, {
    provider,
    onSwitch: () => {},
    onConnected: (p) => calls.connected.push(p.name),
  });
  return { host, calls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const stepOf = (host, key) => host.querySelector(`[data-wel-step="${key}"]`);
const statusOf = (host, key) => stepOf(host, key).querySelector(".wel-step-s").textContent;

const base = {
  name: "claude",
  label: "Claude",
  plan: "",
  present: true,
  installable: true,
  canLogin: true,
  usable: true,
};

test("Connect: an undetectable login runs the sign-in, never 'Already signed in'", async () => {
  const { host, calls } = mountConnect({ ...base, configured: null, signedIn: false });
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(calls.panels, 1, "the sign-in panel is offered");
  assert.equal(stepOf(host, "signin").dataset.state, "working");
  assert.doesNotMatch(statusOf(host, "signin"), /Already signed in/);
  assert.equal(calls.verify, 0, "no hello before the sign-in");
});

test("Connect: a positive sign-in skips to the hello, and only then says so", async () => {
  const { host, calls } = mountConnect({ ...base, configured: true, signedIn: true });
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(calls.panels, 0);
  assert.match(statusOf(host, "signin"), /Already signed in to Claude/);
  assert.equal(calls.verify, 1);
  assert.deepEqual(calls.connected, ["claude"]);
});

test("Connect: a hello that finds the provider signed out goes back to the sign-in, with it offered", async () => {
  const { host, calls } = mountConnect(
    { ...base, configured: true, signedIn: true },
    { verify: { ok: false, reason: "not_signed_in", message: "Claude isn't signed in yet." } }
  );
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(calls.verify, 1);
  assert.equal(stepOf(host, "signin").dataset.state, "failed");
  assert.equal(stepOf(host, "hello").dataset.state, "waiting");
  const offer = stepOf(host, "signin").querySelector('[data-wel-act="signin-now"]');
  assert.ok(offer, "the sign-in itself is the way on");
  assert.match(offer.textContent, /Sign in to Claude/);
  assert.deepEqual(calls.connected, [], "Meet is not entered");
  await offer.click();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(calls.panels, 1, "tapping it opens the sign-in panel");
});

// ---------- client: the welcome's own Meet gate ----------

function welcomeScreen(model) {
  const urls = [];
  const painted = [];
  const paint = (what, cls) => {
    painted.push(what);
    return `<div class="${cls}"><h1>${what}</h1></div>`;
  };
  const win = loadClientModule(["welcome-screen"], {
    globals: {
      history: {
        pushState: (_s, _t, url) => urls.push(url),
        replaceState: (_s, _t, url) => urls.push(url),
      },
      reducedMotion: () => true,
      CairnCoachLink: { peek: () => model, read: async () => model, invalidate: () => {} },
      CairnWelcomeClient: {
        helloHtml: () => paint("hello", "wel-hello"),
        connectHtml: (p) => paint(`connect:${p.name}`, "wel-connect"),
        meetHtml: (p) => paint(`meet:${p ? p.name : ""}`, "wel-meet"),
      },
      CairnWelcomeConnect: { mount: () => () => {} },
      CairnWelcomeMeet: { mount: () => () => {} },
    },
  });
  return { win, urls, painted };
}

test("the welcome never opens Meet through an undetectable login: it goes to that provider's Connect", () => {
  const win = loadClientModule(["coach-link-client"]);
  const unknown = win.CairnCoachLink.model(unknownLoginBody());
  const env = welcomeScreen(unknown);
  env.win.CairnWelcome.open({ stage: "meet", agent: "claude" });
  assert.deepEqual(env.painted, ["connect:claude"]);
  assert.equal(env.urls.at(-1), "/app/welcome/connect?id=claude");

  const signed = win.CairnCoachLink.model({
    settings: {},
    agents: ROWS.map((a) => ({ ...a, usable: true, configured: true, signed_in: true })),
  });
  const ok = welcomeScreen(signed);
  ok.win.CairnWelcome.open({ stage: "meet", agent: "claude" });
  assert.deepEqual(ok.painted, ["meet:claude"]);
});

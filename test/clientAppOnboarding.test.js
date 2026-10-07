// First run (src/client/app/onboarding.ts): the boot decides whether the full-screen
// welcome opens, and at which stage. The welcome itself is the lazy "welcome" bundle,
// reached only through CairnCoachLink.openWelcome (coach-link-client.ts), so these
// drive the built boot module and the eager coach link with the bundle loader stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule } from "./_dom.mjs";

const PROVIDERS = [
  { name: "claude", label: "Claude", plan: "Claude Pro or Max", usable: false, present: false, installable: true, can_login: true },
  { name: "codex", label: "ChatGPT", plan: "Sign in with ChatGPT", usable: false, present: true, installable: true, can_login: true },
  { name: "stub", label: null, plan: null, usable: false, present: true },
];

function settingsBody({ onboarded = false, welcomed = false, usable = [], signedIn = usable } = {}) {
  return {
    settings: { onboarded, coach_welcomed: welcomed, art_enabled: false },
    agents: PROVIDERS.map((a) => ({
      ...a,
      usable: usable.includes(a.name),
      configured: signedIn.includes(a.name) ? true : null,
      signed_in: signedIn.includes(a.name),
    })),
  };
}

function load({ body = settingsBody(), pathname = "/", search = "", knownOnboarded = false } = {}) {
  const opened = [];
  const swr = new Map();
  const timers = [];
  const win = loadClientModule(["coach-link-client", "app-onboarding"], {
    globals: {
      location: { pathname, search, href: `http://cairn.local${pathname}${search}` },
      api: async (path) => {
        if (path === "/settings") return body;
        throw new Error(`unexpected ${path}`);
      },
      artEnabled: true,
      // The lazy loader: record what the welcome was asked to open.
      withBundle: (name, fn) => {
        opened.push(name);
        return fn();
      },
      CairnWelcome: { open: (opts) => opened.push(JSON.parse(JSON.stringify(opts))) },
      swrSet: (key, value) => swr.set(key, value),
      peekCached: (key) => (swr.has(key) ? { data: swr.get(key), fresh: true } : null),
      cachedApi: async () => body,
      swrInvalidate: (key) => swr.delete(key),
      setTimeout: (fn, ms) => {
        timers.push(ms);
        return 0;
      },
    },
  });
  if (knownOnboarded) win.localStorage.setItem("cairn.onboarded", "1");
  return { win, opened, swr, timers };
}

test("a fresh install opens the welcome at Hello, replacing the landing entry", async () => {
  const env = load();
  assert.equal(typeof env.win.maybeOnboard, "function");
  assert.equal(typeof env.win.window.openOnboarding, "function");
  await env.win.maybeOnboard();
  assert.equal(env.win.artEnabled, false, "the art setting still rides the boot read");
  assert.deepEqual(env.opened, ["welcome", { stage: "hello", replace: true }]);
  assert.ok(env.swr.has("coach-link"), "the coach link's model is primed for the stage's first paint");
});

test("an AI already signed in on the server skips straight to meeting the coach", async () => {
  const env = load({ body: settingsBody({ usable: ["codex"] }) });
  await env.win.maybeOnboard();
  assert.deepEqual(env.opened, ["welcome", { stage: "meet", agent: "codex", replace: true }]);
});

test("an AI whose sign-in the server cannot read opens Hello, never Meet", async () => {
  const env = load({ body: settingsBody({ usable: ["codex"], signedIn: [] }) });
  await env.win.maybeOnboard();
  assert.deepEqual(env.opened, ["welcome", { stage: "hello", replace: true }]);
});

test("an onboarded install opens nothing and remembers it on this browser", async () => {
  const env = load({ body: settingsBody({ onboarded: true }) });
  await env.win.maybeOnboard();
  assert.deepEqual(env.opened, []);
  assert.equal(env.win.localStorage.getItem("cairn.onboarded"), "1");
  assert.equal(env.win.document.body.classList.contains("welcome-pending"), false);
});

test("a welcome address reopens its own stage whatever the onboarding state", async () => {
  const env = load({ body: settingsBody({ onboarded: true }), pathname: "/app/welcome/connect", search: "?id=claude" });
  await env.win.maybeOnboard();
  assert.deepEqual(env.opened, ["welcome", { stage: "connect", agent: "claude", replace: true }]);
});

test("a browser that never saw this install onboarded hides the shell until the boot decides", () => {
  const fresh = load();
  assert.equal(fresh.win.document.body.classList.contains("welcome-pending"), true);
  assert.ok(fresh.timers.includes(4000), "with a fail-safe that lifts it");
});

test("an unreachable server never traps anyone in the welcome", async () => {
  const env = load();
  env.win.api = async () => {
    throw new Error("offline");
  };
  await env.win.maybeOnboard();
  assert.deepEqual(env.opened, []);
});

test("older callers of openOnboarding land on the welcome's Hello", () => {
  const env = load();
  env.win.openOnboarding();
  assert.deepEqual(env.opened, ["welcome", { stage: "hello" }]);
});

test("the coach link reads providers from the server, never the offline stub", () => {
  const env = load();
  const model = env.win.CairnCoachLink.model(settingsBody({ usable: ["codex"] }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(model.providers.map((p) => [p.name, p.label, p.plan]))),
    [
      ["claude", "Claude", "Claude Pro or Max"],
      ["codex", "ChatGPT", "Sign in with ChatGPT"],
    ]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(model.usable.map((p) => p.name))), ["codex"]);
  assert.equal(model.welcomed, false);
  // An older server with no coach_welcomed reads as already welcomed: no card it cannot clear.
  assert.equal(env.win.CairnCoachLink.model({ settings: {}, agents: [] }).welcomed, true);
});

test("Today's line: connect without a coach, say hello once one is connected, nothing after", () => {
  const env = load();
  const link = env.win.CairnCoachLink;
  assert.match(link.cardHtml("today-connect"), /Connect your coach to get your first week\./);
  assert.match(link.cardHtml("today-connect"), /data-clink-go="hello"/);
  assert.match(link.cardHtml("today-hello"), /Say hello/);
  assert.match(link.cardHtml("today-hello"), /data-clink-go="meet"/);
  assert.match(link.cardHtml("ask"), /Your coach isn't connected yet/);
  assert.doesNotMatch(link.cardHtml("ask"), /No agents enabled/);
});

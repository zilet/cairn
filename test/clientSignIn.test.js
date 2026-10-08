// The sign-in screen and the one passkey offer (lazy "auth" bundle): passkey first
// (only where it can work), then a pairing code, the access token folded away as the
// recovery path; the Home Screen line; nothing is ever stored on the device but the
// server's HttpOnly cookie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorage, flush, loadClientModule } from "./_dom.mjs";

function load({ fetchImpl, standalone = false, secure = true, passkeys = true, storage, extraGlobals = {} } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const out = fetchImpl ? await fetchImpl(url, init) : { status: 200, body: {} };
    return { status: out.status, ok: out.status >= 200 && out.status < 300, json: async () => out.body ?? {} };
  };
  const win = loadClientModule(["html-utils", "ui-sheet", "auth-passkey-client", "auth-offer-client", "auth-signin-client"], {
    globals: {
      fetch,
      isSecureContext: secure,
      PublicKeyCredential: passkeys ? function PublicKeyCredential() {} : undefined,
      matchMedia: () => ({ matches: standalone }),
      navigator: {},
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      clearTimeout() {},
      localStorage: storage || createStorage(),
      ...extraGlobals,
    },
  });
  return { win, calls };
}

const health = (passkeys) => async () => ({ ok: true, auth_required: true, auth_methods: { passkeys } });

test("a Home Screen app leads with the passkey, then the code, then the token — and says why", async () => {
  const { win } = load({ standalone: true });
  await win.CairnSignIn.openSignIn({ fetchHealth: health(true), reload() {} });
  const sheet = win.document.querySelector(".signin-sheet");
  assert.ok(sheet, "the sign-in sheet is open");
  const text = sheet.textContent;
  assert.match(text, /This Home Screen app needs its own sign-in — a passkey or a code from another device does it\./);
  const order = ["Sign in with passkey", "Enter a pairing code", "Use your access token"].map((s) => text.indexOf(s));
  assert.ok(
    order.every((i) => i >= 0),
    JSON.stringify(order)
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "passkey, then code, then token"
  );
});

test("no passkey offer where it cannot work: no secure context, or nothing registered", async () => {
  const insecure = load({ secure: false });
  await insecure.win.CairnSignIn.openSignIn({ fetchHealth: health(true), reload() {} });
  assert.equal(insecure.win.document.querySelector("[data-signin-passkey]"), null);
  const none = load();
  await none.win.CairnSignIn.openSignIn({ fetchHealth: health(false), reload() {} });
  assert.equal(none.win.document.querySelector("[data-signin-passkey]"), null);
  assert.ok(none.win.document.querySelector(".signin-code"), "the code path is always there");
});

test("a pairing code signs in through the server's cookie and arms the passkey offer; a bad one says so calmly", async () => {
  let status = 400;
  const { win, calls } = load({ fetchImpl: async () => ({ status }) });
  let reloaded = 0;
  await win.CairnSignIn.openSignIn({ fetchHealth: health(false), reload: () => reloaded++ });
  const input = win.document.querySelector(".signin-code");
  input.value = "abcd-efgh";
  win.document.querySelector("[data-signin-code-form]").dispatchEvent(new win.Event("submit", { cancelable: true }));
  await flush();
  await flush();
  const post = calls.find((c) => c.url === "/api/auth/pair");
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.init.body), { code: "abcd-efgh" });
  assert.equal(reloaded, 0);
  assert.match(win.document.querySelector(".token-sheet-err").textContent, /expired or already been used/);

  status = 200;
  win.document.querySelector("[data-signin-code-form]").dispatchEvent(new win.Event("submit", { cancelable: true }));
  await flush();
  await flush();
  assert.equal(reloaded, 1);
  assert.equal(win.sessionStorage.getItem("cairn.auth.offer"), "1");
});

test("the access token signs in as a Bearer header, is cleared from the field, and is never stored", async () => {
  const storage = createStorage({ cairn_token: "stale" });
  const { win, calls } = load({ fetchImpl: async () => ({ status: 200 }), storage });
  let reloaded = 0;
  await win.CairnSignIn.openSignIn({ fetchHealth: health(false), reload: () => reloaded++ });
  const form = win.document.querySelector("[data-signin-token-form]");
  const input = form.querySelector("input[name=token]");
  input.value = "  master-token  ";
  form.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await flush();
  await flush();
  const post = calls.find((c) => c.url === "/api/auth/session");
  assert.equal(post.init.headers.Authorization, "Bearer master-token");
  assert.equal(input.value, "");
  assert.equal(reloaded, 1);
  assert.equal(storage.getItem("cairn_token"), null, "no token on the device afterwards");
  for (let i = 0; i < storage.length; i++) assert.doesNotMatch(String(storage.getItem(storage.key(i))), /master-token/);
});

test("a sign-in that interrupted a connector's consent goes back to it (same-origin path only), not a cached reload", async () => {
  const run = async (oauthResume) => {
    const { win, calls } = load({
      fetchImpl: async (url) =>
        url === "/api/auth/status" ? { status: 200, body: { oauth_resume: oauthResume } } : { status: 200 },
    });
    let reloaded = 0;
    const went = [];
    await win.CairnSignIn.openSignIn({
      fetchHealth: health(false),
      reload: () => reloaded++,
      navigate: (p) => went.push(p),
    });
    win.document.querySelector(".signin-code").value = "abcd-efgh";
    win.document.querySelector("[data-signin-code-form]").dispatchEvent(new win.Event("submit", { cancelable: true }));
    for (let i = 0; i < 4; i++) await flush();
    assert.ok(calls.some((c) => c.url === "/api/auth/status"));
    return { reloaded, went };
  };
  const rid = "A".repeat(43);
  assert.deepEqual(await run(`/oauth/authorize?rid=${rid}`), { reloaded: 0, went: [`/oauth/authorize?rid=${rid}`] });
  for (const hostile of ["https://evil.example/oauth/authorize?rid=x", "//evil.example/x", "/app/today", null]) {
    assert.deepEqual(await run(hostile), { reloaded: 1, went: [] }, String(hostile));
  }
});

test("the passkey offer shows once for a device without one, and 'Not now' is remembered", async () => {
  const storage = createStorage();
  const { win } = load({ storage });
  win.api = async (path) => (path === "/auth/status" ? { device: { id: 1, has_passkey: false } } : null);
  win.sessionStorage.setItem("cairn.auth.offer", "1");
  await win.CairnSignIn.offerPasskeyWith({ toast() {} });
  const offer = win.document.querySelector(".passkey-offer-ov");
  assert.ok(offer, "offered");
  assert.match(offer.textContent, /Add a passkey so this device signs back in with Face ID \/ fingerprint\./);
  assert.equal(win.sessionStorage.getItem("cairn.auth.offer"), null, "the flag is spent");
  offer.querySelector("[data-offer-later]").click();
  assert.equal(storage.getItem("cairn.auth.passkey-offer"), "dismissed");
  await flush();
  win.sessionStorage.setItem("cairn.auth.offer", "1");
  await win.CairnSignIn.offerPasskeyWith({ toast() {} });
  assert.equal(win.document.querySelector(".passkey-offer-ov"), null, "never asked again");

  // A device that already has one is never asked.
  const has = load();
  has.win.api = async () => ({ device: { id: 1, has_passkey: true } });
  await has.win.CairnSignIn.offerPasskeyWith({ toast() {} });
  assert.equal(has.win.document.querySelector(".passkey-offer-ov"), null);
});

const fv = (extra) => async () => ({
  ok: true,
  auth_required: true,
  auth_methods: { passkeys: false },
  first_visit: { platform: null, host_settings_url: null, log_code: false, ...extra },
});
const RW =
  "https://railway.com/project/11111111-2222-3333-4444-555555555555/service/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/variables?environmentId=99999999-8888-7777-6666-000000000000";

test("first visit on Railway leads with where the token lives, a Variables link, and an open token form", async () => {
  const { win } = load();
  await win.CairnSignIn.openSignIn({
    fetchHealth: fv({ platform: "railway", host_settings_url: RW, log_code: true }),
    reload() {},
  });
  const sheet = win.document.querySelector(".signin-sheet");
  const text = sheet.textContent;
  assert.match(text, /First time here\?/);
  assert.match(text, /created when Cairn was deployed/);
  assert.match(text, /cairn service, then Variables, and copy CAIRN_AUTH_TOKEN/);
  assert.match(text, /deploy logs: the first sign-in line has a one-time code/);
  const a = sheet.querySelector(".signin-first-btn");
  assert.equal(a.getAttribute("href"), RW);
  assert.equal(a.getAttribute("target"), "_blank");
  assert.match(a.getAttribute("rel"), /noopener/);
  assert.equal(sheet.querySelector("details"), null, "the token form is not folded");
  assert.ok(sheet.querySelector("[data-signin-token-form] input[name=token]"));
  assert.ok(text.indexOf("First time here?") < text.indexOf("Enter a pairing code"));
});

test("first visit via the installer and plain Docker: no link, platform-specific words", async () => {
  const inst = load();
  await inst.win.CairnSignIn.openSignIn({ fetchHealth: fv({ platform: "installer" }), reload() {} });
  const t1 = inst.win.document.querySelector(".signin-sheet");
  assert.match(t1.textContent, /installer printed it/);
  assert.match(t1.textContent, /cairn\.sh status/);
  assert.equal(t1.querySelector(".signin-first-btn"), null);
  assert.doesNotMatch(t1.textContent, /Or open the deploy logs/);
  const dock = load();
  await dock.win.CairnSignIn.openSignIn({ fetchHealth: fv({ platform: "docker" }), reload() {} });
  assert.match(
    dock.win.document.querySelector(".signin-sheet").textContent,
    /CAIRN_AUTH_TOKEN in your server's settings/
  );
});

test("first visit never links anything but a well-formed Railway variables address, and escapes it", async () => {
  const evil = 'https://evil.example/"><script>x</script>';
  const { win } = load();
  await win.CairnSignIn.openSignIn({ fetchHealth: fv({ platform: "railway", host_settings_url: evil }), reload() {} });
  const sheet = win.document.querySelector(".signin-sheet");
  assert.equal(sheet.querySelector(".signin-first-btn"), null);
  assert.equal(sheet.querySelector("script"), null);
  const off = load();
  await off.win.CairnSignIn.openSignIn({ fetchHealth: health(false), reload() {} });
  const plain = off.win.document.querySelector(".signin-sheet");
  assert.equal(plain.textContent.includes("First time here?"), false, "no first_visit, the screen is unchanged");
  assert.ok(plain.querySelector("details.signin-recovery"));
});

test("the passkey offer after a first sign-in says why and points at pairing the phone", async () => {
  const { win } = load({ fetchImpl: async () => ({ status: 200, body: { device: { has_passkey: false } } }) });
  win.api = async () => ({ device: { has_passkey: false } });
  win.sessionStorage.setItem("cairn.auth.offer", "first");
  await win.CairnSignIn.offerPasskeyWith({ doc: win.document });
  const text = win.document.querySelector(".passkey-offer-ov")?.textContent || "";
  assert.match(text, /never need the access token again/);
  assert.match(text, /Settings → Devices → Pair a device/);
});

test("the passkey offer waits while the welcome is up, and keeps its first-sign-in flag", async () => {
  const { win } = load();
  const held = win.CairnSignIn.offerHeldByWelcome;
  assert.equal(held({ bodyClasses: ["welcome-open"], pathname: "/" }), true);
  assert.equal(held({ bodyClasses: ["welcome-pending"], pathname: "/" }), true);
  assert.equal(held({ bodyClasses: ["welcome-undecided"], pathname: "/" }), true, "onboarding has not decided yet");
  assert.equal(held({ bodyClasses: [], pathname: "/app/welcome/meet" }), true);
  assert.equal(held({ bodyClasses: [], pathname: "/app/today" }), false);
  win.api = async () => ({ device: { has_passkey: false } });
  win.sessionStorage.setItem("cairn.auth.offer", "first");
  win.document.body.classList.add("welcome-open");
  await win.CairnSignIn.offerPasskeyWith({ doc: win.document });
  assert.equal(win.document.querySelector(".passkey-offer-ov"), null, "nothing over the welcome");
  assert.equal(win.sessionStorage.getItem("cairn.auth.offer"), "first", "the flag waits for the welcome to finish");
});

test("a slow cold start: the fail-safe lifting welcome-pending does not release the offer; deciding and closing does, once", async () => {
  const observers = [];
  class FakeObserver {
    constructor(cb) {
      this.cb = cb;
      this.live = true;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.live = false;
    }
  }
  const { win } = load({ extraGlobals: { MutationObserver: FakeObserver } });
  win.api = async () => ({ device: { has_passkey: false } });
  win.sessionStorage.setItem("cairn.auth.offer", "first");
  const body = win.document.body;
  body.classList.add("welcome-pending", "welcome-undecided");
  await win.CairnSignIn.offerPasskeyWith({ doc: win.document });
  // The 4s fail-safe lifts the shell only.
  body.classList.remove("welcome-pending");
  observers.forEach((o) => o.live && o.cb());
  await flush();
  assert.equal(win.document.querySelector(".passkey-offer-ov"), null, "undecided: still waiting");
  // The boot decided: the welcome opens, then closes.
  body.classList.remove("welcome-undecided");
  body.classList.add("welcome-open");
  observers.forEach((o) => o.live && o.cb());
  await flush();
  assert.equal(win.document.querySelector(".passkey-offer-ov"), null, "welcome open");
  body.classList.remove("welcome-open");
  observers.forEach((o) => o.live && o.cb());
  await flush();
  await flush();
  assert.equal(win.document.querySelectorAll(".passkey-offer-ov").length, 1, "shown exactly once");
  assert.match(win.document.querySelector(".passkey-offer-ov").textContent, /never need the access token again/);
  observers.forEach((o) => o.live && o.cb());
  await flush();
  assert.equal(win.document.querySelectorAll(".passkey-offer-ov").length, 1, "and never again");
});

test("a first-visit sign-in marks the offer 'first' (token and code), a plain one marks '1'", async () => {
  for (const [kind, formSel, inputSel, val] of [
    ["token", "[data-signin-token-form]", "input[name=token]", "tok"],
    ["code", "[data-signin-code-form]", ".signin-code", "abcd-efgh"],
  ]) {
    const { win } = load({ fetchImpl: async () => ({ status: 200 }) });
    await win.CairnSignIn.openSignIn({ fetchHealth: fv({ platform: "docker" }), reload() {}, oauthResume: async () => null });
    win.document.querySelector(inputSel).value = val;
    win.document.querySelector(formSel).dispatchEvent(new win.Event("submit", { cancelable: true }));
    await flush();
    await flush();
    assert.equal(win.sessionStorage.getItem("cairn.auth.offer"), "first", kind);
  }
});

test("first-visit sign-in: the token input is labelled and described, one name for the secret", async () => {
  const { win } = load();
  await win.CairnSignIn.openSignIn({ fetchHealth: fv({ platform: "railway", log_code: true }), reload() {} });
  const sheet = win.document.querySelector(".signin-sheet");
  const input = sheet.querySelector("input[name=token]");
  assert.equal(input.getAttribute("aria-label"), null);
  assert.equal(sheet.querySelector(`label[for="${input.id}"]`)?.textContent, "Paste your access token");
  assert.match(sheet.querySelector(`#${input.getAttribute("aria-describedby")}`).textContent, /access token was created/);
  assert.doesNotMatch(sheet.textContent, /access code/);
  assert.match(sheet.textContent, /pairing code box below/);
  assert.match(sheet.textContent, /A one-time code from the deploy logs, or from Settings → Devices → Pair a device on a signed-in device\./);
});

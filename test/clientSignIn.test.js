// The sign-in screen and the one passkey offer (lazy "auth" bundle): passkey first
// (only where it can work), then a pairing code, the access token folded away as the
// recovery path; the Home Screen line; nothing is ever stored on the device but the
// server's HttpOnly cookie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorage, flush, loadClientModule } from "./_dom.mjs";

function load({ fetchImpl, standalone = false, secure = true, passkeys = true, storage } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const out = fetchImpl ? await fetchImpl(url, init) : { status: 200, body: {} };
    return { status: out.status, ok: out.status >= 200 && out.status < 300, json: async () => out.body ?? {} };
  };
  const win = loadClientModule(["html-utils", "ui-sheet", "auth-passkey-client", "auth-signin-client"], {
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
  assert.match(text, /Home Screen apps sign in on their own — a passkey or a code from another device does it\./);
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

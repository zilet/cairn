// The hosted-install client pieces: the pairing link consumed by index.html's inline
// boot script (`#pair=<CODE>` exchanged for a device session cookie, stripped from the
// address BEFORE anything else runs; a token an older build stored is exchanged and
// forgotten; a retired `?pair=<token>` link is stripped and never used), the Settings "Devices" card (pair a
// device, devices, passkeys), the "Update now" actions, and the feedback sheet's
// markup. Plus the server side of the pairing promise: telemetry never keeps a query
// string or a fragment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { earlyFetchScript } from "../dist/earlyFetch.js";
import { telemetryRequestPathLabel } from "../dist/telemetry-privacy.js";
import { createHost, createStorage, flush, loadClientModule } from "./_dom.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");

function runShell({ pathname = "/", search = "", hash = "", storage = {}, session = {}, crypto, respond = () => 200 }) {
  const calls = [];
  const replaced = [];
  const localStorage = createStorage(storage);
  const sessionStorage = createStorage(session);
  const location = { pathname, search, hash };
  const context = {
    location,
    history: {
      state: { s: 1 },
      replaceState: (state, _title, url) => {
        replaced.push({ state, url });
        const u = new URL(url, "https://x.invalid");
        location.search = u.search;
        location.hash = u.hash;
      },
    },
    localStorage,
    sessionStorage,
    URLSearchParams,
    JSON,
    Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "UTC" }) }) },
    fetch: (url, init) => {
      calls.push({ url, init });
      const status = respond(url, init);
      return Promise.resolve({ status, ok: status >= 200 && status < 300 });
    },
    document: { createElement: () => ({}), head: { appendChild() {} } },
    Uint8Array,
    ...(crypto ? { crypto } : {}),
  };
  context.window = context;
  vm.runInNewContext(earlyFetchScript(html), context);
  return { calls, replaced, localStorage, sessionStorage, context };
}

test("a #pair= link leaves the address first, is exchanged for a session, and holds the early reads", async () => {
  const shell = runShell({
    search: "?utm=x",
    hash: "#pair=abcd-efgh&top",
    storage: { "cairn.swr.v1.today": "{}", "cairn.other": "keep", cairn_token: "old" },
  });
  assert.deepEqual(shell.replaced, [{ state: { s: 1 }, url: "/?utm=x#top" }], "only pair= leaves the fragment");
  assert.equal(shell.calls.length, 1, "no early read races the pairing");
  const [call] = shell.calls;
  assert.equal(call.url, "/api/auth/pair");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(call.init.body), { code: "abcd-efgh" });
  assert.equal(call.init.headers.Authorization, undefined, "a code never travels as a credential header");
  assert.ok(shell.context.__cairnAuthReady, "api() waits on the exchange");
  await shell.context.__cairnAuthReady;
  assert.equal(shell.localStorage.getItem("cairn_token"), null, "a stored token is forgotten once the cookie stands");
  assert.equal(shell.localStorage.getItem("cairn.swr.v1.today"), null);
  assert.equal(shell.localStorage.getItem("cairn.other"), "keep");
  assert.equal(shell.sessionStorage.getItem("cairn.auth.offer"), "1", "the one passkey offer is armed");
});

test("a spent pairing code is remembered for the sign-in screen, never retried", async () => {
  const shell = runShell({ hash: "#pair=ABCD-EFGH", respond: () => 400 });
  await shell.context.__cairnAuthReady;
  assert.equal(shell.context.__cairnPairFailed, 400);
  assert.equal(shell.sessionStorage.getItem("cairn.auth.offer"), null);
  assert.equal(shell.calls.length, 1);
});

test("a retired ?pair=<token> link is stripped at once and never exchanged or stored", async () => {
  for (const respond of [() => 200, () => 503, () => 401]) {
    const shell = runShell({ search: "?pair=s3cr%2Bt&utm=x", hash: "#top", respond });
    assert.deepEqual(shell.replaced, [{ state: { s: 1 }, url: "/?utm=x#top" }], "it leaves the address bar first");
    assert.ok(!shell.calls.some((c) => c.url.startsWith("/api/auth/")), "nothing is exchanged");
    assert.ok(
      !shell.calls.some((c) => JSON.stringify(c.init || {}).includes("s3cr")),
      "the token never rides any request"
    );
    assert.equal(shell.context.__cairnAuthReady, undefined, "nothing waits on it");
    assert.equal(shell.context.__cairnRetiredPairLink, 1, "the sign-in screen will say the link is retired");
    await flush();
    assert.equal(shell.localStorage.getItem("cairn_token"), null, "never written to the device");
  }
  // A token an older build stored still migrates alongside (the one-time cookie swap).
  const both = runShell({ search: "?pair=abc", storage: { cairn_token: "tok" } });
  const swaps = both.calls.filter((c) => c.url === "/api/auth/session");
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].init.headers.Authorization, "Bearer tok");
});

test("a token an older build stored is swapped for a cookie in the background, then forgotten", async () => {
  const shell = runShell({ storage: { cairn_token: "tok" } });
  const exchange = shell.calls.find((c) => c.url === "/api/auth/session");
  assert.ok(exchange, "the stored token is exchanged");
  assert.equal(exchange.init.headers.Authorization, "Bearer tok");
  assert.equal(shell.context.__cairnAuthReady, undefined, "the old header still works meanwhile: nothing waits");
  assert.ok(
    shell.calls.some((c) => c.url.startsWith("/api/today")),
    "the early reads still start"
  );
  await flush();
  assert.equal(shell.localStorage.getItem("cairn_token"), null);

  // No credential anywhere: nothing to exchange, the early reads run as before.
  const plain = runShell({ search: "?tab=today" });
  assert.deepEqual(plain.replaced, []);
  assert.ok(!plain.calls.some((c) => c.url.startsWith("/api/auth/")));
});

test("every boot exchange carries this browser's device hint, minted once and kept", async () => {
  const bytes = (a) => {
    for (let i = 0; i < a.length; i++) a[i] = i;
    return a;
  };
  const first = runShell({ hash: "#pair=ABCD-EFGH", crypto: { getRandomValues: bytes } });
  const hint = first.localStorage.getItem("cairn.device-hint");
  assert.match(hint, /^[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse(first.calls[0].init.body), { code: "ABCD-EFGH", device_hint: hint });

  // A stored hint is reused as-is; the legacy-token swap carries it too.
  const again = runShell({ storage: { "cairn.device-hint": "kept-hint-0123456789", cairn_token: "tok" } });
  const swap = again.calls.find((c) => c.url === "/api/auth/session");
  assert.deepEqual(JSON.parse(swap.init.body), { device_hint: "kept-hint-0123456789" });
});

test("a reload that lands while this tab's token swap is in flight never starts a second one", async () => {
  // The tab's sessionStorage survives the reload; the swap a moment ago is still marked.
  const marked = runShell({
    storage: { cairn_token: "tok" },
    session: { "cairn.auth.swap": String(Date.now() - 2000) },
  });
  assert.equal(marked.calls.filter((c) => c.url === "/api/auth/session").length, 0, "one owner, one exchange");
  assert.equal(marked.localStorage.getItem("cairn_token"), "tok", "the header keeps working meanwhile");

  // A stale mark (that swap never finished) is retried; a settled swap clears the mark.
  const stale = runShell({
    storage: { cairn_token: "tok" },
    session: { "cairn.auth.swap": String(Date.now() - 60_000) },
  });
  assert.equal(stale.calls.filter((c) => c.url === "/api/auth/session").length, 1);
  await flush();
  assert.equal(stale.sessionStorage.getItem("cairn.auth.swap"), null);
});

test("server telemetry keeps a path, never its pair/token query or fragment", () => {
  for (const raw of [
    "/?pair=abc123",
    "/app/today?token=abc123&pair=x",
    "/api/today?pair=abc123#frag",
    "/#pair=abc123",
  ]) {
    const label = telemetryRequestPathLabel(raw);
    assert.doesNotMatch(label, /abc123|pair|token=/, raw);
  }
});

function loadSettingsHosting(globals = {}) {
  return loadClientModule(
    ["html-utils", "settings-update-client", "settings-pairing-view", "settings-pairing-client", "settings-feedback-client"],
    {
      globals,
    }
  );
}

test("pairingUrl puts the one-time code in the fragment, never the query", () => {
  const win = loadSettingsHosting();
  assert.equal(
    win.CairnSettingsPairing.pairingUrl("https://cairn.example.app/", "ABCD-EFGH"),
    "https://cairn.example.app/#pair=ABCD-EFGH"
  );
  assert.equal(win.CairnSettingsPairing.pairingCountdown(9 * 60_000 + 41_000), "9:41");
  assert.equal(win.CairnSettingsPairing.pairingCountdown(-5), "0:00");
});

function accessApi(overrides = {}) {
  const calls = [];
  const state = {
    devices: [
      {
        id: 1,
        name: "Milo's <iPhone>",
        user_agent_summary: "Safari on iPhone",
        last_seen_at: "2026-10-07T10:00:00Z",
        current: true,
        has_passkey: false,
      },
      {
        id: 2,
        name: "Laptop",
        user_agent_summary: "Chrome on Mac",
        last_seen_at: "2026-10-01T10:00:00Z",
        current: false,
        has_passkey: true,
      },
    ],
    passkeys: [{ id: 5, name: "Laptop", this_device: false, created_at: "2026-10-01T10:00:00Z" }],
    ...overrides,
  };
  const api = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || "GET", body: opts.body });
    if (path === "/health") return { auth_required: state.auth_required ?? true };
    if (path === "/auth/devices")
      return {
        devices: state.devices,
        revoke_others_removes_passkeys: state.revoke_others_removes_passkeys ?? [],
        revoke_others_disconnects_apps: state.revoke_others_disconnects_apps ?? [],
      };
    if (path === "/auth/passkeys") return { passkeys: state.passkeys };
    if (path === "/auth/pairing-codes")
      return { code: "ABCD-EFGH", expires_at: new Date(state.now + 600_000).toISOString() };
    if (path === "/auth/devices/1" && opts.method === "DELETE") return { ok: true, signed_out: true };
    if (path === "/auth/devices/2" && opts.method === "DELETE") return { ok: true, signed_out: false };
    return { ok: true };
  };
  return { api, calls, state };
}

test("Pair a device mints a one-time code, draws its link as a QR and counts down — never the token", async () => {
  const win = loadSettingsHosting();
  const host = createHost(win.document, { html: win.CairnSettingsPairing.accessCardHtml() });
  const now = Date.parse("2026-10-07T12:00:00Z");
  const { api, calls } = accessApi({ now });
  const encoded = [];
  const fakeFactory = () => ({
    addData: (data) => encoded.push(data),
    make() {},
    getModuleCount: () => 21,
    isDark: (r, c) => (r + c) % 2 === 0,
  });
  win.CairnSettingsPairing.wireAccessCard({
    root: host,
    api,
    origin: "https://cairn.example.app",
    document: win.document,
    loadQr: async () => fakeFactory,
    now: () => now,
    relTime: () => "6 days ago",
    passkeys: { supported: () => true, add: async () => ({ ok: true }) },
  });
  await flush();
  await flush();
  assert.equal(host.querySelector("#accessCard").hidden, false);
  assert.match(host.querySelector("#pairCard").textContent, /Pair a device/);
  await host.querySelector("[data-pair-show]").click();
  await flush();
  await flush();
  assert.ok(calls.some((c) => c.path === "/auth/pairing-codes" && c.method === "POST"));
  assert.deepEqual(encoded, ["https://cairn.example.app/#pair=ABCD-EFGH"]);
  assert.equal(host.querySelector(".pair-code").textContent, "ABCD-EFGH");
  assert.match(host.querySelector(".pair-expiry").textContent, /Works once · expires in 10:00/);
  const svg = host.querySelector(".pair-qr svg");
  assert.ok(svg, "the code is drawn");
  assert.equal(svg.getAttribute("viewBox"), "0 0 29 29", "21 modules plus a four-module quiet zone");
  await host.querySelector("[data-pair-hide]").click();
  assert.equal(host.querySelector(".pair-reveal").hidden, true);
  assert.equal(host.querySelector(".pair-qr svg"), null);
  assert.equal(host.querySelector(".pair-code").textContent, "");
});

test("Devices lists this device first-class, escapes names, and offers the recovery line", async () => {
  const win = loadSettingsHosting();
  const host = createHost(win.document, { html: win.CairnSettingsPairing.accessCardHtml() });
  const { api } = accessApi();
  win.CairnSettingsPairing.wireAccessCard({
    root: host,
    api,
    origin: "x",
    document: win.document,
    relTime: () => "6 days ago",
    passkeys: { supported: () => true, add: async () => ({ ok: true }) },
  });
  await flush();
  await flush();
  const rows = host.querySelectorAll("[data-device-id]");
  assert.equal(rows.length, 2);
  assert.match(rows[0].innerHTML, /Milo&#39;s &lt;iPhone&gt;|Milo's &lt;iPhone&gt;/);
  assert.match(rows[0].textContent, /This device/);
  assert.match(rows[1].textContent, /Chrome on Mac · Last seen 6 days ago/);
  assert.equal(host.querySelector("[data-access-revoke-others]").hidden, false);
  assert.equal(host.querySelector("[data-access-add-passkey]").hidden, false, "this device has no passkey yet");
  assert.match(host.querySelector(".access-recovery").textContent, /CAIRN_AUTH_TOKEN/);
  assert.doesNotMatch(host.innerHTML, /Bearer|token=/);
});

test("signing THIS device out asks first and names the ways back in; another device signs out at once", async () => {
  const win = loadSettingsHosting();
  const host = createHost(win.document, { html: win.CairnSettingsPairing.accessCardHtml() });
  const { api, calls } = accessApi();
  const asked = [];
  let answer = false;
  let reloaded = 0;
  const toasts = [];
  win.CairnSettingsPairing.wireAccessCard({
    root: host,
    api,
    origin: "x",
    document: win.document,
    relTime: () => "now",
    toast: (m) => toasts.push(m),
    reload: () => reloaded++,
    confirm: async (opts) => {
      asked.push(opts);
      return answer;
    },
    passkeys: { supported: () => false, add: async () => ({ ok: false }) },
  });
  await flush();
  await flush();
  const revokeOf = (id) => host.querySelector(`[data-device-id="${id}"] [data-device-revoke]`);
  await revokeOf(1).click();
  await flush();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "Sign out this device?");
  assert.match(asked[0].body, /pairing code from another signed-in device/);
  assert.match(asked[0].body, /access token/);
  assert.ok(!calls.some((c) => c.method === "DELETE"), "Cancel signs nothing out");

  answer = true;
  await revokeOf(1).click();
  await flush();
  await flush();
  assert.ok(calls.some((c) => c.path === "/auth/devices/1" && c.method === "DELETE"));
  assert.equal(reloaded, 1, "signing this device out lands on the sign-in screen");

  await revokeOf(2).click();
  await flush();
  await flush();
  assert.equal(asked.length, 3, "another device now asks first, in plain words");
  assert.match(asked[2].body, /will need a new sign-in/);
  assert.deepEqual(toasts, ["Signed out Laptop."]);
  assert.equal(host.querySelector("[data-access-passkey-note]").hidden, false, "no secure context: say why");

  assert.match(win.CairnSettingsPairing.waysBackInHtml(true), /this device&#39;s passkey|this device's passkey/);
});

test("signing out a device that holds passkeys, or every other device, names the passkeys that go first", async () => {
  const win = loadSettingsHosting();
  const host = createHost(win.document, { html: win.CairnSettingsPairing.accessCardHtml() });
  const { api, calls, state } = accessApi();
  state.devices[1].revoke_removes_passkeys = [{ id: 5, name: "Laptop <key>" }];
  state.devices[1].revoke_disconnects_apps = [{ id: 9, name: "Claude <app>" }];
  state.revoke_others_disconnects_apps = [{ id: 9, name: "Claude <app>" }];
  state.revoke_others_removes_passkeys = [
    { id: 5, name: "Laptop <key>" },
    { id: 6, name: "Added with the token" },
  ];
  const asked = [];
  let answer = false;
  win.CairnSettingsPairing.wireAccessCard({
    root: host,
    api,
    origin: "x",
    document: win.document,
    relTime: () => "now",
    toast: () => {},
    confirm: async (opts) => {
      asked.push(opts);
      return answer;
    },
    passkeys: { supported: () => false, add: async () => ({ ok: false }) },
  });
  await flush();
  await flush();
  await host.querySelector(`[data-device-id="2"] [data-device-revoke]`).click();
  await flush();
  assert.equal(asked.length, 1, "a device that takes passkeys with it asks first");
  assert.equal(asked[0].title, "Sign out Laptop?");
  assert.match(asked[0].body, /Laptop &lt;key&gt;/, "names are escaped");
  assert.doesNotMatch(asked[0].body, /<key>/);
  assert.match(asked[0].body, /disconnects the AI app it connected: <b>Claude &lt;app&gt;<\/b>/, "AI apps it made are named too");
  assert.ok(!calls.some((c) => c.method === "DELETE"), "Cancel removes nothing");

  await host.querySelector("[data-access-revoke-others]").click();
  await flush();
  assert.equal(asked.length, 2);
  assert.equal(asked[1].title, "Sign out every other device?");
  assert.match(asked[1].body, /Added with the token/);
  assert.match(asked[1].body, /Claude &lt;app&gt;/, "sign-out-others names the AI apps it disconnects");
  assert.ok(!calls.some((c) => c.path === "/auth/devices/revoke-others"), "Cancel signs nobody out");
  answer = true;
  state.revoke_others_removes_passkeys = []; // what the refresh after this sign-out reads
  await host.querySelector("[data-access-revoke-others]").click();
  await flush();
  await flush();
  assert.ok(calls.some((c) => c.path === "/auth/devices/revoke-others" && c.method === "POST"));

  // With nothing listed, the sheet still says passkeys not tied to this device go too.
  await host.querySelector("[data-access-revoke-others]").click();
  await flush();
  await flush();
  assert.match(asked.at(-1).body, /not tied to this device/);
});

test("the Devices card stays hidden on an open (no-token) instance, and the tab says why", async () => {
  const win = loadSettingsHosting();
  const host = createHost(win.document, { html: win.CairnSettingsPairing.devicesSliceHtml() });
  const off = host.querySelector("[data-access-off]");
  assert.equal(off.hidden, true, "nothing is claimed before the server answers");
  const { api, calls } = accessApi({ auth_required: false });
  win.CairnSettingsPairing.wireAccessCard({ root: host, api, origin: "x", document: win.document });
  await flush();
  assert.equal(host.querySelector("#accessCard").hidden, true);
  assert.equal(off.hidden, false);
  assert.match(off.textContent, /Sign-in is off on this Cairn/);
  assert.ok(!calls.some((c) => c.path.startsWith("/auth/")));

  // Sign-in on: the card shows and the open-instance line stays away.
  const on = createHost(win.document, { html: win.CairnSettingsPairing.devicesSliceHtml() });
  win.CairnSettingsPairing.wireAccessCard({ root: on, api: accessApi().api, origin: "x", document: win.document });
  await flush();
  assert.equal(on.querySelector("#accessCard").hidden, false);
  assert.equal(on.querySelector("[data-access-off]").hidden, true);
});

test("the update actions print the server's sentence and offer Update now only when it can act", async () => {
  const win = loadSettingsHosting();
  const U = win.CairnSettingsUpdate;
  assert.equal(U.updateActionsHtml(null), "");
  const railway = U.updateActionsHtml({
    update_how: "Your host installs <new> releases automatically.",
    update_method: "automatic",
    update_available: true,
    latest: "2.1.0",
    can_apply: false,
  });
  assert.match(railway, /installs &lt;new&gt; releases/);
  assert.doesNotMatch(railway, /data-update-apply/);
  const stale = U.updateActionsHtml(
    {
      update_how: "x",
      update_method: "trigger_file",
      updater: { last_run: "2026-10-01T00:00:00Z", stale: true },
      can_apply: true,
      update_available: false,
    },
    { relTime: () => "6 days ago" }
  );
  assert.match(stale, /last ran 6 days ago — more than three days ago/);
  assert.doesNotMatch(stale, /data-update-apply/, "nothing newer: no button");

  const host = createHost(win.document, {
    html: U.updateActionsHtml({
      update_how: "x",
      update_method: "deploy_hook",
      can_apply: true,
      update_available: true,
      latest: "2.1.0",
    }),
  });
  const posted = [];
  U.wireUpdateActions({
    host,
    api: async (path, opts) => {
      posted.push([path, opts.method, opts.acceptErrorBody]);
      return { ok: true, method: "deploy_hook", message: "Your host is rebuilding Cairn." };
    },
  });
  assert.match(host.querySelector("[data-update-apply]").textContent, /Update to v2\.1\.0/);
  await host.querySelector("[data-update-apply]").click();
  await flush();
  assert.deepEqual(posted, [["/update/apply", "POST", true]]);
  assert.match(host.querySelector(".upd-result").textContent, /^Your host is rebuilding Cairn\. .*back in about a minute\.$/);
  assert.equal(host.querySelector("[data-update-apply]").hidden, true);
});

test("the feedback sheet escapes what it prints and names the GitHub fallback plainly", () => {
  const win = loadSettingsHosting();
  const F = win.CairnSettingsFeedback;
  const sheet = F.feedbackSheetHtml();
  assert.match(sheet, /Include anonymous diagnostics/);
  assert.match(sheet, /data-fbk-kind="bug"/);
  assert.match(sheet, /aria-pressed="true" data-fbk-kind="bug"/);
  const done = F.feedbackDoneHtml(
    { ok: true, method: "github", url: 'https://github.com/zilet/cairn/issues/new?title=a"b' },
    false
  );
  assert.match(done, /href="https:\/\/github\.com\/zilet\/cairn\/issues\/new\?title=a&quot;b"/);
  assert.match(done, /rel="noopener noreferrer"/);
  const failed = F.feedbackDoneHtml(
    { ok: false, method: "service", error: "<down>", url: "https://github.com/x" },
    false
  );
  assert.match(failed, /&lt;down&gt;/);
  const sent = F.feedbackDoneHtml({ ok: true, method: "service", message: "Thanks" }, false);
  assert.doesNotMatch(sent, /github/i);
});

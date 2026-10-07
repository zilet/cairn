// The installed app's identity on the client: when the one-time iOS re-add note
// shows (and when it must not), what it says must be re-entered, and Settings ->
// Data's "This app" block (server build, this app's shell, Copy token).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, createStorage, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function load(globals = {}) {
  return loadClientModule(
    ["html-utils", "ui-actions-client", "app-identity-model", "app-identity-client", "app-identity-controller"],
    { globals }
  );
}

test("the identity version is the icon suffix, and the note fires once for installs the real bump left behind", () => {
  const { CairnAppIdentityModel: model } = load();
  assert.equal(model.VERSION, 3, "bumped only by scripts/bump-icons.mjs");
  assert.equal(model.PRE_STAMP_VERSION, 2, "frozen: what every install made before the stamp was added with");
  assert.equal(model.STAMP_KEY, "cairn.app.identity.v1");
  assert.equal(model.DISMISS_KEY, "cairn.app.readd.dismissed.v1");
  // A brand-new device (no prior state) always stamps itself at whatever is
  // current today, so it never sees the note.
  const fresh = model.stampFor(null, false, model.VERSION);
  assert.equal(
    model.noteVisible({ iosStandalone: true, outboxCount: 0, installedWith: fresh, dismissedFor: 0, current: model.VERSION }),
    false
  );
  // An install that predates the stamp is frozen at PRE_STAMP_VERSION (2), which
  // this real icon bump has now moved past (VERSION 3) — that install genuinely
  // was added under the old identity, so the one-time re-add note is correctly ON.
  const predatesStamp = model.stampFor(null, true, model.VERSION);
  assert.equal(predatesStamp, model.PRE_STAMP_VERSION);
  assert.equal(
    model.noteVisible({ iosStandalone: true, outboxCount: 0, installedWith: predatesStamp, dismissedFor: 0, current: model.VERSION }),
    true
  );
});

test("iOS standalone is navigator.standalone, or display-mode standalone on an iOS user agent", () => {
  const { CairnAppIdentityModel: model } = load();
  assert.equal(model.isIOSStandalone({ userAgent: IPHONE_UA, navigatorStandalone: true }), true);
  assert.equal(model.isIOSStandalone({ userAgent: IPHONE_UA, displayStandalone: true }), true);
  assert.equal(model.isIOSStandalone({ userAgent: IPAD_UA, maxTouchPoints: 5, displayStandalone: true }), true);
  assert.equal(model.isIOSStandalone({ userAgent: IPHONE_UA }), false, "Safari tab");
  assert.equal(
    model.isIOSStandalone({ userAgent: ANDROID_UA, displayStandalone: true }),
    false,
    "Android updates in place"
  );
  assert.equal(
    model.isIOSStandalone({ userAgent: IPAD_UA, maxTouchPoints: 0, displayStandalone: true }),
    false,
    "a Mac"
  );
});

test("the note shows once per identity: iOS standalone, empty outbox, an older install, not yet dismissed", () => {
  const { CairnAppIdentityModel: model } = load();
  const base = { iosStandalone: true, outboxCount: 0, installedWith: 2, dismissedFor: 0, current: 3 };
  assert.equal(model.noteVisible(base), true);
  assert.equal(model.noteVisible({ ...base, iosStandalone: false }), false);
  assert.equal(model.noteVisible({ ...base, outboxCount: 1 }), false, "a re-add would lose what waits to sync");
  assert.equal(model.noteVisible({ ...base, outboxCount: Number.NaN }), false);
  assert.equal(model.noteVisible({ ...base, installedWith: 3 }), false, "added with the current icon already");
  assert.equal(model.noteVisible({ ...base, installedWith: 0 }), false, "no stamp read");
  assert.equal(model.noteVisible({ ...base, dismissedFor: 3 }), false, "never again after dismissal");
  assert.equal(model.noteVisible({ ...base, dismissedFor: 3, current: 4 }), true, "the next identity asks once more");
  // The stamp: a stored one wins; an empty install was just added; prior state predates it.
  assert.equal(model.stampFor("2", false, 3), 2);
  assert.equal(model.stampFor(null, false, 3), 3);
  assert.equal(model.stampFor(null, true, 3), 2);
  assert.equal(model.stampFor("junk", true, 3), 2);
});

test("stampInstall tells a just-added install from an old one by what storage already holds", () => {
  const { CairnAppIdentityController: ctl, CairnAppIdentityModel: model } = load();
  const fresh = createStorage({ "cairn.diagnostics.v1": "[]" });
  assert.equal(ctl.stampInstall(fresh, 3), 3, "a diagnostics row alone is not prior state");
  assert.equal(fresh.getItem(model.STAMP_KEY), "3");
  const old = createStorage({ "cairn-art-ready": "[]" });
  assert.equal(ctl.stampInstall(old, 3), 2);
  assert.equal(old.getItem(model.STAMP_KEY), "2");
  assert.equal(ctl.stampInstall(old, 4), 2, "the stamp never moves once written");
  assert.equal(ctl.stampInstall(createStorage({ restSec: "90" }), 3), 2);
  assert.equal(ctl.stampInstall(null, 3), 3);
});

test("the re-add note lists exactly what this phone would need entered again", () => {
  const win = load();
  const model = win.CairnAppIdentityModel;
  const storage = createStorage({ cairn_token: "s3cret-token", "cairn-bm-unit": "cm", restSec: "120" });
  const reentry = model.reentry((key) => storage.getItem(key));
  assert.deepEqual(JSON.parse(JSON.stringify(reentry)), {
    preferences: ["your body measurement units", "your rest timer length"],
  });
  const host = renderHtml(win.CairnAppIdentity.readdNoteHtml(reentry), { document: win.document });
  const text = host.textContent;
  assert.match(text, /new icon and name/);
  assert.match(text, /only if you like/);
  assert.match(text, /these would need entering again: your body measurement units and your rest timer length/);
  // Signing in is never a re-entry chore: a Home Screen app signs itself in.
  assert.doesNotMatch(text, /access token/);
  assert.match(text, /the Home Screen app needs its own sign-in: a passkey or a pairing code/);
  assert.doesNotMatch(text, /s3cret/, "the note never shows the token");
  assert.ok(host.querySelector("button[data-readd-dismiss]"));

  const bare = renderHtml(win.CairnAppIdentity.readdNoteHtml(model.reentry(() => null)), { document: win.document });
  assert.match(bare.textContent, /Nothing needs entering again/);
  assert.match(bare.textContent, /needs its own sign-in/);
});

test("mountReaddNote shows only when the rules say so, and dismissal is remembered for this identity", async () => {
  const win = load();
  const model = win.CairnAppIdentityModel;
  const ctl = win.CairnAppIdentityController;
  const env = { userAgent: IPHONE_UA, navigatorStandalone: true };
  const storage = createStorage({ [model.STAMP_KEY]: "2" });

  const off = createHost(win.document, { html: "<p>Brief</p>" });
  ctl.mountReaddNote(off, { storage, env, outboxCount: () => 0, version: 2 });
  assert.equal(off.querySelector(".app-readd"), null, "OFF at the shipped identity");

  const busy = createHost(win.document);
  ctl.mountReaddNote(busy, { storage, env, outboxCount: () => 2, version: 3 });
  assert.equal(busy.querySelector(".app-readd"), null, "never while the outbox holds anything");

  const safari = createHost(win.document);
  ctl.mountReaddNote(safari, { storage, env: { userAgent: IPHONE_UA }, outboxCount: () => 0, version: 3 });
  assert.equal(safari.querySelector(".app-readd"), null);

  const host = createHost(win.document, { html: "<p>Brief</p>" });
  ctl.mountReaddNote(host, { storage, env, outboxCount: () => 0, version: 3 });
  ctl.mountReaddNote(host, { storage, env, outboxCount: () => 0, version: 3 });
  assert.equal(host.querySelectorAll(".app-readd").length, 1, "one note, however often Today repaints");
  assert.equal(host.querySelector("p").textContent, "Brief", "appended below, never replacing the surface");

  await host.querySelector("[data-readd-dismiss]").click();
  assert.equal(host.querySelector(".app-readd"), null);
  assert.equal(storage.getItem(model.DISMISS_KEY), "3");

  const again = createHost(win.document);
  ctl.mountReaddNote(again, { storage, env, outboxCount: () => 0, version: 3 });
  assert.equal(again.querySelector(".app-readd"), null, "never again after dismissal");
});

function cardDeps(overrides = {}) {
  const toasts = [];
  const calls = [];
  const deps = {
    api: async (path) => {
      calls.push(path);
      return {
        ok: true,
        version: "2.0.0",
        build: { version: "2.0.0", build_id: "abc123def456" },
        shell: "cairn-111111111111",
      };
    },
    storage: createStorage({ cairn_token: "tok-XYZ" }),
    toast: (message) => toasts.push(message),
    clipboard: null,
    workerShell: async () => "cairn-111111111111",
    ...overrides,
  };
  return { deps, toasts, calls };
}

test("Settings shows the server build and whether this app runs the server's current shell", async () => {
  const win = load();
  const ctl = win.CairnAppIdentityController;
  const host = createHost(win.document);
  const { deps, calls } = cardDeps();
  ctl.mountAppCard(host, deps);
  assert.match(host.textContent, /Checking this app's shell/);
  await flush();
  assert.deepEqual(calls, ["/health"]);
  assert.equal(host.querySelector(".app-id-row dd code").textContent, "2.0.0@abc123def456");
  assert.equal(host.querySelector(".app-id").dataset.appidShellState, "current");
  assert.match(host.textContent, /cairn-111111111111/);
  assert.match(host.textContent, /running the server's current shell/);

  const behind = createHost(win.document);
  ctl.mountAppCard(behind, cardDeps({ workerShell: async () => "cairn-000000000000" }).deps);
  await flush();
  assert.equal(behind.querySelector(".app-id").dataset.appidShellState, "behind");
  assert.match(behind.textContent, /lands the next time Cairn opens/);

  const none = createHost(win.document);
  ctl.mountAppCard(none, cardDeps({ workerShell: async () => "" }).deps);
  await flush();
  assert.equal(none.querySelector(".app-id").dataset.appidShellState, "none");

  const silent = createHost(win.document);
  ctl.mountAppCard(
    silent,
    cardDeps({
      api: async () => {
        throw new Error("offline");
      },
      workerShell: async () => null,
    }).deps
  );
  await flush();
  assert.equal(silent.querySelector(".app-id").dataset.appidShellState, "unknown");
  assert.equal(silent.querySelector(".app-id-row dd code").textContent, "Not reported");

  const gone = createHost(win.document);
  ctl.mountAppCard(gone, cardDeps().deps);
  gone.remove();
  await flush();
  assert.match(gone.textContent, /Checking/, "a detached card is never repainted");
});

test("the This app block never offers the access token, even when an older build stored one", async () => {
  const win = load();
  const host = createHost(win.document);
  // cardDeps' storage still holds a legacy cairn_token: the block ignores it.
  win.CairnAppIdentityController.mountAppCard(host, cardDeps().deps);
  await flush();
  assert.equal(host.querySelector("[data-appid-copy-token]"), null);
  assert.equal(host.querySelector(".app-id-token-field"), null);
  assert.doesNotMatch(host.innerHTML, /tok-XYZ|Copy token/);
});

test("workerShell asks the controlling worker over a MessageChannel and gives up quietly", async () => {
  const win = load({ MessageChannel });
  const ctl = win.CairnAppIdentityController;
  assert.equal(await ctl.workerShell({ serviceWorker: { controller: null } }), "", "no worker yet");
  assert.equal(await ctl.workerShell({}), "");
  const answering = {
    serviceWorker: {
      controller: {
        postMessage(data, [port]) {
          assert.equal(data.type, "cairn-shell");
          port.postMessage({ shell: "cairn-abc" });
        },
      },
    },
  };
  assert.equal(await ctl.workerShell(answering, () => new Promise(() => {})), "cairn-abc");
  const mute = { serviceWorker: { controller: { postMessage() {} } } };
  assert.equal(await ctl.workerShell(mute, () => Promise.resolve()), null, "an older worker never answers");
});

test("Settings -> Data mounts the This app block under Cairn version", async () => {
  const win = loadClientModule(
    [
      "html-utils",
      "ui-actions-client",
      "app-identity-model",
      "app-identity-client",
      "app-identity-controller",
      "settings-data-controller",
    ],
    {
      globals: {
        CairnSettingsData: {
          phoneAccessCardHtml: () => "",
          wirePhoneAccessCard: () => {},
          wireExerciseGuideCard: () => {},
        },
      },
    }
  );
  const root = createHost(win.document);
  const { deps } = cardDeps();
  win.CairnSettingsDataController.render({
    root,
    workingModel: { update_check_enabled: false },
    api: async () => null,
    toast: () => {},
    markDirty: () => {},
    updateCardHtml: () => "",
    withToken: (p) => p,
    downloadFile: () => {},
    reload: () => {},
    inStandaloneApp: true,
    appIdentity: deps,
  });
  await flush();
  const card = root.querySelector("#appIdentityCard");
  assert.ok(card, "the block sits in the Data slice, standalone or not");
  assert.equal(card.querySelector(".app-id-row dd code").textContent, "2.0.0@abc123def456");
  assert.equal(card.querySelector("[data-appid-copy-token]"), null, "no Copy token: Home Screen apps sign in on their own");
});

test("an installed app's Today gets no install coach — on iOS, the re-add note when the rules say so", () => {
  const run = ({ ua, standalone, stamp, outbox = 0 }) => {
    const storage = createStorage(stamp ? { "cairn.app.identity.v1": stamp } : {});
    const win = loadClientModule(
      [
        "html-utils",
        "ui-actions-client",
        "app-identity-model",
        "app-identity-client",
        "app-identity-controller",
        "pwa-install-coach",
      ],
      {
        globals: {
          localStorage: storage,
          // navigator.standalone exists only in iOS WebKit.
          navigator: { userAgent: ua, maxTouchPoints: 5, ...(ua === IPHONE_UA ? { standalone } : {}) },
          matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" && standalone }),
          CairnOutbox: { count: () => outbox },
        },
      }
    );
    const main = createHost(win.document, { html: "<p>Brief</p>" });
    win.renderPhoneCoachBanner(main);
    return main;
  };
  // Stamp "1" stands in for an install that predates the next identity.
  const older = run({ ua: IPHONE_UA, standalone: true, stamp: "1" });
  assert.ok(older.querySelector(".app-readd"));
  assert.equal(older.querySelector(".phone-coach"), null);
  assert.equal(run({ ua: IPHONE_UA, standalone: true, stamp: "1", outbox: 3 }).querySelector(".app-readd"), null);
  assert.equal(run({ ua: IPHONE_UA, standalone: true, stamp: "3" }).querySelector(".app-readd"), null, "OFF today");
  const fresh = run({ ua: IPHONE_UA, standalone: true });
  assert.equal(fresh.querySelector(".app-readd"), null, "a just-added app stamps itself current at load");
  const android = run({ ua: ANDROID_UA, standalone: true, stamp: "1" });
  assert.equal(android.querySelector(".app-readd"), null);
  assert.equal(android.querySelector(".phone-coach"), null);
});

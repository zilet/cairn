// An installed PWA must become the next version in place — new icon and name
// included — without losing anything. So the things an installed app is keyed on
// never move: the manifest's id/scope/start_url, the localStorage key strings, and
// the outbox a v1 client left behind. And the things that must move, move together:
// every icon URL shares one `.vN` (scripts/bump-icons.mjs), the manifest and the
// meta tag share one theme_color, and the worker serves the manifest network-first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { IDENTITY_FILES, bumpIdentity, checkIdentity, readIdentity } from "../scripts/bump-icons.mjs";
import { API_CLIENT_MODULES } from "./_apiClientModules.mjs";
import { CLIENT_OUTPUTS } from "../scripts/build-client.mjs";
import { createStorage, flush, loadClientModule } from "./_dom.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

test("manifest id, scope and start_url never change", () => {
  const manifest = JSON.parse(read("public/manifest.json"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.start_url, "/?source=pwa");
  assert.match(read("public/index.html"), /<link rel="manifest" href="\/manifest\.json">/);
});

test("every icon URL resolves, shares one .vN, is precached, and matches APP_IDENTITY_VERSION", () => {
  const { version, errors, identity } = checkIdentity(root);
  assert.deepEqual(errors, []);
  assert.ok(version >= 2);
  assert.ok(identity.manifestIcons.length >= 5, "manifest icons + shortcut icons");
  assert.ok(identity.appleTouch, "index.html carries an apple-touch-icon");
  const sw = read("public/sw.js");
  const optional = /const OPTIONAL_ASSETS = \[([\s\S]*?)\];/.exec(sw)[1];
  for (const url of new Set([...identity.manifestIcons, identity.appleTouch, ...identity.indexIcons])) {
    assert.ok(fs.existsSync(path.join(root, "public", url)), `${url} exists`);
    assert.match(url, new RegExp(`\\.v${version}\\.[a-z]+$`), `${url} carries .v${version}`);
    // The og: share image is fetched only by link-preview crawlers, never by the
    // app, so it is deliberately NOT precached (scripts/check-sw-cache.mjs).
    if (/^\/icons\/og\./.test(url)) assert.ok(!optional.includes(`"${url}"`), `${url} is not precached`);
    else assert.ok(optional.includes(`"${url}"`), `${url} is in OPTIONAL_ASSETS`);
  }
  assert.equal(identity.modelVersion, version);
});

test("manifest theme_color and the index.html theme-color meta agree", () => {
  const identity = readIdentity(root);
  assert.ok(identity.themeColor);
  assert.equal(identity.metaTheme, identity.themeColor);
});

// The page follows the system theme, so the browser chrome does too: a theme-color per
// scheme, each the ground of its palette (src/styles/foundation/tokens.css).
test("index.html paints the browser chrome in each palette's own ground", () => {
  const index = read("public/index.html");
  const tokens = read("src/styles/foundation/tokens.css");
  const lightGround = /:root\{[\s\S]*?--ground:\s*(#[0-9a-f]{6})/i.exec(tokens)[1];
  const darkGround = /:root\[data-theme="dark"\]\{[\s\S]*?--ground:\s*(#[0-9a-f]{6})/i.exec(tokens)[1];
  const meta = (scheme) =>
    new RegExp(`<meta name="theme-color" media="\\(prefers-color-scheme: ${scheme}\\)" content="([^"]+)">`).exec(index)?.[1];
  assert.equal(meta("light"), lightGround);
  assert.equal(meta("dark"), darkGround);
  assert.doesNotMatch(index, /<meta name="theme-color" content=/, "no unscoped theme-color left to win");
  assert.equal(readIdentity(root).manifest.background_color, lightGround, "the splash paints the light ground");
});

function copyIdentity() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-bump-icons-"));
  temps.push(dir);
  for (const rel of Object.values(IDENTITY_FILES)) {
    const from = path.join(root, rel);
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
  return dir;
}

test("scripts/bump-icons.mjs moves all five places to the next .vN in one step", () => {
  const dir = copyIdentity();
  const before = checkIdentity(dir);
  const dry = bumpIdentity(dir, { dryRun: true });
  assert.equal(dry.to, before.version + 1);
  assert.deepEqual(checkIdentity(dir).version, before.version, "a dry run touches nothing");

  const result = bumpIdentity(dir, { themeColor: "#123456", shortName: "Cairn & Co" });
  assert.equal(result.to, before.version + 1);
  assert.ok(result.renames.length >= 9);
  const after = checkIdentity(dir);
  assert.deepEqual(after.errors, []);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.identity.modelVersion, before.version + 1);
  assert.equal(after.identity.themeColor, "#123456");
  assert.equal(after.identity.metaTheme, "#123456");
  assert.equal(after.identity.manifest.short_name, "Cairn & Co");
  assert.equal(after.identity.manifest.shortcuts[0].short_name, "Today", "shortcut names are untouched");
  assert.match(
    fs.readFileSync(path.join(dir, "public/index.html"), "utf8"),
    /apple-mobile-web-app-title" content="Cairn &amp; Co"/
  );
  assert.equal(after.identity.manifest.id, "/", "identity keys ride along untouched");
  assert.equal(after.identity.manifest.start_url, "/?source=pwa");
  for (const [from] of result.renames) assert.equal(fs.existsSync(path.join(dir, "public/icons", from)), false);
});

test("the bump refuses to start from places that already disagree", () => {
  const dir = copyIdentity();
  const index = path.join(dir, "public/index.html");
  fs.writeFileSync(
    index,
    fs
      .readFileSync(index, "utf8")
      .replace(
        /(<meta name="theme-color" media="\(prefers-color-scheme: light\)" content=")#[0-9a-f]{6}"/i,
        '$1#000000"'
      )
  );
  assert.ok(checkIdentity(dir).errors.some((e) => /theme_color/.test(e)));
  assert.throws(() => bumpIdentity(dir), /disagree/);
  assert.throws(() => bumpIdentity(copyIdentity(), { themeColor: "red" }), /#rrggbb/);
});

// Every string a client keeps in localStorage. Renaming one strands what an installed
// app already holds (the token, an unsent log, a draft), so a rename must fail here;
// a key whose shape changes is migrated in place under the same name. A new key gets
// an entry here (and says which module owns it).
const PERSISTED_KEYS = {
  cairn_token: ["api-auth", "auth-signin-client", "client-diagnostics"],
  // The one "add a passkey" offer's "Not now", remembered per device (auth-offer-client.ts).
  "cairn.auth.passkey-offer": ["auth-offer-client"],
  // This browser's non-secret device hint: every sign-in sends it so the server reuses
  // this browser's own device row (index.html's boot script mints the same key).
  "cairn.device-hint": ["auth-passkey-client"],
  "cairn.outbox.v1": ["outbox-queue"],
  "cairn-outbox-v1": ["outbox-runtime"], // the Web Locks name old and new tabs coordinate on
  "cairn.chat.draft": ["chat-turn-records-client"],
  "cairn.rest.v1": ["rest-timer"],
  restSec: ["rest-timer"],
  "cairn.fuelLogDraft": ["fuel-deps"],
  "cairn.fuelLogRetry.v1": ["fuel-deps"],
  "cairn.sessnotes.": ["today-session-controller"],
  "cairn.swr.v1.": ["swr-cache"],
  "cairn.brief.v1": ["today-brief-cache-client", "write-invalidation-client"],
  // Chat turns a surface stopped following, settled on the next open (v2 wave 6C).
  "cairn.turnwatch.v1": ["write-invalidation-client"],
  "cairn.train.v1": ["progress-overview-snapshot-client"],
  "cairn.checkin.dismissed.v1": ["capture-checkin-client"],
  // The push offer card's "Not now", remembered on the device so a cached read never re-shows it.
  "cairn.pushOffer.dismissed.v1": ["today-push-controller"],
  // The Brief's check-in line as it last stood today, painted in the Brief's own frame (v2 wave 7).
  "cairn.checkin.paint.v1": ["capture-checkin-client"],
  "cairn.diagnostics.v1": ["client-diagnostics"],
  "cairn.records.evw": ["evidence-wanted-controller"],
  "cairn.records.group": ["records-search-controller"],
  "cairn-bm-unit": ["body-metrics-client", "me-profile-form-client"],
  "cairn-art-ready": ["art-controller"],
  "cairn-art-versions": ["art-memory-client"],
  cairn_phone_coach_dismissed: ["pwa-install-coach"],
  "cairn:healthDocCount": ["me-records-health-doc-controller", "health-picture-controller"],
  "cairn:lastInsightGen": ["capture-read-jobs-client"],
  "cairn:lastWeeklyGen": ["capture-read-jobs-client"],
  "cairn.wakeLock.v1": ["app/wake-lock"],
  // This browser has seen the install onboarded: the boot skips hiding the shell
  // while it asks whether the first-run welcome should open.
  "cairn.onboarded": ["app/onboarding", "welcome-screen", "welcome-meet-controller"],
  // The last welcome this browser started ({id, text}), so a reload after a server
  // restart names the interruption and offers Try again with the same words.
  "cairn.welcome.job": ["welcome-meet-controller"],
  // This device knows the welcome's first week has nothing left to follow (first-week-client.ts).
  "cairn.firstWeek.done": ["first-week-client"],
  "cairn.app.identity.v1": ["app-identity-model"],
  "cairn.app.readd.dismissed.v1": ["app-identity-model"],
  // The five-home navigation's one-time "what moved here" line (v2 wave 5).
  "cairn.nav.homes.v1": ["app/moved-note"],
  "cairn.nav.moved.v1.": ["app/moved-note"],
};
// Tab-scoped (sessionStorage) snapshots and non-storage literals: they never outlive
// a launch, so they are listed only so the sweep below knows them.
const NOT_PERSISTED = new Set([
  "cairn.today.plan.v2",
  "cairn.session.surface.v1", // the Session destination's instant paint (v2 wave 6C)
  "cairn.stand.v1",
  "cairn.endurance.v4",
  "cairn-art-miss", // art-memory-client: images the server just answered "not drawn yet"
  "cairn.dicom-import-jobs.v1",
  "cairn.chat.retry.v1",
  "cairn.auth.offer", // sessionStorage: a sign-in this tab just made arms the one passkey offer
  "cairn.ask.whatif.v1", // the ask surface's in-flight what-if job id (v2 wave 5)
  "cairn:keyboard-settle",
  "cairn:reveal-focused", // a DOM event (focused set field above the iOS keyboard), never stored
  "cairn-shell",
  "cairn-",
]);
// Component namespaces whose literals are class names, data attributes and mount
// names, never storage keys: the You home's cairn-stack (cairn-stack-*.ts).
const NOT_STORAGE_PREFIXES = ["cairn-stack"];

/** The built output of `src/client/<stem>.ts` — what the browser actually runs. */
function built(stem) {
  const entry = CLIENT_OUTPUTS.find((item) => item.source === `src/client/${stem}.ts`);
  assert.ok(entry, `src/client/${stem}.ts is a client output`);
  return read(entry.output);
}

test("the persisted storage key strings never change", () => {
  for (const [key, modules] of Object.entries(PERSISTED_KEYS)) {
    for (const stem of modules) assert.ok(built(stem).includes(`"${key}"`), `${stem} still uses "${key}"`);
  }
  // Derived keys, pinned by their exact construction.
  assert.match(built("outbox-runtime"), /`\$\{OUTBOX_KEY\}\.lock`/);
  assert.match(built("meal-journal-client"), /`shop:\$\{currentPlan\.id\}`/);
  assert.match(built("meal-planner-actions-controller"), /`shop:\$\{currentPlan\.id\}`/);
});

test("every cairn-prefixed key literal in the client is known to the pin list", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(rel);
    }
  };
  walk("src/client");
  const unknown = new Set();
  for (const file of files) {
    for (const m of read(file).matchAll(/["'`](cairn[._:-][A-Za-z0-9._:-]*)["'`$]/g)) {
      if (NOT_STORAGE_PREFIXES.some((prefix) => m[1] === prefix || m[1].startsWith(`${prefix}-`))) continue;
      if (!(m[1] in PERSISTED_KEYS) && !NOT_PERSISTED.has(m[1])) unknown.add(`${m[1]} (${file})`);
    }
  }
  assert.deepEqual([...unknown], [], "pin a new persisted key above, or list a tab-scoped one as not persisted");
});

// A queue exactly as v1 serialized it: the v1.0.0 minimal shape (no state, 4-char
// id tail) and the v1.9 shape (session group, a DELETE, a claim that died mid-send,
// a refusal the athlete still has to review).
const T0 = Date.parse("2026-09-20T12:00:00Z");
const V1_OUTBOX = [
  { id: "mfb2k1c0-1-a9x2", ts: T0, kind: "activity", path: "/activities", body: { text: "easy 5k" } },
  { id: "mfb2k1c0-2-q0pz", ts: T0 + 1, kind: "food", path: "/food-notes", body: { meal: "lunch", text: "rice bowl" } },
  {
    id: "mfb2k1c0-3-z9kd",
    ts: T0 + 2,
    kind: "checkin",
    path: "/checkins",
    body: { energy: 2 },
    state: "needs_attention",
    failure_status: 400,
  },
  {
    id: "session-mutation:44.1",
    ts: T0 + 3,
    kind: "set",
    path: "/sets",
    body: { date: "2026-09-20", exercise: "Bench Press", reps: 8, weight: 135 },
    session_date: "2026-09-20",
    group_id: "session:44",
    state: "sending",
    in_flight_until: T0 + 30_000,
    claim_token: "claim:mfb2k1c0:1:abcd1234",
  },
  {
    id: "mfb2k1c0-5-y7tr1234",
    ts: T0 + 4,
    kind: "restore",
    path: "/sessions/skip",
    method: "DELETE",
    body: { date: "2026-09-20", exercise: "Squat" },
    group_id: "session:44",
  },
  { id: "mfb2k1c0-6-w2e8", ts: T0 + 5, kind: "weight", path: "/bodyweight", body: { weight_lb: 171.4 } },
];

test("an outbox written by v1 still drains, in order, with its own idempotency keys", async () => {
  const storage = createStorage({ "cairn.outbox.v1": JSON.stringify(V1_OUTBOX) });
  const touched = new Set();
  const recording = {
    get length() {
      return storage.length;
    },
    key: (i) => storage.key(i),
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => {
      touched.add(k);
      storage.setItem(k, v);
    },
    removeItem: (k) => storage.removeItem(k),
  };
  const sent = [];
  const win = loadClientModule(API_CLIENT_MODULES, {
    globals: {
      localStorage: recording,
      navigator: { onLine: true },
      location: { reload() {} },
      fetch: async (url, init) => {
        sent.push({ url, method: init.method, key: init.headers["X-Idempotency-Key"], body: JSON.parse(init.body) });
        return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
      },
      // The v1 claim is long expired by the time the new shell boots.
      Date: class extends Date {
        static now() {
          return T0 + 10 * 60_000;
        }
      },
    },
  });
  assert.equal(win.CairnOutbox.count(), V1_OUTBOX.length, "the new shell reads the v1 queue as-is");
  await win.flushOutbox();
  await flush();

  assert.deepEqual(
    sent.map((s) => [s.url, s.method, s.key]),
    [
      ["/api/activities", "POST", "mfb2k1c0-1-a9x2"],
      ["/api/food-notes", "POST", "mfb2k1c0-2-q0pz"],
      ["/api/sets", "POST", "session-mutation:44.1"],
      ["/api/sessions/skip", "DELETE", "mfb2k1c0-5-y7tr1234"],
      ["/api/bodyweight", "POST", "mfb2k1c0-6-w2e8"],
    ]
  );
  assert.deepEqual(sent[2].body, V1_OUTBOX[3].body, "replayed byte-for-byte");
  const left = JSON.parse(storage.getItem("cairn.outbox.v1"));
  assert.deepEqual(
    left.map((item) => [item.id, item.state]),
    [["mfb2k1c0-3-z9kd", "needs_attention"]],
    "only the refusal waits, for the athlete to review"
  );
  assert.ok(touched.has("cairn.outbox.v1.lock"), "the cross-tab lease key keeps its name");
});

function loadWorker({ fetchImpl, cached = {}, setTimeoutImpl = setTimeout } = {}) {
  const handlers = {};
  const stores = new Map();
  const cacheFor = (name) => {
    if (!stores.has(name)) {
      const map = new Map(name === "cairn-shell-dev" ? Object.entries(cached) : []);
      stores.set(name, {
        map,
        match: async (req) => map.get(typeof req === "string" ? req : new URL(req.url).pathname) || undefined,
        put: async (key, res) => {
          map.set(typeof key === "string" ? key : new URL(key.url).pathname, res);
        },
      });
    }
    return stores.get(name);
  };
  const fetches = [];
  const context = {
    self: {
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
      skipWaiting() {},
      clients: { claim: async () => {} },
    },
    caches: {
      open: async (name) => cacheFor(name),
      match: async (req) => cacheFor("cairn-shell-dev").match(req),
    },
    fetch: (req, init) => {
      fetches.push({ url: typeof req === "string" ? req : req.url, init });
      return fetchImpl(req, init);
    },
    Response: { error: () => ({ type: "error" }) },
    URL,
    Promise,
    Error,
    setTimeout: setTimeoutImpl,
  };
  vm.runInNewContext(read("public/sw.js"), context, { filename: "public/sw.js" });
  const request = (pathname, mode = "cors") => {
    let responded = null;
    handlers.fetch({
      request: { url: `https://cairn.test${pathname}`, method: "GET", mode },
      respondWith: (p) => {
        responded = p;
      },
    });
    return responded;
  };
  return { handlers, request, fetches, cache: () => cacheFor("cairn-shell-dev") };
}

test("the worker serves /manifest.json network-first, refreshing the cached copy", async () => {
  const fresh = {
    ok: true,
    clone() {
      return { fresh: true };
    },
    fresh: true,
  };
  const worker = loadWorker({ fetchImpl: async () => fresh, cached: { "/manifest.json": { old: true } } });
  const res = await worker.request("/manifest.json");
  assert.equal(res, fresh, "the launch-time check sees the new manifest");
  assert.equal(worker.fetches[0].init.cache, "no-cache");
  await flush();
  assert.deepEqual(worker.cache().map.get("/manifest.json"), { fresh: true });

  const offline = loadWorker({
    fetchImpl: async () => {
      throw new TypeError("offline");
    },
    cached: { "/manifest.json": { old: true } },
  });
  assert.deepEqual(await offline.request("/manifest.json"), { old: true }, "offline falls back to the precached copy");

  const asleep = loadWorker({
    fetchImpl: () => new Promise(() => {}),
    cached: { "/manifest.json": { old: true } },
    setTimeoutImpl: (fn) => fn(),
  });
  assert.deepEqual(
    await asleep.request("/manifest.json"),
    { old: true },
    "a sleeping tailnet never holds the check open"
  );

  const other = loadWorker({
    fetchImpl: async () => ({ network: true }),
    cached: { "/styles.css": { cachedCss: true } },
  });
  assert.deepEqual(await other.request("/styles.css"), { cachedCss: true }, "the rest of the shell stays cache-first");
});

test("the worker tells Settings which shell it holds", () => {
  const worker = loadWorker({ fetchImpl: async () => ({}) });
  const replies = [];
  worker.handlers.message({ data: { type: "cairn-shell" }, ports: [{ postMessage: (m) => replies.push(m) }] });
  worker.handlers.message({ data: { type: "cairn-shell" }, ports: [] });
  assert.deepEqual(
    JSON.parse(JSON.stringify(replies)),
    [{ shell: "cairn-shell-dev" }],
    "the served worker carries the derived name"
  );
});

test("/api/health reports the shell the server hands out, the same name /sw.js is served with", async () => {
  const { buildServiceWorkerScript, currentShellVersion } = await import("../dist/swVersion.js");
  const { healthBody } = await import("../dist/routes/system.js");
  const expected = buildServiceWorkerScript(path.join(root, "public")).version;
  assert.match(expected, /^cairn-[0-9a-f]{12}$/);
  assert.equal(currentShellVersion(), expected, "dist/ resolves the repo's own public/");
  assert.equal(currentShellVersion(path.join(root, "public")), expected);
  assert.equal(currentShellVersion(path.join(os.tmpdir(), "cairn-no-public-here")), null);
  const body = healthBody();
  assert.equal(body.ok, true);
  assert.equal(body.shell, expected);
  assert.equal(typeof body.build.build_id, "string");
});

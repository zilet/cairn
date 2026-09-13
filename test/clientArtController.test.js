import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadArtController(options = {}) {
  const listeners = new Map();
  const storage = new Map(options.storage || []);
  const apiCalls = [];
  class FakeImage {
    constructor() {
      this.dataset = {};
      this.src = "/api/art?kind=food&q=stale";
      this.isConnected = true;
      this.removed = false;
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
      };
    }
    remove() {
      this.removed = true;
    }
    closest(sel) {
      if (sel === ".artile") return { classList: this.classList };
      return null;
    }
  }
  const context = {
    HTMLImageElement: FakeImage,
    clearTimeout: () => {},
    document: {
      addEventListener: (type, handler) => listeners.set(type, handler),
      body: {
        appendChild() {},
        contains() {
          return false;
        },
      },
      createElement: () => {
        const el = {
          className: "",
          style: {},
          innerHTML: "",
          querySelector: () => ({ addEventListener: () => {} }),
          contains: () => false,
          remove: () => {},
          setAttribute: () => {},
        };
        return el;
      },
    },
    encodeURIComponent,
    escAttr,
    escHtml: (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
    globalThis: null,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    pollToken: 1,
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    window: {
      CairnArt: {
        food: (query) => `<svg data-food="${escAttr(query)}"></svg>`,
        exercise: (query) => `<svg data-ex="${escAttr(query)}"></svg>`,
      },
    },
    withToken: (path) => `${path}&token=t`,
    api: async (path, opts) => {
      apiCalls.push({ path, opts });
      if (path === "/art/versions") return options.versions || { versions: {} };
      if (path === "/art/regenerate") return options.regenerate || { ok: true, regenerated: true, version: 2 };
      assert.equal(path, "/art/manifest");
      return options.manifest || {};
    },
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/art-controller.js"), "utf8"), context);
  return { context, listeners, storage, FakeImage, apiCalls };
}

test("art controller renders generated photo tiles with escaped eager-ready state", async () => {
  const env = loadArtController({
    manifest: { enabled: true, ready: ["food|cached <bowl>"] },
  });

  await env.context.primeArtManifest();
  const html = env.context.artImg("food", "cached <bowl>", "artile-test");

  assert.match(html, /class="artimg-photo on instant"/);
  assert.match(html, /loading="eager"/);
  assert.match(html, /alt="cached &lt;bowl&gt;"/);
  assert.match(html, /q=cached%20%3Cbowl%3E/);
  assert.match(html, /data-artkey="food\|cached &lt;bowl&gt;"/);
  assert.equal(env.storage.get("cairn-art-ready"), JSON.stringify(["food|cached <bowl>"]));
});

test("art controller keeps artEnabled as the legacy mutable global", () => {
  const env = loadArtController();

  env.context.artEnabled = false;
  const disabled = env.context.artImg("food", "rice", "artile-test", "<svg></svg>");
  assert.equal(disabled, `<div class="artile artile-test"><svg></svg></div>`);

  env.context.artEnabled = true;
  const enabled = env.context.artImg("food", "rice", "artile-test", "<svg></svg>");
  assert.match(enabled, /data-art-photo="1"/);
});

test("art controller records loaded photos and retries failed ready images once", () => {
  const env = loadArtController();
  const img = new env.FakeImage();
  img.dataset.artPhoto = "1";
  img.dataset.artkey = "food|seen";

  env.listeners.get("load")({ target: img });

  assert.equal(img.classList.contains("on"), true);
  assert.equal(env.storage.get("cairn-art-ready"), JSON.stringify(["food|seen"]));
  assert.match(env.context.artImg("food", "seen", "artile-test", "<svg></svg>"), /loading="eager"/);

  img.classList.add("instant");
  env.listeners.get("error")({ target: img });

  assert.equal(img.classList.contains("on"), false);
  assert.equal(img.classList.contains("instant"), false);
  assert.equal(img.dataset.retried, "1");
  assert.equal(img.src, "/api/art?kind=food&q=stale&r=1");
});

test("art controller treats a cooldown regenerate as a quiet no-op", async () => {
  const env = loadArtController({
    versions: { versions: { "exercise|Farmer's Carry": 1 } },
    regenerate: { ok: true, regenerated: false, reason: "cooldown", version: 1 },
  });
  await env.context.primeArtManifest();
  const img = new env.FakeImage();
  img.dataset.artKind = "exercise";
  img.dataset.artQ = "Farmer's Carry";
  img.dataset.artkey = "exercise|Farmer's Carry";
  img.isConnected = true;
  const srcBefore = img.src;

  await env.context.redrawExerciseArt(img, "Farmer's Carry");
  assert.equal(img.src, srcBefore, "did not swap the tile");
  assert.equal(img.classList.contains("art-redrawing"), false);
});

test("art controller posts regenerate and swaps the tile to the new versioned URL", async () => {
  const env = loadArtController({
    versions: { versions: { "exercise|Farmer's Carry": 1 } },
    regenerate: { ok: true, regenerated: true, version: 2 },
  });
  await env.context.primeArtManifest();
  const html = env.context.artImg("exercise", "Farmer's Carry", "artile-sm", "<svg></svg>");
  assert.match(html, /v=1/);
  assert.match(html, /data-art-kind="exercise"/);

  const img = new env.FakeImage();
  img.dataset.artKind = "exercise";
  img.dataset.artQ = "Farmer's Carry";
  img.dataset.artkey = "exercise|Farmer's Carry";
  img.isConnected = true;

  await env.context.redrawExerciseArt(img, "Farmer's Carry");
  const regen = env.apiCalls.find((c) => c.path === "/art/regenerate");
  assert.ok(regen, "posted /art/regenerate");
  assert.equal(regen.opts.method, "POST");
  assert.match(String(regen.opts.body), /Farmer's Carry/);
  assert.match(img.src, /kind=exercise/);
  assert.match(img.src, /v=2/);
});

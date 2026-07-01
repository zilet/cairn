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
  }
  const context = {
    HTMLImageElement: FakeImage,
    clearTimeout: () => {},
    document: {
      addEventListener: (type, handler) => listeners.set(type, handler),
    },
    encodeURIComponent,
    escAttr,
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
      },
    },
    withToken: (path) => `${path}&token=t`,
    api: async (path) => {
      assert.equal(path, "/art/manifest");
      return options.manifest || {};
    },
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/art-controller.js"), "utf8"), context);
  return { context, listeners, storage, FakeImage };
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

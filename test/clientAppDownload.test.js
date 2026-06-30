import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("download helper creates a temporary anchor and exposes the legacy global", () => {
  const source = readFileSync(new URL("../public/js/app-download.js", import.meta.url), "utf8");
  const calls = [];
  const anchor = {
    download: "initial",
    href: "",
    click: () => calls.push(["click", anchor.href, anchor.download]),
    remove: () => calls.push(["remove"]),
  };
  const context = {
    document: {
      body: {
        appendChild: (el) => calls.push(["appendChild", el === anchor]),
      },
      createElement: (tag) => {
        calls.push(["createElement", tag]);
        return anchor;
      },
    },
    globalThis: null,
    window: {},
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "app-download.js" });

  assert.equal(typeof context.downloadFile, "function");
  assert.equal(typeof context.window.downloadFile, "function");
  context.downloadFile("/api/export?token=t");

  assert.deepEqual(calls, [
    ["createElement", "a"],
    ["appendChild", true],
    ["click", "/api/export?token=t", ""],
    ["remove"],
  ]);
});

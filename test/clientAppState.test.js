import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCore() {
  const view = { id: "view" };
  const headerTitle = { id: "header-title" };
  const context = {
    Object,
    Error,
    localISO: () => "2026-06-29",
    document: {
      querySelector(selector) {
        if (selector === "#view") return view;
        if (selector === "#header-title") return headerTitle;
        return null;
      },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/01-core.js"), "utf8"), context);
  return { context, view, headerTitle };
}

test("core app state initializes typed globals for the classic script graph", () => {
  const { context, view, headerTitle } = loadCore();

  assert.equal(context.$("#view"), view);
  assert.equal(context.$("#header-title"), headerTitle);
  assert.equal(context.view, view);
  assert.equal(context.headerTitle, headerTitle);
  assert.deepEqual(JSON.parse(JSON.stringify(context.state)), {
    tab: "today",
    day: null,
    dayPicked: false,
    plan: [],
    today: {},
    logDate: "2026-06-29",
  });
});

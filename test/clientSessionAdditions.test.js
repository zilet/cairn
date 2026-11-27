import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function createContext() {
  const ctx = {
    window: null,
    globalThis: null,
    escHtml: (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    escAttr: (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    stagger: (n) => `--i:${Number(n) || 0}`,
    fmtDur: (sec) => {
      const s = Math.round(Number(sec) || 0);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    },
    art: (kind, name) => `<svg data-art="${kind}:${name}"></svg>`,
    artImg: (kind, name, cls) => `<img class="${cls}" alt="${name}">`,
    CairnUi: {
      jobCaptionHtml: ({ tag = "div", className = "job-cap" } = {}) =>
        `<${tag} class="${className}"></${tag}>`,
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  for (const rel of ["public/js/session-additions-model.js", "public/js/session-additions-client.js"]) {
    vm.runInNewContext(readFileSync(join(root, rel), "utf8"), ctx);
  }
  return ctx;
}

test("CairnSessionAdditionsModel formats prescriptions, collects keys, and derives prefill", () => {
  const ctx = createContext();
  const model = ctx.CairnSessionAdditionsModel;

  assert.equal(model.exerciseKey("Face Pull — Rope!"), "face pull rope");
  assert.equal(
    model.rxSummary({ mode: "reps", sets: 3, rep_low: 10, rep_high: 12, target_weight: 55 }),
    "3 × 10–12 · 55 lb"
  );
  assert.equal(
    model.rxSummary({ mode: "reps", sets: 3, rep_low: 8, rep_high: 10, target_weight: -30 }),
    "3 × 8–10 · 30 assist"
  );
  assert.equal(
    model.rxSummary({ mode: "reps", sets: 3, rep_low: 12, rep_high: 12, load_basis: "bodyweight" }),
    "3 × 12 · BW"
  );
  assert.equal(
    model.rxSummary({ mode: "timed", sets: 2, target_seconds: 45 }),
    "2 × 0:45"
  );

  const prefill = model.prefillFromSuggestion({
    mode: "reps",
    rep_low: 12,
    target_weight: null,
    last_set: { weight: 40, reps: 10 },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(prefill)), {
    weight: 40,
    reps: 12,
    rir: null,
    duration_sec: null,
  });

  const fakeRoot = {
    querySelectorAll(selector) {
      if (selector === ".ex[data-card]") return [{ dataset: { card: "Bench Press" } }];
      if (selector === ".ex .logged .chip") return [{}, {}];
      return [];
    },
    querySelector(selector) {
      if (selector === ".session-title") return { textContent: "Push · Chest" };
      return null;
    },
  };
  const keys = model.collectCurrentExerciseKeys(fakeRoot);
  assert.equal(keys.has("bench press"), true);
  assert.match(model.sessionContextSummary(fakeRoot), /2 sets logged on Push/);
});

test("CairnSessionAdditionsClient renders escaped markup and Added state", () => {
  const ctx = createContext();
  const client = ctx.CairnSessionAdditionsClient;

  const sheet = client.sheetHtml({ subtitle: "2 sets logged on <Push>" });
  assert.match(sheet, /Add to this session/);
  assert.match(sheet, /2 sets logged on &lt;Push&gt;/);
  assert.match(sheet, /data-ideate-vibe="feeling strong"/);

  const html = client.resultsHtml({
    why: "Balances your <pressing> work.",
    addedKeys: new Set(["face pull"]),
    suggestions: [
      {
        exercise: "Face Pull",
        mode: "reps",
        sets: 3,
        rep_low: 12,
        rep_high: 15,
        target_weight: 35,
        fit: "Rear delts & posture",
      },
      {
        exercise: "Hammer Curl",
        mode: "reps",
        sets: 3,
        rep_low: 10,
        rep_high: 12,
        fit: "Extra arm work",
        note: "Control the lowering <slow>",
      },
    ],
  });

  assert.match(html, /Balances your &lt;pressing&gt; work\./);
  assert.match(html, /Control the lowering &lt;slow&gt;/);
  assert.match(html, /data-ideate-add="0" disabled>Added ✓<\/button>/);
  assert.match(html, /data-ideate-add="1">\+ Add<\/button>/);
});

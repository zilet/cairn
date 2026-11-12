// Every background coaching op carries an EXPLICIT leash. With no `timeoutMs` a run fell
// to DEFAULT_TIMEOUT_MS (300 s); live, a hung exercise reconcile held its spawn permit the
// whole five minutes while the queue waited. backgroundTimeoutForOp (src/repo/settings.ts)
// is the one helper: the effort leash (150 s at low/medium), the 240 s ceiling for long
// structured outputs, and never past it. A source contract pins each call site to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BACKGROUND_LEASH_MAX_MS, backgroundTimeoutForOp } from "../dist/repo/settings.js";
import { DEFAULT_TIMEOUT_MS } from "../dist/agents.js";

const SITES = {
  "src/coachOps/training.ts": ["proposal", "evolve_program", "exercise_reconcile"],
  "src/coachOps/memory.ts": ["chat_distill", "memory_consolidation", "about_me_growth"],
  "src/coachOps/nutrition.ts": ["meal_plan", "meal_swap", "recipe"],
  "src/coachOps/health.ts": ["health_synthesis", "marker_reconcile"],
};
const LONG = new Set(["health_synthesis", "marker_reconcile", "proposal", "evolve_program", "meal_plan"]);

test("the helper: 150 s for everyday ops, 240 s for long structured outputs, never more", () => {
  assert.equal(BACKGROUND_LEASH_MAX_MS, 240_000);
  assert.ok(BACKGROUND_LEASH_MAX_MS < DEFAULT_TIMEOUT_MS);
  const ops = [...Object.values(SITES).flat(), "insight", "weekly_read"];
  for (const op of ops) {
    const leash = backgroundTimeoutForOp(op);
    assert.ok(leash <= BACKGROUND_LEASH_MAX_MS, `${op}: ${leash} ms is past the ceiling`);
    assert.equal(leash, LONG.has(op) ? 240_000 : 150_000, op);
  }
  // An unknown op still gets a leash, never the 300 s default.
  assert.ok(backgroundTimeoutForOp("something_new") <= BACKGROUND_LEASH_MAX_MS);
});

// The text of the options object following `op: "<name>"` up to the closing `})`.
function callOptions(source, op) {
  const at = source.indexOf(`op: "${op}"`);
  assert.ok(at >= 0, `call site for ${op} not found`);
  const end = source.indexOf("})", at);
  return source.slice(at, end);
}

test("each background call site passes the helper's leash", () => {
  for (const [file, ops] of Object.entries(SITES)) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const op of ops) {
      assert.match(
        callOptions(source, op),
        new RegExp(`timeoutMs: backgroundTimeoutForOp\\("${op}"\\)`),
        `${file} ${op}`
      );
    }
  }
  // Insight / weekly read share one call whose op is chosen at run time.
  const memory = readFileSync(new URL("../src/coachOps/memory.ts", import.meta.url), "utf8");
  const insight = memory.slice(memory.indexOf('const op = k === "weekly_read"'));
  assert.match(insight.slice(0, 400), /timeoutMs: backgroundTimeoutForOp\(op\)/);
});

// Every background coaching op carries an EXPLICIT leash. With no `timeoutMs` a run fell
// to DEFAULT_TIMEOUT_MS (300 s); live, a hung exercise reconcile held its spawn permit the
// whole five minutes while the queue waited. backgroundTimeoutForOp (src/repo/settings.ts)
// is the one helper: the effort leash (150 s at low/medium), the 240 s ceiling for long
// structured outputs, and never past it. A source contract pins each call site to it.
// An op that reads on demand (boundedReads) takes that leash PER TURN: its `timeoutMs` is
// one deadline across every read round, fallback agent and permit wait, and stays 300 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKGROUND_LEASH_MAX_MS,
  BOUNDED_READ_TOTAL_MS,
  backgroundTimeoutForOp,
  boundedReadLeashForOp,
} from "../dist/repo/settings.js";
import { DEFAULT_TIMEOUT_MS } from "../dist/agents.js";
import { runChosenStreaming } from "../dist/runChosen.js";
import { db, repo } from "./_seed.js";

const SITES = {
  "src/coachOps/training.ts": ["proposal", "evolve_program", "exercise_reconcile"],
  "src/coachOps/memory.ts": ["chat_distill", "memory_consolidation", "about_me_growth"],
  "src/coachOps/nutrition.ts": ["meal_plan", "meal_swap", "recipe"],
  "src/coachOps/health.ts": ["marker_reconcile"],
};
// The bounded-read call sites: the total stays 300 s, the leash rides each turn.
const BOUNDED_SITES = { "src/coachOps/health.ts": ["health_synthesis"] };
const LONG = new Set(["health_synthesis", "marker_reconcile", "proposal", "evolve_program", "meal_plan"]);

test("the helper: 150 s for everyday ops, 240 s for long structured outputs, never more", () => {
  assert.equal(BACKGROUND_LEASH_MAX_MS, 240_000);
  assert.ok(BACKGROUND_LEASH_MAX_MS < DEFAULT_TIMEOUT_MS);
  const ops = [...Object.values(SITES).flat(), ...Object.values(BOUNDED_SITES).flat(), "insight", "weekly_read"];
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
});

test("a bounded-read op keeps its 300 s total and takes the leash per turn", () => {
  assert.equal(BOUNDED_READ_TOTAL_MS, DEFAULT_TIMEOUT_MS);
  for (const op of ["insight", "weekly_read", "health_synthesis"]) {
    const leash = boundedReadLeashForOp(op);
    assert.equal(leash.timeoutMs, 300_000, op);
    assert.equal(leash.turnTimeoutMs, backgroundTimeoutForOp(op), op);
    assert.ok(leash.turnTimeoutMs <= leash.timeoutMs, op);
  }
  for (const [file, ops] of Object.entries(BOUNDED_SITES)) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const op of ops) {
      const site = callOptions(source, op);
      assert.match(site, new RegExp(`\\.\\.\\.boundedReadLeashForOp\\("${op}"\\)`), `${file} ${op}`);
      assert.match(site, /boundedReads: true/, `${file} ${op}`);
      assert.doesNotMatch(site, /timeoutMs: backgroundTimeoutForOp/, `${file} ${op}`);
    }
  }
  // Insight / weekly read share one call whose op is chosen at run time.
  const memory = readFileSync(new URL("../src/coachOps/memory.ts", import.meta.url), "utf8");
  const insight = memory.slice(memory.indexOf('const op = k === "weekly_read"')).slice(0, 500);
  assert.match(insight, /\.\.\.boundedReadLeashForOp\(op\)/);
  assert.match(insight, /boundedReads: true/);
  assert.doesNotMatch(insight, /timeoutMs: backgroundTimeoutForOp/);
});

test("the bounded loop receives the total as timeoutMs and the leash as turnTimeoutMs", async () => {
  let seen = null;
  await runChosenStreaming(
    undefined,
    "prompt",
    { op: "insight", boundedReads: true, ...boundedReadLeashForOp("insight") },
    {
      resolveOrder: () => ["stub"],
      runBounded: async (_agent, _prompt, opts) => {
        seen = opts;
        return { agent: "stub", result: { parsed: {} }, tried: [] };
      },
    }
  );
  assert.equal(seen.timeoutMs, 300_000);
  assert.equal(seen.turnTimeoutMs, 150_000);
  assert.equal(seen.mode, "ordinary");
});

test("a person's xhigh/max effort binding is never capped below that effort's leash", () => {
  db.prepare("DELETE FROM settings WHERE id = 1").run();
  try {
    assert.equal(backgroundTimeoutForOp("insight"), 150_000);
    assert.equal(backgroundTimeoutForOp("health_synthesis"), 240_000);
    repo.setSettings({
      agent_profile_bindings: {
        claude: { insight: { reasoning: "xhigh" } },
        codex: { health_synthesis: { reasoning: "max" } },
        grok: { meal_swap: { reasoning: "high" } },
      },
    });
    assert.equal(backgroundTimeoutForOp("insight"), DEFAULT_TIMEOUT_MS);
    assert.equal(backgroundTimeoutForOp("health_synthesis"), DEFAULT_TIMEOUT_MS);
    // high's own leash (240 s) sits inside the ceiling, so it lifts the 150 s base to it.
    assert.equal(backgroundTimeoutForOp("meal_swap"), 240_000);
    // An op nobody bound keeps its ordinary leash.
    assert.equal(backgroundTimeoutForOp("recipe"), 150_000);
    // Per turn, the bound effort's leash; the total never shrinks below it.
    const bounded = boundedReadLeashForOp("insight");
    assert.equal(bounded.turnTimeoutMs, DEFAULT_TIMEOUT_MS);
    assert.ok(bounded.timeoutMs >= bounded.turnTimeoutMs);
  } finally {
    db.prepare("DELETE FROM settings WHERE id = 1").run();
  }
});

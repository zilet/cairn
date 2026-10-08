// A rejected agent reply must say WHICH contract check refused it (a short slug in
// agent_runs.error_message, one WARN line), and a brand-new user's day_read must not be
// rejectable for the most natural way to say "there is no data yet".
//
// Offline: the "agent" is a node script file printing a fixed reply.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-reject-"));
const reply = (name, obj) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `process.stdout.write(${JSON.stringify(JSON.stringify(obj))})`);
  return f;
};
const BASELINE_WORD = reply("baseline.cjs", {
  kind: "easy",
  headline: "Easy start.",
  why: "I don't have a baseline for you yet, so move however feels good.",
});
const NOT_JSON = path.join(dir, "prose.cjs");
fs.writeFileSync(NOT_JSON, "process.stdout.write('just prose')");
const cfg = path.join(dir, "agents.json");
fs.writeFileSync(
  cfg,
  JSON.stringify({
    wordy: { command: "node", args: [BASELINE_WORD, "{prompt}"], input: "arg" },
    prose: { command: "node", args: [NOT_JSON, "{prompt}"], input: "arg" },
  })
);
process.env.AGENTS_CONFIG = cfg;

const { runAgentWithFallback, setAgentRunSink } = await import("../dist/agents.js");
const { recordAgentRun } = await import("../dist/repo/agent-telemetry.js");
const { db } = await import("../dist/db.js");
const { seed } = await import("../dist/seed.js");
const { dayRead } = await import("../dist/repo/day-read.js");
const { dayReadAgentRejection, isValidDayReadAgentResult } = await import("../dist/dayread.js");
const { buildDayReadPrompt } = await import("../dist/prompt.js");

test("blank profile: the baseline is a starting-out read and the prompt names the banned words", () => {
  seed({ blankProfile: true });
  const baseline = dayRead();
  const prompt = buildDayReadPrompt(undefined, { baseline });
  assert.match(prompt, /WORDING RULE for "headline" and "why"/);
  assert.match(prompt, /baseline/);
  // A plain first-day read passes; the natural "no baseline yet" phrasing is the one that is refused.
  const plain = { kind: baseline.kind, headline: "Ease in.", why: "Nothing on record yet, so move however feels good." };
  assert.equal(dayReadAgentRejection(plain, baseline), null);
  const wordy = { ...plain, why: "I don't have a baseline for you yet." };
  assert.equal(dayReadAgentRejection(wordy, baseline), "grammar:engineering_prose:why");
  assert.equal(isValidDayReadAgentResult(wordy, baseline), false);
});

test("day-read rejection codes name the failing check", () => {
  const b = { kind: "easy", signals: {} };
  assert.equal(dayReadAgentRejection({ kind: "easy", why: "" }, b), "missing_field:why");
  assert.equal(dayReadAgentRejection({ kind: "sprint", why: "x" }, b), "schema_mismatch");
  assert.equal(dayReadAgentRejection({ kind: "coach_read", why: "x" }, b), "coach_read_as_final");
  assert.equal(dayReadAgentRejection({ kind: "easy", why: "x", headline: "Readiness 38/100" }, b), "grammar:score:headline");
});

test("a rejected reply is recorded with its reason code and never its prose", async () => {
  db.exec("DELETE FROM agent_runs");
  setAgentRunSink((r) => recordAgentRun(r));
  try {
    await assert.rejects(
      runAgentWithFallback(["wordy"], "go", {
        op: "day_read",
        acceptParsed: (p) => isValidDayReadAgentResult(p, { kind: "easy", signals: {} }),
      })
    );
    await assert.rejects(runAgentWithFallback(["prose"], "go", { op: "day_read" }));
  } finally {
    setAgentRunSink(null);
  }
  const rows = db.prepare("SELECT agent, error_class, error_message FROM agent_runs ORDER BY id").all();
  const wordy = rows.filter((r) => r.agent === "wordy");
  assert.ok(wordy.length >= 1);
  for (const r of wordy) {
    assert.equal(r.error_class, "invalid_contract");
    assert.equal(r.error_message, "invalid_contract: grammar:engineering_prose:why");
    assert.doesNotMatch(r.error_message, /baseline for you/);
  }
  const prose = rows.find((r) => r.agent === "prose");
  assert.equal(prose.error_class, "invalid_json");
  assert.equal(prose.error_message, "invalid_json: no_json");
});

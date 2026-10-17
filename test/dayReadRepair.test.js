// A day_read the reply contract refuses is repaired ONCE, by the same agent, with the
// broken rule named — then the deterministic floor. Never a four-agent rotation.
//
// Live (2026-10-06 12:51): antigravity, grok and claude each answered the same Brief
// prompt with JSON the contract refused, then codex was at its limit — ~50 s and four
// subscription calls for a floor. Offline: the "agents" are node scripts that read the
// prompt on stdin, log each spawn, and answer the way a stubborn or a teachable model
// would.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-dayread-repair-"));
const spawnLog = path.join(dir, "spawns.ndjson");
const script = path.join(dir, "agent.cjs");
// mode: "repairs" — off-contract until the repair names the rule, then compliant;
//       "stubborn" — off-contract every time; "clean" — compliant every time.
// The kind is echoed from the prompt's own baseline line so a compliant reply never
// trips the done / named-brake rules.
fs.writeFileSync(
  script,
  `const fs = require("fs");
const [log, mode, name] = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const hinted = input.includes("What was wrong");
  fs.appendFileSync(log, JSON.stringify({ name, hinted, checks: input.includes("REPLY CHECKS"), named: /baseline, posture/.test(input.split("What was wrong")[1] || "") }) + "\\n");
  const kind = (/A rules-only baseline suggested: kind="(\\w+)"/.exec(input) || [])[1] || "easy";
  const ok = mode === "clean" || (mode === "repairs" && hinted);
  const why = ok ? "Nothing on record yet, so move however feels good." : "I don't have a baseline for you yet.";
  process.stdout.write(JSON.stringify({ kind, headline: "Ease in.", why, focus: null, est_minutes: null, brake: null }));
});
`
);
const agent = (mode, name) => ({ command: "node", args: [script, spawnLog, mode, name], input: "stdin" });
const cfg = path.join(dir, "agents.json");
fs.writeFileSync(
  cfg,
  JSON.stringify({
    repairs: agent("repairs", "repairs"),
    stubborn: agent("stubborn", "stubborn"),
    clean: agent("clean", "clean"),
  })
);
process.env.AGENTS_CONFIG = cfg;

const { runAgentWithFallback, AgentFallbackError } = await import("../dist/agents.js");
const { seed } = await import("../dist/seed.js");
const { dayRead } = await import("../dist/repo/day-read.js");
const { violatesReadingGrammar } = await import("../dist/repo/day-read-grammar.js");
const {
  computeDayRead,
  dayReadAgentRejection,
  dayReadRepairHint,
  dayReadReplyChecks,
  DAY_READ_GRAMMAR_WORDS,
  isValidDayReadAgentResult,
} = await import("../dist/dayread.js");

const spawns = () =>
  fs.existsSync(spawnLog)
    ? fs
        .readFileSync(spawnLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const resetSpawns = () => fs.rmSync(spawnLog, { force: true });

const BASE = { kind: "easy", signals: {} };
const dayReadOpts = (extra = {}) => ({
  op: "day_read",
  timeoutMs: 15_000,
  acceptParsed: (p) => isValidDayReadAgentResult(p, BASE),
  contractRepairHint: (reason) => dayReadRepairHint(reason, BASE),
  ...extra,
});

test("the repair names the broken rule, and the same agent lands a compliant read on it", async () => {
  resetSpawns();
  const r = await runAgentWithFallback(["repairs", "clean"], "go", dayReadOpts({ onContractRejection: "stop" }));
  assert.equal(r.agent, "repairs", "the same agent answered on its repair");
  const runs = spawns();
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((s) => [s.name, s.hinted]),
    [
      ["repairs", false],
      ["repairs", true],
    ]
  );
  assert.ok(runs[1].named, "the repair lists the banned words of the rule it broke");
});

test("a content rejection after the repair floors: ONE agent, two spawns, never the next CLI", async () => {
  resetSpawns();
  await assert.rejects(
    () => runAgentWithFallback(["stubborn", "clean"], "go", dayReadOpts({ onContractRejection: "stop" })),
    (err) => {
      assert.ok(err instanceof AgentFallbackError);
      // computeDayRead reads this phrase as an invalid response (agentIssueFor).
      assert.match(err.message, /outside the requested contract/);
      assert.match(err.message, /grammar:engineering_prose:why/);
      assert.deepEqual(
        err.tried.map((t) => t.agent),
        ["stubborn"]
      );
      return true;
    }
  );
  assert.deepEqual(
    spawns().map((s) => s.name),
    ["stubborn", "stubborn"],
    "the clean agent behind it was never handed the same prompt"
  );
});

test("without the opt-in a content rejection still rotates (every other op is unchanged)", async () => {
  resetSpawns();
  const r = await runAgentWithFallback(["stubborn", "clean"], "go", dayReadOpts());
  assert.equal(r.agent, "clean");
  assert.deepEqual(
    spawns().map((s) => s.name),
    ["stubborn", "stubborn", "clean"]
  );
});

test("computeDayRead: a stubborn agent costs two spawns and the Brief is the deterministic floor", async () => {
  seed({ blankProfile: true });
  resetSpawns();
  const read = await computeDayRead({ agent: "stubborn" });
  assert.equal(read.source, "deterministic");
  assert.equal(read.agent_issue, "invalid_response");
  const runs = spawns();
  assert.equal(runs.length, 2);
  assert.ok(runs[0].checks, "the prompt states today's reply checks up front");
  assert.ok(runs[1].hinted && runs[1].named, "the repair names the broken rule");
});

test("computeDayRead: the same agent's repaired read is the one served", async () => {
  seed({ blankProfile: true });
  resetSpawns();
  const read = await computeDayRead({ agent: "repairs" });
  assert.equal(read.source, "agent");
  assert.equal(read.agent, "repairs");
  assert.equal(violatesReadingGrammar(read.why), null);
  assert.equal(spawns().length, 2);
});

test("every rejection code the day_read predicate emits has repair words, and the words hold the rules", () => {
  const baseline = { kind: "train", signals: {} };
  const codes = [
    "grammar:engineering_prose:why",
    "grammar:device_jargon:headline",
    "grammar:score:why",
    "grammar:gate:why",
    "prose_inconsistent:completed_load_understated",
    "prose_inconsistent:felt_quality_understated",
    "prose_inconsistent:recovery_claimed_unread",
    "html_entity:why",
    "caution_without_brake",
    "kind_vs_done_baseline",
    "done_without_baseline",
    "coach_read_as_final",
    "coach_read_malformed",
    "missing_field:why",
    "bad_field:kind",
    "schema_mismatch",
    "bad_shape",
  ];
  for (const code of codes) assert.ok(dayReadRepairHint(code, baseline), `no repair words for ${code}`);
  assert.equal(dayReadRepairHint("accept_parsed_false", baseline), null, "an unknown code keeps the generic repair");
  // The banned words the prompt and the repair promise are exactly words the grammar refuses.
  for (const word of DAY_READ_GRAMMAR_WORDS) {
    assert.equal(violatesReadingGrammar(`A plain ${word} here.`), "engineering_prose", word);
  }
  // The predicate's prose code now says WHICH guard fired, so the repair can say it.
  const done = {
    kind: "done",
    signals: { today_load: "hard", trained_today: true },
  };
  assert.equal(
    dayReadAgentRejection({ kind: "done", headline: "Done.", why: "That run was easy, nice work." }, done),
    "prose_inconsistent:completed_load_understated"
  );
});

test("the reply checks list only what can fire today", () => {
  seed({ blankProfile: true });
  const baseline = dayRead();
  const checks = dayReadReplyChecks(baseline);
  assert.match(checks, /REPLY CHECKS/);
  for (const word of DAY_READ_GRAMMAR_WORDS) assert.ok(checks.includes(word), word);
  assert.match(checks, /never "done" today/);

  const done = dayReadReplyChecks({ kind: "done", signals: { today_load: "moderate", trained_today: true } });
  assert.match(done, /"kind" is "done"/);
  assert.match(done, /graded moderate: never call it easy/);
  assert.doesNotMatch(done, /brake/);

  const train = dayReadReplyChecks({ kind: "train", signals: {} });
  assert.match(train, /"brake":null/);
  assert.doesNotMatch(dayReadReplyChecks({ kind: "train", signals: {} }, { override: true }), /brake/);
  assert.match(
    dayReadReplyChecks({ kind: "easy", signals: { recovery_unread: "nothing_on_record" } }),
    /never say recovery looks fine/
  );
});

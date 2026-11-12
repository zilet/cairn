// "done" is offered only when it is true. Live (2026-11), 8 of 10 refused day reads in a
// week were `done_without_baseline`: the model answered "kind":"done" on a day the
// server's baseline was not done (a run logged, the lift still open) and ~36 s went to a
// reply that could never pass. So the kinds the validator accepts for THIS baseline
// (dayReadFinalKinds) are the ones the per-call schema enumerates and the prompt offers.
// Offline: the "agent" is a node script that records the schema it was handed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-dayread-kind-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const schemaLog = path.join(dir, "schemas.ndjson");
const script = path.join(dir, "agent.cjs");
fs.writeFileSync(
  script,
  `const fs = require("fs");
const [log, ...rest] = process.argv.slice(2);
const at = rest.indexOf("--json-schema");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.appendFileSync(log, JSON.stringify({ schema: at >= 0 ? JSON.parse(rest[at + 1]) : null }) + "\\n");
  const kind = (/A rules-only baseline suggested: kind="(\\w+)"/.exec(input) || [])[1] || "easy";
  process.stdout.write(JSON.stringify({ kind, headline: "Ease in.", why: "Nothing on record yet, so move however feels good.", focus: null, est_minutes: null, brake: null }));
});
`
);
const cfg = path.join(dir, "agents.json");
fs.writeFileSync(
  cfg,
  JSON.stringify({
    capture: {
      command: "node",
      args: [script, schemaLog, "{schema_args}"],
      input: "stdin",
      structured_output: { flag: ["--json-schema", "{schema}"], arg: "inline" },
    },
  })
);
process.env.AGENTS_CONFIG = cfg;

const { DAY_READ_SCHEMA, dayReadFinalKinds, dayReadSchemaFor } = await import("../dist/agent-contracts.js");
const { matchesJsonSchema } = await import("../dist/json-schema.js");
const { computeDayRead, dayReadAgentRejection, dayReadRepairHint } = await import("../dist/dayread.js");
const { buildDayReadPrompt } = await import("../dist/prompt/day.js");
const { dayRead } = await import("../dist/repo/day-read.js");
const { seed } = await import("../dist/seed.js");

const enumOf = (schema) => schema.properties.kind.enum;
const WHY = "Good day to get the work in.";

test("the per-call schema enumerates only the kinds this baseline admits, and always coach_read", () => {
  for (const kind of ["train", "easy", "rest"]) {
    assert.deepEqual(enumOf(dayReadSchemaFor(kind)), ["train", "easy", "rest", "coach_read"], kind);
  }
  assert.deepEqual(enumOf(dayReadSchemaFor("done")), ["done", "coach_read"]);
  // No baseline: the widest form, the same enum as the static schema.
  assert.deepEqual(enumOf(dayReadSchemaFor(undefined)), enumOf(DAY_READ_SCHEMA));
  assert.deepEqual(enumOf(DAY_READ_SCHEMA), ["train", "easy", "rest", "done", "coach_read"], "the static schema stays widest");
  // Everything else is the static schema's: one open top-level object, the read protocol named.
  const narrowed = dayReadSchemaFor("train");
  assert.equal(narrowed.type, "object");
  assert.equal(narrowed.additionalProperties, true);
  assert.deepEqual(Object.keys(narrowed.properties), Object.keys(DAY_READ_SCHEMA.properties));
  assert.ok(narrowed.properties.requests, "a coach_read request stays expressible");
});

test("the schema is never stricter than the validator, and never looser on the done rule", () => {
  for (const baselineKind of ["train", "easy", "rest", "done"]) {
    const schema = dayReadSchemaFor(baselineKind);
    for (const kind of ["train", "easy", "rest", "done"]) {
      const value = { kind, why: WHY, focus: null, est_minutes: null };
      const rejection = dayReadAgentRejection(value, { kind: baselineKind, signals: {} }, null, { override: true });
      const doneRule = rejection === "done_without_baseline" || rejection === "kind_vs_done_baseline";
      assert.equal(matchesJsonSchema(schema, value, { coerce: true }), !doneRule, `${baselineKind} baseline, ${kind} reply`);
    }
  }
});

test("the validator still refuses done without a done baseline (and the reverse)", () => {
  const read = (kind) => ({ kind, why: WHY, focus: null, est_minutes: null });
  assert.equal(dayReadAgentRejection(read("done"), { kind: "train", signals: {} }), "done_without_baseline");
  assert.equal(dayReadAgentRejection(read("done"), { kind: "rest", signals: {} }), "done_without_baseline");
  assert.equal(dayReadAgentRejection(read("train"), { kind: "done", signals: {} }), "kind_vs_done_baseline");
  assert.equal(dayReadAgentRejection(read("done"), { kind: "done", signals: {} }), null);
  // The widest schema still validates a "done" — the validator, not the schema, refuses it.
  assert.equal(matchesJsonSchema(DAY_READ_SCHEMA, read("done"), { coerce: true }), true);
  assert.deepEqual(dayReadFinalKinds("easy"), ["train", "easy", "rest"]);
  // The repair names only the kinds that can pass.
  assert.doesNotMatch(dayReadRepairHint("bad_field:kind", { kind: "train", signals: {} }), /\bdone\b/);
  assert.match(dayReadRepairHint("bad_field:kind", { kind: "done", signals: {} }), /one of done;/);
});

test("the prompt offers done only on a done baseline, and says an open day is still open", () => {
  seed({ blankProfile: true });
  const base = dayRead();
  const open = { ...base, kind: "train", signals: { ...base.signals, logged_today: { sets: 0, activities: [{ type: "running", duration_min: 30 }] } } };
  const prompt = buildDayReadPrompt(undefined, { baseline: open });
  assert.match(prompt, /"kind": "train\|easy\|rest",/);
  assert.doesNotMatch(prompt, /"kind": "[^"]*done/);
  assert.match(prompt, /THE DAY IS STILL OPEN:/);
  // The line sits beside the output contract, after the wording rule.
  assert.ok(prompt.indexOf("THE DAY IS STILL OPEN:") > prompt.indexOf("WORDING RULE"));
  assert.ok(prompt.indexOf("THE DAY IS STILL OPEN:") < prompt.indexOf("\nDATA:\n"));

  const blank = buildDayReadPrompt(undefined, { baseline: { ...base, kind: "easy", signals: { ...base.signals, logged_today: null } } });
  assert.doesNotMatch(blank, /THE DAY IS STILL OPEN:/, "nothing logged: nothing to say");

  const done = buildDayReadPrompt(undefined, { baseline: { ...open, kind: "done" } });
  assert.match(done, /"kind": "done",/);
  assert.doesNotMatch(done, /THE DAY IS STILL OPEN:/);
});

test("the signals blob drops what DATA already carries and points nowhere DATA is not", () => {
  seed();
  const base = dayRead();
  const prompt = buildDayReadPrompt(undefined, { baseline: base });
  const blob = JSON.parse(/DETERMINISTIC SIGNALS[^\n]*\n(\{[\s\S]*?\})\nA rules-only/.exec(prompt)[1]);
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\nDATA:\n") + "\nDATA:\n".length));
  for (const key of ["underfueling", "signal_state"]) {
    if (Object.hasOwn(data, key)) assert.ok(!Object.hasOwn(blob, key), `${key} rides in DATA, not twice`);
  }
  // Everything else the baseline computed still rides in the blob.
  for (const key of Object.keys(base.signals)) {
    if (key === "underfueling" || key === "signal_state") continue;
    assert.ok(Object.hasOwn(blob, key) || base.signals[key] === undefined, `${key} stays`);
  }
  // DATA has no `signals` key, so the prompt never sends the model looking for one.
  assert.ok(!Object.hasOwn(data, "signals"));
  assert.doesNotMatch(prompt, /DATA\.signals\b|DATA is in signals\./);
});

test("a rest read with a walk logged is not told its planned work is still ahead", () => {
  seed({ blankProfile: true });
  const base = dayRead();
  const walk = { ...base.signals, logged_today: { sets: 0, activities: [{ type: "walking", duration_min: 25 }] } };
  const rest = buildDayReadPrompt(undefined, { baseline: { ...base, kind: "rest", signals: walk } });
  assert.doesNotMatch(rest, /THE DAY IS STILL OPEN|planned work is still ahead/);
  assert.match(
    rest,
    /NOT "DONE": what is already logged today is context for the read and does not make the day "done"/
  );
  for (const kind of ["train", "easy"]) {
    const open = buildDayReadPrompt(undefined, { baseline: { ...base, kind, signals: walk } });
    assert.match(open, /THE DAY IS STILL OPEN: the day's planned work is still ahead/, kind);
    assert.doesNotMatch(open, /NOT "DONE":/, kind);
  }
  const blank = buildDayReadPrompt(undefined, {
    baseline: { ...base, kind: "rest", signals: { ...base.signals, logged_today: null } },
  });
  assert.doesNotMatch(blank, /NOT "DONE":|THE DAY IS STILL OPEN/, "nothing logged: nothing to say");
});

test("the signals header names only what it actually moved to DATA", () => {
  seed();
  const base = dayRead();
  const header = (prompt) => /DETERMINISTIC SIGNALS[^\n]*/.exec(prompt)[0];
  const blobOf = (prompt) => JSON.parse(/DETERMINISTIC SIGNALS[^\n]*\n(\{[\s\S]*?\})\nA rules-only/.exec(prompt)[1]);
  const prompt = buildDayReadPrompt(undefined, { baseline: base });
  for (const key of ["underfueling", "signal_state"]) {
    const kept = Object.hasOwn(blobOf(prompt), key);
    assert.equal(new RegExp(`\\b${key}\\b`).test(header(prompt)), !kept && Object.hasOwn(base.signals, key), key);
  }
  // A signal that differs from DATA's copy stays in the blob, and the header never claims it.
  const differs = {
    ...base,
    signals: { ...base.signals, underfueling: { level: "kept-in-blob" }, signal_state: { dimensions: { kept: true } } },
  };
  const kept = buildDayReadPrompt(undefined, { baseline: differs });
  assert.ok(Object.hasOwn(blobOf(kept), "underfueling"));
  assert.doesNotMatch(header(kept), /underfueling|signal_state|in DATA/);
});

test("computeDayRead hands the agent the narrowed schema", async () => {
  seed({ blankProfile: true });
  fs.rmSync(schemaLog, { force: true });
  const baseline = dayRead();
  await computeDayRead({ agent: "capture" });
  const [first] = fs.readFileSync(schemaLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(first.schema, "the CLI received a schema");
  assert.deepEqual(first.schema.properties.kind.enum, [...dayReadFinalKinds(baseline.kind), "coach_read"]);
  if (baseline.kind !== "done") assert.ok(!first.schema.properties.kind.enum.includes("done"));
});

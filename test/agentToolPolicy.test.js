// The two things learned live on the Pi (2026-09-02) about the autonomous CLIs:
//   1. handed a coaching prompt, grok and agy explore their cwd with tools until the
//      timeout (grok) or a headless permission auto-deny (agy) — one sentence at the
//      top of the prompt is what makes both answer in a single round; and
//   2. agy's `-p /quota --output-format json` answers locally, so the login probe can
//      read signed-in state AND the usage buckets without spending anything.
// Pure/offline: no CLI spawn, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import "./_seed.js";
import { NO_TOOLS_PREAMBLE, applyToolPolicy, parseAgyQuota } from "../dist/agents.js";
import { agentDataDir } from "../dist/agentExecution.js";

test("applyToolPolicy leads a plain prompt with the no-tools preamble, once", () => {
  const out = applyToolPolicy("DATA: {}\n\nOUTPUT CONTRACT: …");
  assert.ok(out.startsWith(NO_TOOLS_PREAMBLE + "\n\n"), "preamble leads");
  assert.ok(out.endsWith("OUTPUT CONTRACT: …"), "the prompt itself is untouched after it");
  // Idempotent: the JSON-repair retry re-runs a prompt that already carries it.
  assert.equal(applyToolPolicy(out), out);
  assert.equal(applyToolPolicy(out + "\n\nREPAIR"), out + "\n\nREPAIR");
});

test("applyToolPolicy leaves a file-handing prompt and a provider-tools run alone", () => {
  const upload = path.join(path.resolve(agentDataDir(process.env)), "uploads", "panel.pdf");
  const filePrompt = `Read the panel at ${upload} and extract the markers.`;
  assert.equal(applyToolPolicy(filePrompt), filePrompt, "an uploaded file must stay readable");
  assert.equal(applyToolPolicy("CAIRN_AGENT_DATA_FILES:\n- x"), "CAIRN_AGENT_DATA_FILES:\n- x");
  assert.equal(applyToolPolicy("Find current evidence.", "provider"), "Find current evidence.");
});

test("NO_TOOLS_PREAMBLE names every tool family the CLIs actually reached for", () => {
  // grok's loop was read_file / grep / run_terminal_command; agy's denial was a
  // shell "command". The sentence must cover files, commands AND the web (the one
  // family a research run re-enables via tools:"provider").
  assert.match(NO_TOOLS_PREAMBLE, /read or list files/i);
  assert.match(NO_TOOLS_PREAMBLE, /run commands/i);
  assert.match(NO_TOOLS_PREAMBLE, /search the web/i);
  assert.match(NO_TOOLS_PREAMBLE, /say so/i, "a missing fact is reported, never fetched");
});

const AGY_QUOTA_ENVELOPE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t96%\t2026-09-08T18:05:09Z\n",
  duration_seconds: 0,
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      description: "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9561, reset_time: "2026-09-08T18:05:09Z" },
            { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9278, reset_time: "2026-09-02T22:00:27Z" },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-09-09T17:46:47Z" },
            { id: "3p-5h", window: "5h", remaining_fraction: 1.4, reset_time: null },
          ],
        },
      ],
    },
  },
});

test("parseAgyQuota flattens the live 1.1.24 /quota envelope into buckets", () => {
  const buckets = parseAgyQuota(AGY_QUOTA_ENVELOPE);
  assert.equal(buckets.length, 4);
  assert.deepEqual(buckets[0], {
    group: "Gemini Models",
    window: "weekly",
    remaining_fraction: 0.9561,
    reset_time: "2026-09-08T18:05:09Z",
  });
  assert.equal(buckets[1].window, "5h");
  // Clamped into [0,1]; a missing reset is null, never a fabricated instant.
  assert.equal(buckets[3].remaining_fraction, 1);
  assert.equal(buckets[3].reset_time, null);
  // A stderr notice ahead of the JSON (update banner) must not break the read.
  assert.equal(parseAgyQuota("Fetching…\n" + AGY_QUOTA_ENVELOPE).length, 4);
});

test("parseAgyQuota is empty on anything that is not the usage envelope", () => {
  assert.deepEqual(parseAgyQuota(""), []);
  assert.deepEqual(parseAgyQuota("not json"), []);
  assert.deepEqual(parseAgyQuota(JSON.stringify({ status: "SUCCESS", response: "OK" })), []);
  assert.deepEqual(parseAgyQuota(JSON.stringify({ command: { name: "usage", data: { groups: "nope" } } })), []);
  assert.deepEqual(
    parseAgyQuota(JSON.stringify({ command: { data: { groups: [{ buckets: [{ window: "5h", remaining_fraction: "n/a" }] }] } } })),
    []
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  availabilityHolds,
  availabilityReason,
  classifyAgentFailure,
  formatResetForPerson,
  holdUntil,
  parseResetsPhrase,
  parseStreamRateLimitEvent,
  parseTryAgainPhrase,
} from "../dist/agentAvailability.js";
import { agentErrorClass } from "../dist/telemetry-privacy.js";
import {
  runAgentWithFallback,
  setAgentAvailabilitySink,
  setAgentDiagnosticSink,
  dominantTriedState,
} from "../dist/agents.js";
import * as repo from "../dist/repo.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---------- the VERBATIM strings the providers actually printed ----------

const CLAUDE_TEXT = "You've hit your weekly limit · resets 8am (America/New_York)";
const CLAUDE_TEXT_DATED = "You've hit your weekly limit · resets Aug 26, 8am (America/New_York)";
const CLAUDE_RATE_EVENT =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1787745600,"rateLimitType":"seven_day","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"session_id":"abc"}';
const CLAUDE_RESULT_LINE =
  '{"type":"result","subtype":"error","is_error":true,"api_error_status":429,"result":"You\'ve hit your weekly limit · resets 8am (America/New_York)"}';
const CODEX_TEXT =
  "ERROR: You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Sep 18th, 2026 4:23 PM.";
const GROK_TEXT =
  'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted\n\nRequest URL: https://cli-chat-proxy.grok.com/v1/responses",\n  "http_status": 402\n}';
const AGY_STDERR =
  'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';

const NOW = new Date("2026-08-25T12:05:00Z");

test("claude's weekly-limit prose resolves to the NEXT 8am in the zone it named", () => {
  assert.equal(parseResetsPhrase(CLAUDE_TEXT, NOW), "2026-08-26T12:00:00.000Z");
  assert.equal(parseResetsPhrase(CLAUDE_TEXT_DATED, NOW), "2026-08-26T12:00:00.000Z");

  const plain = classifyAgentFailure("claude", { code: 1, raw: CLAUDE_TEXT, stderr: "" }, NOW);
  assert.equal(plain.state, "quota_exhausted");
  assert.equal(plain.window, "7d");
  assert.equal(plain.resets_at, "2026-08-26T12:00:00.000Z");
  assert.match(plain.detail, /^Weekly limit — resets /);
  assert.ok(plain.detail.length <= 120);

  const dated = classifyAgentFailure("claude", { code: 1, raw: CLAUDE_TEXT_DATED, stderr: "" }, NOW);
  assert.equal(dated.resets_at, "2026-08-26T12:00:00.000Z");
});

test("the reset phrase parses every shape the providers actually print", () => {
  // The two that were already verified against live output.
  assert.equal(parseResetsPhrase("resets 8am (America/New_York)", NOW), "2026-08-26T12:00:00.000Z");
  assert.equal(parseResetsPhrase("resets Aug 26, 8am (America/New_York)", NOW), "2026-08-26T12:00:00.000Z");

  // A YEAR in the phrase. The old pattern's year group was unreachable — the
  // optional comma had already been eaten — so the hour group took the "20" of
  // "2026" and the reset filed at 20:00 of the current year.
  assert.equal(parseResetsPhrase("resets Aug 26, 2026 8am (America/New_York)", NOW), "2026-08-26T12:00:00.000Z");
  assert.equal(parseResetsPhrase("resets Aug 26 2026, 8am (America/New_York)", NOW), "2026-08-26T12:00:00.000Z");
  // …and a year far enough out that a fallback to "current year" would be visible.
  assert.equal(parseResetsPhrase("resets Jan 3, 2027 8am (America/New_York)", NOW), "2027-01-03T13:00:00.000Z");

  // `at` before a DATELESS time. The old pattern kept `(?:at\s+)?` inside the
  // optional date group, so this string matched nothing at all.
  assert.equal(parseResetsPhrase("resets at 8:30pm (America/New_York)", NOW), "2026-08-26T00:30:00.000Z");

  // A real five-hour-window string: 12pm is noon, not midnight.
  assert.equal(parseResetsPhrase("resets 12:50pm (America/New_York)", NOW), "2026-08-25T16:50:00.000Z");
  assert.equal(parseResetsPhrase("resets 12:50am (America/New_York)", NOW), "2026-08-26T04:50:00.000Z");

  // Nothing clock-shaped → no guess. A bare number after "resets" is not a time.
  assert.equal(parseResetsPhrase("resets Aug 26, 2026 (America/New_York)", NOW), null);
  assert.equal(parseResetsPhrase("your plan resets monthly", NOW), null);
  // An impossible meridiem hour is refused rather than wrapped.
  assert.equal(parseResetsPhrase("resets 20pm (America/New_York)", NOW), null);
});

test("coaching prose that exited 0 is invalid output, never a hold on a healthy provider", () => {
  // `rate_limited` HOLDS, so a contract miss on a healthy run used to park the
  // provider because the reply happened to contain ordinary English.
  const prose = [
    "Your work capacity is trending up — the last three sessions all held their",
    "prescribed pace. Dinner landed around 503 kcal, which is a little light for a",
    "day like this one. If the legs still feel heavy, try again later in the week.",
    "Yesterday came in at 429 kcal under target.",
  ].join(" ");
  const f = classifyAgentFailure("claude", { code: 0, raw: prose, stderr: "" }, NOW);
  assert.equal(f.state, "invalid_output");
  assert.equal(availabilityHolds(f.state), false);

  // The SAME words on a failed run still read as throttling — the exit code is
  // the anchor, and an explicit status phrase is an anchor of its own.
  assert.equal(classifyAgentFailure("claude", { code: 1, raw: prose, stderr: "" }, NOW).state, "rate_limited");
  assert.equal(
    classifyAgentFailure("claude", { code: 0, raw: "Error: HTTP 529 from the API", stderr: "" }, NOW).state,
    "rate_limited"
  );
  assert.equal(
    classifyAgentFailure("claude", { code: 0, raw: "rate limit exceeded", stderr: "" }, NOW).state,
    "rate_limited"
  );
  assert.equal(
    classifyAgentFailure("claude", { code: 0, raw: "API error (status 429)", stderr: "" }, NOW).state,
    "rate_limited"
  );
});

test("the stream-json rate_limit_event beats the prose and carries the exact instant", () => {
  const info = parseStreamRateLimitEvent(CLAUDE_RATE_EVENT);
  assert.equal(info.status, "rejected");
  assert.equal(info.rateLimitType, "seven_day");

  const stream = [CLAUDE_RATE_EVENT, CLAUDE_TEXT, CLAUDE_RESULT_LINE].join("\n");
  const f = classifyAgentFailure("claude", { code: 1, raw: stream, stderr: "" }, NOW);
  assert.equal(f.state, "quota_exhausted");
  assert.equal(f.window, "7d");
  assert.equal(f.resets_at, new Date(1787745600 * 1000).toISOString());

  const fiveHour = CLAUDE_RATE_EVENT.replace("seven_day", "five_hour");
  assert.equal(classifyAgentFailure("claude", { code: 1, raw: fiveHour, stderr: "" }, NOW).window, "5h");
});

test("a 429 result line without limit prose is a temporary rate limit, not a quota", () => {
  const raw = '{"type":"result","is_error":true,"api_error_status":429,"result":"Overloaded"}';
  const f = classifyAgentFailure("claude", { code: 1, raw, stderr: "" }, NOW);
  assert.equal(f.state, "rate_limited");
  assert.equal(f.resets_at, null);
});

test("a five-hour session limit reads as its own window", () => {
  const f = classifyAgentFailure(
    "claude",
    { code: 1, raw: "You've hit your limit · resets 3pm (America/New_York)", stderr: "" },
    NOW
  );
  assert.equal(f.state, "quota_exhausted");
  assert.equal(f.window, "5h");
  assert.equal(f.resets_at, "2026-08-25T19:00:00.000Z");
});

test("codex's usage limit is a quota — the upgrade link never makes it a payment problem", () => {
  assert.equal(parseTryAgainPhrase(CODEX_TEXT, NOW, "America/New_York"), "2026-09-18T20:23:00.000Z");
  const f = classifyAgentFailure("codex", { code: 1, raw: CODEX_TEXT, stderr: "" }, NOW);
  assert.equal(f.state, "quota_exhausted");
  assert.equal(f.window, null);
  assert.ok(f.resets_at && f.resets_at.startsWith("2026-09-18"), f.resets_at);
  assert.doesNotMatch(f.detail, /chatgpt\.com|Upgrade/);
});

test("grok's 402 is payment_required with no reset to wait for", () => {
  const f = classifyAgentFailure("grok", { code: 1, raw: "", stderr: GROK_TEXT }, NOW);
  assert.equal(f.state, "payment_required");
  assert.equal(f.resets_at, null);
  assert.equal(f.detail, "Provider needs credit");
});

test("antigravity's headless permission refusal is op-level, never a provider hold", () => {
  const f = classifyAgentFailure("antigravity", { code: 0, raw: "", stderr: AGY_STDERR }, NOW);
  assert.equal(f.state, "permission_denied");
  assert.equal(availabilityHolds(f.state), false);
  assert.equal(holdUntil(f, 0, NOW), null);
  assert.doesNotMatch(f.detail, /jetski|settings\.json/);
});

test("auth, overload and the honest floors each get their own class", () => {
  assert.equal(
    classifyAgentFailure("claude", { code: 1, raw: "Not logged in. Please run /login", stderr: "" }, NOW).state,
    "auth_required"
  );
  // A long reply that merely mentions logging in is a coaching answer, not auth.
  const chatty = `${"word ".repeat(300)} please login`;
  assert.notEqual(classifyAgentFailure("claude", { code: 1, raw: chatty, stderr: "" }, NOW).state, "auth_required");
  assert.equal(
    classifyAgentFailure("claude", { code: 1, raw: "Error: overloaded, try again later", stderr: "" }, NOW).state,
    "rate_limited"
  );
  assert.equal(
    classifyAgentFailure("stub", { code: 0, raw: "here is some prose", stderr: "" }, NOW).state,
    "invalid_output"
  );
  assert.equal(classifyAgentFailure("stub", { code: 3, raw: "", stderr: "boom" }, NOW).state, "process_error");
});

test("hold policy: quota waits for the provider's own reset, throttling backs off, money waits a day", () => {
  const quota = { state: "quota_exhausted", window: "7d", resets_at: "2026-08-26T12:00:00.000Z", detail: "x" };
  assert.equal(holdUntil(quota, 0, NOW), "2026-08-26T12:00:00.000Z");
  // Unknown reset → an hour, never forever.
  const blind = { state: "quota_exhausted", window: null, resets_at: null, detail: "x" };
  assert.equal(holdUntil(blind, 0, NOW), new Date(NOW.getTime() + 3600000).toISOString());
  // A reset further out than the cap is clamped to 8 days.
  const far = { state: "quota_exhausted", window: null, resets_at: "2027-01-01T00:00:00.000Z", detail: "x" };
  assert.equal(holdUntil(far, 0, NOW), new Date(NOW.getTime() + 8 * 86400000).toISOString());

  const rate = { state: "rate_limited", window: null, resets_at: null, detail: "x" };
  assert.equal(holdUntil(rate, 0, NOW), new Date(NOW.getTime() + 5 * 60000).toISOString());
  assert.equal(holdUntil(rate, 2, NOW), new Date(NOW.getTime() + 20 * 60000).toISOString());
  assert.equal(holdUntil(rate, 40, NOW), new Date(NOW.getTime() + 3600000).toISOString());

  assert.equal(
    holdUntil({ state: "payment_required", resets_at: null, detail: "x" }, 0, NOW),
    new Date(NOW.getTime() + 24 * 3600000).toISOString()
  );
  assert.equal(
    holdUntil({ state: "auth_required", resets_at: null, detail: "x" }, 0, NOW),
    new Date(NOW.getTime() + 30 * 60000).toISOString()
  );
  for (const state of ["permission_denied", "invalid_output", "process_error"]) {
    assert.equal(holdUntil({ state, resets_at: null, detail: "x" }, 0, NOW), null);
  }
});

test("a held provider is named for a person, never in raw CLI words", () => {
  assert.equal(
    availabilityReason({ state: "quota_exhausted", window: "7d", resets_at: "2026-08-26T12:00:00.000Z" }, NOW),
    `weekly limit, resets ${formatResetForPerson("2026-08-26T12:00:00.000Z", NOW)}`
  );
  assert.equal(availabilityReason({ state: "payment_required", resets_at: null }, NOW), "needs credit");
  assert.equal(availabilityReason({ state: "invalid_output", resets_at: null }, NOW), "ran but returned no valid JSON");
});

// ---------- telemetry taxonomy ----------

test("telemetry keeps the availability classes and never lets 'usage limit' fall into auth", () => {
  for (const cls of ["quota_exhausted", "rate_limited", "payment_required", "permission_denied"]) {
    assert.equal(agentErrorClass("error", cls), cls);
  }
  assert.equal(agentErrorClass("usage_limit", null), "quota_exhausted");
  assert.equal(agentErrorClass("weekly_limit_auth", null), "quota_exhausted");
  assert.equal(agentErrorClass("http_429", null), "rate_limited");
  assert.equal(agentErrorClass("billing_error", null), "payment_required");
  assert.equal(agentErrorClass("permission_denied_headless", null), "permission_denied");
  assert.equal(agentErrorClass("auth", null), "auth_required");
  assert.equal(agentErrorClass("ok", null), null);
});

// ---------- persistence ----------

test("an availability hold survives as a row and expires on its own", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const failure = classifyAgentFailure("claude", { code: 1, raw: CLAUDE_TEXT, stderr: "" }, now);
  const row = repo.noteAgentFailure("claude", failure, "day_read", now);
  assert.equal(row.state, "quota_exhausted");
  assert.equal(row.window, "7d");
  assert.equal(row.streak, 1);
  assert.equal(row.op, "day_read");
  assert.equal(row.hold_until, "2026-08-26T12:00:00.000Z");

  assert.equal(repo.getAgentAvailability("claude", now).state, "quota_exhausted");
  assert.equal(repo.listAgentAvailability(now).length, 1);
  // Past the stated reset the hold simply stops applying.
  assert.equal(repo.getAgentAvailability("claude", new Date("2026-08-27T00:00:00Z")), null);
  assert.equal(repo.listAgentAvailability(new Date("2026-08-27T00:00:00Z")).length, 0);

  // The streak only advances while the SAME state repeats.
  const again = repo.noteAgentFailure("claude", failure, "day_read", now);
  assert.equal(again.streak, 2);
  const rate = { state: "rate_limited", window: null, resets_at: null, detail: "busy" };
  assert.equal(repo.noteAgentFailure("claude", rate, "chat", now).streak, 1);

  // A non-holding class leaves no durable row behind.
  assert.equal(
    repo.noteAgentFailure("claude", { state: "invalid_output", resets_at: null, detail: "x" }, "chat", now),
    null
  );
  assert.equal(repo.getAgentAvailability("claude", now), null);

  repo.noteAgentFailure("codex", failure, "chat", now);
  repo.clearAgentAvailability("codex");
  assert.equal(repo.getAgentAvailability("codex", now), null);
});

test("getAgentConfig carries the live hold so Settings can say why a provider is sitting out", () => {
  const now = new Date();
  const failure = {
    state: "quota_exhausted",
    window: "7d",
    resets_at: new Date(now.getTime() + 3600000).toISOString(),
    detail: "Weekly limit",
  };
  repo.noteAgentFailure("stub", failure, "day_read", now);
  const before = repo.getAgentConfig().find((a) => a.name === "stub");
  repo.noteAgentFailure("stub", failure, "day_read", now);
  const stub = repo.getAgentConfig().find((a) => a.name === "stub");
  assert.ok(stub, "stub agent should be in the config");
  assert.equal(stub.availability.state, "quota_exhausted");
  assert.equal(stub.availability.window, "7d");
  assert.ok(stub.availability.hold_until);
  // A hold is a prediction, not an exclusion: usability is untouched.
  assert.equal(stub.usable, before.usable);

  repo.clearAgentAvailability("stub");
  assert.equal(repo.getAgentConfig().find((a) => a.name === "stub").availability, null);
});

// ---------- rotation ----------

async function withFixtureAgents(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-avail-"));
  const marker = path.join(dir, "spawns.log");
  const shout = (text, code) =>
    `printf '%s' ${JSON.stringify(text)}; echo "x" >> ${JSON.stringify(marker)}; exit ${code}`;
  const config = {
    limited: {
      command: "sh",
      args: ["-c", shout(CLAUDE_TEXT, 1)],
      input: "arg",
      description: "fixture",
      env_required: [],
    },
    limited_codex: {
      command: "sh",
      args: ["-c", shout(CODEX_TEXT, 1)],
      input: "arg",
      description: "fixture",
      env_required: [],
    },
    healthy: {
      command: "sh",
      args: ["-c", `printf '%s' '{"ok":true}'`],
      input: "arg",
      description: "fixture",
      env_required: [],
    },
  };
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  const spawns = () =>
    fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length : 0;
  try {
    return await fn({ spawns });
  } finally {
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    setAgentAvailabilitySink(null);
    setAgentDiagnosticSink(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function wireRepoSink() {
  setAgentAvailabilitySink({
    held: (name, now) => {
      const row = repo.getAgentAvailability(name, now);
      return row
        ? { state: row.state, detail: row.detail, hold_until: row.hold_until, resets_at: row.resets_at }
        : null;
    },
    noteFailure: (name, failure, op) => {
      repo.noteAgentFailure(name, failure, op);
    },
    clear: (name) => repo.clearAgentAvailability(name),
  });
}

test("the rotation learns a limit once, then routes around it WITHOUT spawning it again", () =>
  withFixtureAgents(async ({ spawns }) => {
    wireRepoSink();
    const first = await runAgentWithFallback(["limited", "healthy"], "hi", { timeoutMs: 8000, op: "day_read" });
    assert.equal(first.agent, "healthy");
    assert.equal(spawns(), 1, "the limited provider was probed exactly once");
    assert.equal(first.tried[0].agent, "limited");
    assert.equal(first.tried[0].availability.state, "quota_exhausted");
    assert.match(first.tried[0].error, /weekly limit/);
    assert.equal(repo.getAgentAvailability("limited").state, "quota_exhausted");

    const second = await runAgentWithFallback(["limited", "healthy"], "hi", { timeoutMs: 8000, op: "day_read" });
    assert.equal(second.agent, "healthy");
    assert.equal(spawns(), 1, "a held provider is skipped without spawning while a healthy one remains");
    const skipped = second.tried.find((t) => t.agent === "limited");
    assert.ok(skipped, "the skipped provider is still in the ledger");
    assert.equal(skipped.availability.state, "quota_exhausted");
    assert.ok(skipped.availability.hold_until);
  }));

test("a held provider is still probed when it is the only option — a hold is a prediction", () =>
  withFixtureAgents(async ({ spawns }) => {
    wireRepoSink();
    await assert.rejects(() => runAgentWithFallback(["limited"], "hi", { timeoutMs: 8000, op: "day_read" }));
    assert.equal(spawns(), 1);
    await assert.rejects(() => runAgentWithFallback(["limited"], "hi", { timeoutMs: 8000, op: "day_read" }));
    assert.equal(spawns(), 2, "with nothing else to try, the held provider is probed anyway");
  }));

test("a success clears the hold, and an exhausted rotation files ONE taxonomy-only warning", () =>
  withFixtureAgents(async () => {
    wireRepoSink();
    const events = [];
    setAgentDiagnosticSink((e) => events.push(e));

    await assert.rejects(
      () => runAgentWithFallback(["limited", "limited_codex"], "hi", { timeoutMs: 8000, op: "insight" }),
      (err) => {
        assert.equal(err.name, "AgentFallbackError");
        assert.match(err.message, /limited: weekly limit/);
        assert.match(err.message, /limited_codex: usage limit/);
        return true;
      }
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      source: "agent",
      kind: "rotation_exhausted",
      level: "warning",
      operation: "insight",
      fingerprint: "agent:rotation_exhausted:insight:quota_exhausted",
      message: "no provider available (quota_exhausted)",
    });

    repo.noteAgentFailure(
      "healthy",
      { state: "rate_limited", window: null, resets_at: null, detail: "busy" },
      "insight"
    );
    assert.ok(repo.getAgentAvailability("healthy"));
    const ok = await runAgentWithFallback(["healthy"], "hi", { timeoutMs: 8000, op: "insight" });
    assert.equal(ok.agent, "healthy");
    assert.equal(repo.getAgentAvailability("healthy"), null, "a success is proof the provider answers");
  }));

test("the rotation-exhausted warning is filed against the dominant state", () => {
  assert.equal(dominantTriedState([]), "invalid_output");
  assert.equal(
    dominantTriedState([
      { agent: "a", error: "x", availability: { state: "quota_exhausted" } },
      { agent: "b", error: "x", availability: { state: "quota_exhausted" } },
      { agent: "c", error: "x", availability: { state: "process_error" } },
    ]),
    "quota_exhausted"
  );
});

// ---------- the Settings chip ----------

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escAttr(value) {
  return escHtml(value).replace(/"/g, "&quot;");
}

function loadSettingsClient() {
  const context = { Math, Number, String, Object, Array, Set, Date, Intl, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, "public/js/settings-client.js"), "utf8"), context);
  return context.CairnSettingsClient;
}

test("a limited provider says so on its chip, in amber words, with the calm reassurance under it", () => {
  const settings = loadSettingsClient();
  const now = new Date("2026-08-25T12:05:00Z");
  const limited = {
    present: true,
    configured: true,
    availability: {
      state: "quota_exhausted",
      detail: "Weekly limit — resets Wed 8:00 AM",
      resets_at: "2026-08-26T12:00:00.000Z",
      hold_until: "2026-08-26T12:00:00.000Z",
      window: "7d",
    },
  };
  const chip = settings.agentChipState(limited, now);
  assert.equal(chip.cls, "agent-chip-limit");
  assert.match(chip.label, /^Limit reached · resets /);
  assert.match(settings.agentAvailabilityNote(limited, now), /Cairn routes around it until then\./);

  const busy = {
    present: true,
    configured: true,
    availability: {
      state: "rate_limited",
      detail: "Provider busy",
      resets_at: null,
      hold_until: new Date(now.getTime() + 12 * 60000).toISOString(),
      window: null,
    },
  };
  assert.equal(settings.agentChipState(busy, now).label, "Busy · retry in 12m");

  const credit = {
    present: true,
    configured: true,
    availability: {
      state: "payment_required",
      detail: "Provider needs credit",
      resets_at: null,
      hold_until: null,
      window: null,
    },
  };
  assert.equal(settings.agentChipState(credit, now).label, "Needs credit");

  // Nothing held → the existing states are untouched.
  assert.equal(settings.agentChipState({ present: false }, now).label, "Not installed");
  assert.equal(settings.agentChipState({ configured: true }, now).label, "✓ Connected");
  assert.equal(settings.agentChipState({ configured: false }, now).label, "Connect →");
  assert.equal(settings.agentAvailabilityNote({ configured: true }, now), "");
});

test("the activity log and health card name the new classes in plain words", () => {
  const settings = loadSettingsClient();
  const health = settings.agentHealthCard({
    runs: 4,
    ok_rate: 0.5,
    by_agent: [
      { agent: "claude", ok: 2, fail: 2, auth_required: 0, quota_exhausted: 2, payment_required: 1, p50_ms: 900 },
    ],
  });
  assert.match(health, /2 limit/);
  assert.match(health, /1 credit/);
});

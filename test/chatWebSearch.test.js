// Chat questions about the outside world (2026-11-22). Two real turns asked for spring
// half marathons around Boston and then said "do the actual search"; both ran with web
// search off, answered from memory, and the second said "I can't run a live web search
// from here". This file holds the fix end to end, offline:
//   - a web turn runs ONLY on agents that declare web_access, with tools "web", a prompt
//     that leads with today's date and the web block, and no coach_read hijack;
//   - an ordinary turn may escalate to the web exactly ONCE (an explicit web_search
//     request, or a from-memory answer), never in a loop;
//   - the CLI argv carries each CLI's documented web switch only on a web run;
//   - groundReply holds dated outside-world specifics to a source, and leaves coaching alone.
// No CLI spawns and no network: the runners are injected fakes, and AGENTS_CONFIG points
// at a fixture table whose agents are plain `sh` (present, so they are "usable").
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repo } from "./_seed.js";
import {
  CHAT_REPLY_SENTINEL,
  CHAT_WEB_QUERY_PRIVACY_LINE,
  parseChatReply,
  parseChatWebSearchRequest,
  CHAT_WEB_SEARCH_UNAVAILABLE_REPLY,
  chatWebEscalationContract,
  renderChatWebBlock,
} from "../dist/prompt.js";
import {
  chatTurnOwnRaces,
  chatWebEscalationTimeoutMs,
  chatWebProviderOrder,
  chatWebTurnTimeoutMs,
  runChatCompletion,
} from "../dist/chatTurns.js";
import { decideChatRouting } from "../dist/chatRouting.js";
import { NO_TOOLS_PREAMBLE, WEB_TOOLS_PREAMBLE, applyToolPolicy, buildAgentLaunch } from "../dist/agents.js";
import {
  groundReply,
  outsideWorldReplyNeedsWeb,
  readOutsideWorldReply,
  OUTSIDE_WORLD_UNSOURCED_VARIANTS,
  OUTSIDE_WORLD_UNVERIFIED_VARIANTS,
} from "../dist/chatGrounding.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const shipped = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));

// ---------- a fixture agent table: one web-capable agent, one not ----------
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-web-agents-"));
const fixtureConfig = path.join(fixtureDir, "agents.json");
const shAgent = (extra = {}) => ({
  command: "sh",
  args: ["-c", "printf '%s' never-spawned", "{prompt}"],
  input: "arg",
  description: "fixture",
  env_required: [],
  ...extra,
});
fs.writeFileSync(
  fixtureConfig,
  JSON.stringify({ webby: shAgent({ web_access: true }), plain: shAgent(), stub: shAgent() })
);
const previousConfig = process.env.AGENTS_CONFIG;
process.env.AGENTS_CONFIG = fixtureConfig;
after(() => {
  if (previousConfig == null) delete process.env.AGENTS_CONFIG;
  else process.env.AGENTS_CONFIG = previousConfig;
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const REAL_SPRING_HALF =
  "…maybe I can add some spring half marathon race to my goals? Is there something cool happening around Boston area?";
const REAL_DO_THE_SEARCH =
  "Do the actual search and find what is happening. I am not looking to do a 5k race…Races I apply for half marathons.";

const SOURCED_REPLY = `${CHAT_REPLY_SENTINEL}
Two spring halves near Boston look like a fit:
- Cape Cod Half Marathon on April 12, 2027, registration open per the race site, checked today: https://www.capecodhalf.example-race.org/register
- Run to Remember Half Marathon on May 30, 2027 (organiser's page): https://www.runtoremember.org/
I couldn't confirm the course maps yet.`;

function recorder(script) {
  const calls = [];
  let i = 0;
  const run = async (name, prompt, opts) => {
    calls.push({ name, prompt, tools: opts?.tools ?? "none", timeoutMs: opts?.timeoutMs });
    const step = script[i++] ?? `${CHAT_REPLY_SENTINEL}\n(no more scripted turns)`;
    const raw = typeof step === "function" ? step(name) : step;
    if (raw instanceof Error) throw raw;
    for (const piece of String(raw).match(/[\s\S]{1,9}/g) ?? [raw]) opts?.onDelta?.(piece);
    return { code: 0, raw, stderr: "", usage: {} };
  };
  return { calls, run };
}

function turnFixture(message, overrides = {}) {
  return {
    id: 7310,
    agent: "auto",
    message,
    image_path: null,
    routing: decideChatRouting({ message, recent_food_capture: true }),
    ...overrides,
  };
}

function enableFixtureAgents() {
  repo.setSettings({ disabled_agents: [], agent_order: ["plain", "stub", "webby"], chat_context: "lean" });
}

// ---------- the two real messages end in a web search ----------

for (const [label, message] of [
  ["spring half", REAL_SPRING_HALF],
  ["do the actual search", REAL_DO_THE_SEARCH],
]) {
  test(`real message (${label}) runs with web tools on the web-capable agent, with the date and web block`, async () => {
    enableFixtureAgents();
    const { calls, run } = recorder([SOURCED_REPLY]);
    const out = await runChatCompletion(7310, turnFixture(message), [], new AbortController().signal, {
      runAgentStreaming: run,
      runAgent: run,
      supportsStream: () => true,
    });
    assert.equal(calls.length, 1, "one attempt, no escalation needed");
    assert.equal(calls[0].name, "webby", "a web turn starts on the agent that can search");
    assert.equal(calls[0].tools, "web");
    assert.match(calls[0].prompt, /=== WEB SEARCH TURN ===/);
    assert.match(calls[0].prompt, /Today is \w+, \d{1,2} \w+ 20\d\d\./, "today's date in full");
    assert.match(calls[0].prompt, /Search the web now; do not answer from memory/);
    assert.match(calls[0].prompt, /carries its source as a plain link/);
    assert.doesNotMatch(calls[0].prompt, /=== COACH READS: LOOK IT UP ===/, "the coach_read loop does not hijack a web turn");
    assert.match(calls[0].prompt, /THIS TURN IS ABOUT THE OUTSIDE WORLD/);
    assert.match(calls[0].prompt, /\nDATA:\n/, "the athlete's DATA block is still in the prompt");
    assert.ok(calls[0].timeoutMs >= 240_000, "a web turn gets the longer leash");
    assert.deepEqual(out.web, { mode: "searched", escalated: false });
  });
}

test("a web turn never searches on a non-web agent: it falls back with the honest block and tools off", async () => {
  enableFixtureAgents();
  const { calls, run } = recorder([
    (name) => (name === "webby" ? new Error("webby: spawn failed") : `${CHAT_REPLY_SENTINEL}\nI couldn't search just now.`),
    `${CHAT_REPLY_SENTINEL}\nI couldn't search just now, so check the organiser's page.`,
  ]);
  const out = await runChatCompletion(7310, turnFixture(REAL_DO_THE_SEARCH), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
  });
  assert.equal(calls[0].name, "webby");
  for (const call of calls) {
    if (call.tools === "web") assert.equal(call.name, "webby", "only a web-capable agent ever runs with web tools");
  }
  const fallback = calls.find((c) => c.name !== "webby");
  assert.ok(fallback, "a non-web agent answered once the web agent failed");
  assert.equal(fallback.tools, "none");
  assert.match(fallback.prompt, /THIS QUESTION NEEDS THE WEB, AND YOU CANNOT SEARCH ON THIS RUN/);
  assert.doesNotMatch(fallback.prompt, /=== WEB SEARCH TURN ===/);
  assert.equal(out.web.mode, "unavailable");
});

test("a turn pinned to the offline stub still searches on the web-capable agent", async () => {
  enableFixtureAgents();
  const { calls, run } = recorder([SOURCED_REPLY]);
  const out = await runChatCompletion(7310, turnFixture(REAL_SPRING_HALF, { agent: "stub" }), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
  });
  assert.equal(calls[0].name, "webby");
  assert.equal(calls[0].tools, "web");
  assert.equal(out.web.mode, "searched");
});

test("a coach_read request on a web turn is never run or shipped: the same agent is re-asked for prose", async () => {
  enableFixtureAgents();
  const coachRead = JSON.stringify({ kind: "coach_read", requests: [{ tool: "read_training_window", args: { end_date: null, weeks: 6 } }] });
  const { calls, run } = recorder([coachRead, SOURCED_REPLY]);
  let reads = 0;
  const out = await runChatCompletion(7310, turnFixture(REAL_DO_THE_SEARCH), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
    executeCoachRead: () => {
      reads++;
      return { tool: "read_training_window", data: {}, rows_returned: 0, truncated: false };
    },
  });
  assert.equal(reads, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, "webby");
  assert.ok(out.attempts.some((a) => a.status === "read_malformed"));
  assert.match(parseChatReply(out.raw).reply, /Two spring halves/);
});

test("chatWebProviderOrder puts every web agent first and can drop the rest", () => {
  const defs = { a: { web_access: false }, b: { web_access: true }, c: {}, d: { web_access: true } };
  assert.deepEqual(chatWebProviderOrder(["a", "b", "c", "d"], defs), { web: ["b", "d"], fallback: ["a", "c"] });
  assert.deepEqual(chatWebProviderOrder(["a", "b", "c", "d"], defs, { webOnly: true }), { web: ["b", "d"], fallback: [] });
});

// ---------- the one escalation ----------

test("an ordinary turn that asks for the web re-runs ONCE with web tools, then never again", async () => {
  enableFixtureAgents();
  const message = "Should I race the Boston one?"; // nothing here the detector calls web
  const routing = decideChatRouting({ message });
  assert.equal(routing.reason_codes.includes("current_research"), false);
  const ask = JSON.stringify({ web_search: { query: "Boston spring half marathon 2027", why: "race dates" } });
  // The web re-run asks AGAIN: a loop would keep going; the turn must stop at one re-run.
  const { calls, run } = recorder([ask, ask, ask]);
  const out = await runChatCompletion(7310, turnFixture(message, { routing }), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
  });
  assert.equal(calls.length, 2, "the first answer, then exactly one web re-run");
  assert.equal(calls[0].tools, "none");
  assert.match(calls[0].prompt, /"web_search":\{"query"/, "the ordinary turn is offered the request shape");
  assert.equal(calls[1].name, "webby");
  assert.equal(calls[1].tools, "web");
  assert.match(calls[1].prompt, /Search for: "Boston spring half marathon 2027" \(race dates\)\./);
  assert.doesNotMatch(calls[1].prompt, /"web_search":\{"query"/, "the re-run is never offered a second escalation");
  assert.ok(calls[1].timeoutMs >= 120_000 && calls[1].timeoutMs <= chatWebTurnTimeoutMs({ execution: null, requested: { reasoning: "high" } }));
  assert.deepEqual(out.web, { mode: "searched", escalated: true });
  assert.ok(out.attempts.some((a) => a.status === "web_escalated"));
  // The second request reached the parser: the athlete hears the search did not happen.
  assert.equal(parseChatReply(out.raw).reply, CHAT_WEB_SEARCH_UNAVAILABLE_REPLY);
});

test("a from-memory answer on an ordinary turn escalates once instead of shipping", async () => {
  enableFixtureAgents();
  const message = "Should I race the Boston one?";
  const routing = decideChatRouting({ message });
  const { calls, run } = recorder([
    `${CHAT_REPLY_SENTINEL}\nI can't run a live web search from here, but from memory there are a few spring halves.`,
    SOURCED_REPLY,
  ]);
  const out = await runChatCompletion(7310, turnFixture(message, { routing }), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].tools, "web");
  assert.match(out.raw, /capecodhalf/);
  assert.equal(out.web.escalated, true);
});

test("an ordinary coaching answer is shipped as is: no escalation, no web tools", async () => {
  enableFixtureAgents();
  const message = "How is my training trending?";
  const routing = decideChatRouting({ message });
  const { calls, run } = recorder([`${CHAT_REPLY_SENTINEL}\nYour volume held steady; keep the plan.`]);
  const out = await runChatCompletion(7310, turnFixture(message, { routing }), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools, "none");
  assert.deepEqual(out.web, { mode: "off", escalated: false });
});

test("the single-profile path (no routing row) reaches the web through the same detector", async () => {
  enableFixtureAgents();
  const { calls, run } = recorder([SOURCED_REPLY]);
  const out = await runChatCompletion(7310, turnFixture(REAL_SPRING_HALF, { routing: null }), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
  });
  assert.equal(calls[0].name, "webby");
  assert.equal(calls[0].tools, "web");
  assert.equal(out.web.mode, "searched");
});

test("the web leash follows the effort ladder and the re-run gets what is left of it", () => {
  const medium = { execution: null, requested: { reasoning: "medium" } };
  const xhigh = { execution: null, requested: { reasoning: "xhigh" } };
  assert.equal(chatWebTurnTimeoutMs(medium), 240_000);
  assert.equal(chatWebTurnTimeoutMs(xhigh), 300_000);
  assert.equal(chatWebEscalationTimeoutMs(medium, 100_000), 140_000);
  assert.equal(chatWebEscalationTimeoutMs(medium, 200_000), 120_000, "never under the floor");
  assert.equal(chatWebEscalationTimeoutMs(medium, 0), 240_000);
});

// ---------- the request shape and the reply parser ----------

test("parseChatWebSearchRequest reads bare JSON only, never a reply", () => {
  assert.deepEqual(parseChatWebSearchRequest('{"web_search":{"query":"Boston half 2027","why":"dates"}}'), {
    query: "Boston half 2027",
    why: "dates",
  });
  assert.equal(parseChatWebSearchRequest(`${CHAT_REPLY_SENTINEL}\n{"web_search":{"query":"x"}}`), null);
  assert.equal(parseChatWebSearchRequest('{"kind":"coach_read","requests":[]}'), null);
  assert.equal(parseChatWebSearchRequest("Plain prose."), null);
});

test("a web reply with a marker and source links survives parseChatReply intact", () => {
  const { reply, actions } = parseChatReply(`I searched three sites first.\n${SOURCED_REPLY}`);
  assert.deepEqual(actions, []);
  assert.match(reply, /^Two spring halves near Boston/);
  assert.match(reply, /https:\/\/www\.capecodhalf\.example-race\.org\/register/);
  assert.match(reply, /https:\/\/www\.runtoremember\.org\//);
  // No marker: a first line carrying a link is the answer, never tool-step narration.
  const bare = parseChatReply("Looking at what's on this spring: https://www.baa.org/races/half\nThe B.A.A. Half is in October.");
  assert.match(bare.reply, /^Looking at what's on this spring: https:\/\/www\.baa\.org/);
  // …while a web-search step line is narration.
  const narrated = parseChatReply("Let me search the web for spring halves near Boston.\nThe Cape Cod Half is in April.");
  assert.equal(narrated.reply, "The Cape Cod Half is in April.");
});

// ---------- tool policy and argv ----------

test("the web policy leads with its own preamble, once, and replaces the no-tools one", () => {
  const out = applyToolPolicy("DATA: {}", "web");
  assert.ok(out.startsWith(`${WEB_TOOLS_PREAMBLE}\n\n`));
  assert.equal(applyToolPolicy(out, "web"), out, "idempotent");
  const swapped = applyToolPolicy(applyToolPolicy("DATA: {}", "none"), "web");
  assert.ok(swapped.startsWith(WEB_TOOLS_PREAMBLE));
  assert.equal(swapped.includes(NO_TOOLS_PREAMBLE), false);
  assert.match(WEB_TOOLS_PREAMBLE, /do not read or list files or run commands/);
});

test("each CLI's documented web switch rides only on a web run", () => {
  const claude = shipped.claude;
  const codex = shipped.codex;
  const webPrompt = applyToolPolicy("Find spring halves.", "web");
  const plainPrompt = applyToolPolicy("Say hello.", "none");
  const claudeWeb = buildAgentLaunch(claude, claude.args, webPrompt, { webTools: true }).args;
  assert.ok(claudeWeb.includes("--allowedTools"));
  assert.equal(claudeWeb[claudeWeb.indexOf("--allowedTools") + 1], "WebSearch,WebFetch");
  assert.equal(String(claudeWeb[claudeWeb.indexOf("--allowedTools") + 2]).startsWith("-"), true, "the list is closed by a flag");
  assert.equal(claudeWeb.includes("{web_args}"), false);
  const claudeStream = buildAgentLaunch(claude, claude.stream.args, webPrompt, { webTools: true }).args;
  assert.ok(claudeStream.includes("--allowedTools"));
  // A chat web turn is CONFINED to the two web tools, never added to claude's full default
  // toolset: the web_turn_args mirror no_tools_args with the tool list narrowed.
  for (const argv of [claudeWeb, claudeStream]) {
    assert.equal(argv[argv.indexOf("--tools") + 1], "WebSearch,WebFetch", "the toolset itself is the web tools");
    assert.ok(String(argv[argv.indexOf("--tools") + 2]).startsWith("-"), "the --tools list is closed by a flag");
    for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) {
      assert.ok(argv.includes(flag), flag);
    }
    assert.equal(argv[argv.indexOf("--setting-sources") + 1], "user");
    assert.equal(argv.includes("default"), false, "never the default toolset");
    assert.equal(argv.filter((a) => a === "--tools").length, 1, "no_tools_args never rides beside it");
  }
  // Research (tools "provider") keeps web_args only: its prompt does not lead with the web preamble.
  const research = buildAgentLaunch(claude, claude.args, "Research creatine timing.", { webTools: true }).args;
  assert.ok(research.includes("--allowedTools"));
  assert.equal(research.includes("--tools"), false);
  assert.equal(buildAgentLaunch(claude, claude.args, plainPrompt).args.includes("--allowedTools"), false);
  // An MCP attach (native coach reads) is never widened to the web.
  const withMcp = buildAgentLaunch(claude, claude.args, webPrompt, { webTools: true, mcpConfigArgs: ["--mcp-config", "{}"] }).args;
  assert.equal(withMcp.includes("--allowedTools"), false);

  const codexWeb = buildAgentLaunch(codex, codex.args, webPrompt, { webTools: true }).args;
  assert.deepEqual(codexWeb.slice(0, 2), ["--search", "exec"], "codex's --search is a top-level flag, before exec");
  const codexPlain = buildAgentLaunch(codex, codex.args, plainPrompt).args;
  assert.equal(codexPlain[0], "exec");
  assert.equal(codexPlain.includes("--search"), false);

  // Only CLIs with a documented web path declare it.
  assert.equal(shipped.claude.web_access, true);
  assert.equal(shipped.codex.web_access, true);
  assert.equal(shipped.grok.web_access, true);
  assert.notEqual(shipped.antigravity.web_access, true);
  assert.notEqual(shipped.stub.web_access, true);
});

// ---------- the outside-world grounding pass ----------

const UNSOURCED = `Here are two spring halves near Boston:
- Cape Cod Half Marathon on April 12, 2027.
- Run to Remember Half Marathon on May 30, 2027.`;

test("dated outside-world specifics with no source get one calm caveat, worded by how the turn stood", () => {
  const searched = groundReply({ reply: UNSOURCED, applied: [], ctx: { web: "searched", today: "2026-11-22", week: null } });
  assert.ok(searched.reply.startsWith(UNSOURCED));
  assert.ok(OUTSIDE_WORLD_UNSOURCED_VARIANTS.some((line) => searched.reply.endsWith(line)));
  assert.ok(searched.notes.some((n) => n.kind === "outside_world" && n.web === "searched"));

  const asked = { message: REAL_SPRING_HALF, today: "2026-11-22", week: null };
  const memory = groundReply({ reply: UNSOURCED, applied: [], ctx: asked });
  assert.ok(OUTSIDE_WORLD_UNVERIFIED_VARIANTS.some((line) => memory.reply.endsWith(line)));
  // Said once: a second pass over the grounded reply adds nothing.
  assert.equal(groundReply({ reply: memory.reply, applied: [], ctx: asked }).reply, memory.reply);
  assert.equal(outsideWorldReplyNeedsWeb(UNSOURCED, { message: REAL_SPRING_HALF }), true);
});

// ---------- the athlete's own races are coaching, never outside-world claims ----------

const OWN_RACES_REPLY = `Nice work closing out the Hartford Marathon on Nov 1, that was a big block.
Then we build toward the Boston Half Marathon on Apr 12, starting with two easy weeks.`;
const OWN_RACES = [
  { name: "Boston Half Marathon", date: "2027-04-12" },
  { name: "Hartford Marathon", date: "2026-11-01" },
];

test("a coaching reply naming the athlete's own races is never re-run on the web or caveated", () => {
  // The reply reads as two dated items on its face…
  assert.deepEqual(
    (({ items, specifics }) => ({ items, specifics }))(readOutsideWorldReply(OWN_RACES_REPLY)),
    { items: 2, specifics: true }
  );
  // …but an ordinary coaching message never licenses a content read,
  const coaching = "How should I build toward spring after the marathon?";
  assert.equal(outsideWorldReplyNeedsWeb(OWN_RACES_REPLY, { message: coaching }), false);
  assert.equal(outsideWorldReplyNeedsWeb(OWN_RACES_REPLY), false);
  const plain = groundReply({ reply: OWN_RACES_REPLY, applied: [], ctx: { message: coaching, today: "2026-11-22", week: null } });
  assert.equal(plain.reply, OWN_RACES_REPLY);
  // …and the athlete's own races are not items even on an outside-world turn.
  const own = readOutsideWorldReply(OWN_RACES_REPLY, { ownRaces: OWN_RACES });
  assert.equal(own.items, 0);
  assert.equal(outsideWorldReplyNeedsWeb(OWN_RACES_REPLY, { message: REAL_SPRING_HALF, ownRaces: OWN_RACES }), false);
  for (const web of ["searched", "off"]) {
    const out = groundReply({
      reply: OWN_RACES_REPLY,
      applied: [],
      ctx: { message: REAL_SPRING_HALF, web, ownRaces: OWN_RACES, today: "2026-11-22", week: null },
    });
    assert.equal(out.reply, OWN_RACES_REPLY, web);
  }
  // A shortened name and a date-only goal still match; a different distance does not.
  assert.equal(readOutsideWorldReply(OWN_RACES_REPLY, { ownRaces: [{ name: "Eversource Hartford Marathon" }, { date: "2027-04-12" }] }).items, 0);
  const otherRace = "Boston Marathon on April 19.\nProvidence Marathon on May 3.";
  assert.equal(readOutsideWorldReply(otherRace, { ownRaces: OWN_RACES }).items, 2, "the Boston Half is not the Boston Marathon");
});

test("a from-memory disclaimer re-runs and caveats whatever the message was", () => {
  const coaching = "How should I build toward spring?";
  for (const disclaimer of [
    "I can't browse the web, but from what I know:",
    "I don't have live access, but as far as I know:",
    "As of my knowledge cutoff:",
  ]) {
    const reply = `${disclaimer}\n${UNSOURCED}`;
    assert.equal(outsideWorldReplyNeedsWeb(reply, { message: coaching }), true, disclaimer);
    const out = groundReply({ reply, applied: [], ctx: { message: coaching, today: "2026-11-22", week: null } });
    assert.ok(OUTSIDE_WORLD_UNVERIFIED_VARIANTS.some((line) => out.reply.endsWith(line)), disclaimer);
  }
  // No disclaimer, coaching message, web off: unsourced race names are left alone.
  assert.equal(outsideWorldReplyNeedsWeb(UNSOURCED, { message: coaching }), false);
  assert.equal(groundReply({ reply: UNSOURCED, applied: [], ctx: { message: coaching, today: "2026-11-22", week: null } }).reply, UNSOURCED);
});

test("an ordinary turn whose reply names the athlete's races ships as is: no web re-run", async () => {
  enableFixtureAgents();
  const message = "How should I build toward spring after the marathon?";
  const routing = decideChatRouting({ message });
  assert.equal(routing.reason_codes.includes("current_research"), false);
  const { calls, run } = recorder([`${CHAT_REPLY_SENTINEL}\n${OWN_RACES_REPLY}`]);
  const out = await runChatCompletion(7310, turnFixture(message, { routing }), [], new AbortController().signal, {
    runAgentStreaming: run,
    runAgent: run,
    supportsStream: () => true,
  });
  assert.equal(calls.length, 1, "the coaching reply is not thrown away");
  assert.equal(calls[0].tools, "none");
  assert.deepEqual(out.web, { mode: "off", escalated: false });
});

test("chatTurnOwnRaces reads the live race goal and the races kept after it", () => {
  repo.setProfile({ endurance_goal: { mode: "race", event: "Hartford Marathon", date: "2026-11-01", distance_km: 42.2 } });
  repo.setProfile({ endurance_goal: { mode: "race", event: "Boston Half Marathon", date: "2027-04-12", distance_km: 21.1 } });
  const races = chatTurnOwnRaces("2026-11-22");
  assert.ok(races.some((r) => r.name === "Boston Half Marathon" && r.date === "2027-04-12"), JSON.stringify(races));
  assert.ok(races.some((r) => r.name === "Hartford Marathon" && r.date === "2026-11-01"), JSON.stringify(races));
  assert.equal(readOutsideWorldReply(OWN_RACES_REPLY, { ownRaces: races }).items, 0);
});

// ---------- search queries carry no health data ----------

test("the web block and the escalation offer keep the athlete's health out of search queries", () => {
  const ctx = { now: { date: "2026-11-22", weekday: "Sunday" } };
  const block = renderChatWebBlock(ctx, { mode: "search" });
  assert.ok(block.includes(CHAT_WEB_QUERY_PRIVACY_LINE));
  assert.match(CHAT_WEB_QUERY_PRIVACY_LINE, /never the athlete's name, health, labs, body data or injuries/);
  assert.ok(chatWebEscalationContract({ mode: "offer" }).includes(CHAT_WEB_QUERY_PRIVACY_LINE));
});

test("a sourced web reply and ordinary coaching replies are left alone", () => {
  const sourced = parseChatReply(SOURCED_REPLY).reply;
  assert.equal(groundReply({ reply: sourced, applied: [], ctx: { web: "searched", today: "2026-11-22", week: null } }).reply, sourced);
  assert.equal(readOutsideWorldReply(sourced).sourced, true);
  for (const reply of [
    "Your volume held steady across the block. Keep the plan.",
    "Your Long Run on Nov 29 stays at 16 km, and the Easy Run on Dec 1 stays short.",
    "Your goal race, the Philadelphia Half Marathon on November 1, went well. Rest a few days.",
    "Protein landed at 150 g today, a solid day.",
  ]) {
    assert.equal(groundReply({ reply, applied: [], ctx: { today: "2026-11-22", week: null } }).reply, reply, reply);
    assert.equal(outsideWorldReplyNeedsWeb(reply), false, reply);
  }
  // A placeholder link is not a source.
  assert.equal(readOutsideWorldReply(`${UNSOURCED}\nhttps://example.com/races`).sourced, false);
});

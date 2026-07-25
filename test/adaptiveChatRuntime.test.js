import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  buildChatProviderOrder,
  chatExecutionAttemptKey,
  chatTurnTimeoutMs,
  completeInstantFoodCapture,
  inferCaptureMeal,
  isInstantFoodCaptureDecision,
  resolveRuntimeChatProfile,
  shouldCreatePhotoFoodPlaceholder,
} from "../dist/chatTurns.js";
import { loadAgents } from "../dist/agents.js";
import { classifyChatRoute, resolveChatProfile } from "../dist/chatRouting.js";
import {
  buildChatPrompt,
  CHAT_ESCALATE_COACH_SENTINEL,
  CHAT_ESCALATE_DEEP_SENTINEL,
  CHAT_REPLY_SENTINEL,
  parseChatEscalationRequest,
  parseChatReply,
} from "../dist/prompt.js";
import { createChatStreamFilter } from "../dist/chatStreamFilter.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages", "food_notes", "memory", "health_documents", "health_directives");
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive" });
});

test("strict text capture creates and links one food note, finishes synchronously, and replays idempotently", () => {
  const raw = "Log turkey and rice for lunch";
  const routing = classifyChatRoute({ message: raw, has_image: false });
  const user = repo.addChatMessage("user", raw);
  const turn = repo.createChatTurn({ message: raw, routing, user_message_id: user.id });

  const first = completeInstantFoodCapture(turn.id, raw);
  const second = completeInstantFoodCapture(turn.id, raw);
  const stored = repo.getChatTurn(turn.id);
  const foods = repo.listFoodNotes(10);
  assert.equal(foods.length, 1);
  assert.equal(foods[0].raw_output, raw, "the exact athlete text drives ordinary text enrichment");
  assert.equal(foods[0].meal, "lunch");
  assert.equal(stored.capture_food_note_id, foods[0].id);
  assert.equal(stored.status, "done");
  assert.equal(first.turn.assistant_message_id, second.turn.assistant_message_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role='assistant'").get().n, 1);
  assert.deepEqual(stored.meta.routing, routing);
  assert.equal(stored.meta.applied[0].type, "log_food");
});

test("photo-only stays capture-fast but cannot instant-log or create a placeholder", () => {
  const routing = classifyChatRoute({ message: "", has_image: true });
  const turn = repo.createChatTurn({ message: "", image_path: "/tmp/plate.jpg", routing });
  assert.equal(routing.lane, "capture");
  assert.equal(isInstantFoodCaptureDecision(routing, ""), false);
  assert.equal(completeInstantFoodCapture(turn.id, ""), null);
  assert.equal(shouldCreatePhotoFoodPlaceholder(""), false);
  assert.equal(repo.listFoodNotes(10).length, 0);
});

test("an explicitly requested food photo uses instant capture exactly once", () => {
  const message = "Log this lunch photo";
  const routing = classifyChatRoute({ message, has_image: true });
  const turn = repo.createChatTurn({ message, image_path: "/tmp/lunch.jpg", routing });
  assert.equal(isInstantFoodCaptureDecision(routing, message), true);
  completeInstantFoodCapture(turn.id, message);
  completeInstantFoodCapture(turn.id, message);
  const foods = repo.listFoodNotes(10);
  assert.equal(foods.length, 1);
  assert.equal(foods[0].image_path, "/tmp/lunch.jpg");
});

test("instant bypass is conservative for questions, corrections, risk, and legacy turns", () => {
  assert.equal(isInstantFoodCaptureDecision(classifyChatRoute({ message: "Log lunch?" }), "Log lunch?"), false);
  assert.equal(
    isInstantFoodCaptureDecision(classifyChatRoute({ message: "Fix my logged lunch" }), "Fix my logged lunch"),
    false
  );
  assert.equal(
    isInstantFoodCaptureDecision(classifyChatRoute({ message: "Log lunch but account for my medication" }), "Log lunch but account for my medication"),
    false
  );
  assert.equal(isInstantFoodCaptureDecision(null, "Log lunch"), false, "single mode carries no adaptive decision");
  const mixed = classifyChatRoute({ message: "Log lunch and suggest a high-protein dinner" });
  assert.equal(mixed.lane, "coach");
  assert.ok(mixed.reason_codes.includes("explicit_food_log"));
  assert.equal(isInstantFoodCaptureDecision(mixed, "Log lunch and suggest a high-protein dinner"), false);
  assert.equal(inferCaptureMeal("ate oatmeal", 8), "breakfast");
  assert.equal(inferCaptureMeal("late bite", 16), "snack");
});

test("capture prompt retains food ids and hard constraints but excludes full training and clinical history", () => {
  repo.setProfile({ allergies: "Severe peanut allergy", dietary_restrictions: "No shellfish" });
  repo.savePlanDay(1, "SECRET TRAINING PLAN", "legs", [
    { exercise: "SECRET BARBELL MOVEMENT", sets: 3, rep_low: 5, rep_high: 5 },
  ]);
  repo.addHealthDocument({
    kind: "bloodwork",
    summary: "SECRET CLINICAL HISTORY",
    parsed_json: { markers: [{ name: "SECRET MARKER", value: 999 }] },
    enrichment_status: "done",
  });
  const food = repo.addFoodNote("breakfast", "", { summary: "Oats", kcal: 300, protein_g: 20 });
  repo.addMemory("Prefers a high-protein breakfast", "preference", "test");
  repo.addSupplement({ name: "Creatine", dose: "5 g", frequency: "daily" });

  const capture = buildChatPrompt([], "Log lunch", undefined, { lane: "capture" });
  const coach = buildChatPrompt([], "How is training?", undefined, { lane: "coach" });
  assert.match(capture, new RegExp(`\\"id\\":${food.id}`));
  assert.match(capture, /Severe peanut allergy/);
  assert.match(capture, /Creatine/);
  assert.doesNotMatch(capture, /SECRET TRAINING PLAN|SECRET BARBELL MOVEMENT|SECRET CLINICAL HISTORY|SECRET MARKER/);
  assert.match(coach, /SECRET TRAINING PLAN|SECRET BARBELL MOVEMENT/);
});

test("escalation is monotonic, hidden from parsing and streaming, and deep cannot downgrade", () => {
  assert.equal(parseChatEscalationRequest(CHAT_ESCALATE_COACH_SENTINEL, "capture"), "coach");
  assert.equal(parseChatEscalationRequest(CHAT_ESCALATE_DEEP_SENTINEL, "coach"), "deep");
  assert.equal(parseChatEscalationRequest(CHAT_ESCALATE_COACH_SENTINEL, "coach"), null);
  assert.equal(parseChatEscalationRequest(CHAT_ESCALATE_COACH_SENTINEL, "deep"), null);
  assert.equal(parseChatReply(`${CHAT_ESCALATE_COACH_SENTINEL}\n${CHAT_REPLY_SENTINEL}\nReady.`).reply, "Ready.");

  const events = [];
  const stream = createChatStreamFilter((event) => events.push(event));
  stream.push(`${CHAT_REPLY_SENTINEL}\nVisible text\n${CHAT_ESCALATE_DEEP_SENTINEL}\ninternal`);
  stream.finish();
  const visible = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
  assert.match(visible, /Visible text/);
  assert.doesNotMatch(visible, /CAIRN_ESCALATE|internal/);
  const final = parseChatReply(
    `${CHAT_REPLY_SENTINEL}\nVisible final\n${CHAT_ESCALATE_DEEP_SENTINEL}\ninternal tail\n===CAIRN_ACTIONS===\n{"actions":[]}`
  );
  assert.equal(final.reply, "Visible final");
  assert.deepEqual(final.actions, []);
});

test("pinned providers fall through and escalation keys include the lane", () => {
  assert.deepEqual(buildChatProviderOrder("pinned", ["auto-a", "pinned", "auto-b"]), [
    "pinned",
    "auto-a",
    "auto-b",
  ]);
  const profile = { effective: { reasoning: "medium" } };
  assert.notEqual(
    chatExecutionAttemptKey("capture", "custom", profile),
    chatExecutionAttemptKey("coach", "custom", profile),
    "the same provider/profile is eligible again after a stronger-lane prompt"
  );
});

test("current research starts with an enabled web-capable provider while explicit providers stay first", () => {
  const definitions = {
    local: { web_access: false },
    web: { web_access: true },
    backup: { web_access: false },
  };
  assert.deepEqual(
    buildChatProviderOrder("local", ["local", "web", "backup"], { preferWeb: true, definitions }),
    ["web", "local", "backup"],
    "a Settings pin cannot send current research to a stale non-web answer while web is enabled"
  );
  assert.deepEqual(
    buildChatProviderOrder("local", ["local", "web", "backup"], {
      preferWeb: true,
      preserveSelectedFirst: true,
      definitions,
    }),
    ["local", "web", "backup"],
    "an explicitly named provider remains a deliberate first choice, with web next for fallback"
  );
  assert.deepEqual(
    buildChatProviderOrder("local", ["local", "backup"], { preferWeb: true, definitions }),
    ["local", "backup"],
    "no web-capable provider leaves the existing safe fallthrough order intact"
  );
});

test("a chat attempt's leash follows the lane's effort, so a deep turn is not killed mid-think", () => {
  const agents = loadAgents();
  // The whole chain, lane -> profile -> leash. A deep-lane turn runs at high effort;
  // under the old flat 90s cap it was killed mid-think and the rotation handed the
  // question to another agent. capture stays exactly where it was.
  const leashFor = (lane) =>
    chatTurnTimeoutMs(resolveRuntimeChatProfile(agents.claude, resolveChatProfile(lane, "claude", {}), false));
  assert.equal(leashFor("capture"), 90_000);
  assert.equal(leashFor("coach"), 150_000);
  assert.equal(leashFor("deep"), 240_000);

  // A provider that tops out below the request degrades, and the leash follows the
  // DEGRADED effort — not the one we asked for.
  const grok = resolveRuntimeChatProfile(agents.grok, { reasoning: "xhigh" }, false);
  assert.equal(grok.execution?.reasoning, "high");
  assert.equal(chatTurnTimeoutMs(grok), 240_000);

  // A provider that takes no profile flags gets no effort argument, but the QUESTION
  // was still a deep one — fall back to the requested effort rather than the short cap.
  const custom = resolveRuntimeChatProfile({ command: "custom-cli", args: ["{prompt}"] }, { reasoning: "high" }, false);
  assert.equal(custom.execution, null);
  assert.equal(chatTurnTimeoutMs(custom), 240_000);
  // A rejected binding keeps `requested` too, so an explicitly-bound deep turn still waits.
  const rejected = resolveRuntimeChatProfile(
    { command: "custom-cli", args: ["{prompt}"] },
    { model: "m", reasoning: "high" },
    true
  );
  assert.equal(rejected.execution, null);
  assert.match(rejected.unsupported, /does not support/i);
  assert.equal(chatTurnTimeoutMs(rejected), 240_000);
  // Nothing known at all (legacy/no profile) keeps today's leash.
  assert.equal(chatTurnTimeoutMs({ execution: null, requested: null }), 90_000);
});

test("legacy custom providers run with provider defaults when adaptive defaults are unsupported", () => {
  const custom = { command: "custom-cli", args: ["{prompt}"] };
  const profile = resolveRuntimeChatProfile(custom, { reasoning: "medium" }, false);
  assert.equal(profile.unsupported, null);
  assert.equal(profile.execution, null);
  assert.equal(profile.effective, null);

  const bound = resolveRuntimeChatProfile(custom, { model: "configured-model", reasoning: "medium" }, true);
  assert.equal(bound.execution, null);
  assert.match(bound.unsupported, /does not support/i);
});

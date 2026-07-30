import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("logged food has a dedicated Plan Food tab and shortcuts land there", () => {
  const ui = file("public/js/02-ui.js");
  const uiSegments = file("public/js/ui-segments-client.js");
  const meals = file("public/js/06-coach-meals.js");
  const todayRailLoaders = file("src/client/today-rail-loaders-client.ts");
  const chat = file("public/js/09-plan-chat.js");
  const chatFuelContext = file("public/js/chat-fuel-context-client.js");
  const appRenderDispatch = file("public/js/app-render-dispatch.js");

  assert.match(uiSegments, /\["food",\s*"Food"\]/, "Plan segment includes Food");
  assert.match(uiSegments, /food: \(\) => deps\.renderFoodJournal\(\)/, "Food segment is wired to the journal renderer");
  assert.match(ui, /planSeg\(\) \{[\s\S]*uiSegments\(\)\.planSeg\(\)/, "UI shell delegates Plan segments");
  assert.match(meals, /segBar\("food", planSeg\(\)\)/, "daily journal renders as the active Food segment");
  assert.match(meals, /class="meal-energy food-journal"/, "Food tab owns the daily journal and energy surface");
  assert.match(todayRailLoaders, /deps\.state\.planJump = "food"; deps\.activateTab\("plan"\)/, "Today logged-fuel card opens Food");
  assert.match(chat, /state\.planJump = "food"; activateTab\("plan"\)/, "Chat fuel strip opens Food");
  assert.match(chat, /chatFuelContextApi\(\)\.wants\(messages\)/, "Chat screen delegates fuel gating to the context helper");
  assert.match(chatFuelContext, /function chatFuelWantsSurface\(messages = chatFuelContextMessages\)/, "Chat fuel strip is gated by conversation context");
  assert.match(chatFuelContext, /if \(!chatFuelWantsSurface\(messages \|\| chatFuelContextMessages\)\) \{[\s\S]*slot\.innerHTML = "";[\s\S]*return;[\s\S]*\}/, "Unrelated chats suppress the fuel strip");
  assert.doesNotMatch(chat, /requestAnimationFrame\(measureChatTop\); \/\/ re-measure once layout\/fonts settle\s+loadChatFuel\(token\);/, "Chat fuel strip waits for hydrated messages, not the empty shell");
  assert.match(appRenderDispatch, /jump === "food" \? renderFoodJournal\(\)/, "Plan routing can jump directly to Food");
});

function loadChatFuelGate() {
  const chatClient = file("public/js/chat-client.js");
  const chatFuelContext = file("public/js/chat-fuel-context-client.js");
  const context = { window: {} };
  vm.runInNewContext(`
    function escHtml(s) { return String(s ?? ""); }
    function escAttr(s) { return String(s ?? ""); }
    function localISO() { return "2026-06-25"; }
    function chatDayISO() { return "2026-06-25"; }
    ${chatClient}
    globalThis.CairnChatClient = window.CairnChatClient;
    ${chatFuelContext}
    globalThis.chatFuelGate = { chatWantsFuelSurface: window.CairnChatFuelContext.wants };
  `, context);
  return context.chatFuelGate;
}

test("chat fuel strip follows current food intent, not broad health nutrition prose", () => {
  const { chatWantsFuelSurface } = loadChatFuelGate();

  assert.equal(chatWantsFuelSurface([
    { role: "user", content: "Would genome sequencing help with cross referencing my data and making more educated guesses about what to focus on and address my issues?" },
    { role: "assistant", content: "Most nutrition gene advice is noisy. Keep fat loss lean-safe and discuss lipid genetics with your doctor." },
  ]), false, "general health/genetics chat does not show today's fuel");

  assert.equal(chatWantsFuelSurface([
    { role: "user", content: "What did I log for breakfast today?" },
    { role: "assistant", content: "You logged breakfast earlier." },
  ]), true, "food-log questions can show today's fuel");

  assert.equal(chatWantsFuelSurface([
    { role: "user", content: "Log breakfast: turkey sourdough plate" },
    { role: "assistant", content: "Logged.", meta: { applied: [{ type: "log_food" }] } },
    { role: "user", content: "Would genome sequencing help with my LDL and ApoB?" },
    { role: "assistant", content: "A targeted lipid genetics panel may help." },
  ]), false, "a later unrelated user turn hides the earlier food banner");

  assert.equal(chatWantsFuelSurface([
    { role: "user", content: "Add half of Brussel sprouts from their appetizer list." },
    { role: "assistant", content: "Added half an order to lunch." },
  ]), true, "menu language (appetizer) is food intent even with no hardcoded item match");

  assert.equal(chatWantsFuelSurface([
    { role: "user", content: "Also add half of that portion for me" },
    {
      role: "assistant",
      content: "Updated your lunch.",
      meta: { routing: { reason_codes: ["explicit_food_log", "capture_correction"] } },
    },
  ]), true, "the server's routing verdict on the reply keeps the fuel strip up when the local regex has no signal");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const file = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("logged food has a dedicated Plan Food tab and shortcuts land there", () => {
  const ui = file("public/js/02-ui.js");
  const meals = file("public/js/06-coach-meals.js");
  const today = file("public/js/03-today.js");
  const chat = file("public/js/09-plan-chat.js");
  const boot = file("public/js/10-boot.js");

  assert.match(ui, /\["food", "Food"\]/, "Plan segment includes Food");
  assert.match(ui, /food: \(\) => renderFoodJournal\(\)/, "Food segment is wired to the journal renderer");
  assert.match(meals, /segBar\("food", planSeg\(\)\)/, "daily journal renders as the active Food segment");
  assert.match(meals, /class="meal-energy food-journal"/, "Food tab owns the daily journal and energy surface");
  assert.match(today, /state\.planJump = "food"; activateTab\("plan"\)/, "Today logged-fuel card opens Food");
  assert.match(chat, /state\.planJump = "food"; activateTab\("plan"\)/, "Chat fuel strip opens Food");
  assert.match(chat, /function chatWantsFuelSurface\(messages = chatFuelContext\)/, "Chat fuel strip is gated by conversation context");
  assert.match(chat, /if \(!chatWantsFuelSurface\(messages\)\) \{ slot\.innerHTML = ""; return; \}/, "Unrelated chats suppress the fuel strip");
  assert.doesNotMatch(chat, /requestAnimationFrame\(measureChatTop\); \/\/ re-measure once layout\/fonts settle\s+loadChatFuel\(token\);/, "Chat fuel strip waits for hydrated messages, not the empty shell");
  assert.match(boot, /jump === "food" \? renderFoodJournal\(\)/, "Plan routing can jump directly to Food");
});

function loadChatFuelGate() {
  const chat = file("public/js/09-plan-chat.js");
  const start = chat.indexOf("// Chat gets the logged-food glance");
  const end = chat.indexOf("// Expand the collapsed history", start);
  assert.ok(start > 0 && end > start, "chat fuel gate block is extractable");
  const context = {};
  vm.runInNewContext(`
    let chatFuelContext = [];
    function localISO() { return "2026-06-25"; }
    function chatDayISO() { return "2026-06-25"; }
    ${chat.slice(start, end)}
    globalThis.chatFuelGate = { chatWantsFuelSurface };
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
});

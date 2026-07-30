// Wave 5 — client rendering for the chat food-capture feedback chip.
//
// Two layers:
//   1. functional — the pure helpers in chat-client.js that turn a server-stamped
//      log_food action (and later a fetched food-note row) into the chip's content,
//      through every state: filling in → enriched → calm settle;
//   2. wiring — chat-message-client.ts arms the enrichment watch on render (live,
//      reload, or tab-switch re-render), upgrades the chip in place, and refreshes
//      the chat fuel strip when the macros land.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

function loadChatClient() {
  const context = { Math, Number, String, Date, RegExp, Set, JSON, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/chat-client.js"), "utf8"), context);
  return context.CairnChatClient;
}

test("captureFoodInfo pulls the linked note id, live status, and meal off a log_food action", () => {
  const chat = loadChatClient();
  const info = chat.captureFoodInfo({
    type: "log_food",
    result: { id: 12, meal: "dinner", enrichment_status: "pending", food: { meal: "dinner" } },
  });
  assert.equal(info.id, 12);
  assert.equal(info.status, "pending");
  assert.equal(info.food.meal, "dinner");
  assert.equal(info.missing, false);

  // Non-food actions, missing ids, and non-log_food types are not trackable chips.
  assert.equal(chat.captureFoodInfo({ type: "log_weight", result: { id: 3 } }), null);
  assert.equal(chat.captureFoodInfo({ type: "log_food", result: {} }), null);
  assert.equal(chat.captureFoodInfo({ type: "log_food" }), null);

  // A deleted note is surfaced as missing so the chip can settle quietly.
  const gone = chat.captureFoodInfo({ type: "log_food", result: { id: 9, food_note_missing: true } });
  assert.equal(gone.missing, true);
});

test("captureFoodActive marks only pending/in_progress as still filling in", () => {
  const chat = loadChatClient();
  assert.equal(chat.captureFoodActive("pending"), true);
  assert.equal(chat.captureFoodActive("in_progress"), true);
  assert.equal(chat.captureFoodActive("done"), false);
  assert.equal(chat.captureFoodActive("skipped"), false);
  assert.equal(chat.captureFoodActive(""), false);
});

test("captureFoodTagInner renders the whole capture lifecycle", () => {
  const chat = loadChatClient();

  // Filling in: a calm caption + the spinner dot, no macros claimed.
  const pending = chat.captureFoodTagInner("pending", { meal: "dinner" });
  assert.match(pending, /filling in details…/);
  assert.match(pending, /enr-dot/);
  assert.doesNotMatch(pending, /kcal/);

  // Enriched: the meal, capitalized, with the real macros the fuel UI is allowed to show.
  const done = chat.captureFoodTagInner("done", { meal: "dinner", kcal: 640, protein_g: 40 });
  assert.match(done, /✓ Dinner · 640 kcal · 40g protein/);

  // Enriched but macro-less: still a confirmed log, no fake numbers.
  const bare = chat.captureFoodTagInner("done", { meal: "lunch" });
  assert.match(bare, /✓ Lunch logged/);
  assert.doesNotMatch(bare, /kcal/);

  // Calm settle: enrichment off/failed — the log itself is never in doubt.
  assert.match(chat.captureFoodTagInner("skipped", { meal: "snack" }), /✓ Snack logged — details unavailable/);
  assert.match(chat.captureFoodTagInner("failed", { meal: "dinner" }), /✓ Dinner logged — details unavailable/);
});

test("captureFoodFromRow maps a fetched food-note row (parsed or parsed_json) to chip state", () => {
  const chat = loadChatClient();

  const live = chat.captureFoodFromRow({
    enrichment_status: "done",
    meal: "dinner",
    parsed: { summary: "Steak and rice", kcal: 720, protein_g: 52 },
  });
  assert.equal(live.status, "done");
  assert.equal(live.food.meal, "dinner");
  assert.equal(live.food.kcal, 720);

  // A stringified parsed_json column (the raw DB shape) is decoded too.
  const raw = chat.captureFoodFromRow({
    enrichment_status: "pending",
    meal: "lunch",
    parsed_json: JSON.stringify({ kcal: 300 }),
  });
  assert.equal(raw.status, "pending");
  assert.equal(raw.food.kcal, 300);

  // Composing fromRow → tagInner is exactly the in-place upgrade the watcher performs.
  const upgraded = chat.captureFoodTagInner(live.status, live.food);
  assert.match(upgraded, /✓ Dinner · 720 kcal · 52g protein/);
});

test("captureFoodReviewInner shows what the estimate was built from, once it exists", () => {
  const chat = loadChatClient();
  const food = {
    meal: "lunch",
    kcal: 635,
    protein_g: 51,
    ingredient_count: 3,
    confidence: "medium",
    basis: "estimated_from_foods",
    ingredients: [
      { item: "swordfish", amount: "6 oz", kcal: 320, protein_g: 42 },
      { item: "vegetable medley", amount: "1.5 cups", kcal: 95, protein_g: 4 },
      { item: "olive oil", amount: "1 tbsp", kcal: 120 },
    ],
  };

  const done = chat.captureFoodReviewInner("done", food);
  assert.match(done, /swordfish/);
  assert.match(done, /6 oz/);
  assert.match(done, /~320 kcal · 42g P/);
  assert.match(done, /1 tbsp/);
  assert.match(done, /~120 kcal/);
  // Provenance in the athlete's register, never the wire vocabulary and never a score.
  assert.match(done, /Estimated from usual servings · medium confidence/);
  assert.doesNotMatch(done, /estimated_from_foods/);

  // Nothing is claimed before the estimate lands, or when it never will.
  assert.equal(chat.captureFoodReviewInner("pending", food), "");
  assert.equal(chat.captureFoodReviewInner("in_progress", food), "");
  assert.equal(chat.captureFoodReviewInner("failed", food), "");
  assert.equal(chat.captureFoodReviewInner("skipped", food), "");
  // An enriched note with no components has no review to show — no orphan block.
  assert.equal(chat.captureFoodReviewInner("done", { meal: "lunch", kcal: 400 }), "");
});

test("the review is bounded, honest about what it hides, and escapes every string", () => {
  const chat = loadChatClient();
  const many = chat.captureFoodReviewInner("done", {
    ingredient_count: 11,
    ingredients: Array.from({ length: 11 }, (_, i) => ({ item: `component ${i + 1}` })),
  });
  assert.equal((many.match(/class="ing-row"/g) || []).length, 6, "a chat bubble never grows a wall of rows");
  assert.match(many, /and 5 more/);

  // Provenance the food-capture contract doesn't define is simply not spoken.
  const unknownBasis = chat.captureFoodReviewInner("done", {
    ingredient_count: 1,
    ingredients: [{ item: "toast" }],
    basis: "vibes",
    confidence: "92%",
  });
  assert.doesNotMatch(unknownBasis, /capture-review-basis/);

  const hostile = chat.captureFoodReviewInner("done", {
    ingredient_count: 1,
    ingredients: [{ item: "<img src=x onerror=alert(1)>", amount: '"><script>' }],
  });
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;img src=x/);
});

test("captureFoodFromRow carries the review through the SSE path, not just the macros", () => {
  const chat = loadChatClient();
  const live = chat.captureFoodFromRow({
    enrichment_status: "done",
    meal: "lunch",
    parsed: {
      summary: "Swordfish",
      kcal: 635,
      ingredients: [{ item: "swordfish", amount: "6 oz", kcal: 320 }],
      confidence: "medium",
      basis: "photo",
    },
  });
  assert.equal(live.food.ingredient_count, 1);
  assert.equal(live.food.ingredients[0].item, "swordfish");
  // Composing fromRow → reviewInner is exactly the in-place fill the watcher performs.
  const review = chat.captureFoodReviewInner(live.status, live.food);
  assert.match(review, /swordfish/);
  assert.match(review, /Read from the photo · medium confidence/);

  // An older estimate that only carried a flat items list still yields rows.
  const flat = chat.captureFoodFromRow({
    enrichment_status: "done",
    meal: "lunch",
    parsed_json: JSON.stringify({ kcal: 620, items: ["turkey (5 oz)", "rice (1 cup)"] }),
  });
  assert.equal(flat.food.ingredient_count, 2);
  assert.match(chat.captureFoodReviewInner("done", flat.food), /turkey \(5 oz\)/);
});

// ---- wiring: chat-message-client.ts DOM glue --------------------------------
const messageClient = readFileSync(join(root, "src/client/chat-message-client.ts"), "utf8");

test("the applied-tag renderer branches a trackable food log to a live capture chip", () => {
  assert.match(messageClient, /function chatAppliedTagHtml/);
  assert.match(messageClient, /CairnChatClient\.captureFoodInfo\(a\)/);
  assert.match(messageClient, /class="bubble-tag capture-food\$\{active \? " pending" : ""\}"/);
  assert.match(messageClient, /data-capture-note="\$\{escAttr\(info\.id\)\}"/);
  // Every other applied action keeps the plain pill.
  assert.match(messageClient, /class="bubble-tag">✓ \$\{escHtml\(String\(record\.type\)/);
  // The bubble-meta row now uses the branching renderer.
  assert.match(messageClient, /applied\.map\(chatAppliedTagHtml\)/);
});

test("appendMsg arms the enrichment watch on any live re-render, never in the readonly overlay", () => {
  assert.match(messageClient, /if \(!readonly && applied\.length\) armCaptureFoodWatches\(applied\)/);
  assert.match(messageClient, /function armCaptureFoodWatches/);
  assert.match(messageClient, /CairnChatClient\.captureFoodActive\(info\.status\)\) watchCaptureFoodNote/);
});

test("the watcher rides the existing food-note SSE stream and refreshes the fuel strip", () => {
  // SSE-first via the shared pollEnrichment helper, scoped to the chat tab + poll token.
  assert.match(messageClient, /pollEnrichment\("\/food-notes", id, \{/);
  assert.match(messageClient, /tab: "chat"/);
  assert.match(messageClient, /onUpdate: \(row\) => applyCaptureFoodRow\(id, row\)/);
  // Stale-tab / duplicate-arm guard keyed by render token.
  assert.match(messageClient, /const captureFoodWatched = new Set/);
  // On settle, refresh the chat fuel totals so macro-less entries stop lingering.
  assert.match(messageClient, /if \(state\.tab === "chat" && typeof loadChatFuel === "function"\) void loadChatFuel\(pollToken\)/);
});

test("applyCaptureFoodRow upgrades the chip in place by its note id", () => {
  assert.match(messageClient, /function applyCaptureFoodRow/);
  assert.match(messageClient, /document\.querySelector\(`\.capture-food\[data-capture-note="\$\{id\}"\]`\)/);
  assert.match(messageClient, /CairnChatClient\.captureFoodFromRow\(row\)/);
  assert.match(messageClient, /tag\.classList\.toggle\("pending", CairnChatClient\.captureFoodActive\(status\)\)/);
  assert.match(messageClient, /tag\.innerHTML = CairnChatClient\.captureFoodTagInner\(status, food\)/);
});

test("the review fills the ORIGINAL message in place — a slot on render, filled on settle", () => {
  // The slot is rendered with the ack (hidden while empty) so the message the athlete
  // already read becomes the one that carries the details — never a follow-up message.
  assert.match(messageClient, /function chatCaptureReviewHtml/);
  assert.match(messageClient, /data-capture-review="\$\{escAttr\(info\.id\)\}"/);
  assert.match(messageClient, /applied\.map\(chatCaptureReviewHtml\)/);
  // Filled in place by the same watcher that upgrades the chip, found by note id.
  assert.match(messageClient, /document\.querySelector\(`\.capture-review\[data-capture-review="\$\{id\}"\]`\)/);
  assert.match(messageClient, /CairnChatClient\.captureFoodReviewInner\(status, food\)/);
  assert.match(messageClient, /review\.hidden = !inner/);
});

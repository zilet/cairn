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
import { createDocument, loadClientModule } from "./_dom.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

function loadChatClient() {
  const context = { Math, Number, String, Date, RegExp, Set, JSON, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-macros-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/chat-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/chat-capture-chips-client.js"), "utf8"), context);
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

// The athlete's own phone feedback: in chat a logged meal is approximate, so the
// review under the chip is compact and read-only — one line per item, its portion in
// words and a muted ~kcal. No inputs, no remove, no "Add an item", no Save, no
// provenance line, no totals line (the chip above carries the meal's total).
test("captureFoodReviewInner is one quiet read-only line per item, once the estimate exists", () => {
  const chat = loadChatClient();
  const food = {
    meal: "lunch",
    kcal: 711,
    protein_g: 61,
    ingredient_count: 5,
    confidence: "medium",
    basis: "estimated_from_foods",
    ingredients: [
      { item: "Trail mix", amount: "1 handful (~30 g)", kcal: 150, protein_g: 4 },
      { item: "Greek yogurt", amount: "170 g", kcal: 100, protein_g: 17 },
      { item: "Chicken breast", amount: "150 g", kcal: 248, protein_g: 35 },
      { item: "Sourdough toast", amount: "2 slices", kcal: 160, protein_g: 6 },
      { item: "Olive oil", amount: "1 tsp" },
    ],
  };

  const done = chat.captureFoodReviewInner("done", food);
  assert.equal(
    done,
    '<ul class="capture-items">' +
      '<li class="capture-item"><span class="capture-item-name">Trail mix</span><span class="capture-item-portion">1 handful</span><span class="capture-item-kcal">~150 kcal</span></li>' +
      '<li class="capture-item"><span class="capture-item-name">Greek yogurt</span><span class="capture-item-portion">170 g</span>' +
      '<span class="capture-item-macros"><span class="capture-macro" title="17 g protein"><span class="sr-only">17 g protein</span><span aria-hidden="true"><span class="capture-macro-k">P</span>17</span></span></span>' +
      '<span class="capture-item-kcal">~100 kcal</span></li>' +
      '<li class="capture-item"><span class="capture-item-name">Chicken breast</span><span class="capture-item-portion">150 g</span>' +
      '<span class="capture-item-macros"><span class="capture-macro" title="35 g protein"><span class="sr-only">35 g protein</span><span aria-hidden="true"><span class="capture-macro-k">P</span>35</span></span></span>' +
      '<span class="capture-item-kcal">~248 kcal</span></li>' +
      '<li class="capture-item"><span class="capture-item-name">Sourdough toast</span><span class="capture-item-portion">2 slices</span><span class="capture-item-kcal">~160 kcal</span></li>' +
      '<li class="capture-item"><span class="capture-item-name">Olive oil</span><span class="capture-item-portion">1 tsp</span></li>' +
      "</ul>"
  );
  for (const absent of [/<input/, /<button/, /Add an item/, /Save/, /confidence/i, /usual servings/]) {
    assert.doesNotMatch(done, absent, `nothing editable or verbose: ${absent}`);
  }
  // The visible glyphs stay compact. The long label is the hover title and a screen-reader span.
  const visibleMacros = done.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, "").replace(/title="[^"]*"/g, "");
  assert.doesNotMatch(visibleMacros, /protein/);
  assert.match(done, /<span class="sr-only">17 g protein<\/span>/);
  assert.match(done, /title="17 g protein"/);
  assert.match(done, /aria-hidden="true"><span class="capture-macro-k">P<\/span>17/);

  // Nothing is claimed before the estimate lands, or when it never will.
  assert.equal(chat.captureFoodReviewInner("pending", food), "");
  assert.equal(chat.captureFoodReviewInner("in_progress", food), "");
  assert.equal(chat.captureFoodReviewInner("failed", food), "");
  assert.equal(chat.captureFoodReviewInner("skipped", food), "");
  // An enriched note with no components has no review to show — no orphan block.
  assert.equal(chat.captureFoodReviewInner("done", { meal: "lunch", kcal: 400 }), "");
});

// A food shows what it meaningfully brings — its lead macro, fiber when it is a real
// source, else a second big macro — two tags at most, and nothing for a trivial row.
// Fixtures are a real logged dinner's ingredient rows.
test("signature macros name what each food brings, never the full split", () => {
  const context = { Math, Number, String, escHtml, escAttr };
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-macros-client.js"), "utf8"), context);
  const sig = (row) =>
    context
      .captureFoodSignatureMacros(row)
      .map((t) => `${t.key}${t.grams}`)
      .join(" ");
  assert.equal(sig({ kcal: 380, protein_g: 47, carbs_g: 0, fat_g: 20, fiber_g: 0 }), "P47 F20");
  assert.equal(sig({ kcal: 143, protein_g: 9, carbs_g: 26, fat_g: 1, fiber_g: 9 }), "C26 fib9");
  assert.equal(sig({ kcal: 15, protein_g: 0.2, carbs_g: 3.5, fat_g: 0, fiber_g: 3.2 }), "fib3");
  assert.equal(
    sig({ kcal: 6, protein_g: 1, carbs_g: 1, fat_g: 0, fiber_g: 0.5 }),
    "",
    "a handful of greens earns no tag"
  );
  assert.equal(sig({ kcal: 65, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 }), "", "spirits carry no macro");
  assert.equal(sig({ kcal: 62, protein_g: 2.4, carbs_g: 0.6, fat_g: 5.6, fiber_g: 0 }), "F6");
  assert.equal(sig({ kcal: 50, protein_g: 1.2, carbs_g: 11.6, fat_g: 0.3, fiber_g: 3.4 }), "C12 fib3");
  assert.equal(sig({ kcal: 280, protein_g: 16, carbs_g: 22, fat_g: 14, fiber_g: 1.5 }), "P16 F14", "fixed P C F order");
  assert.equal(sig({ kcal: 135, protein_g: 29, carbs_g: 1, fat_g: 1.5, fiber_g: 0 }), "P29");
  // A row with only kcal + protein (an older, thinner estimate) still reads.
  assert.equal(sig({ kcal: 320, protein_g: 42 }), "P42");
  assert.equal(sig({ item: "olive oil" }), "", "no numbers, no tags");
});

test("the review is bounded, honest about what it hides, and escapes every string", () => {
  const chat = loadChatClient();
  const many = chat.captureFoodReviewInner("done", {
    ingredient_count: 11,
    ingredients: Array.from({ length: 11 }, (_, i) => ({ item: `component ${i + 1}` })),
  });
  assert.equal((many.match(/class="capture-item"/g) || []).length, 6, "a chat bubble never grows a wall of rows");
  assert.match(many, /and 5 more/);

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
  assert.match(review, /swordfish<\/span><span class="capture-item-portion">6 oz/);
  assert.doesNotMatch(review, /photo/, "provenance stays off the chat bubble");

  // An older estimate that only carried a flat items list still yields rows.
  const flat = chat.captureFoodFromRow({
    enrichment_status: "done",
    meal: "lunch",
    parsed_json: JSON.stringify({ kcal: 620, items: ["turkey (5 oz)", "rice (1 cup)"] }),
  });
  assert.equal(flat.food.ingredient_count, 2);
  assert.match(chat.captureFoodReviewInner("done", flat.food), /turkey \(5 oz\)/);
});

// A follow-up correction ("oh and 40 g of avocado") comes back as an applied
// update_food_note carrying the updated row: its chip says the new total once, and
// the row is what repaints the original meal's chip + review in place.
test("an applied amendment names the updated meal once and hands its row to the repaint", () => {
  const chat = loadChatClient();
  const action = {
    type: "update_food_note",
    result: {
      id: 42,
      meal: "lunch",
      enrichment_status: "done",
      parsed: {
        kcal: 775,
        protein_g: 62,
        ingredients: [
          { item: "Trail mix", amount: "1 handful (~30 g)", kcal: 150 },
          { item: "Avocado", amount: "40 g", kcal: 64 },
        ],
      },
    },
  };
  const amended = chat.amendedFoodRow(action);
  assert.equal(amended.id, 42);
  assert.equal(chat.amendedFoodTag(action), "✓ Lunch updated · 775 kcal · 62g protein");
  assert.equal(
    chat.amendedFoodTag(action, { among: true }),
    "✓ Lunch corrected · 775 kcal · 62g protein",
    "two ingredients and no item summary stay on the meal"
  );
  const { status, food } = chat.captureFoodFromRow(amended.row);
  assert.match(chat.captureFoodReviewInner(status, food), /Avocado<\/span><span class="capture-item-portion">40 g/);

  assert.equal(chat.amendedFoodRow({ type: "update_food_note", result: { error: "not found", id: 42 } }), null);
  assert.equal(chat.amendedFoodRow({ type: "log_food", result: { id: 42, parsed: {} } }), null);
  assert.equal(chat.amendedFoodTag({ type: "log_weight", result: {} }), null);
});

test("food chips name the entry only when one reply carries more than one", () => {
  const chat = loadChatClient();
  const chocolate = {
    type: "update_food_note",
    result: {
      id: 7,
      meal: "breakfast",
      parsed: { summary: "Chocolate", kcal: 57, protein_g: 1, ingredients: [{ item: "Chocolate" }] },
    },
  };
  const breakfast = { meal: "breakfast", summary: "eggs and toast", kcal: 391, protein_g: 48 };
  assert.equal(chat.amendedFoodTag(chocolate), "✓ Breakfast updated · 57 kcal · 1g protein");
  assert.equal(chat.amendedFoodTag(chocolate, { among: true }), "✓ Chocolate corrected · 57 kcal · 1g protein");
  assert.match(chat.captureFoodTagInner("done", breakfast), /✓ Breakfast · 391 kcal · 48g protein/);
  assert.match(
    chat.captureFoodTagInner("done", breakfast, { among: true }),
    /✓ Breakfast logged · 391 kcal · 48g protein/
  );
  assert.match(
    chat.captureFoodTagInner(
      "done",
      { meal: "breakfast", summary: "Oats", kcal: 300, protein_g: 12 },
      { among: true, preferThing: true }
    ),
    /✓ Oats logged · 300 kcal · 12g protein/
  );
  assert.equal(chat.captureFoodAmongLead({ meal: "breakfast", summary: "Oats" }, { preferThing: true }), "Oats logged");
  assert.equal(
    chat.captureFoodAmongLead({ meal: "breakfast", summary: "breakfast", ingredients: [{ item: "chocolate" }] }),
    "Breakfast logged"
  );
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
  assert.match(messageClient, /chatAppliedTagHtml\(a, foodOpts\[i\]\)/);
  assert.match(messageClient, /data-capture-among="1"/);
});

test("appendMsg arms the enrichment watch on any live re-render, never in the readonly overlay", () => {
  assert.match(messageClient, /if \(!readonly && applied\.length\) armCaptureFoodWatches\(applied\);/);
  // Chat never mounts an editable card over a capture: the review stays read-only.
  assert.doesNotMatch(messageClient, /CairnChatCaptureCard|CairnMealCardController/);
  // An amendment repaints the meal it amended — on the live turn only, never a history paint.
  assert.match(messageClient, /for \(const a of !readonly && !noScroll \? applied : \[\]\) \{/);
  assert.match(messageClient, /CairnChatClient\.amendedFoodRow\(a\)/);
  assert.match(messageClient, /applyCaptureFoodRow\(amended\.id, amended\.row\)/);
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
  assert.match(
    messageClient,
    /if \(state\.tab === "chat" && typeof loadChatFuel === "function"\) void loadChatFuel\(pollToken\)/
  );
});

test("applyCaptureFoodRow upgrades the chip in place by its note id", () => {
  assert.match(messageClient, /function applyCaptureFoodRow/);
  assert.match(messageClient, /document\.querySelector\(`\.capture-food\[data-capture-note="\$\{id\}"\]`\)/);
  assert.match(messageClient, /CairnChatClient\.captureFoodFromRow\(row\)/);
  assert.match(messageClient, /tag\.classList\.toggle\("pending", CairnChatClient\.captureFoodActive\(status\)\)/);
  assert.match(messageClient, /CairnChatClient\.captureFoodTagInner\(\s*status,\s*food,/);
  assert.match(messageClient, /tag\.dataset\.captureAmong === "1"/);
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

function loadMessageClient() {
  const document = createDocument();
  const w = loadClientModule(["html-utils", "capture-macros-client", "chat-client", "chat-capture-chips-client", "chat-message-client"], {
    document,
    globals: {
      $: () => null,
      mdToHtml: (s) => String(s ?? ""),
      CairnChatSpeaker: { forTurn: () => "" },
      localISO: () => "2026-10-17",
      dateLabel: (iso) => iso,
      state: { tab: "chat" },
      withToken: (s) => s,
      pollToken: 1,
      toast: () => {},
      activateTab: () => {},
    },
  });
  return { w, document };
}

test("a failed agent check is calm on the chip and technical only in the title", () => {
  const { w, document } = loadMessageClient();
  const host = document.createElement("div");
  const bubble = w.appendMsg(
    {
      role: "assistant",
      content: "Noted.",
      meta: {
        agent_attempts: [
          { agent: "antigravity", ok: false, status: "timeout" },
          { agent: "codex", ok: false, status: "timeout" },
        ],
      },
    },
    true,
    host
  );
  const btn = bubble.querySelector("button.agentcheck");
  assert.equal(btn.textContent.replace(/\s+/g, " ").trim(), "Took a little longer than usual");
  assert.doesNotMatch(btn.textContent, /antigravity|timeout|agent/i);
  assert.equal(btn.getAttribute("title"), "antigravity timeout +1. Open Settings → Agents");
  assert.equal(btn.getAttribute("aria-label"), null);
  assert.equal(btn.getAttribute("data-agent-check"), "1");
});

test("a failed agent check words itself by what happened, never naming a provider", () => {
  const { w, document } = loadMessageClient();
  const words = (status) => {
    const host = document.createElement("div");
    const bubble = w.appendMsg(
      { role: "assistant", content: "Noted.", meta: { agent_attempts: [{ agent: "codex", ok: false, status }] } },
      true,
      host
    );
    const btn = bubble.querySelector("button.agentcheck");
    assert.doesNotMatch(btn.textContent, /codex|timeout|invalid|auth_required/i);
    assert.equal(btn.getAttribute("title"), `codex ${status.replace(/_/g, " ")}. Open Settings → Agents`);
    return btn.textContent.replace(/\s+/g, " ").trim();
  };
  assert.equal(words("timeout"), "Took a little longer than usual");
  assert.equal(words("auth_required"), "One agent needs signing in again · Agents ›");
  assert.equal(words("invalid_output"), "One agent couldn't answer · Agents ›");
  assert.equal(words("error"), "One agent couldn't answer · Agents ›");
});

test("several food chips in one reply name the entry, and a repaint keeps the name", () => {
  const { w, document } = loadMessageClient();
  const host = document.createElement("div");
  const bubble = w.appendMsg(
    {
      role: "assistant",
      content: "Logged.",
      meta: {
        applied: [
          {
            type: "update_food_note",
            result: {
              id: 7,
              meal: "breakfast",
              enrichment_status: "done",
              parsed: { summary: "Chocolate", kcal: 57, protein_g: 1, ingredients: [{ item: "Chocolate" }] },
            },
          },
          {
            type: "log_food",
            result: {
              id: 8,
              meal: "breakfast",
              enrichment_status: "done",
              food: { meal: "breakfast", summary: "Eggs", kcal: 391, protein_g: 48 },
            },
          },
          {
            type: "log_food",
            result: {
              id: 9,
              meal: "breakfast",
              enrichment_status: "done",
              food: { meal: "breakfast", summary: "Oats", kcal: 280, protein_g: 10 },
            },
          },
        ],
      },
    },
    true,
    host
  );
  const tags = [...bubble.querySelectorAll(".capture-food")].map((el) => el.textContent.replace(/\s+/g, " ").trim());
  assert.deepEqual(tags, [
    "✓ Chocolate corrected · 57 kcal · 1g protein",
    "✓ Eggs logged · 391 kcal · 48g protein",
    "✓ Oats logged · 280 kcal · 10g protein",
  ]);
  // applyCaptureFoodRow stays inside the message module. The chip carries the
  // flags that function reads, and the exported tag builder is what it writes.
  const oats = bubble.querySelector('[data-capture-note="9"]');
  assert.equal(oats.getAttribute("data-capture-among"), "1");
  assert.equal(oats.getAttribute("data-capture-prefer"), "1");
  const { status, food } = w.CairnChatClient.captureFoodFromRow({
    meal: "breakfast",
    enrichment_status: "done",
    parsed: { summary: "Oats", kcal: 300, protein_g: 11 },
  });
  oats.innerHTML = w.CairnChatClient.captureFoodTagInner(status, food, {
    among: oats.getAttribute("data-capture-among") === "1",
    preferThing: oats.getAttribute("data-capture-prefer") === "1",
  });
  assert.match(oats.textContent, /Oats logged · 300 kcal · 11g protein/);
});

// A plan change that did NOT go live must never render as "✓ plan update": the chip was
// the last thing telling the athlete the opposite of the truth after the reply was
// corrected. The landing word is computed server-side, so the chip does no date math.
test("planLandingTag names a scheduled plan change and a today-scoped refusal", () => {
  const chat = loadChatClient();

  const scheduled = chat.planLandingTag({
    type: "plan_update",
    result: { ok: true, applied: false, scheduled: true, landing_label: "tomorrow" },
  });
  assert.equal(scheduled.text, "⏱ plan update · tomorrow");
  assert.equal(scheduled.scheduled, true);

  const held = chat.planLandingTag({
    type: "plan_update",
    result: { ok: true, applied: false, held_reason: "today_scoped" },
  });
  assert.equal(held.text, "plan update · not applied");
  assert.equal(held.scheduled, false);

  // Anything that landed, failed, or is not a plan action keeps the ordinary tag.
  assert.equal(chat.planLandingTag({ type: "plan_update", result: { ok: true, persisted: true } }), null);
  assert.equal(chat.planLandingTag({ type: "plan_update", result: { ok: false, error: "nope" } }), null);
  assert.equal(chat.planLandingTag({ type: "log_food", result: { ok: true, scheduled: true } }), null);
  assert.equal(chat.planLandingTag(null), null);
});

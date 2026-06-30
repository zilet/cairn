import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadFoodNoteClient() {
  const context = {
    Array,
    JSON,
    Math,
    Number,
    Object,
    String,
    art: () => "<svg></svg>",
    artImg: (_kind, text, className) => `<span class="${className}">${context.escHtml(text)}</span>`,
    enrichBadge: (status) => `badge:${status || ""}`,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/format-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/food-note-client.js"), "utf8"), context);
  return context;
}

test("food-note helper parses ingredients, labels, macros, and titles", () => {
  const context = loadFoodNoteClient();
  const food = context.CairnFoodNote;
  const parsed = {
    ingredients: [
      { item: "salmon", amount: "6 oz", kcal: 350, protein_g: 39, carbs_g: 0, fat_g: 21 },
      { name: "rice", qty: "1 cup" },
    ],
    kcal: 710,
    protein_g: 49,
    carbs_g: 64,
    fat_g: 25.2,
  };

  assert.equal(food.ingredientLabel({ amount: "6 oz", item: "salmon" }), "6 oz salmon");
  assert.equal(food.foodTitleFromIngredients(parsed), "salmon, rice");
  assert.equal(food.foodItemsText({ items: ["eggs", { name: "toast" }] }), "eggs, toast");
  assert.equal(food.foodMacroText(parsed, { kcal: true, short: true }), "710 kcal · 49g P · 64g C · 25.2g F");
});

test("food-note renderer escapes note content and preserves direct globals", () => {
  const context = loadFoodNoteClient();
  const food = context.CairnFoodNote;
  const note = {
    id: '5" onclick="bad',
    meal: "Lunch <post-run>",
    raw: "salmon bowl <script>",
    created_at: "2026-06-30T12:00:00.000Z",
    enrichment_status: "done",
    parsed_json: JSON.stringify({
      summary: "Salmon bowl <big>",
      items: [{ item: "salmon <wild>" }, { name: "rice <white>" }],
      kcal: 710,
      protein_g: 49,
      carbs_g: 64,
      fat_g: 25,
      notes: "Good recovery meal <nice>",
    }),
  };

  assert.equal(context.foodTitleFromIngredients({ ingredients: ["eggs", "toast"] }), "eggs, toast");
  assert.equal(context.parsedNote({ parsed_json: '{"summary":"ok"}' }).summary, "ok");

  const html = food.noteEntryHtml(note, 2);
  assert.match(html, /data-noteid="5&quot; onclick=&quot;bad"/);
  assert.match(html, /Lunch &lt;post-run&gt; · 2026-06-30/);
  assert.match(html, /Salmon bowl &lt;big&gt;/);
  assert.match(html, /salmon &lt;wild&gt;, rice &lt;white&gt;/);
  assert.match(html, /710 kcal · 49g P · 64g C · 25g F/);
  assert.match(html, /Good recovery meal &lt;nice&gt;/);
  assert.match(html, /badge:done/);
  assert.match(html, /--i:2/);
  assert.doesNotMatch(html, /<big>|<wild>|<white>|onclick="bad/);
});

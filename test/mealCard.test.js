// The meal card (meal-card-model.ts + meal-card-client.ts + meal-card-controller.ts):
// a logged meal as one editable row per item in the foodCapture.ts ingredient shape,
// with optimistic totals and ONE PUT /api/food-notes/:id per save.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, fire, flush, loadClientModule, renderHtml } from "./_dom.mjs";

// Objects built inside the sandbox carry its prototypes; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  return loadClientModule([
    "html-utils",
    "ui-actions-client",
    "meal-card-model",
    "meal-card-client",
    "meal-card-controller",
  ]);
}

// A pasted multi-line meal: seven items, most with a weight, one with a count. The
// rows sum to 933 kcal; the stored total carries 67 more the rows do not itemize
// (foodCapture.ts rule 4: cooking fat an agent counted at meal level).
function pastedNote(overrides = {}) {
  return {
    id: 42,
    meal: "lunch",
    enrichment_status: "done",
    parsed: {
      summary: "Chicken rice bowl",
      kcal: 1000,
      protein_g: 91,
      carbs_g: 95,
      fat_g: 28,
      fiber_g: 13,
      confidence: "medium",
      basis: "estimated_from_foods",
      ingredients: [
        {
          item: "Chicken breast",
          amount: "200 g",
          kcal: 330,
          protein_g: 62,
          carbs_g: 0,
          fat_g: 7,
          fiber_g: 0,
          basis: "label",
        },
        { item: "White rice", amount: "150 g", kcal: 195, protein_g: 4, carbs_g: 43, fat_g: 0.4, fiber_g: 0.6 },
        { item: "Broccoli", amount: "100g", kcal: 34, protein_g: 2.8, carbs_g: 7, fat_g: 0.4, fiber_g: 2.6 },
        { item: "Olive oil", amount: "10 g", kcal: 88, protein_g: 0, carbs_g: 0, fat_g: 10, fiber_g: 0 },
        { item: "Eggs", amount: "2 eggs", kcal: 144, protein_g: 12.6, carbs_g: 0.7, fat_g: 9.5, fiber_g: 0 },
        { item: "Black beans", amount: "0.1 kg", kcal: 132, protein_g: 8.9, carbs_g: 23.7, fat_g: 0.5, fiber_g: 8.7 },
        { item: "Salsa", amount: "30 g", kcal: 10, protein_g: 0.5, carbs_g: 2, fat_g: 0, fiber_g: 0.5 },
      ],
      ...overrides,
    },
  };
}

function recorder(respond) {
  const calls = [];
  const toasts = [];
  const motion = { expanded: [], collapsed: [] };
  const totals = [];
  const saved = [];
  const deps = {
    api: async (path, init) => {
      calls.push({ path, method: init?.method, body: JSON.parse(init?.body || "null") });
      return respond ? respond(path, init) : null;
    },
    toast: (message) => toasts.push(message),
    expandEl: (el) => motion.expanded.push(el),
    collapseEl: (el, done) => {
      motion.collapsed.push(el);
      done();
    },
    reducedMotion: () => false,
    onTotals: (value, meta) => totals.push({ value: { ...value }, meta }),
    onSaved: (note) => saved.push(note),
  };
  return { calls, toasts, motion, totals, saved, deps };
}

// The card mounts read-only (approximate by default); the editing tests tap its
// Edit first, the way a person does. `{ edit: false }` leaves it at rest.
function mount(win, note, deps, opts = {}) {
  const host = createHost(win.document);
  const teardown = win.CairnMealCardController.mount(host, { note, ...deps });
  if (opts.edit !== false) host.querySelector("[data-meal-card-edit]").click();
  return { host, teardown };
}

async function typeGrams(host, index, value) {
  const input = host.querySelectorAll("[data-meal-card-grams]")[index];
  input.value = value;
  await fire(input, "input");
  return input;
}

test("a pasted 7-item meal renders one row per item, grams as decimal fields, provenance in words", () => {
  const win = load();
  const model = win.CairnMealCardModel.mealCardModel(pastedNote());
  const host = renderHtml(win.CairnMealCard.mealCardHtml(model, { editing: true }), { document: win.document });
  const rows = host.querySelectorAll(".meal-card-row");
  assert.equal(rows.length, 7);
  const grams = host.querySelectorAll("[data-meal-card-grams]");
  assert.equal(grams.length, 7);
  for (const input of grams) {
    assert.equal(input.getAttribute("inputmode"), "decimal");
    assert.match(input.getAttribute("aria-label"), /^Grams of /);
  }
  assert.deepEqual(
    [...grams].map((input) => input.value),
    ["200", "150", "100", "10", "", "100", "30"],
    "weights parse from g / kg; a count leaves the field empty"
  );
  assert.equal(rows[4].querySelector(".meal-card-amount").textContent, "2 eggs", "a count stays visible");
  assert.equal(host.querySelector(".meal-card-prov").textContent, "Estimated from usual servings · medium confidence");
  assert.equal(
    rows[0].querySelector(".meal-card-basis").textContent,
    "read off the label",
    "a row's own basis shows when it differs"
  );
  assert.equal(rows[1].querySelector(".meal-card-basis"), null);
  assert.equal(
    host.querySelector(".meal-card-totals").textContent,
    "1000 kcal · 91 g protein · 13 g fiber · 95 g carbs · 28 g fat"
  );
  assert.equal(host.querySelector("[data-meal-card-save]").disabled, true, "nothing to save yet");
  assert.equal(host.querySelectorAll("button[data-meal-card-remove]").length, 7);
  assert.equal(host.querySelector("[data-meal-card-add]").getAttribute("type"), "button");
});

test("hostile item text is escaped, never markup", () => {
  const win = load();
  const note = pastedNote({ ingredients: [{ item: `<b>x</b>"`, amount: "<i>2</i>", kcal: 10 }] });
  const host = renderHtml(
    win.CairnMealCard.mealCardHtml(win.CairnMealCardModel.mealCardModel(note), { editing: true }),
    { document: win.document }
  );
  assert.equal(host.querySelector("b"), null);
  assert.equal(host.querySelector("i"), null);
  assert.equal(host.querySelector(".meal-card-item").textContent, `<b>x</b>"`);
  assert.equal(host.querySelector("[data-meal-card-remove]").getAttribute("aria-label"), `Remove <b>x</b>"`);
});

// Approximate by default: nobody weighed it, so the card at rest READS — one line per
// item, its portion in words, a muted ~kcal — and only an explicit Edit opens fields.
test("at rest the card reads: portions in words, a muted kcal, no fields until Edit", () => {
  const win = load();
  const note = pastedNote({
    ingredients: [
      { item: "Trail mix", amount: "1 handful (~30 g)", kcal: 150, protein_g: 4 },
      { item: "Greek yogurt", amount: "170 g", kcal: 100, protein_g: 17 },
      { item: "Honey", amount: "1 tsp", fiber_g: 0 },
    ],
  });
  const { calls, deps } = recorder();
  const { host } = mount(win, note, deps, { edit: false });
  const rows = host.querySelectorAll(".meal-card-row");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    [...rows].map((row) => [
      row.querySelector(".meal-card-item")?.textContent,
      row.querySelector(".meal-card-amount")?.textContent ?? null,
      row.querySelector(".meal-card-nutri")?.textContent ?? null,
    ]),
    [
      ["Trail mix", "1 handful", "~150 kcal"],
      ["Greek yogurt", "170 g", "~100 kcal"],
      ["Honey", "1 tsp", null],
    ],
    "the estimator's bracketed weight is not a portion; a row with no kcal stays quiet"
  );
  for (const selector of [
    "input",
    "[data-meal-card-remove]",
    "[data-meal-card-add]",
    "[data-meal-card-save]",
    ".meal-card-totals",
    ".meal-card-basis",
  ]) {
    assert.equal(host.querySelector(selector), null, `no ${selector} at rest`);
  }
  const edit = host.querySelector("[data-meal-card-edit]");
  assert.equal(edit.getAttribute("type"), "button");
  assert.equal(edit.textContent.trim(), "Edit");
  assert.equal(host.querySelector(".meal-card-prov").textContent, "Estimated from usual servings · medium confidence");
  assert.equal(calls.length, 0);
});

test("Edit opens the fields; Cancel puts an unsaved edit back and sends nothing; Done closes", async () => {
  const win = load();
  const { calls, totals, deps } = recorder();
  const { host } = mount(win, pastedNote(), deps, { edit: false });

  host.querySelector("[data-meal-card-edit]").click();
  assert.equal(host.querySelectorAll("[data-meal-card-grams]").length, 7, "the gram fields appear");
  assert.equal(host.ownerDocument.activeElement, host.querySelector("[data-meal-card-grams]"), "focus lands on the first");
  assert.equal(host.querySelector("[data-meal-card-edit]"), null);
  const done = host.querySelector("[data-meal-card-done]");
  assert.equal(done.textContent, "Done");

  await typeGrams(host, 0, "300");
  assert.equal(host.querySelector("[data-meal-card-done]").textContent, "Cancel", "closing now discards, so it says so");
  host.querySelector("[data-meal-card-done]").click();

  assert.equal(host.querySelector("input"), null, "back at rest");
  assert.equal(host.querySelector(".meal-card-row .meal-card-nutri").textContent, "~330 kcal", "the stored row, not the edit");
  assert.deepEqual(plain(totals.at(-1)), {
    value: { kcal: 1000, protein_g: 91, carbs_g: 95, fat_g: 28, fiber_g: 13 },
    meta: { saved: true, unsaved: false },
  });
  assert.equal(host.ownerDocument.activeElement, host.querySelector("[data-meal-card-edit]"));
  assert.equal(calls.length, 0, "nothing was written");

  host.querySelector("[data-meal-card-edit]").click();
  assert.equal(host.querySelectorAll("[data-meal-card-grams]")[0].value, "200", "reopening starts from what is stored");
});

test("hostile text is escaped at rest too", () => {
  const win = load();
  const note = pastedNote({ ingredients: [{ item: `<b>x</b>"`, amount: "<i>2</i> (~30 g)", kcal: 10 }] });
  const host = renderHtml(win.CairnMealCard.mealCardHtml(win.CairnMealCardModel.mealCardModel(note)), {
    document: win.document,
  });
  assert.equal(host.querySelector("b"), null);
  assert.equal(host.querySelector("i"), null);
  assert.equal(host.querySelector(".meal-card-item").textContent, `<b>x</b>"`);
  assert.equal(host.querySelector(".meal-card-amount").textContent, "<i>2</i>");
});

test("at rest: each item lists its own macros and the meal shows its split; unknown values are omitted", () => {
  const win = load();
  const note = pastedNote({
    protein_g: 69,
    carbs_g: 15,
    fat_g: 32,
    fiber_g: 7,
    ingredients: [
      { item: "Turkey breast", amount: "82 g", kcal: 95, protein_g: 22, carbs_g: 0, fat_g: 1, fiber_g: 0 },
      { item: "Avocado", amount: "1/5 avocado", kcal: 50, protein_g: 0.6, carbs_g: 2.5, fat_g: 4.5, fiber_g: 2 },
      { item: "Mystery sauce", amount: "1 tbsp", kcal: 30 },
      { item: "Plain", amount: "1" },
    ],
  });
  const host = renderHtml(win.CairnMealCard.mealCardHtml(win.CairnMealCardModel.mealCardModel(note)), {
    document: win.document,
  });
  const macros = [...host.querySelectorAll(".meal-card-row .meal-card-macros")].map((el) => el.textContent);
  assert.deepEqual(macros, ["22 g P · 0 g C · 1 g F · 0 g fiber", "0.6 g P · 2.5 g C · 4.5 g F · 2 g fiber"]);
  assert.equal(host.querySelectorAll(".meal-card-row").length, 4, "rows without macros still render, with no macro line");
  assert.equal(host.querySelector(".meal-card-split-text").textContent, "69 g protein · 15 g carbs · 32 g fat · 7 g fiber");
  assert.equal(host.querySelectorAll(".meal-card-split-seg").length, 3);

  const partial = renderHtml(win.CairnMealCard.macroSplitHtml({ protein_g: 20, fiber_g: null }), { document: win.document });
  assert.equal(partial.querySelector(".meal-card-split-text").textContent, "20 g protein");
  assert.equal(partial.querySelector(".meal-card-split-bar"), null, "one macro is not a split");
  assert.equal(win.CairnMealCard.macroSplitHtml({}), "", "nothing known draws nothing");
});

test("model: a portion reads in words; a stated weight stays", () => {
  const M = load().CairnMealCardModel;
  assert.equal(M.portionWords("1 handful (~30 g)"), "1 handful");
  assert.equal(M.portionWords("2 slices (about 60g)"), "2 slices");
  assert.equal(M.portionWords("1 cup (240 ml)"), "1 cup");
  assert.equal(M.portionWords("40 g"), "40 g");
  assert.equal(M.portionWords("(~30 g)"), "(~30 g)", "a weight alone is still the portion");
  assert.equal(M.portionWords("a bowl (large)"), "a bowl (large)", "only a bracketed weight goes");
  assert.equal(M.portionWords(null), "");
});

test("model: weights read the way the server reads them, rows rescale, totals follow rule 4", () => {
  const win = load();
  const M = win.CairnMealCardModel;
  assert.equal(M.gramsFromAmount("205 g"), 205);
  assert.equal(M.gramsFromAmount("1,5 kg"), 1500);
  assert.equal(M.formatGrams(M.gramsFromAmount("6 oz")), "170.1");
  // parseFoodQuantity's mass arm: lb, fractions, a hedge, and trailing words.
  assert.equal(M.formatGrams(M.gramsFromAmount("8 oz chicken")), "226.8");
  assert.equal(M.formatGrams(M.gramsFromAmount("~1/2 lb")), "226.8");
  assert.equal(M.gramsFromAmount("200 g cooked"), 200);
  assert.equal(M.gramsFromAmount("about 150g"), 150);
  assert.equal(M.gramsFromAmount("250 ml"), null, "a volume is not a weight");
  assert.equal(M.gramsFromAmount("2 eggs"), null);
  assert.equal(M.parseGramsInput("12,5"), 12.5);
  assert.equal(M.parseGramsInput("abc"), null);
  assert.equal(M.parseGramsInput("0"), null);

  const note = pastedNote();
  const original = M.mealCardRows(note);
  const rows = M.mealCardRows(note);
  rows[0].grams = 300;
  rows[0].edited = true;
  assert.equal(M.rowMacros(rows[0]).kcal, 495);
  // The rows go 933 -> 1098; the 67 the stored total carried beyond them stays.
  assert.equal(M.optimisticTotals(M.storedTotals(note), original, rows).kcal, 1165);
  assert.equal(M.optimisticTotals(M.storedTotals(note), original, rows).protein_g, 122);
  // The body carries the STORED estimate and the new grams: the server scales.
  assert.deepEqual(plain(M.rowBody(rows[0])), {
    item: "Chicken breast",
    amount: "200 g",
    kcal: 330,
    protein_g: 62,
    carbs_g: 0,
    fat_g: 7,
    fiber_g: 0,
    basis: "label",
    grams: 300,
  });
  assert.deepEqual(
    plain(M.rowBody(original[1])),
    { item: "White rice", amount: "150 g", kcal: 195, protein_g: 4, carbs_g: 43, fat_g: 0.4, fiber_g: 0.6 },
    "an untouched row goes back exactly as stored, with no grams"
  );
  // A count takes grams but cannot be rescaled: no per-gram figure exists.
  rows[4].grams = 120;
  rows[4].edited = true;
  assert.equal(M.rowMacros(rows[4]).kcal, 144);
  assert.equal(M.rowBody(rows[4]).amount, "2 eggs");
  assert.equal(M.rowBody(rows[4]).grams, 120);
  assert.equal("basis" in M.rowBody(rows[4]), false);
  assert.equal(M.rowsChanged(original, M.mealCardRows(note)), false);
  assert.equal(M.rowsChanged(original, rows), true);
});

test("editing one row's grams moves the totals at once and saves with exactly one PUT", async () => {
  const win = load();
  const server = pastedNote({ kcal: 1170, protein_g: 123 });
  server.parsed.ingredients[0] = { ...server.parsed.ingredients[0], amount: "300 g", kcal: 495, protein_g: 93 };
  const { calls, totals, saved, deps } = recorder(() => server);
  const { host } = mount(win, pastedNote(), deps);

  await typeGrams(host, 0, "300");
  const line = host.querySelector(".meal-card-totals");
  assert.match(line.textContent, /^1165 kcal · 122 g protein/, "optimistic, before any request");
  assert.equal(line.classList.contains("is-unsaved"), true);
  assert.match(
    host.querySelector('[data-meal-card-row="r0"] .meal-card-nutri').textContent,
    /~495 kcal · 93 g protein/
  );
  assert.equal(calls.length, 0, "typing never writes");
  assert.equal(totals.at(-1).meta.unsaved, true);

  const save = host.querySelector("[data-meal-card-save]");
  assert.equal(save.disabled, false);
  const tap = save.click();
  await save.click();
  await tap;
  await flush();

  assert.equal(calls.length, 1, "one PUT");
  assert.equal(calls[0].path, "/food-notes/42");
  assert.equal(calls[0].method, "PUT");
  assert.deepEqual(Object.keys(calls[0].body), ["ingredients"], "row-shaped body only; the server owns the totals");
  assert.equal(calls[0].body.ingredients.length, 7);
  assert.deepEqual(calls[0].body.ingredients[0], {
    item: "Chicken breast",
    amount: "200 g",
    kcal: 330,
    protein_g: 62,
    carbs_g: 0,
    fat_g: 7,
    fiber_g: 0,
    basis: "label",
    grams: 300,
  });
  assert.equal(calls[0].body.ingredients[1].amount, "150 g", "untouched rows go back as logged");
  assert.equal("grams" in calls[0].body.ingredients[1], false);

  const after = host.querySelector(".meal-card-totals");
  assert.match(after.textContent, /^1170 kcal · 123 g protein/, "the server's numbers win");
  assert.equal(after.classList.contains("is-unsaved"), false);
  assert.equal(after.classList.contains("is-settled"), true);
  assert.equal(host.querySelector(".meal-card-status").textContent, "Saved");
  assert.equal(host.querySelector("[data-meal-card-save]").disabled, true);
  assert.equal(host.querySelectorAll("[data-meal-card-grams]")[0].value, "300");
  assert.equal(saved.length, 1);
  assert.deepEqual(plain(totals.at(-1)), {
    value: { kcal: 1170, protein_g: 123, carbs_g: 95, fat_g: 28, fiber_g: 13 },
    meta: { saved: true, unsaved: false },
  });
  assert.equal(host.querySelector(".meal-card-status").getAttribute("role"), "status");
});

test("a failed save keeps every edit and says so; the next save still goes", async () => {
  const win = load();
  let fail = true;
  const { calls, toasts, deps } = recorder(() => {
    if (fail) throw new Error("offline");
    return pastedNote({ kcal: 1165 });
  });
  const { host } = mount(win, pastedNote(), deps);
  await typeGrams(host, 0, "300");
  await host.querySelector("[data-meal-card-save]").click();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(host.querySelector(".meal-card-status").textContent, "Not saved — your changes are still here.");
  assert.equal(host.querySelectorAll("[data-meal-card-grams]")[0].value, "300");
  assert.match(host.querySelector(".meal-card-totals").textContent, /^1165 kcal/);
  assert.deepEqual(toasts, ["Couldn't save that meal"]);
  const save = host.querySelector("[data-meal-card-save]");
  assert.equal(save.disabled, false);
  assert.equal(save.getAttribute("aria-busy"), null);

  fail = false;
  await save.click();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(host.querySelector(".meal-card-status").textContent, "Saved");
});

test("a calm refusal prints the server's sentence in place", async () => {
  const win = load();
  const { deps } = recorder(() => ({ ok: false, error: "That meal was removed." }));
  const { host } = mount(win, pastedNote(), deps);
  await typeGrams(host, 1, "200");
  await host.querySelector("[data-meal-card-save]").click();
  await flush();
  assert.equal(host.querySelector(".meal-card-status").textContent, "That meal was removed.");
  assert.equal(host.querySelectorAll("[data-meal-card-grams]")[1].value, "200");
});

test("add a row and remove a row, through expandEl and collapseEl", async () => {
  const win = load();
  const { calls, motion, deps } = recorder((_path, init) => {
    const body = JSON.parse(init.body);
    return pastedNote({ ingredients: body.ingredients });
  });
  const { host } = mount(win, pastedNote(), deps);

  await host.querySelector("[data-meal-card-add]").click();
  const rows = host.querySelectorAll(".meal-card-row");
  assert.equal(rows.length, 8);
  const added = rows[7];
  assert.equal(motion.expanded[0], added);
  const name = added.querySelector("[data-meal-card-name]");
  assert.equal(win.document.activeElement, name, "the new row takes focus");
  assert.equal(host.querySelector("[data-meal-card-save]").disabled, true, "a nameless row is not a change");
  name.value = "Avocado";
  await fire(name, "input");
  const grams = added.querySelector("[data-meal-card-grams]");
  grams.value = "50";
  await fire(grams, "input");
  assert.match(added.querySelector(".meal-card-nutri").textContent, /not estimated/);

  await host.querySelectorAll("[data-meal-card-remove]")[3].click();
  assert.equal(motion.collapsed.length, 1);
  assert.equal(host.querySelectorAll(".meal-card-row").length, 7);
  assert.equal(host.querySelector('[data-meal-card-row="r3"]'), null);
  // Stored 1000, minus the removed olive oil (88).
  assert.match(host.querySelector(".meal-card-totals").textContent, /^912 kcal/);

  await fire(grams, "keydown", { key: "Enter" });
  await flush();
  assert.equal(calls.length, 1, "Enter saves");
  const sent = calls[0].body.ingredients;
  assert.equal(sent.length, 7);
  assert.equal(
    sent.some((row) => row.item === "Olive oil"),
    false
  );
  assert.deepEqual(sent.at(-1), { item: "Avocado", grams: 50 }, "a new row states its name and weight only");
});

test("the last row cannot be removed", async () => {
  const win = load();
  const { deps } = recorder();
  const note = pastedNote({ ingredients: [{ item: "Apple", amount: "180 g", kcal: 94 }] });
  const { host } = mount(win, note, deps);
  assert.equal(host.querySelector(".meal-card-rows").classList.contains("is-single"), true);
  await host.querySelector("[data-meal-card-remove]").click();
  assert.equal(host.querySelectorAll(".meal-card-row").length, 1);
});

test("clearing a grams field reads as logged; nonsense is flagged and ignored", async () => {
  const win = load();
  const { deps } = recorder();
  const { host } = mount(win, pastedNote(), deps);
  await typeGrams(host, 0, "300");
  const input = await typeGrams(host, 0, "abc");
  assert.equal(input.hasAttribute("aria-invalid"), true);
  assert.match(host.querySelector(".meal-card-totals").textContent, /^1165 kcal/);
  await typeGrams(host, 0, "");
  assert.equal(input.hasAttribute("aria-invalid"), false);
  assert.match(host.querySelector(".meal-card-totals").textContent, /^1000 kcal/);
  assert.equal(host.querySelector("[data-meal-card-save]").disabled, true);
});

test("mounting twice on one host still saves once per tap; teardown removes the listeners", async () => {
  const win = load();
  const { calls, deps } = recorder(() => pastedNote());
  const host = createHost(win.document);
  win.CairnMealCardController.mount(host, { note: pastedNote(), ...deps });
  const teardown = win.CairnMealCardController.mount(host, { note: pastedNote(), ...deps });
  host.querySelector("[data-meal-card-edit]").click();
  await typeGrams(host, 0, "250");
  await host.querySelector("[data-meal-card-save]").click();
  await flush();
  assert.equal(calls.length, 1);

  teardown();
  await typeGrams(host, 0, "260");
  assert.equal(host.querySelector("[data-meal-card-save]").disabled, true, "no listener after teardown");
});

test("edits made while a save is in flight are kept, and measured from what was saved", async () => {
  const win = load();
  let release;
  const { calls, deps } = recorder(
    () =>
      new Promise((resolve) => {
        release = () => {
          const note = pastedNote({ kcal: 1165 });
          note.parsed.ingredients[0] = { ...note.parsed.ingredients[0], amount: "300 g", kcal: 495, protein_g: 93 };
          resolve(note);
        };
      })
  );
  const { host } = mount(win, pastedNote(), deps);
  await typeGrams(host, 0, "300");
  const pending = host.querySelector("[data-meal-card-save]").click();
  await flush();
  await typeGrams(host, 1, "300");
  release();
  await pending;
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(host.querySelectorAll("[data-meal-card-grams]")[1].value, "300", "the newer edit survives");
  // Saved 1165, plus rice 150 g -> 300 g (195 -> 390), measured from the saved rows.
  assert.match(host.querySelector(".meal-card-totals").textContent, /^1360 kcal/);
  assert.equal(calls[0].body.ingredients[1].grams, undefined, "the rice edit came after the save");
  assert.equal(host.querySelector("[data-meal-card-save]").disabled, false);
});

test("a save that lands after the person left writes nothing", async () => {
  const win = load();
  let release;
  const { deps, saved } = recorder(() => new Promise((resolve) => (release = () => resolve(pastedNote()))));
  const { host } = mount(win, pastedNote(), deps);
  await typeGrams(host, 0, "300");
  const pending = host.querySelector("[data-meal-card-save]").click();
  await flush();
  host.remove();
  release();
  await pending;
  await flush();
  assert.equal(saved.length, 0);
  assert.equal(host.querySelector(".meal-card-status").textContent, "Saving…");
});

test("a save whose answer reads low confidence repaints the provenance and marks the row in words", async () => {
  const win = load();
  const { deps } = recorder((_path, init) => {
    const body = JSON.parse(init.body);
    const note = pastedNote({ confidence: "low", ingredients: body.ingredients });
    // The server's answer: the new row is the athlete's stated weight, unestimated.
    note.parsed.ingredients[7] = { item: "Avocado", amount: "50 g", basis: "user_report", confidence: "low" };
    return note;
  });
  const { host } = mount(win, pastedNote(), deps);
  assert.equal(host.querySelector(".meal-card-prov").textContent, "Estimated from usual servings · medium confidence");

  await host.querySelector("[data-meal-card-add]").click();
  const added = host.querySelector('[data-meal-card-row="n1"]');
  const name = added.querySelector("[data-meal-card-name]");
  name.value = "Avocado";
  await fire(name, "input");
  const grams = added.querySelector("[data-meal-card-grams]");
  grams.focus();
  grams.value = "50";
  await fire(grams, "input");
  await fire(grams, "keydown", { key: "Enter" });
  await flush();

  assert.equal(
    host.querySelector(".meal-card-prov").textContent,
    "Estimated from usual servings · low confidence",
    "the server's confidence replaces the one the card opened with"
  );
  const row = host.querySelector('[data-meal-card-row="n1"]');
  assert.equal(row.querySelector(".meal-card-basis").textContent, "as you said · rough estimate");
  assert.equal(row.querySelector("[data-meal-card-name]"), null, "a saved row's name is text");
  assert.equal(row.querySelector(".meal-card-item").textContent, "Avocado");
  assert.equal(row.classList.contains("is-added"), false);
});

test("Enter in a grams field saves in place: focus and the live region stay put", async () => {
  const win = load();
  const server = pastedNote({ kcal: 1165, protein_g: 122 });
  server.parsed.ingredients[0] = { ...server.parsed.ingredients[0], amount: "300 g", kcal: 495, protein_g: 93 };
  const { calls, deps } = recorder(() => server);
  const { host } = mount(win, pastedNote(), deps);
  const status = host.querySelector(".meal-card-status");
  const input = host.querySelectorAll("[data-meal-card-grams]")[0];
  input.focus();
  input.value = "300";
  await fire(input, "input");
  await fire(input, "keydown", { key: "Enter" });
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(win.document.activeElement, input, "the field typed in keeps focus (the keyboard stays up)");
  assert.equal(host.querySelectorAll("[data-meal-card-grams]")[0], input, "the field is the same node");
  assert.equal(host.querySelector(".meal-card-status"), status, "the same live region announces the save");
  assert.equal(status.textContent, "Saved");
  assert.match(host.querySelector('[data-meal-card-row="r0"] .meal-card-nutri').textContent, /~495 kcal/);
});

// The card's PUT body run through the server's own recompute: the number the card
// shows before the request is the number the save comes back with.
test("the optimistic totals equal the server's recompute of the card's PUT body", async () => {
  const capture = await import("../dist/foodCapture.js");
  const win = load();
  const M = win.CairnMealCardModel;
  const note = pastedNote();
  note.parsed.ingredients.push({ item: "Chicken thigh", amount: "8 oz chicken", kcal: 470, protein_g: 54, fat_g: 27 });
  note.parsed.kcal += 470;
  const edits = [
    ["a plain grams edit", (rows) => (rows[0].grams = 300)],
    ["an ounce row in grams", (rows) => (rows[7].grams = 150)],
    ["a count row given grams", (rows) => (rows[4].grams = 120)],
    ["a removed row", (rows) => rows.splice(3, 1)],
    ["the row carrying the remainder removed", (rows) => rows.splice(7, 1)],
    ["every row removed", (rows) => rows.splice(0, rows.length)],
  ];
  for (const [label, edit] of edits) {
    const original = M.mealCardRows(note);
    const rows = M.mealCardRows(note);
    edit(rows);
    const preview = M.optimisticTotals(M.storedTotals(note), original, rows);
    const server = capture.recomputeFoodIngredients(note.parsed, plain(rows.map(M.rowBody)));
    for (const key of M.MACRO_KEYS) {
      const saved = server.totals[key] === undefined ? null : Math.round(server.totals[key]);
      assert.equal(preview[key], saved, `${label}: ${key}`);
    }
  }
});

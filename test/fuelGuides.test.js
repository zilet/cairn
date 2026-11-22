// The day's food guides (src/repo/fuel-guides.ts): carbs, fat, fiber and saturated fat
// as ranges / floors / ceilings derived from the athlete's own target, bodyweight, the
// day's work and labs, plus the weekly omega-3 line. What these pin: every figure has a
// basis; the athlete's own numbers win; a lipid finding tightens saturated fat and leans
// fiber in words; protein + the fat floor + the top of the carb range fit inside the kcal
// target; an unknown eaten side stays unknown; a day still being eaten speaks of room,
// a partial closed day says nothing about landing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { dayFuelGuides, nutritionDayRead, FAT_FLOOR_G_PER_KG } from "../dist/repo/fuel-guides.js";
import { carbRangeForTier } from "../dist/repo/fuel-demand.js";
import { fiberFloorG, FIBER_FLOOR_G } from "../dist/repo/fiber-floor.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";

const DATE = "2026-04-25";
const KCAL = 2163;
const PROTEIN = 175;
const KG = 80;
const BASIS = { weight_kg: KG, target_kcal: KCAL, protein_g: PROTEIN };

function intake(overrides = {}) {
  return {
    date: DATE,
    count: 2,
    totals: { kcal: 794, protein_g: 62, carbs_g: 63, fat_g: 33, fiber_g: 10 },
    known: { kcal: true, protein_g: true, carbs_g: true, fat_g: true, fiber_g: true },
    target: { kcal: KCAL, protein_g: PROTEIN, mode: "lose", source: "accepted" },
    remaining: null,
    entries: [
      { id: 1, nutrition_pattern: { saturated_fat_g: 4, saturated_fat: "low" } },
      { id: 2, nutrition_pattern: { saturated_fat_g: 5.4, saturated_fat: "moderate" } },
    ],
    ...overrides,
  };
}

function demand(tier = "high") {
  return { date: DATE, demand: "big", drivers: ["long run on this day"], evidence: [], carbs: carbRangeForTier(tier, BASIS) };
}

function guides(opts = {}) {
  return dayFuelGuides(DATE, {
    today: DATE,
    intake: intake(opts.intake),
    demand: opts.demand === undefined ? demand() : opts.demand,
    basis: opts.basis === undefined ? BASIS : opts.basis,
    directives: opts.directives ?? [],
  });
}

const byKey = (read, key) => read.guides.find((g) => g.key === key);

test("every guide is derived from the day's target, bodyweight and work, with a basis in words", () => {
  const read = guides();
  assert.equal(read.day_state, "in_progress");
  assert.equal(read.target_kcal, KCAL);

  const carbs = byKey(read, "carbs");
  assert.equal(carbs.kind, "range");
  assert.equal(carbs.source, "derived");
  // The day-shape range (230–260 off fuel-demand) flexes to fit: 175 g protein and a
  // 50 g fat floor leave room for at most 250 g of carbs inside 2,163 kcal.
  assert.deepEqual([carbs.low_g, carbs.high_g], [230, 250]);
  assert.equal(carbs.basis_words, "for today's endurance work, inside your target");

  const fat = byKey(read, "fat");
  // A fifth of 2,163 kcal is 48 g (over 0.5 g/kg × 80 kg = 40 g), rounded up to 50; the
  // top leaves the carb range's bottom its room.
  assert.equal(fat.low_g, 50);
  assert.ok(fat.high_g >= fat.low_g && fat.high_g <= Math.floor((KCAL * 0.35) / 9));
  assert.equal(fat.basis_words, "a fifth to a third of today's energy");

  const fiber = byKey(read, "fiber");
  assert.equal(fiber.kind, "floor");
  assert.equal(fiber.low_g, 30);
  assert.equal(fiber.lab_led, false);

  const sat = byKey(read, "saturated_fat");
  assert.equal(sat.kind, "ceiling");
  assert.equal(sat.high_g, 24, "under a tenth of 2,163 kcal");
  assert.equal(sat.eaten_g, 9, "summed because every entry carries it");
  assert.equal(sat.basis_words, "under a tenth of today's energy");
  for (const g of read.guides) assert.ok(g.basis_words, `${g.key} carries a basis`);
});

test("the bodyweight fat floor holds when it is higher than the energy share", () => {
  const heavy = { weight_kg: 110, target_kcal: 1900, protein_g: 200 };
  const read = guides({
    basis: heavy,
    intake: { target: { kcal: 1900, protein_g: 200, mode: "lose", source: "accepted" } },
    demand: { date: DATE, demand: "standard", drivers: [], evidence: [], carbs: carbRangeForTier("moderate", heavy) },
  });
  const fat = byKey(read, "fat");
  assert.equal(fat.low_g, Math.ceil((110 * FAT_FLOOR_G_PER_KG) / 5) * 5);
  assert.match(fat.basis_words, /half a gram per kg/);
});

test("the one fiber rule: 14 g per 1,000 kcal, never under 30 g", () => {
  assert.equal(fiberFloorG(1800), FIBER_FLOOR_G);
  assert.equal(fiberFloorG(null), FIBER_FLOOR_G);
  assert.equal(fiberFloorG(3000), 42);
  const big = dayFuelGuides(DATE, {
    today: DATE,
    intake: intake({ target: { kcal: 3000, protein_g: 180, mode: "maintain", source: "formula" } }),
    demand: null,
    basis: { weight_kg: KG, target_kcal: 3000, protein_g: 180 },
    directives: [],
  });
  assert.equal(byKey(big, "fiber").low_g, 42);
  assert.match(byKey(big, "fiber").basis_words, /14 g per 1,000 kcal/);
});

test("the athlete's own carbs and fat win, and the day-shape range is said beside the carbs", () => {
  const read = guides({
    intake: { target: { kcal: KCAL, protein_g: PROTEIN, mode: "lose", source: "accepted", carbs_g: 200, fat_g: 70 } },
  });
  const carbs = byKey(read, "carbs");
  assert.equal(carbs.source, "yours");
  assert.deepEqual([carbs.low_g, carbs.high_g], [200, 200]);
  assert.ok(carbs.day_shape && carbs.day_shape.high_g > 0);
  const fat = byKey(read, "fat");
  assert.equal(fat.source, "yours");
  assert.deepEqual([fat.low_g, fat.high_g], [70, 70]);
});

test("a lipid finding tightens the saturated-fat ceiling and leans fiber in words, with no invented number", () => {
  const read = guides({
    directives: [
      { domain: "nutrition", marker: "ApoB", directive: "Lower saturated fat and add ~10 g/day soluble fiber." },
    ],
  });
  const sat = byKey(read, "saturated_fat");
  assert.equal(sat.lab_led, true);
  assert.equal(sat.high_g, Math.round((KCAL * 0.06) / 9));
  assert.match(sat.basis_words, /lipids/);
  const fiber = byKey(read, "fiber");
  assert.equal(fiber.lab_led, true);
  assert.equal(fiber.low_g, 30, "the floor itself does not move");
  assert.match(fiber.basis_words, /your lipids ask for more of it/);
});

test("protein + the fat floor + the top of the carb range always fit inside the kcal target", () => {
  for (const kcal of [1500, 1800, 2163, 2600, 3200]) {
    for (const protein of [120, 160, 200]) {
      for (const kg of [60, 80, 100]) {
        for (const tier of ["light", "moderate", "high"]) {
          const basis = { weight_kg: kg, target_kcal: kcal, protein_g: protein };
          const read = guides({
            basis,
            intake: { target: { kcal, protein_g: protein, mode: "lose", source: "formula" } },
            demand: { date: DATE, demand: "big", drivers: [], evidence: [], carbs: carbRangeForTier(tier, basis) },
          });
          const fat = byKey(read, "fat");
          const carbs = byKey(read, "carbs");
          if (!carbs || protein * 4 + fat.low_g * 9 > kcal) continue;
          assert.ok(carbs.low_g <= carbs.high_g);
          assert.ok(
            protein * 4 + fat.low_g * 9 + carbs.high_g * 4 <= kcal,
            `${kcal} kcal, ${protein} g protein, ${kg} kg, ${tier}: ${carbs.high_g} g carbs + ${fat.low_g} g fat floor`
          );
          assert.ok(fat.high_g >= fat.low_g);
        }
      }
    }
  }
});

test("an unknown eaten side stays unknown, never a zero", () => {
  const read = guides({
    intake: {
      known: { kcal: true, protein_g: true, carbs_g: false, fat_g: true, fiber_g: true },
      entries: [
        { id: 1, nutrition_pattern: { saturated_fat_g: 4, saturated_fat: "high" } },
        { id: 2, nutrition_pattern: { saturated_fat: "high" } },
      ],
    },
  });
  assert.equal(byKey(read, "carbs").eaten_g, null);
  assert.equal(byKey(read, "carbs").room, null);
  const sat = byKey(read, "saturated_fat");
  assert.equal(sat.eaten_g, null, "one entry has no grams, so the day has none");
  assert.equal(sat.eaten_band, "high", "the coarse band speaks instead");
  assert.equal(sat.on_card, false, "no grams and no lab finding: the card leaves it off");
  assert.match(sat.note, /^today's meals so far read mostly high in it · /);
  assert.equal(byKey(read, "carbs").on_card, true);
  assert.equal(byKey(guides(), "saturated_fat").on_card, true, "known grams earn the row");
});

test("a day still being eaten carries room, never a landing", () => {
  const read = guides();
  const carbs = byKey(read, "carbs");
  assert.deepEqual(carbs.room, { low_g: 230 - 63, high_g: 250 - 63 });
  assert.equal(carbs.landing, null);
  assert.deepEqual(byKey(read, "fiber").room, { low_g: 20, high_g: null });
  assert.deepEqual(byKey(read, "saturated_fat").room, { low_g: null, high_g: 15 });
});

test("the words arrive finished: the guide, then what is left to place, then the basis", () => {
  const read = guides({
    directives: [{ domain: "nutrition", marker: "ApoB", directive: "Lower saturated fat; add soluble fiber." }],
  });
  const words = Object.fromEntries(read.guides.filter((g) => g.text).map((g) => [g.key, [g.text, g.note]]));
  assert.deepEqual(words.carbs, [
    "around 230–250 g today",
    "room for about 170–190 g more · for today's endurance work, inside your target",
  ]);
  assert.deepEqual(words.fat, ["50–60 g", "room for about 15–25 g more · a fifth to a third of today's energy"]);
  assert.deepEqual(words.fiber, [
    "30 g or more",
    "about 20 g more reaches it · the everyday floor for long-term health; your lipids ask for more of it, oats and beans especially",
  ]);
  assert.deepEqual(words.saturated_fat, ["under 14 g", "about 5 g of room under it · kept lower, as your lipids ask"]);
  for (const g of read.guides) {
    if (g.kind === "weekly") continue;
    assert.doesNotMatch(`${g.text} ${g.note}`, /%|\blow\b|short|behind|missed|must|should/i, g.key);
    assert.ok(g.track.lo >= 0 && g.track.hi <= 1 && g.track.lo <= g.track.hi, `${g.key} track inside 0–1`);
  }
  // The athlete's own number is said as theirs, with the day's shape beside it.
  const own = guides({
    intake: { target: { kcal: KCAL, protein_g: PROTEIN, mode: "lose", source: "accepted", carbs_g: 200 } },
  });
  assert.equal(byKey(own, "carbs").text, "around 200 g, your number");
  assert.match(byKey(own, "carbs").note, /^room for about 140 g more · today's work suits 230–250 g · your own number$/);
});

// ---------- against the database ----------

function food(date, parsed, { meal = "meal", eatenAt = null } = {}) {
  db.prepare(
    `INSERT INTO food_notes (date, meal, raw_output, parsed_json, enrichment_status, eaten_at) VALUES (?, ?, '', ?, 'done', ?)`
  ).run(date, meal, JSON.stringify(parsed), eatenAt);
}

const today = () => localDateISO();
const ago = (n) => addDaysISO(today(), -n);
const dbGuides = (date) => dayFuelGuides(date, { today: today(), demand: null, basis: null, directives: [] });

test("a partial closed day says nothing about landing; a complete one says where it landed", () => {
  food(ago(2), { kcal: 400, carbs_g: 50, fat_g: 10, fiber_g: 5 }, { meal: "breakfast", eatenAt: "08:00" });
  const partial = dbGuides(ago(2));
  assert.equal(partial.day_state, "partial");
  for (const g of partial.guides) {
    assert.equal(g.landing ?? null, null, `${g.key} says nothing about landing`);
    assert.equal(g.room ?? null, null);
    assert.doesNotMatch(g.note ?? "", /landed|under the|over by|room|reach/, `${g.key}: no landing words`);
  }

  food(ago(3), { kcal: 900, carbs_g: 100, fat_g: 30, fiber_g: 12 }, { meal: "breakfast", eatenAt: "08:00" });
  food(ago(3), { kcal: 1000, carbs_g: 110, fat_g: 35, fiber_g: 10 }, { meal: "dinner", eatenAt: "19:30" });
  const complete = dbGuides(ago(3));
  assert.equal(complete.day_state, "complete");
  assert.deepEqual(byKey(complete, "fiber").landing, { where: "under", by_g: 8 });
  assert.match(byKey(complete, "fiber").note, /^under the floor by about 8 g · /);
});

test("the weekly omega-3 line counts days with a source, against two a week", () => {
  food(ago(1), { kcal: 500, nutrition_pattern: { omega_3_source: true } });
  food(ago(2), { kcal: 500, nutrition_pattern: { omega_3_source: false } });
  food(ago(3), { kcal: 500, nutrition_pattern: { omega_3_source: false } });
  food(ago(4), { kcal: 500, nutrition_pattern: { omega_3_source: false } });
  const omega = byKey(dbGuides(today()), "omega_3");
  assert.equal(omega.kind, "weekly");
  assert.equal(omega.eaten_g, null);
  assert.equal(
    omega.words,
    "An omega-3 source on one of the last seven days, the low end of the usual one to two servings of oily fish a week."
  );
  assert.deepEqual(omega.weekly, { days_with: 1, days_logged: 4, supplement: false });
});

test("a daily fish-oil supplement is said, never implied as a gap", () => {
  food(ago(1), { kcal: 500, nutrition_pattern: { omega_3_source: false } });
  repo.addSupplement({ name: "Omega-3 (EPA/DHA)", category: "omega-3", frequency: "daily" });
  const omega = byKey(dbGuides(today()), "omega_3");
  assert.equal(omega.words, "You take an omega-3 supplement daily.");
  assert.doesNotMatch(omega.words, /usual guide|none/i);
  assert.equal(omega.weekly.supplement, true);
});

test("too thin a week, or no omega-3 reads at all, says nothing", () => {
  food(ago(1), { kcal: 500, nutrition_pattern: { omega_3_source: false } });
  assert.equal(byKey(dbGuides(today()), "omega_3"), undefined);
});

test("salt speaks only when it leans high on most logged days AND a lab finding makes it relevant", () => {
  for (const n of [1, 2, 3]) food(ago(n), { kcal: 600, nutrition_pattern: { sodium: "high" } });
  assert.equal(byKey(dbGuides(today()), "sodium"), undefined, "no finding: nothing said");
  const read = dayFuelGuides(today(), {
    today: today(),
    demand: null,
    basis: null,
    directives: [{ domain: "nutrition", marker: "Blood pressure", directive: "Ease off sodium." }],
  });
  const salt = byKey(read, "sodium");
  assert.equal(salt.kind, "weekly");
  assert.doesNotMatch(salt.words, /\d+\s*mg/);
});

test("the day read serves the guides beside the log and the day-shape read", () => {
  repo.setProfile({ age: 40, height_cm: 178, weight_lb: 185, sex: "male", activity_factor: 1.5, goal_mode: "lose" });
  food(today(), { kcal: 600, protein_g: 45, carbs_g: 60, fat_g: 20, fiber_g: 8 }, { meal: "breakfast" });
  const read = nutritionDayRead(today());
  assert.ok(read.fuel_demand);
  assert.equal(read.guides.date, today());
  assert.equal(read.guides.day_state, "in_progress");
  assert.equal(byKey(read.guides, "fat").eaten_g, 20);
  assert.ok(byKey(read.guides, "fiber").low_g >= 30);
});

// v2 wave 2, stream A — ideas on demand replace scheduled meal plans.
//
// GET /api/fuel/ideas is deterministic: up to three ideas from what the athlete eats
// again and again, each sized as ONE MEAL of the rest of today (never sized up),
// inside the observed intake band, protein first. An idea never trades protein away
// to fit the band, never names alcohol, is never logged, and never drafts a plan.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo, seedIntake, seedWeight } from "./_seed.js";
import {
  capIdeaTitle,
  FUEL_IDEA_TITLE_MAX,
  FUEL_STAPLE_MIN_DAYS,
  fuelEnergyBound,
  fuelHealthAlignment,
  fuelHealthLeans,
  fuelIdeas,
  fuelStaples,
  isAlcoholFood,
  sizeFuelIdea,
  stripAlcohol,
  stripQualifiers,
  stripSupplements,
  todaySoFar,
} from "../dist/repo/fuel-ideas.js";
import { supplementFoodKind } from "../dist/repo/supplements.js";
import { mealWindowsAhead } from "../dist/repo/shared.js";
import { nutritionRouter } from "../dist/routes/nutrition.js";
import { registerNutritionTools } from "../dist/surfaces/mcp/nutrition.js";

beforeEach(() => {
  resetTables(
    "food_notes",
    "bodyweight_log",
    "garmin_daily_metrics",
    "profile",
    "meal_plans",
    "health_directives",
    "nutrition_targets"
  );
  repo.setProfile({
    age: 35,
    height_cm: 180,
    weight_lb: 180,
    sex: "male",
    activity_factor: 1.5,
    goal_weight_lb: 170,
    goal_date: null,
  });
});

// Staples: each logged on three different days, with a known estimate.
const STAPLES = {
  "Chicken salad": { kcal: 450, protein_g: 50, carbs_g: 20, fat_g: 18 },
  "Greek yogurt bowl": { kcal: 250, protein_g: 30, carbs_g: 25, fat_g: 4 },
  "Toast with jam": { kcal: 300, protein_g: 6, carbs_g: 55, fat_g: 5 },
};

function seedStaples(staples = STAPLES) {
  for (const [summary, macros] of Object.entries(staples)) {
    for (const daysAgo of [50, 51, 52]) {
      repo.addFoodNote("snack", "", { summary, ...macros }, undefined, { date: localDaysAgo(daysAgo) });
    }
  }
}

// Four weeks ending yesterday at ~`perDay` kcal/day with the weight drifting down — a
// band whose loss edge is `perDay` (the profile is a cut, so that edge holds the room).
function seedBand(perDay = 1800) {
  let weight = 180;
  for (let daysAgo = 28; daysAgo >= 0; daysAgo--) {
    weight -= 1 / 7;
    seedWeight(localDaysAgo(daysAgo), Math.round(weight * 10) / 10);
    if (daysAgo >= 1 && (daysAgo - 1) % 7 < 5) {
      seedIntake(daysAgo, Math.round(perDay * 0.4), {}, { eatenAt: "08:00" });
      seedIntake(daysAgo, perDay - Math.round(perDay * 0.4), {}, { eatenAt: "19:00" });
    }
  }
}

const countRows = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

const staple = (over = {}) => ({
  key: "k",
  title: "T",
  kcal: 600,
  protein_g: 40,
  carbs_g: null,
  fat_g: null,
  times_logged: 3,
  last_logged: null,
  usual_now: false,
  ...over,
});

// Every number an athlete reads in a why line carries its unit.
function assertUnits(text) {
  for (const m of text.matchAll(/\d[\d,.]*/g)) {
    const after = text.slice(m.index + m[0].length);
    assert.match(after, /^ (g|kcal)\b/, `"${m[0]}" without a unit in: ${text}`);
  }
  assert.doesNotMatch(text, /%|score/i);
}

test("ideas never trade protein away to fit the band", () => {
  seedStaples();
  seedBand();
  // Lunch so far: 1,500 kcal and almost no protein — dinner is the one meal left, 300
  // kcal of room, lots of protein owed.
  seedIntake(0, 1500, { protein_g: 10 }, { eatenAt: "12:00" });
  const out = fuelIdeas(undefined, { hour: 13 });
  assert.equal(out.kind, "ideas");
  assert.equal(out.band_status, "ok");
  assert.equal(out.room.energy_kcal, 300);
  assert.equal(out.room.meals_ahead, 1);
  assert.ok(out.room.protein_g > 50, "protein is owed");
  assert.equal(out.ideas.length, 3);

  // Protein first: the biggest protein contribution leads even though it does not fit.
  assert.equal(out.ideas[0].title, "Chicken salad");
  assert.equal(out.ideas[0].portion, 1, "a half portion would fit, but it would give protein away");
  assert.equal(out.ideas[0].protein_g, 50);
  assert.equal(out.ideas[0].fits_band, false);
  assert.match(out.ideas[0].why, /protein comes first/);
  assert.equal(out.ideas[1].title, "Greek yogurt bowl");
  assert.equal(out.ideas[1].fits_band, true);

  // The invariant, for every idea: a portion below the usual one only when the smaller
  // portion still covers this meal's protein share.
  for (const idea of out.ideas) {
    if (idea.portion < 1) assert.ok(out.room.meal_share.protein_g <= idea.protein_g, `${idea.title} shrank protein`);
  }
});

test("a food that is not a protein food is never spoken as a protein step", () => {
  seedStaples({
    ...STAPLES,
    Cantaloupe: { kcal: 18, protein_g: 0, carbs_g: 4, fat_g: 0 },
    "Apple crumble": { kcal: 174, protein_g: 3, carbs_g: 28, fat_g: 6, fiber_g: 4 },
    "Trail mix": { kcal: 70, protein_g: 2, carbs_g: 7, fat_g: 5 },
  });
  seedBand();
  seedIntake(0, 1500, { protein_g: 10 }, { eatenAt: "12:00" });
  const out = fuelIdeas(undefined, { hour: 13, exclude: ["chicken salad", "greek yogurt bowl", "trail mix"] });
  const mix = fuelIdeas(undefined, {
    hour: 13,
    exclude: ["chicken salad", "greek yogurt bowl", "toast with jam", "cantaloupe", "apple crumble"],
  }).ideas.find((i) => /trail mix/i.test(i.title));
  assert.match(
    mix.why,
    /^Mostly fat, about \d+ g — not a protein food/,
    "a handful of trail mix is not 'light and filling'"
  );
  const byTitle = Object.fromEntries(out.ideas.map((idea) => [idea.title, idea]));
  const need = out.room.protein_g;

  const toast = byTitle["Toast with jam"];
  assert.match(
    toast.why,
    /^Mostly carbs, about \d+ g — not a protein food, so pair it with one for the \d+ g protein still to go\./
  );
  const melon = byTitle.Cantaloupe;
  assert.match(melon.why, /^Light and filling for few calories — not a protein food/);
  const crumble = byTitle["Apple crumble"];
  assert.match(crumble.why, /^About \d+ g fiber — not a protein food/);
  for (const idea of [toast, melon, crumble]) {
    assert.doesNotMatch(idea.why, /g protein toward|enough for the|protein comes first/, idea.why);
    assert.ok(idea.why.includes(`${need} g protein still to go`));
    assertUnits(idea.why);
  }
  assert.equal(crumble.fiber_g, Math.round(4 * crumble.portion));
});

test("a few grams short of the protein anchor is about there: nothing still to go, no sizing around it", () => {
  seedStaples({ ...STAPLES, Cantaloupe: { kcal: 18, protein_g: 0, carbs_g: 4, fat_g: 0 } });
  seedBand();
  const anchor = fuelIdeas(undefined, { hour: 13 }).protein_anchor.protein_g;
  seedIntake(0, 1200, { protein_g: anchor - 2 }, { eatenAt: "12:00" });
  const out = fuelIdeas(undefined, { hour: 13 });
  assert.equal(out.room.protein_g, 0, "2 g short is not protein still owed");
  for (const idea of out.ideas) {
    assert.doesNotMatch(idea.why, /still to go|protein comes first/, idea.why);
    assert.match(idea.why, /[Pp]rotein is about there today/, idea.why);
  }
});

test("sizing: one meal, never above the usual portion, shrinking only when the meal's protein share is kept", () => {
  const s = staple();
  // Nothing that fits keeps the 30 g owed: the smallest portion that still carries it.
  assert.equal(sizeFuelIdea(s, { protein_g: 30, energy_kcal: 350 }).portion, 0.75, "half would give 20 g of 30 g");
  assert.equal(sizeFuelIdea(s, { protein_g: 30, energy_kcal: 350 }).fits, false);
  assert.equal(sizeFuelIdea(s, { protein_g: 40, energy_kcal: 350 }).portion, 1, "only the usual carries 40 g");
  assert.equal(sizeFuelIdea(s, { protein_g: 30, energy_kcal: 460 }).portion, 0.75, "a smaller portion keeps 30 g");
  assert.equal(sizeFuelIdea(s, { protein_g: 15, energy_kcal: 350 }).portion, 0.5, "half still covers the 15 g owed");
  assert.equal(sizeFuelIdea(s, { protein_g: 0, energy_kcal: 350 }).portion, 0.5, "protein met: size to the share");
  // Plenty of room and protein owed: still the usual portion — never a double.
  assert.equal(sizeFuelIdea(s, { protein_g: 100, energy_kcal: 2000 }).portion, 1);
  assert.equal(sizeFuelIdea(s, { protein_g: 100, energy_kcal: null }).portion, 1, "no band: the usual portion");
  assert.equal(sizeFuelIdea(s, { protein_g: 100, energy_kcal: null }).fits, null);
  // No single idea carries more than half the day's protein anchor.
  const big = staple({ kcal: 1320, protein_g: 144 });
  const capped = sizeFuelIdea(big, { protein_g: 58, energy_kcal: 660, protein_cap_g: 87.5 });
  assert.equal(capped.portion, 0.5);
  assert.equal(capped.protein, 72);
  assert.equal(capped.fits, true);
  assert.equal(sizeFuelIdea(staple({ protein_g: 200 }), { protein_g: 50, energy_kcal: null, protein_cap_g: 80 }), null);
});

test("an idea is one meal: a morning shares the room across the meals ahead, an evening has one", () => {
  seedBand();
  seedStaples({
    // A big dinner that used to come back as "a double portion" of the whole day.
    "Salmon rice bowl": { kcal: 1300, protein_g: 80, carbs_g: 150, fat_g: 30 },
    "Chicken salad": { kcal: 450, protein_g: 50, carbs_g: 20, fat_g: 18 },
    "Greek yogurt bowl": { kcal: 250, protein_g: 30, carbs_g: 25, fat_g: 4 },
  });
  const morning = fuelIdeas(undefined, { hour: 7 });
  const anchor = morning.protein_anchor.protein_g;
  assert.equal(morning.room.meals_ahead, 3, "breakfast, lunch and dinner are all still ahead");
  assert.equal(morning.room.meal_share.energy_kcal, Math.round(morning.room.energy_kcal / 3));
  assert.equal(morning.room.meal_share.protein_g, Math.round(anchor / 3));
  assert.equal(morning.ideas.length, 3);
  for (const idea of morning.ideas) {
    assert.ok(idea.portion <= 1, `${idea.title} was sized up`);
    assert.doesNotMatch(idea.portion_words, /double|one and a half/);
    assert.ok(idea.protein_g <= anchor / 2, `${idea.title} claims most of the day's protein`);
    if (idea.fits_band) assert.ok(idea.kcal <= morning.room.meal_share.energy_kcal);
    assertUnits(idea.why);
    assert.ok(!idea.why.includes(String(morning.room.energy_kcal)), "the whole day's room is never quoted");
  }
  const bowl = morning.ideas.find((i) => i.title === "Salmon rice bowl");
  assert.ok(bowl.portion < 1, "the big dinner is offered as a smaller portion in the morning");
  const fitting = morning.ideas.find((i) => i.fits_band === true);
  assert.match(fitting.why, /toward the \d+ g still to go/);
  assert.match(fitting.why, /one of the three meals still ahead, and leaves room for the rest of the day/);

  // Evening, lunch logged: dinner is the one meal left, so it may use what is left.
  seedIntake(0, 700, { protein_g: 110 }, { eatenAt: "12:30" });
  const evening = fuelIdeas(undefined, { hour: 19 });
  assert.equal(evening.room.meals_ahead, 1);
  assert.equal(evening.room.meal_share.energy_kcal, evening.room.energy_kcal);
  for (const idea of evening.ideas) {
    assert.ok(idea.portion <= 1);
    assertUnits(idea.why);
  }
  const covering = evening.ideas.find((i) => i.protein_g >= evening.room.protein_g);
  assert.match(
    covering.why,
    new RegExp(`^About ${covering.protein_g} g protein, enough for the ${evening.room.protein_g} g still to go`)
  );
  const eveningFit = evening.ideas.find((i) => i.fits_band === true);
  assert.match(eveningFit.why, /fits what is left under the intake your weight still came down at/);
});

test("the meal windows ahead come from the shared windows and what is already logged", () => {
  assert.deepEqual(mealWindowsAhead(7), ["breakfast", "lunch", "dinner"]);
  assert.deepEqual(mealWindowsAhead(9, [{ meal: "breakfast" }]), ["lunch", "dinner"]);
  assert.deepEqual(mealWindowsAhead(13, [{ meal: "meal", eaten_at: "12:30" }]), ["dinner"]);
  assert.deepEqual(mealWindowsAhead(16), ["dinner"]);
  assert.deepEqual(mealWindowsAhead(19, [{ meal: "snack", eaten_at: "15:30" }]), ["dinner"], "a snack covers no meal");
  assert.deepEqual(mealWindowsAhead(19, [{ meal: "supper" }]), []);
  assert.deepEqual(mealWindowsAhead(23), []);
});

test("a staple repeats: a meal logged on one day is never a staple, even when it is usually eaten now", () => {
  // Three one-off dinners, each at this hour — the old "usual now" path let them in.
  for (const [i, summary] of ["Seafood dinner with apple crumble", "Steak night", "Fish tacos"].entries()) {
    repo.addFoodNote("dinner", "", { summary, kcal: 900, protein_g: 70 }, undefined, {
      date: localDaysAgo(3 + i),
      eaten_at: "19:00",
    });
  }
  assert.equal(FUEL_STAPLE_MIN_DAYS, 2);
  assert.deepEqual(fuelStaples(undefined, 19), [], "one logged day is an event, not a staple");
  const none = fuelIdeas(undefined, { hour: 19 });
  assert.deepEqual(none.ideas, []);
  assert.match(none.words, /No staples/);

  // One real staple: one idea, and the set says why there are not three.
  seedStaples({ "Greek yogurt bowl": STAPLES["Greek yogurt bowl"] });
  const one = fuelIdeas(undefined, { hour: 19 });
  assert.deepEqual(
    one.ideas.map((i) => i.title),
    ["Greek yogurt bowl"]
  );
  assert.equal(one.ideas[0].times_logged, 3);
  assert.match(one.words, /^Only one idea so far: an idea needs a food you have logged on more than one day/);
  for (const idea of one.ideas) assert.ok(idea.times_logged >= FUEL_STAPLE_MIN_DAYS);
});

test("recurring components build an idea in the athlete's own food words", () => {
  // Three different meal summaries (none repeats as a whole), the same components.
  const chicken = { item: "Chicken breast", amount: "200 g", kcal: 330, protein_g: 62, carbs_g: 0, fat_g: 7 };
  const asparagus = { item: "Asparagus", amount: "150 g", kcal: 30, protein_g: 3, carbs_g: 6, fat_g: 0, fiber_g: 3 };
  const peppers = { item: "Peppers", amount: "100 g", kcal: 30, protein_g: 1, carbs_g: 6, fat_g: 0, fiber_g: 2 };
  const wine = { item: "Red wine", amount: "1 glass", kcal: 125, protein_g: 0, carbs_g: 4, fat_g: 0 };
  const meals = [
    ["Chicken breast with asparagus and peppers", [chicken, asparagus, peppers]],
    ["Grilled chicken, asparagus, peppers and a glass of red wine", [chicken, asparagus, peppers, wine]],
    ["Chicken plate with asparagus, peppers & red wine", [chicken, asparagus, peppers, wine]],
  ];
  meals.forEach(([summary, ingredients], i) => {
    const kcal = ingredients.reduce((a, r) => a + r.kcal, 0);
    const protein_g = ingredients.reduce((a, r) => a + r.protein_g, 0);
    repo.addFoodNote("dinner", "", { summary, kcal, protein_g, ingredients }, undefined, {
      date: localDaysAgo(10 + i),
    });
  });
  const out = fuelIdeas(undefined, { hour: 19 });
  assert.equal(out.ideas.length, 1, "one idea per lead food");
  const [idea] = out.ideas;
  assert.equal(idea.source, "components");
  assert.equal(idea.title, "Chicken breast with asparagus and peppers");
  assert.equal(idea.protein_g, 66);
  assert.equal(idea.kcal, 390, "the wine is never counted in");
  assert.equal(idea.times_logged, 3);
  assert.doesNotMatch(`${idea.title} ${idea.prefill}`, /wine/i);
  assert.match(idea.prefill, /^Chicken breast \(200 g\), asparagus \(150 g\), and peppers \(100 g\)$/);
  assert.ok(!idea.key.includes(","), "an idea key survives ?exclude=key,key");
});

test("never alcohol: stripped from a staple's words and numbers, a mostly-alcohol staple is skipped", () => {
  const rows = [
    { item: "Chicken breast", kcal: 330, protein_g: 62 },
    { item: "Pinto beans", kcal: 200, protein_g: 12, fiber_g: 10 },
    { item: "Toast", kcal: 160, protein_g: 6 },
    { item: "Trail mix", kcal: 300, protein_g: 8 },
    { item: "Rakija", kcal: 100, protein_g: 0 },
  ];
  const summary = "Chicken breast with pinto beans, veggies, toast, trail mix & rakija sip";
  for (const d of [20, 21]) {
    repo.addFoodNote("dinner", "", { summary, kcal: 1090, protein_g: 84, ingredients: rows }, undefined, {
      date: localDaysAgo(d),
    });
  }
  // A "staple" that is nothing but a drink.
  for (const d of [20, 21, 22]) {
    repo.addFoodNote(
      "snack",
      "",
      {
        summary: "Beer and pretzels",
        kcal: 330,
        protein_g: 5,
        ingredients: [
          { item: "Beer", kcal: 220, protein_g: 2 },
          { item: "Pretzels", kcal: 110, protein_g: 3 },
        ],
      },
      undefined,
      { date: localDaysAgo(d) }
    );
  }
  const staples = fuelStaples(undefined, 19);
  assert.ok(!staples.some((s) => /beer|pretzel/i.test(s.title)), "mostly alcohol: skipped");
  const out = fuelIdeas(undefined, { hour: 19 });
  const meal = out.ideas.find((i) => i.source === "staple");
  assert.ok(meal, "the dinner is still offered");
  assert.doesNotMatch(`${meal.title} ${meal.prefill}`, /rakija|sip/i);
  assert.equal(meal.kcal, 990, "the rakija's kcal is taken out");
  assert.ok(meal.title.length <= FUEL_IDEA_TITLE_MAX);
  assert.equal(meal.title, "Chicken breast with pinto beans, veggies, toast, and more");
  assert.equal(meal.prefill, "Chicken breast with pinto beans, veggies, toast, and trail mix");
});

test("alcohol words: drinks are caught, cooking uses and soft drinks are not", () => {
  for (const drink of ["Red wine", "a beer", "Rakija sip", "gin and tonic", "IPA", "whiskey", "Aperol spritz"]) {
    assert.ok(isAlcoholFood(drink), drink);
  }
  for (const food of [
    "red wine vinegar",
    "beer-battered cod",
    "ginger beer",
    "alcohol-free lager",
    "kale",
    "ginger",
    "rump steak",
    "apple cider vinegar",
  ]) {
    assert.ok(!isAlcoholFood(food), food);
  }
  assert.equal(stripAlcohol("Steak with red wine"), "Steak");
  assert.equal(stripAlcohol("Mac and cheese with a beer"), "Mac and cheese");
  assert.equal(stripAlcohol("Salad with red wine vinegar"), "Salad with red wine vinegar");
  assert.equal(stripAlcohol("Red wine"), "");
});

test("never a supplement: not a side, not a component, out of a staple's words and numbers", () => {
  const chicken = { item: "Chicken breast (cooked)", amount: "200 g", kcal: 330, protein_g: 62, carbs_g: 0, fat_g: 7 };
  const rice = { item: "Rice (cooked)", amount: "150 g", kcal: 195, protein_g: 4, carbs_g: 42, fat_g: 0 };
  const psyllium = {
    item: "Psyllium husk",
    amount: "1 tbsp",
    kcal: 20,
    protein_g: 0,
    carbs_g: 6,
    fat_g: 0,
    fiber_g: 5,
  };
  const creatine = { item: "Creatine", amount: "5 g", kcal: 0, protein_g: 0 };
  const fishOil = { item: "Fish oil capsules", amount: "2", kcal: 20, protein_g: 0, fat_g: 2 };
  const whey = { item: "Whey protein shake", amount: "1 scoop", kcal: 120, protein_g: 24, carbs_g: 3, fat_g: 1 };
  const meals = [
    ["Chicken and rice", [chicken, rice, psyllium, creatine, fishOil, whey]],
    ["Chicken breast, rice, psyllium", [chicken, rice, psyllium, creatine, fishOil, whey]],
    ["Rice bowl with chicken and a shake", [chicken, rice, psyllium, creatine, fishOil, whey]],
  ];
  meals.forEach(([summary, ingredients], i) => {
    const kcal = ingredients.reduce((a, r) => a + r.kcal, 0);
    const protein_g = ingredients.reduce((a, r) => a + r.protein_g, 0);
    repo.addFoodNote("dinner", "", { summary, kcal, protein_g, ingredients }, undefined, {
      date: localDaysAgo(10 + i),
    });
  });
  const staples = fuelStaples(undefined, 19);
  const components = staples.filter((s) => s.source === "components");
  assert.ok(components.length > 0);
  for (const s of components) {
    assert.doesNotMatch(`${s.title} ${s.prefill}`, /psyllium|creatine|fish oil/i, s.title);
    assert.ok(!/whey|shake/i.test(s.title) || /^whey/i.test(s.title), `a protein shake is never a side: ${s.title}`);
    assert.doesNotMatch(s.title, /\(/, "no parenthetical qualifier on a card");
  }
  const chickenIdea = components.find((s) => /^Chicken breast/.test(s.title));
  assert.equal(chickenIdea.title, "Chicken breast with rice");
  assert.equal(chickenIdea.prefill, "Chicken breast (200 g) and rice (150 g)");
  assert.equal(chickenIdea.kcal, 525, "only chicken and rice are counted");
  assert.ok(
    components.some((s) => /^Whey protein shake\b/.test(s.title)),
    "a protein shake may still carry an idea"
  );

  // A whole meal that names a supplement: it leaves the words and the numbers.
  const bowl = { item: "Oats", kcal: 300, protein_g: 10, fiber_g: 8 };
  for (const d of [20, 21]) {
    repo.addFoodNote(
      "breakfast",
      "",
      {
        summary: "Oats with berries, psyllium husk",
        kcal: 320,
        protein_g: 10,
        fiber_g: 13,
        ingredients: [bowl, psyllium],
      },
      undefined,
      { date: localDaysAgo(d) }
    );
  }
  const oats = fuelStaples(undefined, 8).find((s) => s.source === "staple" && /^Oats/.test(s.title));
  assert.equal(oats.title, "Oats with berries");
  assert.equal(oats.prefill, "Oats with berries");
  assert.equal(oats.kcal, 300);
  assert.equal(oats.fiber_g, 8);
});

test("supplement words: supplements are caught, foods are not", () => {
  for (const pill of [
    "Psyllium husk",
    "Creatine monohydrate",
    "Fish oil",
    "Omega-3 softgel",
    "Magnesium glycinate",
    "Vitamin D3",
    "Iron",
    "Caffeine",
    "Zinc 15 mg",
    "Vitamin C tablets",
    "Omega-3 2 capsules",
    "Vitamin D3 + K2",
    "Iron bisglycinate",
  ]) {
    assert.equal(supplementFoodKind(pill), "supplement", pill);
  }
  for (const shake of ["Whey protein shake", "Casein", "Protein powder"])
    assert.equal(supplementFoodKind(shake), "protein", shake);
  assert.equal(supplementFoodKind("Collagen peptides"), "supplement");
  for (const food of [
    "Prepared salad",
    "Turmeric chicken",
    "Probiotic yogurt",
    "Mushroom caps",
    "Chicken breast",
    "Cod liver",
    "Omega-3 eggs",
    "Vitamin D milk",
    "DHA milk",
    "Iron-fortified cereal",
    "Caffeine-free Diet Coke",
    "Orange juice (vitamin C)",
    "Cast iron steak",
    "Benecol stanol spread",
    "Collagen coffee creamer",
  ]) {
    assert.equal(supplementFoodKind(food), null, food);
  }
  assert.equal(stripSupplements("Oats with berries, psyllium husk"), "Oats with berries");
  assert.equal(stripSupplements("Creatine"), "");
  assert.equal(stripSupplements("Eggs and toast"), "Eggs and toast");
  assert.equal(stripQualifiers("Rice (cooked) with beans [canned], and kale"), "Rice with beans, and kale");
  assert.equal(capIdeaTitle("Chicken breast (cooked) with rice (cooked)"), "Chicken breast with rice");
});

test("a food that names a nutrient stays in the idea's words and numbers", () => {
  const eggs = { item: "Omega-3 eggs", amount: "3", kcal: 210, protein_g: 18, carbs_g: 1, fat_g: 15 };
  const toast = { item: "Toast", amount: "1 slice", kcal: 160, protein_g: 6, carbs_g: 30, fat_g: 2 };
  for (const d of [20, 21]) {
    repo.addFoodNote(
      "breakfast",
      "",
      { summary: "Omega-3 eggs, toast", kcal: 370, protein_g: 24, ingredients: [eggs, toast] },
      undefined,
      { date: localDaysAgo(d) }
    );
  }
  const breakfast = fuelStaples(undefined, 8).find((s) => s.source === "staple");
  assert.equal(breakfast.title, "Omega-3 eggs, toast");
  assert.equal(breakfast.kcal, 370);
  assert.equal(breakfast.protein_g, 24);
});

test("a qualifier never splits one food: one rice, one lead, one title", () => {
  const chicken = (item) => ({ item, amount: "200 g", kcal: 330, protein_g: 62, carbs_g: 0, fat_g: 7 });
  const rice = (item) => ({ item, amount: "150 g", kcal: 195, protein_g: 4, carbs_g: 42, fat_g: 0 });
  const meals = [
    ["Chicken and rice", [chicken("Chicken breast (grilled)"), rice("Rice (cooked)")]],
    ["Chicken rice plate", [chicken("Chicken breast (baked)"), rice("Rice (white)")]],
    ["Rice bowl with chicken", [chicken("Chicken breast (grilled)"), rice("Rice (cooked)"), rice("Rice (white)")]],
  ];
  meals.forEach(([summary, ingredients], i) => {
    const kcal = ingredients.reduce((a, r) => a + r.kcal, 0);
    const protein_g = ingredients.reduce((a, r) => a + r.protein_g, 0);
    repo.addFoodNote("dinner", "", { summary, kcal, protein_g, ingredients }, undefined, {
      date: localDaysAgo(10 + i),
    });
  });
  const components = fuelStaples(undefined, 19).filter((s) => s.source === "components");
  const chickenIdeas = components.filter((s) => /^Chicken breast/.test(s.title));
  assert.equal(chickenIdeas.length, 1, "grilled and baked chicken lead one idea");
  assert.equal(chickenIdeas[0].title, "Chicken breast with rice");
  assert.equal(chickenIdeas[0].prefill, "Chicken breast (200 g) and rice (150 g)");
  const shown = fuelIdeas(undefined, { hour: 19 }).ideas.map((i) => i.title.toLowerCase());
  assert.equal(new Set(shown).size, shown.length, "no two ideas print the same title");
});

test("a title keeps its words: a lone qualifier stays, a stripped list starts with a capital", () => {
  assert.equal(capIdeaTitle("(leftovers)"), "Leftovers");
  assert.equal(capIdeaTitle("Rice (cooked)"), "Rice");
  assert.equal(stripQualifiers("(leftovers)"), "");
  for (const d of [20, 21]) {
    repo.addFoodNote(
      "dinner",
      "",
      {
        summary: "Beer, pizza",
        kcal: 950,
        protein_g: 35,
        ingredients: [
          { item: "Beer", kcal: 150, protein_g: 1 },
          { item: "Pizza", kcal: 800, protein_g: 34 },
        ],
      },
      undefined,
      { date: localDaysAgo(d) }
    );
  }
  const pizza = fuelStaples(undefined, 19).find((s) => s.source === "staple");
  assert.equal(pizza.title, "Pizza");
});

test("titles are card-sized: cut at a list boundary or a word, never mid-word", () => {
  assert.equal(capIdeaTitle("Greek yogurt bowl"), "Greek yogurt bowl");
  const list = capIdeaTitle("Chicken breast with asparagus, skyr, peppers, radishes, and a side of roasted potatoes");
  assert.ok(list.length <= FUEL_IDEA_TITLE_MAX, list);
  assert.match(list, /, and more$/);
  const phrase = "Seafood dinner with homemade low-sugar apple crumble and vanilla custard on the side";
  const cut = capIdeaTitle(phrase);
  assert.ok(cut.length <= FUEL_IDEA_TITLE_MAX, cut);
  assert.match(cut, /…$/);
  const words = cut.slice(0, -1).split(" ");
  assert.deepEqual(words, phrase.split(" ").slice(0, words.length), "cut on a word boundary");
});

test("active nutrition findings nudge the order toward low saturated fat and fiber, never the set", () => {
  seedStaples({
    // Same protein and energy; the first is denser in protein, the second lines up with a lipid finding.
    "Pork chop plate": { kcal: 500, protein_g: 45, nutrition_pattern: { saturated_fat: "high" } },
    "Lentil and turkey bowl": { kcal: 520, protein_g: 45, fiber_g: 12, nutrition_pattern: { saturated_fat: "low" } },
  });
  const before = fuelIdeas(undefined, { hour: 19 });
  assert.equal(before.ideas[0].title, "Pork chop plate");
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive, rationale, status)
     VALUES ('markers', 'nutrition', 'LDL-C', 'Favour less saturated fat and more soluble fiber.', 'LDL above range.', 'active')`
  ).run();
  const after = fuelIdeas(undefined, { hour: 19 });
  assert.deepEqual(
    after.ideas.map((i) => i.title),
    ["Lentil and turkey bowl", "Pork chop plate"],
    "reordered, nothing excluded"
  );
  for (const idea of after.ideas) assert.doesNotMatch(idea.why, /saturated|fiber|LDL|cholesterol/i, "never a lecture");

  const leans = fuelHealthLeans([{ directive: "Keep sodium modest for blood pressure." }]);
  assert.deepEqual(leans, { lower_saturated_fat: false, more_fiber: false, lower_sodium: true });
  assert.equal(fuelHealthAlignment(staple({ sodium: "low" }), leans), 1);
  assert.equal(fuelHealthAlignment(staple({ sodium: "high" }), leans), 0);
});

test("with no band the ideas make no energy claim; they are never logged and never a plan", () => {
  seedStaples();
  const notes = countRows("food_notes");
  const out = fuelIdeas();
  assert.equal(out.band_status, "too_few_days");
  assert.equal(out.room.energy_kcal, null);
  assert.ok(out.ideas.length > 0);
  for (const idea of out.ideas) {
    assert.equal(idea.fits_band, null);
    assert.equal(idea.portion, 1);
    assert.ok(idea.prefill.startsWith(idea.title), "Start from this fills the composer");
  }
  assert.equal(out.today_so_far.state, "nothing logged");
  assert.equal(countRows("food_notes"), notes, "an idea is never logged");
  assert.equal(countRows("meal_plans"), 0, "an idea is never a meal plan");
});

test("today's partial day reads in progress, and a food already eaten today is not re-offered", () => {
  seedStaples();
  repo.addFoodNote("breakfast", "", { summary: "Greek yogurt bowl", ...STAPLES["Greek yogurt bowl"] });
  const out = fuelIdeas();
  assert.equal(out.today_so_far.state, "in progress");
  assert.equal(out.today_so_far.protein_g, 30);
  assert.ok(!out.ideas.some((i) => i.title === "Greek yogurt bowl"));
});

test("a meal still being estimated is not a zero: no protein still to go and no energy room off a partial sum", () => {
  seedStaples();
  seedBand();
  repo.addFoodNote("breakfast", "", { summary: "Greek yogurt bowl", ...STAPLES["Greek yogurt bowl"] });
  const known = fuelIdeas();
  assert.equal(known.room.protein_g, known.protein_anchor.protein_g - 30);
  assert.notEqual(known.room.energy_kcal, null, "the band sizes the room while every meal has numbers");

  repo.addFoodNote("lunch", "", { summary: "Something from the cafe" });
  const out = fuelIdeas();
  assert.equal(out.today_so_far.state, "in progress");
  // The sum is marked for what it is: partial, over the estimated meals only.
  assert.equal(out.today_so_far.partial, true);
  assert.equal(out.today_so_far.meals_counted, 1);
  assert.equal(out.today_so_far.meals_unestimated, 1, "the unestimated meal is left out explicitly, not added as zero");
  assert.equal(out.today_so_far.protein_g, 30);
  assert.equal(out.today_so_far.kcal, 250);
  assert.equal(
    out.today_so_far.words,
    "So far today: 30 g protein, 250 kcal and 0 g fiber from 1 meal — in progress, not the day's total. 1 more meal has no numbers yet and isn't counted."
  );
  assert.equal(out.room.protein_g, null);
  assert.equal(out.room.energy_kcal, null);
  assert.ok(out.ideas.length > 0);
  for (const idea of out.ideas) {
    assert.doesNotMatch(idea.why, /still to go|kcal/, "no claim measured off a sum that is only a floor");
    assert.equal(idea.fits_band, null);
    assert.equal(idea.portion, 1, "the usual portion, with no energy claim");
  }
});

test("no staples yet: no ideas, said in words", () => {
  const out = fuelIdeas();
  assert.deepEqual(out.ideas, []);
  assert.match(out.words, /No staples/);
});

test("REST and MCP mirror, and exclude asks for different ideas", async () => {
  seedStaples({ ...STAPLES, "Eggs, toast, and berries": { kcal: 420, protein_g: 28 } });
  let handler;
  for (const layer of nutritionRouter.stack) {
    if (layer.route?.path === "/fuel/ideas" && layer.route.methods.get) handler = layer.route.stack.at(-1).handle;
  }
  const rest = await new Promise((resolve) => handler({ query: { hour: "12" } }, { json: resolve }));
  const tools = new Map();
  registerNutritionTools({ tool: (n, _d, _s, h) => tools.set(n, h) });
  const mcp = JSON.parse((await tools.get("get_fuel_ideas")({ hour: 12 })).content[0].text);
  assert.deepEqual(
    mcp.ideas.map((i) => i.key),
    rest.ideas.map((i) => i.key)
  );
  // Both surfaces carry the same marked-partial sum.
  assert.deepEqual(mcp.today_so_far, rest.today_so_far);
  assert.equal(rest.today_so_far.partial, true);
  assert.equal(rest.today_so_far.words, "Nothing logged yet today.");
  const first = rest.ideas[0].key;
  const next = await new Promise((resolve) => handler({ query: { exclude: first } }, { json: resolve }));
  assert.ok(!next.ideas.some((i) => i.key.split("@")[0] === first.split("@")[0]));
  // A staple whose words carry commas still excludes through ?exclude=key,key.
  const commas = rest.ideas.concat(next.ideas).find((i) => i.title.startsWith("Eggs"));
  assert.ok(commas && !commas.key.includes(","));
  const all = [...new Set([...rest.ideas, ...next.ideas].map((i) => i.key))].join(",");
  const rest2 = await new Promise((resolve) => handler({ query: { hour: "12", exclude: all } }, { json: resolve }));
  assert.ok(!rest2.ideas.some((i) => i.title.startsWith("Eggs")));
});

const okBand = (over = {}) => ({
  status: "ok",
  confidence: "moderate",
  energy_ceiling_kcal: 2300,
  band: { low_kcal: 1900, high_kcal: 2500, low_is_loss_edge: true, high_is_gain_edge: true, mixed: false },
  ...over,
});

test("a loose band sizes nothing: mixed weeks or low confidence make no energy claim", () => {
  const mixed = okBand({ band: { ...okBand().band, mixed: true } });
  assert.deepEqual(fuelEnergyBound(mixed, null), { kcal: null, kind: null });
  assert.equal(fuelEnergyBound(okBand({ confidence: "low" }), null).kcal, null);
  assert.equal(
    fuelEnergyBound({ status: "too_few_days", band: null, energy_ceiling_kcal: null, confidence: null }, null).kcal,
    null
  );
  // Maintain/gain: the no-gain ceiling.
  assert.deepEqual(fuelEnergyBound(okBand(), { kcal: 2400, mode: "maintain", source: "formula" }), {
    kcal: 2300,
    kind: "observed_ceiling",
  });
});

test("during a cut the room is the athlete's own cut bound, never observed maintenance", () => {
  // The loss edge (the most eaten in a week the weight still came down) holds the room.
  assert.deepEqual(fuelEnergyBound(okBand(), { kcal: 2100, mode: "lose", source: "formula" }), {
    kcal: 1900,
    kind: "loss_edge",
  });
  // A target the athlete accepted, when it is lower, holds it instead; a formula guess never does.
  assert.equal(fuelEnergyBound(okBand(), { kcal: 1800, mode: "lose", source: "accepted" }).kind, "accepted_target");
  assert.equal(fuelEnergyBound(okBand(), { kcal: 1800, mode: "lose", source: "formula" }).kind, "loss_edge");
  // No loss edge and no accepted target: the ceiling bounds the room.
  const noLossEdge = okBand({ band: { ...okBand().band, low_is_loss_edge: false } });
  assert.deepEqual(fuelEnergyBound(noLossEdge, { kcal: 2100, mode: "lose", source: "formula" }), {
    kcal: 2300,
    kind: "observed_ceiling",
  });
});

test("a stated target during a cut: the room is the lower of it and the loss edge", () => {
  // min(stated target, loss edge), whichever side is lower.
  assert.deepEqual(fuelEnergyBound(okBand(), { kcal: 1800, mode: "lose", source: "user" }), {
    kcal: 1800,
    kind: "accepted_target",
  });
  assert.deepEqual(fuelEnergyBound(okBand(), { kcal: 2100, mode: "lose", source: "user" }), {
    kcal: 1900,
    kind: "loss_edge",
  });

  // End to end: a target the athlete set (source "user") under a loss edge holds the room.
  seedStaples();
  seedBand(2400);
  const edge = fuelIdeas(undefined, { hour: 19 });
  assert.equal(edge.room.energy_bound, "loss_edge");
  const set = repo.setNutritionTarget({ target_kcal: 2000, protein_g: 170, source: "user" });
  assert.ok(set.target_kcal < edge.room.energy_kcal, "the stated target sits under the loss edge");
  const stated = fuelIdeas(undefined, { hour: 19 });
  assert.equal(stated.room.energy_bound, "accepted_target");
  assert.equal(stated.room.energy_kcal, set.target_kcal);
  assert.match(stated.ideas.find((i) => i.fits_band === true).why, /under the target you set/);
});

test("the ideas say what the room is measured under", () => {
  seedStaples();
  seedBand(); // every week trended down at ~1,800 kcal, and the profile is a cut
  seedIntake(0, 1500, { protein_g: 10 }, { eatenAt: "12:00" });
  const out = fuelIdeas(undefined, { hour: 13 });
  assert.equal(out.room.energy_bound, "loss_edge");
  const fitting = out.ideas.find((i) => i.fits_band === true);
  assert.match(fitting.why, /came down at/);
});

test("today so far is never read as the whole day: partial until complete, unestimated meals counted apart", () => {
  const meal = (kcal, protein_g, fiber_g = 5) => ({ kcal, protein_g, fiber_g });
  const past = "2020-01-02";
  const complete = todaySoFar({ entries: [meal(900, 60), meal(1100, 80)] }, "complete", past);
  assert.equal(complete.partial, false);
  assert.equal(complete.words, "The day's total: 140 g protein, 2,000 kcal and 10 g fiber.");
  const holey = todaySoFar(
    { entries: [meal(900, 60), { kcal: null, protein_g: null, fiber_g: null }] },
    "complete",
    past
  );
  assert.equal(holey.partial, true, "a meal with no numbers keeps even a complete day's sum partial");
  assert.equal(holey.kcal, 900);
  assert.match(
    holey.words,
    /^Logged that day: 60 g protein, 900 kcal and 5 g fiber from 1 meal — not the whole day\. 1 more meal has no numbers yet/
  );
  const none = todaySoFar(
    {
      entries: [
        { kcal: null, protein_g: null },
        { kcal: null, protein_g: null },
      ],
    },
    "in progress",
    past
  );
  assert.equal(none.meals_counted, 0);
  assert.equal(none.meals_unestimated, 2);
  assert.equal(none.words, "2 meals are logged, with no numbers yet, so there is no sum to show.");
  assert.doesNotMatch(`${complete.words} ${holey.words} ${none.words}`, /\blow\b|score|%/);
});

// ---- the "with" pairing and the room words (bigger days) ----
import { fuelRoomWords, pairCarbSide, FUEL_WITH_MIN_KCAL } from "../dist/repo/fuel-ideas.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { fuelIdeasForDay } from "../dist/repo/fuel-ideas-day.js";
import { localDateISO } from "../dist/repo/shared.js";

// A carb food the athlete keeps eating, logged inside meals that are each one-off
// (so it is a recurring COMPONENT, never a staple meal of its own).
function seedRice(over = {}) {
  const item = { item: "Rice (cooked)", kcal: 200, protein_g: 4, carbs_g: 44, fat_g: 0.4, ...over };
  [60, 61, 62].forEach((daysAgo, i) => {
    repo.addFoodNote("meal", "", { summary: `Side plate ${i}`, kcal: item.kcal, protein_g: 4, ingredients: [item] }, undefined, {
      date: localDaysAgo(daysAgo),
    });
  });
}

test("a clear leftover and carb room pair the idea with one carb staple from the athlete's own log", () => {
  seedStaples();
  seedRice();
  seedBand();
  const out = fuelIdeas(undefined, { hour: 19, carbsRoomG: 120 });
  assert.ok(out.ideas.length > 0);
  const paired = out.ideas.filter((i) => i.with);
  assert.ok(paired.length > 0, "an evening with room carries a pairing");
  for (const idea of out.ideas) {
    assert.ok(idea.portion <= 1, "never above the usual portion");
    if (!idea.with) continue;
    assert.equal(idea.with.title, "Rice", "only food from their own log");
    assert.equal(idea.with.kcal, 200);
    assert.equal(idea.with.carbs_g, 44);
    assert.match(idea.with.words, /^With rice, about 200 kcal more/);
    assert.ok(out.room.meal_share.energy_kcal - idea.kcal - idea.with.kcal >= -1, "the pair still fits this meal's share");
    assert.equal(violatesReadingGrammar(idea.with.words), null, idea.with.words);
    assert.doesNotMatch(idea.prefill, /rice/i, "the prefill is the idea alone");
  }
});

test("no pairing without carb room, with little energy left, or with nothing carb-leaning in the log", () => {
  seedStaples();
  seedRice();
  seedBand();
  for (const carbsRoomG of [null, undefined, 20]) {
    const out = fuelIdeas(undefined, { hour: 19, carbsRoomG });
    assert.ok(out.ideas.every((i) => i.with == null), `carbs room ${carbsRoomG}`);
  }
  // Little energy left: lunch took nearly all of the room.
  seedIntake(0, 1650, { protein_g: 10 }, { eatenAt: "12:00" });
  const tight = fuelIdeas(undefined, { hour: 19, carbsRoomG: 120 });
  assert.ok(tight.ideas.every((i) => i.with == null), "crumbs of room pair nothing");
});

test("no pairing when no staple is mostly carbohydrate or small enough", () => {
  seedStaples();
  seedBand();
  assert.ok(fuelIdeas(undefined, { hour: 19, carbsRoomG: 120 }).ideas.every((i) => i.with == null), "no carb food logged");
  seedRice({ kcal: 3000, carbs_g: 600 });
  assert.ok(fuelIdeas(undefined, { hour: 19, carbsRoomG: 900 }).ideas.every((i) => i.with == null), "too big to fit");
});

test("pairCarbSide holds its thresholds and never repeats the idea's own food", () => {
  const sides = [{ key: "rice", title: "Rice", kcal: 200, carbs_g: 44, days: 3 }];
  const idea = { title: "Chicken", kcal: 400, carbs_g: 10 };
  assert.ok(pairCarbSide(idea, 700, 100, sides), "300 left of 700");
  assert.equal(pairCarbSide(idea, 700, 100, [{ ...sides[0], kcal: 301 }]), null, "does not fit the leftover");
  assert.equal(pairCarbSide({ ...idea, kcal: 600 }, 700, 100, sides), null, `under ${FUEL_WITH_MIN_KCAL} kcal left`);
  assert.equal(pairCarbSide({ ...idea, kcal: 1200 }, 1500, 100, sides), null, "a leftover of 300 is under a quarter of 1,500");
  assert.equal(pairCarbSide(idea, 700, 40, sides), null, "carbs room after the idea's own carbs is 30 g");
  assert.equal(pairCarbSide({ ...idea, title: "Chicken and rice" }, 700, 100, sides), null, "already in the idea");
  assert.equal(pairCarbSide(idea, null, 100, sides), null, "no energy claim");
});

test("room words speak only on a bigger day, say about, and pass the reading grammar", () => {
  const big = fuelRoomWords({ shiftKcal: 300, work: ["the long run"], openKcal: 1013, carbsRoomG: 90 });
  assert.equal(big, "Today's number is bigger for the long run; after one of these about 1,010 kcal is still open, and it suits carbs.");
  assert.equal(violatesReadingGrammar(big), null);
  const noCarbs = fuelRoomWords({ shiftKcal: 300, work: ["lifting"], openKcal: 400, carbsRoomG: 10 });
  assert.doesNotMatch(noCarbs, /carbs/);
  assert.equal(violatesReadingGrammar(noCarbs), null);
  assert.equal(fuelRoomWords({ shiftKcal: 0, work: [], openKcal: 1000, carbsRoomG: 90 }), null, "ordinary day");
  assert.equal(fuelRoomWords({ shiftKcal: -200, work: [], openKcal: 1000, carbsRoomG: 90 }), null, "lighter day");
  assert.equal(fuelRoomWords({ shiftKcal: 300, work: ["lifting"], openKcal: 100, carbsRoomG: 90 }), null, "little open");
  assert.equal(fuelRoomWords({ shiftKcal: 300, work: ["lifting"], openKcal: null, carbsRoomG: 90 }), null);
});

test("on a bigger day the ideas carry the room words; on a lighter day the ideas respect the smaller room", () => {
  seedStaples();
  seedBand();
  const dow = new Date(`${localDateISO()}T12:00:00`).getDay();
  const setLiftDays = (days) =>
    repo.setProfile({ strength_schedule: { days: days.map((d) => ({ dow: d })), source: "athlete", updated_at: localDateISO() } });
  repo.savePlanDay(1, "Full body", "strength", [{ exercise: "Back Squat", sets: 3, reps: "5" }], { day_type: "training" });

  setLiftDays([(dow + 2) % 7, (dow + 4) % 7]);
  const light = fuelIdeas(undefined, { hour: 19, carbsRoomG: 120 });
  setLiftDays([dow, (dow + 3) % 7]);
  const big = fuelIdeas(undefined, { hour: 19, carbsRoomG: 120 });

  assert.ok(big.room.energy_kcal > light.room.energy_kcal, "a lifting day has more room than a rest day");
  assert.equal(light.room_words, null);
  assert.match(big.room_words ?? "", /^Today's number is bigger for lifting; after one of these about [\d,]+ kcal is still open/);
  assert.equal(violatesReadingGrammar(big.room_words), null);
  for (const out of [light, big]) {
    for (const idea of out.ideas) {
      assert.ok(idea.portion <= 1);
      if (idea.fits_band) assert.ok(idea.kcal <= out.room.meal_share.energy_kcal + 1, "inside this meal's share");
    }
  }
});

test("fuelIdeasForDay reads the carbs room from the day's guide and mirrors fuelIdeas", () => {
  seedStaples();
  seedBand();
  const out = fuelIdeasForDay(undefined, { hour: 19 });
  assert.equal(out.kind, "ideas");
  const same = fuelIdeas(undefined, { hour: 19, carbsRoomG: null });
  assert.deepEqual(out.ideas.map((i) => i.key), same.ideas.map((i) => i.key));
});

test("room words name the day: another date, logged work, and no named work", () => {
  const base = { shiftKcal: 300, work: ["the long run"], openKcal: 800, carbsRoomG: 10 };
  assert.match(fuelRoomWords({ ...base, isToday: false }), /^That day's number is bigger for the long run;/);
  const logged = fuelRoomWords({ ...base, outcomeShiftKcal: 200, outcomeWork: ["the ride you logged"] });
  assert.match(logged, /^Today's number is bigger for the long run and the ride you logged;/);
  const plain = fuelRoomWords({ shiftKcal: 120, work: [], openKcal: 800, carbsRoomG: null });
  assert.match(plain, /^Today's number is bigger than your average; after one of these/);
  for (const text of [logged, plain]) assert.equal(violatesReadingGrammar(text), null, text);
  assert.equal(fuelRoomWords({ shiftKcal: 0, work: [], outcomeShiftKcal: 0, openKcal: 800, carbsRoomG: null }), null);
});

test("before the first log of the day the carbs guide's whole high is still open", async () => {
  const { dayCarbsRoomG } = await import("../dist/repo/fuel-ideas-day.js");
  seedStaples();
  seedBand();
  const morning = dayCarbsRoomG(localDateISO());
  assert.ok(morning != null && morning > 0, "the whole day is open before the first log");
  if (morning != null) assert.ok(morning >= 30, `carbs room before any log: ${morning}`);
  const out = fuelIdeasForDay(undefined, { hour: 7 });
  assert.equal(out.kind, "ideas");
});

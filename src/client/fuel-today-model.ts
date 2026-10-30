// @ts-check
// Fuel — the model (docs/V2-PLAN.md wave 2, "fuel-today"). Pure shaping from the
// server's reads (GET /api/nutrition/day, GET /api/nutrition/intake-band) to what
// Train › Intake's today card prints: today so far, protein first, as numbers with units; the
// logged meals as meal-card models; and the day's state in words.
//
// The laws it holds (CLAUDE.md "Logged intake is evidence only when the day reads
// complete"; docs/VISION.md):
//   - a day with food on it reads "in progress", never "low" (it is always today:
//     another day's food is read on that day's own page);
//   - an unknown sum prints no number (never a zero standing in for "not estimated");
//   - the energy range is the athlete's OWN observed band, spoken by the server,
//     and it is shown only when it exists — never a guessed target, never a score;
//   - the day-shape lines speak only of the day read itself.
// No DOM, no fetch, no `state`.
{
  type Day = import("../contracts/client.js").ClientDayIntake;
  type Entry = import("../contracts/client.js").ClientFoodEntry;
  type Band = import("../contracts/fuel.js").ClientIntakeBand;

  const MEAL_LABEL: Record<string, string> = {
    breakfast: "Breakfast",
    lunch: "Lunch",
    dinner: "Dinner",
    snack: "Snack",
    meal: "Meal",
  };

  const NUTRIENTS = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const;

  // The protein anchor is a goal, not a line to hit: within this many grams of it the
  // day reads "about there", never "2 g to go". Same rule as the server's ideas
  // (PROTEIN_ABOUT_THERE_G, repo/fuel-ideas.ts).
  const PROTEIN_ABOUT_THERE_G = 10;

  function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function rounded(value: unknown): number | null {
    const n = num(value);
    return n == null ? null : Math.round(n);
  }

  function positive(value: number | null): number | null {
    return value != null && value > 0 ? value : null;
  }

  function active(status: unknown): boolean {
    const s = String(status || "");
    return s === "pending" || s === "in_progress";
  }

  /** "Breakfast" for a known slot, the athlete's own label otherwise, "" for none. */
  function mealLabel(meal: unknown): string {
    const key = String(meal || "").toLowerCase();
    return MEAL_LABEL[key] || String(meal || "").trim();
  }

  // "Dinner · 9:00 PM" when a time was stated, "Dinner" when it wasn't. `eaten_at`
  // GATES and `logged_at` RENDERS: logged_at falls back to the write time, so shown
  // unconditionally it would put "8:40 AM" under a dinner remembered next morning.
  function mealMeta(entry: Record<string, unknown>): string {
    const label = mealLabel(entry.meal);
    const when = entry.eaten_at ? String(entry.logged_at || "").trim() : "";
    return [label, when].filter(Boolean).join(" · ");
  }

  /**
   * The day in words. Today with food on it is "in progress" and nothing else — a
   * partial day is absent, never "low".
   */
  function dayState(count: number): ClientFuelDayState {
    return count ? "in progress" : "nothing logged";
  }

  function macro(day: Partial<Day>, key: (typeof NUTRIENTS)[number], count: number): ClientFuelMacro {
    const known = count > 0 && day.known?.[key] !== false;
    return { value: known ? rounded(day.totals?.[key]) : null, known };
  }

  /**
   * Today so far. `band` is the observed intake band read (may be null or absent);
   * `today` is the device's local ISO date.
   */
  function todayModel(dayIn: unknown, bandIn: unknown, opts: { today: string }): ClientFuelTodayModel {
    const day = record(dayIn) as Partial<Day>;
    const band = record(bandIn) as Partial<Band>;
    const entries = Array.isArray(day.entries) ? day.entries : [];
    const count = Number(day.count) || entries.length;
    const date = String(day.date || opts.today);
    const protein = macro(day, "protein_g", count);
    // Protein comes first: the anchor the band read carries, else the day's target.
    const anchor = rounded(band.protein_anchor?.protein_g) ?? rounded(record(day.target).protein_g);
    const short = anchor != null && protein.value != null ? anchor - protein.value : null;
    // The day-shape read belongs to the day it was read for, never another one.
    const demand = day.fuel_demand && String(day.fuel_demand.date || date) === date ? day.fuel_demand : null;
    const toGo = short != null && short > PROTEIN_ABOUT_THERE_G ? short : null;
    const aboutThere = short != null && short > 0 && short <= PROTEIN_ABOUT_THERE_G;
    // The band's own sentence, only when there is a band. With too few complete days
    // there is none, and the surface stays quiet rather than guessing one.
    const bandWords = band.status === "ok" && band.band && typeof band.words === "string" ? band.words : null;
    return {
      date,
      count,
      pending: entries.filter((e) => active(e?.enrichment_status)).length,
      state: dayState(count),
      protein: { ...protein, anchor, toGo, aboutThere },
      // Energy beside the day's own number — the same target the Today glance reads.
      energy: { ...macro(day, "kcal", count), of: positive(rounded(record(day.target).kcal)) },
      carbs: macro(day, "carbs_g", count),
      fat: macro(day, "fat_g", count),
      fiber: macro(day, "fiber_g", count),
      bandWords,
      demand,
    };
  }

  /** A day entry as the food note the meal card edits ({id, parsed:{…}}). */
  function entryNote(entryIn: unknown): ClientFuelMealNote {
    const entry = record(entryIn) as Partial<Entry>;
    const parsed: Record<string, unknown> = {
      summary: entry.summary ?? "",
      ingredients: Array.isArray(entry.ingredients) ? entry.ingredients : [],
      basis: entry.basis ?? null,
      confidence: entry.confidence ?? null,
    };
    for (const key of NUTRIENTS) parsed[key] = entry[key] ?? null;
    return { id: Number(entry.id), parsed };
  }

  function mealModel(entryIn: unknown): ClientFuelMeal | null {
    const entry = record(entryIn);
    const id = Number(entry.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const pending = active(entry.enrichment_status);
    const failed = !pending && String(entry.enrichment_status || "") === "failed";
    const note = entryNote(entry);
    const rows = (globalThis as { CairnMealCardModel?: CairnMealCardModelApi }).CairnMealCardModel?.mealCardRows(note);
    const title = String(entry.summary ?? "").trim() || "Food";
    const raw = String(entry.raw ?? "").trim();
    const meal: Omit<ClientFuelMeal, "sig"> = {
      id,
      title,
      meta: mealMeta(entry),
      kcal: rounded(entry.kcal),
      protein_g: rounded(entry.protein_g),
      pending,
      failed,
      editable: !pending && !!rows && rows.length > 0,
      slot: String(entry.meal ?? "").trim(),
      raw: raw && raw !== title ? raw : "",
      note,
    };
    const sigOf = [meal.title, meal.meta, meal.slot, meal.kcal, meal.protein_g, pending, failed, note.parsed];
    return { ...meal, sig: JSON.stringify(sigOf) };
  }

  /** The day's meals in the server's order (the order they were eaten). */
  function mealModels(dayIn: unknown): ClientFuelMeal[] {
    const entries = record(dayIn).entries;
    return (Array.isArray(entries) ? entries : []).map(mealModel).filter((m): m is ClientFuelMeal => !!m);
  }

  /** "45 g protein · ~620 kcal" — protein first, the anchor; "" when neither is known. */
  function mealNumsText(totals: { kcal?: unknown; protein_g?: unknown }): string {
    const kcal = rounded(totals.kcal);
    const protein = rounded(totals.protein_g);
    return [protein == null ? "" : `${protein} g protein`, kcal == null ? "" : `~${kcal} kcal`]
      .filter(Boolean)
      .join(" · ");
  }

  const CAIRN_FUEL_TODAY_MODEL = {
    MEAL_LABEL,
    mealLabel,
    mealMeta,
    dayState,
    todayModel,
    entryNote,
    mealModel,
    mealModels,
    mealNumsText,
  };

  Object.assign(globalThis, { CairnFuelTodayModel: CAIRN_FUEL_TODAY_MODEL });
}

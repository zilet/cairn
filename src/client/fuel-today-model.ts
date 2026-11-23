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
//   - the day-shape lines speak only of the day read itself;
//   - the food guides (carbs, fat, fiber, saturated fat) are the server's ranges, floors
//     and ceilings (repo/fuel-guides.ts), never a must-hit number: while the day is eaten
//     they speak of what is left to place, never a shortfall; only a closed complete day
//     says where it landed; a partial day says nothing about landing.
// No DOM, no fetch, no `state`.
{
  type Day = import("../contracts/client.js").ClientDayIntake;
  type Entry = import("../contracts/client.js").ClientFoodEntry;
  type Band = import("../contracts/fuel.js").ClientIntakeBand;
  type Guide = import("../contracts/fuel.js").ClientFuelGuide;

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

  // ---------- the day's food guides ----------
  // The words, the track and which guides the card shows (`on_card`) arrive finished from
  // the server (repo/fuel-guides.ts). A read with no guides (an older cached payload)
  // keeps the bare numbers as rows with no guide.
  function guidesModel(day: Partial<Day>, date: string, count: number): ClientFuelGuidesModel | null {
    const read = day.guides;
    const row = (key: string, label: string, eaten: number | null, g?: Guide): ClientFuelGuideRow => ({
      key,
      label,
      eaten,
      text: String(g?.text || ""),
      note: String(g?.note || ""),
      track: g?.track || null,
      why: g?.why?.effect ? g.why : null,
    });
    if (!read || !Array.isArray(read.guides) || String(read.date || date) !== date) {
      const bare = (key: "carbs_g" | "fat_g" | "fiber_g", label: string) =>
        row(key.slice(0, -2), label, macro(day, key, count).value);
      return count
        ? { rows: [bare("carbs_g", "Carbs"), bare("fat_g", "Fat"), bare("fiber_g", "Fiber")], weekly: [], explain: [], pattern: null }
        : null;
    }
    return {
      rows: read.guides.filter((g) => g.on_card && g.text).map((g) => row(g.key, g.label, rounded(g.eaten_g), g)),
      weekly: read.guides.filter((g) => g.kind === "weekly" && g.words).map((g) => String(g.words)),
      explain: Array.isArray(read.explain) ? read.explain.filter((e) => e?.effect) : [],
      pattern: read.pattern && Array.isArray(read.pattern.lines) && read.pattern.lines.length ? read.pattern : null,
    };
  }

  // Energy beside the DAY's number (the server lays it over the weekly average and says
  // why in `day_words`), and what is left of it, rounded to ten because the meals behind
  // it are estimates. `left` is null with nothing to set it against, or an unknown sum.
  function energyModel(day: Partial<Day>, count: number): ClientFuelTodayModel["energy"] {
    const m = macro(day, "kcal", count);
    const target = record(day.target);
    const of = positive(rounded(target.kcal));
    const eaten = count ? m.value : 0;
    const left = of != null && eaten != null ? Math.round((of - eaten) / 10) * 10 : null;
    return { ...m, of, dayWords: typeof target.day_words === "string" && target.day_words ? target.day_words : null, left };
  }

  // ---------- the week's fuel ----------
  // The seven days the day's number belongs to (GET /nutrition/day `fuel_week`,
  // repo/fuel-week.ts), shaped for the strip under the energy meter. Each bar is the day's
  // move from the average, drawn from the average line up (more) or down (less) on ONE
  // scale: the larger of the cap a day can move (15% of the average), the week's largest
  // move and the furthest a complete logged day sat from it, so nothing is ever clipped. A
  // logged amount is a fact beside the bar (`tick`), never a grade: no tone, no percentage.
  // Absent on an older read, a read dated another week, or a malformed one.
  const WEEKDAY_LONG: Record<string, string> = {
    Mon: "Monday",
    Tue: "Tuesday",
    Wed: "Wednesday",
    Thu: "Thursday",
    Fri: "Friday",
    Sat: "Saturday",
    Sun: "Sunday",
  };
  const WEEK_SCALE_SHARE = 0.15;

  const kcalText = (n: number): string => (Math.round(n / 10) * 10).toLocaleString("en-US");

  function fuelWeekModel(day: Partial<Day>, date: string): ClientFuelWeekModel | null {
    const read = day.fuel_week;
    const average = positive(rounded(read?.average_kcal));
    if (!read || average == null || !Array.isArray(read.days) || read.days.length !== 7) return null;
    if (!read.days.some((d) => String(d?.date) === date)) return null;
    const rows = read.days.map((d) => ({
      d,
      kcal: rounded(d?.kcal) ?? average,
      logged: d?.when === "ahead" ? null : rounded(d?.logged_kcal),
    }));
    const scale = Math.max(
      average * WEEK_SCALE_SHARE,
      ...rows.map((r) => Math.abs(r.kcal - average)),
      ...rows.map((r) => (r.logged == null ? 0 : Math.abs(r.logged - average)))
    );
    const frac = (n: number): number => Math.max(-1, Math.min(1, (n - average) / scale));
    const avg = kcalText(average);
    const days = rows.map(({ d, kcal, logged }): ClientFuelWeekDayModel => {
      const when: ClientFuelWeekDayModel["when"] = d.when === "past" || d.when === "today" ? d.when : "ahead";
      const name = WEEKDAY_LONG[String(d.weekday)] || String(d.weekday || "");
      const work = [...(Array.isArray(d.work) ? d.work : []), ...(Array.isArray(d.outcome_work) ? d.outcome_work : [])]
        .map(String)
        .filter(Boolean);
      // At the average the server says nothing; the strip still says where the day sits.
      const fallback =
        when === "today"
          ? `Today sits at the week's ${avg} average.`
          : when === "past"
            ? `That day sat at the week's ${avg} average.`
            : `This day sits at the week's ${avg} average.`;
      const label = [
        `${name}${when === "today" ? ", today" : when === "ahead" ? ", ahead" : ""}: ${kcal.toLocaleString("en-US")} kcal`,
        work.length ? `for ${work.join(" and ")}` : "",
        logged != null ? `about ${kcalText(logged)} logged` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return {
        date: String(d.date),
        weekday: String(d.weekday || ""),
        name,
        tag: String(d.tag || ""),
        kcal,
        when,
        bar: frac(kcal),
        tick: logged == null ? null : frac(logged),
        words: typeof d.words === "string" && d.words ? d.words : fallback,
        logged: logged == null ? null : `About ${kcalText(logged)} kcal logged.`,
        label,
      };
    });
    return {
      average,
      words: String(read.words || ""),
      sumWords: String(read.sum_words || ""),
      today: days.find((d) => d.when === "today")?.date ?? date,
      days,
    };
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
      energy: energyModel(day, count),
      carbs: macro(day, "carbs_g", count),
      fat: macro(day, "fat_g", count),
      fiber: macro(day, "fiber_g", count),
      bandWords,
      demand,
      guides: guidesModel(day, date, count),
      week: fuelWeekModel(day, date),
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

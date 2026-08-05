// @ts-check
// Plan -> Meals day-fuel review renderer.

type DayFuelEntry = {
  id?: unknown;
  summary?: unknown;
  meal?: unknown;
  eaten_at?: unknown;
  logged_at?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
  enrichment_status?: unknown;
};

type DayFuelDemandData = {
  date?: unknown;
  demand?: unknown;
  drivers?: unknown;
};

type DayFuelData = {
  date?: unknown;
  fuel_demand?: DayFuelDemandData | null;
  count?: unknown;
  totals?: {
    kcal?: unknown;
    protein_g?: unknown;
    carbs_g?: unknown;
    fat_g?: unknown;
    fiber_g?: unknown;
  } | null;
  known?: Partial<Record<"kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g", boolean>> | null;
  remaining?: {
    kcal?: unknown;
    protein_g?: unknown;
  } | null;
  target?: unknown;
  entries?: DayFuelEntry[] | null;
};

(() => {
  const MEAL_LABEL: Record<string, string> = {
    breakfast: "Breakfast",
    lunch: "Lunch",
    dinner: "Dinner",
    snack: "Snack",
    meal: "Meal",
  };

  function mealLabelHtml(meal: unknown): string {
    const key = String(meal || "").toLowerCase();
    return MEAL_LABEL[key] || (meal ? escHtml(meal) : "");
  }

  // "Dinner · 9:00 PM" when the time is known, plain "Dinner" when it isn't, and
  // nothing at all when neither is. A missing time leaves no trace — no dash, no
  // blank slot, no "add a time" — because not remembering when you ate is normal
  // and this line is a memory, never a prompt to complete something. Most entries
  // will never carry a time, so that is the case this has to look right in first.
  //
  // `eaten_at` GATES and `logged_at` RENDERS, deliberately. logged_at falls back to
  // the WRITE time when nothing was stated, so showing it unconditionally would put
  // "8:40 AM" under a dinner that was remembered the next morning — the exact
  // confusion this feature exists to remove. eaten_at is the only honest signal that
  // a time was actually stated; whenever it is set, logged_at is that same time,
  // already localized by the one formatter on the server.
  function mealMetaHtml(entry: DayFuelEntry): string {
    const meal = mealLabelHtml(entry.meal);
    const when = entry.eaten_at ? String(entry.logged_at || "").trim() : "";
    if (!meal && !when) return "";
    const text = meal && when ? `${meal} &middot; ${escHtml(when)}` : meal || escHtml(when);
    return `<span class="dayfuel-meal lbl">${text}</span>`;
  }

  // ---------- the big-day fuel line ----------
  // A flat daily target lands the same on a long-run day and a rest day. When the
  // server's deterministic read (repo/fuel-demand.ts) says today carries the week's
  // bigger work, the card says ONE quiet sentence about shape — carbs toward the work.
  //
  // Three rules hold this line in place:
  //   • BIG DAYS ONLY. A standard or light day says nothing new; most days are silent.
  //   • TODAY ONLY. Yesterday's card must never carry a line about fueling work that is
  //     already done — that is a verdict on what they ate, which the nutrition laws
  //     forbid. The read is forward-looking or it is absent.
  //   • The TARGET DOES NOT MOVE. Every variant says so. The accepted number stays
  //     authoritative; this is a note about the shape of the day, not a new number.
  // The sentence rotates per date so a stable week doesn't print one literal for days.
  const DEMAND_LONG_RUN = [
    "Today carries the long run — carbs earn their place around it. The target itself stays where it is.",
    "The long run is today's big piece; carb-forward around it tends to sit well. Same target, different shape.",
    "Long run today — a good day for carbs to lead, with the daily target unchanged.",
    "Today's long run is the work that asks for fuel; carbs around it, and the number stays as it is.",
  ];
  const DEMAND_QUALITY_RUN = [
    "There's quality running in today — carbs around it tend to make it feel better. The target itself doesn't move.",
    "Today's fast work asks a little more of fuel; carb-forward around it, same daily target.",
    "Quality run today — a good day for carbs to lead, with the target unchanged.",
    "Hard running lands today; carbs around it is the natural shape, and the number stays as it is.",
  ];
  const DEMAND_HEAVY_LOWER = [
    "Heavy lower work today — carbs around it are the easy win. The target stays where it is.",
    "Today leans heavy through the legs; carb-forward around the session, same daily target.",
    "Legs carry today's load — a good day for carbs to lead, with the target unchanged.",
    "Today's the heavier leg day; carbs around it, and the number stays as it is.",
  ];
  const DEMAND_DOUBLE = [
    "Lifting and running both land today — carbs around them, with the target unchanged.",
    "Today's a double; carb-forward around both pieces, same daily target.",
    "Two sessions share today — a good day for carbs to lead. The target stays where it is.",
    "Strength and a run in one day; carbs around the work, and the number stays as it is.",
  ];
  const DEMAND_GENERIC = [
    "Today carries more work than an ordinary day — a good day for carbs to lead, with the target unchanged.",
    "Bigger day than usual; carb-forward around the work, same daily target.",
    "There's real work in today — carbs around it. The target stays where it is.",
    "Today asks a bit more of fuel; carbs toward the work, and the number stays as it is.",
  ];

  function demandVariants(drivers: string[]): string[] {
    const has = (needle: string) => drivers.some((driver) => driver.includes(needle));
    if (has("long run")) return DEMAND_LONG_RUN;
    if (has("quality run")) return DEMAND_QUALITY_RUN;
    if (has("heavy lower")) return DEMAND_HEAVY_LOWER;
    if (has("same day")) return DEMAND_DOUBLE;
    return DEMAND_GENERIC;
  }

  function dayFuelDemandHtml(day: DayFuelData): string {
    const demand = day.fuel_demand;
    if (!demand || String(demand.demand || "") !== "big") return "";
    const date = String(demand.date || day.date || "");
    if (!date || date !== localISO()) return "";
    const drivers = Array.isArray(demand.drivers) ? demand.drivers.map((driver) => String(driver)) : [];
    const line = pickDayVariant(demandVariants(drivers), date, "dayfuel-demand");
    return `<div class="dayfuel-demand">${escHtml(line)}</div>`;
  }

  function macroValue(value: unknown): number | null {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : null;
  }

  function knownMacro(
    day: DayFuelData,
    key: "kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g",
    value: unknown
  ): number | null {
    return day.known?.[key] === false ? null : macroValue(value);
  }

  function totalHtml(value: number | null, label: string): string {
    return value == null
      ? `<span><b class="numeral numeral-lg">&mdash;</b><small>${label}</small></span>`
      : `<span><b class="numeral numeral-lg" data-cu="${value}">0</b><small>${label}</small></span>`;
  }

  function dayFuelHtml(day: DayFuelData | null | undefined): string {
    const d = day || {};
    const t = d.totals || {};
    const count = Number(d.count) || 0;
    const kcal = knownMacro(d, "kcal", t.kcal);
    const protein = knownMacro(d, "protein_g", t.protein_g);
    const carbs = knownMacro(d, "carbs_g", t.carbs_g);
    const fat = knownMacro(d, "fat_g", t.fat_g);
    const fiber = knownMacro(d, "fiber_g", t.fiber_g);
    const head = `<div class="dayfuel-head"><span class="lbl">Today's fuel</span>${count ? `<span class="dayfuel-count">${count} item${count === 1 ? "" : "s"}</span>` : ""}</div>`;
    if (!count) {
      return `<div class="dayfuel reveal" style="--i:0">${head}
          <div class="dayfuel-empty">Nothing logged yet today &mdash; log a meal in <button class="linkbtn linkbtn-plain" id="dayFuelAsk" type="button">Chat</button>; describe it in plain words and the macros are handled for you.</div>
          ${dayFuelDemandHtml(d)}
        </div>`;
    }

    let remLine = "";
    if (d.remaining && d.target) {
      const left = d.known?.kcal === false ? null : macroValue(d.remaining.kcal);
      const pleft = d.known?.protein_g === false ? null : macroValue(d.remaining.protein_g);
      remLine =
        left == null
          ? ""
          : left > 0
            ? `<div class="dayfuel-rem"><span class="numeral" data-cu="${left}">0</span> kcal left${pleft != null && pleft > 0 ? ` &middot; ${pleft} g protein to go` : ""}</div>`
            : `<div class="dayfuel-rem dayfuel-rem-done">Fuel's in for today.</div>`;
    }

    const rows = (d.entries || [])
      .map((entry) => {
        const id = entry.id == null ? "" : String(entry.id);
        const summary = entry.summary == null ? "" : String(entry.summary);
        const k = macroValue(entry.kcal);
        const p = macroValue(entry.protein_g);
        const meta = mealMetaHtml(entry);
        const pending = entry.enrichment_status === "pending" || entry.enrichment_status === "in_progress";
        return `<button class="dayfuel-row" data-fooditem="${escAttr(id)}" type="button">
          <span class="dayfuel-art">${art("food", summary)}</span>
          <span class="dayfuel-main">
            <span class="dayfuel-name">${escHtml(summary)}${pending ? ` <span class="dayfuel-pending">&middot; estimating&hellip;</span>` : ""}</span>
            ${meta}
          </span>
          <span class="dayfuel-macros">${k != null ? `<span class="numeral">${k}</span> kcal` : "&mdash;"}${p != null ? ` &middot; ${p}g P` : ""}</span>
          <span class="dayfuel-edit" aria-hidden="true">&#9998;</span>
        </button>`;
      })
      .join("");

    return `<div class="dayfuel reveal" style="--i:0">${head}
        <div class="dayfuel-totals" aria-label="${escAttr(`${kcal ?? "unknown"} kcal, ${protein ?? "unknown"} grams protein, ${carbs ?? "unknown"} grams carbohydrate, ${fat ?? "unknown"} grams fat, ${fiber ?? "unknown"} grams fiber`)}">
          ${totalHtml(kcal, "kcal")}
          ${totalHtml(protein, "protein g")}
          ${totalHtml(carbs, "carbs g")}
          ${totalHtml(fat, "fat g")}
          ${totalHtml(fiber, "fiber g")}
        </div>
        ${remLine}
        ${dayFuelDemandHtml(d)}
        <div class="dayfuel-list">${rows}</div>
        <div class="dayfuel-foot"><span class="lbl">Tap an item to fix it &middot; log more in Chat</span>
          <button class="linkbtn linkbtn-quiet linkbtn-sm" id="dayFuelProgress" type="button">See the multi-week intake read →</button></div>
      </div>`;
  }

  const CAIRN_DAY_FUEL = {
    MEAL_LABEL,
    mealLabelHtml,
    dayFuelHtml,
    dayFuelDemandHtml,
  };

  Object.assign(globalThis, {
    CairnDayFuel: CAIRN_DAY_FUEL,
    MEAL_LABEL,
    dayFuelHtml,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnDayFuel: CAIRN_DAY_FUEL,
      MEAL_LABEL,
      dayFuelHtml,
    });
  }
})();

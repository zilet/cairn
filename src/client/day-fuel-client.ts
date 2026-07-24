// @ts-check
// Plan -> Meals day-fuel review renderer.

type DayFuelEntry = {
  id?: unknown;
  summary?: unknown;
  meal?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
  enrichment_status?: unknown;
};

type DayFuelData = {
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
        const ml = mealLabelHtml(entry.meal);
        const pending = entry.enrichment_status === "pending" || entry.enrichment_status === "in_progress";
        return `<button class="dayfuel-row" data-fooditem="${escAttr(id)}" type="button">
          <span class="dayfuel-art">${art("food", summary)}</span>
          <span class="dayfuel-main">
            <span class="dayfuel-name">${escHtml(summary)}${pending ? ` <span class="dayfuel-pending">&middot; estimating&hellip;</span>` : ""}</span>
            ${ml ? `<span class="dayfuel-meal lbl">${ml}</span>` : ""}
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
        <div class="dayfuel-list">${rows}</div>
        <div class="dayfuel-foot"><span class="lbl">Tap an item to fix it &middot; log more in Chat</span>
          <button class="linkbtn linkbtn-quiet linkbtn-sm" id="dayFuelProgress" type="button">See the multi-week intake read →</button></div>
      </div>`;
  }

  const CAIRN_DAY_FUEL = {
    MEAL_LABEL,
    mealLabelHtml,
    dayFuelHtml,
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

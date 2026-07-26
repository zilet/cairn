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

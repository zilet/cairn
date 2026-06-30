(() => {
// @ts-check
// Plan -> Meals day-fuel review renderer.
(() => {
    const MEAL_LABEL = {
        breakfast: "Breakfast",
        lunch: "Lunch",
        dinner: "Dinner",
        snack: "Snack",
        meal: "Meal",
    };
    function mealLabelHtml(meal) {
        const key = String(meal || "").toLowerCase();
        return MEAL_LABEL[key] || (meal ? escHtml(meal) : "");
    }
    function dayFuelHtml(day) {
        const d = day || {};
        const t = d.totals || {};
        const count = Number(d.count) || 0;
        const kcal = Math.round(Number(t.kcal) || 0);
        const protein = Math.round(Number(t.protein_g) || 0);
        const head = `<div class="dayfuel-head"><span class="lbl">Today's fuel</span>${count ? `<span class="dayfuel-count">${count} item${count === 1 ? "" : "s"}</span>` : ""}</div>`;
        if (!count) {
            return `<div class="dayfuel reveal" style="--i:0">${head}
          <div class="dayfuel-empty">Nothing logged yet today &mdash; log a meal in <button class="linklike" id="dayFuelAsk" type="button">Chat</button>; describe it in plain words and the macros are handled for you.</div>
        </div>`;
        }
        let remLine = "";
        if (d.remaining && d.target) {
            const left = Math.round(Number(d.remaining.kcal));
            const pleft = Math.round(Number(d.remaining.protein_g));
            remLine = left > 0
                ? `<div class="dayfuel-rem"><span class="numeral" data-cu="${left}">0</span> kcal left${pleft > 0 ? ` &middot; ${pleft} g protein to go` : ""}</div>`
                : `<div class="dayfuel-rem dayfuel-rem-done">Fuel's in for today.</div>`;
        }
        const rows = (d.entries || []).map((entry) => {
            const id = entry.id == null ? "" : String(entry.id);
            const summary = entry.summary == null ? "" : String(entry.summary);
            const k = Math.round(Number(entry.kcal) || 0);
            const p = Math.round(Number(entry.protein_g) || 0);
            const ml = mealLabelHtml(entry.meal);
            const pending = entry.enrichment_status === "pending" || entry.enrichment_status === "in_progress";
            return `<button class="dayfuel-row" data-fooditem="${escAttr(id)}" type="button">
          <span class="dayfuel-art">${art("food", summary)}</span>
          <span class="dayfuel-main">
            <span class="dayfuel-name">${escHtml(summary)}${pending ? ` <span class="dayfuel-pending">&middot; estimating&hellip;</span>` : ""}</span>
            ${ml ? `<span class="dayfuel-meal lbl">${ml}</span>` : ""}
          </span>
          <span class="dayfuel-macros">${entry.kcal != null ? `<span class="numeral">${k}</span> kcal` : "&mdash;"}${entry.protein_g != null ? ` &middot; ${p}g P` : ""}</span>
          <span class="dayfuel-edit" aria-hidden="true">&#9998;</span>
        </button>`;
        }).join("");
        return `<div class="dayfuel reveal" style="--i:0">${head}
        <div class="dayfuel-totals">
          <span class="numeral numeral-lg" data-cu="${kcal}">0</span><span class="dayfuel-unit">kcal</span>
          <span class="dayfuel-dot" aria-hidden="true">&middot;</span>
          <span class="numeral numeral-lg" data-cu="${protein}">0</span><span class="dayfuel-unit">g protein</span>
        </div>
        ${remLine}
        <div class="dayfuel-list">${rows}</div>
        <div class="dayfuel-foot lbl">Tap an item to fix it &middot; log more in Chat</div>
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
})();

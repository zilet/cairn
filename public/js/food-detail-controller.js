(() => {
// @ts-check
// Food note detail modal controller: food-note detail rendering and removal.
(() => {
    function foodDetailRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function foodDetailString(value, fallback = "") {
        return typeof value === "string" ? value : fallback;
    }
    function foodDetailNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }
    async function openFoodDetail(note, fromTile, deps) {
        const row = foodDetailRecord(note);
        const parsed = deps.foodNote.parsedNote(row);
        const text = row.raw || row.raw_text || row.raw_output || "";
        const title = (parsed && parsed.summary) || deps.foodNote.foodTitleFromIngredients(parsed) || text || "Food note";
        const kcal = deps.foodNum(parsed?.kcal) || 0;
        const macros = parsed ? [["Protein", parsed.protein_g], ["Carbs", parsed.carbs_g], ["Fat", parsed.fat_g], ["Fiber", parsed.fiber_g]]
            .filter(([, value]) => value != null && value !== "" && !Number.isNaN(Number(value))) : [];
        const maxG = Math.max(1, ...macros.map(([, value]) => Number(value)));
        const ingredients = deps.foodNote.foodIngredients(parsed);
        const items = ingredients.length ? ingredients.map((ingredient) => deps.foodNote.ingredientLabel(ingredient)).join(", ") : deps.foodNote.foodItemsText(parsed);
        const time = foodDetailString(row.created_at).slice(11, 16);
        if (kcal && !deps.state._goal) {
            try {
                deps.state._goal = foodDetailRecord(await deps.api("/goal"));
            }
            catch {
                deps.state._goal = null;
            }
        }
        const target = foodDetailNumber(foodDetailRecord(deps.state._goal?.recommended).target_intake_kcal);
        const ctxBits = [];
        if (kcal && target)
            ctxBits.push(`${Math.round((kcal / target) * 100)}% of the day`);
        if (time)
            ctxBits.push(time);
        const query = String(text || title || "Food note");
        const svg = deps.art("food", query);
        const photoSrc = deps.artEnabled() && query
            ? deps.withToken(`/api/art?kind=food&q=${encodeURIComponent(String(query).trim().slice(0, 120))}`)
            : "";
        deps.openDetailFrom(fromTile, () => {
            const el = deps.mountDetail(`
      <div class="detail-art"><div class="detail-art-zoom">${deps.artImg("food", query, "artile-xl", svg)}</div></div>
      <h2 class="detail-title">${deps.escapeHtml(title)}</h2>
      ${items ? `<div class="detail-items">${deps.escapeHtml(items)}</div>` : ""}
      ${kcal ? `<div class="detail-kcal"><span class="numeral detail-num" data-cu="${kcal}">0</span><span class="detail-unit lbl">cal</span></div>` : ""}
      ${ctxBits.length ? `<div class="detail-ctx lbl">${deps.escapeHtml(ctxBits.join(" · "))}</div>` : ""}
      ${macros.length ? `<div class="detail-macros">${macros.map(([label, value]) => `
        <div class="macrobar">
          <div class="macrobar-top"><span class="lbl">${label}</span><span class="macrobar-val">${deps.escapeHtml(deps.formatFoodNum(value))}g</span></div>
          <div class="macrobar-track"><div class="macrobar-fill barfill" style="width:${Math.max(3, Math.round((Number(value) / maxG) * 100))}%"></div></div>
        </div>`).join("")}</div>` : ""}
      ${ingredients.length ? `<div class="detail-section"><div class="lbl">Ingredients</div><div class="ing-breakdown">${ingredients.map((ingredient) => `
        <div class="ing-row">
          <div class="ing-main">
            <span>${deps.escapeHtml(ingredient.item)}</span>
            ${ingredient.amount ? `<small>${deps.escapeHtml(ingredient.amount)}</small>` : ""}
          </div>
          <div class="ing-nutri">${deps.escapeHtml(deps.foodNote.foodMacroText(ingredient, { kcal: true, short: true }) || "estimated")}</div>
        </div>`).join("")}</div></div>` : ""}
      ${text && text !== title ? `<div class="detail-section"><div class="lbl">As logged</div><div class="detail-body">“${deps.escapeHtml(text)}”</div></div>` : ""}
      ${parsed?.notes ? `<div class="detail-section"><div class="detail-body" style="color:var(--muted)">${deps.escapeHtml(parsed.notes)}</div></div>` : ""}
      <div class="detail-actions">
        <button class="pillbtn pill-warn" data-remove>Remove</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`, photoSrc);
            deps.runCountUps(el);
            deps.wireDetailCommon();
            el.querySelector("[data-remove]")?.addEventListener("click", async () => {
                try {
                    const result = foodDetailRecord(await deps.api(`/food-notes/${row.id}`, { method: "DELETE" }));
                    if (result && result.error)
                        throw new Error(String(result.error));
                    deps.toast("Removed");
                    deps.closeDetail(true);
                    document.querySelector(`.fnent[data-noteid="${row.id}"]`)?.remove();
                }
                catch {
                    deps.toast("Couldn't remove");
                }
            });
        });
    }
    const CAIRN_FOOD_DETAIL_CONTROLLER = {
        openFoodDetail,
    };
    Object.assign(globalThis, { CairnFoodDetailController: CAIRN_FOOD_DETAIL_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnFoodDetailController = CAIRN_FOOD_DETAIL_CONTROLLER;
    }
})();
})();

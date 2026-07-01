// @ts-check
// Plan -> Food day-fuel load/edit controller.

type DayFuelControllerDay = import("../contracts/client.js").ClientDayIntake;
type DayFuelControllerEntry = import("../contracts/client.js").ClientFoodEntry;

type DayFuelControllerOptions = {
  root?: ParentNode | null | undefined;
  isCurrent?: (token: number) => boolean;
  onRerender?: () => unknown;
  onAsk?: () => unknown;
};

(() => {
  const DAY_FUEL_ASK = "How's my eating shaping up today, and does it fit my goal?";

  function fuelRoot(options: DayFuelControllerOptions = {}): ParentNode {
    return options.root || view;
  }

  function fuelStillCurrent(token: number, root: ParentNode, options: DayFuelControllerOptions): boolean {
    if (options.isCurrent) return options.isCurrent(token);
    return Boolean(root.querySelector("#dayFuelSlot"));
  }

  function fuelNumberOrNull(value: unknown): number | null {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function fuelInputValue(el: HTMLElement, selector: string): string {
    return el.querySelector<HTMLInputElement>(selector)?.value || "";
  }

  function fuelMealOptions(entry: DayFuelControllerEntry): string {
    return ["breakfast", "lunch", "dinner", "snack", "meal"].map((meal) => {
      const selected = String(entry.meal || "").toLowerCase() === meal ? "selected" : "";
      return `<option value="${meal}" ${selected}>${CairnDayFuel.MEAL_LABEL[meal]}</option>`;
    }).join("");
  }

  async function loadDayFuel(token: number, options: DayFuelControllerOptions = {}): Promise<void> {
    const root = fuelRoot(options);
    const slot = root.querySelector("#dayFuelSlot");
    if (!slot) return;
    const qs = state.logDate ? `?date=${encodeURIComponent(state.logDate)}` : "";
    let response: unknown = null;
    try {
      response = await api("/nutrition/day" + qs);
    } catch {
      slot.innerHTML = "";
      return;
    }
    if (!fuelStillCurrent(token, root, options)) return;
    if (!response || typeof response !== "object") {
      slot.innerHTML = "";
      return;
    }
    const day = response as DayFuelControllerDay;
    state._dayFuel = day;
    slot.innerHTML = CairnDayFuel.dayFuelHtml(day as unknown as Record<string, unknown>);
    runCountUps(slot);
    slot.querySelectorAll<HTMLElement>("[data-fooditem]").forEach((row) =>
      row.addEventListener("click", () => openFoodEdit(Number(row.dataset.fooditem), row, options))
    );
    slot.querySelector("#dayFuelAsk")?.addEventListener("click", () => {
      if (options.onAsk) options.onAsk();
      else gotoChatWith(DAY_FUEL_ASK);
    });
  }

  function openFoodEdit(id: number, fromEl: Element, options: DayFuelControllerOptions = {}): void {
    const day = state._dayFuel as DayFuelControllerDay | null | undefined;
    const entry = day && Array.isArray(day.entries) ? day.entries.find((item) => item.id === id) : null;
    if (!entry) return;
    openDetailFrom(fromEl, () => {
      const el = mountDetail(`
        <h2 class="detail-title">Edit this meal</h2>
        <div class="detail-ctx lbl">correct what was logged &middot; macros are rough &mdash; fix anything off</div>
        <div class="field"><label>Description</label>
          <input id="fedSummary" type="text" value="${escAttr(entry.summary || "")}" maxlength="200"></div>
        <div class="field"><label>Meal</label>
          <select id="fedMeal">${fuelMealOptions(entry)}</select></div>
        <div class="fed-macros">
          <div class="field"><label>kcal</label><input id="fedKcal" type="number" inputmode="numeric" value="${entry.kcal ?? ""}"></div>
          <div class="field"><label>protein (g)</label><input id="fedProtein" type="number" inputmode="numeric" value="${entry.protein_g ?? ""}"></div>
          <div class="field"><label>carbs (g)</label><input id="fedCarbs" type="number" inputmode="numeric" value="${entry.carbs_g ?? ""}"></div>
          <div class="field"><label>fat (g)</label><input id="fedFat" type="number" inputmode="numeric" value="${entry.fat_g ?? ""}"></div>
        </div>
        <div class="detail-actions">
          <button class="pillbtn pill-accent" id="fedSave">Save</button>
          <button class="pillbtn" data-close>Close</button>
          <button class="pillbtn" id="fedDel">Delete</button>
        </div>`);
      wireDetailCommon();
      el.querySelector("#fedSave")?.addEventListener("click", async () => {
        const meal = el.querySelector<HTMLSelectElement>("#fedMeal");
        const body = {
          summary: fuelInputValue(el, "#fedSummary").trim(),
          meal: meal?.value || "meal",
          kcal: fuelNumberOrNull(fuelInputValue(el, "#fedKcal")),
          protein_g: fuelNumberOrNull(fuelInputValue(el, "#fedProtein")),
          carbs_g: fuelNumberOrNull(fuelInputValue(el, "#fedCarbs")),
          fat_g: fuelNumberOrNull(fuelInputValue(el, "#fedFat")),
        };
        try {
          await api(`/food-notes/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          toast("Updated");
        } catch {
          toast("Couldn't save");
          return;
        }
        swrInvalidate("progress:energy");
        closeDetail(true);
        options.onRerender?.();
      });
      const del = el.querySelector("#fedDel");
      if (del) del.addEventListener("click", () => armDelete(del, async () => {
        try {
          await api(`/food-notes/${id}`, { method: "DELETE" });
          toast("Removed");
        } catch {
          toast("Couldn't remove");
          return;
        }
        swrInvalidate("progress:energy");
        closeDetail(true);
        options.onRerender?.();
      }));
    });
  }

  const CAIRN_DAY_FUEL_CONTROLLER = {
    loadDayFuel,
    openFoodEdit,
  };

  Object.assign(globalThis, { CairnDayFuelController: CAIRN_DAY_FUEL_CONTROLLER });
  if (typeof window !== "undefined") window.CairnDayFuelController = CAIRN_DAY_FUEL_CONTROLLER;
})();

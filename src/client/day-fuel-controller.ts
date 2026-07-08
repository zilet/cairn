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
  const EMPTY_TOTALS = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };

  function dayFuelCacheKey(): string {
    return `food:day:${state.logDate || "today"}`;
  }

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

  function renderDayFuel(token: number, day: DayFuelControllerDay, options: DayFuelControllerOptions = {}): void {
    const root = fuelRoot(options);
    const slot = root.querySelector("#dayFuelSlot");
    if (!slot) return;
    if (!fuelStillCurrent(token, root, options)) return;
    if (!day || typeof day !== "object") {
      slot.innerHTML = "";
      return;
    }
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

  async function loadDayFuel(token: number, options: DayFuelControllerOptions = {}): Promise<void> {
    const root = fuelRoot(options);
    const slot = root.querySelector("#dayFuelSlot");
    if (!slot) return;
    const qs = state.logDate ? `?date=${encodeURIComponent(state.logDate)}` : "";
    const key = dayFuelCacheKey();
    const peek = peekCached<DayFuelControllerDay>(key);
    const result = await paintSWR({
      key,
      path: "/nutrition/day" + qs,
      peek,
      token,
      tab: null,
      render: (day) => renderDayFuel(token, day as DayFuelControllerDay, options),
    });
    if (!result && !peek && fuelStillCurrent(token, root, options)) slot.innerHTML = "";
  }

  function withFuelEntry(day: DayFuelControllerDay | null, id: number, patch: Partial<DayFuelControllerEntry> | null): DayFuelControllerDay {
    const base = day || state._dayFuel as DayFuelControllerDay | null | undefined || {
      date: state.logDate || "",
      totals: { ...EMPTY_TOTALS },
      entries: [],
      count: 0,
      target: null,
      remaining: null,
    };
    const entries = Array.isArray(base.entries) ? base.entries : [];
    const prior = entries.find((item) => item.id === id) || null;
    const nextEntries = patch === null
      ? entries.filter((item) => item.id !== id)
      : entries.map((item) => item.id === id ? { ...item, ...patch } : item);
    const delta = (key: "kcal" | "protein_g" | "carbs_g" | "fat_g" | "fiber_g") =>
      (patch === null ? 0 : Number(patch[key] ?? prior?.[key] ?? 0)) - Number(prior?.[key] ?? 0);
    const totals = { ...EMPTY_TOTALS, ...(base.totals || {}) };
    for (const key of ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const) {
      totals[key] = Number(totals[key] || 0) + delta(key);
    }
    const remaining = base.remaining
      ? {
          ...base.remaining,
          kcal: Number(base.remaining.kcal || 0) - delta("kcal"),
          protein_g: Number(base.remaining.protein_g || 0) - delta("protein_g"),
        }
      : base.remaining;
    return { ...base, entries: nextEntries, count: nextEntries.length, totals, remaining };
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
          await optimisticMutation<DayFuelControllerDay>({
            key: dayFuelCacheKey(),
            apply: (current) => withFuelEntry(current, id, body),
            rollback: state._dayFuel as DayFuelControllerDay,
            request: () => api(`/food-notes/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
            onChange: (day) => renderDayFuel(0, day, { ...options, isCurrent: () => true }),
          });
          toast("Updated");
        } catch {
          toast("Couldn't save");
          return;
        }
        swrInvalidate("progress:energy");
        closeDetail(true);
      });
      const del = el.querySelector("#fedDel");
      if (del) del.addEventListener("click", () => armDelete(del, async () => {
        try {
          await optimisticMutation<DayFuelControllerDay>({
            key: dayFuelCacheKey(),
            apply: (current) => withFuelEntry(current, id, null),
            rollback: state._dayFuel as DayFuelControllerDay,
            request: () => api(`/food-notes/${id}`, { method: "DELETE" }),
            onChange: (day) => renderDayFuel(0, day, { ...options, isCurrent: () => true }),
          });
          toast("Removed");
        } catch {
          toast("Couldn't remove");
          return;
        }
        swrInvalidate("progress:energy");
        closeDetail(true);
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

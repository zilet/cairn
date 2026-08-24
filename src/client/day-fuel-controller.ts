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
  const EMPTY_KNOWN = { kcal: false, protein_g: false, carbs_g: false, fat_g: false, fiber_g: false };
  // Ids we already have a live enrichment watcher for — one per pending food note,
  // cleared when the watch resolves, so a re-render never opens a duplicate stream.
  const _fuelWatched = new Set<number>();

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
    return ["breakfast", "lunch", "dinner", "snack", "meal"]
      .map((meal) => {
        const selected = String(entry.meal || "").toLowerCase() === meal ? "selected" : "";
        return `<option value="${meal}" ${selected}>${CairnDayFuel.MEAL_LABEL[meal]}</option>`;
      })
      .join("");
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
    slot
      .querySelectorAll<HTMLElement>("[data-fooditem]")
      .forEach((row) => row.addEventListener("click", () => openFoodEdit(Number(row.dataset.fooditem), row, options)));
    slot.querySelector("#dayFuelAsk")?.addEventListener("click", () => {
      if (options.onAsk) options.onAsk();
      else gotoChatWith(DAY_FUEL_ASK);
    });
    slot.querySelector("#dayFuelProgress")?.addEventListener("click", () => {
      state.progressSeg = "intake";
      activateTab("progress");
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
    watchFuelPending(token, options);
  }

  function fuelMacroValue(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  // A just-logged food note enriches in the background; its Fuel row shows an
  // "· estimating…" badge until the macros land. Watch each still-pending entry
  // (SSE-first, poll fallback — pollEnrichment handles both) and, the moment it
  // settles, patch the entry in place so the badge clears and the estimate folds
  // into the running totals — no full reload, no flicker. pollEnrichment's own
  // stale-tab guard means onUpdate never fires after the surface re-renders.
  function watchFuelPending(token: number, options: DayFuelControllerOptions = {}): void {
    // Guarded like the rest of the shell's cross-module globals: if the enrichment
    // helpers aren't loaded (e.g. a minimal test host), skip watching — the Fuel
    // card still renders, it just won't live-clear the badge.
    if (typeof enrichmentActive !== "function" || typeof pollEnrichment !== "function") return;
    const day = state._dayFuel as DayFuelControllerDay | null | undefined;
    const entries = day && Array.isArray(day.entries) ? day.entries : [];
    for (const entry of entries) {
      const id = Number(entry.id);
      if (!id || !enrichmentActive(entry.enrichment_status)) continue;
      if (_fuelWatched.has(id)) continue;
      _fuelWatched.add(id);
      pollEnrichment("/food-notes", id, {
        tab: state.tab,
        token,
        onUpdate: (row) => {
          if (enrichmentActive(row.enrichment_status)) return; // still cooking
          const parsed = (row as { parsed?: Record<string, unknown> }).parsed || {};
          const rawOutput = (row as { raw_output?: unknown }).raw_output;
          const patch: Partial<DayFuelControllerEntry> = {
            summary: String(parsed.summary ?? rawOutput ?? entry.summary ?? "").trim() || "Food",
            kcal: fuelMacroValue(parsed.kcal),
            protein_g: fuelMacroValue(parsed.protein_g),
            carbs_g: fuelMacroValue(parsed.carbs_g),
            fat_g: fuelMacroValue(parsed.fat_g),
            fiber_g: fuelMacroValue(parsed.fiber_g),
            enrichment_status: (row.enrichment_status ?? null) as string | null,
          };
          const next = withFuelEntry(state._dayFuel as DayFuelControllerDay, id, patch);
          renderDayFuel(token, next, options);
          swrInvalidate("progress:intake");
        },
      }).finally(() => {
        _fuelWatched.delete(id);
      });
    }
  }

  function withFuelEntry(
    day: DayFuelControllerDay | null,
    id: number,
    patch: Partial<DayFuelControllerEntry> | null
  ): DayFuelControllerDay {
    const base = day ||
      (state._dayFuel as DayFuelControllerDay | null | undefined) || {
        date: state.logDate || "",
        totals: { ...EMPTY_TOTALS },
        known: { ...EMPTY_KNOWN },
        entries: [],
        count: 0,
        target: null,
        remaining: null,
      };
    const entries = Array.isArray(base.entries) ? base.entries : [];
    const nextEntries =
      patch === null
        ? entries.filter((item) => item.id !== id)
        : entries.map((item) => (item.id === id ? { ...item, ...patch } : item));
    const totals: DayFuelControllerDay["totals"] = { ...EMPTY_TOTALS };
    const known = { ...EMPTY_KNOWN };
    for (const key of ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"] as const) {
      const values = nextEntries.map((entry) => fuelMacroValue(entry[key]));
      totals[key] = Math.round(values.reduce((sum: number, value) => sum + Number(value ?? 0), 0) * 10) / 10;
      known[key] = nextEntries.length > 0 && values.every((value) => value != null);
    }
    const remaining = base.remaining
      ? {
          ...base.remaining,
          kcal: base.target ? Number(base.target.kcal) - totals.kcal : base.remaining.kcal,
          protein_g: base.target ? Number(base.target.protein_g) - totals.protein_g : base.remaining.protein_g,
        }
      : base.remaining;
    return { ...base, entries: nextEntries, count: nextEntries.length, totals, known, remaining };
  }

  // The same twin context the read-only food-detail sheet shows (ingredients,
  // the verbatim "as logged" quote, share-of-day) — so a correction happens
  // with the original words still visible, not against five bare numbers.
  function fuelEditContextHtml(entry: DayFuelControllerEntry, day: DayFuelControllerDay | null | undefined): string {
    const ingredients = CairnFoodNote.foodIngredients(entry);
    const items = ingredients.length ? ingredients.map(CairnFoodNote.ingredientLabel).join(", ") : CairnFoodNote.foodItemsText(entry);
    const raw = String(entry.raw || "").trim();
    const summary = String(entry.summary || "");
    const kcal = fuelMacroValue(entry.kcal);
    const target = fuelMacroValue(day?.target?.kcal ?? null);
    const shareOfDay = kcal && target ? `${Math.round((kcal / target) * 100)}% of the day` : "";
    const bits = [items ? escHtml(items) : "", shareOfDay ? escHtml(shareOfDay) : ""].filter(Boolean).join(" &middot; ");
    return (
      (bits ? `<div class="detail-ctx lbl">${bits}</div>` : "") +
      (raw && raw !== summary ? `<div class="detail-section"><div class="lbl">As logged</div><div class="detail-body">&ldquo;${escHtml(raw)}&rdquo;</div></div>` : "")
    );
  }

  function openFoodEdit(id: number, fromEl: Element, options: DayFuelControllerOptions = {}): void {
    const day = state._dayFuel as DayFuelControllerDay | null | undefined;
    const entry = day && Array.isArray(day.entries) ? day.entries.find((item) => item.id === id) : null;
    if (!entry) return;
    openDetailFrom(fromEl, () => {
      const el = mountDetail(`
        <h2 class="detail-title">Edit this meal</h2>
        ${fuelEditContextHtml(entry, day)}
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
          <div class="field"><label>fiber (g)</label><input id="fedFiber" type="number" inputmode="numeric" value="${entry.fiber_g ?? ""}"></div>
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
          fiber_g: fuelNumberOrNull(fuelInputValue(el, "#fedFiber")),
        };
        try {
          await optimisticMutation<DayFuelControllerDay>({
            key: dayFuelCacheKey(),
            apply: (current) => withFuelEntry(current, id, body),
            rollback: state._dayFuel as DayFuelControllerDay,
            request: () =>
              api(`/food-notes/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }),
            onChange: (day) => renderDayFuel(0, day, { ...options, isCurrent: () => true }),
          });
          toast("Updated");
        } catch {
          toast("Couldn't save");
          return;
        }
        swrInvalidate("progress:energy");
        swrInvalidate("progress:intake");
        closeDetail(true);
      });
      const del = el.querySelector("#fedDel");
      if (del)
        del.addEventListener("click", () =>
          armDelete(del, async () => {
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
            swrInvalidate("progress:intake");
            closeDetail(true);
          })
        );
    });
  }

  const CAIRN_DAY_FUEL_CONTROLLER = {
    loadDayFuel,
    openFoodEdit,
  };

  Object.assign(globalThis, { CairnDayFuelController: CAIRN_DAY_FUEL_CONTROLLER });
  if (typeof window !== "undefined") window.CairnDayFuelController = CAIRN_DAY_FUEL_CONTROLLER;
})();

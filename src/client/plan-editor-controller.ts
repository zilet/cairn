// @ts-check
// Plan editor DOM orchestration: route paint, edit state, and save-bar persistence.

type PlanEditorControllerApiDay = import("../contracts/client.js").ClientPlanDay;
type PlanEditorControllerItem = {
  kind?: "strength" | "cardio";
  exercise?: unknown;
  sets?: unknown;
  rep_low?: unknown;
  rep_high?: unknown;
  target_weight?: unknown;
  note?: unknown;
  warmup_sets?: unknown;
  muscle_group?: unknown;
  target_seconds?: unknown;
  mode?: unknown;
  target_distance_km?: unknown;
  target_duration_min?: unknown;
  target_zone?: unknown;
  interval?: unknown;
  interval_note?: unknown;
};

type PlanEditorControllerDay = {
  day_number?: unknown;
  name?: unknown;
  focus?: unknown;
  items?: PlanEditorControllerItem[];
};

type PlanEditorControllerModelDay = {
  day_number: unknown;
  name: unknown;
  focus: unknown;
  items: PlanEditorControllerItem[];
};

type PlanEditorControllerSaveDay = {
  day_number: number;
  name: string;
  focus: unknown;
  items: Array<Record<string, unknown>>;
};

type PlanEditorControllerHelpers = {
  blankStrength(): PlanEditorControllerItem;
  blankCardio(): PlanEditorControllerItem;
  dayModelFromPlan(day: PlanEditorControllerDay | PlanEditorControllerApiDay): PlanEditorControllerModelDay;
  calendarFooterHtml(plan: unknown, host: unknown, icsUrl: unknown): string;
  progDayHtml(day: PlanEditorControllerDay, dayIndex: number): string;
  pitemHtml(item: PlanEditorControllerItem, dayIndex: number, itemIndex: number, lastIndex: number): string;
  pdayHtml(day: PlanEditorControllerDay, dayIndex: number): string;
};

type PlanEditorControllerInput = HTMLInputElement | HTMLTextAreaElement;

declare function wireGuides(scope?: ParentNode | null): void;

(() => {
function planHelpers(): PlanEditorControllerHelpers {
  return CairnPlanEditor as unknown as PlanEditorControllerHelpers;
}

function planInput(el: Element | null | undefined): PlanEditorControllerInput | null {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

function planText(root: ParentNode, selector: string): string {
  return planInput(root.querySelector(selector))?.value || "";
}

function planNumber(root: ParentNode, selector: string): number | null {
  const value = planText(root, selector);
  return value === "" ? null : Number(value);
}

function planDayNumber(day: PlanEditorControllerModelDay): number {
  return Number(day.day_number) || 0;
}

function planDatasetNumber(el: HTMLElement, key: string): number {
  return Number(el.dataset[key]) || 0;
}

function planDatasetPair(value: string | undefined): [number, number] {
  const [day, item] = String(value || "").split(":").map(Number);
  return [Number.isFinite(day) ? day : -1, Number.isFinite(item) ? item : -1];
}

function planEditorRoot(): HTMLElement | null {
  return $("#planedit");
}

function serializePlanDays(model: PlanEditorControllerModelDay[]): PlanEditorControllerSaveDay[] {
  return model.map((day, index) => ({
    day_number: index + 1,
    name: String(day.name || `Day ${index + 1}`),
    focus: day.focus || null,
    items: day.items
      .filter((item) => {
        if (isCardioItem(item)) {
          const note = String(item.note || "").trim();
          const zone = String(item.target_zone || "").trim();
          return !!note || item.target_distance_km != null || item.target_duration_min != null || !!zone;
        }
        return !!String(item.exercise || "").trim();
      })
      .map((item) => {
        if (isCardioItem(item)) {
          const intervalNote = String(item.interval_note || "").trim();
          const note = String(item.note || "").trim();
          const zone = String(item.target_zone || "").trim();
          return {
            kind: "cardio",
            note: note || null,
            target_distance_km: item.target_distance_km ?? null,
            target_duration_min: item.target_duration_min ?? null,
            target_zone: zone || null,
            interval: intervalNote ? { note: intervalNote } : null,
          };
        }
        const note = String(item.note || "").trim();
        return {
          kind: "strength",
          exercise: String(item.exercise || "").trim(),
          sets: item.sets,
          rep_low: item.rep_low,
          rep_high: item.rep_high,
          target_weight: item.target_weight,
          note: note || null,
          warmup_sets: item.warmup_sets ?? null,
          target_seconds: item.target_seconds ?? null,
        };
      }),
  }));
}

async function renderPlanEditor(): Promise<void> {
  const helpers = planHelpers();
  headerTitle.textContent = "Plan";
  state.planSeg = "edit";
  const token = ++pollToken;
  const peek = peekCached<PlanEditorControllerApiDay[]>("plan");
  if (!peek) view.innerHTML = segSkeleton("edit", planSeg(), 3);
  const revalidate = cachedApi("/plan", {
    key: "plan",
    onUpgrade: (_data, { changed }) => {
      if (peek && !peek.fresh) markRefreshing(false);
      if (!changed || !peek) return;
      if (state.tab !== "plan" || token !== pollToken || !view.querySelector("#planedit")) return;
      if (view.querySelector(".pday") || document.querySelector(".savebar.show")) return;
      renderPlanEditor();
    },
  });
  const plan = peek ? peek.data : await revalidate.catch(() => []);
  if (token !== pollToken || state.tab !== "plan") return;
  if (peek && !peek.fresh) markRefreshing(true);

  const icsUrl = withToken("/api/plan.ics");
  const calFooter = helpers.calendarFooterHtml(plan, location.host, icsUrl);
  view.innerHTML = segBar("edit", planSeg()) + `<div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>${calFooter}`;
  wireSeg(PLAN_HANDLERS);

  const model: PlanEditorControllerModelDay[] = (Array.isArray(plan) ? plan : []).map((day) => helpers.dayModelFromPlan(day));
  const editing = new Set<number>();
  let planBar: ClientSaveBar | null = null;

  function markDirty(): void {
    planBar?.markDirty();
  }

  function sync(): void {
    view.querySelectorAll<HTMLElement>(".pday").forEach((dayEl) => {
      const day = model[planDatasetNumber(dayEl, "d")];
      if (!day) return;
      day.name = planText(dayEl, ".pday-name");
      day.focus = planText(dayEl, ".pday-focus");
    });
    view.querySelectorAll<HTMLElement>(".pitem").forEach((itEl) => {
      const day = model[planDatasetNumber(itEl, "d")];
      const item = day && day.items[planDatasetNumber(itEl, "i")];
      if (!item) return;
      if (itEl.dataset.kind === "cardio") {
        item.note = planText(itEl, ".pi-ex");
        item.target_distance_km = planNumber(itEl, ".pi-km");
        item.target_duration_min = planNumber(itEl, ".pi-min");
        item.target_zone = (planText(itEl, ".pi-zone") || "").trim() || null;
        item.interval_note = (planText(itEl, ".pi-ivl") || "").trim();
        return;
      }
      item.exercise = planText(itEl, ".pi-ex");
      item.sets = planNumber(itEl, ".pi-sets") ?? 3;
      item.rep_low = planNumber(itEl, ".pi-lo");
      item.rep_high = planNumber(itEl, ".pi-hi");
      item.target_weight = planNumber(itEl, ".pi-tw");
      item.warmup_sets = planNumber(itEl, ".pi-wu");
      item.note = planText(itEl, ".pi-note");
    });
  }

  function draw(): void {
    const root = planEditorRoot();
    if (!root) return;
    root.innerHTML = model.map((day, dayIndex) => editing.has(dayIndex) ? helpers.pdayHtml(day, dayIndex) : helpers.progDayHtml(day, dayIndex)).join("");
    wireGuides(root);

    view.querySelectorAll<HTMLElement>("[data-editday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      editing.add(planDatasetNumber(button, "editday"));
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-doneday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      editing.delete(planDatasetNumber(button, "doneday"));
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-delday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const deleted = planDatasetNumber(button, "delday");
      model.splice(deleted, 1);
      const keep = [...editing].filter((index) => index !== deleted).map((index) => (index > deleted ? index - 1 : index));
      editing.clear();
      keep.forEach((index) => editing.add(index));
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-delitem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayIndex, itemIndex] = planDatasetPair(button.dataset.delitem);
      const day = model[dayIndex];
      if (day && itemIndex >= 0) {
        day.items.splice(itemIndex, 1);
        markDirty();
        draw();
      }
    }));
    view.querySelectorAll<HTMLElement>("[data-additem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const day = model[planDatasetNumber(button, "additem")];
      if (!day) return;
      day.items.push(helpers.blankStrength());
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-addcardio]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const day = model[planDatasetNumber(button, "addcardio")];
      if (!day) return;
      day.items.push(helpers.blankCardio());
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-pikind]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayRaw, itemRaw, kindRaw] = String(button.dataset.pikind || "").split(":");
      const dayIndex = Number(dayRaw);
      const itemIndex = Number(itemRaw);
      const kind = kindRaw === "cardio" ? "cardio" : "strength";
      const item = model[dayIndex]?.items[itemIndex];
      if (!item || item.kind === kind) return;
      const label = item.kind === "cardio" ? (item.note || "") : (item.exercise || "");
      const next = kind === "cardio" ? helpers.blankCardio() : helpers.blankStrength();
      if (kind === "cardio") next.note = label;
      else next.exercise = label;
      model[dayIndex].items[itemIndex] = next;
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-upitem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayIndex, itemIndex] = planDatasetPair(button.dataset.upitem);
      const items = model[dayIndex]?.items;
      if (items && itemIndex > 0) {
        [items[itemIndex - 1], items[itemIndex]] = [items[itemIndex], items[itemIndex - 1]];
        markDirty();
        draw();
      }
    }));
    view.querySelectorAll<HTMLElement>("[data-downitem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayIndex, itemIndex] = planDatasetPair(button.dataset.downitem);
      const items = model[dayIndex]?.items;
      if (items && itemIndex >= 0 && itemIndex < items.length - 1) {
        [items[itemIndex + 1], items[itemIndex]] = [items[itemIndex], items[itemIndex + 1]];
        markDirty();
        draw();
      }
    }));
  }

  $("#addDay")?.addEventListener("click", () => {
    sync();
    const next = model.reduce((max, day) => Math.max(max, planDayNumber(day)), 0) + 1;
    model.push({ day_number: next, name: `Day ${next}`, focus: "", items: [] });
    editing.add(model.length - 1);
    markDirty();
    draw();
  });

  const persistPlan = async (): Promise<boolean> => {
    sync();
    const days = serializePlanDays(model);
    const status = $("#planstatus");
    if (!days.length) {
      if (status) status.textContent = "Add at least one day before saving.";
      return false;
    }
    const response = await api("/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
    if (response && "error" in response && response.error) {
      if (status) status.textContent = "Couldn't save your plan — try again.";
      return false;
    }
    state.plan = [];
    swrInvalidate("plan");
    renderPlanEditor();
    return true;
  };

  const planEdit = planEditorRoot();
  if (!planEdit) return;
  planBar = mountSaveBar({
    sentinel: planEdit,
    fields: planEdit,
    onSave: persistPlan,
    onDiscard: () => renderPlanEditor(),
  });

  draw();
}

const CAIRN_PLAN_EDITOR_CONTROLLER = {
  render: renderPlanEditor,
  serializeDays: serializePlanDays,
};

Object.assign(globalThis, {
  CairnPlanEditorController: CAIRN_PLAN_EDITOR_CONTROLLER,
  renderPlanEditor,
});

if (typeof window !== "undefined") {
  window.CairnPlanEditorController = CAIRN_PLAN_EDITOR_CONTROLLER;
  window.renderPlanEditor = renderPlanEditor;
}
})();

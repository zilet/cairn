// @ts-check
// Plan editor form reads and save-payload assembly. Lift days only: a run is never
// a plan item (it lives in Plan -> Endurance), so a save carries strength items alone.

type PlanEditorFormItem = {
  kind?: "strength" | "cardio";
  exercise?: unknown;
  sets?: unknown;
  rep_low?: unknown;
  rep_high?: unknown;
  target_weight?: unknown;
  note?: unknown;
  warmup_sets?: unknown;
  target_seconds?: unknown;
};

type PlanEditorFormModelDay = {
  day_number?: unknown;
  name?: unknown;
  focus?: unknown;
  day_type?: unknown;
  items: PlanEditorFormItem[];
};

type PlanEditorFormSaveDay = {
  day_number: number;
  name: string;
  focus: unknown;
  day_type: "training";
  items: Array<Record<string, unknown>>;
};

type PlanEditorFormInput = HTMLInputElement | HTMLTextAreaElement;

(() => {
function planInput(el: Element | null | undefined): PlanEditorFormInput | null {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

function planText(root: ParentNode, selector: string): string {
  return planInput(root.querySelector(selector))?.value || "";
}

function planNumber(root: ParentNode, selector: string): number | null {
  const value = planText(root, selector);
  return value === "" ? null : Number(value);
}

function planDayNumber(day: PlanEditorFormModelDay): number {
  return Number(day.day_number) || 0;
}

function planDatasetNumber(el: HTMLElement, key: string): number {
  return Number(el.dataset[key]) || 0;
}

function planDatasetPair(value: string | undefined): [number, number] {
  const [day, item] = String(value || "").split(":").map(Number);
  return [Number.isFinite(day) ? day : -1, Number.isFinite(item) ? item : -1];
}

function syncPlanModel(model: PlanEditorFormModelDay[], root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".pday").forEach((dayEl) => {
    const day = model[planDatasetNumber(dayEl, "d")];
    if (!day) return;
    day.name = planText(dayEl, ".pday-name");
    day.focus = planText(dayEl, ".pday-focus");
  });
  root.querySelectorAll<HTMLElement>(".pitem").forEach((itEl) => {
    const day = model[planDatasetNumber(itEl, "d")];
    const item = day && day.items[planDatasetNumber(itEl, "i")];
    if (!item) return;
    item.exercise = planText(itEl, ".pi-ex");
    item.sets = planNumber(itEl, ".pi-sets") ?? 3;
    item.rep_low = planNumber(itEl, ".pi-lo");
    item.rep_high = planNumber(itEl, ".pi-hi");
    item.target_weight = planNumber(itEl, ".pi-tw");
    item.warmup_sets = planNumber(itEl, ".pi-wu");
    item.note = planText(itEl, ".pi-note");
  });
}

function planItemHasContent(item: PlanEditorFormItem): boolean {
  return !isCardioItem(item) && !!String(item.exercise || "").trim();
}

function serializePlanDays(model: PlanEditorFormModelDay[]): PlanEditorFormSaveDay[] {
  return model.map((day, index) => {
    // Blank rows and any run an older payload left in the model never travel: the
    // plan the editor saves holds lifts only.
    const items = day.items.filter(planItemHasContent);
    return {
      day_number: index + 1,
      name: String(day.name || `Day ${index + 1}`),
      focus: day.focus || null,
      day_type: "training" as const,
      items: items.map((item) => {
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
    };
  });
}

const CAIRN_PLAN_EDITOR_FORM = {
  dayNumber: planDayNumber,
  datasetNumber: planDatasetNumber,
  datasetPair: planDatasetPair,
  syncModel: syncPlanModel,
  serializeDays: serializePlanDays,
};

Object.assign(globalThis, { CairnPlanEditorForm: CAIRN_PLAN_EDITOR_FORM });

if (typeof window !== "undefined") {
  window.CairnPlanEditorForm = CAIRN_PLAN_EDITOR_FORM;
}
})();

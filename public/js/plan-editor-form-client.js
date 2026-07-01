(() => {
// @ts-check
// Plan editor form reads and save-payload assembly.
(() => {
    function planInput(el) {
        return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
    }
    function planText(root, selector) {
        return planInput(root.querySelector(selector))?.value || "";
    }
    function planNumber(root, selector) {
        const value = planText(root, selector);
        return value === "" ? null : Number(value);
    }
    function planDayNumber(day) {
        return Number(day.day_number) || 0;
    }
    function planDatasetNumber(el, key) {
        return Number(el.dataset[key]) || 0;
    }
    function planDatasetPair(value) {
        const [day, item] = String(value || "").split(":").map(Number);
        return [Number.isFinite(day) ? day : -1, Number.isFinite(item) ? item : -1];
    }
    function syncPlanModel(model, root) {
        root.querySelectorAll(".pday").forEach((dayEl) => {
            const day = model[planDatasetNumber(dayEl, "d")];
            if (!day)
                return;
            day.name = planText(dayEl, ".pday-name");
            day.focus = planText(dayEl, ".pday-focus");
        });
        root.querySelectorAll(".pitem").forEach((itEl) => {
            const day = model[planDatasetNumber(itEl, "d")];
            const item = day && day.items[planDatasetNumber(itEl, "i")];
            if (!item)
                return;
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
    function serializePlanDays(model) {
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
})();

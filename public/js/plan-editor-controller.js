(() => {
// @ts-check
// Plan editor DOM orchestration: route paint, edit state, and save-bar persistence.
(() => {
    function planHelpers() {
        return CairnPlanEditor;
    }
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
    function planEditorRoot() {
        return $("#planedit");
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
    async function renderPlanEditor() {
        const helpers = planHelpers();
        headerTitle.textContent = "Plan";
        state.planSeg = "edit";
        const token = ++pollToken;
        const peek = peekCached("plan");
        if (!peek)
            view.innerHTML = segSkeleton("edit", planSeg(), 3);
        const revalidate = cachedApi("/plan", {
            key: "plan",
            onUpgrade: (_data, { changed }) => {
                if (peek && !peek.fresh)
                    markRefreshing(false);
                if (!changed || !peek)
                    return;
                if (state.tab !== "plan" || token !== pollToken || !view.querySelector("#planedit"))
                    return;
                if (view.querySelector(".pday") || document.querySelector(".savebar.show"))
                    return;
                renderPlanEditor();
            },
        });
        const plan = peek ? peek.data : await revalidate.catch(() => []);
        if (token !== pollToken || state.tab !== "plan")
            return;
        if (peek && !peek.fresh)
            markRefreshing(true);
        const icsUrl = withToken("/api/plan.ics");
        const calFooter = helpers.calendarFooterHtml(plan, location.host, icsUrl);
        view.innerHTML = segBar("edit", planSeg()) + `<div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>${calFooter}`;
        wireSeg(PLAN_HANDLERS);
        const model = (Array.isArray(plan) ? plan : []).map((day) => helpers.dayModelFromPlan(day));
        const editing = new Set();
        let planBar = null;
        function markDirty() {
            planBar?.markDirty();
        }
        function sync() {
            view.querySelectorAll(".pday").forEach((dayEl) => {
                const day = model[planDatasetNumber(dayEl, "d")];
                if (!day)
                    return;
                day.name = planText(dayEl, ".pday-name");
                day.focus = planText(dayEl, ".pday-focus");
            });
            view.querySelectorAll(".pitem").forEach((itEl) => {
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
        function draw() {
            const root = planEditorRoot();
            if (!root)
                return;
            root.innerHTML = model.map((day, dayIndex) => editing.has(dayIndex) ? helpers.pdayHtml(day, dayIndex) : helpers.progDayHtml(day, dayIndex)).join("");
            wireGuides(root);
            view.querySelectorAll("[data-editday]").forEach((button) => button.addEventListener("click", () => {
                sync();
                editing.add(planDatasetNumber(button, "editday"));
                draw();
            }));
            view.querySelectorAll("[data-doneday]").forEach((button) => button.addEventListener("click", () => {
                sync();
                editing.delete(planDatasetNumber(button, "doneday"));
                draw();
            }));
            view.querySelectorAll("[data-delday]").forEach((button) => button.addEventListener("click", () => {
                sync();
                const deleted = planDatasetNumber(button, "delday");
                model.splice(deleted, 1);
                const keep = [...editing].filter((index) => index !== deleted).map((index) => (index > deleted ? index - 1 : index));
                editing.clear();
                keep.forEach((index) => editing.add(index));
                markDirty();
                draw();
            }));
            view.querySelectorAll("[data-delitem]").forEach((button) => button.addEventListener("click", () => {
                sync();
                const [dayIndex, itemIndex] = planDatasetPair(button.dataset.delitem);
                const day = model[dayIndex];
                if (day && itemIndex >= 0) {
                    day.items.splice(itemIndex, 1);
                    markDirty();
                    draw();
                }
            }));
            view.querySelectorAll("[data-additem]").forEach((button) => button.addEventListener("click", () => {
                sync();
                const day = model[planDatasetNumber(button, "additem")];
                if (!day)
                    return;
                day.items.push(helpers.blankStrength());
                markDirty();
                draw();
            }));
            view.querySelectorAll("[data-addcardio]").forEach((button) => button.addEventListener("click", () => {
                sync();
                const day = model[planDatasetNumber(button, "addcardio")];
                if (!day)
                    return;
                day.items.push(helpers.blankCardio());
                markDirty();
                draw();
            }));
            view.querySelectorAll("[data-pikind]").forEach((button) => button.addEventListener("click", () => {
                sync();
                const [dayRaw, itemRaw, kindRaw] = String(button.dataset.pikind || "").split(":");
                const dayIndex = Number(dayRaw);
                const itemIndex = Number(itemRaw);
                const kind = kindRaw === "cardio" ? "cardio" : "strength";
                const item = model[dayIndex]?.items[itemIndex];
                if (!item || item.kind === kind)
                    return;
                const label = item.kind === "cardio" ? (item.note || "") : (item.exercise || "");
                const next = kind === "cardio" ? helpers.blankCardio() : helpers.blankStrength();
                if (kind === "cardio")
                    next.note = label;
                else
                    next.exercise = label;
                model[dayIndex].items[itemIndex] = next;
                markDirty();
                draw();
            }));
            view.querySelectorAll("[data-upitem]").forEach((button) => button.addEventListener("click", () => {
                sync();
                const [dayIndex, itemIndex] = planDatasetPair(button.dataset.upitem);
                const items = model[dayIndex]?.items;
                if (items && itemIndex > 0) {
                    [items[itemIndex - 1], items[itemIndex]] = [items[itemIndex], items[itemIndex - 1]];
                    markDirty();
                    draw();
                }
            }));
            view.querySelectorAll("[data-downitem]").forEach((button) => button.addEventListener("click", () => {
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
        const persistPlan = async () => {
            sync();
            const days = serializePlanDays(model);
            const status = $("#planstatus");
            if (!days.length) {
                if (status)
                    status.textContent = "Add at least one day before saving.";
                return false;
            }
            const response = await api("/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
            if (response && "error" in response && response.error) {
                if (status)
                    status.textContent = "Couldn't save your plan — try again.";
                return false;
            }
            state.plan = [];
            swrInvalidate("plan");
            renderPlanEditor();
            return true;
        };
        const planEdit = planEditorRoot();
        if (!planEdit)
            return;
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
})();

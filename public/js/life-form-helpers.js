(() => {
// @ts-check
// Me -> Life form helpers: safe reads, dynamic fields, and add workflow.
function lifeFormTimelineActions() {
    return globalThis.CairnLifeTimelineActions;
}
function lifeIsRecord(value) {
    return !!value && typeof value === "object";
}
function lifeRecord(value) {
    return lifeIsRecord(value) ? value : {};
}
function lifeRows(value) {
    return Array.isArray(value) ? value.filter(lifeIsRecord) : [];
}
function lifeInputValue(id) {
    return $("#" + id)?.value ?? "";
}
function trimmedLifeInputValue(id) {
    const value = lifeInputValue(id).trim();
    return value || null;
}
function drawLifeFields(kind) {
    const wrap = $("#lFields");
    if (!wrap)
        return;
    wrap.innerHTML = CairnLife.lifeFieldsHtml(kind);
}
function collectLifeForm() {
    const kind = lifeInputValue("lKind");
    const title = trimmedLifeInputValue("lTitle");
    const detail = trimmedLifeInputValue("lDetail");
    const start_date = trimmedLifeInputValue("lStart");
    const end_date = trimmedLifeInputValue("lEnd");
    const meta = {};
    if (kind === "trip") {
        const loc = trimmedLifeInputValue("lLocation");
        if (loc)
            meta.location = loc;
    }
    else if (kind === "injury") {
        const area = trimmedLifeInputValue("lArea");
        if (area)
            meta.area = area;
        const sev = $("#lSeverity");
        if (sev)
            meta.severity = sev.value;
    }
    else {
        const imp = $("#lImpact");
        if (imp)
            meta.impact = imp.value;
    }
    return { kind, title, detail, start_date, end_date, meta };
}
async function submitLifeForm(deps) {
    const status = $("#lStatus");
    const body = collectLifeForm();
    const titleInput = $("#lTitle");
    if (!status)
        return;
    if (!body.title) {
        status.textContent = "Add a title first.";
        titleInput?.focus();
        return;
    }
    const btn = $("#lAdd");
    if (!btn)
        return;
    btn.disabled = true;
    try {
        const response = lifeRecord(await deps.api("/context-events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }));
        if (response.error) {
            status.textContent = "Couldn't save that — try again.";
            return;
        }
        status.textContent = "";
        deps.toast("Added");
        // Reset the text + dates but keep the kind.
        drawLifeFields(lifeInputValue("lKind"));
        lifeFormTimelineActions().load(deps);
    }
    catch {
        status.textContent = "Couldn't save that — check your connection.";
    }
    finally {
        btn.disabled = false;
    }
}
const CAIRN_LIFE_FORM_HELPERS = {
    collectForm: collectLifeForm,
    drawFields: drawLifeFields,
    inputValue: lifeInputValue,
    record: lifeRecord,
    rows: lifeRows,
    submit: submitLifeForm,
    trimmedInputValue: trimmedLifeInputValue,
};
Object.assign(globalThis, { CairnLifeFormHelpers: CAIRN_LIFE_FORM_HELPERS });
if (typeof window !== "undefined") {
    window.CairnLifeFormHelpers = CAIRN_LIFE_FORM_HELPERS;
}
})();

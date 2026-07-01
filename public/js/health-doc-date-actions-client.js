(() => {
// Health document date editing: open/cancel/save the result-date editor.
// The row wiring facade lives in health-doc-actions-controller.ts.
function hdocDateRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function hdocDateElement(selector) {
    return $(selector);
}
function hdocDateRow(id) {
    return hdocDateElement(`#hlist .hdoc[data-hdoc="${id}"]`);
}
function openHealthDocDateEditor(row, editBtn) {
    const editor = row.querySelector("[data-hdate-editor]");
    const flash = row.querySelector("[data-hdate-flash]");
    if (flash)
        flash.hidden = true;
    editBtn.hidden = true;
    if (editor) {
        editor.hidden = false;
        editor.querySelector("[data-hdate]")?.focus();
    }
}
function cancelHealthDocDateEditor(row, editBtn) {
    const editor = row.querySelector("[data-hdate-editor]");
    const input = row.querySelector("[data-hdate]");
    if (input)
        input.value = input.defaultValue;
    if (editor)
        editor.hidden = true;
    if (editBtn)
        editBtn.hidden = false;
}
function flashHealthDocDateSaved(row) {
    const flash = row.querySelector("[data-hdate-flash]");
    if (!flash)
        return;
    flash.hidden = false;
    setTimeout(() => {
        if (flash.isConnected)
            flash.hidden = true;
    }, 2200);
}
async function saveHealthDocDate(id, deps) {
    const row = hdocDateRow(id);
    if (!row)
        return;
    const input = row.querySelector("[data-hdate]");
    const save = row.querySelector("[data-hdate-save]");
    if (!input)
        return;
    if (save) {
        save.disabled = true;
        save.textContent = "Saving…";
    }
    let updated = null;
    try {
        updated = await deps.api(`/health-docs/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ doc_date: input.value || null }),
        });
    }
    catch {
        if (save) {
            save.disabled = false;
            save.textContent = "Save";
        }
        deps.toast("Couldn't update date");
        return;
    }
    const doc = hdocDateRecord(updated);
    if (doc.id && !doc.error) {
        row.innerHTML = CairnHealthDocs.healthDocInner(doc);
        deps.wireHealthDoc(row);
        flashHealthDocDateSaved(row);
        deps.loadHealthMarkers(deps.pollToken());
        deps.paintHealthPicture();
        return;
    }
    if (save) {
        save.disabled = false;
        save.textContent = "Save";
    }
    deps.toast(String(doc.error || "Couldn't update date"));
}
const CAIRN_HEALTH_DOC_DATE_ACTIONS = {
    cancelEditor: cancelHealthDocDateEditor,
    openEditor: openHealthDocDateEditor,
    saveDate: saveHealthDocDate,
};
Object.assign(globalThis, { CairnHealthDocDateActions: CAIRN_HEALTH_DOC_DATE_ACTIONS });
if (typeof window !== "undefined") {
    window.CairnHealthDocDateActions = CAIRN_HEALTH_DOC_DATE_ACTIONS;
}
})();

(() => {
// Health Records controller: list loading, row actions, re-analysis polling,
// deep-link scrolling, and delete.
// Rendering primitives stay in health-records-client.ts and health-docs-client.ts.
function hrecRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function hrecRows(value) {
    return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") : [];
}
function hrecNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function hrecElement(selector) {
    return $(selector);
}
function hrecRefreshPictureAfterDelete(deps) {
    const pictureCache = deps.getHealthPictureCache();
    const docCount = pictureCache?.docCount || 0;
    if (!pictureCache || docCount <= 0)
        return;
    pictureCache.docCount = docCount - 1;
    deps.setHealthPictureCache(pictureCache);
    deps.paintHealthPicture();
}
function healthDocUploadDeps(deps) {
    return {
        api: deps.api,
        toast: deps.toast,
        enrichmentActive: deps.enrichmentActive,
        pollDoc: (id) => pollHealthDoc(id, deps),
        wireDoc: (el) => wireHealthDoc(el, deps),
        getHealthPictureCache: deps.getHealthPictureCache,
        setHealthPictureCache: deps.setHealthPictureCache,
        paintHealthPicture: deps.paintHealthPicture,
    };
}
function wireHealthUpload(deps) {
    CairnHealthDocUploadController.wireUpload(healthDocUploadDeps(deps));
}
function wireHealthDoc(el, deps) {
    if (!el)
        return;
    const id = el.dataset.hdoc;
    if (!id)
        return;
    const del = el.querySelector("[data-hdel]");
    if (del && !del._wired) {
        del._wired = true;
        del.addEventListener("click", () => startHealthDelete(del, deps));
    }
    const editBtn = el.querySelector("[data-hdate-edit]");
    if (editBtn && !editBtn._wired) {
        editBtn._wired = true;
        editBtn.addEventListener("click", () => {
            const editor = el.querySelector("[data-hdate-editor]");
            const flash = el.querySelector("[data-hdate-flash]");
            if (flash)
                flash.hidden = true;
            editBtn.hidden = true;
            if (editor) {
                editor.hidden = false;
                editor.querySelector("[data-hdate]")?.focus();
            }
        });
    }
    const saveBtn = el.querySelector("[data-hdate-save]");
    if (saveBtn && !saveBtn._wired) {
        saveBtn._wired = true;
        saveBtn.addEventListener("click", () => saveHealthDocDate(id, deps));
    }
    const cancelBtn = el.querySelector("[data-hdate-cancel]");
    if (cancelBtn && !cancelBtn._wired) {
        cancelBtn._wired = true;
        cancelBtn.addEventListener("click", () => {
            const editor = el.querySelector("[data-hdate-editor]");
            const input = el.querySelector("[data-hdate]");
            if (input)
                input.value = input.defaultValue;
            if (editor)
                editor.hidden = true;
            if (editBtn)
                editBtn.hidden = false;
        });
    }
    const rescan = el.querySelector("[data-hrescan]");
    if (rescan && !rescan._wired) {
        rescan._wired = true;
        rescan.addEventListener("click", () => reanalyzeHealthDoc(id, deps));
    }
    el.querySelectorAll("[data-hdoc-toggle]").forEach((toggleEl) => {
        if (toggleEl._wired)
            return;
        toggleEl._wired = true;
        const toggle = () => el.classList.toggle("hdoc-collapsed");
        toggleEl.addEventListener("click", toggle);
        if (toggleEl.getAttribute("role") === "button") {
            toggleEl.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle();
                }
            });
        }
    });
}
async function saveHealthDocDate(id, deps) {
    const row = hrecElement(`#hlist .hdoc[data-hdoc="${id}"]`);
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
    const doc = hrecRecord(updated);
    if (doc.id && !doc.error) {
        row.innerHTML = CairnHealthDocs.healthDocInner(doc);
        wireHealthDoc(row, deps);
        const flash = row.querySelector("[data-hdate-flash]");
        if (flash) {
            flash.hidden = false;
            setTimeout(() => {
                if (flash.isConnected)
                    flash.hidden = true;
            }, 2200);
        }
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
async function reanalyzeHealthDoc(id, deps) {
    const row = hrecElement(`#hlist .hdoc[data-hdoc="${id}"]`);
    let updated = null;
    try {
        updated = await deps.api(`/health-docs/${id}/reanalyze`, { method: "POST" });
    }
    catch {
        deps.toast("Couldn't start re-analysis");
        return;
    }
    const doc = hrecRecord(updated);
    if (!doc.id || doc.error) {
        deps.toast(String(doc.error || "Couldn't re-analyze"));
        return;
    }
    deps.toast("Re-analyzing…");
    if (row) {
        row.innerHTML = CairnHealthDocs.healthDocInner(doc);
        wireHealthDoc(row, deps);
    }
    pollHealthDoc(id, deps);
}
function pollHealthDoc(id, deps) {
    const numericId = hrecNumber(id);
    if (numericId == null || numericId <= 0)
        return;
    const tab = deps.state.tab;
    const token = deps.pollToken();
    deps.pollEnrichment("/health-docs", numericId, {
        tab,
        token,
        tries: 100,
        interval: 4000,
        onUpdate: (row) => {
            const doc = hrecRecord(row);
            if (deps.state.meSeg !== "health" || deps.state.healthSeg !== "records")
                return;
            const el = hrecElement(`#hlist .hdoc[data-hdoc="${doc.id}"]`);
            if (el) {
                el.innerHTML = CairnHealthDocs.healthDocInner(doc);
                wireHealthDoc(el, deps);
            }
            if (doc.enrichment_status === "done") {
                loadHealthDocs(deps);
                deps.loadHealthMarkers(deps.pollToken());
                deps.paintHealthPicture();
            }
        },
    });
}
async function loadHealthDocs(deps) {
    const wrap = hrecElement("#hlist");
    if (!wrap)
        return [];
    let docs = [];
    let fetched = false;
    try {
        docs = hrecRows(await deps.api("/health-docs"));
        fetched = true;
    }
    catch {
        docs = [];
    }
    if (fetched && Array.isArray(docs)) {
        try {
            localStorage.setItem("cairn:healthDocCount", String(docs.length));
        }
        catch { }
    }
    if (deps.state.tab !== "me" || deps.state.meSeg !== "health" || !wrap.isConnected)
        return docs || [];
    if (!docs || !docs.length) {
        wrap.innerHTML = CairnHealthRecords.recordsEmptyHtml();
        return [];
    }
    wrap.innerHTML = CairnHealthRecords.recordsListHtml(docs);
    wrap.querySelectorAll(".hdoc").forEach((el) => {
        wireHealthDoc(el, deps);
        if (el.dataset.hdoc && el.querySelector(".enr-pending"))
            pollHealthDoc(Number(el.dataset.hdoc), deps);
    });
    if (deps.state.pendingHealthDocId) {
        const wanted = String(deps.state.pendingHealthDocId);
        const target = [...wrap.querySelectorAll(".hdoc[data-hdoc]")]
            .find((el) => el.dataset.hdoc === wanted);
        deps.state.pendingHealthDocId = null;
        if (target) {
            target.classList.remove("hdoc-collapsed");
            try {
                target.scrollIntoView({ block: "start", behavior: "smooth" });
            }
            catch {
                target.scrollIntoView();
            }
        }
    }
    return docs;
}
function startHealthDelete(btn, deps) {
    const row = btn.closest(".hdoc");
    if (!(row instanceof HTMLElement))
        return;
    const id = row.dataset.hdoc;
    if (!id)
        return;
    deps.armDelete(btn, () => {
        deps.api(`/health-docs/${id}`, { method: "DELETE" })
            .then(() => {
            deps.toast("Removed");
            row.remove();
            const list = hrecElement("#hlist");
            if (list && !list.children.length)
                list.innerHTML = CairnHealthRecords.recordsEmptyHtml();
            hrecRefreshPictureAfterDelete(deps);
            deps.loadHealthMarkers(deps.pollToken());
        })
            .catch(() => deps.toast("Couldn't remove that — try again."));
    });
}
function renderHealthRecords(deps) {
    const content = hrecElement("#hContent");
    if (!content)
        return Promise.resolve([]);
    content.innerHTML = CairnHealthRecords.recordsTabHtml();
    wireHealthUpload(deps);
    return loadHealthDocs(deps);
}
const CAIRN_HEALTH_RECORDS_CONTROLLER = {
    render: renderHealthRecords,
    loadDocs: loadHealthDocs,
    wireDoc: wireHealthDoc,
    wireUpload: wireHealthUpload,
};
Object.assign(globalThis, { CairnHealthRecordsController: CAIRN_HEALTH_RECORDS_CONTROLLER });
if (typeof window !== "undefined") {
    window.CairnHealthRecordsController = CAIRN_HEALTH_RECORDS_CONTROLLER;
}
})();

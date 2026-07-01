(() => {
// Health Records controller: list loading, upload handoff, and deep-link scrolling.
// Rendering primitives stay in health-records-client.ts and health-docs-client.ts;
// per-row document actions live in health-doc-actions-controller.ts.
function hrecRows(value) {
    return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") : [];
}
function hrecElement(selector) {
    return $(selector);
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
function healthDocActionsDeps(deps) {
    return {
        state: deps.state,
        api: deps.api,
        toast: deps.toast,
        armDelete: deps.armDelete,
        pollEnrichment: deps.pollEnrichment,
        pollToken: deps.pollToken,
        loadHealthMarkers: deps.loadHealthMarkers,
        paintHealthPicture: deps.paintHealthPicture,
        loadHealthDocs: () => loadHealthDocs(deps),
        wireHealthDoc: (el) => wireHealthDoc(el, deps),
        getHealthPictureCache: deps.getHealthPictureCache,
        setHealthPictureCache: deps.setHealthPictureCache,
    };
}
function wireHealthUpload(deps) {
    CairnHealthDocUploadController.wireUpload(healthDocUploadDeps(deps));
}
function wireHealthDoc(el, deps) {
    CairnHealthDocActionsController.wireDoc(el, healthDocActionsDeps(deps));
}
function pollHealthDoc(id, deps) {
    CairnHealthDocActionsController.pollDoc(id, healthDocActionsDeps(deps));
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

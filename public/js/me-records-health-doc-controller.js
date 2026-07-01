(() => {
// Health Records controller: upload, date edits, re-analysis polling, and delete.
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
function hrecFileDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(file);
    });
}
function hrecRefreshPictureAfterUpload(doc, deps) {
    const pictureCache = deps.getHealthPictureCache();
    const stamp = doc.created_at || new Date().toISOString();
    if (pictureCache) {
        pictureCache.docCount = (pictureCache.docCount || 0) + 1;
        if (!pictureCache.newestDocAt || stamp > pictureCache.newestDocAt)
            pictureCache.newestDocAt = stamp;
        deps.setHealthPictureCache(pictureCache);
    }
    else {
        deps.setHealthPictureCache({ review: null, docCount: 1, newestDocAt: stamp });
    }
    deps.paintHealthPicture();
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
function wireHealthUpload(deps) {
    const fileInput = hrecElement("#hFile");
    const fileName = hrecElement("#hFileName");
    const uploadBox = hrecElement("#hUploadBox");
    const textInput = hrecElement("#hText");
    const uploadBtn = hrecElement("#hUpload");
    const status = hrecElement("#hStatus");
    const fileLabel = hrecElement("#hFileLabel");
    if (!fileInput || !fileName || !uploadBox || !textInput || !uploadBtn || !status || !fileLabel)
        return;
    let pendingFile = null;
    const setUploadReady = () => {
        const hasText = textInput.value.trim().length > 0;
        uploadBtn.disabled = !pendingFile && !hasText;
    };
    const resetPicker = () => {
        fileInput.value = "";
        textInput.value = "";
        pendingFile = null;
        fileName.textContent = CairnHealthClient.H_FILE_PROMPT;
    };
    const setPendingFile = (file) => {
        if (!file) {
            pendingFile = null;
            fileName.textContent = CairnHealthClient.H_FILE_PROMPT;
            setUploadReady();
            return;
        }
        if (file.size > CairnHealthClient.MAX_DOC_BYTES) {
            deps.toast("File too large (max 15MB)");
            fileInput.value = "";
            pendingFile = null;
            fileName.textContent = CairnHealthClient.H_FILE_PROMPT;
            setUploadReady();
            return;
        }
        pendingFile = file;
        fileName.textContent = file.name || "Pasted image";
        setUploadReady();
    };
    fileInput.addEventListener("change", () => {
        const file = fileInput.files && fileInput.files[0];
        setPendingFile(file || null);
    });
    textInput.addEventListener("input", setUploadReady);
    uploadBox.addEventListener("dragover", (event) => {
        event.preventDefault();
        fileLabel.classList.add("dragover");
    });
    uploadBox.addEventListener("dragleave", () => fileLabel.classList.remove("dragover"));
    uploadBox.addEventListener("drop", (event) => {
        event.preventDefault();
        fileLabel.classList.remove("dragover");
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file)
            setPendingFile(file);
    });
    uploadBox.addEventListener("paste", (event) => {
        const files = Array.from(event.clipboardData?.files || []);
        const image = files.find((file) => (file.type || "").startsWith("image/"));
        if (image) {
            event.preventDefault();
            setPendingFile(image);
            return;
        }
        if (event.target !== textInput) {
            const text = event.clipboardData && event.clipboardData.getData("text/plain");
            if (text) {
                event.preventDefault();
                textInput.value = text;
                setUploadReady();
            }
        }
    });
    uploadBtn.addEventListener("click", async () => {
        const file = pendingFile;
        const pastedText = textInput.value.trim();
        if (!file && !pastedText) {
            deps.toast("Add a file or text first");
            return;
        }
        if (file && file.size > CairnHealthClient.MAX_DOC_BYTES) {
            deps.toast("File too large (max 15MB)");
            return;
        }
        if (!file && pastedText.length > CairnHealthClient.MAX_DOC_TEXT) {
            deps.toast("Text is too long");
            return;
        }
        uploadBtn.disabled = true;
        status.textContent = "Uploading…";
        const body = { original_name: "" };
        if (file) {
            let dataUrl;
            try {
                dataUrl = await hrecFileDataUrl(file);
            }
            catch {
                status.textContent = "Couldn't read that file. Try a different one.";
                uploadBtn.disabled = false;
                return;
            }
            body.original_name = file.name || "Pasted image";
            body.mime = CairnHealthClient.guessUploadMime(file);
            body.data_base64 = String(dataUrl).split(",")[1] || "";
        }
        else {
            body.original_name = "Pasted results";
            body.text = pastedText;
        }
        let row = null;
        try {
            row = await deps.api("/health-docs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        }
        catch {
            status.textContent = "Couldn't upload that — check your connection.";
            uploadBtn.disabled = false;
            return;
        }
        const doc = hrecRecord(row);
        if (!doc.id || doc.error) {
            status.textContent = "Couldn't upload that — try again.";
            uploadBtn.disabled = false;
            return;
        }
        status.textContent = "";
        deps.toast("Uploaded");
        resetPicker();
        const wrap = hrecElement("#hlist");
        if (wrap) {
            wrap.querySelector(".empty")?.remove();
            wrap.insertAdjacentHTML("afterbegin", CairnHealthDocs.healthDocHtml(doc));
            wireHealthDoc(wrap.querySelector(`.hdoc[data-hdoc="${doc.id}"]`), deps);
        }
        if (doc.id && deps.enrichmentActive(doc.enrichment_status))
            pollHealthDoc(doc.id, deps);
        hrecRefreshPictureAfterUpload(doc, deps);
    });
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

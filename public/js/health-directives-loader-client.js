(() => {
function directiveLoaderRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function directiveLoaderRows(value) {
    return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
}
function directiveLoaderEvidenceRows(value) {
    return directiveLoaderRows(directiveLoaderRecord(value).evidence);
}
async function directiveLoaderToggleEvidence(btn) {
    const box = btn.nextElementSibling;
    if (!box || !box.classList.contains("hb-evbox"))
        return;
    if (!btn.dataset.openLabel)
        btn.dataset.openLabel = btn.innerHTML;
    const opening = box.hidden;
    if (!opening) {
        box.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        btn.innerHTML = btn.dataset.openLabel;
        return;
    }
    btn.setAttribute("aria-expanded", "true");
    btn.textContent = "hide the evidence";
    box.hidden = false;
    if (box.dataset.loaded === "1") {
        box.classList.remove("chip-in");
        void box.offsetWidth;
        box.classList.add("chip-in");
        return;
    }
    box.innerHTML = `<div class="hb-ev-loading lbl"><span class="aspin aspin-xs"></span> reading the source…</div>`;
    let res = null;
    try {
        res = await api(`/evidence?marker=${encodeURIComponent(btn.dataset.evidence || "")}`);
    }
    catch {
        res = null;
    }
    if (box.hidden)
        return;
    box.dataset.loaded = "1";
    box.innerHTML = CairnHealthClient.evidenceListHtml(directiveLoaderEvidenceRows(res));
    if (!reducedMotion()) {
        box.classList.remove("chip-in");
        void box.offsetWidth;
        box.classList.add("chip-in");
    }
}
function directiveLoaderPaint(wrap, active, evSummary) {
    wrap.innerHTML = CairnHealthDirectives.directivesSectionHtml(active, evSummary);
    $("#hbDerive")?.addEventListener("click", directiveLoaderDerive);
    $("#hbResearchNudge")?.addEventListener("click", () => switchTab("settings"));
    wrap.querySelectorAll("[data-ddone]").forEach((b) => b.addEventListener("click", () => directiveLoaderResolve(b.dataset.ddone || "", "resolved")));
    wrap.querySelectorAll("[data-ddismiss]").forEach((b) => b.addEventListener("click", () => directiveLoaderResolve(b.dataset.ddismiss || "", "dismissed")));
    wrap.querySelectorAll("[data-evidence]").forEach((b) => b.addEventListener("click", () => { void directiveLoaderToggleEvidence(b); }));
}
async function directiveLoaderLoad(token) {
    const wrap = $("#hbDirectives");
    if (!wrap || !wrap.isConnected)
        return;
    let res = null, evSummary = null;
    try {
        [res, evSummary] = await Promise.all([
            api("/directives"),
            api("/evidence/summary").then((summary) => summary).catch(() => null),
        ]);
    }
    catch {
        res = null;
    }
    if (token !== pollToken || !wrap.isConnected)
        return;
    const all = directiveLoaderRows(directiveLoaderRecord(res).directives);
    const active = all.filter((d) => !d.status || d.status === "active");
    directiveLoaderPaint(wrap, active, evSummary);
}
async function directiveLoaderResolve(id, status) {
    if (!id)
        return;
    const card = $(`#hbDirectives .hb-directive[data-dir="${id}"]`);
    let res = null;
    try {
        res = await api(`/directives/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    }
    catch {
        res = null;
    }
    if (!directiveLoaderRecord(res).ok) {
        toast("Couldn't update");
        return;
    }
    toast(status === "resolved" ? "Marked done" : "Dismissed");
    const after = () => { void directiveLoaderLoad(pollToken); };
    if (card)
        collapseEl(card, after);
    else
        after();
}
async function directiveLoaderDerive() {
    const btn = $("#hbDerive");
    const restore = btnBusy(btn, "refreshing…");
    let res = null;
    try {
        res = await api("/directives/derive", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    }
    catch {
        res = null;
    }
    const row = directiveLoaderRecord(res);
    if (!row.ok) {
        toast("Couldn't refresh");
        restore();
        return;
    }
    toast(row.derived ? `Refreshed — ${row.derived} found` : "Up to date");
    void directiveLoaderLoad(pollToken);
}
const CAIRN_HEALTH_DIRECTIVE_LOADER = {
    load: directiveLoaderLoad,
};
Object.assign(globalThis, { CairnHealthDirectiveLoader: CAIRN_HEALTH_DIRECTIVE_LOADER });
if (typeof window !== "undefined") {
    window.CairnHealthDirectiveLoader = CAIRN_HEALTH_DIRECTIVE_LOADER;
}
})();

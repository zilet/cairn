(() => {
// ==== 08-me-records.js ====
// ====================================================================
// Evidence is inspectable — a calm "see the evidence" disclosure that lazy-fetches
// GET /api/evidence?marker= and lists the cited source(s): an outbound title link,
// a truncated body, the confidence word. INFORMATIONAL, not medical advice. Empty
// evidence ⇒ the citation string already shown stands alone (a quiet note here).
// ====================================================================
function isScreenRecord(value) {
    return !!value && typeof value === "object";
}
function screenRecord(value) {
    return isScreenRecord(value) ? value : {};
}
function screenRows(value) {
    return Array.isArray(value) ? value.filter(isScreenRecord) : [];
}
function inputValue(id) {
    return $("#" + id)?.value ?? "";
}
function trimmedInputValue(id) {
    const value = inputValue(id).trim();
    return value || null;
}
// ---- Markers tab: trends across every document ----
function paintHealthMarkersTab() {
    const c = $("#hContent");
    if (!c)
        return;
    c.innerHTML = `<div id="hMarkers">${skelLines(4)}</div>`;
    loadHealthMarkers(pollToken);
}
// ---- Share tab: clinician report + data portability ----
function openDoctorReportTab() {
    const url = withToken("/api/health-report");
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
        toast("Allow pop-ups to open the doctor report in a new tab");
        return;
    }
    try {
        tab.opener = null;
    }
    catch { }
    tab.location.href = url;
}
function paintHealthShareTab() {
    const c = $("#hContent");
    if (!c)
        return;
    const render = (res) => {
        const row = screenRecord(res);
        const markers = screenRows(row.markers);
        const groups = screenRows(row.groups);
        const count = markers.length;
        if (!count) {
            c.innerHTML = `<div class="empty-state reveal" style="${stagger(0)}">
        <div class="empty-state-line">Nothing to share yet</div>
        <div class="hpic-hero-sub">Add a lab report or DEXA scan first. The report will stay grouped by clinical panel once markers exist.</div>
        <button id="hShareToRecords" class="logbtn hpic-cta-btn">ADD A DOCUMENT</button>
      </div>`;
            $("#hShareToRecords")?.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
            return;
        }
        c.innerHTML = `<div class="hshare">
      <section class="hshare-card hshare-card-main reveal" style="${stagger(0)}">
        <div>
          <div class="lbl hshare-kicker">For your doctor</div>
          <h2 class="hshare-title">Clinical marker report</h2>
          <p class="hshare-copy">Grouped by clinical panel, with findings first, dated history, DEXA body composition when available, and a MyChart-ready copy view.</p>
          <div class="hshare-meta">${count} marker${count === 1 ? "" : "s"} · ${groups.length || 1} panel${(groups.length || 1) === 1 ? "" : "s"}</div>
        </div>
        <div class="hshare-actions">
          <button id="hReportBtn" class="logbtn">Open doctor report</button>
        </div>
      </section>
      <div class="hshare-grid">
        <section class="hshare-card reveal" style="${stagger(1)}">
          <div class="lbl hshare-kicker">Portable data</div>
          <h3 class="hshare-subtitle">Structured health export</h3>
          <p class="hshare-copy">A JSON snapshot for another tool: marker observations, history, supplements, and active connected-brain directives.</p>
          <button id="hExportBtn" class="ghostbtn">Download JSON</button>
        </section>
        <section class="hshare-card reveal" style="${stagger(2)}">
          <div class="lbl hshare-kicker">Data hygiene</div>
          <h3 class="hshare-subtitle">Align lab names</h3>
          <p class="hshare-copy">Merge obvious duplicate marker names from different labs so each trend stays one line.</p>
          <button id="hAlignBtn" class="ghostbtn">Align lab names</button>
        </section>
      </div>
    </div>`;
        $("#hReportBtn")?.addEventListener("click", openDoctorReportTab);
        $("#hExportBtn")?.addEventListener("click", () => {
            downloadFile(withToken("/api/health-export"));
            toast("Structured data downloaded");
        });
        $("#hAlignBtn")?.addEventListener("click", async (e) => {
            const btn = e.currentTarget instanceof Element ? e.currentTarget : null;
            const restore = btnBusy(btn, "aligning…");
            let r = null;
            try {
                r = await api("/markers/reconcile", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            }
            catch {
                r = null;
            }
            restore();
            const out = screenRecord(r);
            const aligned = Number(out.aligned) || 0;
            if (!out || out.ok === false) {
                toast("Couldn't align right now — try again in a bit.");
                return;
            }
            toast(aligned ? `Merged ${aligned} duplicate marker${aligned === 1 ? "" : "s"}` : "Already aligned");
            if (aligned)
                swrInvalidate("markers:priority");
        });
    };
    const peek = peekCached("markers:priority");
    if (peek)
        render(peek.data);
    else
        c.innerHTML = `<div class="hshare">${skelLines(4)}</div>`;
    cachedApi("/markers/priority", {
        key: "markers:priority",
        onUpgrade: (data, { changed }) => { if (changed || !peek)
            render(data); },
    }).catch(() => { if (!peek)
        render(null); });
}
function healthMarkersEmptyHtml() {
    return CairnHealthClient.markersEmptyHtml(CairnHealthClient.HEALTH_HERO_ART);
}
// ---- Records tab: upload affordance + the document list ----
function paintHealthRecordsTab() {
    void CairnHealthRecordsController.render(healthRecordsDeps());
}
// ---- Learned tab: the legible "what Cairn has understood about you" timeline ----
// A calm history you VISIT (pull-only, never a notification). It EXPLAINS what
// Cairn has understood and changed — it does NOT GRADE: no scores, no accuracy %,
// no judgment. A quiet editorial read, grouped by kind under plain-language
// kickers, newest-first within each group. Reads GET /api/learned-timeline only.
function renderLearnedTimeline(data, token) {
    const c = $("#hContent");
    if (!c || token !== pollToken)
        return; // a sibling tab repainted while we fetched
    c.innerHTML = learnedTimelineHtml(data);
    $("#learnedToMemory")?.addEventListener("click", () => withViewTransition(() => renderMemory().then(viewEnter)));
}
function paintHealthLearnedTab() {
    const c = $("#hContent");
    if (!c)
        return;
    const token = pollToken;
    c.innerHTML = `<div id="hLearned">${skelLines(4)}</div>`;
    api("/learned-timeline")
        .then((data) => renderLearnedTimeline(data || { items: [] }, token))
        .catch(() => renderLearnedTimeline({ items: [] }, token));
}
function healthRecordsDeps() {
    return {
        state,
        api,
        toast,
        armDelete,
        pollEnrichment,
        enrichmentActive,
        pollToken: () => pollToken,
        loadHealthMarkers,
        paintHealthPicture,
        getHealthPictureCache,
        setHealthPictureCache,
    };
}
// ---------- Me: Life (trips / injuries / life events) ----------
// Pure Life timeline renderers live in life-client.js.
async function renderLife() {
    headerTitle.textContent = "Me";
    state.meSeg = "life";
    pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
    view.innerHTML = segBar("life", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Trips, injuries, and life events. The coach factors these into the workout you see — easing off around travel or an injury.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">Add to your timeline</h1>
    <div class="lifeadd">
      <div class="field" style="margin-bottom:9px"><label for="lKind">Kind</label>
        <select id="lKind" name="lKind" class="selflex">${CairnLife.lifeKindOptionsHtml()}</select>
      </div>
      <div id="lFields"></div>
      <button id="lAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
      <div id="lStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Timeline</h1>
    <div id="llist"></div>`;
    wireSeg(ME_HANDLERS);
    const kindSel = $("#lKind");
    if (!kindSel)
        return;
    kindSel.addEventListener("change", () => drawLifeFields(kindSel.value));
    drawLifeFields(kindSel.value);
    $("#lAdd")?.addEventListener("click", submitLifeEvent);
    loadLifeEvents();
}
// Render the kind-specific add fields into #lFields.
function drawLifeFields(kind) {
    const wrap = $("#lFields");
    if (!wrap)
        return;
    wrap.innerHTML = CairnLife.lifeFieldsHtml(kind);
}
function collectLifeForm() {
    const kind = inputValue("lKind");
    const title = trimmedInputValue("lTitle");
    const detail = trimmedInputValue("lDetail");
    const start_date = trimmedInputValue("lStart");
    const end_date = trimmedInputValue("lEnd");
    const meta = {};
    if (kind === "trip") {
        const loc = trimmedInputValue("lLocation");
        if (loc)
            meta.location = loc;
    }
    else if (kind === "injury") {
        const area = trimmedInputValue("lArea");
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
async function submitLifeEvent() {
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
        const r = screenRecord(await api("/context-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
        if (r.error) {
            status.textContent = "Couldn't save that — try again.";
            return;
        }
        status.textContent = "";
        toast("Added");
        // reset the text + dates but keep the kind
        drawLifeFields(inputValue("lKind"));
        loadLifeEvents();
    }
    catch {
        status.textContent = "Couldn't save that — check your connection.";
    }
    finally {
        btn.disabled = false;
    }
}
async function loadLifeEvents() {
    const wrap = $("#llist");
    if (!wrap)
        return;
    let events = [];
    // Fetch the timeline and the structured injury impacts together. Impacts are a
    // calm enhancement on active injuries — if the read fails, the cards still draw.
    let impacts = null;
    try {
        const [eventRows, impactRows] = await Promise.all([
            api("/context-events"),
            api("/injury-impacts").catch(() => null),
        ]);
        events = screenRows(eventRows);
        impacts = impactRows;
    }
    catch {
        events = [];
    }
    if (state.tab !== "me" || state.meSeg !== "life" || !wrap.isConnected)
        return;
    if (!events || !events.length) {
        wrap.innerHTML = `<div class="empty">Nothing on your timeline yet.</div>`;
        return;
    }
    const impactsById = {};
    for (const inj of screenRows(screenRecord(impacts).injuries)) {
        impactsById[String(inj.id)] = inj;
    }
    // active/upcoming first (sorted by soonest start), then past/archived
    const active = events.filter((e) => CairnLife.eventActive(e));
    const past = events.filter((e) => !CairnLife.eventActive(e));
    const byStart = (a, b) => (a.start_date || "9999") < (b.start_date || "9999") ? -1 : 1;
    active.sort(byStart);
    past.sort((a, b) => byStart(b, a)); // most recent past first
    state._lifeById = Object.fromEntries(events.map((e) => [String(e.id), e]));
    wrap.innerHTML = [...active, ...past].map((ev, i) => CairnLife.lifeEventHtml(ev, i, impactsById)).join("");
    wrap.querySelectorAll("[data-ledit]").forEach((b) => b.addEventListener("click", () => startLifeEdit(b.closest(".life-ev"))));
    wrap.querySelectorAll("[data-ldel]").forEach((b) => b.addEventListener("click", () => startLifeDelete(b)));
}
// Inline edit: swap the card body for a compact editable form.
function startLifeEdit(card) {
    if (!card || card.querySelector(".life-edit"))
        return;
    const id = card.dataset.life;
    if (!id)
        return;
    const ev = screenRecord((state._lifeById || {})[id]);
    if (!ev.id)
        return;
    const meta = CairnLife.parsedMeta(ev);
    const metaField = ev.kind === "trip"
        ? `<input class="le-meta form-input" name="life_location" aria-label="Location" placeholder="Location" value="${escAttr(meta.location || "")}">`
        : ev.kind === "injury"
            ? `<input class="le-meta form-input" name="life_area" aria-label="Area" placeholder="Area" value="${escAttr(meta.area || "")}">`
            : "";
    const box = document.createElement("div");
    box.className = "life-edit";
    box.innerHTML = `
    <input class="le-title form-input" name="life_title" aria-label="Title" placeholder="Title" value="${escAttr(ev.title || "")}">
    ${metaField}
    <div class="ob-grid" style="margin-top:6px">
      <input class="le-start form-input" name="life_start" aria-label="Start" type="date" value="${escAttr(ev.start_date || "")}">
      <input class="le-end form-input" name="life_end" aria-label="End" type="date" value="${escAttr(ev.end_date || "")}">
    </div>
    <input class="le-detail form-input" name="life_detail" aria-label="Detail" placeholder="Detail" value="${escAttr(ev.detail || "")}">
    <div class="life-edit-ctl">
      <button class="iconbtn memok le-save" title="save">✓</button>
      <button class="iconbtn le-cancel" title="cancel">×</button>
    </div>`;
    const prev = card.innerHTML;
    card.innerHTML = "";
    card.appendChild(box);
    box.querySelector(".le-title")?.focus();
    const cancel = () => { card.innerHTML = prev; rewireLifeCard(card); };
    const save = async () => {
        const v = (cls) => {
            const el = box.querySelector(cls);
            return el && el.value.trim() ? el.value.trim() : null;
        };
        const title = v(".le-title");
        if (!title) {
            box.querySelector(".le-title")?.focus();
            return;
        }
        const newMeta = { ...meta };
        const metaEl = box.querySelector(".le-meta");
        if (metaEl) {
            const mv = metaEl.value.trim();
            if (ev.kind === "trip")
                newMeta.location = mv || undefined;
            else if (ev.kind === "injury")
                newMeta.area = mv || undefined;
        }
        try {
            await api(`/context-events/${id}`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: ev.kind, title, detail: v(".le-detail"), start_date: v(".le-start"), end_date: v(".le-end"), meta: newMeta }),
            });
        }
        catch {
            toast("Couldn't save that — try again.");
            return;
        }
        toast("Updated");
        loadLifeEvents();
    };
    box.querySelector(".le-save")?.addEventListener("click", save);
    box.querySelector(".le-cancel")?.addEventListener("click", cancel);
}
function rewireLifeCard(card) {
    const e = card.querySelector("[data-ledit]");
    if (e)
        e.addEventListener("click", () => startLifeEdit(card));
    const d = card.querySelector("[data-ldel]");
    if (d)
        d.addEventListener("click", () => startLifeDelete(d));
}
// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startLifeDelete(btn) {
    const row = btn.closest(".life-ev");
    if (!(row instanceof HTMLElement))
        return;
    const id = row.dataset.life;
    if (!id)
        return;
    armDelete(btn, () => {
        api(`/context-events/${id}`, { method: "DELETE" })
            .then(() => { toast("Removed"); loadLifeEvents(); })
            .catch(() => toast("Couldn't remove that — try again."));
    });
}
// ---------- Me: Family (the people the coach plans around) ----------
// Family is warm context, not surveillance: who's in your life, so the buddy
// plans around the school run and the 6am-with-kids reality. Recurring
// commitments (soccer Tuesdays) live on the Life timeline as family_event
// context_events — this roster is the people, not their calendar.
// Pure Family card/swatch renderers live in family-client.js.
async function renderFamily() {
    headerTitle.textContent = "Me";
    state.meSeg = "family";
    pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
    view.innerHTML = segBar("family", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      The people in your life, so the coach plans around them — never the hardest session on the chaos day. Recurring commitments like the school run or a kid's soccer night live on your <button class="linkbtn" id="famToLife">Life timeline</button> as events.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">Add someone</h1>
    <div class="lifeadd famadd">
      <div class="field" style="margin-bottom:9px"><label for="fName">Name</label>
        <input id="fName" name="fName" type="text" placeholder="e.g. Mara" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label for="fRel">Relationship (optional)</label>
        <input id="fRel" name="fRel" type="text" placeholder="e.g. daughter / partner" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label for="fBirth">Birthday (optional)</label>
        <input id="fBirth" name="fBirth" type="date" max="${localISO()}" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><span class="field-label">Colour</span>${CairnFamily.familySwatches(CairnFamily.FAMILY_DEFAULT_COLOR)}</div>
      <div class="field" style="margin-bottom:9px"><label for="fNotes">Notes (optional)</label>
        <input id="fNotes" name="fNotes" type="text" placeholder="e.g. trains with me on weekends" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label for="fAllergy">Allergies (optional)</label>
        <input id="fAllergy" name="fAllergy" type="text" placeholder="e.g. peanuts, shellfish" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label for="fDiet">Dietary needs (optional)</label>
        <input id="fDiet" name="fDiet" type="text" placeholder="e.g. vegetarian, no pork" class="form-input"></div>
      <button id="fAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
      <div id="fStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Your people</h1>
    <div id="flist"></div>`;
    wireSeg(ME_HANDLERS);
    $("#famToLife")?.addEventListener("click", () => withViewTransition(() => renderLife().then(viewEnter)));
    // swatch picker (add form)
    let addColor = CairnFamily.FAMILY_DEFAULT_COLOR;
    view.querySelectorAll(".famadd .fam-swatch").forEach((b) => b.addEventListener("click", () => {
        addColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
        view.querySelectorAll(".famadd .fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
    }));
    $("#fAdd")?.addEventListener("click", async () => {
        const status = $("#fStatus");
        const nameInput = $("#fName");
        if (!status || !nameInput)
            return;
        const name = nameInput.value.trim();
        if (!name) {
            status.textContent = "Add a name first.";
            nameInput.focus();
            return;
        }
        const body = {
            name,
            relationship: $("#fRel")?.value.trim() || null,
            birthdate: $("#fBirth")?.value || null,
            color: addColor,
            notes: $("#fNotes")?.value.trim() || null,
            allergies: $("#fAllergy")?.value.trim() || null,
            dietary_restrictions: $("#fDiet")?.value.trim() || null,
        };
        const btn = $("#fAdd");
        if (!btn)
            return;
        btn.disabled = true;
        try {
            const r = screenRecord(await api("/family", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
            if (r.error) {
                status.textContent = "Couldn't save that — try again.";
                return;
            }
            status.textContent = "";
            toast("Added");
            nameInput.value = "";
            const rel = $("#fRel");
            if (rel)
                rel.value = "";
            const birth = $("#fBirth");
            if (birth)
                birth.value = "";
            const notes = $("#fNotes");
            if (notes)
                notes.value = "";
            const allergy = $("#fAllergy");
            if (allergy)
                allergy.value = "";
            const diet = $("#fDiet");
            if (diet)
                diet.value = "";
            loadFamily();
        }
        catch {
            status.textContent = "Couldn't save that — check your connection.";
        }
        finally {
            btn.disabled = false;
        }
    });
    loadFamily();
}
async function loadFamily() {
    const wrap = $("#flist");
    if (!wrap)
        return;
    let people = [];
    try {
        people = screenRows(await api("/family"));
    }
    catch {
        people = [];
    }
    if (state.tab !== "me" || state.meSeg !== "family" || !wrap.isConnected)
        return;
    if (!Array.isArray(people) || !people.length) {
        wrap.innerHTML = `<div class="empty">No one here yet. Add the people you plan your weeks around.</div>`;
        return;
    }
    state._famById = Object.fromEntries(people.map((f) => [String(f.id), f]));
    wrap.innerHTML = people.map((f, i) => CairnFamily.familyCardHtml(f, i)).join("");
    wrap.querySelectorAll("[data-fedit]").forEach((b) => b.addEventListener("click", () => startFamilyEdit(b.closest(".fam-card"))));
    wrap.querySelectorAll("[data-fdel]").forEach((b) => b.addEventListener("click", () => startFamilyDelete(b)));
}
// Inline edit: swap the card body for a compact editable form (mirrors Life's pattern).
function startFamilyEdit(card) {
    if (!card || card.querySelector(".fam-edit"))
        return;
    const id = card.dataset.fam;
    if (!id)
        return;
    const f = screenRecord((state._famById || {})[id]);
    if (!f.id)
        return;
    let editColor = CairnFamily.familyColor(f.color);
    const box = document.createElement("div");
    box.className = "fam-edit";
    box.innerHTML = `
    <input class="fe-name form-input" name="family_name" aria-label="Name" placeholder="Name" value="${escAttr(f.name || "")}">
    <input class="fe-rel form-input" name="family_relationship" aria-label="Relationship" placeholder="Relationship" value="${escAttr(f.relationship || "")}">
    <input class="fe-birth form-input" name="family_birthdate" aria-label="Birthday" type="date" max="${localISO()}" value="${escAttr(f.birthdate || "")}">
    ${CairnFamily.familySwatches(editColor)}
    <input class="fe-notes form-input" name="family_notes" aria-label="Notes" placeholder="Notes" value="${escAttr(f.notes || "")}">
    <input class="fe-allergy form-input" name="family_allergies" aria-label="Allergies" placeholder="Allergies" value="${escAttr(f.allergies || "")}">
    <input class="fe-diet form-input" name="family_dietary_needs" aria-label="Dietary needs" placeholder="Dietary needs" value="${escAttr(f.dietary_restrictions || "")}">
    <div class="life-edit-ctl">
      <button class="iconbtn memok fe-save" title="save">✓</button>
      <button class="iconbtn fe-cancel" title="cancel">×</button>
    </div>`;
    const prev = card.innerHTML;
    card.innerHTML = "";
    card.appendChild(box);
    box.querySelector(".fe-name")?.focus();
    box.querySelectorAll(".fam-swatch").forEach((b) => b.addEventListener("click", () => {
        editColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
        box.querySelectorAll(".fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
    }));
    const cancel = () => { card.innerHTML = prev; rewireFamilyCard(card); };
    const save = async () => {
        const v = (cls) => {
            const el = box.querySelector(cls);
            return el && el.value.trim() ? el.value.trim() : null;
        };
        const name = v(".fe-name");
        if (!name) {
            box.querySelector(".fe-name")?.focus();
            return;
        }
        try {
            await api(`/family/${id}`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, relationship: v(".fe-rel"), birthdate: v(".fe-birth"), color: editColor, notes: v(".fe-notes"), allergies: v(".fe-allergy"), dietary_restrictions: v(".fe-diet") }),
            });
        }
        catch {
            toast("Couldn't save that — try again.");
            return;
        }
        toast("Updated");
        loadFamily();
    };
    box.querySelector(".fe-save")?.addEventListener("click", save);
    box.querySelector(".fe-cancel")?.addEventListener("click", cancel);
}
function rewireFamilyCard(card) {
    const e = card.querySelector("[data-fedit]");
    if (e)
        e.addEventListener("click", () => startFamilyEdit(card));
    const d = card.querySelector("[data-fdel]");
    if (d)
        d.addEventListener("click", () => startFamilyDelete(d));
}
// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startFamilyDelete(btn) {
    const row = btn.closest(".fam-card");
    if (!(row instanceof HTMLElement))
        return;
    const id = row.dataset.fam;
    if (!id)
        return;
    armDelete(btn, () => {
        api(`/family/${id}`, { method: "DELETE" })
            .then(() => { toast("Removed"); loadFamily(); })
            .catch(() => toast("Couldn't remove that — try again."));
    });
}
Object.assign(globalThis, {
    healthMarkersEmptyHtml,
    loadHealthDocs,
    paintHealthLearnedTab,
    paintHealthMarkersTab,
    paintHealthRecordsTab,
    paintHealthShareTab,
    renderFamily,
    renderLife,
});
})();

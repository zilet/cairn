// ==== 08-me-records.js ====
// ====================================================================
// Evidence is inspectable — a calm "see the evidence" disclosure that lazy-fetches
// GET /api/evidence?marker= and lists the cited source(s): an outbound title link,
// a truncated body, the confidence word. INFORMATIONAL, not medical advice. Empty
// evidence ⇒ the citation string already shown stands alone (a quiet note here).
// ====================================================================

type FamilyMember = import("../contracts/client-api.js").ClientFamilyMember;
type LearnedTimelineData = import("../contracts/client-api.js").ClientLearnedTimeline;
type ScreenRecord = Record<string, unknown>;

function isScreenRecord(value: unknown): value is ScreenRecord {
  return !!value && typeof value === "object";
}

function screenRecord(value: unknown): ScreenRecord {
  return isScreenRecord(value) ? value : {};
}

function screenRows<T extends ScreenRecord = ScreenRecord>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter(isScreenRecord) as T[] : [];
}

// ---- Markers tab: trends across every document ----
function paintHealthMarkersTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `<div id="hMarkers">${skelLines(4)}</div>`;
  loadHealthMarkers(pollToken);
}

// ---- Share tab: clinician report + data portability ----
function healthShareDeps(): ClientHealthShareControllerDeps {
  return {
    root: view,
    api,
    cachedApi,
    peekCached,
    swrInvalidate,
    toast,
    btnBusy,
    downloadFile,
    select: $,
    stagger,
    switchHealthSeg,
    withToken,
  };
}

function paintHealthShareTab() {
  CairnHealthShareController.render(healthShareDeps());
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
function renderLearnedTimeline(data: LearnedTimelineData | null | undefined, token: number) {
  const c = $("#hContent");
  if (!c || token !== pollToken) return; // a sibling tab repainted while we fetched
  c.innerHTML = learnedTimelineHtml(data);
  $("#learnedToMemory")?.addEventListener("click", () => withViewTransition(() => renderMemory().then(viewEnter)));
}

function paintHealthLearnedTab() {
  const c = $("#hContent");
  if (!c) return;
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
// Pure Life timeline renderers live in life-client.js; workflow wiring lives in
// life-controller.js. Keep this route bridge stable for the rest of the app.

function lifeControllerDeps(): ClientLifeControllerDeps {
  return {
    view,
    state,
    segments: ME_SEG,
    handlers: ME_HANDLERS,
    headerTitle,
    api,
    armDelete,
    escapeAttr: escAttr,
    invalidatePoll: () => { pollToken++; },
    segBar,
    toast,
    wireSeg,
  };
}

async function renderLife() {
  return CairnLifeController.render(lifeControllerDeps());
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
  view.querySelectorAll<HTMLElement>(".famadd .fam-swatch").forEach((b) => b.addEventListener("click", () => {
    addColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
    view.querySelectorAll(".famadd .fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
  }));

  $<HTMLButtonElement>("#fAdd")?.addEventListener("click", async () => {
    const status = $("#fStatus");
    const nameInput = $<HTMLInputElement>("#fName");
    if (!status || !nameInput) return;
    const name = nameInput.value.trim();
    if (!name) { status.textContent = "Add a name first."; nameInput.focus(); return; }
    const body = {
      name,
      relationship: $<HTMLInputElement>("#fRel")?.value.trim() || null,
      birthdate: $<HTMLInputElement>("#fBirth")?.value || null,
      color: addColor,
      notes: $<HTMLInputElement>("#fNotes")?.value.trim() || null,
      allergies: $<HTMLInputElement>("#fAllergy")?.value.trim() || null,
      dietary_restrictions: $<HTMLInputElement>("#fDiet")?.value.trim() || null,
    };
    const btn = $<HTMLButtonElement>("#fAdd");
    if (!btn) return;
    btn.disabled = true;
    try {
      const r = screenRecord(await api("/family", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (r.error) { status.textContent = "Couldn't save that — try again."; return; }
      status.textContent = "";
      toast("Added");
      nameInput.value = "";
      const rel = $<HTMLInputElement>("#fRel"); if (rel) rel.value = "";
      const birth = $<HTMLInputElement>("#fBirth"); if (birth) birth.value = "";
      const notes = $<HTMLInputElement>("#fNotes"); if (notes) notes.value = "";
      const allergy = $<HTMLInputElement>("#fAllergy"); if (allergy) allergy.value = "";
      const diet = $<HTMLInputElement>("#fDiet"); if (diet) diet.value = "";
      loadFamily();
    } catch { status.textContent = "Couldn't save that — check your connection."; }
    finally { btn.disabled = false; }
  });

  loadFamily();
}

async function loadFamily() {
  const wrap = $("#flist");
  if (!wrap) return;
  let people: FamilyMember[] = [];
  try { people = screenRows<FamilyMember>(await api("/family")); } catch { people = []; }
  if (state.tab !== "me" || state.meSeg !== "family" || !wrap.isConnected) return;
  if (!Array.isArray(people) || !people.length) {
    wrap.innerHTML = `<div class="empty">No one here yet. Add the people you plan your weeks around.</div>`;
    return;
  }
  state._famById = Object.fromEntries(people.map((f) => [String(f.id), f]));
  wrap.innerHTML = people.map((f, i) => CairnFamily.familyCardHtml(f, i)).join("");
  wrap.querySelectorAll<HTMLElement>("[data-fedit]").forEach((b) => b.addEventListener("click", () => startFamilyEdit(b.closest<HTMLElement>(".fam-card"))));
  wrap.querySelectorAll<HTMLElement>("[data-fdel]").forEach((b) => b.addEventListener("click", () => startFamilyDelete(b)));
}

// Inline edit: swap the card body for a compact editable form (mirrors Life's pattern).
function startFamilyEdit(card: HTMLElement | null) {
  if (!card || card.querySelector(".fam-edit")) return;
  const id = card.dataset.fam;
  if (!id) return;
  const f = screenRecord((state._famById || {})[id]) as FamilyMember;
  if (!f.id) return;
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
  box.querySelector<HTMLInputElement>(".fe-name")?.focus();
  box.querySelectorAll<HTMLElement>(".fam-swatch").forEach((b) => b.addEventListener("click", () => {
    editColor = b.dataset.color || CairnFamily.FAMILY_DEFAULT_COLOR;
    box.querySelectorAll(".fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
  }));

  const cancel = () => { card.innerHTML = prev; rewireFamilyCard(card); };
  const save = async () => {
    const v = (cls: string) => {
      const el = box.querySelector<HTMLInputElement>(cls);
      return el && el.value.trim() ? el.value.trim() : null;
    };
    const name = v(".fe-name");
    if (!name) { box.querySelector<HTMLInputElement>(".fe-name")?.focus(); return; }
    try {
      await api(`/family/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, relationship: v(".fe-rel"), birthdate: v(".fe-birth"), color: editColor, notes: v(".fe-notes"), allergies: v(".fe-allergy"), dietary_restrictions: v(".fe-diet") }),
      });
    } catch { toast("Couldn't save that — try again."); return; }
    toast("Updated"); loadFamily();
  };
  box.querySelector<HTMLButtonElement>(".fe-save")?.addEventListener("click", save);
  box.querySelector<HTMLButtonElement>(".fe-cancel")?.addEventListener("click", cancel);
}

function rewireFamilyCard(card: HTMLElement) {
  const e = card.querySelector("[data-fedit]"); if (e) e.addEventListener("click", () => startFamilyEdit(card));
  const d = card.querySelector("[data-fdel]"); if (d) d.addEventListener("click", () => startFamilyDelete(d));
}

// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startFamilyDelete(btn: Element) {
  const row = btn.closest(".fam-card");
  if (!(row instanceof HTMLElement)) return;
  const id = row.dataset.fam;
  if (!id) return;
  armDelete(btn, () => {
    api(`/family/${id}`, { method: "DELETE" })
      .then(() => { toast("Removed"); loadFamily(); })
      .catch(() => toast("Couldn't remove that — try again."));
  });
}

Object.assign(globalThis, {
  healthMarkersEmptyHtml,
  loadHealthDocs: () => CairnHealthRecordsController.loadDocs(healthRecordsDeps()),
  paintHealthLearnedTab,
  paintHealthMarkersTab,
  paintHealthRecordsTab,
  paintHealthShareTab,
  renderFamily,
  renderLife,
});

// ==== 08-me-records.js ====
// ====================================================================
// Evidence is inspectable — a calm "see the evidence" disclosure that lazy-fetches
// GET /api/evidence?marker= and lists the cited source(s): an outbound title link,
// a truncated body, the confidence word. INFORMATIONAL, not medical advice. Empty
// evidence ⇒ the citation string already shown stands alone (a quiet note here).
// ====================================================================

type LearnedTimelineData = import("../contracts/client-api.js").ClientLearnedTimeline;

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
// Pure Family card/swatch renderers live in family-client.js; workflow wiring
// lives in family-controller.js. Keep this route bridge stable for the app.

function familyControllerDeps(): ClientFamilyControllerDeps {
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
    localISO,
    segBar,
    toast,
    viewEnter,
    wireSeg,
    withViewTransition,
    renderLife,
  };
}

async function renderFamily() {
  return CairnFamilyController.render(familyControllerDeps());
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

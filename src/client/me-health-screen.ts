// ==== 07-me-health.js ====
{
type HealthScreenRecord = Record<string, unknown>;
type HealthStandingRead = import("../contracts/client-api.js").ClientHealthStanding;
type HealthReviewRecord = HealthScreenRecord & { created_at?: string; error?: unknown };
type WiredHealthElement<T extends HTMLElement = HTMLElement> = T & { _wired?: boolean };

function healthScreenRecord(value: unknown): HealthScreenRecord {
  return value && typeof value === "object" ? (value as HealthScreenRecord) : {};
}

function healthScreenRows<T extends HealthScreenRecord = HealthScreenRecord>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((row) => !!row && typeof row === "object") as T[]) : [];
}

function healthInput(selector: string, root: ParentNode = document): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(selector);
}

function healthInputValue(selector: string, root: ParentNode = document): string {
  return healthInput(selector, root)?.value ?? "";
}

// ---------- Me (segmented: Profile / Memory / Health / Life) ----------
// Standing leads — Me opens to the REVIEW (where you stand + where to focus), not a
// data-entry form. The lab DATA (Health), identity (Profile), life, family and the
// curated Memory follow it: review first, entering/updating second.
const ME_SEG: readonly ClientSegment[] = [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"], ["life", "Life"], ["family", "Family"], ["memory", "Memory"]];
// Lazy handler refs (arrow-wrapped like PROGRESS_HANDLERS/PLAN_HANDLERS): renderLife and
// renderFamily live in a later-loaded module, so bare references would resolve at parse
// time — before that script runs — and throw. Arrows defer resolution to call time, by
// which point every module is loaded. wireSeg/renderMe call handlers with no args.
const ME_HANDLERS: Record<ClientMeSection, () => unknown> = { standing: () => renderMeStanding(), profile: () => renderMeProfile(), memory: () => renderMemory(), health: () => renderHealth(), life: () => renderLife(), family: () => renderFamily() };
function renderMe() {
  headerTitle.textContent = "Me";
  pollToken++; // invalidate in-flight enrichment polls
  if (!state.meSeg) state.meSeg = "standing";
  return (ME_HANDLERS[state.meSeg] || renderMeStanding)();
}

// True when the Health → Read depth view is live — the whole-picture loaders
// (picture/synthesis/recovery/directives/markers/supplements) gate on this so a
// late async response never paints into a sibling tab.
function onHealthReadView() {
  return state.tab === "me" && state.meSeg === "health" && state.healthSeg === "read";
}

// The Standing review — the FIRST thing Me opens to. It leads with the conductor's
// whole-athlete "Where to focus" card (the cross-domain lead, tapping through to the
// plan), then the detailed where-you-stand health read below.
async function renderMeStanding() {
  headerTitle.textContent = "Me";
  state.meSeg = "standing";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("standing", ME_SEG)
    + `<div class="cfocus-slot cfocus-standing-slot" id="cfocusStandingSlot"></div>`
    + `<div id="hContent"></div>`;
  wireSeg(ME_HANDLERS);
  loadCoachingFocus("#cfocusStandingSlot", view); // the whole-athlete lead → planning
  paintStandingReview(); // the detailed where-you-stand health read
}

function healthNumberValue(selector: string, root: ParentNode = document): number | null {
  const raw = healthInputValue(selector, root);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function healthTextAreaValue(selector: string, root: ParentNode = document): string {
  return root.querySelector<HTMLTextAreaElement>(selector)?.value ?? "";
}

function meProfileDeps(): MeProfileControllerDeps {
  return {
    root: view,
    state,
    segments: ME_SEG,
    handlers: ME_HANDLERS as Record<string, () => unknown>,
    headerTitle,
    api,
    activateTab,
    escapeAttr: escAttr,
    escapeHtml: escHtml,
    inputValue: healthInputValue,
    invalidatePoll: () => { pollToken++; },
    mountSaveBar,
    numberValue: healthNumberValue,
    primaryDiscipline: () => primaryDiscipline,
    renderMe,
    renderProfile: () => renderMeProfile(),
    segBar,
    segSkeleton,
    setDiscipline,
    setEnduranceGoalSet,
    skeletonSwap: skelSwap,
    swrInvalidate,
    textAreaValue: healthTextAreaValue,
    toast,
    wireSeg,
    select: $,
  };
}

async function renderMeProfile() {
  return CairnMeProfileController.renderProfile(meProfileDeps());
}

// Pure food-note parsing/rendering lives in food-note-client.js; the food detail
// modal is owned by food-detail-controller.js.

// tap a note card → full-screen food detail (zooming from its art tile)
function wireNoteCard(el: Element): void {
  const card = el as WiredHealthElement;
  if (!card || card._wired) return; card._wired = true;
  card.addEventListener("click", (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("button, a, input")) return;
    const n = (state._notesById || {})[card.dataset.noteid || ""];
    if (n) openFoodDetail(n, card.querySelector(".artile"));
  });
}

function renderNotes(notes: unknown): void {
  const wrap = $<HTMLElement>("#notelist");
  if (!wrap) return;
  const rows = healthScreenRows(notes);
  if (!rows.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Snap a plate or jot a meal in Chat and it shows up here.</div>`; return; }
  state._notesById = Object.fromEntries(rows.map((n) => [String(n.id), n]));
  wrap.innerHTML = rows.map((n, i) => CairnFoodNote.noteEntryHtml(n, i)).join("");
  wrap.querySelectorAll(".fnent").forEach(wireNoteCard);
}

function renderActs(acts: unknown): void {
  const wrap = $<HTMLElement>("#actlist");
  if (!wrap) return;
  const rows = healthScreenRows(acts) as Array<import("../contracts/client.js").ClientActivity & HealthScreenRecord>;
  if (!rows.length) { wrap.innerHTML = `<div class="empty">Nothing logged yet. Log a ride, run, or walk on Today and it lands here.</div>`; return; }
  wrap.innerHTML = rows.map((a) => actEntryHtml(a)).join("");
}

function meMemoryDeps(): ClientMeMemoryControllerDeps {
  return {
    view,
    state,
    segments: ME_SEG,
    handlers: ME_HANDLERS as Record<string, () => unknown>,
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

async function renderMemory() {
  return CairnMeMemoryController.render(meMemoryDeps());
}

// ---------- Me: Health — the whole picture (review · markers · records) ----------
let _hReadSpy: IntersectionObserver | null = null;    // scroll-spy IntersectionObserver for the Read tab's sticky nav

function healthReadDeps(): ClientHealthReadControllerDeps {
  return {
    root: view,
    state,
    api,
    cachedApi,
    peekCached,
    markRefreshing,
    swrInvalidate,
    runOp,
    toast,
    pollToken: () => pollToken,
    select: $,
    escapeAttr: escAttr,
    escapeHtml: escHtml,
    relTime,
    stagger,
    reducedMotion,
    switchHealthSeg,
    isHealthReviewRunning: () => CairnHealthPictureController.isHealthReviewRunning(),
    loadHealthPicture: (token, docsPromise) => loadHealthPicture(token, docsPromise),
    paintHealthPicture,
    setReadSpy: (spy) => { _hReadSpy = spy; },
    teardownReadSpy: () => {
      if (_hReadSpy) {
        _hReadSpy.disconnect();
        _hReadSpy = null;
      }
    },
  };
}

function healthPictureDeps() {
  return {
    root: view,
    state,
    api,
    toast,
    switchHealthSeg,
    onHealthReadView,
    pollToken: () => pollToken,
    escapeHtml: escHtml,
    storage: typeof localStorage !== "undefined" ? localStorage : null,
  };
}

function getHealthPictureCache(): ClientHealthPictureCache | null {
  return CairnHealthPictureController.getHealthPictureCache();
}

function setHealthPictureCache(cache: ClientHealthPictureCache | null): ClientHealthPictureCache | null {
  return CairnHealthPictureController.setHealthPictureCache(cache);
}

function parsedReview(r: { parsed?: unknown; error?: unknown } | null | undefined): Record<string, unknown> | null {
  return CairnHealthPicture.parsedReview(r);
}

function healthDotClass(flag: unknown): string {
  return CairnHealthPicture.healthDotClass(flag);
}

function reviewBusyHtml(): string {
  return CairnHealthPicture.reviewBusyHtml();
}

function healthHeroHtml(err: unknown): string {
  return CairnHealthPicture.healthHeroHtml(err);
}

function buildPictureHtml(err: unknown, docCount: unknown): string {
  return CairnHealthPicture.buildPictureHtml(err, docCount);
}

function reviewHtml(review: HealthReviewRecord, stale: unknown, err: unknown): string {
  return CairnHealthPicture.reviewHtml(review, stale, err);
}

function paintHealthPicture(): void {
  CairnHealthPictureController.paintHealthPicture(healthPictureDeps());
}

async function runHealthReview(): Promise<void> {
  await CairnHealthPictureController.runHealthReview(healthPictureDeps());
}

async function loadHealthPicture(token: number, docsP: Promise<unknown>): Promise<void> {
  await CairnHealthPictureController.loadHealthPicture(token, docsP, healthPictureDeps());
}

function healthMarkersDeps(): ClientHealthMarkersControllerDeps {
  return {
    root: view,
    cachedApi,
    peekCached,
    markRefreshing,
    pollToken: () => pollToken,
    relAge,
    select: $,
    stagger,
    switchHealthSeg,
    escapeHtml: escHtml,
  };
}

function loadHealthMarkers(token: number): void {
  CairnHealthMarkersController.load(healthMarkersDeps(), token);
}

// Health's inner views. The whole-picture DEPTH (synthesis + connected brain) used to
// be inlined under the top-level Standing review, ballooning it to ~8 screens. It now
// lives here as its own "Read" sub-tab, one tap from the review, with an in-page jump
// nav so you can land on what you want instead of scrolling the whole story:
//   • read    — "Read": the whole-picture synthesis + the connected-brain directives,
//               recovery, what-matters-now markers, symptom links and supplements,
//               with a jump-chip nav across them.
//   • markers — "Markers": the rich trends catalog (the ONE detailed markers home).
//   • records — "Records": upload + the document list.
//   • share   — "Share": doctor report, structured export, and data-alignment actions.
//   • learned — "Learned": the quiet record of what Cairn has come to understand.
const HEALTH_SEG: readonly (readonly [ClientHealthSection, string])[] = [["read", "Read"], ["markers", "Markers"], ["records", "Records"], ["share", "Share"], ["learned", "Learned"]];

// Health is the lab-DATA + whole-picture-read home. Fold every legacy analysis/brain/
// standing key onto Read (where that content now lives) so a returning client never
// lands on a dead inner tab.
function normalizeHealthSeg(seg: unknown): ClientHealthSection {
  if (seg === "analysis" || seg === "brain" || seg === "standing") return "read";
  return typeof seg === "string" && HEALTH_SEG.some(([k]) => k === seg) ? (seg as ClientHealthSection) : "read";
}

// True when we positively know there are zero health documents — from this session's
// last load (cache.docCount) or this device's last visit (persisted). Used to open a
// brand-new user on Records (where they upload) instead of an empty Standing read.
// Returns false when the count is unknown, so we only override on a confident zero.
function healthDocsKnownEmpty(): boolean {
  return CairnHealthPictureController.healthDocsKnownEmpty(healthPictureDeps());
}

// Health is a one-level inner view: the Me seg picks "Health", then a single inner
// seg picks Read / Markers / Records / Share. Splitting these bounds each view's scroll and
// keeps it focused — and the connected brain now lives on the default Read view, so
// it's reachable in one nav step (Me → Health) instead of buried behind a second seg.
async function renderHealth(): Promise<void> {
  headerTitle.textContent = "Me";
  state.meSeg = "health";
  state.healthSeg = normalizeHealthSeg(state.healthSeg);
  // New user with nothing uploaded yet → open on Records (where you add a document),
  // not the Read view that can only say "this will sharpen". Respect any explicit
  // tab choice made this session, and only override on a confident zero doc count.
  if (!state.healthSegPicked && state.healthSeg === "read" && healthDocsKnownEmpty()) {
    state.healthSeg = "records";
  }
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  const idx = Math.max(0, HEALTH_SEG.findIndex(([k]) => k === state.healthSeg));
  view.innerHTML = segBar("health", ME_SEG)
    + `<div class="segwrap hsegwrap"><div class="seg seg-sliding hseg" style="--segn:${HEALTH_SEG.length};--segi:${idx}">`
    +   `<span class="seg-thumb"></span>`
    +   HEALTH_SEG.map(([k, l]) => `<button class="segbtn${k === state.healthSeg ? " active" : ""}" data-hseg="${k}">${l}</button>`).join("")
    + `</div></div>`
    + `<div id="hContent"></div>`;
  wireSeg(ME_HANDLERS);
  const hseg = view.querySelector<HTMLElement>(".hseg");
  if (!hseg) return;
  hseg.querySelectorAll<HTMLButtonElement>(".segbtn").forEach((b) => b.addEventListener("click", () => {
    const next = normalizeHealthSeg(b.dataset.hseg);
    if (next === state.healthSeg) return;
    setHealthSegActive(next);
    if (typeof syncRouteFromState === "function") syncRouteFromState();
    withViewTransition(() => paintHealthTab());
  }));
  paintHealthTab();
}

// Slide the inner seg thumb + flip the active button to `seg` (no repaint).
function setHealthSegActive(seg: ClientHealthSection): void {
  state.healthSeg = seg;
  state.healthSegPicked = true; // a deliberate tab choice — don't auto-default to Records again
  const hseg = view.querySelector<HTMLElement>(".hseg");
  if (!hseg) return;
  const btns = [...hseg.querySelectorAll<HTMLButtonElement>(".segbtn")];
  const target = btns.find((b) => b.dataset.hseg === seg);
  if (!target) return;
  hseg.style.setProperty("--segi", String(btns.indexOf(target)));
  btns.forEach((x) => x.classList.toggle("active", x === target));
  fitSeg(hseg); // keep the active pill centered when the bar is in scroll mode
}

// Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
// same user gesture (so the file dialog isn't blocked) — hence no view transition.
function switchHealthSeg(seg: ClientHealthSection, opts: { openPicker?: boolean } = {}): void {
  if (state.tab !== "me" || state.meSeg !== "health") return;
  setHealthSegActive(seg);
  if (typeof syncRouteFromState === "function") syncRouteFromState();
  if (opts.openPicker) {
    paintHealthTab();
    const f = $<HTMLInputElement>("#hFile"); if (f) f.click();
  } else {
    withViewTransition(() => paintHealthTab());
  }
}

// Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
// poll from the tab we're leaving stops cleanly (Records resumes on return).
function paintHealthTab(): void {
  pollToken++;
  if (state.healthSeg === "records") {
    paintHealthRecordsTab();
    return;
  }
  if (state.healthSeg === "share") {
    paintHealthShareTab();
    return;
  }
  if (state.healthSeg === "learned") {
    paintHealthLearnedTab();
    return;
  }
  if (state.healthSeg === "markers") {
    paintHealthMarkersTab();
    return;
  }
  paintHealthReadTab();
}

// ME → Health → Read: the whole-picture depth that used to balloon the Standing tab.
// A STICKY jump-chip nav heads it (pinned under the Health seg) so you can land on the
// connections, recovery, markers or supplements from anywhere in the long read; below
// it the same id-keyed slots the loaders fill. Single editorial column (no broken
// two-column gutter), capped width on desktop. The targets carry scroll-margin-top so a
// jump lands below the sticky chrome, and a scroll-spy highlights the section you're in.
function paintHealthReadTab(): void {
  CairnHealthReadController.paintTab(healthReadDeps());
}

// ---- Standing tab: percentiles, signal age, and point-in-time BP ----
function healthStandingDeps(): ClientHealthStandingControllerDeps {
  return {
    root: view,
    document,
    state,
    api,
    swrInvalidate,
    toast,
    activateTab,
    pollToken: () => pollToken,
    select: $,
    escapeAttr: escAttr,
    loadDexaTargeting: typeof loadDexaTargeting === "function" ? loadDexaTargeting : undefined,
  };
}

function renderHealthStanding(data: HealthStandingRead | null | undefined): void {
  CairnHealthStandingController.render(data, healthStandingDeps());
}

function openBpSheet(): void {
  CairnHealthStandingController.openBpSheet(healthStandingDeps());
}

function loadHealthStanding(token: number, refAge: unknown): void {
  CairnHealthStandingController.load(healthStandingDeps(), token, refAge);
}

function paintStandingReview(): void {
  CairnHealthStandingController.paintReview(healthStandingDeps());
}

function openHealthRead(opts: { scroll?: string } = {}): void {
  CairnHealthStandingController.openRead(healthStandingDeps(), opts);
}

function scrollHealthRailIntoView(sel: string): void {
  CairnHealthReadController.scrollHealthRailIntoView(healthReadDeps(), sel);
}

function loadHealthSynthesis(token: number): void {
  CairnHealthReadController.loadSynthesis(healthReadDeps(), token);
}

function triggerHealthSynthesis(): void {
  CairnHealthReadController.triggerSynthesis(healthReadDeps());
}

function renderHealthSynthesis(data: unknown, token?: number | null): void {
  CairnHealthReadController.renderSynthesis(data, healthReadDeps(), token);
}

async function loadSymptomLinks(token: number): Promise<void> {
  await CairnHealthReadController.loadSymptomLinks(healthReadDeps(), token);
}

function loadSupplements(token: number): void {
  CairnHealthReadController.loadSupplements(healthReadDeps(), token);
}

function renderSupplements(list: unknown, token?: number | null): void {
  CairnHealthReadController.renderSupplements(list, healthReadDeps(), token);
}

async function understandSupplementsFromInput(): Promise<void> {
  await CairnHealthReadController.understandSupplementsFromInput(healthReadDeps());
}

async function removeSupplement(id: number): Promise<void> {
  await CairnHealthReadController.removeSupplement(id, healthReadDeps());
}

function loadRecoverySummary(token: number, sel: string): void {
  CairnHealthReadController.loadRecoverySummary(healthReadDeps(), token, sel);
}

function loadPriorityMarkers(token: number): void {
  CairnHealthReadController.loadPriorityMarkers(healthReadDeps(), token);
}

// ---- Cross-domain directives, grouped by domain (the review side) ----
// Pure directive grouping and card rendering live in health-client.js.
Object.assign(globalThis, {
  HEALTH_SEG,
  ME_HANDLERS,
  ME_SEG,
  buildPictureHtml,
  getHealthPictureCache,
  healthDotClass,
  healthDocsKnownEmpty,
  healthHeroHtml,
  loadHealthMarkers,
  loadHealthPicture,
  loadHealthStanding,
  loadHealthSynthesis,
  loadPriorityMarkers,
  loadRecoverySummary,
  loadSupplements,
  loadSymptomLinks,
  normalizeHealthSeg,
  onHealthReadView,
  openBpSheet,
  openHealthRead,
  paintHealthPicture,
  paintHealthReadTab,
  paintHealthTab,
  paintStandingReview,
  parsedReview,
  renderActs,
  renderHealth,
  renderHealthStanding,
  renderHealthSynthesis,
  renderMe,
  renderMeProfile,
  renderMeStanding,
  renderMemory,
  renderNotes,
  renderSupplements,
  reviewBusyHtml,
  reviewHtml,
  runHealthReview,
  scrollHealthRailIntoView,
  setHealthSegActive,
  setHealthPictureCache,
  switchHealthSeg,
  triggerHealthSynthesis,
  understandSupplementsFromInput,
  wireNoteCard,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    renderMe,
    renderMemory,
    switchHealthSeg,
    loadHealthMarkers,
    paintHealthPicture,
  });
}
}

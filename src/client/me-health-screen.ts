// ==== 07-me-health.js ====
{
type HealthScreenRecord = Record<string, unknown>;
type HealthStandingRead = import("../contracts/client-api.js").ClientHealthStanding;
type HealthReviewRecord = HealthScreenRecord & { created_at?: string; error?: unknown };
type MarkerPriorityResponse = { markers?: HealthMarkerRow[]; groups?: HealthMarkerGroup[] };
type HealthMarkerGroup = { key: string; label?: string };
type HealthMarkerRow = HealthScreenRecord & {
  name?: string;
  key?: string;
  group?: string;
  group_label?: string;
};
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

// ---- markers (trends) ----
function fmtMkNum(v: unknown): string {
  return CairnHealthMarkers.formatMarkerNumber(v);
}

function sparkDateLabel(d: unknown): string {
  return CairnHealthMarkers.sparkDateLabel(d);
}

function markerTrendWord(m: { trend?: { dir?: unknown; span_days?: unknown } | null; points?: Array<{ value?: unknown; date?: unknown }> | null } | null | undefined): string {
  return CairnHealthMarkers.markerTrendWord(m);
}

function markerSpanWord(days: unknown): string {
  return CairnHealthMarkers.markerSpanWord(days);
}

function markerChartSvg(m: HealthScreenRecord | null | undefined): string {
  return CairnHealthMarkers.markerChartSvg(m);
}

function wireMarkerChart(svg: Element): void {
  if (!(svg instanceof SVGElement)) return;
  CairnHealthMarkers.wireMarkerChart(svg);
}

function markerPanelHtml(m: HealthScreenRecord | null | undefined): string {
  return CairnHealthMarkers.markerPanelHtml(m);
}

function hmkRowHtml(m: HealthScreenRecord | null | undefined, i?: number): string {
  return CairnHealthMarkers.hmkRowHtml(m, i);
}

function orderHealthMarkersForDisplay(groupKey: unknown, list: HealthMarkerRow[] | null | undefined): HealthMarkerRow[] {
  return CairnHealthClient.orderMarkersForDisplay(groupKey, list);
}
function healthMarkerSubgroup(groupKey: unknown, name: unknown): string | null {
  return CairnHealthClient.markerSubgroup(groupKey, name);
}
function lipidGroupNoteHtml(list: HealthMarkerRow[] | null | undefined): string {
  return CairnHealthClient.lipidGroupNoteHtml(list, { relAge });
}

// SWR over /markers/priority (key shared with the Health → Read priority view): a
// warm re-entry paints the grouped marker list instantly, then revalidates and
// re-paints only if the payload changed. The render is unchanged — SWR only
// changes WHEN the data arrives.
function loadHealthMarkers(token: number): void {
  const wrap = $<HTMLElement>("#hMarkers");
  if (!wrap || !wrap.isConnected) return;
  // /markers/priority is the superset: it carries the optimal bands (for the chart) plus
  // group + trend on top of the flat marker shape /health/markers returns.
  const paint = (res: unknown) => {
    if (token !== pollToken || !wrap.isConnected) return;
    const data = healthScreenRecord(res) as MarkerPriorityResponse;
    const markers = healthScreenRows<HealthMarkerRow>(data.markers);
    if (!markers.length) {
      wrap.innerHTML = CairnHealthClient.markersEmptyHtml(CairnHealthClient.HEALTH_HERO_ART);
      const b = wrap.querySelector("#hMkToRecords");
      if (b) b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
      return;
    }
    // Server `groups` is the canonical ordered list of groups that hold ≥1 marker; render
    // headers in that order. Most groups preserve server priority order; lipids get a
    // clinician-style scan order so LDL variants and particle markers don't read as one pile.
    // Degrade gracefully if the backend hasn't shipped grouping yet: derive an ordered list
    // from the markers themselves, falling everything ungrouped into a single "Markers" bucket.
    let groups = healthScreenRows<HealthMarkerGroup>(data.groups).filter((g) => !!g.key);
    if (!groups.length) {
      const seen = new Set<string>(), derived: HealthMarkerGroup[] = [];
      for (const m of markers) {
        const key = typeof m.group === "string" && m.group ? m.group : "other";
        if (!seen.has(key)) { seen.add(key); derived.push({ key, label: m.group_label || (m.group ? m.group : "Markers") }); }
      }
      groups = derived;
    }
    const byGroup = new Map<string, HealthMarkerRow[]>(groups.map((g) => [g.key, []]));
    for (const m of markers) {
      const groupKey = typeof m.group === "string" ? m.group : "";
      const key = byGroup.has(groupKey) ? groupKey : (groups[0] && groups[0].key);
      if (key && byGroup.has(key)) byGroup.get(key)?.push(m);
    }
    let i = 0;
    const sections = groups.map((g, gi) => {
      const list: HealthMarkerRow[] = (typeof orderHealthMarkersForDisplay === "function")
        ? orderHealthMarkersForDisplay(g.key, byGroup.get(g.key) || [])
        : (byGroup.get(g.key) || []);
      if (!list.length) return "";
      let lastSub = "";
      const rows = list.map((m) => {
        const subgroup = typeof healthMarkerSubgroup === "function"
          ? healthMarkerSubgroup(g.key, m.name || m.key || "")
          : "";
        const subhead = subgroup && subgroup !== lastSub
          ? `<div class="hmk-subhead">${escHtml(subgroup)}</div>`
          : "";
        if (subgroup) lastSub = subgroup;
        return subhead + hmkRowHtml(m, i++);
      }).join("");
      const head = `<div class="hmk-grouphead lbl reveal" style="${stagger(gi)}">${escHtml(g.label || g.key)}</div>`;
      const note = g.key === "lipids" && typeof lipidGroupNoteHtml === "function"
        ? lipidGroupNoteHtml(list)
        : "";
      return `<section class="hmk-section">${head}${note}<div class="hmk-card">${rows}</div></section>`;
    }).join("");
    // The clinical report + portable export live on their own Share sub-tab, so the
    // catalog doesn't repeat a "share with your doctor" footer here.
    wrap.innerHTML = `<div class="hmk-groups">${sections}</div>`;
    wrap.querySelectorAll<HTMLElement>(".hmk-x .hmk-row").forEach((b) =>
      b.addEventListener("click", () => {
        const item = b.closest<HTMLElement>(".hmk");
        if (!item) return;
        const open = item.classList.toggle("open");
        b.setAttribute("aria-expanded", open ? "true" : "false");
      }));
    wrap.querySelectorAll("svg.hchart").forEach(wireMarkerChart);
  };
  const peek = peekCached("markers:priority");
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/markers/priority", {
    key: "markers:priority",
    onUpgrade: (data, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(data); },
    // No cached read + a thrown fetch (offline / parse failure): clear the
    // "Loading markers…" placeholder to the calm empty state, never a stuck loader.
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); if (!peek) paint(null); });
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
function renderHealthStanding(data: HealthStandingRead | null | undefined): void {
  const wrap = $<HTMLElement>("#hStanding");
  if (!wrap) return;
  wrap.innerHTML = CairnHealthStanding.renderHealthStandingHtml(data, { referenceAge: state.healthStandingRef });

  // Don't stack two competing "single most important thing" surfaces: if the conductor's
  // "Where to focus" card already led above, drop this health "one lever" section (the
  // Program view de-dupes the same way via suppressLever). Order-independent — the
  // conductor loader does the mirror removal if it lands after this paint.
  if (view.querySelector("#cfocusStandingSlot .cfocus")) wrap.querySelector(".hstand-lever")?.remove();

  wrap.querySelectorAll<HTMLElement>("[data-refage]").forEach((b) => b.addEventListener("click", () => {
    state.healthStandingRef = Number(b.dataset.refage || 20);
    loadHealthStanding(pollToken, state.healthStandingRef);
  }));
  // This lever lives on the top-level Standing tab (meSeg="standing"), so switchHealthSeg
  // would bail (it guards meSeg==="health"). Route into Health → Markers directly.
  wrap.querySelector("[data-lever-go]")?.addEventListener("click", () => {
    state.meSeg = "health"; state.healthSeg = "markers"; state.healthSegPicked = true; activateTab("me");
  });
  $("#bpLogOpen")?.addEventListener("click", () => openBpSheet());
  // "From your DEXA — what to focus on next", co-located with the regional read.
  // Shared renderer defined in 05-progress.js (loaded earlier); null-safe + quiet.
  if (typeof loadDexaTargeting === "function") loadDexaTargeting("hDexaSlot");
}

// The relocated BP capture: a compact sheet behind a tap, so the Standing read stays a
// reading surface (the user's "why am I entering BP in the analysis view?"). Reuses the
// same POST /blood-pressure wiring as before.
function openBpSheet(): void {
  if (document.getElementById("bpSheetOv")) return;
  const ov = document.createElement("div");
  ov.id = "bpSheetOv";
  ov.className = "bpsheet-ov";
  ov.innerHTML = `<div class="bpsheet" role="dialog" aria-modal="true" aria-label="Log blood pressure">
      <div class="bpsheet-hd"><h3>Log a reading</h3><button class="bpsheet-x" type="button" aria-label="Close">✕</button></div>
      <form id="bpSheetForm" class="bpsheet-form">
        <div class="bpsheet-row">
          <label>Systolic<input id="bpSys" class="form-input" type="number" inputmode="numeric" min="60" max="260" placeholder="120" required></label>
          <label>Diastolic<input id="bpDia" class="form-input" type="number" inputmode="numeric" min="35" max="160" placeholder="80" required></label>
          <label>Pulse<input id="bpPulse" class="form-input" type="number" inputmode="numeric" min="25" max="240" placeholder="60"></label>
        </div>
        <label class="bpsheet-when">When<input id="bpAt" class="form-input" type="datetime-local" value="${escAttr(CairnHealthStanding.localDateTimeInputValue())}"></label>
        <div class="bpsheet-row">
          <label>Position<input id="bpPosition" class="form-input" type="text" maxlength="40" placeholder="Seated"></label>
          <label>Note<input id="bpNote" class="form-input" type="text" maxlength="240" placeholder="Optional"></label>
        </div>
        <div class="bpsheet-ft"><button class="ghostbtn" type="button" data-close>Cancel</button><button class="logbtn" type="submit">Save</button></div>
      </form>
    </div>`;
  document.body.appendChild(ov);
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") teardown(); };
  const teardown = () => { document.removeEventListener("keydown", onKey); ov.remove(); };
  document.addEventListener("keydown", onKey);
  ov.querySelector(".bpsheet-x")?.addEventListener("click", teardown);
  ov.querySelector("[data-close]")?.addEventListener("click", teardown);
  ov.addEventListener("click", (e) => { if (e.target === ov) teardown(); });
  $<HTMLFormElement>("#bpSheetForm")?.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget instanceof HTMLFormElement ? e.currentTarget : null;
    const submit = form?.querySelector<HTMLButtonElement>("button[type='submit']") || null;
    if (submit) submit.disabled = true;
    const payload = {
      systolic: healthInputValue("#bpSys"), diastolic: healthInputValue("#bpDia"), pulse: healthInputValue("#bpPulse"),
      measured_at: healthInputValue("#bpAt"), position: healthInputValue("#bpPosition"), note: healthInputValue("#bpNote"), source: "manual",
    };
    try {
      const res = await api("/blood-pressure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) as unknown as { error?: string } | null;
      if (!res || res.error) { toast(res?.error || "Couldn't log BP"); if (submit) submit.disabled = false; return; }
      toast("BP logged");
      swrInvalidate("markers:");
      teardown();
      loadHealthStanding(pollToken, state.healthStandingRef || 20);
    } catch {
      toast("Couldn't log BP");
      if (submit) submit.disabled = false;
    }
  });
  setTimeout(() => $<HTMLInputElement>("#bpSys")?.focus(), 30);
}

function loadHealthStanding(token: number, refAge: unknown): void {
  const ref = Number(refAge || state.healthStandingRef || 20);
  state.healthStandingRef = ref;
  api(`/health/standing?reference_age=${encodeURIComponent(String(ref))}`)
    .then((data) => { if (token === pollToken) renderHealthStanding(data || null); })
    .catch(() => {
      if (token !== pollToken) return;
      const wrap = $<HTMLElement>("#hStanding");
      if (wrap) wrap.innerHTML = `<div class="hstand hstand-panel"><div class="empty">Couldn't load health standing right now.</div></div>`;
    });
}

// The Standing tab is the calm REVIEW — where you stand + where to focus. It stays
// short and scannable: the conductor "Where to focus" (rendered above #hContent), then
// the momentum-led structured read (#hStanding — hero, momentum, the one lever, and the
// collapsed Full standing: live body comp, BP, percentiles). The whole-picture depth
// (synthesis, recovery, picture, the connected-brain directives/markers/supplements)
// now lives one tap away in Health → Read, reachable from the jump-off below — so this
// page no longer stacks ~8 screens of analysis on top of the review.
function paintStandingReview(): void {
  const c = $<HTMLElement>("#hContent");
  if (!c) return;
  c.innerHTML = `<div id="hStanding"><div class="hstand hstand-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div></div>
    <button type="button" class="hread-jump" id="hStandingToRead">
      <span class="hread-jump-main">
        <span class="lbl">Your whole picture</span>
        <span class="hread-jump-title">The full health read</span>
        <span class="hread-jump-sub">Synthesis, the connected-brain list, recovery, markers and supplements — read as one story.</span>
      </span>
      <span class="hread-jump-arrow" aria-hidden="true">→</span>
    </button>`;
  loadHealthStanding(pollToken, state.healthStandingRef || 20);
  $("#hStandingToRead")?.addEventListener("click", () => openHealthRead());
}

// Jump from the Standing review into the relocated depth (Health → Read). Switches the
// Me seg to Health and the inner seg to Read in one step, then paints.
function openHealthRead(opts: { scroll?: string } = {}): void {
  state.meSeg = "health";
  state.healthSeg = "read";
  state.healthSegPicked = true;
  if (opts.scroll) state.pendingHealthScroll = opts.scroll;
  activateTab("me");
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
  fmtMkNum,
  getHealthPictureCache,
  healthDotClass,
  healthDocsKnownEmpty,
  healthHeroHtml,
  healthMarkerSubgroup,
  hmkRowHtml,
  lipidGroupNoteHtml,
  loadHealthMarkers,
  loadHealthPicture,
  loadHealthStanding,
  loadHealthSynthesis,
  loadPriorityMarkers,
  loadRecoverySummary,
  loadSupplements,
  loadSymptomLinks,
  markerChartSvg,
  markerPanelHtml,
  markerSpanWord,
  markerTrendWord,
  normalizeHealthSeg,
  onHealthReadView,
  openBpSheet,
  openHealthRead,
  orderHealthMarkersForDisplay,
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
  sparkDateLabel,
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

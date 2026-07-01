// ==== 07-me-health.js ====
{
type HealthScreenRecord = Record<string, unknown>;
type HealthStandingRead = import("../contracts/client-api.js").ClientHealthStanding;
type HealthReviewRecord = HealthScreenRecord & { created_at?: string; error?: unknown };
type MarkerPriorityResponse = { markers?: HealthMarkerRow[]; groups?: HealthMarkerGroup[] };
type HealthSynthesisPriority = HealthScreenRecord & {
  label?: string;
  the_move?: string;
  recheck?: string;
};
type HealthSynthesisPayload = HealthScreenRecord & {
  synthesis?: (HealthScreenRecord & {
    headline?: string;
    story?: string;
    priorities?: HealthSynthesisPriority[];
    one_change?: string;
    generated_at?: string;
    stale?: unknown;
  }) | null;
  focus?: HealthScreenRecord & { priorities?: unknown[] };
  stale?: unknown;
};
type SymptomMarker = HealthScreenRecord & { name?: string; value?: unknown; unit?: string };
type SymptomLink = HealthScreenRecord & { note?: string; markers?: SymptomMarker[] };
type RecoverySummary = HealthScreenRecord & { has_data?: unknown };
type HealthMarkerGroup = { key: string; label?: string };
type HealthMarkerRow = HealthScreenRecord & {
  name?: string;
  key?: string;
  group?: string;
  group_label?: string;
};
type HealthSupplement = HealthScreenRecord & {
  id?: number | string;
  name?: string;
  dose?: string | null;
  frequency?: string | null;
  note?: string | null;
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
  const c = $<HTMLElement>("#hContent");
  if (!c) return;
  if (_hReadSpy) { _hReadSpy.disconnect(); _hReadSpy = null; } // drop a prior tab's observer
  c.innerHTML = `<div class="hread">
      <nav class="hread-nav" aria-label="Jump to a section">
        <button type="button" class="hread-chip" data-jump="hSynthesis">The read</button>
        <button type="button" class="hread-chip" data-jump="hbDirectives">Connections</button>
        <button type="button" class="hread-chip" data-jump="hRecovery">Recovery</button>
        <button type="button" class="hread-chip" data-jump="hbMarkers">Markers</button>
        <button type="button" class="hread-chip" data-jump="hbSupplements">Supplements</button>
      </nav>
      <div class="hbrain-intro sess"><div class="sess-line" style="color:var(--muted)">
        One brain across your whole picture. A finding in your labs can quietly shape your meals, your training, and what to keep an eye on. It's here to inform — never medical advice — and nothing changes your plan on its own.
      </div></div>
      <div id="hSynthesis"></div>
      <div id="hPicture">
        <div class="hpic hpic-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div>
      </div>
      <div id="hbDirectives"><div class="hb-load">Gathering connections…</div></div>
      <div id="hbSymptomLinks"></div>
      <div id="hRecovery"></div>
      <div id="hbMarkers"><div class="hb-load">Reading what matters most…</div></div>
      <div id="hbSupplements"></div>
    </div>`;
  const chips = [...c.querySelectorAll<HTMLButtonElement>(".hread-chip")];
  const setActiveChip = (id: string | undefined) => chips.forEach((ch) => ch.classList.toggle("active", ch.dataset.jump === id));
  // Jump chips: scroll the target slot into view; scroll-margin-top (CSS) keeps it clear
  // of the sticky seg + nav. Mark it active immediately so the tap reads as a selection.
  chips.forEach((b) => b.addEventListener("click", () => {
    const el = b.dataset.jump ? view.querySelector<HTMLElement>("#" + b.dataset.jump) : null;
    if (el) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    setActiveChip(b.dataset.jump);
  }));
  // Scroll-spy: highlight the chip for whichever section sits under the sticky nav. The
  // band (rootMargin) starts below the pinned chrome; the topmost section in it wins.
  // Sections WITHOUT their own chip (the picture reads under "The read", symptom links
  // under "Connections") map to the owning chip so no scroll position is left unlit.
  if ("IntersectionObserver" in window) {
    const spy: Array<readonly [string, string]> = [["hSynthesis", "hSynthesis"], ["hPicture", "hSynthesis"], ["hbDirectives", "hbDirectives"], ["hbSymptomLinks", "hbDirectives"], ["hRecovery", "hRecovery"], ["hbMarkers", "hbMarkers"], ["hbSupplements", "hbSupplements"]];
    const owner = new Map(spy);
    const order = spy.map(([id]) => id);
    const visible = new Set<string>();
    _hReadSpy = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id); }
      const top = order.find((id) => visible.has(id));
      if (top) setActiveChip(owner.get(top));
    }, { rootMargin: "-104px 0px -55% 0px", threshold: 0 });
    const spyObserver = _hReadSpy;
    order.forEach((id) => { const el = document.getElementById(id); if (el && spyObserver) spyObserver.observe(el); });
  }
  loadHealthSynthesis(pollToken);
  loadRecoverySummary(pollToken, "#hRecovery");
  loadPriorityMarkers(pollToken);
  const directivesLoaded = CairnHealthDirectiveLoader.load(pollToken);
  loadSymptomLinks(pollToken);
  loadSupplements(pollToken);
  // A provenance "why" deep-link can ask to land on the referenced directive rather
  // than the top. The directives rail hydrates async, so wait for it to render, then
  // scroll it into view. Consumed once; a normal entry never scrolls.
  if (state.pendingHealthScroll === "hbDirectives") {
    const token = pollToken;
    state.pendingHealthScroll = null;
    void directivesLoaded.then(() => { if (token === pollToken) scrollHealthRailIntoView("#hbDirectives"); });
  }
  if (CairnHealthPictureController.isHealthReviewRunning()) { paintHealthPicture(); return; } // a run is still cooking
  loadHealthPicture(pollToken, api("/health-docs"));
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

// Bring a Standing-tab connected-brain rail target into view once it has real content
// (the rail loads async, so wait for its "Gathering…" placeholder to be replaced
// before scrolling). pollToken-guarded so switching sub-views cancels it cleanly.
function scrollHealthRailIntoView(sel: string): void {
  const token = pollToken;
  let tries = 0;
  const onRead = () => state.tab === "me" && state.meSeg === "health" && state.healthSeg === "read";
  const tick = () => {
    if (token !== pollToken || !onRead()) return;
    const el = view.querySelector<HTMLElement>(sel);
    const ready = el && !el.querySelector(".hb-load"); // directives rendered (placeholder gone)
    if (ready || tries > 20) {
      if (el) el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
      return;
    }
    tries++;
    setTimeout(tick, 80);
  };
  setTimeout(tick, 80);
}

// ---- the elite-coach synthesis: the whole picture, read as ONE prioritized story ----
// Leads the Read tab as a tight narrative: headline + connected story + the 2-3
// priorities + the one change. The deterministic act-now / worth-tracking TIERS it
// used to repeat are now carried by the actionable connected-brain list (#hbDirectives)
// rendered directly below, so we no longer duplicate them here. Pull: it waits here; a
// refresh regenerates it as a streamed job. No scores; informational, never a verdict.
function renderHealthSynthesis(data: unknown, token?: number | null): void {
  const wrap = $<HTMLElement>("#hSynthesis");
  if (!wrap || !wrap.isConnected || (token != null && token !== pollToken)) return;
  const payload = healthScreenRecord(data) as HealthSynthesisPayload;
  const s = payload.synthesis && typeof payload.synthesis === "object" ? payload.synthesis : null;
  const focus = healthScreenRecord(payload.focus);
  const hasFocus = Array.isArray(focus.priorities) && focus.priorities.length;
  if (!s && !hasFocus) { wrap.innerHTML = ""; return; } // nothing to synthesize yet — stay quiet
  // Newer labs landed since this read was written? Warn calmly, the same way the
  // review card does — so the narrative never silently contradicts the fresh
  // connected-brain list below it. Read defensively for both response shapes.
  const stale = payload.stale ?? (s && s.stale) ?? false;

  const prios = s && Array.isArray(s.priorities) ? healthScreenRows<HealthSynthesisPriority>(s.priorities).filter((p) => p.label || p.the_move) : [];
  let body: string;
  if (s && s.headline) {
    body = `
      <h3 class="hsyn-headline">${escHtml(s.headline)}</h3>
      ${s.story ? `<p class="hsyn-story">${escHtml(s.story)}</p>` : ""}
      ${prios.length ? `<div class="hsyn-prios">${prios.map((p) => `
        <div class="hsyn-prio">
          <span class="hsyn-plabel">${escHtml(p.label || "")}</span>
          ${p.the_move ? `<span class="hsyn-pmove">${escHtml(p.the_move)}</span>` : ""}
          ${p.recheck ? `<span class="hsyn-precheck lbl">${escHtml(p.recheck)}</span>` : ""}
        </div>`).join("")}</div>` : ""}
      ${s.one_change ? `<div class="hsyn-onechange"><span class="lbl">If you change one thing</span><span>${escHtml(s.one_change)}</span></div>` : ""}
      <div class="hsyn-foot"><span class="lbl">${s.generated_at ? `read ${escHtml(relTime(s.generated_at))}` : ""}</span>${stale
        ? `<button id="hsynRefresh" class="hpic-refresh hpic-refresh-stale" type="button" title="New results since this read"><span class="hdot hdot-warn"></span>New results — refresh</button>`
        : `<button class="linkbtn" id="hsynRefresh" type="button">refresh</button>`}</div>`;
  } else {
    body = `
      <p class="hsyn-invite">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn hsyn-gen" id="hsynGen" type="button">Read my whole picture</button>`;
  }
  wrap.innerHTML = `<div class="hsyn reveal"><div class="hsyn-kicker lbl">Your health — one picture</div>${body}</div>`;
  $("#hsynRefresh")?.addEventListener("click", triggerHealthSynthesis);
  $("#hsynGen")?.addEventListener("click", triggerHealthSynthesis);
}

function loadHealthSynthesis(token: number): void {
  const wrap = $<HTMLElement>("#hSynthesis");
  if (!wrap || !wrap.isConnected) return;
  api("/health/synthesis")
    .then((data) => renderHealthSynthesis(data || {}, token))
    .catch(() => { /* leave quiet */ });
}

// Regenerate the synthesis — a streamed background job (reads the whole picture;
// can take ~30-90s), reconnects across reloads via runOp.
function triggerHealthSynthesis(): void {
  const wrap = $<HTMLElement>("#hSynthesis");
  if (!wrap) return;
  const card = wrap.querySelector(".hsyn");
  if (card && !card.querySelector(".job-cap")) {
    const cap = document.createElement("div");
    cap.className = "job-cap lbl hsyn-cap";
    card.appendChild(cap);
  }
  runOp("health_synthesis", {}, {
    path: "/health/synthesis",
    anchor: "#hSynthesis .hsyn",
    caption: ["reading your labs", "connecting it to your training & recovery", "finding what matters most", "writing your picture"],
    guard: () => !$("#hSynthesis")?.isConnected,
    render: (result) => {
      const payload = healthScreenRecord(result) as HealthSynthesisPayload;
      if (payload.synthesis) renderHealthSynthesis(payload, pollToken);
      else loadHealthSynthesis(pollToken);
      swrInvalidate("plan:coach");
    },
    onFail: () => { toast("Couldn't read the picture right now — try again in a bit."); loadHealthSynthesis(pollToken); },
  });
}

// ---- Supplements: UNDERSTANDING, not a daily log ----
// Say it once in plain words ("creatine daily, omega-3, some D, whey occasionally")
// → the system approximates each into name · dose · cadence and folds it into the
// connected brain. No rows-per-day, no check-offs — just what you're taking.
// Symptom ↔ marker connections — a quiet "worth mentioning to your doctor" read when
// something the athlete logged (a life event, a check-in note) lines up with an
// out-of-range marker. Pull-only, informational, never diagnostic. Renders nothing
// when there's no genuine co-occurrence (the common, calm case).
async function loadSymptomLinks(token: number): Promise<void> {
  const wrap = $<HTMLElement>("#hbSymptomLinks");
  if (!wrap || !wrap.isConnected) return;
  let r: { links?: unknown[] } | null = null;
  try { r = await api("/symptom-links"); } catch { r = null; }
  if ((token != null && token !== pollToken) || !wrap.isConnected) return;
  const links = healthScreenRows<SymptomLink>(r?.links);
  if (!links.length) { wrap.innerHTML = ""; return; }
  const cards = links.slice(0, 3).map((l) => {
    const mk = Array.isArray(l.markers)
      ? healthScreenRows<SymptomMarker>(l.markers).map((m) => `${escHtml(m.name)}${m.value != null ? ` ${escHtml(String(m.value))}` : ""}${m.unit ? ` ${escHtml(m.unit)}` : ""}`).join(", ")
      : "";
    return `<div class="symlink">
        <div class="symlink-note">${escHtml(l.note || "")}</div>
        ${mk ? `<div class="symlink-mk lbl">${mk}</div>` : ""}
      </div>`;
  }).join("");
  wrap.innerHTML = `<div class="hb-section symlink-card reveal">
      <span class="lbl">Worth mentioning to your doctor</span>
      <p class="symlink-sub">Something you noted lines up with one of your lab markers. Informational only — a question for your clinician, never a diagnosis.</p>
      ${cards}
    </div>`;
}

function loadSupplements(token: number): void {
  const wrap = $<HTMLElement>("#hbSupplements");
  if (!wrap || !wrap.isConnected) return;
  const peek = peekCached("supplements");
  if (peek) renderSupplements(peek.data, token);
  cachedApi("/supplements", {
    key: "supplements",
    onUpgrade: (data, { changed }) => { if (changed || !peek) renderSupplements(data, token); },
  }).catch(() => { if (!peek) renderSupplements([], token); });
}

function renderSupplements(list: unknown, token?: number | null): void {
  const wrap = $<HTMLElement>("#hbSupplements");
  if (!wrap || !wrap.isConnected || (token != null && token !== pollToken)) return;
  const items = healthScreenRows<HealthSupplement>(list);
  const chips = items.map((s) => {
    const bits = [s.dose, s.frequency].filter(Boolean).map(escHtml).join(" · ");
    return `<div class="supp-chip" title="${escAttr(s.note || s.name)}">
        <span class="supp-name">${escHtml(s.name)}</span>${bits ? `<span class="supp-meta">${bits}</span>` : ""}
        <button class="supp-x" data-suppx="${s.id}" aria-label="Remove ${escAttr(s.name)}">×</button>
      </div>`;
  }).join("");
  wrap.innerHTML = `<div class="hb-section supp-card reveal" style="${stagger(3)}">
      <span class="lbl">What you're taking</span>
      <p class="supp-sub">Say it once in plain words — I'll approximate the rest and fold it into your picture.</p>
      ${items.length ? `<div class="supp-chips">${chips}</div>` : `<p class="supp-empty">Nothing yet. Tell me below, or just mention it in chat.</p>`}
      <div class="supp-input">
        <input id="suppText" type="text" placeholder="e.g. creatine daily, omega-3…" autocomplete="off" />
        <button id="suppAdd" class="ghostbtn">Add</button>
      </div>
    </div>`;
  const input = $<HTMLInputElement>("#suppText");
  const submit = () => understandSupplementsFromInput();
  $("#suppAdd")?.addEventListener("click", submit);
  input?.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  wrap.querySelectorAll<HTMLElement>("[data-suppx]").forEach((b) =>
    b.addEventListener("click", () => removeSupplement(Number(b.dataset.suppx)))
  );
}

async function understandSupplementsFromInput(): Promise<void> {
  const input = $<HTMLInputElement>("#suppText");
  const text = (input?.value || "").trim();
  if (!text) return;
  const btn = $<HTMLButtonElement>("#suppAdd");
  if (btn) { btn.disabled = true; btn.textContent = "Reading…"; }
  try {
    await api("/supplements/understand", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    swrInvalidate("supplements");
    loadSupplements(pollToken);
  } catch { if (btn) { btn.disabled = false; btn.textContent = "Add"; } }
}

async function removeSupplement(id: number): Promise<void> {
  try {
    await api(`/supplements/${id}`, { method: "DELETE" });
    swrInvalidate("supplements");
    loadSupplements(pollToken);
  } catch {}
}

// ---- Recovery (calm, plain-language; never a score) ----
// Render a quiet line about how recovery's been over the window. ONE home now: the
// top of the Read view (#hRecovery). Bails to nothing / a quiet hint when there's
// no wearable or check-in data.
// SWR over /recovery?days=14 (key recovery:14): a warm re-entry paints the recovery
// read instantly, then revalidates. `sel` targets which slot this call paints.
function loadRecoverySummary(token: number, sel: string): void {
  const wrap = $<HTMLElement>(sel);
  if (!wrap || !wrap.isConnected) return;
  const paint = (r: unknown) => {
    const summary = healthScreenRecord(r) as RecoverySummary;
    const w = $<HTMLElement>(sel);
    if (token !== pollToken || !w || !w.isConnected) return;
    if (!summary.has_data) {
      // quiet hint, not a nag — capture is offered, never demanded
      w.innerHTML = CairnHealthRead.recoveryNoDataHtml();
      return;
    }
    w.innerHTML = CairnHealthRead.recoveryHtml(summary);
  };
  const peek = peekCached("recovery:14");
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/recovery?days=14", {
    key: "recovery:14",
    onUpgrade: (data, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(data); },
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); });
}

// ---- Priority markers (optimal-zone framing, never a score) ----
// Phrase each marker in plain language against its optimal zone: "ApoB — above
// optimal", "HbA1c — in your optimal range", "Ferritin — below optimal". Order
// comes from the server (impact_score); we NEVER render that number.
// SWR over /markers/priority (key shared with the Markers tab): a warm re-entry
// into the Health → Read view paints "what matters now" instantly, then revalidates.
function loadPriorityMarkers(token: number): void {
  const wrap = $<HTMLElement>("#hbMarkers");
  if (!wrap || !wrap.isConnected) return;
  const paint = (res: unknown) => {
    if (token !== pollToken || !wrap.isConnected) return;
    const markers = healthScreenRows<HealthMarkerRow>((healthScreenRecord(res) as MarkerPriorityResponse).markers);
    wrap.innerHTML = CairnHealthRead.priorityMarkersSectionHtml(markers);
    $("#hbToMarkers")?.addEventListener("click", () => switchHealthSeg("markers"));
  };
  const peek = peekCached("markers:priority");
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/markers/priority", {
    key: "markers:priority",
    onUpgrade: (data, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(data); },
    // No cached read + a thrown fetch (offline / parse failure): clear the
    // "Reading what matters most…" placeholder to the calm empty state instead
    // of leaving the loader stuck forever.
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); if (!peek) paint(null); });
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

// @ts-check
// ==== 02-ui.js ====

function uiRecord(value: unknown): UiRecord {
  return value && typeof value === "object" ? value as UiRecord : {};
}

function uiString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function todayHeaderDeps() {
  return {
    headerTitle,
    state,
    dateLabel,
    escapeHtml: escHtml,
    localISO,
    syncRouteFromState: () => { if (typeof syncRouteFromState === "function") syncRouteFromState(); },
    renderToday: () => renderToday(),
  };
}

function setTodayHeaderTitle() {
  CairnUiHeader.setTodayHeaderTitle(todayHeaderDeps());
}

function updateHeaderCondense() {
  CairnUiHeader.updateHeaderCondense(todayHeaderDeps());
}
CairnUiHeader.installHeaderCondenseScroll(todayHeaderDeps);

function toast(msg: unknown, opts: ToastOptions = {}): void {
  CairnUiActions.toast(msg, opts);
}

function armDelete(btn: Element | null | undefined, onConfirm: () => unknown, { label = "remove?" }: { label?: string } = {}): void {
  CairnUiActions.armDelete(btn, onConfirm, { label });
}

// ---------- detail controllers (exercise + food full-screen overlays) ----------
function exerciseDetailDeps(): ExerciseDetailControllerDeps {
  return {
    root: view,
    state,
    api,
    art,
    artImg,
    closeDetail,
    escapeHtml: escHtml,
    exerciseDetail: CairnExerciseDetail,
    fmtDur,
    fmtWeight,
    gotoChatWith,
    mountDetail,
    openDetailFrom,
    postExerciseMode,
    renderToday,
    runCountUps,
    sparklineSvg,
    toast,
    wireDetailCommon,
  };
}

function wireGuides(scope?: ParentNode | null): void {
  CairnExerciseDetailController.wireGuides(scope, exerciseDetailDeps());
}

function exerciseExplanation(d: ExerciseDetailRow | null | undefined): UiExerciseExplanationPayload {
  return CairnExerciseDetailController.exerciseExplanation(d, exerciseDetailDeps());
}

function exerciseExplanationHtml(d: ExerciseDetailRow | null | undefined, explanation?: UiExerciseExplanationPayload | null): string {
  return CairnExerciseDetailController.exerciseExplanationHtml(d, explanation, exerciseDetailDeps());
}

function replaceExerciseExplanation(el: ParentNode, d: ExerciseDetailRow, explanation: UiExerciseExplanationPayload | null | undefined): void {
  CairnExerciseDetailController.replaceExerciseExplanation(el, d, explanation, exerciseDetailDeps());
}

function foodDetailDeps(): FoodDetailControllerDeps {
  return {
    state,
    api,
    art,
    artEnabled: () => artEnabled,
    artImg,
    closeDetail,
    escapeHtml: escHtml,
    foodNote: CairnFoodNote,
    foodNum,
    formatFoodNum,
    mountDetail,
    openDetailFrom,
    runCountUps,
    toast,
    wireDetailCommon,
    withToken,
  };
}

async function openFoodDetail(note: unknown, fromTile?: Element | null): Promise<void> {
  return CairnFoodDetailController.openFoodDetail(note, fromTile, foodDetailDeps());
}
function gotoChatWith(text: string): void {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  const t = document.querySelector('.tab[data-tab="chat"]');
  if (t) t.classList.add("active");
  state.tab = "chat";
  document.body.dataset.tab = "chat"; // keep the header's Today-scoped styling off
  if (typeof syncRouteFromState === "function") syncRouteFromState();
  Promise.resolve(renderChat()).then(() => {
    const i = $<HTMLTextAreaElement>("#chatInput");
    if (i) { i.value = text; autosizeChatInput(i); i.focus(); }
  });
}

// segmented sub-nav: items = [[key,label]]; handlers = {key: renderFn}
// Emits a sliding ink thumb (.seg-thumb) behind the active button; sub-view swaps
// go through a view transition so the thumb glides between renders. Wrapped in a
// sticky .segwrap band so the sub-nav stays pinned to the top while you scroll a
// long sub-view — one tap back to another section, never lost from focus.
function segBar(active: unknown, items: ReadonlyArray<UiSegment>): string {
  return CairnUi.segmentedNavHtml({ active, items });
}
function wireSeg(handlers: Record<string, () => unknown>) {
  view.querySelectorAll<HTMLElement>(".segbtn").forEach((b, _i) =>
    b.addEventListener("click", () => {
      const f = handlers[String(b.dataset.seg || "")]; if (!f) return;
      // slide the thumb immediately, then swap the sub-view inside a transition
      const seg = b.closest(".seg");
      if (seg) {
        const idx = [...seg.querySelectorAll<HTMLElement>(".segbtn")].indexOf(b);
        (seg as HTMLElement).style.setProperty("--segi", String(idx));
      }
      withViewTransition(() => Promise.resolve(f()).then(() => {
        if (typeof syncRouteFromState === "function") syncRouteFromState();
        return viewEnter();
      }));
    })
  );
  view.querySelectorAll(".seg").forEach(fitSeg);
}

// Pill / segment bars stay on ONE line and SCROLL when they don't fit, rather than
// clipping the last pill (e.g. "Calendar" on a narrow phone). Measure with
// content-width pills (the .seg-scroll layout); if that overflows, keep scroll mode
// — the sliding ink thumb assumes equal-width segments, so it yields to the solid
// active-pill background — and center the active pill. Otherwise drop back to the
// equal-width thumb. Adapts per-bar and per-viewport; no fixed breakpoint.
function fitSeg(seg: Element | null | undefined): void {
  if (!seg) return;
  const el = seg as HTMLElement;
  el.classList.add("seg-scroll");
  const overflow = el.scrollWidth > el.clientWidth + 1;
  seg.classList.toggle("seg-scroll", overflow);
  if (overflow) {
    const active = el.querySelector<HTMLElement>(".segbtn.active");
    if (active) el.scrollLeft = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
  }
}
let _segFitRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(_segFitRaf);
  _segFitRaf = requestAnimationFrame(() => view.querySelectorAll(".seg").forEach(fitSeg));
});
const PROGRESS_SEG: readonly UiSegment[] = [["sessions", "History"], ["trend", "1RM"], ["volume", "Volume"], ["endurance", "Endurance"], ["weight", "Weight"], ["calendar", "Calendar"], ["program", "Program"], ["energy", "Energy"]];
const PROGRESS_HANDLERS: Record<string, () => unknown> = { trend: () => renderProgress(), volume: () => renderVolume(), endurance: () => renderEndurance(), weight: () => renderWeight(), calendar: () => renderCalendar(), sessions: () => renderHistory(), program: () => renderProgram(), energy: () => renderEnergy() };
// The Plan sub-nav is dynamic: a runner/hybrid (or anyone with an endurance goal)
// gets a dedicated ENDURANCE tab — the home for the periodized ramp, this week's
// prescribed runs, and shaping the running plan. A pure strength athlete with no
// running goal never sees it (calm, no empty surface).
function planSeg(): readonly UiSegment[] {
  const routedToEndurance = state.planSeg === "endurance" || state.planJump === "endurance";
  return showEnduranceTab() || routedToEndurance
    ? [["edit", "Training"], ["endurance", "Endurance"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]]
    : [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]];
}
const PLAN_HANDLERS: Record<string, () => unknown> = { edit: () => renderPlanEditor(), endurance: () => renderPlanEndurance(), food: () => renderFoodJournal(), meals: () => renderMeals(), coach: () => renderCoach() };

// ---------- view transition utilities ----------
const uiViewTransitions = CairnUiViewTransitions.create({ view, reducedMotion });
function viewEnter(): void { uiViewTransitions.viewEnter(); }
function withViewTransition(fn: () => unknown): Promise<unknown> { return uiViewTransitions.withViewTransition(fn); }
function skelSwap(fn: () => unknown): Promise<unknown> { return uiViewTransitions.skelSwap(fn); }

// Primary training discipline ('strength'|'endurance'|'hybrid'), read once from the
// profile and used for a GENTLE emphasis reframe — never to hide a surface. Default
// 'strength' so a profile that never set it behaves exactly as before. Refreshed by
// the profile loader (renderToday/renderMeProfile) and on a profile save.
let primaryDiscipline: string = "strength";
Object.defineProperty(globalThis, "primaryDiscipline", {
  configurable: true,
  get: () => primaryDiscipline,
  set: (value) => { primaryDiscipline = String(value || "strength"); },
});
function setDiscipline(d: unknown): string {
  primaryDiscipline = d === "endurance" || d === "hybrid" ? d : "strength";
  return primaryDiscipline;
}
const isEndurance = (): boolean => primaryDiscipline === "endurance";
const isHybrid = (): boolean => primaryDiscipline === "hybrid";

// Whether the athlete has an endurance OBJECTIVE on file (a race or a standing
// readiness target). Primed from the profile alongside the discipline (warm-load +
// on save). Used to surface the Plan → Endurance tab even when the discipline label
// is 'strength' — setting a running goal is a clear signal you want a running plan.
let enduranceGoalSet: boolean = false;
Object.defineProperty(globalThis, "enduranceGoalSet", {
  configurable: true,
  get: () => enduranceGoalSet,
  set: (value) => { enduranceGoalSet = !!value; },
});
function setEnduranceGoalSet(present: unknown): boolean { enduranceGoalSet = !!present; return enduranceGoalSet; }
// A runner home is warranted when the athlete trains endurance OR has set a goal.
const showEnduranceTab = (): boolean => isEndurance() || isHybrid() || enduranceGoalSet;

// tiny inline sparkline (numbers only — safe for innerHTML)
function sparklineSvg(vals: unknown, w = 132, h = 30): string {
  const v = (Array.isArray(vals) ? vals : []).map(Number).filter((x: number) => !Number.isNaN(x));
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v);
  const x = (i: number) => 2 + (i * (w - 4)) / (v.length - 1);
  const y = (n: number) => max === min ? h / 2 : h - 3 - ((n - min) / (max - min)) * (h - 6);
  const pts = v.map((n: number, i: number) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  const last = v[v.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="currentColor"/>
    </svg>`;
}

// ---------- background enrichment (poll a row until its status settles) ----------
// pollToken is bumped on every full re-render so in-flight polls can detect a stale tab and bail.
let pollToken: number = 0;
function setPollTokenForClassicScripts(value: number): number {
  pollToken = value;
  return pollToken;
}
Object.defineProperty(globalThis, "pollToken", {
  configurable: true,
  get: () => pollToken,
  set: (value) => { pollToken = Number(value) || 0; },
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function enrichmentActive(status: unknown): boolean {
  return status === "pending" || status === "in_progress";
}
// Poll GET path/:id every ~1.5s up to ~10 tries. onUpdate(row) runs per fetch while the tab
// is still current; resolves once status leaves the active states (or the cap is hit). Returns the last row.
async function pollEnrichment<T extends UiRecord = UiRecord>(path: string, id: string | number, { tab, token, onUpdate, tries = 10, interval = 1500 }: PollEnrichmentOptions<T> = {}): Promise<T | null> {
  let row: T | null = null;
  for (let i = 0; i < tries; i++) {
    await sleep(interval);
    if (token !== pollToken || state.tab !== tab) return null; // navigated away / re-rendered
    try { row = uiRecord(await api(`${path}/${id}`)) as T; } catch { continue; }
    if (!row || row.error) continue;
    if (token !== pollToken || state.tab !== tab) return null;
    onUpdate && onUpdate(row);
    if (!enrichmentActive(row.enrichment_status)) return row;
  }
  return row;
}

// Status badge: a quiet spinner ONLY while the coach is still refining a just-logged
// entry. Once it settles there's NO permanent tag — the refined entry itself is the
// result, and the capture toast already confirmed the log at the moment of action.
// (A persistent "✦ noted" used to sit on every entry forever; that was pure noise.)
function enrichBadge(status: unknown): string {
  if (enrichmentActive(status)) return `<span class="enr enr-pending">enriching...</span>`;
  return ""; // done / skipped / failed / undefined -> no lingering tag
}

// One-line description of an activity row from its (possibly refined) fields.
function activityLine(a: UiRecord): string {
  const bits = [
    a.type,
    a.duration_min ? `${a.duration_min} min` : null,
    a.distance_km ? `${a.distance_km} km` : null,
    a.pace || null,
    a.rpe != null ? `RPE ${a.rpe}` : null,
  ].filter(Boolean).join(" · ");
  return bits || uiString(a.raw_text) || uiString(a.notes);
}

const CAIRN_UI_SHELL_GLOBALS = {
  setTodayHeaderTitle,
  updateHeaderCondense,
  toast,
  armDelete,
  wireGuides,
  exerciseExplanation,
  exerciseExplanationHtml,
  replaceExerciseExplanation,
  gotoChatWith,
  openFoodDetail,
  segBar,
  wireSeg,
  fitSeg,
  PROGRESS_SEG,
  PROGRESS_HANDLERS,
  planSeg,
  PLAN_HANDLERS,
  viewEnter,
  withViewTransition,
  skelSwap,
  setDiscipline,
  isEndurance,
  isHybrid,
  setEnduranceGoalSet,
  showEnduranceTab,
  sparklineSvg,
  setPollTokenForClassicScripts,
  enrichmentActive,
  pollEnrichment,
  enrichBadge,
  activityLine,
};

Object.assign(globalThis, CAIRN_UI_SHELL_GLOBALS);

if (typeof window !== "undefined") {
  Object.assign(window, CAIRN_UI_SHELL_GLOBALS);
}

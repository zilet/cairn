// @ts-check
// Segmented navigation plus the discipline state that gates Train's Endurance leaf.
// Train's nav also carries one CROSS-VIEW leaf: Program → Plan opens the
// plan editor (the Plan view, which lives under the Train home), so its handler
// navigates with activateTab instead of repainting the Progress view in place.

type UiSegmentsSegment = readonly [string, string];
type UiSegmentsHandlerMap = Record<string, () => unknown>;
type UiSegmentsDeps = {
  root: ParentNode;
  state: Pick<ClientAppState, "planSeg" | "planJump" | "progressSeg">;
  activateTab(name: string): unknown;
  segmentedNavHtml(options: { active: unknown; items: ReadonlyArray<UiSegmentsSegment> }): string;
  withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
  viewEnter(): unknown;
  syncRouteFromState(): unknown;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  addResizeListener(listener: () => void): void;
  renderTrainWeek(): unknown;
  renderTrainOverview(): unknown;
  renderProgress(): unknown;
  renderVolume(): unknown;
  renderEndurance(): unknown;
  renderWeight(): unknown;
  renderMeasurements(): unknown;
  renderCalendar(): unknown;
  renderHistory(): unknown;
  renderProgram(): unknown;
  renderIntake(): unknown;
  renderEnergy(): unknown;
  renderPlanEditor(): unknown;
  renderPlanEndurance(): unknown;
  renderFoodJournal(): unknown;
  renderMeals(): unknown;
  renderCoach(): unknown;
};
type UiSegmentsController = {
  segBar(active: unknown, items: ReadonlyArray<UiSegmentsSegment>): string;
  wireSeg(handlers: UiSegmentsHandlerMap): void;
  fitSeg(seg: Element | null | undefined): void;
  progressHandlers: UiSegmentsHandlerMap;
  /** Train's nav as painted OUTSIDE the Progress view (the plan editor): every
   *  Progress leaf navigates there, and Plan repaints the editor in place. */
  progressLinkHandlers: UiSegmentsHandlerMap;
};
type UiSegmentsApi = {
  PROGRESS_SEG: readonly UiSegmentsSegment[];
  PROGRESS_GROUPS: readonly UiSegmentsSegment[];
  progressGroupOf(leaf: unknown): string;
  progressNav(activeLeaf: string): string;
  progressDeeperHtml(activeLeaf: string): string;
  progressIsLanding(leaf: string): boolean;
  create(deps: UiSegmentsDeps): UiSegmentsController;
  setDiscipline(discipline: unknown): string;
  isEndurance(): boolean;
  isHybrid(): boolean;
  setEnduranceGoalSet(present: unknown): boolean;
  showEnduranceTab(): boolean;
};

declare var primaryDiscipline: string;
declare var enduranceGoalSet: boolean;

const UI_PROGRESS_SEGMENTS: readonly UiSegmentsSegment[] = [
  ["week", "This week"],
  ["overview", "Progress"],
  ["sessions", "History"],
  ["trend", "1RM"],
  ["volume", "Volume"],
  ["endurance", "Endurance"],
  ["weight", "Weight"],
  ["measurements", "Measurements"],
  ["calendar", "Calendar"],
  ["plan", "Plan"],
  ["program", "Program"],
  ["intake", "Intake"],
  ["energy", "Energy"],
];

// Train's one-level nav (groups, landings, deeper rows, the step back) is built by
// CairnTrainNav (train-nav-client.ts); this module wires it. Leaves that open
// ANOTHER view (the Plan view's editor) rather than a Progress one:
const UI_PROGRESS_CROSS_VIEW_LEAVES: ReadonlySet<string> = new Set(["plan"]);
const uiTrainNav = (): TrainNavApi => (globalThis as unknown as { CairnTrainNav: TrainNavApi }).CairnTrainNav;
function uiProgressNav(activeLeaf: string): string {
  return uiTrainNav().navHtml(activeLeaf);
}
function uiProgressDeeperHtml(activeLeaf: string): string {
  return uiTrainNav().deeperHtml(activeLeaf, uiSegmentsShowEnduranceTab());
}

let uiPrimaryDiscipline = "strength";
let uiEnduranceGoalSet = false;

function normalizeUiDiscipline(discipline: unknown): string {
  return discipline === "endurance" || discipline === "hybrid" ? discipline : "strength";
}

function uiDisciplinePropertyValue(discipline: unknown): string {
  return String(discipline || "strength");
}

function uiSegmentsSetDiscipline(discipline: unknown): string {
  uiPrimaryDiscipline = normalizeUiDiscipline(discipline);
  return uiPrimaryDiscipline;
}

function uiSegmentsIsEndurance(): boolean {
  return uiPrimaryDiscipline === "endurance";
}

function uiSegmentsIsHybrid(): boolean {
  return uiPrimaryDiscipline === "hybrid";
}

function uiSegmentsSetEnduranceGoalSet(present: unknown): boolean {
  uiEnduranceGoalSet = !!present;
  return uiEnduranceGoalSet;
}

function uiSegmentsShowEnduranceTab(): boolean {
  return uiSegmentsIsEndurance() || uiSegmentsIsHybrid() || uiEnduranceGoalSet;
}

Object.defineProperty(globalThis, "primaryDiscipline", {
  configurable: true,
  get: () => uiPrimaryDiscipline,
  set: (value) => {
    uiPrimaryDiscipline = uiDisciplinePropertyValue(value);
  },
});

Object.defineProperty(globalThis, "enduranceGoalSet", {
  configurable: true,
  get: () => uiEnduranceGoalSet,
  set: (value) => {
    uiEnduranceGoalSet = !!value;
  },
});

function createUiSegments(deps: UiSegmentsDeps): UiSegmentsController {
  let segFitRaf = 0;
  // Handlers that navigate to another view. They run bare: activateTab owns the
  // swap, the route sync and the focus, so wrapping them in a second transition
  // would double-animate.
  const crossView = new WeakSet<() => unknown>();
  function navigation(fn: () => unknown): () => unknown {
    crossView.add(fn);
    return fn;
  }

  function segBar(active: unknown, items: ReadonlyArray<UiSegmentsSegment>): string {
    // The Progress seg-set renders as Train's one-level group nav; every other
    // caller keeps the flat sliding segmented bar unchanged.
    if (items === UI_PROGRESS_SEGMENTS) return uiProgressNav(String(active ?? ""));
    return deps.segmentedNavHtml({ active, items });
  }

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
    fadeSegEdges(el, overflow);
    if (overflow && !fadeWired.has(el) && typeof el.addEventListener === "function") {
      fadeWired.add(el);
      el.addEventListener("scroll", () => fadeSegEdges(el, el.classList.contains("seg-scroll")), { passive: true });
    }
  }

  // The scrolling rail's edge fades follow what is still hidden on each side.
  const fadeWired = new WeakSet<HTMLElement>();
  function fadeSegEdges(el: HTMLElement, overflow: boolean): void {
    const left = overflow && el.scrollLeft > 2;
    const right = overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    el.classList.toggle("seg-fade-l", left);
    el.classList.toggle("seg-fade-r", right);
  }

  function wireSeg(handlers: UiSegmentsHandlerMap): void {
    const drive = (button: HTMLElement, handler: () => unknown): void => {
      if (crossView.has(handler)) {
        handler();
        return;
      }
      const seg = button.closest(".seg");
      if (seg) {
        const index = [...seg.querySelectorAll<HTMLElement>(".segbtn")].indexOf(button);
        (seg as HTMLElement).style.setProperty("--segi", String(index));
      }
      deps.withViewTransition(() =>
        Promise.resolve(handler()).then(() => {
          deps.syncRouteFromState();
          return deps.viewEnter();
        })
      );
    };
    layDeeperRows();
    deps.root.querySelectorAll<HTMLElement>(".segbtn").forEach((button) =>
      button.addEventListener("click", () => {
        const handler = handlers[String(button.dataset.seg || "")];
        if (!handler) return; // group buttons (data-proggroup, no data-seg) fall to the loop below
        drive(button, handler);
      })
    );
    // Train's group buttons — a tap lands on the group's landing. Tapping the group
    // you're already on is a no-op.
    deps.root.querySelectorAll<HTMLElement>(".segbtn[data-proggroup]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.classList.contains("active")) return;
        const handler = handlers[uiTrainNav().landingOf(String(button.dataset.proggroup || ""))];
        if (handler) drive(button, handler);
      })
    );
    // Train's one-tap-deeper rows and a deeper leaf's step back to its landing.
    deps.root.querySelectorAll<HTMLElement>("[data-train-leaf]").forEach((row) =>
      row.addEventListener("click", () => {
        const handler = handlers[String(row.dataset.trainLeaf || "")];
        if (handler) drive(row, handler);
      })
    );
    deps.root.querySelectorAll(".seg").forEach(fitSeg);
  }

  // A Train landing lays its deeper rows into its own slot when it carries one
  // (the overview places them above the journey line), else at the view's end.
  // Idempotent: a repaint that kept the rows never doubles them.
  function layDeeperRows(): void {
    const root = deps.root as ParentNode & Partial<Pick<Element, "insertAdjacentHTML">>;
    if (typeof root.querySelector !== "function") return;
    const marker = root.querySelector<HTMLElement>("[data-train-landing]");
    if (!marker || root.querySelector(".train-deeper")) return;
    const html = uiProgressDeeperHtml(String(marker.dataset.trainLanding || ""));
    if (!html) return;
    const slot = root.querySelector<HTMLElement>("[data-train-deeper-slot]");
    if (slot) slot.innerHTML = html;
    else if (typeof root.insertAdjacentHTML === "function") root.insertAdjacentHTML("beforeend", html);
  }

  function scheduleFit(): void {
    deps.cancelAnimationFrame(segFitRaf);
    segFitRaf = deps.requestAnimationFrame(() => deps.root.querySelectorAll(".seg").forEach(fitSeg));
  }

  const progressHandlers: UiSegmentsHandlerMap = {
    week: () => deps.renderTrainWeek(),
    overview: () => deps.renderTrainOverview(),
    trend: () => deps.renderProgress(),
    volume: () => deps.renderVolume(),
    endurance: () => deps.renderEndurance(),
    weight: () => deps.renderWeight(),
    measurements: () => deps.renderMeasurements(),
    calendar: () => deps.renderCalendar(),
    sessions: () => deps.renderHistory(),
    program: () => deps.renderProgram(),
    intake: () => deps.renderIntake(),
    energy: () => deps.renderEnergy(),
    plan: () => openPlan("edit"),
    // Train → Fuel's "This week's menu" row opens the week menu (Today's, /app/today/menu).
    menu: () => openPlan("meals"),
  };
  navigation(progressHandlers.plan);
  navigation(progressHandlers.menu);

  function openPlan(section: ClientPlanSection): void {
    deps.state.planSeg = section;
    deps.state.planJump = section === "edit" ? null : section;
    deps.activateTab("plan");
  }

  const progressLinkHandlers: UiSegmentsHandlerMap = { plan: () => deps.renderPlanEditor() };
  for (const [leaf] of UI_PROGRESS_SEGMENTS) {
    if (UI_PROGRESS_CROSS_VIEW_LEAVES.has(leaf)) continue;
    progressLinkHandlers[leaf] = navigation(() => {
      deps.state.progressSeg = leaf as ClientProgressSection;
      deps.activateTab("progress");
    });
  }

  deps.addResizeListener(scheduleFit);

  return {
    segBar,
    wireSeg,
    fitSeg,
    progressHandlers,
    progressLinkHandlers,
  };
}

const CAIRN_UI_SEGMENTS: UiSegmentsApi = {
  PROGRESS_SEG: UI_PROGRESS_SEGMENTS,
  get PROGRESS_GROUPS() {
    return uiTrainNav().GROUPS;
  },
  progressGroupOf: (leaf: unknown) => uiTrainNav().groupOf(leaf),
  progressNav: uiProgressNav,
  progressDeeperHtml: uiProgressDeeperHtml,
  progressIsLanding: (leaf: string) => uiTrainNav().isLanding(leaf),
  create: createUiSegments,
  setDiscipline: uiSegmentsSetDiscipline,
  isEndurance: uiSegmentsIsEndurance,
  isHybrid: uiSegmentsIsHybrid,
  setEnduranceGoalSet: uiSegmentsSetEnduranceGoalSet,
  showEnduranceTab: uiSegmentsShowEnduranceTab,
};

Object.assign(globalThis, { CairnUiSegments: CAIRN_UI_SEGMENTS });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnUiSegments: CAIRN_UI_SEGMENTS });
}

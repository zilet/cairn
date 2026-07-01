// @ts-check
// Segmented navigation plus the discipline state that gates Plan's Endurance tab.

type UiSegmentsSegment = readonly [string, string];
type UiSegmentsHandlerMap = Record<string, () => unknown>;
type UiSegmentsDeps = {
  root: ParentNode;
  state: Pick<ClientAppState, "planSeg" | "planJump">;
  segmentedNavHtml(options: { active: unknown; items: ReadonlyArray<UiSegmentsSegment> }): string;
  withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
  viewEnter(): unknown;
  syncRouteFromState(): unknown;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  addResizeListener(listener: () => void): void;
  renderProgress(): unknown;
  renderVolume(): unknown;
  renderEndurance(): unknown;
  renderWeight(): unknown;
  renderCalendar(): unknown;
  renderHistory(): unknown;
  renderProgram(): unknown;
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
  planSeg(): readonly UiSegmentsSegment[];
  planHandlers: UiSegmentsHandlerMap;
};
type UiSegmentsApi = {
  PROGRESS_SEG: readonly UiSegmentsSegment[];
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
  ["sessions", "History"],
  ["trend", "1RM"],
  ["volume", "Volume"],
  ["endurance", "Endurance"],
  ["weight", "Weight"],
  ["calendar", "Calendar"],
  ["program", "Program"],
  ["energy", "Energy"],
];

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
  set: (value) => { uiPrimaryDiscipline = uiDisciplinePropertyValue(value); },
});

Object.defineProperty(globalThis, "enduranceGoalSet", {
  configurable: true,
  get: () => uiEnduranceGoalSet,
  set: (value) => { uiEnduranceGoalSet = !!value; },
});

function createUiSegments(deps: UiSegmentsDeps): UiSegmentsController {
  let segFitRaf = 0;

  function segBar(active: unknown, items: ReadonlyArray<UiSegmentsSegment>): string {
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
  }

  function wireSeg(handlers: UiSegmentsHandlerMap): void {
    deps.root.querySelectorAll<HTMLElement>(".segbtn").forEach((button) =>
      button.addEventListener("click", () => {
        const handler = handlers[String(button.dataset.seg || "")];
        if (!handler) return;
        const seg = button.closest(".seg");
        if (seg) {
          const index = [...seg.querySelectorAll<HTMLElement>(".segbtn")].indexOf(button);
          (seg as HTMLElement).style.setProperty("--segi", String(index));
        }
        deps.withViewTransition(() => Promise.resolve(handler()).then(() => {
          deps.syncRouteFromState();
          return deps.viewEnter();
        }));
      })
    );
    deps.root.querySelectorAll(".seg").forEach(fitSeg);
  }

  function scheduleFit(): void {
    deps.cancelAnimationFrame(segFitRaf);
    segFitRaf = deps.requestAnimationFrame(() => deps.root.querySelectorAll(".seg").forEach(fitSeg));
  }

  const progressHandlers: UiSegmentsHandlerMap = {
    trend: () => deps.renderProgress(),
    volume: () => deps.renderVolume(),
    endurance: () => deps.renderEndurance(),
    weight: () => deps.renderWeight(),
    calendar: () => deps.renderCalendar(),
    sessions: () => deps.renderHistory(),
    program: () => deps.renderProgram(),
    energy: () => deps.renderEnergy(),
  };

  function planSeg(): readonly UiSegmentsSegment[] {
    const routedToEndurance = deps.state.planSeg === "endurance" || deps.state.planJump === "endurance";
    return uiSegmentsShowEnduranceTab() || routedToEndurance
      ? [["edit", "Training"], ["endurance", "Endurance"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]]
      : [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]];
  }

  const planHandlers: UiSegmentsHandlerMap = {
    edit: () => deps.renderPlanEditor(),
    endurance: () => deps.renderPlanEndurance(),
    food: () => deps.renderFoodJournal(),
    meals: () => deps.renderMeals(),
    coach: () => deps.renderCoach(),
  };

  deps.addResizeListener(scheduleFit);

  return {
    segBar,
    wireSeg,
    fitSeg,
    progressHandlers,
    planSeg,
    planHandlers,
  };
}

const CAIRN_UI_SEGMENTS: UiSegmentsApi = {
  PROGRESS_SEG: UI_PROGRESS_SEGMENTS,
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

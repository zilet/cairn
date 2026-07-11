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
  renderTrainOverview(): unknown;
  renderProgress(): unknown;
  renderVolume(): unknown;
  renderEndurance(): unknown;
  renderWeight(): unknown;
  renderMeasurements(): unknown;
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
  PROGRESS_GROUPS: readonly UiSegmentsSegment[];
  progressGroupOf(leaf: unknown): string;
  progressNav(activeLeaf: string): string;
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
  ["overview", "Overview"],
  ["sessions", "History"],
  ["trend", "1RM"],
  ["volume", "Volume"],
  ["endurance", "Endurance"],
  ["weight", "Weight"],
  ["measurements", "Measurements"],
  ["calendar", "Calendar"],
  ["program", "Program"],
  ["energy", "Energy"],
];

// Progress two-level nav: the 8 flat views regroup into 4 top GROUPS, each with an
// optional sub-bar of leaves. This surfaces the flagship reads — Performance (the
// athletic standing benchmark) and Fuel (adaptive nutrition) — as their own top
// slots instead of burying them at the tail of an 8-wide scroll bar, and gives a
// "Body" home for body-composition reads. The ROUTE stays the leaf
// (/app/progress/<leaf>), so every deep link is unchanged.
const UI_PROGRESS_GROUPS: readonly UiSegmentsSegment[] = [
  ["train", "Train"],
  ["performance", "Performance"],
  ["fuel", "Fuel"],
  ["body", "Body"],
];
const UI_PROGRESS_GROUP_LEAVES: Record<string, readonly string[]> = {
  train: ["overview", "sessions", "trend", "volume", "endurance", "calendar"],
  performance: ["program"],
  fuel: ["energy"],
  body: ["weight", "measurements"],
};
const UI_PROGRESS_LEAF_GROUP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const group of Object.keys(UI_PROGRESS_GROUP_LEAVES)) {
    for (const leaf of UI_PROGRESS_GROUP_LEAVES[group]) map[leaf] = group;
  }
  return map;
})();

function uiProgressGroupOf(leaf: unknown): string {
  return UI_PROGRESS_LEAF_GROUP[String(leaf || "")] || "train";
}
function uiProgressLeafLabel(leaf: string): string {
  const found = UI_PROGRESS_SEGMENTS.find(([k]) => k === leaf);
  return found ? found[1] : leaf;
}
// A group's visible leaves — endurance is hidden unless the user's discipline
// shows it OR it's the active view (so a deep-link to it is never stranded).
function uiProgressVisibleLeaves(group: string, activeLeaf: string): string[] {
  const leaves = UI_PROGRESS_GROUP_LEAVES[group] || [];
  return leaves.filter((leaf) => leaf !== "endurance" || uiSegmentsShowEnduranceTab() || activeLeaf === "endurance");
}
function uiProgressGroupDefaultLeaf(group: string): string {
  return uiProgressVisibleLeaves(group, "")[0] || "sessions";
}

// Top group bar — mirrors segmentedNavHtml's markup (sliding thumb, aria-pressed)
// but the buttons carry data-proggroup, wired to their group's default leaf.
function uiProgressGroupBar(activeGroup: string): string {
  const gi = Math.max(
    0,
    UI_PROGRESS_GROUPS.findIndex(([k]) => k === activeGroup)
  );
  const buttons = UI_PROGRESS_GROUPS.map(([k, l]) => {
    const on = k === activeGroup;
    return `<button class="segbtn${on ? " active" : ""}" type="button" data-proggroup="${k}" aria-pressed="${on ? "true" : "false"}">${l}</button>`;
  }).join("");
  return `<div class="segwrap"><div class="seg seg-sliding" role="group" aria-label="Progress sections" style="--segn:${UI_PROGRESS_GROUPS.length};--segi:${gi}"><span class="seg-thumb" aria-hidden="true"></span>${buttons}</div></div>`;
}
// Sub-bar of the active group's leaves (leaf buttons keep data-seg so the existing
// wireSeg handler map drives them). Omitted for a single-view group.
function uiProgressSubBar(group: string, activeLeaf: string): string {
  const leaves = uiProgressVisibleLeaves(group, activeLeaf);
  if (leaves.length < 2) return "";
  const li = Math.max(0, leaves.indexOf(activeLeaf));
  const buttons = leaves
    .map((k) => {
      const on = k === activeLeaf;
      return `<button class="segbtn${on ? " active" : ""}" type="button" data-seg="${k}" aria-pressed="${on ? "true" : "false"}">${uiProgressLeafLabel(k)}</button>`;
    })
    .join("");
  return `<div class="segwrap prog-subwrap"><div class="seg seg-sliding prog-subseg" role="group" aria-label="Progress view" style="--segn:${leaves.length};--segi:${li}"><span class="seg-thumb" aria-hidden="true"></span>${buttons}</div></div>`;
}
function uiProgressNav(activeLeaf: string): string {
  const group = uiProgressGroupOf(activeLeaf);
  return uiProgressGroupBar(group) + uiProgressSubBar(group, activeLeaf);
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

  function segBar(active: unknown, items: ReadonlyArray<UiSegmentsSegment>): string {
    // The Progress seg-set renders as a two-level group/leaf nav; every other
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
  }

  function wireSeg(handlers: UiSegmentsHandlerMap): void {
    const drive = (button: HTMLElement, handler: () => unknown): void => {
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
    deps.root.querySelectorAll<HTMLElement>(".segbtn").forEach((button) =>
      button.addEventListener("click", () => {
        const handler = handlers[String(button.dataset.seg || "")];
        if (!handler) return; // group buttons (data-proggroup, no data-seg) fall to the loop below
        drive(button, handler);
      })
    );
    // Progress top-group buttons — a tap lands on the group's default leaf. Tapping
    // the group you're already in is a no-op (its sub-bar already holds the choice).
    deps.root.querySelectorAll<HTMLElement>(".segbtn[data-proggroup]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.classList.contains("active")) return;
        const handler = handlers[uiProgressGroupDefaultLeaf(String(button.dataset.proggroup || ""))];
        if (handler) drive(button, handler);
      })
    );
    deps.root.querySelectorAll(".seg").forEach(fitSeg);
  }

  function scheduleFit(): void {
    deps.cancelAnimationFrame(segFitRaf);
    segFitRaf = deps.requestAnimationFrame(() => deps.root.querySelectorAll(".seg").forEach(fitSeg));
  }

  const progressHandlers: UiSegmentsHandlerMap = {
    overview: () => deps.renderTrainOverview(),
    trend: () => deps.renderProgress(),
    volume: () => deps.renderVolume(),
    endurance: () => deps.renderEndurance(),
    weight: () => deps.renderWeight(),
    measurements: () => deps.renderMeasurements(),
    calendar: () => deps.renderCalendar(),
    sessions: () => deps.renderHistory(),
    program: () => deps.renderProgram(),
    energy: () => deps.renderEnergy(),
  };

  function planSeg(): readonly UiSegmentsSegment[] {
    const routedToEndurance = deps.state.planSeg === "endurance" || deps.state.planJump === "endurance";
    return uiSegmentsShowEnduranceTab() || routedToEndurance
      ? [
          ["edit", "Training"],
          ["endurance", "Endurance"],
          ["food", "Food"],
          ["meals", "Meals"],
        ]
      : [
          ["edit", "Training"],
          ["food", "Food"],
          ["meals", "Meals"],
        ];
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
  PROGRESS_GROUPS: UI_PROGRESS_GROUPS,
  progressGroupOf: uiProgressGroupOf,
  progressNav: uiProgressNav,
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

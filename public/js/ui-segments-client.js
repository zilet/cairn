(() => {
// @ts-check
// Segmented navigation plus the discipline state that gates Plan's Endurance tab.
const UI_PROGRESS_SEGMENTS = [
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
function normalizeUiDiscipline(discipline) {
    return discipline === "endurance" || discipline === "hybrid" ? discipline : "strength";
}
function uiDisciplinePropertyValue(discipline) {
    return String(discipline || "strength");
}
function uiSegmentsSetDiscipline(discipline) {
    uiPrimaryDiscipline = normalizeUiDiscipline(discipline);
    return uiPrimaryDiscipline;
}
function uiSegmentsIsEndurance() {
    return uiPrimaryDiscipline === "endurance";
}
function uiSegmentsIsHybrid() {
    return uiPrimaryDiscipline === "hybrid";
}
function uiSegmentsSetEnduranceGoalSet(present) {
    uiEnduranceGoalSet = !!present;
    return uiEnduranceGoalSet;
}
function uiSegmentsShowEnduranceTab() {
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
function createUiSegments(deps) {
    let segFitRaf = 0;
    function segBar(active, items) {
        return deps.segmentedNavHtml({ active, items });
    }
    function fitSeg(seg) {
        if (!seg)
            return;
        const el = seg;
        el.classList.add("seg-scroll");
        const overflow = el.scrollWidth > el.clientWidth + 1;
        seg.classList.toggle("seg-scroll", overflow);
        if (overflow) {
            const active = el.querySelector(".segbtn.active");
            if (active)
                el.scrollLeft = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
        }
    }
    function wireSeg(handlers) {
        deps.root.querySelectorAll(".segbtn").forEach((button) => button.addEventListener("click", () => {
            const handler = handlers[String(button.dataset.seg || "")];
            if (!handler)
                return;
            const seg = button.closest(".seg");
            if (seg) {
                const index = [...seg.querySelectorAll(".segbtn")].indexOf(button);
                seg.style.setProperty("--segi", String(index));
            }
            deps.withViewTransition(() => Promise.resolve(handler()).then(() => {
                deps.syncRouteFromState();
                return deps.viewEnter();
            }));
        }));
        deps.root.querySelectorAll(".seg").forEach(fitSeg);
    }
    function scheduleFit() {
        deps.cancelAnimationFrame(segFitRaf);
        segFitRaf = deps.requestAnimationFrame(() => deps.root.querySelectorAll(".seg").forEach(fitSeg));
    }
    const progressHandlers = {
        trend: () => deps.renderProgress(),
        volume: () => deps.renderVolume(),
        endurance: () => deps.renderEndurance(),
        weight: () => deps.renderWeight(),
        calendar: () => deps.renderCalendar(),
        sessions: () => deps.renderHistory(),
        program: () => deps.renderProgram(),
        energy: () => deps.renderEnergy(),
    };
    function planSeg() {
        const routedToEndurance = deps.state.planSeg === "endurance" || deps.state.planJump === "endurance";
        return uiSegmentsShowEnduranceTab() || routedToEndurance
            ? [["edit", "Training"], ["endurance", "Endurance"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]]
            : [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]];
    }
    const planHandlers = {
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
const CAIRN_UI_SEGMENTS = {
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
})();

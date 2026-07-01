(() => {
// @ts-check
// Segmented navigation plus the discipline state that gates Plan's Endurance tab.
const UI_PROGRESS_SEGMENTS = [
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
const UI_PROGRESS_GROUPS = [
    ["train", "Train"],
    ["performance", "Performance"],
    ["fuel", "Fuel"],
    ["body", "Body"],
];
const UI_PROGRESS_GROUP_LEAVES = {
    train: ["sessions", "trend", "volume", "endurance", "calendar"],
    performance: ["program"],
    fuel: ["energy"],
    body: ["weight", "measurements"],
};
const UI_PROGRESS_LEAF_GROUP = (() => {
    const map = {};
    for (const group of Object.keys(UI_PROGRESS_GROUP_LEAVES)) {
        for (const leaf of UI_PROGRESS_GROUP_LEAVES[group])
            map[leaf] = group;
    }
    return map;
})();
function uiProgressGroupOf(leaf) {
    return UI_PROGRESS_LEAF_GROUP[String(leaf || "")] || "train";
}
function uiProgressLeafLabel(leaf) {
    const found = UI_PROGRESS_SEGMENTS.find(([k]) => k === leaf);
    return found ? found[1] : leaf;
}
// A group's visible leaves — endurance is hidden unless the athlete's discipline
// shows it OR it's the active view (so a deep-link to it is never stranded).
function uiProgressVisibleLeaves(group, activeLeaf) {
    const leaves = UI_PROGRESS_GROUP_LEAVES[group] || [];
    return leaves.filter((leaf) => leaf !== "endurance" || uiSegmentsShowEnduranceTab() || activeLeaf === "endurance");
}
function uiProgressGroupDefaultLeaf(group) {
    return uiProgressVisibleLeaves(group, "")[0] || "sessions";
}
// Top group bar — mirrors segmentedNavHtml's markup (sliding thumb, aria-pressed)
// but the buttons carry data-proggroup, wired to their group's default leaf.
function uiProgressGroupBar(activeGroup) {
    const gi = Math.max(0, UI_PROGRESS_GROUPS.findIndex(([k]) => k === activeGroup));
    const buttons = UI_PROGRESS_GROUPS.map(([k, l]) => {
        const on = k === activeGroup;
        return `<button class="segbtn${on ? " active" : ""}" type="button" data-proggroup="${k}" aria-pressed="${on ? "true" : "false"}">${l}</button>`;
    }).join("");
    return `<div class="segwrap"><div class="seg seg-sliding" role="group" aria-label="Progress sections" style="--segn:${UI_PROGRESS_GROUPS.length};--segi:${gi}"><span class="seg-thumb" aria-hidden="true"></span>${buttons}</div></div>`;
}
// Sub-bar of the active group's leaves (leaf buttons keep data-seg so the existing
// wireSeg handler map drives them). Omitted for a single-view group.
function uiProgressSubBar(group, activeLeaf) {
    const leaves = uiProgressVisibleLeaves(group, activeLeaf);
    if (leaves.length < 2)
        return "";
    const li = Math.max(0, leaves.findIndex((k) => k === activeLeaf));
    const buttons = leaves.map((k) => {
        const on = k === activeLeaf;
        return `<button class="segbtn${on ? " active" : ""}" type="button" data-seg="${k}" aria-pressed="${on ? "true" : "false"}">${uiProgressLeafLabel(k)}</button>`;
    }).join("");
    return `<div class="segwrap prog-subwrap"><div class="seg seg-sliding prog-subseg" role="group" aria-label="Progress view" style="--segn:${leaves.length};--segi:${li}"><span class="seg-thumb" aria-hidden="true"></span>${buttons}</div></div>`;
}
function uiProgressNav(activeLeaf) {
    const group = uiProgressGroupOf(activeLeaf);
    return uiProgressGroupBar(group) + uiProgressSubBar(group, activeLeaf);
}
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
        // The Progress seg-set renders as a two-level group/leaf nav; every other
        // caller keeps the flat sliding segmented bar unchanged.
        if (items === UI_PROGRESS_SEGMENTS)
            return uiProgressNav(String(active ?? ""));
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
        const drive = (button, handler) => {
            const seg = button.closest(".seg");
            if (seg) {
                const index = [...seg.querySelectorAll(".segbtn")].indexOf(button);
                seg.style.setProperty("--segi", String(index));
            }
            deps.withViewTransition(() => Promise.resolve(handler()).then(() => {
                deps.syncRouteFromState();
                return deps.viewEnter();
            }));
        };
        deps.root.querySelectorAll(".segbtn").forEach((button) => button.addEventListener("click", () => {
            const handler = handlers[String(button.dataset.seg || "")];
            if (!handler)
                return; // group buttons (data-proggroup, no data-seg) fall to the loop below
            drive(button, handler);
        }));
        // Progress top-group buttons — a tap lands on the group's default leaf. Tapping
        // the group you're already in is a no-op (its sub-bar already holds the choice).
        deps.root.querySelectorAll(".segbtn[data-proggroup]").forEach((button) => button.addEventListener("click", () => {
            if (button.classList.contains("active"))
                return;
            const handler = handlers[uiProgressGroupDefaultLeaf(String(button.dataset.proggroup || ""))];
            if (handler)
                drive(button, handler);
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
        measurements: () => deps.renderMeasurements(),
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
})();

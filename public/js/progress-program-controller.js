(() => {
// @ts-check
// Progress -> Program route controller: SWR fan-out, conductor state, DOM paint, and actions.
function isProgressProgramRecord(value) {
    return !!value && typeof value === "object";
}
function progressProgramRecord(value) {
    return isProgressProgramRecord(value) ? value : {};
}
// The conductor lead for Progress -> Program. Cached as rendered HTML so the
// Program body can collapse the deep read only when a usable focus card exists.
var _progFocusCard;
const PROGRESS_FOCUS_STATE = {
    cardHtml: () => typeof _progFocusCard === "string" ? _progFocusCard : "",
    hasFocusCard: () => !!_progFocusCard,
};
Object.assign(globalThis, { CairnProgressFocus: PROGRESS_FOCUS_STATE });
if (typeof window !== "undefined") {
    window.CairnProgressFocus = PROGRESS_FOCUS_STATE;
}
// "Evolve my plan" button - POSTs to /api/program/evolve through durable runOp.
// The draft lands in Plan proposals for review; nothing auto-applies.
async function triggerProgramEvolve(btn, deps) {
    const foot = btn.closest(".prog-evolve-foot") || btn.parentElement;
    const restore = deps.busy(btn, "Drafting your plan…");
    let cap = foot && foot.querySelector(".prog-evolve-cap");
    if (foot && !cap) {
        cap = document.createElement("div");
        cap.className = "prog-evolve-cap job-cap lbl";
        foot.appendChild(cap);
    }
    const cleanup = () => { restore(); cap?.remove(); };
    await deps.runOp("evolve_program", {}, {
        path: "/program/evolve",
        anchor: ".prog-evolve-foot",
        caption: [
            "reading how your lifts are trending",
            "spotting what's stalled",
            "drafting how your plan should evolve",
            "checking it against your constraints",
        ],
        guard: () => !document.querySelector(".prog-evolve-foot")?.isConnected,
        render: () => {
            cleanup();
            deps.toast("Drafted — review it in your Plan");
            deps.invalidate("progress:program");
            deps.invalidate("plan:coach");
            deps.invalidate("plan:proposals");
            if (deps.state.tab === "progress")
                deps.renderSelf();
        },
        onFail: () => { cleanup(); deps.toast("Couldn't draft right now — try again in a bit."); },
    });
}
async function renderProgressProgram(deps) {
    deps.headerTitle.textContent = "Progress";
    deps.state.progressSeg = "program";
    const token = deps.nextToken();
    const peek = deps.peekCached("progress:program");
    if (!peek)
        deps.view.innerHTML = deps.skeletonHtml("program", 3);
    // Fetch the conductor in parallel. It never blocks the warm Program paint; if the
    // card presence changes, repaint from the cached program-state payload.
    deps.api("/coaching-focus").then((focus) => {
        const card = (typeof coachingFocusCardHtml === "function")
            ? coachingFocusCardHtml(focus)
            : "";
        const prev = _progFocusCard;
        _progFocusCard = card;
        if (card === prev)
            return;
        if (!card && (prev === undefined || prev === ""))
            return;
        if (deps.isCurrent(token) && deps.state.tab === "progress" && deps.state.progressSeg === "program") {
            const cached = deps.peekCached("progress:program");
            if (cached)
                paintProgressProgramBody(cached.data, deps);
        }
    }).catch(() => { });
    return deps.paintSWR({
        key: "progress:program",
        path: "/program-state",
        peek,
        token,
        tab: "progress",
        render: (data) => paintProgressProgramBody(data, deps),
    });
}
function paintProgressProgramBody(data, deps) {
    const head = deps.segmentHtml("program");
    const lifts = data.lifts;
    const volume = data.volume;
    const meso = data.mesocycle || null;
    const endurance = data.endurance || null;
    const headline = data.headline || "";
    const adaptations = data.adaptations_due;
    if (!lifts.length && !volume.length && !meso && !endurance) {
        deps.view.innerHTML = head + deps.hero("Program", []) +
            deps.empty(deps.art("exercise", "barbell squat"), "Not enough data yet — log a few sessions and your program intelligence will read here.");
        deps.wireSegments();
        return;
    }
    const sorted = sortLifts(lifts);
    const nStalled = sorted.filter((lift) => lift.status === "plateaued" || lift.status === "regressing").length;
    const nGood = sorted.filter((lift) => lift.status === "progressing").length;
    const heroStats = [];
    if (lifts.length)
        heroStats.push(["lifts tracked", lifts.length]);
    if (nGood)
        heroStats.push(["climbing", nGood]);
    if (nStalled)
        heroStats.push(["stalled", nStalled]);
    const conductor = CairnProgressFocus.cardHtml();
    const hasConductor = !!conductor;
    const headlineHtml = headline ? `<div class="prog-headline reveal" style="${stagger(1)}">${escHtml(headline)}</div>` : "";
    const testSlot = `<div id="progTestSlot" class="ptest-slot reveal" style="${stagger(1)}"></div>`;
    const perfSlot = `<div id="progPerfSlot" class="pperf-slot reveal" style="${stagger(2)}"></div>`;
    const blockSlot = `<div id="progBlockSlot" class="pblock-slot reveal" style="${stagger(2)}"></div>`;
    const adjustSlot = `<div id="progAdjustSlot" class="padj-slot reveal" style="${stagger(3)}"></div>`;
    const muscleSlot = `<div id="progMuscleSlot" class="pmus-slot reveal" style="${stagger(3)}"></div>`;
    const dexaSlot = `<div id="progDexaSlot" class="pdexa-slot reveal" style="${stagger(3)}"></div>`;
    const adaptHtml = adaptations.length ? adaptationsHtml(adaptations, 4) : "";
    let liftsHtml = "";
    if (sorted.length) {
        liftsHtml += `<div class="prow-section-head lbl reveal" style="${stagger(5)}">Lifts</div>`;
        liftsHtml += sorted.map((lift, i) => liftRowHtml(lift, 6 + i)).join("");
    }
    const volumeHtml = volume.length
        ? `<div class="pvol-head lbl reveal" style="${stagger(2)}">Weekly volume by muscle</div>` + volumeBlockHtml(volume, 3)
        : "";
    const mesoHtml = meso ? mesoBlockHtml(meso, 4) : "";
    const endHtml = endurance ? enduranceBlockHtml(endurance, 5) : "";
    const evolveFoot = `<div class="prog-evolve-foot reveal" style="${stagger(7)}">
    <button class="draftbtn prog-evolve-btn" id="progEvolveBtn" type="button">Evolve my plan</button>
    <span class="prog-evolve-note lbl">asks the coach to draft an updated plan — you review before anything changes</span>
    <button id="progTidyBtn" class="ghostbtn" style="width:100%;text-align:center;padding:9px;margin-top:11px" type="button">Tidy exercise names</button>
    <span class="prog-evolve-note lbl">Different logs name the same lift differently — Cairn merges duplicates so each one tracks as one line. Runs automatically as you log.</span>
  </div>`;
    let html = "";
    if (hasConductor) {
        html = head + deps.hero("Program", heroStats) + conductor + liftsHtml +
            `<details class="full-read reveal" style="${stagger(6)}">
        <summary>The full read</summary>
        <div class="full-read-body">${headlineHtml + testSlot + perfSlot + blockSlot + adjustSlot + muscleSlot + dexaSlot +
                adaptHtml + volumeHtml + mesoHtml + endHtml}</div>
      </details>` + evolveFoot;
    }
    else {
        html = head + deps.hero("Program", heroStats) +
            headlineHtml + testSlot + perfSlot + blockSlot + adjustSlot + muscleSlot + dexaSlot +
            adaptHtml + liftsHtml + volumeHtml + mesoHtml + endHtml + evolveFoot;
    }
    deps.view.innerHTML = html;
    deps.wireSegments();
    deps.runCountUps(deps.view);
    const evolveBtn = deps.view.querySelector("#progEvolveBtn");
    if (evolveBtn)
        evolveBtn.addEventListener("click", () => { void triggerProgramEvolve(evolveBtn, deps); });
    const tidyBtn = deps.view.querySelector("#progTidyBtn");
    if (tidyBtn)
        tidyBtn.addEventListener("click", () => { void tidyExerciseNames(tidyBtn, deps); });
    loadPerformance();
    loadProgramBlock();
    loadProgramAdjustments();
    loadTestWeek();
    loadMuscleTrajectory();
    loadDexaTargeting("progDexaSlot");
}
// "Tidy exercise names" merges duplicate movements so each lift tracks as one line.
async function tidyExerciseNames(btn, deps) {
    const restore = deps.busy(btn, "tidying…");
    let result = null;
    try {
        result = await deps.api("/exercises/reconcile-names", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
        });
    }
    catch {
        result = null;
    }
    restore();
    const row = progressProgramRecord(result);
    if (!isProgressProgramRecord(result) || row.ok === false) {
        deps.toast("Couldn't tidy names — try again.");
        return;
    }
    const n = Number(row.aligned ?? row.applied) || 0;
    deps.toast(n ? `Tidied ${n} exercise name${n === 1 ? "" : "s"}` : "Names already tidy");
    if (n) {
        deps.invalidate("progress:program");
        deps.renderSelf();
    }
}
const CAIRN_PROGRESS_PROGRAM_CONTROLLER = {
    focus: PROGRESS_FOCUS_STATE,
    render: renderProgressProgram,
    paint: paintProgressProgramBody,
    triggerProgramEvolve,
    tidyExerciseNames,
};
Object.assign(globalThis, { CairnProgressProgramController: CAIRN_PROGRESS_PROGRAM_CONTROLLER });
if (typeof window !== "undefined") {
    window.CairnProgressProgramController = CAIRN_PROGRESS_PROGRAM_CONTROLLER;
}
})();

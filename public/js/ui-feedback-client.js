(() => {
// @ts-check
// Shared UI feedback/loading primitives for the vanilla PWA.
// Staggered entrance delay for `.reveal` cards; index capped so long lists do not crawl in.
function stagger(i) {
    return `--i:${Math.min(i ?? 0, 12)}`;
}
function reducedMotion() {
    return "matchMedia" in window && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
// Put a button into a calm "working" state for the length of an agentic call.
function btnBusy(btn, label, { ghost = false } = {}) {
    if (!btn)
        return () => { };
    const busyBtn = btn;
    const button = btn;
    if (busyBtn._busyRestore)
        return busyBtn._busyRestore;
    const html = button.innerHTML;
    const wasDisabled = button.disabled;
    const minW = button.style.minWidth;
    const text = label != null ? label : (button.textContent || "").trim();
    button.style.minWidth = button.offsetWidth + "px";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.classList.add("btn-busy");
    button.innerHTML = `<span class="btn-working"><span class="aspin aspin-sm${ghost ? " aspin-ghost" : ""}"></span>${escHtml(text)}</span>`;
    const restore = () => {
        if (busyBtn._busyRestore !== restore)
            return;
        busyBtn._busyRestore = null;
        button.innerHTML = html;
        button.disabled = wasDisabled;
        button.removeAttribute("aria-busy");
        button.classList.remove("btn-busy");
        button.style.minWidth = minW;
    };
    busyBtn._busyRestore = restore;
    return restore;
}
// Count a numeral up from 0 -> target. Respects prefers-reduced-motion by snapping.
function countUp(el, target, { dur = 750, fmt = (v) => Math.round(v).toLocaleString() } = {}) {
    if (!el)
        return;
    const t = Number(target) || 0;
    if (reducedMotion() || !t) {
        el.textContent = fmt(t);
        return;
    }
    const t0 = performance.now();
    const tick = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - (1 - p) ** 3;
        el.textContent = fmt(t * eased);
        if (p < 1 && el.isConnected)
            requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}
function loadingState(label) {
    return CairnUi.loadingStateHtml({ label });
}
const THINKING_SCRIPTS = {
    session_suggest: ["Reading your week…", "Weighing recovery…", "Shaping today's session…", "Choosing the right load…"],
    proposal: ["Reading your training…", "Weighing your recent sessions…", "Drafting next week's targets…", "Keeping the progression honest…"],
    endurance_runs: ["Reading your running…", "Checking your mileage and goal…", "Shaping this week's runs…", "Keeping it aerobic and conservative…"],
    meal_plan: ["Reading your week…", "Balancing the macros…", "Plating the days…", "Checking the protein floor…"],
    meal_swap: ["Reading the meal…", "Finding a match…", "Holding the macros…", "Plating the swap…"],
    recipe: ["Opening the kitchen…", "Sourcing the ingredients…", "Writing the steps…", "Tasting as it goes…"],
    nutrition_checkin: ["Reading your intake…", "Tracing the trend…", "Weighing the drift…", "Settling on a number…"],
    day_read_override: ["Hearing you…", "Re-reading the day…", "Reshaping the brief…"],
    chat_distill: ["Looking back over the thread…", "Keeping what matters…", "Tidying the rest away…"],
    onboard: ["Hearing you out…", "Folding it into your picture…", "Noting what matters…", "Setting things up…"],
    insight: ["Connecting the dots…", "Crossing the domains…", "Listening for one real thread…"],
};
function thinkingCaption(el, op) {
    if (!el)
        return () => { };
    const target = el;
    const lines = THINKING_SCRIPTS[String(op)] || ["Thinking…"];
    const paint = (txt) => {
        target.textContent = txt;
        if (!reducedMotion()) {
            target.style.animation = "none";
            void target.offsetWidth;
            target.style.animation = "";
        }
    };
    target.classList.add("typing-cap");
    paint(lines[0]);
    if (reducedMotion() || lines.length < 2)
        return () => { };
    let i = 0;
    const timer = setInterval(() => {
        if (!target.isConnected) {
            clearInterval(timer);
            return;
        }
        i = i + 1 >= lines.length ? Math.max(1, lines.length - 2) : i + 1;
        paint(lines[i]);
    }, 2600);
    return () => clearInterval(timer);
}
function tabErrorState(tab) {
    view.innerHTML = `<div class="loadstate" role="alert">
    <div class="loadstate-label">Couldn't load this view — check your connection.</div>
    <button class="ghostbtn" data-tabretry style="margin-top:10px">Try again</button>
  </div>`;
    const btn = view.querySelector("[data-tabretry]");
    if (btn)
        btn.addEventListener("click", () => switchTab(tab));
}
function skelLines(n = 3) {
    let s = `<div class="skel-card" aria-hidden="true"><div class="hshimmer hshimmer-lg"></div>`;
    for (let i = 0; i < n; i++)
        s += `<div class="hshimmer${i === n - 1 ? " hshimmer-sm" : ""}"></div>`;
    return s + `</div>`;
}
function todaySkeleton() {
    return `<div class="today-wrap today-skel" aria-busy="true">
    <div class="skel-brief" aria-hidden="true">
      <div class="hshimmer hshimmer-sm" style="width:34%"></div>
      <div class="hshimmer hshimmer-lg" style="width:64%;height:26px"></div>
      <div class="hshimmer"></div>
    </div>
    ${skelLines(2)}
    ${skelLines(3)}
  </div>`;
}
function segSkeleton(active, seg, cards = 2) {
    let s = segBar(active, seg) + `<div class="skel-region" aria-busy="true">${skelLines(2)}`;
    for (let i = 0; i < cards; i++)
        s += skelLines(3);
    return s + `</div>`;
}
function fmtK(n) {
    const v = Number(n) || 0;
    return v >= 10000 ? `${Math.round(v / 100) / 10}k` : Math.round(v).toLocaleString();
}
function runCountUps(scope, { snap = false } = {}) {
    (scope || view).querySelectorAll("[data-cu]").forEach((el) => {
        const fmt = el.dataset.cufmt === "k" ? fmtK : (x) => Math.round(x).toLocaleString();
        if (snap) {
            el.textContent = fmt(Number(el.dataset.cu) || 0);
            return;
        }
        countUp(el, Number(el.dataset.cu) || 0, { fmt });
    });
}
const CAIRN_UI_FEEDBACK = {
    stagger,
    reducedMotion,
    btnBusy,
    countUp,
    fmtK,
    runCountUps,
    loadingState,
    thinkingCaption,
    tabErrorState,
    skelLines,
    todaySkeleton,
    segSkeleton,
};
Object.assign(globalThis, {
    CairnUiFeedback: CAIRN_UI_FEEDBACK,
    stagger,
    reducedMotion,
    btnBusy,
    countUp,
    fmtK,
    runCountUps,
    loadingState,
    thinkingCaption,
    tabErrorState,
    skelLines,
    todaySkeleton,
    segSkeleton,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnUiFeedback: CAIRN_UI_FEEDBACK,
        stagger,
        reducedMotion,
        btnBusy,
        countUp,
        fmtK,
        runCountUps,
        loadingState,
        thinkingCaption,
        tabErrorState,
        skelLines,
        todaySkeleton,
        segSkeleton,
    });
}
})();

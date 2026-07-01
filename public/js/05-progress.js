(() => {
// ==== 05-progress.js ====
// ---------- Progress: est-1RM trend ----------
// SWR over /exercises (key progress:exercises): the 1RM seg paints its exercise
// picker + chart shell instantly on a warm re-entry, then revalidates.
async function renderProgress() {
    headerTitle.textContent = "Progress";
    state.progressSeg = "trend";
    const token = ++pollToken;
    const peek = peekCached("progress:exercises");
    if (!peek)
        view.innerHTML = segSkeleton("trend", PROGRESS_SEG, 1); // cold: skeleton-first
    return paintSWR({
        key: "progress:exercises",
        path: "/exercises",
        peek: peek,
        token,
        tab: "progress",
        render: (exercises) => paintProgressBody(CairnProgressData.rows(exercises)),
    });
}
function paintProgressBody(exercises) {
    const saved = state.progressEx || exercises[0]?.name;
    view.innerHTML = segBar("trend", PROGRESS_SEG) + `<div id="trendHero"></div>
    <div class="field"><label>Exercise</label>
    <select id="exsel">${exercises.map((e) => `<option ${e.name === saved ? "selected" : ""}>${escHtml(e.name)}</option>`).join("")}</select></div>
    <canvas id="chart"></canvas><div id="pstats"></div>`;
    wireSeg(PROGRESS_HANDLERS);
    const select = $("#exsel");
    if (select)
        select.addEventListener("change", () => { state.progressEx = select.value; drawProgress(select.value); });
    drawProgress(saved);
}
// ---------- Progress: bodyweight ----------
// SWR over /bodyweight?limit=90 (key progress:weight) + the shared /profile (key
// `profile`, for the goal line): the Weight seg paints its chart instantly on a
// warm re-entry, then revalidates. A bodyweight log invalidates progress:weight.
async function renderWeight() {
    headerTitle.textContent = "Progress";
    state.progressSeg = "weight";
    const token = ++pollToken;
    const peekRows = peekCached("progress:weight");
    const peekProfile = peekCached("profile");
    if (!peekRows)
        view.innerHTML = segSkeleton("weight", PROGRESS_SEG, 1); // cold: skeleton-first
    const paint = (rows, profile) => {
        if (token !== pollToken || state.tab !== "progress")
            return;
        paintWeightBody(CairnProgressData.rows(rows), CairnProgressData.record(profile));
    };
    // Profile rides along (peeked + revalidated under its shared key); the weight
    // rows are the SWR-keyed surface that actually changes here.
    let profile = peekProfile ? peekProfile.data : null;
    cachedApi("/profile", { key: "profile", onUpgrade: (data) => { profile = data; } }).catch(() => { });
    if (peekRows) {
        paint(peekRows.data, profile);
        if (!peekRows.fresh)
            markRefreshing(true);
    }
    cachedApi("/bodyweight?limit=90", {
        key: "progress:weight",
        onUpgrade: (rows, { changed }) => { if (peekRows && !peekRows.fresh)
            markRefreshing(false); if (changed || !peekRows)
            skelSwap(() => paint(rows, profile)); },
    }).catch(() => { if (peekRows && !peekRows.fresh)
        markRefreshing(false); });
}
function paintWeightBody(rows, profile) {
    const head = segBar("weight", PROGRESS_SEG);
    const pts = rows.map((p) => ({ date: CairnProgressData.string(p.date), v: CairnProgressData.number(p.weight_lb) }));
    if (!pts.length) {
        view.innerHTML = head + progressHero("Bodyweight", []) +
            emptyStateHtml(art("activity", "walk"), "No weigh-ins yet — log one from the Today strip.");
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const goalW = profile.goal_weight_lb != null ? CairnProgressData.number(profile.goal_weight_lb) : null;
    const first = pts[0].v, last = pts[pts.length - 1].v;
    const delta = Math.round((last - first) * 10) / 10;
    const toGoal = goalW != null ? Math.round((last - goalW) * 10) / 10 : null;
    const hero = progressHero("Bodyweight", [
        ["current · lb", last, { text: true }],
        ["change", `${delta >= 0 ? "+" : ""}${delta}`, { text: true }],
        toGoal != null ? ["to goal", toGoal > 0 ? String(toGoal) : "at goal", { text: true }] : null,
    ]);
    view.innerHTML = head + hero + `<canvas id="chart"></canvas>
    <div class="chart-foot lbl">${pts.length} weigh-in${pts.length === 1 ? "" : "s"}${goalW != null ? ` · goal ${goalW} lb` : ""}</div>`;
    wireSeg(PROGRESS_HANDLERS);
    runCountUps(view);
    drawLineChart($("#chart"), pts, { goal: goalW ?? null, fmt: (v) => `${Math.round(v * 10) / 10} lb` });
}
async function drawProgress(name) {
    const data = await api("/progress/" + encodeURIComponent(name));
    const row = CairnProgressData.record(data);
    const canvas = $("#chart"), stats = $("#pstats"), heroWrap = $("#trendHero");
    if (!canvas || !canvas.isConnected)
        return; // navigated away mid-fetch
    const pts = CairnProgressData.rows(row.points).map((p) => ({
        date: CairnProgressData.string(p.date),
        v: CairnProgressData.number(p.best1rm),
    }));
    if (!pts.length) {
        if (heroWrap)
            heroWrap.innerHTML = progressHero("Estimated 1RM", []);
        canvas.style.display = "none";
        if (stats)
            stats.innerHTML = emptyStateHtml(art("exercise", name), `No data for ${name} yet.`);
        return;
    }
    canvas.style.display = "";
    const first = pts[0].v, last = pts[pts.length - 1].v;
    const delta = Math.round((last - first) * 10) / 10;
    if (heroWrap) {
        heroWrap.innerHTML = progressHero("Estimated 1RM", [
            ["current est-1rm", Math.round(last)],
            ["since first", `${delta >= 0 ? "+" : ""}${delta}`, { text: true }],
            ["sessions", pts.length],
        ]);
        runCountUps(heroWrap);
    }
    drawLineChart(canvas, pts, { peak: true });
    if (stats)
        stats.innerHTML = `<div class="chart-foot lbl">Epley est. · best set per day · ${escHtml(row.unit || "lb")} · ▲ all-time peak</div>`;
}
// ---------- Progress: volume by muscle group ----------
// SWR over /volume?days=30 (key progress:volume): the Volume seg paints the
// per-muscle bars instantly on a warm re-entry, then revalidates.
async function renderVolume() {
    headerTitle.textContent = "Progress";
    state.progressSeg = "volume";
    const token = ++pollToken;
    const peek = peekCached("progress:volume");
    if (!peek)
        view.innerHTML = segSkeleton("volume", PROGRESS_SEG, 2); // cold: skeleton-first
    return paintSWR({
        key: "progress:volume",
        path: "/volume?days=30",
        peek: peek,
        token,
        tab: "progress",
        render: (data) => paintVolumeBody(CairnProgressData.record(data)),
    });
}
function paintVolumeBody(data) {
    const groups = CairnProgressData.rows(data.by_muscle).slice()
        .sort((a, b) => CairnProgressData.number(b.sets) - CairnProgressData.number(a.sets));
    const head = segBar("volume", PROGRESS_SEG);
    if (!groups.length) {
        view.innerHTML = head + progressHero("Volume", []) +
            emptyStateHtml(art("exercise", "barbell row"), `Nothing logged in the last ${CairnProgressData.number(data.days, 30)} days.`);
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const totalSets = groups.reduce((t, g) => t + CairnProgressData.number(g.sets), 0);
    const maxSets = Math.max(1, ...groups.map((g) => CairnProgressData.number(g.sets)));
    const hero = progressHero("Volume", [
        ["sets · 30d", totalSets],
        ["lb moved · 30d", data.total_tonnage || 0, { k: true }],
        ["top muscle", groups[0].muscle_group, { text: true }],
    ]);
    const rows = groups.map((g, i) => `
    <div class="volrow reveal" style="${stagger(i + 2)}">
      <div class="volrow-top">
        <span class="volrow-name">${escHtml(g.muscle_group)}</span>
        <span class="volrow-meta"><b>${CairnProgressData.number(g.sets)}</b> set${CairnProgressData.number(g.sets) === 1 ? "" : "s"} · ${CairnProgressData.number(g.tonnage).toLocaleString()} lb</span>
      </div>
      <div class="volbar"><div class="volbar-fill barfill" style="width:${Math.max(3, Math.round((CairnProgressData.number(g.sets) / maxSets) * 100))}%"></div></div>
    </div>`).join("");
    view.innerHTML = head + hero +
        `<div id="volBalanceSlot" class="vol-balance-slot reveal" style="${stagger(1)}"></div>` +
        `<div class="vol-kicker lbl reveal" style="${stagger(2)}">Last ${CairnProgressData.number(data.days, 30)} days · ranked by sets</div>` + rows;
    wireSeg(PROGRESS_HANDLERS);
    runCountUps(view);
    // The balance read settles in above the bars (best-effort, async) — the engine
    // reads your volume per canonical muscle group, names what's DUE and what's
    // running high, and flags the patterns (core / grip / mobility) that are absent.
    loadVolumeBalance();
}
// ---------- Volume: the balance read (which groups are due / high / missing) ----------
// Fed by GET /api/program/balance — working-set volume per CANONICAL group banded
// against the volume landmarks, in PLAIN WORDS (never a 0–100 grade). Surfaces the
// adherence skew (summary) + the due / high groups + the missing-pattern gaps the
// new taxonomy made visible (core, forearms/grip). Best-effort + null-safe: the
// SURFACE endpoint may not be wired yet (404) — guard like every optional fetch,
// leaving the bars untouched if it's missing. Constitution: pull, never push.
async function loadVolumeBalance() {
    const slot = view.querySelector("#volBalanceSlot");
    if (!slot)
        return;
    let bal = null;
    try {
        bal = await api("/program/balance");
    }
    catch {
        bal = null;
    }
    if (state.tab !== "progress" || state.progressSeg !== "volume" || !slot.isConnected)
        return;
    const html = volBalanceHtml(bal);
    if (!html) {
        slot.innerHTML = "";
        return;
    }
    slot.innerHTML = html;
}
// ---------- Progress: Endurance (runner/cyclist-first read) ----------
async function renderEndurance() {
    await CairnProgressEnduranceController.render(CairnProgressRouteDeps.endurance(() => renderEndurance()));
}
function paintEnduranceBody(end, prs, goal, compliance, settings, runPlan) {
    CairnProgressEnduranceController.paint(end, prs, goal, compliance, settings, runPlan, CairnProgressRouteDeps.endurance(() => renderEndurance()));
}
// SWR over /calendar?days=84 (key progress:calendar): the Calendar seg paints its
// month grids instantly on a warm re-entry, then revalidates.
async function renderCalendar() {
    headerTitle.textContent = "Progress";
    state.progressSeg = "calendar";
    const token = ++pollToken;
    const peek = peekCached("progress:calendar");
    if (!peek)
        view.innerHTML = segSkeleton("calendar", PROGRESS_SEG, 2); // cold: skeleton-first
    return paintSWR({
        key: "progress:calendar",
        path: "/calendar?days=84",
        peek: peek,
        token,
        tab: "progress",
        render: (data) => paintCalendarBody(CairnProgressData.record(data)),
    });
}
function paintCalendarBody(data) {
    const cells = CairnProgressData.rows(data.cells);
    const head = segBar("calendar", PROGRESS_SEG);
    if (!cells.length) {
        view.innerHTML = head + progressHero("Calendar", []) +
            emptyStateHtml(art("activity", "run"), "No activity logged yet.");
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const todayIso = localISO();
    const byDate = new Map(cells.map((c) => [CairnProgressData.string(c.date), c]));
    const ym = todayIso.slice(0, 7);
    const monthSessions = cells.filter((c) => (c.date || "").slice(0, 7) === ym && c.lifted).length;
    const activeDays = cells.filter((c) => c.lifted || c.activity).length;
    // Honest continuity, not a streak: cumulative session counts that never reset.
    // (A reset-on-miss "day streak" is the chain-you-fear-breaking mechanic the
    // constitution rules out — §2/§6C of VISION.md. The deterministic streak value
    // still exists in getWeeklyStats for agent context; it just isn't surfaced here.)
    const windowSessions = cells.filter((c) => c.lifted).length;
    const hero = progressHero("Calendar", [
        ["sessions this month", monthSessions],
        ["sessions · 12wk", windowSessions],
        ["active days · 84d", activeDays],
    ]);
    const months = [...new Set(cells.map((c) => CairnProgressData.string(c.date).slice(0, 7)))].filter(Boolean).reverse();
    const grids = months.map((mo, i) => calMonthHtml(mo, byDate, todayIso, i + 1)).join("");
    const legend = `<div class="cal-legend"><span>Less</span><i class="cl0"></i><i class="cl1"></i><i class="cl2"></i><i class="cl3"></i><i class="cl4"></i><span>More</span></div>`;
    view.innerHTML = head + hero + grids + legend;
    wireSeg(PROGRESS_HANDLERS);
    runCountUps(view);
    // tap a day with data → open it on Today
    view.querySelectorAll(".cal-day[data-goto]").forEach((el) => el.addEventListener("click", () => {
        state.logDate = el.dataset.goto || state.logDate;
        state.day = null;
        state.dayPicked = false;
        activateTab("today");
    }));
}
// ---------- Progress: Energy Balance (adaptive, MacroFactor-style) ----------
// A calm editorial read of derived expenditure (real TDEE from intake −
// Δweighted-bodyweight). Adherence-NEUTRAL: never scolds about logging gaps,
// never shows a gauge or a score. When there's not enough data, a quiet
// "keep logging when you can". A subtle "run a check-in" affordance sits below;
// the check-in is an ADVISORY recommendation (no clean one-click target field —
// calories live in the meal plan), never an auto-apply.
// SWR over /nutrition/expenditure?window=21 (key progress:energy): the Energy
// Balance seg paints its derived read instantly on a warm re-entry, then
// revalidates. The shell (#checkinResult) is preserved across re-fills so an
// in-flight nutrition check-in card is never clobbered by a background refresh.
async function renderEnergy() {
    headerTitle.textContent = "Progress";
    state.progressSeg = "energy";
    const token = ++pollToken;
    const head = segBar("energy", PROGRESS_SEG);
    const peek = peekCached("progress:energy");
    // Always paint the shell; only the #energyCard slot shows a loading state on cold.
    view.innerHTML = head + `<div id="energyHero"></div>
    <div id="energyCard">${peek ? "" : loadingState("Reading your trend…")}</div>
    <div id="checkinResult" class="checkin-result"></div>`;
    wireSeg(PROGRESS_HANDLERS);
    const paint = (exp) => {
        if (token !== pollToken || !view.querySelector("#energyCard"))
            return;
        paintEnergyBody(exp);
    };
    if (peek) {
        paint(peek.data);
        if (!peek.fresh)
            markRefreshing(true);
    }
    cachedApi("/nutrition/expenditure?window=21", {
        key: "progress:energy",
        onUpgrade: (exp, { changed }) => { if (peek && !peek.fresh)
            markRefreshing(false); if (changed || !peek)
            paint(exp); },
    }).catch(() => { if (peek && !peek.fresh)
        markRefreshing(false); });
}
// Energy Balance DOM painting and durable nutrition check-in reconnect live in
// /js/progress-energy-surface-client.js so Progress and Plan Food share one
// implementation. This screen keeps only the route/SWR shell above.
// ---------- Progress: Program (adaptive program intelligence) ----------
// The controller owns Program SWR orchestration, conductor state, DOM composition,
// and actions. The shared route dependency adapter lives in progress-route-deps-client.
async function renderProgram() {
    return CairnProgressProgramController.render(CairnProgressRouteDeps.program(() => renderProgram()));
}
Object.assign(globalThis, {
    renderCalendar,
    renderEnergy,
    renderEndurance,
    renderProgram,
    renderProgress,
    renderVolume,
    renderWeight,
});
})();

(() => {
function isProgressRecord(value) {
    return !!value && typeof value === "object";
}
function progressRecord(value) {
    return isProgressRecord(value) ? value : {};
}
function progressRows(value) {
    return Array.isArray(value) ? value.filter(isProgressRecord) : [];
}
function progressString(value) {
    return typeof value === "string" ? value : value == null ? "" : String(value);
}
function progressNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
// ---------- Progress: History ----------
// SWR over /sessions?limit=30 (key history:sessions): a warm re-entry into the
// History seg paints the hero + session cards instantly, then revalidates and
// re-paints only on change. A set-log / session-edit invalidates the key.
async function renderHistory() {
    headerTitle.textContent = "Progress";
    state.progressSeg = "sessions"; // remember the chosen seg so the default never yanks back
    const token = ++pollToken;
    const peek = peekCached("history:sessions");
    if (!peek)
        view.innerHTML = segSkeleton("sessions", PROGRESS_SEG, 3); // cold: skeleton-first
    return paintSWR({
        key: "history:sessions",
        path: "/sessions?limit=30",
        peek: peek,
        token,
        tab: "progress",
        render: (sessions) => paintHistoryBody(progressRows(sessions)),
    });
}
// Build + wire the History view from a sessions list. Idempotent: re-queries the
// freshly-written DOM each call (warm peek + changed revalidate both route here).
function paintHistoryBody(sessions) {
    const head = segBar("sessions", PROGRESS_SEG);
    if (!sessions.length) {
        view.innerHTML = head + progressHero("Training history", []) +
            emptyStateHtml(art("exercise", "barbell squat"), "No sessions logged yet \u2014 your story starts on Today.");
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const ym = localISO().slice(0, 7);
    const iso30 = localISO(new Date(Date.now() - 30 * 864e5));
    const inMonth = sessions.filter((s) => (s.date || "").slice(0, 7) === ym).length;
    const last30 = sessions.filter((s) => (s.date || "") >= iso30);
    const t30 = last30.reduce((t, s) => t + setsTonnage(s.sets), 0);
    const sets30 = last30.reduce((t, s) => t + (s.sets || []).length, 0);
    const hero = progressHero("Training history", [
        ["sessions this month", inMonth],
        ["lb moved \u00b7 30d", Math.round(t30), { k: true }],
        ["sets \u00b7 30d", sets30],
    ]);
    view.innerHTML = head + hero + `<div class="sess-grid">${sessions.map((s, i) => sessionCardHtml(s, i + 1)).join("")}</div>`;
    wireSeg(PROGRESS_HANDLERS);
    runCountUps(view);
    // Tap a past session → edit its logged sets + notes (corrections flow into the brain).
    const openFrom = (card) => {
        const sess = sessions.find((s) => s.id === Number(card.dataset.sessid));
        if (sess)
            openSessionEdit(sess, card);
    };
    view.querySelectorAll(".hist-tap[data-sessid]").forEach((card) => {
        card.addEventListener("click", () => openFrom(card));
        card.addEventListener("keydown", (event) => {
            const e = event;
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openFrom(card);
            }
        });
    });
}
// Edit a past session: correct any logged set's numbers (or duration), delete a
// mis-entry, fix the notes. Saves via PUT /sets/:id + PUT /sessions/:id/notes — and
// because trainingSignals re-reads sessions live, the coach sees the correction on
// its next read. No score, no judgement — just "fix what you logged".
async function openSessionEdit(sess, fromEl) {
    const sets = (sess.sets || []).slice().sort((a, b) => progressNumber(a.id) - progressNumber(b.id));
    const byEx = {};
    for (const s of sets) {
        const key = progressString(s.exercise) || "Exercise";
        (byEx[key] ??= []).push(s);
    }
    const groups = Object.entries(byEx).map(([ex, list]) => {
        const setRows = list.map((s) => {
            const timed = s.duration_sec != null || s.mode === "timed";
            const fields = timed
                ? `<input class="edset-dur" inputmode="numeric" value="${s.duration_sec != null ? fmtDur(s.duration_sec) : ""}" placeholder="1:30" aria-label="duration">`
                : `<input class="edset-w" type="number" inputmode="decimal" value="${s.weight ?? ""}" placeholder="wt" aria-label="weight">
           <input class="edset-r" type="number" inputmode="numeric" value="${s.reps ?? ""}" placeholder="reps" aria-label="reps">
           <input class="edset-rir" type="number" inputmode="numeric" value="${s.rir ?? ""}" placeholder="rir" aria-label="rir">`;
            return `<div class="edset" data-setid="${s.id}" data-kind="${timed ? "timed" : "reps"}">
          ${fields}
          <button class="edset-del" data-eddel="${s.id}" title="Delete set" aria-label="Delete set">×</button>
        </div>`;
        }).join("");
        return `<div class="ed-exgroup"><div class="ed-exname">${escHtml(ex)}</div>${setRows}</div>`;
    }).join("");
    openDetailFrom(fromEl, () => {
        const el = mountDetail(`
      <h2 class="detail-title">${escHtml(sess.title || sess.day_name || "Session")}</h2>
      <div class="detail-ctx lbl">${escHtml(fmtShortDate(sess.date))} · edit logged sets</div>
      <div class="ed-sets">${groups || `<div class="detail-body" style="color:var(--muted)">No sets logged.</div>`}</div>
      <div class="detail-section"><div class="lbl">Session notes</div>
        <textarea id="edNotes" class="ed-notes" rows="2" placeholder="How did it go?">${escHtml(sess.notes || "")}</textarea></div>
      <div class="detail-actions">
        <button class="pillbtn pill-accent" id="edSave">Save changes</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`);
        wireDetailCommon();
        // delete a set inline — two-tap armed × (the one destructive-confirm pattern),
        // then the row collapses out (deletion is committed on the confirming tap).
        el.querySelectorAll("[data-eddel]").forEach((b) => b.addEventListener("click", () => armDelete(b, async () => {
            try {
                await api(`/sets/${b.dataset.eddel}`, { method: "DELETE" });
            }
            catch {
                toast("Couldn't delete set");
                return;
            }
            const row = b.closest(".edset");
            if (row)
                collapseEl(row, () => row.remove());
        })));
        const save = el.querySelector("#edSave");
        if (save)
            save.addEventListener("click", async () => {
                save.disabled = true;
                const tasks = [];
                el.querySelectorAll(".edset").forEach((row) => {
                    if (!row.isConnected)
                        return; // a set deleted mid-edit
                    const id = row.dataset.setid;
                    const body = row.dataset.kind === "timed"
                        ? { duration_sec: parseDur(row.querySelector(".edset-dur")?.value) }
                        : {
                            weight: numOrNull(row.querySelector(".edset-w")?.value),
                            reps: numOrNull(row.querySelector(".edset-r")?.value),
                            rir: numOrNull(row.querySelector(".edset-rir")?.value),
                        };
                    tasks.push(api(`/sets/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
                });
                tasks.push(api(`/sessions/${sess.id}/notes`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ notes: el.querySelector("#edNotes")?.value.trim() || "" }),
                }));
                try {
                    await Promise.all(tasks);
                    toast("Updated");
                }
                catch {
                    toast("Some changes didn't save");
                }
                // corrected sets/notes change the History list, weekly stats, volume, and (if
                // it's that date's session) Today — drop the caches so renderHistory below and
                // any later paint read truth.
                swrInvalidate("history:sessions");
                swrInvalidate("stats");
                swrInvalidate("progress:volume");
                if (sess.date)
                    swrInvalidate("today:session:" + sess.date);
                closeDetail(true);
                renderHistory();
            });
    });
}
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
        render: (exercises) => paintProgressBody(progressRows(exercises)),
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
        paintWeightBody(progressRows(rows), progressRecord(profile));
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
    const pts = rows.map((p) => ({ date: progressString(p.date), v: progressNumber(p.weight_lb) }));
    if (!pts.length) {
        view.innerHTML = head + progressHero("Bodyweight", []) +
            emptyStateHtml(art("activity", "walk"), "No weigh-ins yet — log one from the Today strip.");
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const goalW = profile.goal_weight_lb != null ? progressNumber(profile.goal_weight_lb) : null;
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
    const row = progressRecord(data);
    const canvas = $("#chart"), stats = $("#pstats"), heroWrap = $("#trendHero");
    if (!canvas || !canvas.isConnected)
        return; // navigated away mid-fetch
    const pts = progressRows(row.points).map((p) => ({ date: progressString(p.date), v: progressNumber(p.best1rm) }));
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
        render: (data) => paintVolumeBody(progressRecord(data)),
    });
}
function paintVolumeBody(data) {
    const groups = progressRows(data.by_muscle).slice()
        .sort((a, b) => progressNumber(b.sets) - progressNumber(a.sets));
    const head = segBar("volume", PROGRESS_SEG);
    if (!groups.length) {
        view.innerHTML = head + progressHero("Volume", []) +
            emptyStateHtml(art("exercise", "barbell row"), `Nothing logged in the last ${progressNumber(data.days, 30)} days.`);
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const totalSets = groups.reduce((t, g) => t + progressNumber(g.sets), 0);
    const maxSets = Math.max(1, ...groups.map((g) => progressNumber(g.sets)));
    const hero = progressHero("Volume", [
        ["sets · 30d", totalSets],
        ["lb moved · 30d", data.total_tonnage || 0, { k: true }],
        ["top muscle", groups[0].muscle_group, { text: true }],
    ]);
    const rows = groups.map((g, i) => `
    <div class="volrow reveal" style="${stagger(i + 2)}">
      <div class="volrow-top">
        <span class="volrow-name">${escHtml(g.muscle_group)}</span>
        <span class="volrow-meta"><b>${progressNumber(g.sets)}</b> set${progressNumber(g.sets) === 1 ? "" : "s"} · ${progressNumber(g.tonnage).toLocaleString()} lb</span>
      </div>
      <div class="volbar"><div class="volbar-fill barfill" style="width:${Math.max(3, Math.round((progressNumber(g.sets) / maxSets) * 100))}%"></div></div>
    </div>`).join("");
    view.innerHTML = head + hero +
        `<div id="volBalanceSlot" class="vol-balance-slot reveal" style="${stagger(1)}"></div>` +
        `<div class="vol-kicker lbl reveal" style="${stagger(2)}">Last ${progressNumber(data.days, 30)} days · ranked by sets</div>` + rows;
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
function progressEnduranceDeps() {
    return {
        view,
        headerTitle,
        state,
        api,
        nextToken: () => ++pollToken,
        isCurrent: (token) => token === pollToken,
        segmentHtml: (active) => segBar(active, PROGRESS_SEG),
        wireSegments: () => wireSeg(PROGRESS_HANDLERS),
        loading: loadingState,
        empty: emptyStateHtml,
        hero: progressHero,
        art,
        runCountUps,
        renderSelf: () => renderEndurance(),
    };
}
async function renderEndurance() {
    await CairnProgressEnduranceController.render(progressEnduranceDeps());
}
function paintEnduranceBody(end, prs, goal, compliance, settings, runPlan) {
    CairnProgressEnduranceController.paint(end, prs, goal, compliance, settings, runPlan, progressEnduranceDeps());
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
        render: (data) => paintCalendarBody(progressRecord(data)),
    });
}
function paintCalendarBody(data) {
    const cells = progressRows(data.cells);
    const head = segBar("calendar", PROGRESS_SEG);
    if (!cells.length) {
        view.innerHTML = head + progressHero("Calendar", []) +
            emptyStateHtml(art("activity", "run"), "No activity logged yet.");
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const todayIso = localISO();
    const byDate = new Map(cells.map((c) => [progressString(c.date), c]));
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
    const months = [...new Set(cells.map((c) => progressString(c.date).slice(0, 7)))].filter(Boolean).reverse();
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
// Renders GET /api/program-state as a calm editorial read of how the athlete's
// program is evolving. No 0–100 scores. Constitution: calm, suggestion-not-a-gate,
// pull-never-push. Skeleton-first paint; empty state when lifts is empty.
// "Evolve my plan" button — POSTs to /api/program/evolve. Degrades gracefully
// if the endpoint 404s (not yet wired). ok:false at 200 = designed failure signal.
// Evolve the plan — a durable background job (streams an evolving caption, survives
// a reload), exactly like session-suggest. runOp transparently handles the stream
// (bg on) or the inline result (bg off). The draft lands in the Plan proposals for
// review — nothing auto-applies.
async function triggerProgramEvolve(btn) {
    const foot = btn.closest(".prog-evolve-foot") || btn.parentElement;
    const restore = btnBusy(btn, "Drafting your plan…");
    // A caption line runOp animates while the coach thinks.
    let cap = foot && foot.querySelector(".prog-evolve-cap");
    if (foot && !cap) {
        cap = document.createElement("div");
        cap.className = "prog-evolve-cap job-cap lbl";
        foot.appendChild(cap);
    }
    const cleanup = () => { restore(); cap?.remove(); };
    await runOp("evolve_program", {}, {
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
            toast("Drafted — review it in your Plan");
            swrInvalidate("progress:program");
            swrInvalidate("plan:coach");
            swrInvalidate("plan:proposals");
            if (state.tab === "progress")
                renderProgram();
        },
        onFail: () => { cleanup(); toast("Couldn't draft right now — try again in a bit."); },
    });
}
// SWR over /program-state (key progress:program). Skeleton-first on cold;
// paints the full program read instantly on warm re-entry, then revalidates.
// The conductor lead for Progress→Program — the cross-domain "one block focus" card
// (GET /api/coaching-focus → coachingFocusCardHtml). Cached as a rendered HTML string
// ("" when unavailable) so paintProgramBody can branch its layout: present → lead with
// it and collapse the deep sections behind "The full read"; absent → the existing
// stacked sections, untouched (graceful degradation).
var _progFocusCard;
const PROGRESS_FOCUS_STATE = {
    cardHtml: () => typeof _progFocusCard === "string" ? _progFocusCard : "",
    hasFocusCard: () => !!_progFocusCard,
};
Object.assign(globalThis, { CairnProgressFocus: PROGRESS_FOCUS_STATE });
if (typeof window !== "undefined") {
    window.CairnProgressFocus = PROGRESS_FOCUS_STATE;
}
async function renderProgram() {
    headerTitle.textContent = "Progress";
    state.progressSeg = "program";
    const token = ++pollToken;
    const peek = peekCached("progress:program");
    if (!peek)
        view.innerHTML = segSkeleton("program", PROGRESS_SEG, 3);
    // Fetch the conductor in parallel (own try/catch → never throws). When it lands or
    // its presence changes, re-paint from the cached program-state so the layout can
    // collapse the pile. Never blocks the warm paint below.
    api("/coaching-focus").then((f) => {
        const card = (typeof coachingFocusCardHtml === "function") ? coachingFocusCardHtml(f) : "";
        const prev = _progFocusCard;
        _progFocusCard = card;
        if (card === prev)
            return;
        if (!card && (prev === undefined || prev === ""))
            return; // stayed flat — no re-paint
        if (token === pollToken && state.tab === "progress" && state.progressSeg === "program") {
            const cached = peekCached("progress:program");
            if (cached)
                paintProgramBody(cached.data);
        }
    }).catch(() => { });
    return paintSWR({
        key: "progress:program",
        path: "/program-state",
        peek: peek,
        token,
        tab: "progress",
        render: (data) => paintProgramBody(data),
    });
}
function paintProgramBody(data) {
    const head = segBar("program", PROGRESS_SEG);
    const lifts = data.lifts;
    const volume = data.volume;
    const meso = data.mesocycle || null;
    const endurance = data.endurance || null;
    const headline = data.headline || "";
    const adaptations = data.adaptations_due;
    if (!lifts.length && !volume.length && !meso && !endurance) {
        view.innerHTML = head + progressHero("Program", []) +
            emptyStateHtml(art("exercise", "barbell squat"), "Not enough data yet — log a few sessions and your program intelligence will read here.");
        wireSeg(PROGRESS_HANDLERS);
        return;
    }
    const sorted = sortLifts(lifts);
    // Count stalled/regressing for a quiet hero stat (no score — just a direction indicator).
    const nStalled = sorted.filter((l) => l.status === "plateaued" || l.status === "regressing").length;
    const nGood = sorted.filter((l) => l.status === "progressing").length;
    const heroStats = [];
    if (lifts.length)
        heroStats.push(["lifts tracked", lifts.length]);
    if (nGood)
        heroStats.push(["climbing", nGood]);
    if (nStalled)
        heroStats.push(["stalled", nStalled]);
    const conductor = CairnProgressFocus.cardHtml();
    const hasConductor = !!conductor;
    // The deterministic headline — the single most important program sentence. When the
    // conductor leads it's redundant (the conductor states the through-line), so it tucks
    // into the disclosure with the rest of the deep read.
    const headlineHtml = headline ? `<div class="prog-headline reveal" style="${stagger(1)}">${escHtml(headline)}</div>` : "";
    // The async slots (loaded after paint): a "test week due" banner, the capacity
    // benchmark, the periodization block, the "what changed & why" digest, the muscle
    // advance/stall strip, and DEXA targeting. Each renders nothing until it has data.
    const testSlot = `<div id="progTestSlot" class="ptest-slot reveal" style="${stagger(1)}"></div>`;
    const perfSlot = `<div id="progPerfSlot" class="pperf-slot reveal" style="${stagger(2)}"></div>`;
    const blockSlot = `<div id="progBlockSlot" class="pblock-slot reveal" style="${stagger(2)}"></div>`;
    const adjustSlot = `<div id="progAdjustSlot" class="padj-slot reveal" style="${stagger(3)}"></div>`;
    const muscleSlot = `<div id="progMuscleSlot" class="pmus-slot reveal" style="${stagger(3)}"></div>`;
    const dexaSlot = `<div id="progDexaSlot" class="pdexa-slot reveal" style="${stagger(3)}"></div>`;
    const adaptHtml = adaptations.length ? adaptationsHtml(adaptations, 4) : "";
    // Lift rows — the per-lift trajectory, kept visible beneath the lead.
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
        // Conductor leads. Lift rows stay visible beneath it; the rest of the deep read —
        // the deterministic headline, capacity benchmark, DEXA targeting, muscle strip,
        // weekly volume, mesocycle, and the adaptations digest — collapses behind ONE "The
        // full read" disclosure. The lever is de-triplicated: the conductor is the one lever
        // now (performance's standalone .pperf-lever is suppressed in loadPerformance).
        html = head + progressHero("Program", heroStats) + conductor + liftsHtml +
            `<details class="full-read reveal" style="${stagger(6)}">
        <summary>The full read</summary>
        <div class="full-read-body">${headlineHtml + testSlot + perfSlot + blockSlot + adjustSlot + muscleSlot + dexaSlot +
                adaptHtml + volumeHtml + mesoHtml + endHtml}</div>
      </details>` + evolveFoot;
    }
    else {
        // No conductor — the existing stacked layout, untouched (graceful degradation).
        html = head + progressHero("Program", heroStats) +
            headlineHtml + testSlot + perfSlot + blockSlot + adjustSlot + muscleSlot + dexaSlot +
            adaptHtml + liftsHtml + volumeHtml + mesoHtml + endHtml + evolveFoot;
    }
    view.innerHTML = html;
    wireSeg(PROGRESS_HANDLERS);
    runCountUps(view);
    const btn = view.querySelector("#progEvolveBtn");
    if (btn)
        btn.addEventListener("click", () => triggerProgramEvolve(btn));
    const tidyBtn = view.querySelector("#progTidyBtn");
    if (tidyBtn)
        tidyBtn.addEventListener("click", () => tidyExerciseNames(tidyBtn));
    loadPerformance(); // the "where you stand" capacity benchmark hero
    loadProgramBlock(); // periodization block card (active) or a "start a block" affordance
    loadProgramAdjustments(); // the "what changed & why" digest
    loadTestWeek(); // the "a test week is about due" banner
    loadMuscleTrajectory(); // per-muscle-group advancing/stalling strip
    loadDexaTargeting("progDexaSlot"); // "from your DEXA, what to focus on next"
}
// "Tidy exercise names" — the exercise-canon analogue to Health's "Align lab names".
// Merges duplicate movements (e.g. "Dead hang" / "Dead hang timed") so each lift
// tracks as one line. Calm, low-friction; degrades calmly on failure. Refreshes the
// program read on success so the merged history shows immediately.
async function tidyExerciseNames(btn) {
    const restore = btnBusy(btn, "tidying…");
    let r = null;
    try {
        r = await api("/exercises/reconcile-names", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    }
    catch {
        r = null;
    }
    restore();
    const row = progressRecord(r);
    if (!isProgressRecord(r) || row.ok === false) {
        toast("Couldn't tidy names — try again.");
        return;
    }
    const n = Number(row.aligned ?? row.applied) || 0;
    toast(n ? `Tidied ${n} exercise name${n === 1 ? "" : "s"}` : "Names already tidy");
    if (n) {
        swrInvalidate("progress:program");
        renderProgram();
    }
}
Object.assign(globalThis, {
    renderCalendar,
    renderEnergy,
    renderEndurance,
    renderHistory,
    renderProgram,
    renderProgress,
    renderVolume,
    renderWeight,
});
})();

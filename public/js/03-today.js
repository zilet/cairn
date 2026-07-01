(() => {
function todayApi(path, opts) {
    return api(path, opts);
}
function todayCachedApi(path, opts) {
    return cachedApi(path, opts);
}
function todayPeekCached(key, freshFor) {
    return peekCached(key, freshFor);
}
const todayState = state;
const todayView = view;
const todaySideLoaders = globalThis.CairnTodaySideLoaders;
const todayPlanSessionPreparation = globalThis.CairnTodayPlanSessionPreparation;
const todayDataLoader = globalThis.CairnTodayDataLoader;
const todayMainShell = globalThis.CairnTodayMainShell;
const todayPlanSurface = globalThis.CairnTodayPlanSurface;
const todayPlanSurfaceRenderer = globalThis.CairnTodayPlanSurfaceRenderer;
function todaySideLoaderDeps() {
    return {
        root: todayView,
        state: todayState,
        api: todayApi,
        activateTab,
        runCountUps,
        escapeHtml: escHtml,
        localISO,
        stagger,
    };
}
function todayPlanSurfaceDeps() {
    return {
        escapeHtml: escHtml,
        escapeAttr: escAttr,
        stagger,
        cardioLabel,
        cardioPrescription,
        rxMoveCount: todayRxMoveCount,
        setsTonnage,
        trainGlyph: CairnTodayBrief.BRIEF_KIND.train.glyph,
    };
}
function todayPlanSurfaceRendererDeps() {
    return {
        planSurface: todayPlanSurface,
        planSurfaceDeps: todayPlanSurfaceDeps,
        isCardioItem,
        cardioLabel,
        cardioPlanCard,
        exCard,
        garminSessionCard,
        sessionDoneCard,
        skipLineHtml: (labels) => CairnTodaySessionStatus.skipLineHtml(labels),
    };
}
function todayMainShellDeps() {
    return {
        escapeHtml: escHtml,
        micGlyph: MIC_GLYPH,
    };
}
// The per-card prescription line. `rx` is one Prescription from the progression
// engine (or null → renders nothing). Calm, no score, one move + its why. When the
// move is "switch it up" (action:'vary'), the engine hands a small menu of same-
// pattern swaps that the card renderer frames as a quiet choice.
function todayExRxLineHtml(rx) {
    return CairnTodayTraining.exRxLineHtml(rx);
}
// How many of a day's prescriptions are an actual MOVE (not a plain hold) — drives
// the "apply these" affordance copy + whether it shows at all.
function todayRxMoveCount(rxByEx) {
    return CairnTodayTraining.rxMoveCount(rxByEx);
}
// "Apply these to my plan" — sends the whole day's adapted targets through the
// propose→apply path (POST /api/program/progression/apply {day}), which lands a
// DRAFT plan proposal for review. Nothing auto-applies; we deep-link into Plan →
// Coach where the draft is reviewed/applied, mirroring loadDraftProposals. Calm,
// honest degradation: an unreachable / not-yet-wired endpoint restores the button.
async function applyDayProgression(btn, day) {
    if (day == null)
        return;
    const restore = btnBusy(btn, "Drafting…");
    let r = null;
    try {
        r = await todayApi("/program/progression/apply", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ day }),
        });
    }
    catch {
        restore();
        toast("Couldn't draft that — check your connection.");
        return;
    }
    if (!r || r.ok === false) {
        restore();
        toast("Couldn't draft that just now — try again in a bit.");
        return;
    }
    // A fresh draft is waiting in Plan → Coach — drop the caches that surface it.
    swrInvalidate("plan:coach");
    swrInvalidate("plan:proposals");
    toast("Drafted — review it in your Plan");
    todayState.planJump = "coach";
    activateTab("plan");
}
function exCard(it, logged, prefill, revealIdx, rx) {
    return CairnTodayCards.exerciseCardHtml(it, logged, prefill, revealIdx, rx, {
        day: todayState.day,
        exModes: todayState.exModes,
    });
}
// Today: a planned cardio effort. A prescription (distance/duration/zone/interval)
// + a calm "log this" affordance that prefills the free-text capture (it routes
// through the same activity log as everything else — no separate set-logger). Reuses
// the .ex card vocabulary so it sits naturally among the strength cards.
//
// `done` (optional) = a matched synced cardio effort (a CardioEffort from
// /api/cardio). When present the card flips to a calm "✓ Easy run — 8.2 km · mostly
// Z2 · synced from Garmin" read with NO "log this" button — the run already
// happened, the watch carried it. When absent we keep the prescription, but "Log
// this run →" is the FALLBACK with a quiet "or it'll sync from your watch" hint,
// since a synced run is the runner's preferred path. (Sync freshness rides on a
// separate line only when Garmin is configured.)
function cardioPlanCard(it, revealIdx, done, syncline) {
    return CairnTodayCards.cardioPlanCardHtml(it, revealIdx, done, syncline);
}
// Does a synced cardio effort satisfy a planned cardio item? The bar is deliberately
// low (per spec): a compatible-type effort logged today is enough to call the
// prescription done — a runner's plan day is "did a run happen?", not an exact-match
// audit. Compatibility falls back to "any endurance effort" when neither side names a
// recognizable verb (so a generic activity still flips a generic cardio prescription).
function cardioEffortMatches(it, eff) {
    return CairnTodayCards.cardioEffortMatches(it, eff);
}
// ---------- sync trust: a quiet freshness line where a runner needs the mileage ----------
// The Garmin freshness renderer lives in /js/cardio-sync-client.js and preserves
// the cardioSyncLine compatibility global used by Today, Progress, and Plan.
// Cardio sync execution wiring also lives in /js/cardio-sync-client.js. It preserves
// the wireCardioSync compatibility global used by Today, Progress, and Plan.
// Session status render helpers live in /js/today-session-status-client.js. They
// own tonnage, set chips, completion, skip-line, and feedback markup while this
// screen keeps DOM wiring and persistence.
// Set an exercise's mode by name (upsert-by-name). Returns the todayApi() promise.
function postExerciseMode(name, mode) {
    return todayApi("/exercises", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mode }) });
}
async function suggestedPlanDayNumber(session, isToday) {
    return CairnTodayPlanSelection.suggestedPlanDayNumber(session, isToday, {
        state: todayState,
        api: todayApi,
    });
}
// ---------- The Brief (day-read) ----------
// Pure Brief markup lives in /js/today-brief-client.js. Stateful fetch/cache,
// steer-job, reconnect, and focus-mode wiring live in /js/today-brief-controller.js.
function todayBriefDeps() {
    return {
        root: todayView,
        state: todayState,
        api: todayApi,
        invalidate: swrInvalidate,
        renderToday,
        withViewTransition,
        runOp,
        runCountUps,
        reducedMotion,
        collapseEl,
        activateTab,
        toast,
        localISO,
        escapeHtml: escHtml,
        loadTrainingProvenance: (isToday) => loadTrainingProvenance(isToday),
        revealPlanThen,
        revealSessionComposer,
        askForSession,
    };
}
async function loadBrief(date, override, opts = {}) {
    return CairnTodayBriefController.loadBrief(date, override, todayBriefDeps(), opts);
}
async function upgradeBriefInPlace(date, isToday) {
    await CairnTodayBriefController.upgradeBriefInPlace(date, isToday, todayBriefDeps());
}
async function reshapeToday() {
    await CairnTodayBriefController.reshapeToday(todayBriefDeps());
}
function briefHtml(read, { showPlan, hasPlanDay, isToday }) {
    return CairnTodayBriefController.briefHtml(read, { showPlan, hasPlanDay, isToday }, todayBriefDeps());
}
function focusEngaged(date, { showPlan, hasLoggedSets, isToday }) {
    return CairnTodayBriefController.focusEngaged(date, { showPlan, hasLoggedSets, isToday }, todayBriefDeps());
}
function setFocus(date, on) {
    CairnTodayBriefController.setFocus(date, on, todayBriefDeps());
}
function focusBarHtml(read, day, { exDone, exTotal, isToday }) {
    return CairnTodayBriefController.focusBarHtml(read, day, { exDone, exTotal, isToday });
}
function briefSignalsText(read) {
    return CairnTodayBriefController.briefSignalsText(read);
}
function todaySessionSuggestDeps() {
    return {
        root: todayView,
        state: todayState,
        runOp,
        thinkingCaption,
        runCountUps,
        collapseEl,
        reducedMotion,
        toast,
        revealPlanThen,
        appendOffPlanCard,
    };
}
function reconnectSessionSuggest(job) {
    return CairnTodaySessionSuggestController.reconnectSessionSuggest(job, todaySessionSuggestDeps());
}
function revealSessionComposer() {
    CairnTodaySessionSuggestController.revealSessionComposer(todaySessionSuggestDeps());
}
async function askForSession(opts = {}) {
    await CairnTodaySessionSuggestController.askForSession(opts, todaySessionSuggestDeps());
}
// Reveal the plan/logging surface for the selected date, then run `after` once the
// surface exists in the DOM. If it's already shown, run immediately.
function revealPlanThen(after, opts = {}) {
    if (todayView.querySelector(".addex")) {
        after && after();
        return;
    }
    // `blank`: reveal a clean logging surface with NO plan day pre-loaded (used by a
    // logged session suggestion). On a day with nothing planned, this stops Today from
    // borrowing — and mislabeling the session as — the next rotation day's workout.
    todayState.planReveal = { date: todayState.logDate, on: true, blank: !!opts.blank };
    Promise.resolve(renderToday()).then(() => { after && after(); });
}
// ---------- The Today salience arbiter (Era 2, §12 item 1) ----------
// Today's rail cards each decide independently whether to render, so a busy day
// can stack into a dashboard — exactly the calm-by-default pressure Era 2 relieves.
// GET /api/today-agenda runs ONE deterministic ranking + budget pass server-side
// (src/repo/today-agenda.ts), returning { hero, primary[], more[], total }. The
// arbiter changes PLACEMENT, never the cards: the top 1–2 surfaces render inline,
// the rest collapse behind one quiet "more". The rich existing cards are reused
// verbatim — we just order their stable slots by the agenda and tuck the lower-
// ranked ones into a disclosure. Pull, never push; it can only ever REDUCE.
//
// Which existing rail client_card maps to which loader fn (the loader binds to the
// slot id; we only move where the slot lives). Generic Era-2 candidates (no
// client_card — since-last / goal-checkin) render a calm card from their own text.
function todayRailDeps() {
    return {
        root: todayView,
        state: todayState,
        api: todayApi,
        activateTab,
        gotoChatWith,
        collapseEl,
        loadTodayReads,
        runCountUps,
        escapeHtml: escHtml,
        toast,
        invalidate: swrInvalidate,
        refreshToday: renderToday,
    };
}
async function renderToday(opts = {}) {
    const todayData = await todayDataLoader.load(opts, {
        root: todayView,
        state: todayState,
        api: todayApi,
        cachedApi: todayCachedApi,
        peekCached: todayPeekCached,
        localISO,
        todaySkeleton,
        setTodayHeaderTitle,
        nextPollToken: () => ++pollToken,
    });
    const { soft, isToday } = todayData;
    const session = todayData.session;
    const { day, loggedByEx, cardioEfforts, todaySettings, matchedCardio, activeItems, skippedItems, cardioItems, strengthItems, planEx, offPlanEx, pendingOffPlan, lastSets, rxByEx, rxFor, prefillFor, exDone, exTotal, hasSyncedCardioToday, isRunDay, expectingRun, } = await todayPlanSessionPreparation.preparePlanSession({
        state: todayState,
        session,
        isToday,
        api: todayApi,
        cachedApi: todayCachedApi,
        peekCached: todayPeekCached,
        suggestedPlanDayNumber,
        isCardioItem,
        cardioLabel,
        cardioEffortMatches,
    });
    const [stats, profile, exercises] = [todayData.stats, todayData.profile, todayData.exercises];
    if (profile) {
        setDiscipline(profile.primary_discipline);
        setEnduranceGoalSet(!!profile.endurance_goal_json);
    } // keep the emphasis globals warm for Progress/Today/Plan
    // exercise → mode map ('reps'|'timed'), used by exCard + the add-exercise flow
    todayState.exModes = Object.fromEntries((exercises || []).map((e) => [e.name, e.mode || "reps"]));
    const curW = stats.weight_lb ?? (profile && profile.weight_lb != null ? profile.weight_lb : null);
    // Compass strip: adherence to this week's plan + weight-trend pace vs the goal.
    // The pure helper owns the mode wording and week recap markup; Today keeps
    // placement and the click into Chat.
    const todayCompass = CairnTodayCompass.build(stats, {
        escapeHtml: escHtml,
        escapeAttr: escAttr,
        formatKm: fmtKm,
    }, {
        currentWeight: curW,
        isToday,
        isEndurance: isEndurance(),
        isHybrid: isHybrid(),
    });
    // ---- The Brief: the day-read leads. A suggestion, never a gate. ----
    // The plan/logging surface is revealed when the read says "train", when the
    // user has already logged on this date (they've committed), when they tapped
    // "train anyway"/"log these" (todayState.planReveal), or when reviewing a past date.
    const hasLoggedSets = !!(session && (session.sets || []).length);
    const hasPlanDay = (day.items || []).length > 0;
    const revealOn = todayState.planReveal && todayState.planReveal.date === todayState.logDate && todayState.planReveal.on;
    const isFinished = !!(session && session.finished_at);
    // Non-blocking Brief: fetch the read in FAST mode — the endpoint returns a warm
    // cached read instantly, so the common case is immediate; a cold cache resolves
    // to a provisional read (painted with the .is-thinking filament) and the real
    // agentic read swaps in via upgradeBriefInPlace() once it lands. First paint
    // never waits on agent:"auto". (Honors an active override.)
    const briefOverride = todayState.brief && todayState.brief.date === todayState.logDate ? todayState.brief.override : "";
    const read = await loadBrief(todayState.logDate, briefOverride, { fast: true });
    const hasGarmin = !!(session && session.garmin);
    const showPlan = !isToday || hasLoggedSets || hasGarmin || revealOn || read.kind === "train";
    // A finished session reads as a calm "done" card (the work now lives in History),
    // not the live logging surface — "Log more" reopens it. Only on today: a past date
    // keeps its full logged surface for review, and history editing has its own tab.
    const showDone = isFinished && isToday && !revealOn;
    // Focus mode strips Today to the logging surface (see focusEngaged). Never engages
    // on a finished session (the done card replaces the surface). Progress for the slim
    // header: how many of today's exercises have at least one logged set.
    const focus = !showDone && focusEngaged(todayState.logDate, { showPlan, hasLoggedSets, isToday });
    // ---- Day-type-aware lead: read the day as run / lift / both / rest ----
    // When the day is about running — cardio prescribed and/or a synced run, with NO
    // strength logged today — the run is the HERO of the plan area, not buried under a
    // strength shell. We don't rewrite Today; we just (a) lead the session head with the
    // run's name + prescription, and (b) order the cardio card(s) FIRST in the surface.
    // A mixed day (both lift + cardio) keeps the lift-led head but still floats cardio
    // up so it's never lost at the bottom. Pure lifting is unchanged.
    // Sync freshness: only when Garmin is configured. The stale "this morning's run not
    // synced yet?" nudge fires when a run is prescribed today but no synced effort has
    // landed AND the last sync is stale (see cardioSyncLine). One shared line under the
    // run card (and on the Endurance view).
    const syncline = cardioItems.length ? cardioSyncLine(todaySettings, { expectingRun }) : "";
    // In focus mode the chrome (context banner, Brief, insight, capture) gives way to
    // the slim sticky focus header; otherwise the Brief leads as always.
    // Desktop two-column model (≥1100px): the Brief + capture + logging surface are
    // the PRIMARY column (.today-main); the week-ahead / weekly-read / connection-
    // insight / garmin-reconcile / "lately" are the secondary RIGHT RAIL (.today-rail).
    // The rail slots keep their stable ids — the rail controller binds each loader to
    // the same slot ids as before. On
    // mobile/tablet the two wrappers stack (single column): the rail flows right after
    // the capture row, where the week-ahead/reads naturally sat before.
    //
    // Era 2 — the SALIENCE ARBITER governs the rail. GET /api/today-agenda runs one
    // deterministic ranking + budget pass and tells us which 1–2 surfaces matter most
    // today (primary, inline) vs which collapse behind one quiet "more". We build the
    // rail from that, reusing the rich existing cards verbatim (their slots, ordered).
    // Best-effort: a null agenda (route not wired / offline) falls back to the CURRENT
    // fixed rail so Today is never broken while the arbiter is half-integrated. The
    // agenda is per-render (it reflects today's data), not SWR-cached.
    // NOTE: the fallback rail deliberately has NO #fuelSlot — fuel surfaces ONLY
    // through the agenda (which omits it when nothing's logged), so there is no path,
    // even on a 404/offline fallback, that can render the old "Nothing logged yet"
    // capture nudge. The other rail cards keep a fallback for graceful degradation.
    let agenda = null;
    const agendaGeneric = []; // generic Era-2 cards we drew (wired after the write)
    // The CONDUCTOR — one sequenced whole-athlete focus (GET /api/coaching-focus), the
    // cross-domain analog of the health focus. It leads Today just under the Brief and
    // SUBSUMES the parallel banner cluster: when it's available it carries the one
    // highest-leverage lever, so the standalone health-lever line (#ctxHealth) and the
    // ◎ goal line / ✦ draft banner stand down (one voice, not five). Fetched in parallel
    // with the agenda so it adds no serial latency; null/unavailable (thin athlete /
    // offline / route absent) degrades cleanly — the old lines return exactly as before.
    let conductor = null;
    if (!focus) {
        [agenda, conductor] = await Promise.all([
            CairnTodayRailController.fetchTodayAgenda(todayState.logDate, todayRailDeps()),
            todayApi("/coaching-focus").catch(() => null),
        ]);
    }
    // On Today the conductor shows as ONE thread line — the full lead/alongside/
    // later/check-in card is a weeks-cadence review that lives on Me → Standing.
    // The thread still subsumes the redundant compass + health-lever banner lines,
    // but a pending plan PROPOSAL (the brain's prepared change) always shows below.
    const conductorHtml = conductor ? coachingFocusThreadHtml(conductor) : "";
    const conductorLeads = !!conductorHtml; // the thread has something to lead with
    const railHtml = focus
        ? ""
        : (agenda ? CairnTodayRailController.railHtml(agenda, agendaGeneric) : CairnTodayRailController.fallbackRailHtml(isToday));
    let html = todayMainShell.leadHtml({
        focus,
        focusHtml: focusBarHtml(read, day, { exDone, exTotal, isToday }),
        isToday,
        briefHtml: briefHtml(read, { showPlan, hasPlanDay, isToday }),
        conductorHtml,
        conductorLeads,
        goalLineHtml: CairnTodayContext.goalLineHtml(stats, curW, isToday),
        currentWeight: curW,
    }, todayMainShellDeps());
    html += todayPlanSurfaceRenderer.buildHtml({
        showDone,
        showPlan,
        focus,
        session,
        day,
        isToday,
        plan: todayState.plan,
        activeDay: todayState.day,
        logDate: todayState.logDate,
        cardioItems,
        strengthItems,
        activeItems,
        skippedItems,
        matchedCardio,
        syncedLine: syncline,
        loggedByEx,
        offPlanEx,
        pendingOffPlan,
        lastSets,
        rxByEx,
        exDone,
        exTotal,
        hasSyncedCardioToday,
        hasLoggedSets,
        hasGarmin,
        isRunDay,
        prefillFor,
        rxFor,
    }, todayPlanSurfaceRendererDeps());
    // ---- Trajectory tier (this week), quiet, below the fold — hidden in focus ----
    if (!focus) {
        html += todayMainShell.weekFoldHtml(todayCompass, todayMainShellDeps());
    }
    // Scope the focus class to this render via a wrapper, so a tab switch (which
    // replaces #view wholesale) can never leave the class stranded. The primary
    // column (.today-main) holds the Brief, capture, and logging surface; the rail
    // (.today-rail) sits beside it on wide screens (section 36) and stacks under it
    // on mobile/tablet. Focus mode is a single centered column — no rail.
    todayView.innerHTML = todayMainShell.wrapHtml(html, { focus, railHtml });
    // Calm, dismissible "add to home screen" coach — appended to the primary column AFTER
    // the wholesale innerHTML write above (mounting before it would be silently wiped).
    // Pull, not push: it waits below the Brief, hidden in standalone mode and after dismissal.
    if (!focus) {
        try {
            const main = todayView.querySelector(".today-main");
            if (main && typeof renderPhoneCoachBanner === "function")
                renderPhoneCoachBanner(main);
        }
        catch { }
    }
    CairnTodayPostRenderWiring.wirePostRender({
        root: todayView,
        state: todayState,
        read,
        isToday,
        focus,
        showPlan,
        soft,
        conductorLeads,
        agenda,
        agendaGeneric,
        todayCompass,
        updateHeaderCondense,
        runCountUps,
        quickLog,
        reducedMotion,
        wireCardioSync,
        renderToday,
        applyDayProgression,
        wireBrief,
        upgradeBriefInPlace,
        loadTrainingProvenance,
        loadTableHint,
        setupWeightChip,
        setupVoiceCapture,
        loadFrequentFoods,
        loadContextBanner,
        loadHealthFocusBanner,
        loadWearable,
        loadCheckin,
        loadDraftProposals,
        runAgendaRail: CairnTodayRailController.runAgendaRail,
        runFallbackRail: CairnTodayRailController.runFallbackRail,
        todayRailDeps,
        activateTab,
        setFocus,
        withViewTransition,
        viewEnter,
        localISO,
    });
    wireGuides(view);
    CairnTodaySessionController.wireSessionSurface({ session, hasLoggedSets }, todaySessionDeps());
    setupAddExercise();
    todayDataLoader.scheduleSoftRepaint(todayData, {
        root: todayView,
        state: todayState,
        isCurrentPoll: (token) => token === pollToken,
        renderToday,
    });
}
// A finished workout's calm wrap-up: a quiet checkmark, the day, the numbers that
// matter, the "how did that feel?" slot, and two soft ways forward (log more /
// see it in history). No score, no verdict — just "that's done, well played".
function sessionDoneCard(session, day, { isToday }) {
    return CairnTodaySessionStatus.sessionDoneCardHtml(session, day, { isToday });
}
function todaySessionDeps() {
    return {
        root: todayView,
        state: todayState,
        api: todayApi,
        invalidate: swrInvalidate,
        invalidateTodayProgression,
        scheduleRxRefresh,
        renderToday,
        activateTab,
        withViewTransition,
        viewEnter,
        reducedMotion,
        startRest,
        stopRest,
        toast,
        parseDur,
        fmtDur,
        collapseEl,
        expandEl,
        localISO,
        sessionStatus: CairnTodaySessionStatus,
    };
}
function wireLogRow(row) {
    CairnTodaySessionController.wireLogRow(row, todaySessionDeps());
}
function wireSkips() {
    CairnTodaySessionController.wireSkips(todaySessionDeps());
}
function wireBrief(read, { isToday }) {
    CairnTodayBriefController.wireBrief(read, { isToday }, todayBriefDeps());
}
function reconnectDayReadOverride(job) {
    return CairnTodayBriefController.reconnectDayReadOverride(job, todayBriefDeps());
}
// ---- Keep the adapted prescription in step with the sets being logged ----
// The per-lift "next up / hold / ease off" line (exRxLineHtml) is the visible proof
// the plan FOLLOWS what you logged — so it must not stay frozen at render-time after
// the first set. A full renderToday() only fires on the FIRST set of a previously-
// empty day; for every later set we instead REFRESH the prescription cheaply, in
// place. Debounced (rapid taps coalesce into one fetch) + best-effort: a failed fetch
// leaves the last paint, exactly like the initial progression load.
function todayProgressionDeps() {
    return {
        state: todayState,
        root: todayView,
        cachedApi: todayCachedApi,
        invalidate: swrInvalidate,
        exRxLineHtml: todayExRxLineHtml,
        moveCount: todayRxMoveCount,
        loadProgramAdjustmentsBanner: () => CairnTodayRailController.loadProgramAdjustmentsBanner(todayRailDeps()),
    };
}
function scheduleRxRefresh() {
    CairnTodayProgressionController.scheduleRxRefresh(todayProgressionDeps());
}
function invalidateTodayProgression() {
    CairnTodayProgressionController.invalidateTodayProgression(todayProgressionDeps());
}
async function refreshAdaptedRx() {
    await CairnTodayProgressionController.refreshAdaptedRx(todayProgressionDeps());
}
function todayAddExerciseDeps() {
    return {
        root: todayView,
        state: todayState,
        api: todayApi,
        postExerciseMode,
        exCard,
        wireGuides,
        wireLogRow,
        wireSkips,
        toast,
        escapeHtml: escHtml,
        escapeAttr: escAttr,
    };
}
async function setupAddExercise() {
    await CairnTodayAddExerciseController.setupAddExercise(todayAddExerciseDeps());
}
async function appendOffPlanCard(name, mode) {
    await CairnTodayAddExerciseController.appendOffPlanCard(name, mode, todayAddExerciseDeps());
}
function garminSessionCard(g) {
    return todaySideLoaders.garminSessionCard(g);
}
async function loadWearable(isToday) {
    await todaySideLoaders.loadWearable(isToday, todaySideLoaderDeps());
}
async function loadTableHint() {
    await todaySideLoaders.loadTableHint(todaySideLoaderDeps());
}
// Today context/goal/health rail markup lives in /js/today-context-client.js.
// This screen keeps API loading, slot liveness checks, and navigation wiring.
async function loadContextBanner() {
    await todaySideLoaders.loadContextBanner(todaySideLoaderDeps());
}
async function loadDraftProposals() {
    await todaySideLoaders.loadDraftProposals(todaySideLoaderDeps());
}
async function loadHealthFocusBanner() {
    await todaySideLoaders.loadHealthFocusBanner(todaySideLoaderDeps());
}
Object.assign(globalThis, {
    postExerciseMode,
    reconnectDayReadOverride,
    reconnectSessionSuggest,
    renderToday,
    reshapeToday,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        postExerciseMode,
        reconnectDayReadOverride,
        reconnectSessionSuggest,
        renderToday,
        reshapeToday,
    });
}
})();

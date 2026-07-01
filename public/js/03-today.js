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
function setChip(s, i) {
    return CairnTodaySessionStatus.setChipHtml(s, i);
}
// Session status render helpers live in /js/today-session-status-client.js. They
// own tonnage, set chips, completion, skip-line, and feedback markup while this
// screen keeps DOM wiring and persistence.
// Set an exercise's mode by name (upsert-by-name). Returns the todayApi() promise.
function postExerciseMode(name, mode) {
    return todayApi("/exercises", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mode }) });
}
function planDayNumberForSession(session, plan) {
    if (!session || !(session.sets || []).length)
        return null;
    const byId = plan.find((d) => Number(d.id) === Number(session.plan_day_id));
    if (byId)
        return byId.day_number;
    const loggedNames = new Set((session.sets || []).map((s) => s.exercise).filter(Boolean));
    let best = null;
    for (const d of plan) {
        const plannedNames = new Set((d.items || []).map((it) => it.exercise));
        let hits = 0;
        loggedNames.forEach((name) => { if (plannedNames.has(name))
            hits++; });
        if (hits && (!best || hits > best.hits))
            best = { day_number: d.day_number, hits };
    }
    return best?.day_number ?? null;
}
function nextPlanDayNumber(dayNumber, plan) {
    const ordered = [...plan].sort((a, b) => a.day_number - b.day_number);
    if (!ordered.length)
        return null;
    const idx = ordered.findIndex((d) => d.day_number === dayNumber);
    return ordered[idx >= 0 ? (idx + 1) % ordered.length : 0].day_number;
}
async function suggestedPlanDayNumber(session, isToday) {
    const currentLoggedDay = planDayNumberForSession(session, todayState.plan);
    if (currentLoggedDay)
        return currentLoggedDay;
    if (!isToday)
        return todayState.plan[0]?.day_number ?? 1;
    try {
        const recent = await todayApi("/sessions?limit=20");
        const latest = (recent || []).find((s) => s.date !== todayState.logDate && planDayNumberForSession(s, todayState.plan));
        const latestDay = planDayNumberForSession(latest, todayState.plan);
        return latestDay ? (nextPlanDayNumber(latestDay, todayState.plan) ?? todayState.plan[0]?.day_number ?? 1) : (todayState.plan[0]?.day_number ?? 1);
    }
    catch {
        return todayState.plan[0]?.day_number ?? 1;
    }
}
// ---------- The Brief (day-read) ----------
// Phase 1: Today opens with a calm day-read — rest / easy / train — fetched from
// GET /api/today-read. It's a SUGGESTION, never a gate: every read carries one-tap
// redirects (train anyway · ask for a session · pull in your plan) so the rest of
// the surface is always one move away. The read is cached per-date on todayState.brief
// (keyed by date+override) so re-renders that don't change the day don't re-fetch.
// Brief/focus-bar render helpers live in /js/today-brief-client.js. This screen
// keeps the stateful fetch/cache/job wiring and passes render context into the
// typed pure helpers.
// Fetch (or reuse) the day-read for the selected date. Always resolves to a read
// object — the endpoint is always 200 (agentic or deterministic fallback). On a
// hard network failure we synthesize a minimal "train" read so the launchpad still
// works; the Brief never blocks the rest of Today.
// A bare provisional read used only to paint Today's structure instantly when the
// agentic read isn't warm yet. Marked _provisional so the background upgrade knows
// to replace it; it's never cached as the final read.
function provisionalRead(_date) {
    return CairnTodayBrief.provisionalRead();
}
async function loadBrief(date, override, opts = {}) {
    const cached = todayState.brief;
    // Reuse a non-provisional cached read for the same date/override.
    if (cached && cached.date === date && cached.override === (override || "") && !cached.read._provisional)
        return cached.read;
    const fetchRead = (async () => {
        let read = null;
        try {
            const qs = new URLSearchParams({ date, agent: "auto" });
            if (override)
                qs.set("override", override);
            read = await todayApi("/today-read?" + qs.toString());
        }
        catch {
            read = null;
        }
        if (!read || !read.kind)
            read = provisionalRead(date);
        return read;
    })();
    // Fast mode (first paint): never block more than ~the timeout. The endpoint
    // returns a cached read instantly, so the common case resolves immediately;
    // only a cold cache (first-ever agentic compute) hits the timeout, where we
    // paint a provisional read and let the background upgrade swap the real one in.
    if (opts.fast) {
        const TIMEOUT = 1200;
        const raced = await Promise.race([
            fetchRead.then((r) => ({ r })),
            new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT)),
        ]);
        if (raced && raced.r && !raced.r._provisional) {
            // Adopt the server-persisted steer (read.override) on a fresh open/reload —
            // the warm-cache reload hits this fast path, so the steer must survive here.
            todayState.brief = { date, override: override || raced.r.override || "", read: raced.r };
            return raced.r;
        }
        // timed out (or only got a provisional) — keep the real fetch alive so the
        // upgrade can await the SAME promise instead of firing a second request.
        todayState._briefInflight = { date, override: override || "", promise: fetchRead };
        const prov = (raced && raced.r) || provisionalRead(date);
        todayState.brief = { date, override: override || "", read: prov };
        return prov;
    }
    todayState._briefInflight = null; // a non-fast (deliberate) load supersedes any pending upgrade
    const read = await fetchRead;
    // The server PERSISTS the athlete's steer on the read (read.override). When we
    // didn't request one explicitly (a fresh open / reload), adopt the persisted steer
    // so the chips filter correctly and the active-steer styling shows — this is what
    // makes "Easy day instead" survive a reload instead of snapping back to canonical.
    todayState.brief = { date, override: override || read.override || "", read };
    return read;
}
// Upgrade a provisionally-painted Brief to the real (agentic) read in place,
// without re-rendering the rest of Today. Runs the .is-thinking filament while
// it waits, then swaps the .brief element. No-op if the read was already real,
// the tab changed, or the date/override moved on. Pull-never-push: it just
// quietly settles into the better read; nothing nags.
async function upgradeBriefInPlace(date, isToday) {
    const inflight = todayState._briefInflight;
    if (!inflight || inflight.date !== date)
        return; // nothing provisional to upgrade
    const briefEl = todayView.querySelector(".brief");
    if (briefEl && !reducedMotion())
        briefEl.classList.add("is-thinking");
    let read = null;
    try {
        read = await inflight.promise;
    }
    catch {
        read = null;
    }
    // Stale-guard: bail if we navigated away or the date moved while waiting.
    if (todayState.tab !== "today" || todayState.logDate !== date)
        return;
    if (todayState._briefInflight === inflight)
        todayState._briefInflight = null;
    if (!read || read._provisional) {
        briefEl?.classList.remove("is-thinking");
        return;
    }
    // Adopt the server-persisted steer when the real read settles (cold-cache path).
    todayState.brief = { date, override: inflight.override || read.override || "", read };
    const live = todayView.querySelector(".brief");
    if (!live)
        return;
    // Re-derive showPlan in case the real read flipped train↔rest/easy; only the
    // Brief element is swapped, so the logging surface below is untouched.
    const day = todayState.plan.find((d) => d.day_number === todayState.day) || todayState.plan[0] || { items: [] };
    const hasPlanDay = (day.items || []).length > 0;
    const showPlan = !!todayView.querySelector(".plansurface");
    const tmp = document.createElement("div");
    tmp.innerHTML = briefHtml(read, { showPlan, hasPlanDay, isToday });
    const fresh = tmp.firstElementChild;
    if (!fresh) {
        live.classList.remove("is-thinking");
        return;
    }
    fresh.classList.add(reducedMotion() ? "" : "brief-settle");
    live.replaceWith(fresh);
    wireBrief(read, { isToday });
    runCountUps(fresh);
    if (showPlan)
        loadTrainingProvenance(isToday); // re-attach the causal line after the swap
}
// A relevant log just reshaped today (an activity, a check-in) — drop the cached
// Brief so it re-fetches the server-recomputed read, and if Today is the live
// surface, re-render it with the hero morph so the change shows immediately. A
// logged set doesn't need this: the first set already re-renders Today, and
// nulling todayState.brief there lets that render pick up the fresh read.
async function reshapeToday() {
    todayState.brief = null;
    // A relevant log (activity / food / weight / check-in) can shift the day's
    // session, weekly stats, and energy read — drop their SWR caches so the
    // re-render below reads truth instead of a stale warm peek.
    swrInvalidate("today:session:" + todayState.logDate);
    swrInvalidate("stats");
    swrInvalidate("progress:energy");
    if (todayState.tab !== "today")
        return;
    // Re-fetch the read BEFORE the transition so renderToday's loadBrief hits the
    // warm cache and the DOM update is instant — running the (slow, agentic) fetch
    // inside withViewTransition trips its ~4s timeout and aborts the morph. This
    // mirrors the override-chip path. The fetch can take a few seconds; the "Logged"
    // toast already gave feedback, and the old read stays put until the flip lands.
    await loadBrief(todayState.logDate, "");
    if (todayState.tab !== "today")
        return; // navigated away during the await
    const morph = !reducedMotion();
    if (morph) {
        todayView.querySelector(".brief")?.classList.add("brief-morph");
        todayState._briefMorph = true;
    }
    try {
        await withViewTransition(() => renderToday());
    }
    finally {
        todayState._briefMorph = false;
        todayView.querySelector(".brief")?.classList.remove("brief-morph");
    }
}
// Honest degradation: one calm line when coaching is offline. The typed helper
// renders the notice; this screen owns the session-only dismissal state and collapse.
let _agentOfflineDismissed = false;
function wireAgentOffline(scope) {
    (scope || view).querySelectorAll("[data-agentoffx]").forEach((b) => b.addEventListener("click", () => {
        _agentOfflineDismissed = true;
        const el = b.closest(".agent-offline");
        if (el)
            collapseEl(el, () => el.remove());
        else
            b.remove();
    }));
}
function briefHtml(read, { showPlan, isToday }) {
    const activeOverride = todayState.brief && todayState.brief.date === todayState.logDate ? todayState.brief.override : "";
    return CairnTodayBrief.briefHtml(read, {
        showPlan,
        isToday,
        activeOverride,
        morph: !!todayState._briefMorph,
        reducedMotion: reducedMotion(),
        offlineDismissed: _agentOfflineDismissed,
    });
}
// ---- Focus mode: a distraction-free logging view for a training day ----
// Per the constitution it's a calm OPTION, never forced: it auto-engages once you've
// logged a set today (you've committed to the work), you can toggle it on/off any
// time, and an explicit choice for the date always wins over the auto rule. When on,
// Today sheds the Brief/insight/capture/week chrome and keeps just a slim sticky
// header (day · progress · one-line read · exit) above the logging cards.
function focusEngaged(date, { showPlan, hasLoggedSets, isToday }) {
    if (!showPlan)
        return false;
    const f = todayState.focus;
    if (f && f.date === date)
        return f.on; // the athlete's explicit choice for this date
    return !!(isToday && hasLoggedSets); // auto: engage once logging is underway
}
function setFocus(date, on) { todayState.focus = { date, on }; }
// The slim sticky header shown in focus mode — day name, sets-of-exercises progress,
// the one-line Brief read for context, and a one-tap exit back to the full Today.
function focusBarHtml(read, day, { exDone, exTotal, isToday }) {
    return CairnTodayBrief.focusBarHtml(read, day, { exDone, exTotal, isToday });
}
// The optional "tap to see why" detail — plain-language signals, never raw numbers
// as a verdict. Built lazily into a toast-like inline expander under the Brief.
function briefSignalsText(read) {
    return CairnTodayBrief.signalsText(read);
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
const TODAY_RAIL_LOADERS = {
    fuel: () => loadFuelToday(todayState.logDate),
    "week-ahead": () => loadWeekAhead(),
    "program-adjustments": () => loadProgramAdjustmentsBanner(),
    "weekly-read": () => loadTodayReads(),
    "connection-insight": () => loadTodayReads(),
    "garmin-reconcile": () => loadGarminReconcile(),
    lately: () => loadRecentActivities(),
};
function renderableAgendaBuckets(agenda) {
    return window.CairnTodayAgenda.renderableBuckets(agenda);
}
// Fetch the agenda for a date. Best-effort + null-safe: a 404 during dev (route not
// wired yet) or any failure returns null, and the caller falls back to the CURRENT
// fixed rail so Today never breaks while the arbiter is half-integrated.
async function fetchTodayAgenda(date) {
    try {
        const a = await todayApi("/today-agenda?date=" + encodeURIComponent(date || todayState.logDate));
        if (!a || !Array.isArray(a.primary) || !Array.isArray(a.more))
            return null;
        return a;
    }
    catch {
        return null;
    }
}
// Build the rail HTML from the agenda. Each surfaced candidate is either an EXISTING
// client card (its slot, ordered) or a generic Era-2 card (rendered inline). The
// `primary` items lead; the `more` items live inside ONE quiet, collapsed disclosure
// ("N more" — calm, not a badge). Returns "" when nothing is surfaced (quiet day →
// just the Brief). `genericPending` collects the generic candidates we drew so the
// caller can wire them after the innerHTML write.
function buildAgendaRailHtml(agenda, genericPending) {
    return window.CairnTodayAgenda.railHtml(agenda, genericPending);
}
// Run the rail loaders for every surfaced existing client_card (primary + more) and
// wire any generic Era-2 cards. Called after the wholesale innerHTML write, like the
// other Today wiring. De-duped so two candidates that share a loader (weekly-read +
// connection-insight both call loadTodayReads, which fills both slots in one fetch)
// fire it once.
function runAgendaRail(agenda, genericPending) {
    const called = new Set();
    const buckets = renderableAgendaBuckets(agenda);
    for (const c of [...buckets.primary, ...buckets.more]) {
        if (!c.client_card)
            continue;
        const loader = TODAY_RAIL_LOADERS[c.client_card];
        if (!loader || called.has(loader))
            continue;
        called.add(loader);
        try {
            loader();
        }
        catch { }
    }
    wireGenericAgendaCards(genericPending);
}
// Wire the generic Era-2 cards' action + dismiss controls. The action's `kind`
// names where it goes (chat:<prefill> → Chat with the prefill; tab:<name> → that
// tab); a dismiss flips the card away (the producer owns the server-side stamp via
// its own action, if any — here we just collapse it for this view). Best-effort.
function wireGenericAgendaCards(pending) {
    if (!pending || !pending.length)
        return;
    todayView.querySelectorAll("[data-agenda-act]").forEach((b) => {
        if (b._wired)
            return;
        b._wired = true;
        b.addEventListener("click", () => {
            const kind = b.getAttribute("data-agenda-act") || "";
            const id = b.getAttribute("data-agenda-id") || "";
            const c = pending.find((x) => x.id === id);
            const payload = c && c.action ? c.action.payload : null;
            if (kind.startsWith("chat")) {
                gotoChatWith(typeof payload === "string" ? payload : (c && c.title) || "");
                return;
            }
            if (kind === "plan-coach") {
                todayState.planJump = "coach";
                activateTab("plan");
                return;
            }
            if (kind === "plan-endurance") {
                todayState.planJump = "endurance";
                activateTab("plan");
                return;
            }
            // Deep-link into Me → Standing (the whole-athlete review; set the seg state,
            // then activate the Me tab so it renders the right sub-view).
            if (kind === "me-health-standing") {
                todayState.meSeg = "standing";
                activateTab("me");
                return;
            }
            if (kind === "me-health-read") {
                todayState.meSeg = "health";
                todayState.healthSeg = "read";
                todayState.healthSegPicked = true;
                activateTab("me");
                return;
            }
            if (kind.startsWith("tab:")) {
                activateTab(kind.slice(4));
                return;
            }
            // an unrecognized action kind: a calm no-op rather than a broken link.
        });
    });
    todayView.querySelectorAll("[data-agenda-dismiss]").forEach((b) => {
        if (b._wired)
            return;
        b._wired = true;
        b.addEventListener("click", () => {
            const card = b.closest(".agenda-card");
            if (card)
                collapseEl(card, () => card.remove());
            else
                b.remove();
        });
    });
}
async function renderToday(opts = {}) {
    // `soft:true` marks a warm SWR re-render (a background revalidate found new data):
    // numerals snap to their final value instead of re-counting from zero. Passed
    // explicitly (not a shared flag) so re-entrant renders never race over it.
    const soft = !!opts.soft;
    pollToken++; // invalidate any in-flight enrichment polls from a previous render
    if (!todayState.logDate)
        todayState.logDate = localISO();
    setTodayHeaderTitle();
    // Skeleton-first: paint the shell synchronously so a tab switch never leaves the
    // previous tab frozen during the data/agent awaits below. The real render swaps
    // todayView.innerHTML wholesale once the data is in hand. Skip when re-rendering
    // in-place (the Brief is already on screen — a skeleton flash would be jarring).
    // SWR data load: when every input is warm in cache, Today paints REAL content
    // instantly (no skeleton, no network wait) and a single background revalidate
    // upgrades it in place only if something changed. A cold input keeps the existing
    // skeleton + await. The Brief self-SWRs (loadBrief), so it's left untouched.
    // `changed` accumulates from each revalidate; once any input differs we softly
    // re-render Today (guarded against clobbering active logging). `warm` drives the
    // count-up snap so already-shown numerals never re-count from zero.
    const sessKey = "today:session:" + todayState.logDate;
    const peeks = {
        plan: todayState.plan.length ? { data: todayState.plan, fresh: true } : todayPeekCached("plan"),
        session: todayPeekCached(sessKey),
        stats: todayPeekCached("stats"),
        profile: todayPeekCached("profile"),
        exercises: todayPeekCached("exercises"),
    };
    const statsPromise = peeks.stats ? Promise.resolve(peeks.stats.data) : todayApi("/stats");
    const profilePromise = peeks.profile ? Promise.resolve(peeks.profile.data) : todayApi("/profile").catch(() => null);
    const exercisesPromise = peeks.exercises ? Promise.resolve(peeks.exercises.data) : todayApi("/exercises").catch(() => []);
    const warm = Object.values(peeks).every(Boolean);
    const myToken = pollToken; // staleness guard for the background revalidate tail
    let _todayChanged = false;
    const revals = [];
    // Background revalidations; each writes its cache tier and flags a change. Only the
    // 5 primary inputs feed the soft-repaint decision (last-set prefills don't).
    const reval = (path, key) => { revals.push(todayCachedApi(path, { key, onUpgrade: (_d, { changed }) => { if (changed)
            _todayChanged = true; } }).catch(() => { })); };
    // Cold + no existing surface → skeleton-first (the old frozen-tab guard). Warm
    // skips the skeleton entirely: the prior content stays until the synchronous
    // render below swaps in the real today-wrap, so there's no blank/skeleton flash.
    if (!warm && !todayView.querySelector(".today-wrap"))
        todayView.innerHTML = todaySkeleton();
    // /plan
    if (!todayState.plan.length)
        todayState.plan = (peeks.plan ? peeks.plan.data : await todayApi("/plan"));
    reval("/plan", "plan");
    const isToday = todayState.logDate === localISO();
    // session for the selected date (single object or null)
    const session = peeks.session ? peeks.session.data : await todayApi("/sessions?date=" + todayState.logDate);
    reval("/sessions?date=" + todayState.logDate, sessKey);
    const loggedByEx = {};
    if (session)
        for (const s of session.sets)
            (loggedByEx[s.exercise] ??= []).push(s);
    for (const k of Object.keys(loggedByEx))
        loggedByEx[k].sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0));
    // A blank reveal (a logged session suggestion on a day with nothing planned): don't
    // auto-pick a rotation day — leave the session unlinked and the surface clean, so
    // only the suggested/off-plan cards show. The day-switch still lets the athlete pull
    // a real plan day in (which sets dayPicked and exits this branch).
    const revealBlank = !!(todayState.planReveal && todayState.planReveal.date === todayState.logDate && todayState.planReveal.on && todayState.planReveal.blank);
    const hasSelectedDay = todayState.plan.some((d) => d.day_number === todayState.day);
    if (revealBlank && !todayState.dayPicked) {
        todayState.day = null;
    }
    else if (!todayState.dayPicked || todayState.day === null || !hasSelectedDay) {
        todayState.day = await suggestedPlanDayNumber(session, isToday);
        todayState.dayPicked = false;
    }
    const day = (revealBlank && todayState.day === null)
        ? { items: [] }
        : (todayState.plan.find((d) => d.day_number === todayState.day) || todayState.plan[0] || { items: [] });
    // Cardio plan items (kind:'cardio') carry NO loaded exercise — they're a prescription
    // logged through the free-text capture, not the set logger. Keep them out of the
    // name/prefill plumbing (all keyed on a strength exercise name); skips DO cover cardio,
    // keyed by the display label instead (see isSkipped below).
    const planNames = new Set((day.items || []).filter((it) => !isCardioItem(it) && it.exercise).map((it) => it.exercise));
    // ---- Runner loop: synced cardio + sync freshness ----
    // Pull the day's logged cardio efforts ONCE (GET /api/cardio?date=) so each
    // prescription can flip to a calm "done" card on a matched synced run, and pull
    // /settings ONCE for Garmin sync freshness. Both are best-effort + null-safe. We
    // pay for these reads only when the day is plausibly about running — it prescribes
    // cardio, OR (it's today and the plan day has no strength to log, a likely run /
    // rest day where a synced run IS the day's training). A pure lifting day pays
    // nothing. These are a per-render read (always-fresh), not SWR-cached.
    //
    // Matched BEFORE the skip filter, over EVERY cardio item (skipped or not), so a run
    // that synced from the watch still claims its prescription even if it had been marked
    // "not today" — the done card then wins over a stale skip, mirroring how a logged
    // strength set overrides a skip below.
    const allCardio = (day.items || []).filter(isCardioItem);
    const strengthPlanned = (day.items || []).some((it) => !isCardioItem(it) && it.exercise);
    const couldHaveRun = allCardio.length > 0 || (isToday && !strengthPlanned);
    let cardioEfforts = [];
    let todaySettings = null;
    if (couldHaveRun) {
        [cardioEfforts, todaySettings] = await Promise.all([
            todayApi("/cardio?date=" + todayState.logDate).catch(() => []),
            todayApi("/settings").then((r) => (r && r.settings) || null).catch(() => null),
        ]);
        cardioEfforts = Array.isArray(cardioEfforts) ? cardioEfforts : [];
    }
    // Match each prescription to a synced effort (presence of a compatible run is
    // enough). One effort satisfies at most one prescription (consume as matched).
    const matchedCardio = new Map(); // plan item ref → CardioEffort
    if (allCardio.length && cardioEfforts.length) {
        const pool = [...cardioEfforts];
        for (const it of allCardio) {
            const i = pool.findIndex((eff) => cardioEffortMatches(it, eff));
            if (i >= 0)
                matchedCardio.set(it, pool.splice(i, 1)[0]);
        }
    }
    // "Not today" skips for this session. A skip only holds while the work has no result
    // yet: a strength exercise wins once a set is logged (e.g. via chat/MCP), and a cardio
    // prescription wins once a synced run satisfies it (the done card returns). A cardio
    // item carries no loaded exercise, so its skip is keyed by its display label — the same
    // string the skip line shows and POSTs back to restore.
    const skippedSet = new Set(((session && session.skips) || []).map((n) => String(n).toLowerCase()));
    const isSkipped = (it) => isCardioItem(it)
        ? skippedSet.has(cardioLabel(it).toLowerCase()) && !matchedCardio.has(it)
        : !!it.exercise && skippedSet.has(it.exercise.toLowerCase()) && !(loggedByEx[it.exercise] || []).length;
    const activeItems = (day.items || []).filter((it) => !isSkipped(it));
    const skippedItems = (day.items || []).filter(isSkipped);
    const cardioItems = activeItems.filter(isCardioItem);
    // prefill: for plan exercises with no set yet this session, fetch most-recent-ever
    // once. Cache-first per exercise so a warm Today never waits on these either; cold
    // ones are fetched (and cached) in parallel as before.
    const planEx = activeItems.filter((it) => !isCardioItem(it) && it.exercise).map((it) => it.exercise);
    const offPlanEx = Object.keys(loggedByEx).filter((ex) => !planNames.has(ex));
    // Pending off-plan cards: exercises added on the fly ("+ Add exercise" or a logged
    // session suggestion) that have NO set yet, so they live only in todayState. A full
    // re-render — e.g. the first set on a previously-empty day brings in the FINISH
    // block via refreshFinishStat — would otherwise drop them, since off-plan cards are
    // rebuilt from loggedByEx alone. Re-materialize any not already covered by the plan
    // or a logged set, and prune the rest (a now-logged/planned exercise is no longer
    // "pending" — it owns a real card, so deleting its sets drops it as before).
    const planLower = new Set([...planNames].map((n) => n.toLowerCase()));
    const loggedLower = new Set(Object.keys(loggedByEx).map((n) => n.toLowerCase()));
    const pendingForDate = todayState.pendingOffPlan?.[todayState.logDate] ?? [];
    const pendingOffPlan = pendingForDate.filter((p) => p && p.name && !planLower.has(p.name.toLowerCase()) && !loggedLower.has(p.name.toLowerCase()));
    if (todayState.pendingOffPlan && todayState.pendingOffPlan[todayState.logDate])
        todayState.pendingOffPlan[todayState.logDate] = pendingOffPlan;
    const needLast = [...new Set([...planEx, ...pendingOffPlan.map((p) => p.name)])].filter((ex) => !(loggedByEx[ex] && loggedByEx[ex].length));
    const lastSets = {};
    await Promise.all(needLast.map(async (ex) => {
        const lk = "last-set:" + ex;
        const pk = todayPeekCached(lk);
        if (pk) {
            lastSets[ex] = pk.data;
            todayCachedApi("/last-set?exercise=" + encodeURIComponent(ex), { key: lk }).catch(() => { });
            return;
        }
        try {
            lastSets[ex] = await todayCachedApi("/last-set?exercise=" + encodeURIComponent(ex), { key: lk });
        }
        catch {
            lastSets[ex] = null;
        }
    }));
    // ---- Adaptive progression: the next session's adapted target per lift ----
    // The real-time "it follows what I logged" surface. Best-effort + null-safe: the
    // SURFACE endpoint may not be live yet (404) — guard like every other optional
    // fetch, so Today is unchanged if it's missing. Keyed by canonical plan day.
    // Only paid for on a strength-bearing plan day (a pure run/rest day skips it).
    let rxByEx = {};
    if (todayState.day != null && planEx.length) {
        try {
            const list = await todayCachedApi("/program/progression?day=" + encodeURIComponent(todayState.day), {
                key: `program:progression:${todayState.day}`,
                freshFor: 15000,
            });
            if (Array.isArray(list)) {
                for (const rx of list) {
                    if (rx && rx.exercise)
                        rxByEx[String(rx.exercise).toLowerCase()] = rx;
                }
            }
        }
        catch {
            rxByEx = {};
        }
    }
    const rxFor = (name) => (name ? rxByEx[String(name).toLowerCase()] || null : null);
    function prefillFor(it) {
        const logged = loggedByEx[it.exercise] || [];
        if (logged.length) {
            const s = logged[logged.length - 1];
            return { weight: s.weight, reps: s.reps, rir: s.rir, duration_sec: s.duration_sec ?? null };
        }
        const last = lastSets[it.exercise];
        if (last)
            return { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
        return { weight: it.target_weight ?? null, reps: it.rep_low ?? null, rir: null, duration_sec: it.target_seconds ?? null };
    }
    const [stats, profile, exercises] = await Promise.all([statsPromise, profilePromise, exercisesPromise]);
    if (profile) {
        setDiscipline(profile.primary_discipline);
        setEnduranceGoalSet(!!profile.endurance_goal_json);
    } // keep the emphasis globals warm for Progress/Today/Plan
    reval("/stats", "stats");
    reval("/profile", "profile");
    reval("/exercises", "exercises");
    // exercise → mode map ('reps'|'timed'), used by exCard + the add-exercise flow
    todayState.exModes = Object.fromEntries((exercises || []).map((e) => [e.name, e.mode || "reps"]));
    const curW = stats.weight_lb ?? (profile && profile.weight_lb != null ? profile.weight_lb : null);
    // Compass strip: adherence to this week's plan + weight-trend pace vs the
    // goal — the two numbers that actually steer the week (raw tonnage/sets/
    // streak live on in the Progress hero bands).
    const planned = stats.week_planned || 0, done = stats.week_done || 0;
    const dots = planned
        ? `<div class="stat-dots">${Array.from({ length: planned }, (_, i) => `<span class="stat-dot${i < done ? " on" : ""}"></span>`).join("")}</div>`
        : "";
    const fmtPace = (v) => (v > 0 ? "+" : "") + (Math.round(v * 10) / 10);
    // Pace verdict reads in the LANGUAGE of the goal mode — never "behind" when you're
    // just maintaining (the constitution: kind, never anxious). Plain words, no score.
    const goalMode = stats.goal_mode || "lose";
    const PACE_WORDS = {
        lose: { on: "on pace", behind: "behind", fast: "too fast" },
        gain: { on: "building", behind: "not building yet", fast: "building fast" },
        maintain: { holding: "holding steady", drifting_up: "drifting up", drifting_down: "easing down" },
    };
    const paceWord = (PACE_WORDS[goalMode] || PACE_WORDS.lose)[stats.pace_status] || "";
    let paceTile = "";
    if (stats.trend_lb_wk == null) {
        paceTile = `<div class="stat stat-pace"><div class="stat-n numeral stat-dim">—</div><div class="stat-l lbl">pace · log weigh-ins</div></div>`;
    }
    else if (stats.needed_lb_wk == null) {
        paceTile = `<div class="stat stat-pace"><div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div><div class="stat-l lbl">lb/wk · set a goal</div></div>`;
    }
    else {
        // maintain → just the plain-words state (no "need", no pressure); lose/gain → state + needed pace.
        const sub = goalMode === "maintain"
            ? paceWord
            : `${paceWord}${stats.needed_lb_wk ? ` · need ${fmtPace(stats.needed_lb_wk)}` : ""}`;
        const title = goalMode === "maintain"
            ? `Weight trend ${fmtPace(stats.trend_lb_wk)} lb/wk — ${paceWord || "holding steady"}`
            : `Trend ${fmtPace(stats.trend_lb_wk)} lb/wk over recent weigh-ins${stats.goal_weight_lb != null ? ` · need ${fmtPace(stats.needed_lb_wk)} ${goalMode === "gain" ? "to build toward" : "to reach"} ${stats.goal_weight_lb} lb${stats.goal_date ? ` by ${stats.goal_date}` : ""}` : ""}`;
        paceTile = `<div class="stat stat-pace pace-${stats.pace_status || "on"}" title="${escAttr(title)}">
        <div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div>
        <div class="stat-sub">${escHtml(sub)}</div>
        <div class="stat-l lbl">lb / week</div>
      </div>`;
    }
    // Pace offer: a calm OPTIONAL line into Chat when the trend genuinely deviates —
    // a low signal is information, never a verdict. SUPPRESSED entirely in MAINTAIN
    // mode (holding steady is success — no nudge). Gain offers fuel-up / ease-surplus.
    const maxSafe = curW != null ? Math.round(curW * 0.01 * 10) / 10 : null;
    const PACE_OFFER = goalMode === "maintain" ? {}
        : goalMode === "gain" ? {
            behind: {
                line: "Not building yet — want to look at fueling together?",
                ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but I'm aiming for a lean gain of about ${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk. Should we add some calories to build lean mass?`,
            },
            fast: {
                line: "Building a little fast — want to ease the surplus?",
                ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk, faster than my lean-gain pace (~${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk). Should we trim calories so it stays muscle, not fat?`,
            },
        }
            : {
                fast: {
                    line: "Trending a bit fast — want to look at your pace together?",
                    ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but the lean-safe ceiling for me is about -${maxSafe} lb/wk (needed pace ${fmtPace(stats.needed_lb_wk ?? 0)}). Should we add calories or adjust the plan to protect lean mass?`,
                },
                behind: {
                    line: "A little behind your goal pace — want to look together?",
                    ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but I need ${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk to hit ${stats.goal_weight_lb} lb by ${stats.goal_date}. What should we tighten — meals, cardio, or the timeline?`,
                },
            };
    const paceOffer = isToday && PACE_OFFER[stats.pace_status]
        ? `<button class="pace-offer pace-offer-${stats.pace_status}" id="paceOffer">${escHtml(PACE_OFFER[stats.pace_status].line)} · <span class="pace-offer-cta">ask the coach →</span></button>`
        : "";
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
    // The "n / m exercises logged" progress is a strength-logging count — cardio items
    // are logged through the activity feed, not the set logger, so they don't count here.
    const strengthItems = activeItems.filter((it) => !isCardioItem(it));
    const exDone = strengthItems.filter((it) => (loggedByEx[it.exercise] || []).length).length;
    const exTotal = strengthItems.length;
    // ---- Day-type-aware lead: read the day as run / lift / both / rest ----
    // When the day is about running — cardio prescribed and/or a synced run, with NO
    // strength logged today — the run is the HERO of the plan area, not buried under a
    // strength shell. We don't rewrite Today; we just (a) lead the session head with the
    // run's name + prescription, and (b) order the cardio card(s) FIRST in the surface.
    // A mixed day (both lift + cardio) keeps the lift-led head but still floats cardio
    // up so it's never lost at the bottom. Pure lifting is unchanged.
    const hasSyncedCardioToday = cardioEfforts.length > 0;
    const isRunDay = (cardioItems.length > 0 || hasSyncedCardioToday) && exTotal === 0;
    // Sync freshness: only when Garmin is configured. The stale "this morning's run not
    // synced yet?" nudge fires when a run is prescribed today but no synced effort has
    // landed AND the last sync is stale (see cardioSyncLine). One shared line under the
    // run card (and on the Endurance view).
    const expectingRun = isToday && cardioItems.length > 0
        && !cardioItems.some((it) => matchedCardio.has(it)); // a prescribed run with nothing matched yet
    const syncline = cardioItems.length ? cardioSyncLine(todaySettings, { expectingRun }) : "";
    // In focus mode the chrome (context banner, Brief, insight, capture) gives way to
    // the slim sticky focus header; otherwise the Brief leads as always.
    // Desktop two-column model (≥1100px): the Brief + capture + logging surface are
    // the PRIMARY column (.today-main); the week-ahead / weekly-read / connection-
    // insight / garmin-reconcile / "lately" are the secondary RIGHT RAIL (.today-rail).
    // The rail slots keep their stable ids — every loader (loadWeekAhead, loadTodayReads,
    // loadRecentActivities, loadGarminReconcile) binds to them exactly as before. On
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
    const fixedRailHtml = `<aside class="today-rail">
    ${isToday ? `<div id="weekAheadSlot" class="weekahead-slot"></div>` : ""}
    ${isToday ? `<div id="adjustSlot" class="adjust-slot"></div>` : ""}
    <div id="weeklySlot" class="weekly-slot"></div>
    <div id="insightSlot" class="insight-slot"></div>
    ${isToday ? `<div id="garminReconcileSlot" class="garmin-reconcile-slot"></div>` : ""}
    <div id="qlRecent" class="ql-recent lately-slot"></div>
  </aside>`;
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
            fetchTodayAgenda(todayState.logDate),
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
        : (agenda ? buildAgendaRailHtml(agenda, agendaGeneric) : fixedRailHtml);
    let html = focus
        ? focusBarHtml(read, day, { exDone, exTotal, isToday })
        : `${isToday ? "" : `<button id="backToday" class="ghostbtn back-today">← Back to today</button>`}
    <div id="ctxBanner"><div id="ctxEvents"></div><div id="ctxHealth"></div></div>
    ${briefHtml(read, { showPlan, hasPlanDay, isToday })}
    ${conductorHtml ? `<div class="cfocus-slot cfocus-thread-slot" id="cfocusSlot">${conductorHtml}</div>` : `<div class="cfocus-slot" id="cfocusSlot"></div>`}
    ${conductorLeads ? "" : CairnTodayContext.goalLineHtml(stats, curW, isToday)}
    <div id="draftSlot" class="draft-slot"></div>
    <div id="sugSlot" class="sug-slot"></div>
    <div class="capture-row reveal" style="--i:1">
      <div class="wt-inline" id="wtInline" hidden>
        <input id="wtInlineInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (lb)">
        <button id="wtInlineGo" class="logbtn">+</button>
      </div>
      <div class="quicklog">
        <input id="qlInput" type="text" placeholder="Log a ride, run, meal, or weight…">
        <button id="qlMic" class="qlmic" type="button" hidden aria-label="Dictate" title="Say it out loud">${MIC_GLYPH}</button>
        <button id="qlBtn" class="logbtn">↵</button>
        <button id="wtChipMini" class="wt-mini" title="Log bodyweight">${curW != null ? `${curW}<span class="wt-mini-unit">lb</span>` : "weight"}<span class="stat-plus">+</span></button>
      </div>
      <div id="freqFoods" class="freq-foods"></div>
      ${isToday ? `<div id="checkinSlot" class="checkin-slot"></div>` : ""}
    </div>`;
    // ---- A finished workout: calm "done" card, the live surface put away ----
    if (showDone) {
        html += sessionDoneCard(session, day, { isToday });
    }
    else if (showPlan) {
        // ---- Plan / logging surface — the launchpad, shown when the day calls for it ----
        html += `<div class="plansurface reveal" style="--i:2">`;
        // A designed break between the analysis above (Brief + capture) and the logging
        // surface below — the eye lands on "here begins the work" instead of one flat,
        // undifferentiated scroll. Focus mode has its own slim sticky header, so skip it there.
        if (!focus) {
            // On a run day (cardio-led, no strength), the head names the RUN — its label +
            // prescription — so the day reads as "today is a run", not a strength shell with
            // a cardio card hiding inside. No focus pill (there's no set-by-set logging to
            // focus into). Otherwise the strength session leads exactly as before.
            if (isRunDay) {
                const lead = cardioItems[0] || null;
                const rName = lead ? cardioLabel(lead) : "Today's run";
                const rPres = lead ? cardioPrescription(lead) : "";
                html += `<div class="session-head session-head-run">
          <div class="session-head-main">
            <div class="session-kicker lbl">${isToday ? "TODAY · A RUN" : "A RUN"}</div>
            <h2 class="session-title">${escHtml(rName)}${rPres ? `<span class="session-focus"> · ${escHtml(rPres)}</span>` : ""}</h2>
          </div>
        </div>`;
            }
            else {
                const sName = day && day.name ? day.name : "Today's session";
                // Describe the plan day actually being logged (its own focus) — the Brief's
                // suggested focus lives in the card above and can name a different day.
                const sFocus = (day && day.focus) ? day.focus : "";
                // A MIXED day (strength + a prescribed/synced run) reads as "LIFT + RUN" so a
                // hybrid athlete sees both at a glance — the run cards float up right below.
                const mixed = cardioItems.length > 0 || hasSyncedCardioToday;
                const kicker = mixed
                    ? (isToday ? "TODAY · LIFT + RUN" : "LIFT + RUN")
                    : (isToday ? "TODAY'S SESSION" : "SESSION");
                html += `<div class="session-head">
          <div class="session-head-main">
            <div class="session-kicker lbl">${kicker}</div>
            <h2 class="session-title">${escHtml(sName)}${sFocus ? `<span class="session-focus"> · ${escHtml(sFocus)}</span>` : ""}</h2>
          </div>
          <div class="session-head-side">
            ${exTotal ? `<span class="session-prog" title="exercises with a logged set"><b>${exDone}</b><span class="session-prog-sep">/</span>${exTotal}</span>` : ""}
            <button class="focus-enter" id="focusEnter" title="Distraction-free logging">${CairnTodayBrief.BRIEF_KIND.train.glyph} Focus</button>
          </div>
        </div>`;
            }
        }
        html += `<div class="day-switch">`;
        for (const d of todayState.plan) {
            html += `<button class="daybtn ${d.day_number === todayState.day ? "active" : ""}" data-day="${d.day_number}">${d.day_number} · ${escHtml(d.name)}</button>`;
        }
        html += `</div><div id="tableHint"></div>`;
        // ---- "It followed your logs" — one calm banner + an apply control ----
        // When the progression engine has actual MOVES for this day (anything past a
        // plain hold), surface ONE quiet line above the cards: the day's targets have
        // adapted to what you logged, and you can fold them into your plan. The per-lift
        // detail lives on each card (ex-rx); this is just the at-a-glance + the apply.
        // Pull, never push — a hold-only day shows nothing. Goes through propose→apply,
        // so "Apply to my plan" lands a DRAFT for review, never an auto-change.
        const rxMoves = todayRxMoveCount(rxByEx);
        if (rxMoves > 0) {
            const word = rxMoves === 1 ? "One lift has a new target" : `${rxMoves} lifts have new targets`;
            html += `<div class="rx-banner reveal" style="${stagger(0)}">
        <div class="rx-banner-text">
          <span class="rx-banner-ico" aria-hidden="true">✦</span>
          <span class="rx-banner-h">${escHtml(word)} from what you logged</span>
        </div>
        <button class="rx-banner-apply draftbtn" id="rxApplyBtn" type="button" data-rx-day="${escAttr(String(todayState.day))}">Apply to my plan</button>
      </div>`;
        }
        // Garmin "body's reaction" card — the strength session's physiology layer
        // (HR / zones / calories / training effect), reconciled from a synced watch.
        if (hasGarmin)
            html += garminSessionCard(session.garmin);
        let cardIdx = 0;
        // The sync-freshness line rides on the first UNMATCHED cardio card (where a runner
        // looks to trust this morning's mileage). A matched run is already "done" — no line.
        let syncLineUsed = false;
        // On a run/mixed day float the cardio prescription(s) to the top of the surface so
        // the run is the hero, not the tail. A pure lifting day preserves plan order.
        const surfaceItems = (isRunDay || cardioItems.length > 1 || (cardioItems.length && strengthItems.length))
            ? [...activeItems.filter(isCardioItem), ...activeItems.filter((it) => !isCardioItem(it))]
            : activeItems;
        for (const it of surfaceItems) {
            // A planned cardio effort is a prescription + a "log this" affordance (it routes
            // through the free-text capture), not the set-by-set logger. A matched synced run
            // flips it to a calm "done" card; an unmatched one keeps the prescription + a
            // quiet "or it'll sync from your watch" fallback and (once) the freshness line.
            if (isCardioItem(it)) {
                const matched = matchedCardio.get(it) || null;
                const line = (!matched && !syncLineUsed) ? syncline : "";
                if (line)
                    syncLineUsed = true;
                html += cardioPlanCard(it, cardIdx++, matched, line);
                continue;
            }
            html += exCard({ ...it, fromPlan: true }, loggedByEx[it.exercise] || [], prefillFor(it), cardIdx++, rxFor(it.exercise));
        }
        for (const ex of offPlanEx) {
            const logged = loggedByEx[ex];
            const s = logged[logged.length - 1];
            html += exCard({ exercise: ex, fromPlan: false }, logged, { weight: s.weight, reps: s.reps, rir: s.rir }, cardIdx++, rxFor(ex));
        }
        // Pending off-plan cards (added but not yet logged) — rebuilt so a re-render never
        // drops a freshly-added exercise before its first set lands. Prefill from last-set.
        for (const p of pendingOffPlan) {
            const last = lastSets[p.name];
            const prefill = last
                ? { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null }
                : { weight: null, reps: null, rir: null, duration_sec: null };
            html += exCard({ exercise: p.name, fromPlan: false, mode: p.mode || null }, [], prefill, cardIdx++, rxFor(p.name));
        }
        html += `<div class="addex">
      <button id="addExBtn" class="ghostbtn addex-btn">+ Add exercise</button>
      <div id="addExForm" class="addex-form" hidden>
        <div class="addex-row">
          <input id="addExInput" type="text" autocomplete="off" placeholder="Search or type an exercise" list="exOptions">
          <datalist id="exOptions"></datalist>
          <button id="addExGo" class="logbtn">+</button>
        </div>
        <div class="addex-mode" id="addExMode" role="group" aria-label="Exercise type">
          <button class="modebtn active" data-exmode="reps">Reps</button>
          <button class="modebtn" data-exmode="timed">Timed</button>
        </div>
      </div>
    </div>`;
        if (hasLoggedSets) {
            const tonnage = setsTonnage(session.sets);
            html += `<div class="finish">
        <div class="finish-stat" data-finishstat>${session.sets.length} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + todayState.logDate}</div>
        <div id="feedbackSlot" class="feedback-slot"></div>
        <div class="logrow" style="margin-top:8px">
          <input id="sessNotes" type="text" placeholder="Session notes (optional)" value="${escAttr(session.notes || "")}" style="text-align:left">
          <button id="finishBtn" class="logbtn" style="width:auto;padding:0 16px;font-size:.82rem;letter-spacing:.04em">FINISH</button>
        </div>
      </div>`;
        }
        // Skipped exercises live on as one slim, muted line at the very bottom —
        // recoverable later in the day (tap a name to restore), never buried.
        html += skipLineHtml(skippedItems.map((it) => (isCardioItem(it) ? cardioLabel(it) : it.exercise)));
        html += `</div>`; // .plansurface
    }
    // ---- Trajectory tier (this week), quiet, below the fold — hidden in focus ----
    if (!focus) {
        // Discipline-aware emphasis (gentle): an endurance athlete leads with mileage,
        // a hybrid shows lifts + mileage side by side, a lifter is unchanged. Never
        // hides a surface — only reorders which number the week opens with.
        const end = stats.endurance || {};
        const weekKm = Number(end.week_km) || 0;
        const mileageTile = `<div class="stat" title="Distance logged this week">
        <div class="stat-n numeral"><span data-cu="${weekKm}">0</span><span class="stat-frac">km</span></div>
        <div class="stat-l lbl">this week${end.week_moving_min ? ` · ${Math.round(end.week_moving_min)} min` : ""}</div>
      </div>`;
        const adherenceTile = `<div class="stat" title="Training sessions logged this week vs your plan">
        <div class="stat-n numeral"><span data-cu="${done}">0</span><span class="stat-frac">/${planned || "—"}</span></div>
        ${dots}
        <div class="stat-l lbl">this week</div>
      </div>`;
        const wtTile = `<button class="stat stat-wt" id="wtChip" title="Log bodyweight">
        <div class="stat-n numeral" data-wtval>${curW != null ? curW : "—"}<span class="stat-plus">+</span></div>
        <div class="stat-l lbl">${stats.goal_weight_lb != null ? `lb → ${escHtml(String(stats.goal_weight_lb))}` : "weight · lb"}</div>
      </button>`;
        // Compass cells per mode: endurance leads mileage; hybrid pairs lifts+mileage;
        // strength keeps the original adherence + pace + weight.
        let compassCells = "";
        if (isEndurance())
            compassCells = `${mileageTile}${paceTile}${wtTile}`;
        else if (isHybrid())
            compassCells = `${adherenceTile}${mileageTile}${wtTile}`;
        else
            compassCells = `${adherenceTile}${paceTile}${wtTile}`;
        // Collapsed-state recap: speak to BOTH modalities, ordering by the active
        // discipline so the summary opens with what the athlete trains for.
        const liftBit = done ? `${done} lift${done === 1 ? "" : "s"}` : "";
        const cardioBits = [];
        if (stats.week_cardio)
            cardioBits.push(`${stats.week_cardio} cardio`);
        if (weekKm)
            cardioBits.push(`${fmtKm(weekKm)} km`);
        const cardioBit = cardioBits.join(" · ");
        const recapBits = (isEndurance() ? [cardioBit, liftBit] : [liftBit, cardioBit]).filter(Boolean);
        const weekRecap = recapBits.join(" · ");
        html += `${paceOffer}
    <details class="weekfold" id="weekFold">
      <summary class="weekfold-sum"><span class="lbl">This week</span>${weekRecap ? `<span class="weekfold-recap">${escHtml(weekRecap)}</span>` : ""}<span class="weekfold-chev" aria-hidden="true">▾</span></summary>
      <div class="statstrip statstrip-compass">
        ${compassCells}
      </div>
      <div id="wearStrip"></div>
    </details>`;
    }
    // Scope the focus class to this render via a wrapper, so a tab switch (which
    // replaces #view wholesale) can never leave the class stranded. The primary
    // column (.today-main) holds the Brief, capture, and logging surface; the rail
    // (.today-rail) sits beside it on wide screens (section 36) and stacks under it
    // on mobile/tablet. Focus mode is a single centered column — no rail.
    todayView.innerHTML = focus
        ? `<div class="today-wrap today-focus">${html}</div>`
        : `<div class="today-wrap"><div class="today-main">${html}</div>${railHtml}</div>`;
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
    updateHeaderCondense(); // re-render may reset scroll → recompute the pinned-header state
    // On a warm SWR re-render (a background revalidate found new data) snap the
    // numerals to their final value — never re-count an already-shown number from 0.
    runCountUps(view, { snap: soft });
    const qlBtn = todayView.querySelector("#qlBtn");
    const qlInput = todayView.querySelector("#qlInput");
    if (qlBtn)
        qlBtn.addEventListener("click", quickLog);
    if (qlInput)
        qlInput.addEventListener("keydown", (e) => { if (e.key === "Enter")
            quickLog(); });
    // "Log this run/ride" on a planned cardio card: prefill the free-text capture with
    // a sensible sentence and focus it, so logging the effort is one tap + a tweak —
    // the same activity-log path everything else flows through, never a new logger.
    todayView.querySelectorAll("[data-cardio-log]").forEach((b) => b.addEventListener("click", () => {
        const inp = todayView.querySelector("#qlInput");
        if (!inp)
            return;
        inp.value = b.dataset.cardioLog;
        inp.focus();
        try {
            inp.setSelectionRange(inp.value.length, inp.value.length);
        }
        catch { }
        inp.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    }));
    // "Sync now" on a run card's freshness line — pull from the watch, then re-render
    // Today so this morning's run (and its zones/pace) lands in place.
    wireCardioSync(view, () => renderToday({ soft: true }));
    // "Apply to my plan" — fold the day's adapted targets into a DRAFT proposal.
    const rxApplyBtn = todayView.querySelector("#rxApplyBtn");
    if (rxApplyBtn)
        rxApplyBtn.addEventListener("click", () => {
            const d = Number(rxApplyBtn.dataset.rxDay);
            applyDayProgression(rxApplyBtn, Number.isFinite(d) ? d : todayState.day);
        });
    wireBrief(read, { isToday });
    // If we painted a provisional (cold-cache) read, upgrade it to the agentic read
    // in place — the filament keeps running until the real read settles in.
    if (read._provisional)
        upgradeBriefInPlace(todayState.logDate, isToday);
    // Connected-brain provenance: a quiet causal line under the Brief on a training
    // day, if a training/watch directive shaped it ("eased volume — RHR ran high · why").
    if (!focus && showPlan)
        loadTrainingProvenance(isToday);
    loadTableHint();
    // The chrome — capture row, context banners, insight, frequents, week tier — only
    // exists outside focus mode; skip its wiring entirely when focused.
    if (!focus) {
        setupWeightChip();
        setupVoiceCapture();
        loadFrequentFoods();
        // The Brief-adjacent context surfaces (events / health focus / wearable strip /
        // morning check-in / a waiting draft) live in .today-main, not the arbitrated
        // rail, so they load unconditionally as before.
        loadContextBanner();
        // The standalone health-lever line is SUBSUMED by the conductor when it leads —
        // one voice. It only loads (and the ◎ goal line / ✦ draft banner only render)
        // when the conductor is unavailable, so Today degrades to exactly its prior shape.
        if (!conductorLeads)
            loadHealthFocusBanner();
        loadWearable(isToday);
        if (isToday) {
            loadCheckin();
            loadDraftProposals();
        }
        // The RAIL is arbiter-governed: run only the surfaces the agenda surfaced (in its
        // ranked order, primary + more), plus wire any generic Era-2 cards. When the
        // agenda is unavailable we fall back to the fixed-rail loaders exactly as before.
        if (agenda) {
            runAgendaRail(agenda, agendaGeneric);
        }
        else {
            // Fallback (agenda route unavailable): the other rail cards still load. Fuel is
            // intentionally NOT loaded here — it has no slot in fixedRailHtml and surfaces
            // only via the agenda, so the evaluation-only fuel glance is never a capture nudge.
            loadRecentActivities();
            if (isToday) {
                loadTodayReads();
                loadGarminReconcile();
                loadWeekAhead();
                loadProgramAdjustmentsBanner();
            }
        }
        todayView.querySelector("#goalLine")?.addEventListener("click", () => activateTab("progress"));
    }
    // Focus toggle — enter (pill above the cards) / exit (slim header), each a smooth
    // view-transition morph between the full Today and the focused logging todayView.
    const focusEnterBtn = todayView.querySelector("#focusEnter");
    if (focusEnterBtn)
        focusEnterBtn.addEventListener("click", () => {
            setFocus(todayState.logDate, true);
            withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
        });
    const focusExitBtn = todayView.querySelector("#focusExit");
    if (focusExitBtn)
        focusExitBtn.addEventListener("click", () => {
            setFocus(todayState.logDate, false);
            withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
        });
    const paceOfferBtn = todayView.querySelector("#paceOffer");
    if (paceOfferBtn)
        paceOfferBtn.addEventListener("click", () => {
            todayState.chatPrefill = PACE_OFFER[stats.pace_status]?.ask || "";
            activateTab("chat");
        });
    const backBtn = todayView.querySelector("#backToday");
    if (backBtn)
        backBtn.addEventListener("click", () => {
            todayState.logDate = localISO();
            todayState.day = null;
            todayState.dayPicked = false;
            renderToday();
        });
    todayView.querySelectorAll(".daybtn").forEach((b) => b.addEventListener("click", () => {
        todayState.day = Number(b.dataset.day);
        todayState.dayPicked = true;
        renderToday();
    }));
    wireDeletes();
    wireSkips();
    wireGuides(view);
    const finishBtn = todayView.querySelector("#finishBtn");
    if (finishBtn)
        finishBtn.addEventListener("click", async () => {
            finishBtn.disabled = true;
            const notes = todayView.querySelector("#sessNotes").value.trim();
            let r;
            try {
                r = await todayApi(`/sessions/${session.id}/finish`, {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }),
                });
            }
            catch {
                finishBtn.disabled = false;
                toast("Couldn't finish — check your connection");
                return;
            }
            const sm = r.summary || {};
            // finishing stamps the session (Today flips to the done card) and lands it in
            // History — invalidate so renderToday + History read the finished todayState.
            todayState.brief = null;
            swrInvalidate("today:session:" + todayState.logDate);
            swrInvalidate("history:sessions");
            swrInvalidate("stats");
            stopRest();
            // Elite micro-exit: the logging surface lifts away, then Today re-renders to the
            // calm "done" card (which reveals in). The workout now lives in your history.
            const surface = todayView.querySelector(".plansurface");
            const settle = () => {
                if (todayState.tab !== "today")
                    return; // user navigated away during the exit animation
                toast(`Done · ${sm.sets || 0} sets · ${(sm.tonnage || 0).toLocaleString()} lb`);
                renderToday();
            };
            if (surface && !reducedMotion()) {
                surface.classList.add("slide-out");
                setTimeout(settle, 300);
            }
            else {
                settle();
            }
        });
    // Done card: reopen to keep logging, or jump to the session in History.
    const reopenBtn = todayView.querySelector("#reopenBtn");
    if (reopenBtn)
        reopenBtn.addEventListener("click", async () => {
            reopenBtn.disabled = true;
            try {
                await todayApi(`/sessions/${session.id}/reopen`, { method: "POST" });
            }
            catch { }
            // reopening clears finished_at — Today returns to the live surface; refresh caches.
            todayState.brief = null;
            swrInvalidate("today:session:" + todayState.logDate);
            swrInvalidate("history:sessions");
            todayState.planReveal = { date: todayState.logDate, on: true };
            withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
        });
    const toHistoryBtn = todayView.querySelector("#toHistoryBtn");
    if (toHistoryBtn)
        toHistoryBtn.addEventListener("click", () => activateTab("progress"));
    todayView.querySelectorAll(".ex .logrow").forEach((row) => wireLogRow(row));
    if (hasLoggedSets)
        renderFeedback(todayView.querySelector("#feedbackSlot"), session);
    setupAddExercise();
    // SWR tail: once the background revalidations settle, if any of the 5 primary
    // inputs actually changed, softly re-render Today in place (numerals SNAP, never
    // re-count). Guarded so a refresh never clobbers what the athlete is doing: bail
    // if we navigated away / the date moved (pollToken), if a logging input is
    // focused, or if the Brief is mid-reshape.
    if (revals.length)
        Promise.all(revals).then(() => {
            if (!_todayChanged)
                return;
            if (myToken !== pollToken || todayState.tab !== "today")
                return; // moved on / a newer render superseded us
            const ae = document.activeElement;
            if (ae && (ae.closest?.(".ex") || ae.closest?.(".quicklog") || ae.closest?.(".addex") || ae.closest?.(".wt-inline")))
                return; // mid-entry
            if (todayView.querySelector(".brief.is-thinking"))
                return; // a steer reshape is in flight
            renderToday({ soft: true });
        });
}
// A finished workout's calm wrap-up: a quiet checkmark, the day, the numbers that
// matter, the "how did that feel?" slot, and two soft ways forward (log more /
// see it in history). No score, no verdict — just "that's done, well played".
function sessionDoneCard(session, day, { isToday }) {
    return CairnTodaySessionStatus.sessionDoneCardHtml(session, day, { isToday });
}
// ---------- Autoregulation: gentle 1-tap "how did that feel?" ----------
// Optional, calm, dismissible. A 1-5 soreness + 1-5 performance tap and an
// optional joint/area field, on a session that already has logged sets. The
// session object (from GET /api/sessions?date=) already carries any prior
// answer, so we render it as recorded when it's set. Recovery INFORMS the
// coach — it never auto-changes a plan (you drive).
function hasFeedback(session) {
    return CairnTodaySessionStatus.hasFeedback(session);
}
function renderFeedback(slot, session) {
    if (!slot)
        return;
    if (hasFeedback(session)) {
        renderFeedbackDone(slot, session);
        return;
    }
    // collapsed by default — one quiet line, opt-in
    slot.innerHTML = CairnTodaySessionStatus.feedbackOpenHtml();
    const open = slot.querySelector("#feedbackOpen");
    if (open)
        open.addEventListener("click", () => renderFeedbackForm(slot, session));
}
function renderFeedbackForm(slot, session) {
    slot.innerHTML = CairnTodaySessionStatus.feedbackFormHtml(session);
    const date = session.date || todayState.logDate;
    const picked = {};
    const save = async () => {
        const joint = slot.querySelector("#feedbackJoint");
        const jointVal = joint ? joint.value.trim() : "";
        try {
            const saved = await todayApi(`/sessions/${date}/feedback`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    soreness: picked.soreness, performance: picked.performance,
                    joint_pain: jointVal || null,
                }),
            });
            if (saved && !saved.error) {
                Object.assign(session, saved);
            }
        }
        catch { /* silent — it's optional */ }
    };
    slot.querySelectorAll(".feel-dot").forEach((b) => b.addEventListener("click", async () => {
        const kind = b.dataset.feel, val = Number(b.dataset.val);
        picked[kind] = val;
        slot.querySelectorAll(`.feel-dot[data-feel="${kind}"]`).forEach((d) => d.classList.toggle("feel-dot-on", Number(d.dataset.val) <= val));
        await save();
        toast("Noted");
    }));
    // a joint/area entered on its own is still worth recording
    const joint = slot.querySelector("#feedbackJoint");
    if (joint)
        joint.addEventListener("change", () => { if (picked.soreness || picked.performance || joint.value.trim())
            save(); });
    const dismiss = slot.querySelector("#feedbackDismiss");
    if (dismiss)
        dismiss.addEventListener("click", () => { slot.innerHTML = ""; });
}
function renderFeedbackDone(slot, session) {
    const html = CairnTodaySessionStatus.feedbackDoneHtml(session);
    if (!html) {
        slot.innerHTML = "";
        return;
    }
    slot.innerHTML = html;
    const edit = slot.querySelector("#feedbackEdit");
    if (edit)
        edit.addEventListener("click", () => renderFeedbackForm(slot, session));
}
// Wire the Brief's launchpad: override chips reshape the read; redirects open the
// rest of Today (train anyway / pull in plan / ask for a session). Nothing here is
// a gate — each control is one tap to a different path through the day.
function wireBrief(read, { isToday }) {
    const brief = todayView.querySelector(".brief");
    if (!brief)
        return;
    wireAgentOffline(brief); // dismiss ✕ on the "coaching offline" notice, when present
    // Steer options → reshape the read agentically (POST /today-read/reshape) as a
    // durable background job, so a steer survives a tab switch / reload / restart
    // like the other ops. runOp streams the wait into the Brief; the `done` result
    // is the raw read object, which the op's render adopts + morphs into place.
    brief.querySelectorAll("[data-override]").forEach((b) => b.addEventListener("click", () => {
        const intent = b.dataset.override;
        if (brief.classList.contains("is-thinking"))
            return; // a reshape is already in flight
        // Visible "thinking" state for the (slow, agentic) reshape: the tapped option
        // carries a ring, the rest freeze, a filament sweeps the card, and a quiet line
        // makes the wait read as intentional rather than stalled.
        paintBriefReshaping(brief, b);
        // bust the per-date cache so the next plain render re-reads the steered Brief
        todayState.brief = null;
        runOp("day_read_override", { date: todayState.logDate, override: intent, agent: "auto" }, dayReadOverrideOpOpts({ intent, isToday, prevFocus: read.focus }));
    }));
    // Redirects: start the session (reveal + scroll), reveal the plan, pull in a
    // plan day, or ask for a session. None is a gate — each is one tap to a path.
    brief.querySelectorAll("[data-redirect]").forEach((b) => b.addEventListener("click", () => {
        const action = b.dataset.redirect;
        if (action === "ask-session") {
            revealSessionComposer();
            return;
        }
        if (action === "view-week") {
            activateTab("plan");
            return;
        } // the day-ahead → the full plan/week
        if (action === "view-program") {
            todayState.progressSeg = "program";
            activateTab("progress");
            return;
        } // the arc → the program/periodization view
        if (action === "start-session") {
            // the day's primary on a train day: make sure the logging surface exists,
            // then bring its first card into view so "start" lands you in the work.
            revealPlanThen(() => {
                const surface = todayView.querySelector(".plansurface") || todayView.querySelector(".addex");
                surface?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
            });
            return;
        }
        if (action === "reveal-plan") {
            todayState.planReveal = { date: todayState.logDate, on: true };
            renderToday();
            return;
        }
        if (action === "pull-plan") {
            // surface the planned day's logging cards (the day switcher + cards)
            todayState.planReveal = { date: todayState.logDate, on: true };
            todayState.dayPicked = true;
            renderToday();
            return;
        }
    }));
    // "Back to today's read" — clear a persisted steer and recompute the canonical
    // read (?reset=1 invalidates the cached steer server-side). The athlete is never
    // trapped in an override they changed their mind about.
    const steerReset = brief.querySelector("[data-steerreset]");
    if (steerReset)
        steerReset.addEventListener("click", async () => {
            if (brief.classList.contains("is-thinking"))
                return;
            brief.querySelectorAll(".brief-steer-opt").forEach((c) => { c.disabled = true; });
            steerReset.disabled = true;
            steerReset.innerHTML = `<span class="aspin aspin-xs"></span>back to today's read`;
            brief.classList.add("is-thinking");
            const note = document.createElement("div");
            note.className = "athinking-note chip-in";
            note.textContent = "Reading the day again…";
            (steerReset.closest(".brief-steer") || steerReset.parentElement).after(note);
            todayState.brief = null;
            try {
                const qs = new URLSearchParams({ date: todayState.logDate, agent: "auto", reset: "1" });
                const fresh = await todayApi("/today-read?" + qs.toString());
                todayState.brief = {
                    date: todayState.logDate,
                    override: fresh && fresh.override ? fresh.override : "",
                    read: fresh && fresh.kind ? fresh : { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic" },
                };
            }
            catch {
                todayState.brief = null;
            }
            if (todayState.tab !== "today")
                return;
            const morph = !reducedMotion();
            if (morph) {
                brief.classList.add("brief-morph");
                todayState._briefMorph = true;
            }
            try {
                await withViewTransition(() => renderToday());
            }
            finally {
                todayState._briefMorph = false;
                todayView.querySelector(".brief")?.classList.remove("brief-morph");
            }
        });
    // "Tap to see why" — plain-language signals (never raw numbers as a verdict),
    // shown only on a deliberate tap, in a quiet inline line under the headline.
    const whyBtn = brief.querySelector("[data-briefwhy]");
    if (whyBtn && read.signals && Object.keys(read.signals).length) {
        whyBtn.hidden = false;
        whyBtn.addEventListener("click", () => {
            if (brief.querySelector(".brief-signals")) {
                brief.querySelector(".brief-signals").remove();
                whyBtn.textContent = "tap to see why";
                return;
            }
            const sig = document.createElement("p");
            sig.className = "brief-signals chip-in";
            sig.textContent = briefSignalsText(read);
            whyBtn.before(sig);
            whyBtn.textContent = "hide";
        });
    }
}
// Paint the Brief's "reshaping" state when a steer chip is tapped: the chosen
// option carries a ring, the rest freeze, the card gets the filament, and a quiet
// "Reading the day again…" line makes the wait read as intentional. Reused by the
// reload reconnector so a mid-flight reshape shows the same state after a refresh.
function paintBriefReshaping(brief, chip) {
    const chipLabel = chip ? (chip.textContent || "").trim() : "";
    brief.querySelectorAll(".brief-steer-opt").forEach((c) => {
        c.classList.toggle("brief-steer-active", c === chip);
        if (c !== chip)
            c.disabled = true;
    });
    const resetBtn = brief.querySelector("[data-steerreset]");
    if (resetBtn)
        resetBtn.disabled = true;
    if (chip) {
        chip.classList.add("brief-steer-busy");
        chip.innerHTML = `<span class="aspin aspin-xs"></span>${escHtml(chipLabel)}`;
    }
    if (!reducedMotion())
        brief.classList.add("is-thinking");
    brief.setAttribute("aria-busy", "true"); // screen readers hear "busy" while the read reshapes
    if (!brief.querySelector(".athinking-note")) {
        const note = document.createElement("div");
        note.className = "athinking-note chip-in";
        note.setAttribute("role", "status");
        note.textContent = "Reading the day again…";
        const anchor = brief.querySelector(".brief-steer") || brief;
        anchor.after ? anchor.after(note) : brief.appendChild(note);
    }
}
// The shared runOp options for a Brief override reshape — used by both the live
// chip tap and the reload reconnector, so the morph/fail behavior is identical
// whether the read lands now or after a refresh. The job's `done` result is the
// raw read object (byte-for-byte what GET /api/today-read?override= returns).
function dayReadOverrideOpOpts({ intent, prevFocus } = {}) {
    return {
        path: "/today-read/reshape",
        anchor: ".brief",
        // No .job-cap inside the Brief — the chip + athinking-note carry the wait, so
        // skip runOp's caption (it still drives the filament + reconnect via the host).
        guard: () => !todayView.querySelector(".brief")?.isConnected,
        isFail: (r) => !r || !r.kind,
        render: (read) => {
            if (todayState.tab !== "today") {
                todayState.brief = null;
                return;
            }
            // Adopt the reshaped read exactly like loadBrief: carry the persisted steer.
            todayState.brief = { date: todayState.logDate, override: intent || read.override || "", read };
            // The re-render runs inside a view transition so the hero (brief-hero shared
            // element) morphs to its reshaped read fluidly instead of popping.
            const morph = !reducedMotion();
            if (morph) {
                todayView.querySelector(".brief")?.classList.add("brief-morph");
                todayState._briefMorph = true;
            }
            Promise.resolve(withViewTransition(() => renderToday())).finally(() => {
                todayState._briefMorph = false;
                todayView.querySelector(".brief")?.classList.remove("brief-morph");
            });
            // "short on time" also offers a shorter session straight away.
            if (/short on time/i.test(intent || ""))
                askForSession({ minutes: 30, focus: read.focus || prevFocus || undefined });
        },
        onFail: (_err) => {
            // designed failure (no read) or unreachable — fall back to the canonical read.
            // A null err means the POST itself failed; either way, clear the steer and let
            // Today re-read the calm cached Brief so the chip never stays stuck "thinking".
            todayState.brief = null;
            const live = todayView.querySelector(".brief");
            if (live) {
                live.classList.remove("is-thinking");
                live.removeAttribute("aria-busy");
                live.querySelector(".athinking-note")?.remove();
            }
            if (todayState.tab === "today")
                renderToday();
        },
    };
}
// Reconnector: after a reload mid-reshape, jobReconnect rebuilds the Brief's
// thinking state and returns the handlers runOp would have used, so a steer that
// finished (or finishes) while we were away lands in place. Mirrors the
// session-suggest reconnector's option→handler translation.
function reconnectDayReadOverride(job) {
    if (todayState.tab !== "today")
        return null; // not on Today — a later renderToday() retries
    const brief = todayView.querySelector(".brief");
    if (!brief)
        return null;
    const intent = (job && job.input && job.input.override) || "";
    // Mark the active chip (best-effort) and paint the reshaping todayState.
    const chip = [...brief.querySelectorAll(".brief-steer-opt")].find((c) => c.dataset.override === intent) || null;
    todayState.brief = null;
    paintBriefReshaping(brief, chip);
    const o = dayReadOverrideOpOpts({ intent, isToday: todayState.logDate === localISO(), prevFocus: null });
    const clearBusy = () => { const b = todayView.querySelector(".brief"); if (b)
        b.classList.remove("is-thinking", "is-thinking--determinate"); };
    return {
        guard: o.guard,
        onDone: (result) => { clearBusy(); if (o.isFail(result))
            o.onFail(result);
        else
            o.render(result); },
        onError: () => { clearBusy(); o.onFail(null); },
        onCanceled: () => { clearBusy(); o.onFail(null); },
    };
}
// delete wiring (re-callable after inline chip inserts; guards against double-binding)
function wireDeletes() {
    todayView.querySelectorAll("[data-del]").forEach((b) => {
        if (b._wired)
            return;
        b._wired = true;
        b.addEventListener("click", async (e) => {
            e.stopPropagation();
            await todayApi(`/sets/${b.dataset.del}`, { method: "DELETE" });
            // a removed set changes this date's session + stats + History — invalidate so
            // the wholesale renderToday below (and other surfaces) read truth.
            todayState.brief = null;
            swrInvalidate("today:session:" + todayState.logDate);
            swrInvalidate("stats");
            swrInvalidate("history:sessions");
            swrInvalidate("progress:volume");
            invalidateTodayProgression();
            // refresh from server so set numbers + counts stay correct
            renderToday();
        });
    });
}
// ---------- skip an exercise for the day ("not today") ----------
// collapseEl / expandEl live in ui-motion-client.ts and stay compatibility globals
// for Today, Capture, Progress, and Health directive cards.
// The slim "Skipped: …" line at the very bottom of Today. Hidden while empty.
function skipNameHtml(name) {
    return CairnTodaySessionStatus.skipNameHtml(name);
}
function skipLineHtml(names) {
    return CairnTodaySessionStatus.skipLineHtml(names);
}
function addSkipName(name) {
    const line = todayView.querySelector("#skipLine");
    if (!line)
        return;
    const names = line.querySelector(".skipline-names");
    const dup = [...names.querySelectorAll("[data-unskip]")]
        .some((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase());
    if (!dup) {
        const tpl = document.createElement("template");
        tpl.innerHTML = skipNameHtml(name).trim();
        const el = tpl.content.firstElementChild;
        if (!el || !names)
            return;
        el.classList.add("chip-in");
        names.appendChild(el);
    }
    line.classList.remove("skipline-empty");
}
function removeSkipName(name) {
    const line = todayView.querySelector("#skipLine");
    if (!line)
        return;
    [...line.querySelectorAll("[data-unskip]")]
        .filter((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase())
        .forEach((b) => b.remove());
    if (!line.querySelector("[data-unskip]"))
        line.classList.add("skipline-empty");
}
async function skipFromCard(card, exercise) {
    let res;
    try {
        res = await todayApi("/sessions/skip", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date: todayState.logDate, exercise }),
        });
    }
    catch {
        toast("Couldn't skip — try again");
        return;
    }
    if (!res || res.ok !== true) {
        toast(res && res.error ? "Sets already logged — delete them first" : "Couldn't skip — try again");
        return;
    }
    swrInvalidate("today:session:" + todayState.logDate); // the session's skips changed
    // remember where the card sat so UNDO can put it back in place, wiring intact
    const anchor = card.nextElementSibling;
    collapseEl(card, () => { card.remove(); addSkipName(exercise); });
    toast(`${exercise} skipped today`, { action: "Undo", onAction: () => undoSkip(card, anchor, exercise) });
}
async function undoSkip(card, anchor, exercise) {
    try {
        await todayApi("/sessions/skip", {
            method: "DELETE", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date: todayState.logDate, exercise }),
        });
    }
    catch {
        toast("Couldn't restore — try again");
        return;
    }
    swrInvalidate("today:session:" + todayState.logDate); // the session's skips changed
    if (todayState.tab !== "today")
        return;
    removeSkipName(exercise);
    if (!card.isConnected) {
        // the detached card kept all its listeners — slot it back where it was.
        // Insert relative to the ref node's own parent (.plansurface), since
        // insertBefore needs the ref to be a direct child of the caller.
        const before = anchor && anchor.isConnected ? anchor : todayView.querySelector(".addex");
        if (!before || !before.parentNode) {
            renderToday();
            return;
        }
        before.parentNode.insertBefore(card, before);
    }
    expandEl(card);
}
// An off-plan card with no logged sets isn't persisted anywhere — it's a transient
// DOM card from appendOffPlanCard — so removing it is a pure in-flow collapse, no API.
function removeOffPlanCard(card) {
    if (!card)
        return;
    // drop it from the pending list too, so a later re-render doesn't bring it back.
    const name = card.dataset && card.dataset.card;
    if (name && todayState.pendingOffPlan && todayState.pendingOffPlan[todayState.logDate]) {
        todayState.pendingOffPlan[todayState.logDate] = todayState.pendingOffPlan[todayState.logDate].filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    }
    collapseEl(card, () => card.remove());
}
function wireSkips() {
    todayView.querySelectorAll(".ex-skip").forEach((b) => {
        if (b._wired)
            return;
        b._wired = true;
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            const card = b.closest(".ex");
            if (b.hasAttribute("data-remove-card")) {
                removeOffPlanCard(card);
                return;
            }
            skipFromCard(card, decodeURIComponent(b.dataset.skip));
        });
    });
    const line = todayView.querySelector("#skipLine");
    if (line && !line._wired) {
        line._wired = true;
        line.addEventListener("click", async (e) => {
            const b = e.target.closest("[data-unskip]");
            if (!b)
                return;
            const exercise = decodeURIComponent(b.dataset.unskip);
            try {
                await todayApi("/sessions/skip", {
                    method: "DELETE", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ date: todayState.logDate, exercise }),
                });
            }
            catch {
                toast("Couldn't restore — try again");
                return;
            }
            swrInvalidate("today:session:" + todayState.logDate); // the session's skips changed
            toast(`${exercise} is back on`);
            renderToday(); // full refresh rebuilds the card in its plan position
        });
    }
}
// ---- Keep the adapted prescription in step with the sets being logged ----
// The per-lift "next up / hold / ease off" line (exRxLineHtml) is the visible proof
// the plan FOLLOWS what you logged — so it must not stay frozen at render-time after
// the first set. A full renderToday() only fires on the FIRST set of a previously-
// empty day; for every later set we instead REFRESH the prescription cheaply, in
// place. Debounced (rapid taps coalesce into one fetch) + best-effort: a failed fetch
// leaves the last paint, exactly like the initial progression load.
let _rxRefreshTimer = null;
function scheduleRxRefresh() {
    if (todayState.day == null)
        return; // a pure run/rest day has no per-lift progression
    if (_rxRefreshTimer != null)
        clearTimeout(_rxRefreshTimer);
    _rxRefreshTimer = setTimeout(() => { refreshAdaptedRx(); }, 600);
}
function invalidateTodayProgression() {
    if (todayState.day != null)
        swrInvalidate("program:progression:" + todayState.day);
}
async function refreshAdaptedRx() {
    if (todayState.tab !== "today" || todayState.day == null)
        return;
    const day = todayState.day, date = todayState.logDate;
    let list = null;
    try {
        list = await todayCachedApi("/program/progression?day=" + encodeURIComponent(day), {
            key: `program:progression:${day}`,
            freshFor: 15000,
        });
    }
    catch {
        return;
    } // calm: leave the last-painted prescription as-is
    // Bail if the surface moved out from under the in-flight fetch (tab/day/date change).
    if (todayState.tab !== "today" || todayState.day !== day || todayState.logDate !== date)
        return;
    if (!Array.isArray(list))
        return;
    const rxByEx = {};
    for (const rx of list) {
        if (rx && rx.exercise)
            rxByEx[String(rx.exercise).toLowerCase()] = rx;
    }
    // Re-render each lift card's prescription line in place. A now-complete card drops
    // its line (mirrors exCard's `!complete ? todayExRxLineHtml(rx)`); an active one shows the
    // freshly-adapted move.
    todayView.querySelectorAll(".ex[data-card]").forEach((card) => {
        const name = (card.dataset.card || "").toLowerCase();
        const rx = name ? rxByEx[name] || null : null;
        const complete = card.classList.contains("ex-complete");
        const existing = card.querySelector(".ex-rx");
        const html = complete ? "" : todayExRxLineHtml(rx);
        if (existing) {
            if (!html) {
                existing.remove();
                return;
            }
            const tpl = document.createElement("template");
            tpl.innerHTML = html.trim();
            existing.replaceWith(tpl.content.firstChild);
        }
        else if (html) {
            // No line yet (e.g. it was complete and a set was deleted, or the engine had
            // nothing earlier) — insert it where exCard places it: before the logged chips.
            const tpl = document.createElement("template");
            tpl.innerHTML = html.trim();
            const loggedWrap = card.querySelector("[data-logged]");
            if (loggedWrap)
                card.insertBefore(tpl.content.firstChild, loggedWrap);
        }
    });
    // Keep the at-a-glance "N lifts have new targets" banner honest: update its count or
    // hide it when nothing's left to apply. (We don't synthesize a missing banner mid-
    // session — that's a rare transition the first-set renderToday already covers.)
    const banner = todayView.querySelector(".rx-banner");
    if (banner) {
        const moves = todayRxMoveCount(rxByEx);
        if (moves === 0)
            banner.remove();
        else {
            const h = banner.querySelector(".rx-banner-h");
            if (h)
                h.textContent = `${moves === 1 ? "One lift has a new target" : `${moves} lifts have new targets`} from what you logged`;
        }
    }
    // The "what changed" digest reads the same engine — refresh it cheaply (its own
    // loader is null-safe + scoped to #adjustSlot, and degrades on its own).
    loadProgramAdjustmentsBanner();
}
// Log one set from a card's logrow; update the card inline without a full re-render.
function wireLogRow(row) {
    if (!row)
        return;
    const logBtn = row.querySelector(".logbtn");
    if (!logBtn || logBtn._wired)
        return;
    logBtn._wired = true;
    logBtn.addEventListener("click", async () => {
        if (logBtn.disabled)
            return;
        const timed = row.dataset.mode === "timed";
        let body;
        if (timed) {
            const durEl = row.querySelector(".in-dur");
            const sec = parseDur(durEl.value);
            if (sec == null || sec <= 0) {
                toast("Time? e.g. 1:30 or 90");
                durEl.focus();
                return;
            }
            durEl.value = fmtDur(sec); // normalise the display for the next tap
            body = {
                exercise: decodeURIComponent(row.dataset.ex),
                weight: null, reps: null, rir: null,
                duration_sec: sec, exercise_mode: "timed",
                day_number: Number(row.dataset.day),
                date: todayState.logDate,
            };
        }
        else {
            const wEl = row.querySelector(".in-w"), rEl = row.querySelector(".in-r"), rirEl = row.querySelector(".in-rir");
            const w = wEl.value, r = rEl.value, rir = rirEl.value;
            if (r === "") {
                toast("Reps?");
                rEl.focus();
                return;
            }
            body = {
                exercise: decodeURIComponent(row.dataset.ex),
                weight: w === "" ? null : Number(w),
                reps: Number(r),
                rir: rir === "" ? null : Number(rir),
                day_number: Number(row.dataset.day),
                date: todayState.logDate,
            };
        }
        logBtn.disabled = true;
        let res;
        try {
            res = await todayApi("/sets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        }
        catch {
            logBtn.disabled = false;
            toast("Couldn't log that set — check your connection.");
            return;
        }
        logBtn.disabled = false;
        if (!res || res.ok === false || res.error || res.id == null) {
            toast(res && res.error ? res.error : "Couldn't log that set.");
            return;
        }
        todayState.brief = null; // a logged set reshapes today — the next Today render re-reads the Brief
        // a logged set changes this date's session, the weekly stats, and the History
        // list — drop their SWR caches so every surface revalidates to truth.
        swrInvalidate("today:session:" + todayState.logDate);
        swrInvalidate("stats");
        swrInvalidate("history:sessions");
        swrInvalidate("progress:volume"); // muscle-group volume shifts too
        invalidateTodayProgression();
        // inline: append chip, tick progress, keep inputs populated for the next tap
        const card = row.closest(".ex");
        const loggedWrap = card.querySelector("[data-logged]");
        const tpl = document.createElement("template");
        tpl.innerHTML = setChip({ id: res.id, set_number: res.set_number, weight: res.weight, reps: res.reps, rir: res.rir, duration_sec: res.duration_sec ?? null }).trim();
        const chipEl = tpl.content.firstElementChild;
        if (!card || !loggedWrap || !chipEl)
            return;
        chipEl.classList.add("chip-in");
        loggedWrap.appendChild(chipEl);
        wireDeletes();
        bumpProgress(card);
        const skipCtl = card.querySelector(".ex-skip");
        if (skipCtl)
            skipCtl.remove(); // a logged set makes the card no longer skippable
        if (res.pr) {
            toast("🏆 New PR!");
            if (navigator.vibrate)
                navigator.vibrate([60, 40, 120]);
        }
        else
            toast("Set logged");
        startRest();
        // refreshFinishStat returns true when it fired a full re-render (first set of an
        // empty date) — that path already re-fetches progression + repaints every card, so
        // we only schedule the standalone, debounced prescription refresh otherwise. This
        // is what keeps the adapted "next up / hold / ease off" line in step with the sets.
        if (!refreshFinishStat())
            scheduleRxRefresh();
    });
}
function bumpProgress(card) {
    const prog = card.querySelector("[data-prog]");
    if (!prog)
        return;
    const done = card.querySelectorAll("[data-logged] .chip").length;
    const m = (prog.textContent.match(/\/\s*(\d+)/) || [])[1];
    const goal = m ? Number(m) : 0;
    prog.innerHTML = `${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span>`;
    const complete = goal && done >= goal;
    prog.classList.toggle("done", !!complete);
    card.classList.toggle("ex-complete", !!complete);
}
// Returns true iff it triggered a FULL re-render (first set of an empty date) — the
// caller skips the standalone prescription refresh in that case (renderToday already
// re-fetches progression and repaints every card, so a second fetch would be wasteful).
function refreshFinishStat() {
    const chips = todayView.querySelectorAll(".ex [data-logged] .chip");
    if (!chips.length)
        return false;
    const stat = todayView.querySelector("[data-finishstat]");
    if (!stat) {
        // first set on a previously empty date — re-render to bring in the FINISH block.
        // This is also where focus mode auto-engages (hasLoggedSets just flipped true),
        // so morph through a view transition: Today gently collapses into the focus todayView.
        withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
        return true;
    }
    let sets = 0, tonnage = 0;
    chips.forEach((c) => {
        sets++;
        const mm = c.textContent.match(/(-?\d+(?:\.\d+)?)\s*×\s*(\d+)/);
        if (mm) {
            const wt = Number(mm[1]), reps = Number(mm[2]);
            if (wt > 0)
                tonnage += wt * reps;
        }
    });
    const isToday = todayState.logDate === localISO();
    stat.textContent = `${sets} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + todayState.logDate}`;
    return false;
}
async function setupAddExercise() {
    const btn = todayView.querySelector("#addExBtn");
    const form = todayView.querySelector("#addExForm");
    const input = todayView.querySelector("#addExInput");
    const go = todayView.querySelector("#addExGo");
    const datalist = todayView.querySelector("#exOptions");
    if (!btn || !form)
        return;
    let mode = "reps";
    const modeWrap = todayView.querySelector("#addExMode");
    modeWrap.querySelectorAll("[data-exmode]").forEach((b) => b.addEventListener("click", () => {
        mode = b.dataset.exmode;
        modeWrap.querySelectorAll(".modebtn").forEach((x) => x.classList.toggle("active", x === b));
    }));
    const setMode = (m) => {
        mode = m;
        modeWrap.querySelectorAll(".modebtn").forEach((x) => x.classList.toggle("active", x.dataset.exmode === m));
    };
    btn.addEventListener("click", async () => {
        form.hidden = false;
        btn.hidden = true;
        input.focus();
        if (!datalist.children.length) {
            try {
                const exs = await todayApi("/exercises");
                todayState.exModes = Object.fromEntries((exs || []).map((e) => [e.name, e.mode || "reps"]));
                datalist.innerHTML = (exs || []).map((e) => `<option value="${escAttr(e.name)}">${escHtml(e.muscle_group || "")}</option>`).join("");
            }
            catch { /* free-typed names still work */ }
        }
    });
    // picking a known timed exercise flips the toggle automatically
    input.addEventListener("input", () => {
        const m = (todayState.exModes || {})[input.value.trim()];
        if (m)
            setMode(m);
    });
    function resetAddForm() { input.value = ""; form.hidden = true; btn.hidden = false; setMode("reps"); }
    const add = async () => {
        const name = (input.value || "").trim();
        if (!name) {
            input.focus();
            return;
        }
        // A card for this exercise already on the page. Match on name AND mode — so
        // re-adding "Dead hang" as Timed when only a Reps card exists is NOT swallowed.
        const existing = [...todayView.querySelectorAll(".ex[data-card]")]
            .find((el) => el.dataset.card.toLowerCase() === name.toLowerCase());
        if (existing) {
            const curMode = existing.dataset.mode || "reps";
            const hasSets = !!existing.querySelector(".logged .chip");
            if (curMode === mode || hasSets) {
                // same type, or it already has logged sets (can't switch type underfoot) —
                // just bring the card into todayView. Tell them how to change a type that's locked.
                existing.scrollIntoView({ behavior: "smooth", block: "center" });
                (existing.querySelector(".in-r") || existing.querySelector(".in-dur"))?.focus();
                resetAddForm();
                if (curMode !== mode && hasSets)
                    toast(`${name} already has sets — delete them to change its type`);
                return;
            }
            // type change requested on an empty card → flip the exercise's mode + swap the
            // card to the new type in place (keeps it on the page, ready to log).
            try {
                await postExerciseMode(name, mode);
                (todayState.exModes ??= {})[name] = mode;
            }
            catch { /* fall through — the set itself still carries exercise_mode */ }
            const tpl = document.createElement("template");
            tpl.innerHTML = exCard({ exercise: name, fromPlan: false, mode }, [], { weight: null, reps: null, rir: null, duration_sec: null }, null, null).trim();
            const fresh = tpl.content.firstElementChild;
            if (!fresh)
                return;
            existing.replaceWith(fresh);
            wireGuides(fresh);
            wireLogRow(fresh.querySelector(".logrow"));
            wireSkips();
            fresh.scrollIntoView({ behavior: "smooth", block: "center" });
            (fresh.querySelector(".in-dur") || fresh.querySelector(".in-r"))?.focus();
            resetAddForm();
            return;
        }
        // typed a name that's sitting in today's skipped line → restore it instead
        const skippedBtn = [...todayView.querySelectorAll("#skipLine [data-unskip]")]
            .find((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase());
        if (skippedBtn) {
            resetAddForm();
            skippedBtn.click();
            return;
        }
        if (mode === "timed" && (todayState.exModes || {})[name] !== "timed") {
            // register the exercise as timed so logging + history know its mode
            try {
                await postExerciseMode(name, "timed");
                (todayState.exModes ??= {})[name] = "timed";
            }
            catch { /* fall through — the set itself still carries exercise_mode */ }
        }
        appendOffPlanCard(name, mode);
        resetAddForm();
    };
    go.addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter")
        add(); });
}
async function appendOffPlanCard(name, mode) {
    // Remember it in state (keyed by date) so a re-render rebuilds it instead of dropping
    // it — an unlogged off-plan card otherwise lives only in the DOM. Deduped by name.
    (todayState.pendingOffPlan ??= {});
    const list = (todayState.pendingOffPlan[todayState.logDate] ??= []);
    if (!list.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        list.push({ name, mode: mode || "reps" });
    let prefill = { weight: null, reps: null, rir: null, duration_sec: null };
    try {
        const last = await todayApi("/last-set?exercise=" + encodeURIComponent(name));
        if (last)
            prefill = { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
    }
    catch { }
    const tpl = document.createElement("template");
    tpl.innerHTML = exCard({ exercise: name, fromPlan: false, mode: mode || null }, [], prefill, null, null).trim();
    const cardEl = tpl.content.firstElementChild;
    if (!cardEl)
        return;
    // .addex lives inside .plansurface — insert relative to its real parent
    // (insertBefore requires the ref node to be a direct child of the caller).
    const addBlock = todayView.querySelector(".addex");
    if (addBlock)
        addBlock.before(cardEl);
    else
        (todayView.querySelector(".plansurface") || todayView).appendChild(cardEl);
    wireGuides(cardEl);
    wireLogRow(cardEl.querySelector(".logrow"));
    wireSkips(); // wire the off-plan card's remove ✕
    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
    (cardEl.querySelector(".in-r") || cardEl.querySelector(".in-dur"))?.focus();
}
// Today: the "body's reaction" card for a strength session reconciled from Garmin —
// HR / calories / training-effect tiles + a time-in-HR-zone bar + the agent's
// one-line read. All server strings via escHtml; numbers coerced. "" without data.
function garminSessionCard(g) {
    return CairnTodayLately.garminSessionCard(g);
}
// ---------- Today: the unified "Lately" feed ----------
// One timeline of what you actually did — finished strength sessions AND cardio
// merged (the old "Recent" strip read only the activities table, so it was blind
// to lifting). Each row carries a real relative time, and a Garmin-synced row taps
// open to its body-reaction (HR zones, effort, VO2, temp) — the same physiology a
// strength session already shows. Fed by GET /api/recent-training (FeedRow[]).
// One row of the Lately feed — strength or cardio, normalized.
function latelyRow(row) {
    return CairnTodayLately.rowHtml(row);
}
async function loadRecentActivities() {
    const wrap = todayView.querySelector("#qlRecent");
    if (!wrap)
        return;
    let rows = [];
    try {
        rows = await todayApi("/recent-training?limit=6");
    }
    catch {
        rows = [];
    }
    if (todayState.tab !== "today" || !wrap.isConnected)
        return;
    if (!rows || !rows.length) {
        wrap.innerHTML = "";
        return;
    }
    wrap.innerHTML =
        `<div class="lately-h"><span class="ql-recent-h lbl">Lately</span>` +
            `<button class="lately-all lbl" id="latelyAll" type="button">see all →</button></div>` +
            rows.map(latelyRow).join("");
    const allBtn = wrap.querySelector("#latelyAll");
    if (allBtn)
        allBtn.addEventListener("click", () => activateTab("progress")); // lands on History
    wrap.querySelectorAll('.lately-head[role="button"]').forEach((h) => {
        const toggle = () => {
            const r = h.closest(".lately-row");
            const det = r && r.querySelector(".lately-detail");
            if (!det)
                return;
            const open = det.hidden;
            det.hidden = !open;
            r.classList.toggle("lately-open", open);
            h.setAttribute("aria-expanded", open ? "true" : "false");
        };
        h.addEventListener("click", toggle);
        h.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggle();
            }
        });
    });
}
// Today: slim Garmin wearable strip under the compass — steps · sleep · resting
// HR (· HRV) from the most recent garmin_daily_metrics row. Renders nothing at
// all unless that row is from today or yesterday, so non-Garmin users (and the
// past-date view) see zero clutter. Values are numeric — server text never
// reaches innerHTML here.
async function loadWearable(isToday) {
    const slot = todayView.querySelector("#wearStrip");
    if (!slot || !isToday)
        return;
    let rows = [];
    try {
        rows = await todayApi("/garmin/daily?limit=1");
    }
    catch {
        return;
    }
    if (todayState.tab !== "today" || !slot.isConnected)
        return;
    const m = Array.isArray(rows) ? rows[0] : null;
    if (!m || !m.date)
        return;
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    if (m.date !== localISO() && m.date !== localISO(yest))
        return;
    const cells = [];
    if (m.steps != null) {
        cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Number(m.steps) || 0}" data-cufmt="k">0</span><span class="wear-l lbl">steps</span></span>`);
    }
    if (m.sleep_min != null) {
        const v = Math.max(0, Math.round(Number(m.sleep_min) || 0));
        const score = m.sleep_score != null ? ` · ${Math.round(Number(m.sleep_score))}` : "";
        cells.push(`<span class="wear-cell"><span class="wear-n numeral">${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}</span><span class="wear-l lbl">sleep${score}</span></span>`);
    }
    if (m.resting_hr != null) {
        cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.resting_hr)) || 0}">0</span><span class="wear-l lbl">rest hr</span></span>`);
    }
    if (m.hrv_ms != null && cells.length < 4) {
        cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.hrv_ms)) || 0}">0</span><span class="wear-l lbl">hrv</span></span>`);
    }
    if (m.body_battery_avg != null && cells.length < 4) {
        cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.body_battery_avg)) || 0}">0</span><span class="wear-l lbl">battery</span></span>`);
    }
    if (!cells.length)
        return;
    slot.innerHTML = `<div class="wearstrip reveal" style="${stagger(0)}">
      <span class="wear-kicker lbl">Garmin${m.date !== localISO() ? " · yest" : ""}</span>
      ${cells.join("")}
    </div>`;
    runCountUps(slot);
}
// Today: a one-line pointer to the day's planned meals — deliberately quiet
// (the full planner lives in Plan → Meals; this is just the shortcut there).
async function loadTableHint() {
    const wrap = todayView.querySelector("#tableHint");
    if (!wrap)
        return;
    let plans = [];
    try {
        plans = await todayApi("/mealplans?limit=6");
    }
    catch {
        return;
    }
    if (todayState.tab !== "today" || !wrap.isConnected)
        return;
    const p = (plans || []).find((x) => x.status === "accepted" && x.parsed) ||
        (plans || []).find((x) => x.status === "draft" && x.parsed);
    const parsed = p?.parsed;
    const days = parsed && Array.isArray(parsed.days) ? parsed.days : [];
    const lbl = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(todayState.logDate + "T12:00:00").getDay()];
    const day = days.find((d) => String(d.day || "").toLowerCase().startsWith(lbl));
    const meals = day && Array.isArray(day.meals) ? day.meals : [];
    if (!meals.length)
        return;
    const first = meals[0].name || meals[0].meal || "";
    wrap.innerHTML = `<button class="tablehint" id="tableHintBtn">
      <span class="lbl">Table</span> ${escHtml(first)}${meals.length > 1 ? `<span class="tablehint-more"> +${meals.length - 1}</span>` : ""}<span class="tablehint-go">→</span>
    </button>`;
    wrap.querySelector("#tableHintBtn").addEventListener("click", () => { todayState.planJump = "meals"; activateTab("plan"); });
}
// Today context/goal/health rail markup lives in /js/today-context-client.js.
// This screen keeps API loading, slot liveness checks, and navigation wiring.
async function loadContextBanner() {
    const wrap = todayView.querySelector("#ctxEvents");
    if (!wrap)
        return;
    let events = [];
    try {
        events = await todayApi("/context-events?active=1");
    }
    catch {
        events = [];
    }
    if (todayState.tab !== "today" || !wrap.isConnected)
        return;
    wrap.innerHTML = CairnTodayContext.contextBannerHtml(events);
}
// Today: react to agentic work — a quiet card when the coach has drafted a plan
// change waiting for review (a scheduler weekly-review draft, or a chat plan change).
// Pull, never push: it only appears when a `draft` proposal exists and clears the
// moment it's applied/discarded in Plan → Coach. Tapping jumps straight there.
async function loadDraftProposals() {
    const slot = todayView.querySelector("#draftSlot");
    if (!slot)
        return;
    let plans = [];
    try {
        plans = await todayApi("/proposals?limit=8");
    }
    catch {
        return;
    }
    if (todayState.tab !== "today" || !slot.isConnected)
        return;
    const drafts = (plans || []).filter((p) => p && p.status === "draft");
    if (!drafts.length) {
        slot.innerHTML = "";
        return;
    }
    const head = drafts.length > 1 ? `${drafts.length} plan changes are waiting` : "A plan change is waiting";
    const raw = String(drafts[0].instruction || "").replace(/^(auto|chat):\s*/i, "").trim();
    const sub = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "Drafted by your coach";
    slot.innerHTML = `<button class="draft-card reveal" id="draftCard" style="--i:0" type="button">
      <span class="draft-ico" aria-hidden="true">✦</span>
      <span class="draft-body">
        <span class="draft-h">${escHtml(head)}</span>
        <span class="draft-sub">${escHtml(sub)} · review</span>
      </span>
      <span class="draft-go" aria-hidden="true">→</span>
    </button>`;
    slot.querySelector("#draftCard").addEventListener("click", () => { todayState.planJump = "coach"; activateTab("plan"); });
}
// Today rail: a calm "today's fuel" glance — what's logged today + (only when a
// real target exists) a gentle "remaining". Never a score, "remaining" not
// "consumed", never red. Capture stays in Chat — this card is purely a REVIEW that
// taps through to the full editable day (Plan → Food).
//
// The fuel surface is an EVALUATION glance, NEVER a "log something" prompt: over
// time people log food less and just evaluate occasionally as the habit builds, so
// an empty day surfaces NOTHING here (the salience arbiter already omits the `fuel`
// candidate when count <= 0). This function is only ever called with logged food;
// it returns "" defensively if handed an empty day so no capture nudge can render.
function fuelCardHtml(d) {
    return window.CairnTodayAgenda.fuelCardHtml(d);
}
async function loadFuelToday(date) {
    const slot = todayView.querySelector("#fuelSlot");
    if (!slot)
        return;
    let d = null;
    try {
        d = await todayApi(`/nutrition/day?date=${encodeURIComponent(date || todayState.logDate)}`);
    }
    catch {
        return;
    }
    if (todayState.tab !== "today" || !slot.isConnected)
        return;
    // Empty / nothing logged → render nothing (no capture prompt — capture is Chat-only).
    if (!d || typeof d !== "object" || !(Number(d.count) > 0)) {
        slot.innerHTML = "";
        return;
    }
    slot.innerHTML = fuelCardHtml(d);
    const card = slot.querySelector("#fuelCard");
    // The card only renders with logged food now, so it always taps through to the
    // editable day review (Plan → Food) — never into a "log something" chat prompt.
    if (card)
        card.addEventListener("click", () => { todayState.planJump = "food"; activateTab("plan"); });
    runCountUps(slot);
}
// Today: a calm "week ahead" sketch. Rendering lives in
// /js/today-week-ahead-client.js; this screen keeps API loading and slot wiring.
async function loadWeekAhead() {
    const slot = todayView.querySelector("#weekAheadSlot");
    if (!slot)
        return;
    let r = null;
    try {
        r = await todayApi("/week-ahead");
    }
    catch {
        return;
    }
    if (todayState.tab !== "today" || !slot.isConnected)
        return;
    slot.innerHTML = CairnTodayWeekAhead.cardHtml(r);
}
// Today rail: a calm, self-explaining "what changed" card — the handful of
// adaptations the program engine noticed (a lift to push/deload, a group that's
// due, a missing pattern). Each row TAPS OPEN in place to reveal the plain-words
// WHY plus concrete movements to do about it ("Try Back Squat · Walking Lunge")
// and a "Plan it →" that hands the coach a tailored request (a DRAFT proposal,
// never auto-applied). So the athlete sees WHAT changed, WHY, and HAS something to
// do. The card is ACUTE-recovery aware: a group you just torched (a long ride/run
// or a heavy session) is held back and reframed ("Quads — recovering"), never put
// up as the next move. "+N more" expands the rest IN PLACE (no yank to a charts
// screen); the header "My plan →" opens the actual plan. Pull, never push: it waits
// quietly and renders NOTHING when there's nothing to say. Best-effort + null-safe.
// Today program-adjustment rail markup lives in /js/today-program-adjustments-client.js.
// This screen keeps API loading, tab navigation, and expand/collapse wiring.
async function loadProgramAdjustmentsBanner() {
    const slot = todayView.querySelector("#adjustSlot");
    if (!slot)
        return;
    let rows = null;
    try {
        rows = await todayApi("/program/adjustments");
    }
    catch {
        rows = null;
    }
    if (todayState.tab !== "today" || !slot.isConnected)
        return;
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) {
        slot.innerHTML = "";
        return;
    }
    const more = CairnTodayProgramAdjustments.extraCount(rows);
    slot.innerHTML = CairnTodayProgramAdjustments.bannerHtml(rows);
    const card = slot.querySelector(".adjust-card");
    if (!card)
        return;
    card.addEventListener("click", (e) => {
        const act = e.target.closest(".adjust-act");
        if (act) {
            todayState.chatPrefill = act.getAttribute("data-req") || "";
            activateTab("chat");
            return;
        }
        // "My plan →" opens the actual plan (where changes land), not the charts/history.
        if (e.target.closest("#adjustAll")) {
            activateTab("plan");
            return;
        }
        // "+N more" / "Show less" reveals the rest of the adaptations IN PLACE.
        const moreBtn = e.target.closest("#adjustMore");
        if (moreBtn) {
            const open = card.classList.toggle("adjust-open");
            moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
            moreBtn.textContent = open ? "Show less" : `+${more} more in your program`;
            return;
        }
        const item = e.target.closest(".adjust-item");
        if (item) {
            const open = item.getAttribute("aria-expanded") === "true";
            item.setAttribute("aria-expanded", open ? "false" : "true");
            const detail = item.parentElement.querySelector(".adjust-detail");
            if (detail)
                detail.hidden = open;
        }
    });
}
// Today: one quiet health-focus line from the latest whole-picture review (first
// focus title + action), mirroring the context banner. Tap → Me → Health.
// Renders nothing when there's no review or no focus items — zero noise.
async function loadHealthFocusBanner() {
    const wrap = todayView.querySelector("#ctxHealth");
    if (!wrap)
        return;
    // ONE coach voice on Today: lead with the whole-picture synthesis's single lever (the
    // most holistic, connected line — "trimming body fat lifts lipids, glucose & T at once"),
    // else the prioritized focus LEAD (freshness-aware + capped server-side, so a stale CRP
    // or an empty bucket never leads). Both are pull artifacts; /health/synthesis carries
    // BOTH in one call. Taps through to Me → Health → Read where the full picture lives.
    let data = null;
    try {
        data = await todayApi("/health/synthesis");
    }
    catch {
        data = null;
    }
    if (todayState.tab !== "today" || !wrap.isConnected)
        return;
    wrap.innerHTML = CairnTodayContext.healthFocusBannerHtml(data);
    if (!wrap.innerHTML)
        return;
    wrap.querySelector("#ctxHealthGo").addEventListener("click", () => {
        // the synthesis + connected-brain focus now live on Health → Read
        todayState.meSeg = "health";
        todayState.healthSeg = "read";
        todayState.healthSegPicked = true;
        activateTab("me");
    });
}
// Today: a calm "Garmin logged a lift that isn't in Cairn yet — reconcile?" card.
// Pull, never push: it waits quietly when the watch synced a strength activity that
// hasn't been linked to a session (session_id null), and renders NOTHING otherwise —
// so it never appears unless Garmin is configured AND there's an unlinked lift. The
// single Reconcile action runs the deterministic physiology merge (POST /garmin/
// reconcile), then refreshes Today so the reconciled garminSessionCard / Lately row
// replaces this. Degrades silently: a failed fetch → empty slot.
async function loadGarminReconcile() {
    await CairnTodayGarminReconciliation.load({
        root: todayView,
        date: todayState.logDate,
        isCurrentToday: () => todayState.tab === "today",
        api: todayApi,
        escapeHtml: escHtml,
        toast,
        invalidate: swrInvalidate,
        refreshToday: renderToday,
    });
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

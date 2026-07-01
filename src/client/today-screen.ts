// ==== 03-today.js ====
// ---------- Today ----------
// ---------- Adaptive next-prescription (the loop closes here) ----------
// On a lift card, render the NEXT session's adapted target straight from the
// deterministic progression engine (GET /api/program/progression). It reads what
// you actually logged + the lift's trend and proposes one calm move — overload /
// hold / deload / rotate a variation / +seconds — with a plain-words "why". NEVER a
// score; the server hands us finished plain words (delta_text + why), we just frame
// them. The whole day's prescriptions become a DRAFT plan proposal via the apply
// control in the session head — nothing auto-applies.
type TodayScreenApiResponse<Path extends string> = import("../contracts/client.js").ClientApiResponse<Path>;
type TodayScreenCachedApiOptions<T> = { key?: string; freshFor?: number; onUpgrade?: (data: T, meta: { changed: boolean }) => void };
type TodayScreenSwrPeek<T> = { data: T; fresh: boolean };
type TodayScreenDayRead = import("../contracts/client.js").ClientDayRead & { _provisional?: boolean; override?: string | null };
type TodayScreenPlanItem = import("../contracts/client.js").ClientPlanItem & {
  fromPlan?: boolean;
  muscle_group?: string | null;
  target_distance_km?: number | null;
  target_duration_min?: number | null;
  target_zone?: string | null;
};
type TodayScreenPlanDay = {
  id?: number;
  day_number: number;
  name: string;
  focus?: string | null;
  items: TodayScreenPlanItem[];
  [key: string]: unknown;
};
type TodayScreenLoggedSet = import("../contracts/client.js").ClientLoggedSet;
type TodayScreenTrainingSession = import("../contracts/client.js").ClientTrainingSession & {
  plan_day_id?: number | null;
  skips?: unknown[];
};
type TodayScreenCardioEffort = import("../contracts/client.js").ClientCardioEffort;
type TodayScreenPrescription = import("../contracts/client.js").ClientPrescription;
type TodayScreenPrescriptionByExercise = Record<string, TodayScreenPrescription | null | undefined>;
type TodayScreenExercise = import("../contracts/client.js").ClientExercise;
type TodayScreenProfile = import("../contracts/client.js").ClientProfile;
type TodayScreenWeeklyStats = import("../contracts/client.js").ClientWeeklyStats & {
  goal_mode?: string | null;
  goal_weight_lb?: number | null;
  goal_date?: string | null;
};
type TodayScreenAgenda = import("../contracts/client.js").ClientTodayAgenda;
type TodayScreenDayIntake = import("../contracts/client.js").ClientDayIntake;
type TodayState = Omit<typeof state, "brief" | "_briefInflight" | "exModes" | "pendingOffPlan" | "plan"> & {
  tab?: string;
  logDate: string;
  day: number | null;
  plan: TodayScreenPlanDay[];
  exModes: Record<string, string>;
  focus?: { date: string; on: boolean } | null;
  brief?: { date: string; override: string; read: TodayScreenDayRead } | null;
  _briefInflight?: { date: string; override: string; promise: Promise<TodayScreenDayRead> } | null;
  _briefMorph?: boolean;
  planJump?: string;
  chatPrefill?: string;
  pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
  meSeg?: string;
  healthSeg?: string;
  healthSegPicked?: boolean;
  [key: string]: unknown;
};
type TodayScreenSideLoaderDeps = {
  root: ParentNode;
  state: TodayState;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  activateTab(tab: string): unknown;
  runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
  escapeHtml(value: unknown): string;
  localISO(date?: Date): string;
  stagger(index?: number | null): string;
};
type TodayScreenSideLoaders = {
  garminSessionCard(value: unknown): string;
  loadWearable(isToday: unknown, deps: TodayScreenSideLoaderDeps): Promise<void>;
  loadTableHint(deps: TodayScreenSideLoaderDeps): Promise<void>;
  loadContextBanner(deps: TodayScreenSideLoaderDeps): Promise<void>;
  loadDraftProposals(deps: TodayScreenSideLoaderDeps): Promise<void>;
  loadHealthFocusBanner(deps: TodayScreenSideLoaderDeps): Promise<void>;
};
type TodayScreenSessionSuggestDeps = Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[1];
type TodayScreenSessionSuggestAskOptions = Parameters<Window["CairnTodaySessionSuggestController"]["askForSession"]>[0];

function todayApi<Path extends string>(
  path: Path,
  opts?: RequestInit & { headers?: Record<string, string> },
): Promise<TodayScreenApiResponse<Path>> {
  return api(path, opts);
}

function todayCachedApi<Path extends string>(
  path: Path,
  opts?: TodayScreenCachedApiOptions<TodayScreenApiResponse<Path>>,
): Promise<TodayScreenApiResponse<Path>> {
  return cachedApi(path, opts);
}

function todayPeekCached<T = unknown>(key: string, freshFor?: number): TodayScreenSwrPeek<T> | null {
  return peekCached<T>(key, freshFor);
}

const todayState = state as TodayState;
const todayView = view as HTMLElement & any;
const todaySideLoaders = (globalThis as unknown as { CairnTodaySideLoaders: TodayScreenSideLoaders }).CairnTodaySideLoaders;
const todayPlanSessionPreparation = (globalThis as unknown as {
  CairnTodayPlanSessionPreparation: TodayPlanSessionPreparationApi;
}).CairnTodayPlanSessionPreparation;
const todayDataLoader = (globalThis as unknown as {
  CairnTodayDataLoader: Window["CairnTodayDataLoader"];
}).CairnTodayDataLoader;

function todaySideLoaderDeps(): TodayScreenSideLoaderDeps {
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

// The per-card prescription line. `rx` is one Prescription from the progression
// engine (or null → renders nothing). Calm, no score, one move + its why. When the
// move is "switch it up" (action:'vary'), the engine hands a small menu of same-
// pattern swaps that the card renderer frames as a quiet choice.
function todayExRxLineHtml(rx: TodayScreenPrescription | null | undefined) {
  return CairnTodayTraining.exRxLineHtml(rx);
}

// How many of a day's prescriptions are an actual MOVE (not a plain hold) — drives
// the "apply these" affordance copy + whether it shows at all.
function todayRxMoveCount(rxByEx: TodayScreenPrescriptionByExercise) {
  return CairnTodayTraining.rxMoveCount(rxByEx);
}

// "Apply these to my plan" — sends the whole day's adapted targets through the
// propose→apply path (POST /api/program/progression/apply {day}), which lands a
// DRAFT plan proposal for review. Nothing auto-applies; we deep-link into Plan →
// Coach where the draft is reviewed/applied, mirroring loadDraftProposals. Calm,
// honest degradation: an unreachable / not-yet-wired endpoint restores the button.
async function applyDayProgression(btn: Element | null | undefined, day: number | null | undefined) {
  if (day == null) return;
  const restore = btnBusy(btn, "Drafting…");
  let r = null;
  try {
    r = await todayApi("/program/progression/apply", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ day }),
    });
  } catch { restore(); toast("Couldn't draft that — check your connection."); return; }
  if (!r || r.ok === false) { restore(); toast("Couldn't draft that just now — try again in a bit."); return; }
  // A fresh draft is waiting in Plan → Coach — drop the caches that surface it.
  swrInvalidate("plan:coach");
  swrInvalidate("plan:proposals");
  toast("Drafted — review it in your Plan");
  todayState.planJump = "coach";
  activateTab("plan");
}

function exCard(
  it: TodayScreenPlanItem,
  logged: TodayScreenLoggedSet[],
  prefill: Record<string, unknown>,
  revealIdx: number | null | undefined,
  rx: TodayScreenPrescription | null | undefined,
) {
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
function cardioPlanCard(
  it: TodayScreenPlanItem,
  revealIdx: number | null | undefined,
  done: TodayScreenCardioEffort | null | undefined,
  syncline: string,
) {
  return CairnTodayCards.cardioPlanCardHtml(it, revealIdx, done as Record<string, unknown> | null | undefined, syncline);
}

// Does a synced cardio effort satisfy a planned cardio item? The bar is deliberately
// low (per spec): a compatible-type effort logged today is enough to call the
// prescription done — a runner's plan day is "did a run happen?", not an exact-match
// audit. Compatibility falls back to "any endurance effort" when neither side names a
// recognizable verb (so a generic activity still flips a generic cardio prescription).
function cardioEffortMatches(it: TodayScreenPlanItem, eff: TodayScreenCardioEffort | null | undefined) {
  return CairnTodayCards.cardioEffortMatches(it, eff as Record<string, unknown> | null | undefined);
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
function postExerciseMode(name: string, mode: string) {
  return todayApi("/exercises", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mode }) });
}

async function suggestedPlanDayNumber(session: TodayScreenTrainingSession | null | undefined, isToday: boolean): Promise<number> {
  return CairnTodayPlanSelection.suggestedPlanDayNumber(session, isToday, {
    state: todayState,
    api: todayApi,
  });
}

// ---------- The Brief (day-read) ----------
// Pure Brief markup lives in /js/today-brief-client.js. Stateful fetch/cache,
// steer-job, reconnect, and focus-mode wiring live in /js/today-brief-controller.js.
function todayBriefDeps(): ClientTodayBriefControllerDeps {
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
    loadTrainingProvenance: (isToday?: boolean) => loadTrainingProvenance(isToday),
    revealPlanThen,
    revealSessionComposer,
    askForSession,
  };
}

async function loadBrief(date: string, override: string, opts: { fast?: boolean } = {}): Promise<TodayScreenDayRead> {
  return CairnTodayBriefController.loadBrief(date, override, todayBriefDeps(), opts) as Promise<TodayScreenDayRead>;
}

async function upgradeBriefInPlace(date: string, isToday: boolean) {
  await CairnTodayBriefController.upgradeBriefInPlace(date, isToday, todayBriefDeps());
}

async function reshapeToday() {
  await CairnTodayBriefController.reshapeToday(todayBriefDeps());
}

function briefHtml(
  read: (Partial<TodayScreenDayRead> & { _provisional?: unknown; override?: unknown }) | null | undefined,
  { showPlan, hasPlanDay, isToday }: { showPlan?: unknown; hasPlanDay?: unknown; isToday?: unknown },
): string {
  return CairnTodayBriefController.briefHtml(read, { showPlan, hasPlanDay, isToday }, todayBriefDeps());
}

function focusEngaged(
  date: unknown,
  { showPlan, hasLoggedSets, isToday }: { showPlan?: unknown; hasLoggedSets?: unknown; isToday?: unknown },
): boolean {
  return CairnTodayBriefController.focusEngaged(date, { showPlan, hasLoggedSets, isToday }, todayBriefDeps());
}

function setFocus(date: string, on: boolean): void {
  CairnTodayBriefController.setFocus(date, on, todayBriefDeps());
}

function focusBarHtml(
  read: Partial<TodayScreenDayRead> | null | undefined,
  day: { name?: unknown } | null | undefined,
  { exDone, exTotal, isToday }: { exDone?: unknown; exTotal?: unknown; isToday?: boolean },
): string {
  return CairnTodayBriefController.focusBarHtml(read, day, { exDone, exTotal, isToday });
}

function briefSignalsText(read: Partial<TodayScreenDayRead> | null | undefined): string {
  return CairnTodayBriefController.briefSignalsText(read);
}

function todaySessionSuggestDeps(): TodayScreenSessionSuggestDeps {
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

function reconnectSessionSuggest(job?: unknown) {
  return CairnTodaySessionSuggestController.reconnectSessionSuggest(job, todaySessionSuggestDeps());
}

function revealSessionComposer() {
  CairnTodaySessionSuggestController.revealSessionComposer(todaySessionSuggestDeps());
}

async function askForSession(opts: TodayScreenSessionSuggestAskOptions = {}) {
  await CairnTodaySessionSuggestController.askForSession(opts, todaySessionSuggestDeps());
}

// Reveal the plan/logging surface for the selected date, then run `after` once the
// surface exists in the DOM. If it's already shown, run immediately.
function revealPlanThen(after: (() => unknown) | null | undefined, opts: { blank?: boolean } = {}) {
  if (todayView.querySelector(".addex")) { after && after(); return; }
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

async function renderToday(opts: any = {}) {
  const todayData = await todayDataLoader.load(opts, {
    root: todayView,
    state: todayState,
    api: todayApi as (path: string) => Promise<unknown>,
    cachedApi: todayCachedApi as (path: string, opts?: TodayScreenCachedApiOptions<unknown>) => Promise<unknown>,
    peekCached: todayPeekCached,
    localISO,
    todaySkeleton,
    setTodayHeaderTitle,
    nextPollToken: () => ++pollToken,
  });
  const { soft, isToday } = todayData;
  const session: any = todayData.session;
  const {
    day,
    loggedByEx,
    cardioEfforts,
    todaySettings,
    matchedCardio,
    activeItems,
    skippedItems,
    cardioItems,
    strengthItems,
    planEx,
    offPlanEx,
    pendingOffPlan,
    lastSets,
    rxByEx,
    rxFor,
    prefillFor,
    exDone,
    exTotal,
    hasSyncedCardioToday,
    isRunDay,
    expectingRun,
  } = await todayPlanSessionPreparation.preparePlanSession({
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

  const [stats, profile, exercises]: any[] = [todayData.stats, todayData.profile, todayData.exercises];
  if (profile) { setDiscipline(profile.primary_discipline); setEnduranceGoalSet(!!profile.endurance_goal_json); } // keep the emphasis globals warm for Progress/Today/Plan
  // exercise → mode map ('reps'|'timed'), used by exCard + the add-exercise flow
  todayState.exModes = Object.fromEntries((exercises || []).map((e: any) => [e.name, e.mode || "reps"]));
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
  const syncline = cardioItems.length ? cardioSyncLine(todaySettings as Record<string, unknown> | null | undefined, { expectingRun }) : "";

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
  const agendaGeneric: any[] = []; // generic Era-2 cards we drew (wired after the write)
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
  } else if (showPlan) {
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
      } else {
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
    if (hasGarmin) html += garminSessionCard(session.garmin);

    let cardIdx = 0;
    // The sync-freshness line rides on the first UNMATCHED cardio card (where a runner
    // looks to trust this morning's mileage). A matched run is already "done" — no line.
    let syncLineUsed = false;
    // On a run/mixed day float the cardio prescription(s) to the top of the surface so
    // the run is the hero, not the tail. A pure lifting day preserves plan order.
    const surfaceItems = (isRunDay || cardioItems.length > 1 || (cardioItems.length && strengthItems.length))
      ? [...activeItems.filter(isCardioItem), ...activeItems.filter((it: any) => !isCardioItem(it))]
      : activeItems;
    for (const it of surfaceItems) {
      // A planned cardio effort is a prescription + a "log this" affordance (it routes
      // through the free-text capture), not the set-by-set logger. A matched synced run
      // flips it to a calm "done" card; an unmatched one keeps the prescription + a
      // quiet "or it'll sync from your watch" fallback and (once) the freshness line.
      if (isCardioItem(it)) {
        const matched = matchedCardio.get(it) || null;
        const line = (!matched && !syncLineUsed) ? syncline : "";
        if (line) syncLineUsed = true;
        html += cardioPlanCard(it, cardIdx++, matched, line);
        continue;
      }
      const exerciseName = String(it.exercise || "");
      html += exCard({ ...it, fromPlan: true }, loggedByEx[exerciseName] || [], prefillFor(it), cardIdx++, rxFor(exerciseName));
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
    html += CairnTodaySessionStatus.skipLineHtml(skippedItems.map((it: any) => (isCardioItem(it) ? cardioLabel(it) : it.exercise)));
    html += `</div>`; // .plansurface
  }

  // ---- Trajectory tier (this week), quiet, below the fold — hidden in focus ----
  if (!focus) {
    html += `${todayCompass.paceOfferHtml}
    <details class="weekfold" id="weekFold">
      <summary class="weekfold-sum"><span class="lbl">This week</span>${todayCompass.weekRecap ? `<span class="weekfold-recap">${escHtml(todayCompass.weekRecap)}</span>` : ""}<span class="weekfold-chev" aria-hidden="true">▾</span></summary>
      <div class="statstrip statstrip-compass">
        ${todayCompass.cellsHtml}
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
      if (main && typeof renderPhoneCoachBanner === "function") renderPhoneCoachBanner(main);
    } catch {}
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
function sessionDoneCard(session: any, day: any, { isToday }: any) {
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

function wireLogRow(row: Element | null | undefined) {
  CairnTodaySessionController.wireLogRow(row, todaySessionDeps());
}

function wireSkips() {
  CairnTodaySessionController.wireSkips(todaySessionDeps());
}

function wireBrief(read: any, { isToday }: any) {
  CairnTodayBriefController.wireBrief(read, { isToday }, todayBriefDeps());
}

function reconnectDayReadOverride(job: any) {
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

async function appendOffPlanCard(name: any, mode: any) {
  await CairnTodayAddExerciseController.appendOffPlanCard(name, mode, todayAddExerciseDeps());
}

function garminSessionCard(g: any) {
  return todaySideLoaders.garminSessionCard(g);
}

async function loadWearable(isToday: any) {
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

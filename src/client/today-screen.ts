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
const todayMainShell = (globalThis as unknown as {
  CairnTodayMainShell: Window["CairnTodayMainShell"];
}).CairnTodayMainShell;
const todayPlanSurface = (globalThis as unknown as {
  CairnTodayPlanSurface: Window["CairnTodayPlanSurface"];
}).CairnTodayPlanSurface;
const todayPlanSurfaceRenderer = (globalThis as unknown as {
  CairnTodayPlanSurfaceRenderer: Window["CairnTodayPlanSurfaceRenderer"];
}).CairnTodayPlanSurfaceRenderer;
const todayRenderState = (globalThis as unknown as {
  CairnTodayRenderState: TodayRenderStateApi;
}).CairnTodayRenderState;

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
    skipLineHtml: (labels: string[]) => CairnTodaySessionStatus.skipLineHtml(labels),
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
  // Non-blocking Brief: fetch the read in FAST mode — the endpoint returns a warm
  // cached read instantly, so the common case is immediate; a cold cache resolves
  // to a provisional read (painted with the .is-thinking filament) and the real
  // agentic read swaps in via upgradeBriefInPlace() once it lands. First paint
  // never waits on agent:"auto". (Honors an active override.)
  const briefOverride = todayState.brief && todayState.brief.date === todayState.logDate ? todayState.brief.override : "";
  const read = await loadBrief(todayState.logDate, briefOverride, { fast: true });
  const {
    hasLoggedSets,
    hasPlanDay,
    hasGarmin,
    showPlan,
    showDone,
    focus,
  } = todayRenderState.derive({
    logDate: todayState.logDate,
    session,
    day,
    read,
    isToday,
    planReveal: todayState.planReveal,
    focusEngaged,
  });

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

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
type TodayScreenDayRead = import("../contracts/client.js").ClientDayRead & {
  _provisional?: boolean;
  override?: string | null;
};
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
type TodayState = Omit<typeof state, "brief" | "_briefInflight" | "exModes" | "pendingOffPlan" | "plan"> & {
  tab?: string;
  logDate: string;
  day: number | null;
  plan: TodayScreenPlanDay[];
  exModes: Record<string, string>;
  brief?: { date: string; override: string; read: TodayScreenDayRead } | null;
  _briefInflight?: { date: string; override: string; promise: Promise<TodayScreenDayRead> } | null;
  _briefMorph?: boolean;
  planJump?: string;
  chatPrefill?: string;
  pendingOffPlan?: Record<string, Array<{ name: string; mode?: string | null }>>;
  capturePrefill?: string | null;
  meSeg?: string;
  healthSeg?: string;
  healthSegPicked?: boolean;
  [key: string]: unknown;
};

const todayState = state as TodayState;
const todayView = view as HTMLElement & any;
const todayRuntime = CairnTodayScreenRuntime.create({
  state: todayState,
  root: todayView,
  // Mode-aware re-render: the shared session/data wiring re-renders whichever
  // training surface is live. On the Today tab that's the full Brief screen; on
  // the isolated "session" destination it's the calm logging surface only. This
  // one lever threads through the whole deps graph, so delete/finish/reopen and
  // add-exercise all re-render the correct surface.
  renderToday: (opts?: Record<string, unknown>) => rerenderTraining(opts),
});
const todayApi = todayRuntime.api;
const todayDeps = todayRuntime.deps;
const todayPlanSurfaceRendererDeps = todayRuntime.planSurfaceRendererDeps;
const todayMainShellDeps = todayRuntime.mainShellDeps;
const todayPlanSessionPreparation = (
  globalThis as unknown as {
    CairnTodayPlanSessionPreparation: TodayPlanSessionPreparationApi;
  }
).CairnTodayPlanSessionPreparation;
const todayDataLoader = (
  globalThis as unknown as {
    CairnTodayDataLoader: Window["CairnTodayDataLoader"];
  }
).CairnTodayDataLoader;
const todayMainShell = (
  globalThis as unknown as {
    CairnTodayMainShell: Window["CairnTodayMainShell"];
  }
).CairnTodayMainShell;
const todayPlanSurfaceRenderer = (
  globalThis as unknown as {
    CairnTodayPlanSurfaceRenderer: Window["CairnTodayPlanSurfaceRenderer"];
  }
).CairnTodayPlanSurfaceRenderer;
const todayRenderState = (
  globalThis as unknown as {
    CairnTodayRenderState: TodayRenderStateApi;
  }
).CairnTodayRenderState;

const {
  sessionDeps: todaySessionDeps,
  setupAddExercise,
  loadHealthFocusBanner,
  postExerciseMode: todayRuntimePostExerciseMode,
  reconnectSessionSuggest: todayRuntimeReconnectSessionSuggest,
  reconnectDayReadOverride: todayRuntimeReconnectDayReadOverride,
  invalidateTodayProgression: _invalidateTodayProgression,
  loadBrief,
  reshapeToday: todayRuntimeReshapeToday,
  briefHtml,
} = todayRuntime;

function postExerciseMode(name: string, mode: string): Promise<unknown> {
  return todayRuntimePostExerciseMode(name, mode);
}

function reconnectSessionSuggest(job?: unknown): unknown {
  return todayRuntimeReconnectSessionSuggest(job);
}

function reconnectDayReadOverride(job?: unknown): unknown {
  return todayRuntimeReconnectDayReadOverride(job);
}

async function reshapeToday(): Promise<void> {
  await todayRuntimeReshapeToday();
}

// ---------- sync trust: a quiet freshness line where a runner needs the mileage ----------
// The Garmin freshness renderer lives in /js/cardio-sync-client.js and preserves
// the cardioSyncLine compatibility global used by Today, Progress, and Plan.

// Cardio sync execution wiring also lives in /js/cardio-sync-client.js. It preserves
// the wireCardioSync compatibility global used by Today, Progress, and Plan.

// Session status render helpers live in /js/today-session-status-client.js. They
// own tonnage, set chips, completion, skip-line, and feedback markup while this
// screen keeps DOM wiring and persistence.

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
  return todayDeps().rail();
}

// ---- warm instant-paint for the Today plan surface (mirrors Stand/Train) ------
// The fetch chain behind the plan surface is several network round trips deep
// (session prep + brief, see the Promise.all above), so a bare re-entry — a cold
// app load, or switching back from another tab — otherwise shows nothing useful
// for that whole duration: switchTab's paintTabSkeleton() actually skips its own
// skeleton once "plan" is SWR-warm, which leaves the PREVIOUS tab's stale markup
// on screen rather than anything Today-shaped. Cache the exact wrapped HTML this
// function last wrote, keyed by date, and repaint it immediately, before any
// fetch; the normal fetch-then-write flow below still always runs afterward and
// settles on the true content, so this is purely an earlier, best-effort paint —
// never a substitute for it.
const TODAY_PLAN_SNAP_KEY = "cairn.today.plan.v2";
let todayPaintedRealFor: string | null = null; // date last given the REAL (non-snapshot) write this session

function todaySaveSurfaceSnapshot(date: string, html: string): void {
  try {
    sessionStorage.setItem(TODAY_PLAN_SNAP_KEY, JSON.stringify({ date, html }));
  } catch {
    /* quota — skip */
  }
}
function todayLoadSurfaceSnapshot(date: string): string | null {
  try {
    const raw = sessionStorage.getItem(TODAY_PLAN_SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { date?: unknown; html?: unknown } | null;
    return parsed && parsed.date === date && typeof parsed.html === "string" ? parsed.html : null;
  } catch {
    return null;
  }
}

function wireExerciseDecisionUndo(root: ParentNode, repaint: () => Promise<unknown> | unknown): void {
  // Autonomous changes explain themselves at the affected exercise and can be
  // put back immediately. The server owns the exact rollback snapshot; the UI
  // only sends the durable decision id that arrived with the plan item.
  (Array.from(root.querySelectorAll("[data-decision-undo]")) as HTMLElement[]).forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.decisionUndo);
      if (!Number.isFinite(id) || button.dataset.busy === "1") return;
      button.dataset.busy = "1";
      button.setAttribute("aria-busy", "true");
      try {
        const result: any = await api(`/brain/decisions/${id}/revert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "one-tap undo from the affected exercise" }),
        });
        if (!result?.ok) throw new Error(result?.error || "This change can no longer be undone.");
        toast("Put back the previous plan");
        await repaint();
      } catch (error: any) {
        toast(error?.message || "Could not undo that change");
        button.dataset.busy = "";
        button.removeAttribute("aria-busy");
      }
    });
  });
}

async function renderToday(opts: any = {}) {
  const enteredDate = todayState.logDate;
  // A soft (background stale-while-revalidate) repaint must feel silent: keep the
  // scroll position and suppress the `.reveal` entrance stagger so a "nothing
  // changed" refresh never flashes the whole screen or jumps under the reader.
  // Mirrors Stand's quietPaint and the Session surface's scroll capture/restore.
  const prevY = typeof window !== "undefined" ? window.scrollY : 0;

  // Only for a genuine (non-soft) entry, and only when Today isn't ALREADY
  // showing this exact date's real content (never paint stale snapshot markup
  // OVER a live, fresher surface — the same hazard class as the instant-paint
  // Stand/Train guards).
  const showingFreshToday = todayPaintedRealFor === enteredDate && !!todayView.querySelector(".today-wrap");
  if (!opts?.soft && !showingFreshToday && todayState.tab === "today") {
    const snap = todayLoadSurfaceSnapshot(enteredDate);
    if (snap) todayView.innerHTML = snap;
  }

  const todayData = await todayDataLoader.load(opts, todayDeps().dataLoad());
  const { soft, isToday } = todayData;
  const session: any = todayData.session;

  // The Brief's day-read has no data dependency on the plan/session preparation
  // below (it only needs logDate + any active override, not the prepared plan
  // day/prescriptions) — kicking off both waves together instead of serially
  // saves one full round-trip on cold entry. (See the Brief comment further
  // down for what `loadBrief`'s fast mode does.)
  const briefOverride =
    todayState.brief && todayState.brief.date === todayState.logDate ? todayState.brief.override : "";
  const previewTrainAnyway = /\btrain anyway\b/i.test(String(briefOverride || ""));
  const [prep, read, sessionPreview] = await Promise.all([
    todayPlanSessionPreparation.preparePlanSession(todayDeps().planSession(session, isToday)),
    loadBrief(todayState.logDate, briefOverride, { fast: true }),
    loadAdaptiveSessionPreview(todayState.logDate, String(briefOverride || ""), previewTrainAnyway).catch(() => null),
  ]);
  const {
    day,
    loggedByEx,
    todaySettings,
    matchedCardio,
    activeItems,
    skippedItems,
    cardioItems,
    strengthItems,
    offPlanEx,
    pendingOffPlan,
    lastSets,
    rxByEx,
    strengthJourney,
    rxFor,
    prefillFor,
    exDone,
    exTotal,
    hasSyncedCardioToday,
    isRunDay,
    expectingRun,
  } = prep;

  const [stats, profile, exercises]: any[] = [todayData.stats, todayData.profile, todayData.exercises];
  if (profile) {
    setDiscipline(profile.primary_discipline);
    setEnduranceGoalSet(!!profile.endurance_goal_json);
  } // keep the emphasis globals warm for Progress/Today/Plan
  // exercise → mode map ('reps'|'timed'), used by exCard + the add-exercise flow
  todayState.exModes = Object.fromEntries((exercises || []).map((e: any) => [e.name, e.mode || "reps"]));
  const curW = stats.weight_lb ?? (profile && profile.weight_lb != null ? profile.weight_lb : null);
  // Compass strip: adherence to this week's plan + weight-trend pace vs the goal.
  // It is trajectory only and stays inside the collapsed "This week" fold.
  const todayCompass = CairnTodayCompass.build(
    stats,
    {
      escapeHtml: escHtml,
      escapeAttr: escAttr,
      formatKm: fmtKm,
    },
    {
      currentWeight: curW,
      isToday,
      isEndurance: isEndurance(),
      isHybrid: isHybrid(),
    }
  );

  // ---- The Brief: the day-read leads. A suggestion, never a gate. ----
  // The plan/logging surface is revealed when the read says "train", when the
  // user has already logged on this date (they've committed), when they tapped
  // "train anyway"/"log these" (todayState.planReveal), or when reviewing a past date.
  // Non-blocking Brief: fetched above in FAST mode (in parallel with the plan/
  // session prep) — the endpoint returns a warm cached read instantly, so the
  // common case is immediate; a cold cache resolves to a provisional read
  // (painted with the .is-thinking filament) and the real agentic read swaps in
  // via upgradeBriefInPlace() once it lands. First paint never waits on
  // agent:"auto". (Honors an active override.)
  const { hasLoggedSets, hasGarmin, showPlan, showDone } = todayRenderState.derive({
    logDate: todayState.logDate,
    session,
    day,
    read,
    isToday,
    planReveal: todayState.planReveal,
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
  const syncline = cardioItems.length
    ? cardioSyncLine(todaySettings as Record<string, unknown> | null | undefined, { expectingRun })
    : "";

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
  // The CONDUCTOR (whole-picture focus, GET /api/coaching-focus) and the SALIENCE
  // ARBITER (GET /api/today-agenda, which shapes the rail) are the two network reads
  // that used to block the FIRST paint: renderToday awaited them before its single
  // innerHTML write, so a cold open held a blank skeleton for their latency stacked on
  // top of everything else. Now we kick them off, render the calm base IMMEDIATELY,
  // and hydrate the conductor thread + the rail into their stable slots as they land
  // (phase two, at the end of this function). Null/unavailable degrades exactly as
  // before — the standalone goal/health lines simply return.
  const renderedDate = todayState.logDate;
  const railToken = pollToken;
  const agendaPromise = CairnTodayRailController.fetchTodayAgenda(todayState.logDate, todayRailDeps());
  const conductorPromise = todayApi("/coaching-focus").catch(() => null);

  let html = todayMainShell.leadHtml(
    {
      isToday,
      briefHtml: briefHtml(read, { showPlan, showDone, isToday }),
      conductorHtml: "",
      currentWeight: curW,
    },
    todayMainShellDeps()
  );

  // On Today, the plan area is a calm launch card into the isolated Session
  // destination (logging no longer lives inline here). The done card still shows
  // inline.
  html +=
    showPlan && !showDone
      ? sessionLaunchCardHtml({
          day,
          dailySession: prep.dailySession,
          preview: sessionPreview,
          exDone,
          exTotal,
          isToday,
          hasLoggedSets,
          isRunDay,
          read,
          strengthJourney,
        })
      : todayPlanSurfaceRenderer.buildHtml(
          {
            showDone,
            showPlan,
            focus: false,
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
            strengthJourney,
            exDone,
            exTotal,
            hasSyncedCardioToday,
            hasLoggedSets,
            hasGarmin,
            isRunDay,
            preserveItemOrder: !!prep.dailySession,
            prefillFor,
            attributionFor: prep.attributionFor,
            rxFor,
          },
          todayPlanSurfaceRendererDeps()
        );

  // ---- Trajectory tier (this week), quiet, below the fold ----
  html += todayMainShell.weekFoldHtml(todayCompass, todayMainShellDeps());

  // The primary column (.today-main) holds the Brief, capture, and logging surface;
  // the rail (.today-rail) sits beside it on wide screens and stacks under it on
  // mobile/tablet. The rail is DEFERRED: paint an empty (but present) .today-rail now
  // so the two-column desktop layout is stable from the first frame, and hydrate its
  // structure + loaders in phase two once the agenda resolves.
  // The awaits above (data load, session prep, the brief race) can outlast a tab
  // switch or a date change — bail rather than paint Today over whichever surface
  // the user moved to. Instant-paint Stand exposed this: a later cold repaint no
  // longer papers over a stale write. (Phase two below re-checks the same way.)
  if (todayState.tab !== "today" || todayState.logDate !== enteredDate) return;
  // The class must be on an ancestor at the moment innerHTML mounts the cards,
  // since the CSS `rise` animation fires on insertion. toggle() also clears it on
  // the next hard render so real entrances still animate.
  todayView.classList.toggle("today-soft", !!soft);
  const todayWrappedHtml = todayMainShell.wrapHtml(html, {
    railHtml: `<aside class="today-rail" aria-busy="true"></aside>`,
  });
  todayView.innerHTML = todayWrappedHtml;
  if (soft) {
    try {
      window.scrollTo(0, prevY);
    } catch {}
  }
  // Snapshot this REAL write for next entry's instant paint (see above).
  todayPaintedRealFor = enteredDate;
  todaySaveSurfaceSnapshot(enteredDate, todayWrappedHtml);

  // The lead entry: one tap opens the isolated Session destination.
  (todayView.querySelector("#sessLaunch") as HTMLElement | null)?.addEventListener("click", (event: Event) => {
    void openSession(undefined, {
      source: "adaptive_plan",
      trigger: event.currentTarget as HTMLElement,
      provenance: { entry: "today_launch" },
      preview: sessionPreview,
    });
  });

  // Calm, dismissible "add to home screen" coach — appended to the primary column AFTER
  // the wholesale innerHTML write above (mounting before it would be silently wiped).
  // Pull, not push: it waits below the Brief, hidden in standalone mode and after dismissal.
  try {
    const main = todayView.querySelector(".today-main");
    if (main && typeof renderPhoneCoachBanner === "function") renderPhoneCoachBanner(main);
  } catch {}

  // Phase-1 wiring covers everything the user can act on immediately (capture,
  // Brief, session launch, day switch, drafts, wearable). The RAIL and the standalone
  // health lever are deferred to phase two: deferRail skips both rail loaders, and
  // conductorLeads:true holds the health-lever load so the conductor can decide whether
  // it shows at all — one voice, and no late-write race to clean up.
  CairnTodayPostRenderWiring.wirePostRender(
    todayDeps().postRender({
      read,
      isToday,
      showPlan,
      soft,
      conductorLeads: true,
      deferRail: true,
      agenda: null,
      agendaGeneric: [],
    })
  );

  wireExerciseDecisionUndo(todayView, () => renderToday({ soft: true }));

  wireGuides(view);

  CairnTodaySessionController.wireSessionSurface({ session, hasLoggedSets, lastSets }, todaySessionDeps());

  setupAddExercise();

  todayDataLoader.scheduleSoftRepaint(todayData, todayDeps().dataRefresh());

  // ---- PHASE 2: hydrate the conductor thread + agenda rail as they resolve ----
  // Everything above painted without waiting on these two network reads. Fold them in
  // now. Bail if the surface moved on (tab switch, date change, or a newer render
  // superseded this one) so a stale read never lands on the wrong screen.
  const [agenda, conductor] = await Promise.all([agendaPromise, conductorPromise]);
  if (todayState.tab !== "today" || todayState.logDate !== renderedDate || pollToken !== railToken) return;

  const conductorHtml = conductor ? coachingFocusThreadHtml(conductor) : "";
  const conductorLeads = !!conductorHtml;
  const cfocusSlot = todayView.querySelector("#cfocusSlot");
  if (cfocusSlot) {
    // Clicks on the thread ride the global [data-cfocus-go] delegate, so dropping the
    // markup into the slot is enough — no per-render wiring to re-run.
    cfocusSlot.innerHTML = conductorHtml;
    cfocusSlot.classList.toggle("cfocus-thread-slot", conductorLeads);
  }
  // The standalone health lever was held in phase one; load it only when the conductor
  // isn't already carrying the one highest-leverage line.
  if (!conductorLeads) loadHealthFocusBanner();

  // Rail: render the agenda-driven structure (or the calm fallback) into the reserved
  // .today-rail slot, then run its loaders. railHtml() fills agendaGeneric in place,
  // which runAgendaRail then wires — keep that order.
  const agendaGeneric: any[] = [];
  const railEl = todayView.querySelector(".today-rail");
  if (railEl) {
    railEl.outerHTML = agenda
      ? CairnTodayRailController.railHtml(agenda, agendaGeneric)
      : CairnTodayRailController.fallbackRailHtml(isToday);
    // The LEAD arbitration (read.attention, server-owned): move whichever surface
    // earned today's position of prominence out of the rail and into the main
    // column BEFORE the loaders run, so each loader still finds its slot by id
    // wherever it now lives. A payload without the decision changes nothing.
    CairnTodayRailController.promoteAttentionLead(todayView, read?.attention);
    if (agenda) CairnTodayRailController.runAgendaRail(agenda, agendaGeneric, todayRailDeps());
    else CairnTodayRailController.runFallbackRail(isToday, todayRailDeps());
  }
}

// ---------- The focused Session destination (its own route, isolated from Today) ----------
// All set logging lives HERE, OUT of Today's re-render cycle. Because state.tab
// is "session" (not "today") whenever this renders, every background "brain"
// path self-gates off — the soft-SWR repaint, the day-read override job, the
// agenda/conductor rail, the adapted-Rx patcher all check `tab === "today"` and
// no-op. So nothing rebuilds the surface under your fingers while you enter a
// workout. We deliberately REUSE Today's exact data-prep (preparePlanSession),
// card/surface renderers (buildHtml), and session wiring (wireSessionSurface,
// setupAddExercise); the only differences are: (a) no Brief/rail/capture chrome,
// (b) a calm sticky top bar, (c) the finish bar is ALWAYS present so logging the
// first set never forces a full rebuild, (d) the "apply to plan" banner is
// dropped (the brain's proposals stay on Today), and (e) scroll is PRESERVED
// across the surgical re-renders (delete/finish), reset only on a fresh open or
// a day switch. Entered via openSession(); left via the ← close (or the browser
// back button, which the router handles for free since openSession pushes a URL).
let sessionFreshNext = false;

type OpenSessionOptions = {
  source?: "adaptive_plan" | "agent_suggest" | "manual_plan" | "athlete_override";
  dayNumber?: number | null;
  replace?: boolean;
  agentJobId?: number | null;
  session?: import("../contracts/client.js").ClientSessionSuggestion | null;
  constraints?: Record<string, unknown>;
  trigger?: HTMLElement | null;
  provenance?: Record<string, unknown>;
  trainAnyway?: boolean;
  /** The exact authoritative candidate the athlete just reviewed on Today. */
  preview?: DailySessionPreview | null;
};

function dailySessionProvenanceLabel(
  dailySession: import("../contracts/client-api.js").ClientDailySessionComposition | null | undefined,
): string | null {
  const provenance =
    dailySession?.provenance && typeof dailySession.provenance === "object"
      ? (dailySession.provenance as Record<string, unknown>)
      : null;
  if (provenance?.choice === "training_by_choice") return "Training by choice";
  if (provenance?.choice === "adapted_for_today") return "Adapted for today";
  return null;
}

type DailySessionPreview = import("../contracts/client-api.js").ClientDailySessionPreview;

function adaptiveSessionPreviewPath(date: string, override: string, trainAnyway: boolean): string {
  const params = new URLSearchParams({ date });
  if (override) params.set("override", override);
  if (trainAnyway) params.set("train_anyway", "true");
  return `/daily-session/preview?${params.toString()}`;
}

async function loadAdaptiveSessionPreview(
  date: string,
  override: string,
  trainAnyway: boolean,
): Promise<DailySessionPreview | null> {
  const value = await todayApi(adaptiveSessionPreviewPath(date, override, trainAnyway));
  if (
    !value ||
    typeof value !== "object" ||
    String((value as DailySessionPreview).date || "") !== date ||
    String((value as DailySessionPreview).source || "") !== "adaptive_plan" ||
    !/^[a-f0-9]{64}$/.test(String((value as DailySessionPreview).input_fingerprint || ""))
  ) {
    return null;
  }
  return value as DailySessionPreview;
}

function adaptiveSessionPreviewDelta(
  previous: DailySessionPreview | null,
  fresh: DailySessionPreview,
): string {
  if (!previous) return "Today’s session has updated. Review the refreshed card, then start when it feels right.";
  const changes: string[] = [];
  if (previous.title !== fresh.title || previous.focus !== fresh.focus) changes.push("the session focus");
  if (previous.item_count !== fresh.item_count) {
    changes.push(`${fresh.item_count} movement${fresh.item_count === 1 ? "" : "s"}`);
  }
  if (previous.est_minutes !== fresh.est_minutes && fresh.est_minutes != null) {
    changes.push(`about ${fresh.est_minutes} minutes`);
  }
  if (JSON.stringify(previous.constraints) !== JSON.stringify(fresh.constraints)) changes.push("today’s guardrails");
  const detail = changes.length ? ` — ${changes.slice(0, 2).join(" and ")}` : "";
  return `Today’s session has updated${detail}. Review it, then start when it feels right.`;
}

const todaySessionSuggestController = CairnTodaySessionSuggestController as typeof CairnTodaySessionSuggestController & {
  meaningfulLegacySession(cachedSession: unknown, explicitReplacement: boolean): boolean;
  stageCachedContinuation(
    continuation: { session: Record<string, unknown>; daily_session: Record<string, unknown> },
    localPrepareId: string,
  ): Record<string, unknown> | null;
  snapshotRecovery(
    dailySession: unknown,
    originalRequest: unknown,
  ): { body: Record<string, unknown>; intent: Record<string, unknown> } | null;
  stagedPrepareResponse(input: {
    date: string;
    request: Record<string, unknown>;
    plan: Array<Record<string, unknown>>;
    selectedDay: number | null;
    suggestedSession?: Record<string, unknown> | null;
    localPrepareId: string;
  }): Record<string, unknown> | null;
};
const sessionPrepareCoordinator = todaySessionSuggestController.createPrepareCoordinator();
let sessionPrepareAnnouncement = 0;

function announceSessionPrepare(message: string): void {
  if (typeof document === "undefined" || !document.body) return;
  let status = document.getElementById("sessionPrepareLive");
  let mounted = false;
  if (!status) {
    status = document.createElement("div");
    status.id = "sessionPrepareLive";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    status.setAttribute(
      "style",
      "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"
    );
    document.body.appendChild(status);
    mounted = true;
  }
  // A live region needs to exist before its first text mutation for reliable
  // announcement across VoiceOver/NVDA. Later updates can land synchronously.
  const announcement = ++sessionPrepareAnnouncement;
  if (mounted && typeof setTimeout === "function") {
    setTimeout(() => {
      if (status && announcement === sessionPrepareAnnouncement) status.textContent = message;
    }, 0);
  } else status.textContent = message;
}

function sessionPrepareBusy(trigger: HTMLElement | null | undefined, busy: boolean, message = ""): void {
  if (!trigger) return;
  trigger.toggleAttribute("disabled", busy);
  if (busy) trigger.setAttribute("aria-busy", "true");
  else trigger.removeAttribute("aria-busy");
  const host = trigger.closest(".sess-launch") || trigger.parentElement;
  const status = host?.querySelector<HTMLElement>(".sess-launch-status, [data-session-prepare-status]");
  if (status) status.textContent = message;
}

function cachePreparedSession(date: string, response: Record<string, unknown>): void {
  if (response.session) swrSet(`today:session:${date}`, response.session);
  if (response.daily_session) swrSet(`today:daily-session:${date}`, response.daily_session);
  swrInvalidate(`today:aggregate:${date}`);
  swrInvalidate("history:sessions");
}

function enterSession(date: string, response?: Record<string, unknown> | null): void {
  if (response) cachePreparedSession(date, response);
  todayState.logDate = date;
  const daily = response?.daily_session as Record<string, unknown> | null | undefined;
  if (daily?.source === "manual_plan") {
    const linked = todayState.plan.find((day) => Number(day.id) === Number(daily.plan_day_id));
    if (linked) todayState.day = linked.day_number;
    todayState.dayPicked = true;
  } else if (daily && daily.source !== "adaptive_plan") {
    todayState.day = null;
    todayState.dayPicked = false;
  }
  todayState.planReveal = { date, on: true };
  sessionFreshNext = true;
  try {
    window.scrollTo(0, 0);
  } catch {}
  activateTab("session");
}

async function openSession(date?: string | null, options: OpenSessionOptions = {}): Promise<boolean> {
  const targetDate = date || todayState.logDate || localISO();
  const trigger = options.trigger || null;
  let source = options.source || (options.dayNumber != null || todayState.dayPicked ? "manual_plan" : "adaptive_plan");
  // Replacement is an explicit action, not an inference from retained UI state.
  // Every real plan-day switch passes replace:true; dayPicked also survives a
  // reload/reopen and must not turn continuation into an unsafe replacement.
  const explicitReplacement = options.replace === true;

  // Historic/legacy sessions remain usable exactly as they were. A composition is
  // additive; never force a migration-like prepare over already-logged work.
  const cachedSession = peekCached<any>(`today:session:${targetDate}`)?.data || null;
  const cachedDaily =
    cachedSession?.daily_session || peekCached<any>(`today:daily-session:${targetDate}`)?.data || null;
  const livePreparePrerequisite = (id: string): boolean => {
    const rows = (globalThis as {
      CairnOutbox?: { list?(): Array<{ id?: unknown; kind?: unknown; state?: unknown }> };
    }).CairnOutbox?.list?.() || [];
    return rows.some((item) =>
      String(item.id || "") === id &&
      item.kind === "daily_session_prepare" &&
      item.state !== "needs_attention"
    );
  };
  const continuation = todaySessionSuggestController.cachedContinuation(
    cachedSession,
    cachedDaily,
    explicitReplacement,
    livePreparePrerequisite,
  );
  if (continuation) {
    // Locally staged work may continue only while its exact prepare barrier is
    // still live. A cached server composition must be asserted by ID before the
    // athlete can log against it; status:"active" alone is never authority.
    if (continuation.staged === true) {
      const intent = await sessionPrepareCoordinator.run(targetDate, async () => continuation);
      if (!intent.current || !intent.ok) return false;
      announceSessionPrepare("Today’s session is ready.");
      enterSession(targetDate, intent.value);
      return true;
    }

    const expectedActiveId = Number(continuation.daily_session.id);
    if (!Number.isInteger(expectedActiveId) || expectedActiveId <= 0) {
      swrInvalidate(`today:session:${targetDate}`);
      swrInvalidate(`today:daily-session:${targetDate}`);
    } else {
      const assertionBody: import("../contracts/client-api.js").ClientDailySessionPrepareRequest = {
        date: targetDate,
        expected_active_id: expectedActiveId,
      };
      sessionPrepareBusy(trigger, true, "Confirming today’s session…");
      announceSessionPrepare("Confirming today’s session…");
      const asserted = await sessionPrepareCoordinator.run(targetDate, () =>
        todayApi("/daily-session/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(assertionBody),
          acceptErrorBody: true,
        })
      );
      if (!asserted.current) {
        sessionPrepareBusy(trigger, false);
        return false;
      }
      if (asserted.ok) {
        const response = asserted.value as Record<string, unknown>;
        const daily = response.daily_session && typeof response.daily_session === "object"
          ? response.daily_session as Record<string, unknown>
          : null;
        const session = response.session && typeof response.session === "object"
          ? response.session as Record<string, unknown>
          : null;
        if (response.ok === true && daily && session && Number(daily.id) === expectedActiveId) {
          swrSet(`today:session:${targetDate}`, { ...session, daily_session: daily });
          swrSet(`today:daily-session:${targetDate}`, daily);
          outboxResolveSessionPrerequisite(targetDate);
          sessionPrepareBusy(trigger, false, "Today’s session is ready.");
          announceSessionPrepare("Today’s session is ready.");
          enterSession(targetDate, { ...response, session: { ...session, daily_session: daily } });
          return true;
        }
        // Reachable mismatch/missing truth: retire only this stale continuation.
        swrInvalidate(`today:session:${targetDate}`);
        swrInvalidate(`today:daily-session:${targetDate}`);
        const message = String(response.error || "Today’s session changed elsewhere. Open it again to use the current version.");
        sessionPrepareBusy(trigger, false, message);
        announceSessionPrepare(message);
        toast(message);
        return false;
      }

      const classify = (globalThis as {
        CairnApiCache?: { isTransientApiFailure?: (value: unknown) => boolean };
      }).CairnApiCache?.isTransientApiFailure;
      const transient = typeof classify !== "function" || classify(asserted.error);
      if (transient) {
        const savedDaily = continuation.daily_session;
        const recovery = todaySessionSuggestController.snapshotRecovery(savedDaily, assertionBody);
        const queued = await (globalThis as {
          outboxEnqueue?: (
            kind: string,
            path: string,
            body: unknown,
            options?: {
              prepareIntent?: Record<string, unknown> | null;
              retryBody?: Record<string, unknown> | null;
              retryIntent?: Record<string, unknown> | null;
            },
          ) => Promise<{ id?: unknown } | null>;
        }).outboxEnqueue?.("daily_session_prepare", "/daily-session/prepare", assertionBody, {
          prepareIntent: savedDaily,
          retryBody: recovery?.body,
          retryIntent: recovery?.intent,
        });
        const localPrepareId = String(queued?.id || "").trim();
        const staged = localPrepareId
          ? todaySessionSuggestController.stageCachedContinuation(continuation, localPrepareId)
          : null;
        if (staged) {
          const stagedRecord = staged as {
            session: Record<string, unknown>;
            daily_session: Record<string, unknown>;
          };
          swrSet(`today:session:${targetDate}`, stagedRecord.session);
          swrSet(`today:daily-session:${targetDate}`, stagedRecord.daily_session);
          const message = "Session confirmed on this device — Cairn will reconcile it when you’re back online.";
          sessionPrepareBusy(trigger, false, message);
          announceSessionPrepare(message);
          toast(message);
          enterSession(targetDate, staged);
          return true;
        }
      }
      const message = transient
        ? "Could not save this session check on this device — free storage and try again."
        : "Could not confirm today’s session. Try again when you’re ready.";
      sessionPrepareBusy(trigger, false, message);
      announceSessionPrepare(message);
      toast(message);
      return false;
    }
  }
  if (
    (cachedSession?._staged_offline === true || cachedDaily?._staged_offline === true) &&
    !explicitReplacement
  ) {
    const stagedId = String(cachedSession?._local_prepare_id || cachedDaily?._local_prepare_id || "");
    const stagedPrerequisite = (globalThis as {
      CairnOutbox?: { list?(): Array<{ id?: unknown; kind?: unknown; state?: unknown }> };
    }).CairnOutbox?.list?.().find((item) => String(item.id || "") === stagedId && item.kind === "daily_session_prepare");
    if (stagedPrerequisite?.state === "needs_attention") {
      const message = "This saved session needs attention before you can keep logging.";
      sessionPrepareBusy(trigger, false, message);
      announceSessionPrepare(message);
      toast(message);
      return false;
    }
    // A staged cache without its queued/prepared barrier is a phantom. Retire
    // only this date's staged pair and latch the mounted surface until a fresh
    // server reconciliation succeeds.
    outboxBlockSessionPrerequisite(targetDate);
    swrInvalidate(`today:session:${targetDate}`);
    swrInvalidate(`today:daily-session:${targetDate}`);
  }
  if (todaySessionSuggestController.meaningfulLegacySession(cachedSession, explicitReplacement)) {
    const intent = await sessionPrepareCoordinator.run(targetDate, async () => cachedSession);
    if (!intent.current || !intent.ok) return false;
    announceSessionPrepare("Today’s session is ready.");
    enterSession(targetDate);
    return true;
  }

  let customSession = options.session || null;
  // An empty weekly plan still has a useful durable destination: an explicit,
  // zero-item athlete override where exercises can be added as the session unfolds.
  if ((source === "adaptive_plan" && !todayState.plan.length) || (source === "athlete_override" && !customSession)) {
    source = "athlete_override";
    customSession = {
      name: "Open session",
      focus: "Choose as you go",
      why: "A blank session for whatever feels useful today.",
      est_minutes: null,
      items: [],
    };
  }
  const dayNumber =
    options.dayNumber != null
      ? Number(options.dayNumber)
      : source === "manual_plan" && todayState.day != null
        ? Number(todayState.day)
        : null;
  const override =
    todayState.brief && todayState.brief.date === targetDate ? String(todayState.brief.override || "").trim() : "";
  let adaptivePreview: DailySessionPreview | null = null;
  if (source === "adaptive_plan") {
    const reviewed = options.preview;
    if (
      reviewed &&
      reviewed.date === targetDate &&
      reviewed.source === "adaptive_plan" &&
      /^[a-f0-9]{64}$/.test(reviewed.input_fingerprint)
    ) {
      // Bind Start to the exact candidate rendered on the card. The server will
      // compare this token against a fresh candidate; never silently authorize a
      // newer session the athlete has not seen.
      adaptivePreview = reviewed;
    } else if (reviewed === undefined) {
      try {
        // Entry points without a visible preview (for example the Brief's direct
        // Start action) may fetch one immediately before prepare.
        adaptivePreview = await loadAdaptiveSessionPreview(targetDate, override, options.trainAnyway === true);
      } catch {
        // Preview is additive. If the read itself is offline, preserve the
        // existing durable local staging path and reconcile when connectivity returns.
      }
    }
  }
  const body: import("../contracts/client-api.js").ClientDailySessionPrepareRequest = {
    date: targetDate,
    source,
  };
  if (adaptivePreview) body.expected_input_fingerprint = adaptivePreview.input_fingerprint;
  if (options.trainAnyway === true) body.train_anyway = true;
  if (source === "agent_suggest") {
    const agentJobId = Number(options.agentJobId);
    if (!Number.isInteger(agentJobId) || agentJobId <= 0) {
      const message = "This suggested session can’t be verified yet. Draft it again, then use the new result.";
      sessionPrepareBusy(trigger, false, message);
      announceSessionPrepare(message);
      toast(message);
      return false;
    }
    body.agent_job_id = agentJobId;
    body.constraints = options.constraints || {};
    body.provenance = options.provenance || {
      verification: "verified_agent_job",
      operation: "session_suggest",
      agent_job_id: agentJobId,
    };
  } else {
    body.constraints = options.constraints || (override ? { day_read_override: override } : {});
    body.provenance = { entry: "pwa", ...(options.provenance || {}) };
    if (source === "athlete_override" && customSession) body.session = customSession;
  }
  if (source === "manual_plan" && dayNumber != null) body.day_number = dayNumber;
  // Ordinary opens accept the server's existing composition. Only a deliberate
  // athlete/agent/plan-day choice may replace an unstarted accepted session.
  // The server remains the authority and refuses replacement after work starts.
  body.replace = explicitReplacement;

  const offlineStageInput = {
    date: targetDate,
    request: body as unknown as Record<string, unknown>,
    plan: todayState.plan as Array<Record<string, unknown>>,
    selectedDay: todayState.day == null ? null : Number(todayState.day),
    suggestedSession:
      source === "agent_suggest" && todayState.suggestedSession
        ? (todayState.suggestedSession as unknown as Record<string, unknown>)
        : null,
  };
  const canStageOffline = todaySessionSuggestController.stagedPrepareResponse({
    ...offlineStageInput,
    localPrepareId: "validation",
  });

  sessionPrepareBusy(trigger, true, "Preparing today’s session…");
  announceSessionPrepare("Preparing today’s session…");
  const result = await sessionPrepareCoordinator.run(targetDate, () =>
    todayApi("/daily-session/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      acceptErrorBody: true,
    })
  );
  if (!result.current) {
    sessionPrepareBusy(trigger, false);
    return false;
  }
  if (!result.ok) {
    const error = result.error as { message?: unknown } | null;
    const classify = (globalThis as {
      CairnApiCache?: { isTransientApiFailure?: (value: unknown) => boolean };
    }).CairnApiCache?.isTransientApiFailure;
    const transient = typeof classify !== "function" || classify(error);
    if (transient && canStageOffline) {
      const stagedIntent = canStageOffline.daily_session && typeof canStageOffline.daily_session === "object"
        ? canStageOffline.daily_session as Record<string, unknown>
        : null;
      const recovery = todaySessionSuggestController.snapshotRecovery(stagedIntent, body);
      const queued = await (globalThis as {
        outboxEnqueue?: (
          kind: string,
          path: string,
          body: unknown,
          options?: {
            prepareIntent?: Record<string, unknown> | null;
            retryBody?: Record<string, unknown> | null;
            retryIntent?: Record<string, unknown> | null;
          },
        ) => Promise<{ id?: unknown } | null>;
      }).outboxEnqueue?.("daily_session_prepare", "/daily-session/prepare", body, {
        prepareIntent: stagedIntent,
        retryBody: recovery?.body,
        retryIntent: recovery?.intent,
      });
      const localPrepareId = String(queued?.id || "").trim();
      const staged = localPrepareId
        ? todaySessionSuggestController.stagedPrepareResponse({ ...offlineStageInput, localPrepareId })
        : null;
      if (staged) {
        const message = "Session saved on this device — it will sync when you’re back online.";
        sessionPrepareBusy(trigger, false, message);
        announceSessionPrepare(message);
        toast(message);
        enterSession(targetDate, staged);
        return true;
      }
    }
    const message = transient && canStageOffline
      ? "Could not save this session on this device — free storage and try again."
      : String(error?.message || "Could not save today’s session. Try again when you’re ready.");
    sessionPrepareBusy(trigger, false, message);
    announceSessionPrepare(message);
    toast(message);
    return false;
  }
  const response = result.value as Record<string, unknown>;
  if (
    response?.ok === false &&
    response.code === "daily_session_preview_stale" &&
    response.preview &&
    typeof response.preview === "object"
  ) {
    const fresh = response.preview as DailySessionPreview;
    const message = adaptiveSessionPreviewDelta(adaptivePreview, fresh);
    sessionPrepareBusy(trigger, false, message);
    announceSessionPrepare(message);
    toast(message);
    // Repaint from server truth instead of patching individual text nodes. This
    // replaces every displayed field (including constraints) and, crucially,
    // re-wires Start with the fresh preview fingerprint so the next click cannot
    // loop on the stale token captured by the old listener.
    await renderToday({ soft: true });
    return false;
  }
  if (response?.ok === false && response.code === "daily_session_active_changed") {
    const message =
      "Another accepted session now owns today. Review the refreshed card before continuing.";
    sessionPrepareBusy(trigger, false, message);
    announceSessionPrepare(message);
    toast(message);
    await renderToday({ soft: true });
    return false;
  }
  if (response?.ok !== true || !response.daily_session || !response.session) {
    const message = String(response?.error || "This session could not be prepared.");
    sessionPrepareBusy(trigger, false, message);
    announceSessionPrepare(message);
    toast(message);
    return false;
  }
  sessionPrepareBusy(trigger, false, "Today’s session is ready.");
  announceSessionPrepare("Today’s session is ready.");
  outboxResolveSessionPrerequisite(targetDate);
  enterSession(targetDate, response);
  return true;
}

function rerenderTraining(opts?: Record<string, unknown>): Promise<unknown> | unknown {
  return todayState.tab === "session" ? renderSession(opts) : renderToday(opts);
}

// The Today "lead entry": instead of the full set-by-set logging surface living
// inline on Today (where the brain's background re-renders used to yank it), the
// plan area shows one calm tap-card that opens the isolated Session destination.
// Suggestion, never a gate — the Brief still leads above it.
function sessionLaunchCardHtml(opts: {
  day: { name?: unknown; focus?: unknown; items?: Array<{ exercise?: unknown }> | null } | null | undefined;
  dailySession?: import("../contracts/client-api.js").ClientDailySessionComposition | null;
  preview?: DailySessionPreview | null;
  exDone: number;
  exTotal: number;
  isToday: boolean;
  hasLoggedSets: boolean;
  isRunDay: boolean;
  read: { est_minutes?: unknown } | null | undefined;
  strengthJourney?: import("../contracts/client-api.js").ClientStrengthJourney | null;
}): string {
  const name =
    opts.dailySession?.title ||
    opts.preview?.title ||
    (opts.day && opts.day.name ? String(opts.day.name) : opts.isRunDay ? "Today's run" : "Today's session");
  const focus = opts.dailySession?.focus || opts.preview?.focus || (opts.day && opts.day.focus ? String(opts.day.focus) : "");
  const started = opts.exDone > 0 || opts.hasLoggedSets;
  const previewCount = !started && !opts.dailySession ? opts.preview?.item_count : null;
  const sub = previewCount != null
    ? `${previewCount} movement${previewCount === 1 ? "" : "s"}`
    : opts.exTotal
    ? started
      ? `${opts.exDone} of ${opts.exTotal} logged`
      : `${opts.exTotal} lift${opts.exTotal === 1 ? "" : "s"}`
    : "";
  const estimate =
    opts.dailySession?.est_minutes ??
    opts.preview?.est_minutes ??
    (opts.read && opts.read.est_minutes ? Number(opts.read.est_minutes) : null);
  const est = estimate ? `~${Number(estimate)} min` : "";
  const meta = [sub, est].filter(Boolean).join("  ·  ");
  const cta = started ? "Continue" : "Start";
  const objective = opts.strengthJourney?.available ? opts.strengthJourney.objective : null;
  const hasAnchor =
    !!objective?.exercise &&
    (opts.day?.items || []).some(
      (item) =>
        String(item.exercise || "")
          .trim()
          .toLowerCase() === String(objective.exercise).trim().toLowerCase()
    );
  const journeyLine = hasAnchor
    ? objective?.status === "completed"
      ? "Anchor milestone rebuilt · consolidate it calmly today."
      : opts.strengthJourney?.phase === "protecting"
        ? "Anchor day · hold or ease; the relevant safety signal leads."
        : `Anchor day · ${escHtml(objective?.exercise)}${Number(opts.strengthJourney?.gap_lb) > 0 ? ` · ${Number(opts.strengthJourney?.gap_lb).toFixed(1)} lb estimated 1RM gap` : ""}`
    : "";
  const decisionLabel = dailySessionProvenanceLabel(opts.dailySession);
  const source = decisionLabel || (opts.dailySession
    ? opts.dailySession.source === "adaptive_plan" || opts.dailySession.source === "manual_plan"
      ? `From plan${opts.day?.name ? ` · ${String(opts.day.name)}` : ""}`
      : "Built for today"
    : opts.isToday
      ? "TODAY'S SESSION"
      : "SESSION");
  return `<button class="sess-launch reveal" style="--i:2" type="button" id="sessLaunch">
      <div class="sess-launch-body">
        <div class="sess-launch-kicker lbl">${escHtml(source)}</div>
        <div class="sess-launch-title">${escHtml(name)}${focus ? `<span class="sess-launch-focus"> · ${escHtml(focus)}</span>` : ""}</div>
        ${meta ? `<div class="sess-launch-meta">${escHtml(meta)}</div>` : ""}
        ${opts.dailySession?.why || opts.preview?.primary_rationale ? `<div class="sess-launch-why">${escHtml(opts.dailySession?.why || opts.preview?.primary_rationale || "")}</div>` : ""}
        ${!opts.dailySession && opts.preview?.constraints?.length ? `<div class="sess-launch-why">${escHtml(opts.preview.constraints.slice(0, 2).join(" · "))}</div>` : ""}
        <span class="sess-launch-status" role="status" aria-live="polite"></span>
        ${journeyLine ? `<div class="sess-launch-journey">${journeyLine}</div>` : ""}
      </div>
      <span class="sess-launch-cta">${cta} <span class="sess-launch-arrow" aria-hidden="true">→</span></span>
    </button>`;
}

function sessionShellHtml(
  inner: string,
  meta: {
    fresh: boolean;
    kicker: string;
    dayName: string;
    dayFocus: string;
    why?: string;
    estimate?: number | null;
    exDone: number;
    exTotal: number;
  }
): string {
  const capped = Math.min(meta.exTotal, 12);
  const dots = meta.exTotal
    ? `<div class="sess-dots" aria-hidden="true">${Array.from({ length: capped }, (_v, i) => `<span class="sess-dot${i < meta.exDone ? " on" : ""}"></span>`).join("")}</div>`
    : "";
  const prog = meta.exTotal
    ? `<span class="sess-prog"><b>${meta.exDone}</b><span class="sess-prog-sep"> of </span>${meta.exTotal}</span>`
    : "";
  return `<div class="sess-dest${meta.fresh ? " sess-fresh" : ""}">
    <div class="sess-topbar">
      <button class="sess-close" id="sessClose" type="button" aria-label="Back to today">←</button>
      <div class="sess-topbar-mid">
        <div class="sess-kicker lbl">${escHtml(meta.kicker)}</div>
        <div class="sess-dayname" role="heading" aria-level="1" tabindex="-1">${escHtml(meta.dayName)}${meta.dayFocus ? `<span class="sess-focus"> · ${escHtml(meta.dayFocus)}</span>` : ""}</div>
        ${meta.why || meta.estimate ? `<div class="sess-topbar-why">${meta.why ? escHtml(meta.why) : ""}${meta.estimate ? `${meta.why ? " · " : ""}${Math.round(meta.estimate)} min` : ""}</div>` : ""}
      </div>
      <div class="sess-topbar-side">${prog}</div>
    </div>
    ${dots}
    <div class="sess-body"><div id="sessionPrimerSlot" class="sess-primer-slot"></div>${inner}</div>
  </div>`;
}

function wireSessionDestination(): void {
  const close = view.querySelector<HTMLButtonElement>("#sessClose");
  if (close && !close.dataset.wired) {
    close.dataset.wired = "1";
    close.addEventListener("click", () => {
      todayState.planReveal = undefined;
      activateTab("today");
    });
  }
  view.querySelectorAll<HTMLElement>(".sess-dest .daybtn").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      const dayNumber = Number(btn.dataset.day);
      void openSession(todayState.logDate, {
        source: "manual_plan",
        dayNumber,
        replace: true,
        trigger: btn,
        provenance: { entry: "session_day_switch" },
      });
    });
  });
  // Focus mode intentionally omits capture. Route the cardio CTA to Chat with the
  // natural-language phrase ready for review; nothing is logged implicitly.
  view.querySelectorAll<HTMLElement>(".sess-dest [data-cardio-log]").forEach((button) => {
    if (button.dataset.wired) return;
    button.dataset.wired = "1";
    button.addEventListener("click", () => {
      const phrase = String(button.dataset.cardioLog || "").trim();
      if (!phrase) return;
      todayState.chatPrefill = phrase;
      activateTab("chat");
    });
  });
}

async function renderSession(opts: any = {}): Promise<void> {
  const enteredDate = todayState.logDate;
  const hadSurface = !!todayView.querySelector(".sess-dest");
  const fresh = !hadSurface || sessionFreshNext || !!opts.fresh;
  sessionFreshNext = false;
  const prevY = typeof window !== "undefined" ? window.scrollY : 0;

  const todayData = await todayDataLoader.load(opts, todayDeps().dataLoad());
  const { isToday } = todayData;
  const session: any = todayData.session;
  const prep: any = await todayPlanSessionPreparation.preparePlanSession(todayDeps().planSession(session, isToday));

  const profile: any = todayData.profile;
  const exercises: any[] = (todayData.exercises as any[]) || [];
  if (profile) {
    setDiscipline(profile.primary_discipline);
    setEnduranceGoalSet(!!profile.endurance_goal_json);
  }
  todayState.exModes = Object.fromEntries(exercises.map((e: any) => [e.name, e.mode || "reps"]));

  const day = prep.day;
  const dailySession = prep.dailySession as import("../contracts/client-api.js").ClientDailySessionComposition | null;
  const hasLoggedSets = !!(session && (session.sets || []).length);
  const hasGarmin = !!(session && session.garmin);
  const isFinished = !!(session && session.finished_at);
  const revealOn = !!(
    todayState.planReveal &&
    todayState.planReveal.date === todayState.logDate &&
    todayState.planReveal.on
  );
  const showDone = isFinished && !revealOn;
  const showPlan = !showDone;

  const surface = todayPlanSurfaceRenderer.buildHtml(
    {
      showDone,
      showPlan,
      focus: true,
      session,
      day,
      isToday,
      plan: todayState.plan,
      activeDay: todayState.day,
      logDate: todayState.logDate,
      cardioItems: prep.cardioItems,
      strengthItems: prep.strengthItems,
      activeItems: prep.activeItems,
      skippedItems: prep.skippedItems,
      matchedCardio: prep.matchedCardio,
      syncedLine: "",
      loggedByEx: prep.loggedByEx,
      offPlanEx: prep.offPlanEx,
      pendingOffPlan: prep.pendingOffPlan,
      lastSets: prep.lastSets,
      rxByEx: prep.rxByEx,
      strengthJourney: prep.strengthJourney,
      exDone: prep.exDone,
      exTotal: prep.exTotal,
      hasSyncedCardioToday: prep.hasSyncedCardioToday,
      hasLoggedSets: true,
      hasGarmin,
      isRunDay: prep.isRunDay,
      preserveItemOrder: !!dailySession,
      prefillFor: prep.prefillFor,
      attributionFor: prep.attributionFor,
      rxFor: prep.rxFor,
    },
    todayPlanSurfaceRendererDeps()
  );

  const dayName =
    dailySession?.title || (day && day.name ? String(day.name) : prep.isRunDay ? "Today's run" : "Session");
  const dayFocus = dailySession?.focus || (day && day.focus ? String(day.focus) : "");
  const sourceLabel = dailySessionProvenanceLabel(dailySession) || (dailySession
    ? dailySession.source === "adaptive_plan" || dailySession.source === "manual_plan"
      ? `From plan${day && day.name ? ` · ${String(day.name)}` : ""}`
      : "Built for today"
    : null);
  const kicker =
    sourceLabel ||
    (isToday
      ? "TODAY · SESSION"
      : typeof humanDate === "function"
        ? humanDate(todayState.logDate)
        : todayState.logDate);

  // Same stale-render bail as renderToday: the loads above can outlast leaving
  // the Session destination, and this paint must never land on another tab.
  if (todayState.tab !== "session" || todayState.logDate !== enteredDate) return;
  todayView.innerHTML = sessionShellHtml(surface, {
    fresh,
    kicker,
    dayName,
    dayFocus,
    why: dailySession?.why || "",
    estimate: dailySession?.est_minutes || null,
    exDone: prep.exDone,
    exTotal: prep.exTotal,
  });

  // Calm: no mid-workout "apply these targets to my plan" banner in the focused
  // surface — the brain's proposals stay on Today. (Per-lift adapted target lines
  // still render; refreshAdaptedRx is already a no-op here since tab !== "today".)
  todayView.querySelector(".sess-dest .rx-banner")?.remove();

  CairnTodaySessionController.wireSessionSurface(
    { session, hasLoggedSets, lastSets: prep.lastSets },
    todaySessionDeps()
  );
  wireExerciseDecisionUndo(todayView, () => renderSession({ soft: true }));
  setupAddExercise();
  wireGuides(view);
  wireSessionDestination();

  // A fresh entry places assistive-tech focus on the one session heading. The
  // visual scroll remains at the top and reduced-motion users get no animation.
  if (fresh) {
    try {
      (todayView.querySelector(".sess-dayname") as HTMLElement | null)?.focus({ preventScroll: true });
    } catch {}
  }

  // The pre-session primer — "a coach was already here". Best-effort + off the paint
  // path: fetch GET /api/session-primer and hydrate #sessionPrimerSlot (collapsed once
  // the session has logged sets), decorating any fresh movement rows. A missing lib /
  // null payload / a stale render is a calm no-op. Not awaited (never blocks logging).
  const primerDay = todayState.day == null ? null : Number(todayState.day);
  window.CairnSessionPrimer?.hydrate({
    root: todayView,
    date: todayState.logDate,
    dayNumber: primerDay != null && Number.isFinite(primerDay) ? primerDay : null,
    hasLoggedSets,
    api: todayApi,
    guard: () => todayState.tab === "session" && todayState.logDate === enteredDate,
  });

  if (fresh) {
    try {
      window.scrollTo(0, 0);
    } catch {}
  } else {
    try {
      window.scrollTo(0, prevY);
    } catch {}
  }
}

Object.assign(globalThis, {
  openSession,
  postExerciseMode,
  reconnectDayReadOverride,
  reconnectSessionSuggest,
  renderSession,
  renderToday,
  reshapeToday,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    openSession,
    postExerciseMode,
    reconnectDayReadOverride,
    reconnectSessionSuggest,
    renderSession,
    renderToday,
    reshapeToday,
  });
}

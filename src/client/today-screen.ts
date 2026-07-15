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
const todayPlanSessionPreparation = (globalThis as unknown as {
  CairnTodayPlanSessionPreparation: TodayPlanSessionPreparationApi;
}).CairnTodayPlanSessionPreparation;
const todayDataLoader = (globalThis as unknown as {
  CairnTodayDataLoader: Window["CairnTodayDataLoader"];
}).CairnTodayDataLoader;
const todayMainShell = (globalThis as unknown as {
  CairnTodayMainShell: Window["CairnTodayMainShell"];
}).CairnTodayMainShell;
const todayPlanSurfaceRenderer = (globalThis as unknown as {
  CairnTodayPlanSurfaceRenderer: Window["CairnTodayPlanSurfaceRenderer"];
}).CairnTodayPlanSurfaceRenderer;
const todayRenderState = (globalThis as unknown as {
  CairnTodayRenderState: TodayRenderStateApi;
}).CairnTodayRenderState;

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
const TODAY_PLAN_SNAP_KEY = "cairn.today.plan.v1";
let todayPaintedRealFor: string | null = null; // date last given the REAL (non-snapshot) write this session

function todaySaveSurfaceSnapshot(date: string, html: string): void {
  try { sessionStorage.setItem(TODAY_PLAN_SNAP_KEY, JSON.stringify({ date, html })); } catch { /* quota — skip */ }
}
function todayLoadSurfaceSnapshot(date: string): string | null {
  try {
    const raw = sessionStorage.getItem(TODAY_PLAN_SNAP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { date?: unknown; html?: unknown } | null;
    return parsed && parsed.date === date && typeof parsed.html === "string" ? parsed.html : null;
  } catch { return null; }
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
  const briefOverride = todayState.brief && todayState.brief.date === todayState.logDate ? todayState.brief.override : "";
  const [prep, read] = await Promise.all([
    todayPlanSessionPreparation.preparePlanSession(todayDeps().planSession(session, isToday)),
    loadBrief(todayState.logDate, briefOverride, { fast: true }),
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
  // Non-blocking Brief: fetched above in FAST mode (in parallel with the plan/
  // session prep) — the endpoint returns a warm cached read instantly, so the
  // common case is immediate; a cold cache resolves to a provisional read
  // (painted with the .is-thinking filament) and the real agentic read swaps in
  // via upgradeBriefInPlace() once it lands. First paint never waits on
  // agent:"auto". (Honors an active override.)
  const {
    hasLoggedSets,
    hasGarmin,
    showPlan,
    showDone,
  } = todayRenderState.derive({
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

  // The goal line is deferred into #goalSlot: painting it now and then hiding it when
  // the conductor turns out to lead would flip on screen, so it renders once, in its
  // final form, in phase two.
  const goalLineHtml = CairnTodayContext.goalLineHtml(stats, curW, isToday);

  let html = todayMainShell.leadHtml({
    isToday,
    briefHtml: briefHtml(read, { showPlan, showDone, isToday }),
    conductorHtml: "",
    conductorLeads: false,
    goalLineHtml: "",
    currentWeight: curW,
  }, todayMainShellDeps());

  // On Today, the plan area is a calm launch card into the isolated Session
  // destination (logging no longer lives inline here). The done card still shows
  // inline.
  html += (showPlan && !showDone)
    ? sessionLaunchCardHtml({ day, exDone, exTotal, isToday, hasLoggedSets, isRunDay, read, strengthJourney })
    : todayPlanSurfaceRenderer.buildHtml({
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
    prefillFor,
    rxFor,
  }, todayPlanSurfaceRendererDeps());

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
  const todayWrappedHtml = todayMainShell.wrapHtml(html, { railHtml: `<aside class="today-rail" aria-busy="true"></aside>` });
  todayView.innerHTML = todayWrappedHtml;
  if (soft) { try { window.scrollTo(0, prevY); } catch {} }
  // Snapshot this REAL write for next entry's instant paint (see above).
  todayPaintedRealFor = enteredDate;
  todaySaveSurfaceSnapshot(enteredDate, todayWrappedHtml);

  // The lead entry: one tap opens the isolated Session destination.
  todayView.querySelector("#sessLaunch")?.addEventListener("click", () => openSession());

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
  CairnTodayPostRenderWiring.wirePostRender(todayDeps().postRender({
    read,
    isToday,
    showPlan,
    soft,
    conductorLeads: true,
    deferRail: true,
    agenda: null,
    agendaGeneric: [],
    todayCompass,
  }));

  // Autonomous changes explain themselves at the affected exercise and can be
  // put back immediately. The server owns the exact rollback snapshot; the UI
  // only sends the durable decision id that arrived with the plan item.
  (Array.from(todayView.querySelectorAll("[data-decision-undo]")) as HTMLElement[]).forEach((button) => {
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
        await renderToday({ soft: true });
      } catch (error: any) {
        toast(error?.message || "Could not undo that change");
        button.dataset.busy = "";
        button.removeAttribute("aria-busy");
      }
    });
  });

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
  // The goal line renders now, in final form, unless the conductor leads and subsumes it.
  const goalSlot = todayView.querySelector("#goalSlot");
  if (goalSlot) {
    goalSlot.innerHTML = conductorLeads ? "" : goalLineHtml;
    goalSlot.querySelector("#goalLine")?.addEventListener("click", () => activateTab("progress"));
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

function openSession(date?: string | null): void {
  if (date) todayState.logDate = date;
  todayState.planReveal = { date: todayState.logDate, on: true };
  sessionFreshNext = true;
  try { window.scrollTo(0, 0); } catch {}
  activateTab("session");
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
  exDone: number;
  exTotal: number;
  isToday: boolean;
  hasLoggedSets: boolean;
  isRunDay: boolean;
  read: { est_minutes?: unknown } | null | undefined;
  strengthJourney?: import("../contracts/client-api.js").ClientStrengthJourney | null;
}): string {
  const name = opts.day && opts.day.name ? String(opts.day.name) : (opts.isRunDay ? "Today's run" : "Today's session");
  const focus = opts.day && opts.day.focus ? String(opts.day.focus) : "";
  const started = opts.exDone > 0 || opts.hasLoggedSets;
  const sub = opts.exTotal
    ? (started ? `${opts.exDone} of ${opts.exTotal} logged` : `${opts.exTotal} lift${opts.exTotal === 1 ? "" : "s"}`)
    : "";
  const est = opts.read && opts.read.est_minutes ? `~${Number(opts.read.est_minutes)} min` : "";
  const meta = [sub, est].filter(Boolean).join("  ·  ");
  const cta = started ? "Continue" : "Start";
  const objective = opts.strengthJourney?.available ? opts.strengthJourney.objective : null;
  const hasAnchor = !!objective?.exercise && (opts.day?.items || []).some((item) =>
    String(item.exercise || "").trim().toLowerCase() === String(objective.exercise).trim().toLowerCase()
  );
  const journeyLine = hasAnchor
    ? objective?.status === "completed"
      ? "Anchor milestone rebuilt · consolidate it calmly today."
      : opts.strengthJourney?.phase === "protecting"
        ? "Anchor day · hold or ease; the relevant safety signal leads."
        : `Anchor day · ${escHtml(objective?.exercise)}${Number(opts.strengthJourney?.gap_lb) > 0 ? ` · ${Number(opts.strengthJourney?.gap_lb).toFixed(1)} lb estimated 1RM gap` : ""}`
    : "";
  return `<button class="sess-launch reveal" style="--i:2" type="button" id="sessLaunch">
      <div class="sess-launch-body">
        <div class="sess-launch-kicker lbl">${opts.isToday ? "TODAY'S SESSION" : "SESSION"}</div>
        <div class="sess-launch-title">${escHtml(name)}${focus ? `<span class="sess-launch-focus"> · ${escHtml(focus)}</span>` : ""}</div>
        ${meta ? `<div class="sess-launch-meta">${escHtml(meta)}</div>` : ""}
        ${journeyLine ? `<div class="sess-launch-journey">${journeyLine}</div>` : ""}
      </div>
      <span class="sess-launch-cta">${cta} <span class="sess-launch-arrow" aria-hidden="true">→</span></span>
    </button>`;
}

function sessionShellHtml(inner: string, meta: {
  fresh: boolean;
  kicker: string;
  dayName: string;
  dayFocus: string;
  exDone: number;
  exTotal: number;
}): string {
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
        <div class="sess-dayname">${escHtml(meta.dayName)}${meta.dayFocus ? `<span class="sess-focus"> · ${escHtml(meta.dayFocus)}</span>` : ""}</div>
      </div>
      <div class="sess-topbar-side">${prog}</div>
    </div>
    ${dots}
    <div class="sess-body">${inner}</div>
  </div>`;
}

function wireSessionDestination(): void {
  const close = view.querySelector<HTMLButtonElement>("#sessClose");
  if (close && !close.dataset.wired) {
    close.dataset.wired = "1";
    close.addEventListener("click", () => { todayState.planReveal = undefined; activateTab("today"); });
  }
  view.querySelectorAll<HTMLElement>(".sess-dest .daybtn").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => {
      todayState.day = Number(btn.dataset.day);
      (todayState as { dayPicked?: boolean }).dayPicked = true;
      sessionFreshNext = true;
      void renderSession();
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
  if (profile) { setDiscipline(profile.primary_discipline); setEnduranceGoalSet(!!profile.endurance_goal_json); }
  todayState.exModes = Object.fromEntries(exercises.map((e: any) => [e.name, e.mode || "reps"]));

  const day = prep.day;
  const hasLoggedSets = !!(session && (session.sets || []).length);
  const hasGarmin = !!(session && session.garmin);
  const isFinished = !!(session && session.finished_at);
  const revealOn = !!(todayState.planReveal && todayState.planReveal.date === todayState.logDate && todayState.planReveal.on);
  const showDone = isFinished && !revealOn;
  const showPlan = !showDone;

  const surface = todayPlanSurfaceRenderer.buildHtml({
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
    prefillFor: prep.prefillFor,
    rxFor: prep.rxFor,
  }, todayPlanSurfaceRendererDeps());

  const dayName = day && day.name ? String(day.name) : (prep.isRunDay ? "Today's run" : "Session");
  const dayFocus = day && day.focus ? String(day.focus) : "";
  const kicker = isToday ? "TODAY · SESSION" : (typeof humanDate === "function" ? humanDate(todayState.logDate) : todayState.logDate);

  // Same stale-render bail as renderToday: the loads above can outlast leaving
  // the Session destination, and this paint must never land on another tab.
  if (todayState.tab !== "session" || todayState.logDate !== enteredDate) return;
  todayView.innerHTML = sessionShellHtml(surface, {
    fresh,
    kicker,
    dayName,
    dayFocus,
    exDone: prep.exDone,
    exTotal: prep.exTotal,
  });

  // Calm: no mid-workout "apply these targets to my plan" banner in the focused
  // surface — the brain's proposals stay on Today. (Per-lift adapted target lines
  // still render; refreshAdaptedRx is already a no-op here since tab !== "today".)
  todayView.querySelector(".sess-dest .rx-banner")?.remove();

  CairnTodaySessionController.wireSessionSurface({ session, hasLoggedSets, lastSets: prep.lastSets }, todaySessionDeps());
  setupAddExercise();
  wireGuides(view);
  wireSessionDestination();

  if (fresh) { try { window.scrollTo(0, 0); } catch {} }
  else { try { window.scrollTo(0, prevY); } catch {} }
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

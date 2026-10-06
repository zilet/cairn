// @ts-check
// Horizon -> Race (the Plan view's endurance section) renderers plus the running-plan
// screen orchestration. This is the one home for runs: every run it shows comes from
// the run endpoints (/run-plan, /training-agenda, /race-build, /run-compliance), never
// the lift plan.

type EnduranceGoalRow = import("../contracts/client-api.js").ClientEnduranceGoal;
type EnduranceComplianceRow = import("../contracts/client-api.js").ClientRunCompliance;
type EnduranceAgenda = import("../contracts/client-api.js").ClientFlexibleTrainingAgenda;
type EnduranceRaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
type EnduranceRunPlan = import("../contracts/client-api.js").ClientWeeklyRunPlan;

type EndurancePaintExtra = {
  runPlan?: EnduranceRunPlan | null;
  nextAgenda?: EnduranceAgenda | null;
  nextRunPlan?: EnduranceRunPlan | null;
  nextRaceBuild?: EnduranceRaceBuild | null;
  laterAgenda?: EnduranceAgenda | null;
  laterRunPlan?: EnduranceRunPlan | null;
  laterRaceBuild?: EnduranceRaceBuild | null;
  today?: string;
  units?: "km" | "mi";
  /** Cairn was out of reach for some read: an empty week is unknown, not "no runs". */
  unreachable?: boolean;
};

type EnduranceProposal = {
  id?: unknown;
  agent?: unknown;
  parsed?: {
    summary?: unknown;
    cardio?: unknown[];
  } | null;
};

type EnduranceBusyElement = Element & { _busyRestore?: () => void };

(() => {
const enduranceModel = () => CairnPlanEnduranceModel;

async function renderPlanEndurance(): Promise<void> {
  // The race view in depth lives under Horizon (/app/horizon/race): it wears "Race"
  // and steps back to the timeline, whose race lane summarises it.
  headerTitle.textContent = "Race";
  state.planSeg = "endurance";
  view.innerHTML = horizonBackHtml() + `<div id="endPlanBody">${loadingState("Reading your running…")}</div>`;
  wireHorizonBack(view);
  const token = ++pollToken;
  const today = localISO();
  const nextMonday = enduranceModel().nextMonday(today);
  const laterMonday = nextMonday ? enduranceModel().nextMonday(nextMonday) : "";
  // Network-first reads that fall back to the last-known answer only when Cairn is
  // out of reach (CairnOffline), so an offline open never reads as a fresh install.
  let unreachable = false;
  let fromLastKnown = false;
  let goalKnown = false;
  const lastKnown = async <T,>(path: string, key: string): Promise<T | null> => {
    if (typeof CairnOffline === "undefined") return (await api(path).catch(() => null)) as T | null;
    const read = await CairnOffline.read<T>(path, key);
    if (read.unreachable) unreachable = true;
    if (read.source === "last-known") fromLastKnown = true;
    if (key === "horizon:endurance-goal" && read.source !== "none") goalKnown = true;
    return read.data;
  };
  let goal: EnduranceGoalRow | null = null;
  let compliance: EnduranceComplianceRow | null = null;
  let agenda: EnduranceAgenda | null = null;
  let settings: Record<string, unknown> | null = null;
  let raceBuild: EnduranceRaceBuild | null = null;
  let runPlan: EnduranceRunPlan | null = null;
  let nextAgenda: EnduranceAgenda | null = null;
  let nextRunPlan: EnduranceRunPlan | null = null;
  let nextRaceBuild: EnduranceRaceBuild | null = null;
  let laterAgenda: EnduranceAgenda | null = null;
  let laterRunPlan: EnduranceRunPlan | null = null;
  let laterRaceBuild: EnduranceRaceBuild | null = null;
  // One trip for the whole screen: /horizon-race answers every read below, keyed by
  // the path each one asks with, and primes the request layer (apiPrime). A read the
  // fan-in came back without still asks for itself.
  try {
    const mondays = [nextMonday, laterMonday].filter(Boolean);
    const q = encodeURIComponent;
    const paths = [
      "/endurance-goal",
      "/run-compliance",
      `/training-agenda?date=${q(today)}`,
      "/settings",
      "/race-build",
      "/run-plan",
      ...mondays.flatMap((d) => [`/training-agenda?date=${q(d)}`, `/run-plan?date=${q(d)}`, `/race-build?date=${q(d)}`]),
    ];
    apiPrime(
      paths,
      api(`/horizon-race?dates=${mondays.map(q).join(",")}` as "/horizon-race").then(
        (value) => (value as { responses?: unknown } | null)?.responses ?? null
      )
    );
  } catch { /* each read below asks for itself */ }
  try {
    [goal, compliance, agenda, settings, raceBuild, runPlan, nextAgenda, nextRunPlan, nextRaceBuild, laterAgenda, laterRunPlan, laterRaceBuild] = await Promise.all([
      lastKnown<EnduranceGoalRow>("/endurance-goal", "horizon:endurance-goal"),
      api("/run-compliance").catch(() => null),
      lastKnown<EnduranceAgenda>(`/training-agenda?date=${encodeURIComponent(today)}`, `horizon:agenda:${today}`),
      api("/settings").then((response) => (enduranceModel().record(response).settings as Record<string, unknown> | null) || null).catch(() => null),
      lastKnown<EnduranceRaceBuild>("/race-build", "horizon:race-build"),
      lastKnown<EnduranceRunPlan>("/run-plan", "horizon:run-plan"),
      nextMonday ? api(`/training-agenda?date=${encodeURIComponent(nextMonday)}`).catch(() => null) : Promise.resolve(null),
      nextMonday ? api(`/run-plan?date=${encodeURIComponent(nextMonday)}`).catch(() => null) : Promise.resolve(null),
      nextMonday ? api(`/race-build?date=${encodeURIComponent(nextMonday)}`).catch(() => null) : Promise.resolve(null),
      laterMonday ? api(`/training-agenda?date=${encodeURIComponent(laterMonday)}`).catch(() => null) : Promise.resolve(null),
      laterMonday ? api(`/run-plan?date=${encodeURIComponent(laterMonday)}`).catch(() => null) : Promise.resolve(null),
      laterMonday ? api(`/race-build?date=${encodeURIComponent(laterMonday)}`).catch(() => null) : Promise.resolve(null),
    ]);
  } catch { /* paint with whatever resolved */ }
  if (token !== pollToken || !view.querySelector("#endPlanBody")) return;
  // Out of reach with no remembered goal: "No goal set yet" / "No runs waiting"
  // would be a lie about a real race build, so say what is true instead.
  if (unreachable && !goalKnown) {
    const body = view.querySelector("#endPlanBody");
    if (body) {
      body.innerHTML = CairnOffline.unreachableHtml({ body: "Your race build and runs fill in as soon as it's back." });
      CairnOffline.wireRetry(body, () => renderPlanEndurance());
    }
    return;
  }
  const units = typeof runUnits === "function" ? runUnits(settings?.run_units) : (settings?.run_units === "mi" ? "mi" : "km");
  paintPlanEndurance(goal, compliance, agenda, settings, raceBuild, {
    runPlan,
    nextAgenda,
    nextRunPlan,
    nextRaceBuild,
    laterAgenda,
    laterRunPlan,
    laterRaceBuild,
    today,
    units,
    unreachable,
  });
  if (unreachable && fromLastKnown) view.querySelector("#endPlanBody")?.insertAdjacentHTML("afterbegin", CairnOffline.lastKnownHtml());
}

function paintPlanEndurance(
  goalValue: EnduranceGoalRow | null,
  compliance: EnduranceComplianceRow | null,
  agenda: EnduranceAgenda | null,
  settings: Record<string, unknown> | null,
  raceBuild?: EnduranceRaceBuild | null,
  extra?: EndurancePaintExtra | null,
): void {
  const body = view.querySelector("#endPlanBody");
  if (!body) return;
  _endDrafting = false;

  const goal = goalValue;
  const today = extra?.today || (typeof localISO === "function" ? localISO() : "");
  const units = extra?.units || (typeof runUnits === "function" ? runUnits(settings?.run_units) : "km");
  const briefing = enduranceModel().buildBriefing({
    today,
    units,
    agenda,
    runPlan: extra?.runPlan,
    raceBuild,
    nextAgenda: extra?.nextAgenda,
    nextRunPlan: extra?.nextRunPlan,
    nextRaceBuild: extra?.nextRaceBuild,
    laterAgenda: extra?.laterAgenda,
    laterRunPlan: extra?.laterRunPlan,
    laterRaceBuild: extra?.laterRaceBuild,
  });
  // This week's runs for the THIS WEEK card (the race view's, or the plain one for a
  // runner with no race), what was run first; next week is its own section.
  const weekModel = typeof CairnRaceWeekRuns !== "undefined" ? CairnRaceWeekRuns : null;
  const runs = weekModel ? weekModel.weekRuns(raceBuild ?? null, agenda, units) : null;
  const sessionsHtml = CairnPlanEnduranceBriefing.sessionsHtml(briefing, { runs, today });
  const nextWeekHtml = CairnPlanEnduranceBriefing.nextWeekHtml(briefing, {
    figure: weekModel ? weekModel.nextWeekText(raceBuild ?? null, units) : "",
    today,
  });
  // The race view is the primary race surface (race-view-*): the race, THIS WEEK, the
  // build week by week, how the lifting fits, the finish estimate. A failed read still
  // mounts it for a race goal, so it can say so and try again.
  const showRace = enduranceModel().showsRaceView(goal, raceBuild);
  // With no race, THIS WEEK still stands: the week's volume from the run engine and the
  // runs by weekday — never an empty ladder or an estimate with nothing behind it.
  const plainWeek =
    showRace || typeof CairnRaceView === "undefined"
      ? ""
      : CairnRaceView.thisWeekHtml(CairnRaceViewModel.thisWeekModel(raceBuild ?? null, units, { agenda }), {
          sessionsHtml,
          focus: CairnRaceViewModel.runWords(briefing.headline, units),
          units,
        });
  const goalHtml = showRace
    ? ""
    : goal
      ? `<div class="card-stack-item end-goal-row">${typeof enduranceGoalCard === "function" ? enduranceGoalCard(goal, { units }) : ""}</div>`
      : `<div class="end-goal card-stack-item reveal" style="${stagger(0)}">
         <div class="end-goal-head"><span class="lbl">Running</span></div>
         <div class="end-goal-name">No race on the calendar</div>
         <div class="end-goal-sub">Set a dated race or a standing distance in <b>You → Profile</b> and the coach builds your running toward it.</div>
       </div>`;
  // The race view's own ladder supersedes the generic "typical arc" ramp
  // placeholder — show one or the other, never both.
  const rampHtml = showRace ? "" : rampHtmlForGoal(goal);
  const standingNote = goal && goal.mode === "standing"
    ? `<div class="end-ramp-note reveal" style="${stagger(1)}"><span class="lbl">Steady readiness</span> — no race to peak for, so the plan holds a sustainable rhythm rather than ramping.${goal.weekly_km ? ` Target around <b>${escHtml(typeof fmtDist === "function" ? fmtDist(goal.weekly_km, units) : `${goal.weekly_km} km`)}/wk</b>.` : ""}</div>`
    : "";

  const emptyHtml = !showRace && !plainWeek
    ? `<div class="end-runs-empty card-stack-item reveal" style="${stagger(2)}">
         <div class="lbl">Upcoming runs</div>
         <p>${extra?.unreachable ? "Can't reach Cairn right now — your upcoming runs fill in as soon as it's back." : "No runs waiting. Ask at the bottom if you want the coach to shape the next week around your lifting."}</p>
       </div>`
    : "";
  const syncHtml = typeof cardioSyncLine === "function" ? cardioSyncLine(settings, {}) : "";

  const presets = enduranceModel().presets(goal);
  const chips = presets.map((preset, index) => `<button class="end-chip" data-egi="${index}">${escHtml(preset.t)}</button>`).join("");
  const composer = `<details class="end-shape-fold card-stack-item reveal" style="${stagger(4)}">
      <summary><span class="lbl">Shape this week's runs</span></summary>
      <div class="end-shape">
        <p class="end-shape-sub">Tell the coach what you want — it picks it up in chat, where it can move your run days and read how you're doing. Your lifting plan is never touched.</p>
        <div class="end-chips">${chips}</div>
        <textarea id="endInstr" class="form-textarea" rows="2" placeholder="e.g. ease my long run, my knee's cranky — or find a tempo opening later this week"></textarea>
        <button id="endDraftBtn" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ASK THE COACH</button>
        <div id="endDraftStatus" class="end-shape-status"></div>
        <div id="endDraft"></div>
      </div>
    </details>`;

  body.innerHTML =
    `<div class="card-stack">` +
    goalHtml +
    (showRace ? `<div id="endRaceSlot" class="card-stack-item"></div>` : "") +
    (plainWeek ? `<div class="card-stack-item">${plainWeek}</div>` : "") +
    (plainWeek && nextWeekHtml ? `<div class="card-stack-item">${nextWeekHtml}</div>` : "") +
    emptyHtml +
    (rampHtml ? `<div class="card-stack-item">${rampHtml}</div>` : "") +
    (standingNote ? `<div class="card-stack-item">${standingNote}</div>` : "") +
    composer +
    `<div id="endUpcomingSlot" class="card-stack-item"></div>` +
    (syncHtml ? `<div class="card-stack-item">${syncHtml}</div>` : "") +
    `</div>`;

  if (typeof loadPlanUpcomingNote === "function") loadPlanUpcomingNote(pollToken, "#endUpcomingSlot");
  const raceSlot = body.querySelector("#endRaceSlot");
  if (raceSlot && typeof CairnRaceViewController !== "undefined") {
    CairnRaceViewController.mount(raceSlot, {
      initial: raceBuild ?? null,
      load: () => api("/race-build"),
      units,
      sessionsHtml,
      nextWeekHtml,
      agenda,
      reducedMotion: () => (typeof reducedMotion === "function" ? reducedMotion() : false),
    });
  }

  if (syncHtml && typeof wireCardioSync === "function") wireCardioSync(body, () => renderPlanEndurance());
  body.querySelectorAll<HTMLElement>(".end-chip").forEach((button) => button.addEventListener("click", () => {
    const preset = presets[Number(button.dataset.egi) || 0];
    if (preset) draftEnduranceRuns(preset.i);
  }));
  body.querySelector("#endDraftBtn")?.addEventListener("click", () => {
    const instruction = (body.querySelector<HTMLTextAreaElement>("#endInstr")?.value || "").trim();
    draftEnduranceRuns(instruction || presets[0].i);
  });
}

function rampHtmlForGoal(goal: EnduranceGoalRow | null): string {
  return enduranceModel().rampHtml(goal);
}

let _endDrafting = false;

function enduranceComposerLock(): void {
  _endDrafting = true;
  view.querySelectorAll<HTMLButtonElement>(".end-chip").forEach((chip) => { chip.disabled = true; });
}

function enduranceComposerRestore(): void {
  view.querySelectorAll<HTMLButtonElement>(".end-chip").forEach((chip) => { chip.disabled = false; });
  (view.querySelector("#endDraftBtn") as EnduranceBusyElement | null)?._busyRestore?.();
  _endDrafting = false;
}

// Runs are not plan items, so a plan proposal can no longer carry them: the run
// request goes to chat, which can move the stated run days (set_endurance_schedule)
// and talk the week through. The draft/apply card below only ever renders an older
// proposal that already exists.
function draftEnduranceRuns(instruction: unknown): void {
  if (_endDrafting) return;
  const text = String(instruction || "").trim().slice(0, 600);
  const g = globalThis as unknown as {
    state?: { chatPrefill?: string | null };
    activateTab?: (name: string) => unknown;
  };
  if (g.state) g.state.chatPrefill = text;
  if (typeof g.activateTab === "function") g.activateTab("chat");
}

function enduranceProposalOpOpts(): ClientAgentOpHandlers {
  return {
    path: "/agent/run",
    anchor: "#endDraftStatus",
    caption: "endurance_runs",
    guard: () => !view.querySelector("#endDraftStatus")?.isConnected,
    isFail: (result) => {
      const row = enduranceModel().record(result);
      const proposal = enduranceModel().record(row.proposal);
      return !result || row.ok === false || !row.proposal || !proposal.parsed;
    },
    render: (result) => renderEnduranceDraftResult(enduranceModel().record(result).proposal),
    onFail: (error) => {
      enduranceComposerRestore();
      const status = view.querySelector("#endDraftStatus");
      if (!status) return;
      status.textContent = enduranceModel().record(error).agent_status === "unconfigured"
        ? "Drafting runs needs a coaching agent — connect one in Settings."
        : "The coach couldn't finish — try again, or pick another agent in Settings.";
    },
  };
}

function renderEnduranceDraftResult(proposal: unknown): void {
  enduranceComposerRestore();
  const status = view.querySelector("#endDraftStatus");
  const draftWrap = view.querySelector("#endDraft");
  if (!status || !draftWrap) return;
  const p = enduranceModel().record(proposal) as EnduranceProposal;
  const cardio = p.parsed && Array.isArray(p.parsed.cardio) ? p.parsed.cardio : [];
  if (!cardio.length) {
    status.innerHTML = `The coach proposed plan changes but no runs this time. <button class="linkbtn end-link" id="endToCoach">Review in Changes →</button>`;
    status.querySelector("#endToCoach")?.addEventListener("click", () => {
      state.planSeg = "coach";
      state.planJump = "coach";
      activateTab("plan");
    });
    return;
  }
  status.textContent = "";
  draftWrap.innerHTML = enduranceModel().draftCardHtml(p);
  draftWrap.querySelector<HTMLElement>("[data-egapply]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget instanceof Element ? event.currentTarget as HTMLElement : null;
    if (!button) return;
    await applyProposalById(button.dataset.egapply, button);
    renderPlanEndurance();
  });
  draftWrap.querySelector<HTMLElement>("[data-egdiscard]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    try { await api(`/proposals/${button?.dataset.egdiscard}/discard`, { method: "POST" }); } catch {}
    draftWrap.innerHTML = "";
    status.textContent = "Discarded.";
  });
}

const CAIRN_PLAN_ENDURANCE = enduranceModel();

Object.assign(globalThis, { CairnPlanEndurance: CAIRN_PLAN_ENDURANCE });
Object.assign(globalThis, {
  renderPlanEndurance,
  paintPlanEndurance,
  enduranceComposerLock,
  enduranceComposerRestore,
  draftEnduranceRuns,
  enduranceProposalOpOpts,
  renderEnduranceDraftResult,
});

if (typeof window !== "undefined") {
  window.CairnPlanEndurance = CAIRN_PLAN_ENDURANCE;
  Object.assign(window, {
    renderPlanEndurance,
    paintPlanEndurance,
    enduranceComposerLock,
    enduranceComposerRestore,
    draftEnduranceRuns,
    enduranceProposalOpOpts,
    renderEnduranceDraftResult,
  });
}
})();

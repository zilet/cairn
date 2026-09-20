// @ts-check
// Plan -> Endurance renderers plus the running-plan screen orchestration.

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
  today?: string;
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
  headerTitle.textContent = "Plan";
  state.planSeg = "endurance";
  view.innerHTML = segBar("endurance", planSeg()) + `<div id="endPlanBody">${loadingState("Reading your running…")}</div>`;
  wireSeg(PLAN_HANDLERS);
  const token = ++pollToken;
  const today = localISO();
  const nextMonday = enduranceModel().nextMonday(today);
  let goal: EnduranceGoalRow | null = null;
  let compliance: EnduranceComplianceRow | null = null;
  let agenda: EnduranceAgenda | null = null;
  let plan: unknown = [];
  let settings: Record<string, unknown> | null = null;
  let raceBuild: EnduranceRaceBuild | null = null;
  let runPlan: EnduranceRunPlan | null = null;
  let nextAgenda: EnduranceAgenda | null = null;
  let nextRunPlan: EnduranceRunPlan | null = null;
  let nextRaceBuild: EnduranceRaceBuild | null = null;
  try {
    [goal, compliance, agenda, plan, settings, raceBuild, runPlan, nextAgenda, nextRunPlan, nextRaceBuild] = await Promise.all([
      api("/endurance-goal").catch(() => null),
      api("/run-compliance").catch(() => null),
      api(`/training-agenda?date=${encodeURIComponent(today)}`).catch(() => null),
      api("/plan").catch(() => []),
      api("/settings").then((response) => (enduranceModel().record(response).settings as Record<string, unknown> | null) || null).catch(() => null),
      api("/race-build").catch(() => null),
      api("/run-plan").catch(() => null),
      nextMonday ? api(`/training-agenda?date=${encodeURIComponent(nextMonday)}`).catch(() => null) : Promise.resolve(null),
      nextMonday ? api(`/run-plan?date=${encodeURIComponent(nextMonday)}`).catch(() => null) : Promise.resolve(null),
      nextMonday ? api(`/race-build?date=${encodeURIComponent(nextMonday)}`).catch(() => null) : Promise.resolve(null),
    ]);
  } catch { /* paint with whatever resolved */ }
  if (token !== pollToken || !view.querySelector("#endPlanBody")) return;
  paintPlanEndurance(goal, compliance, agenda, plan, settings, raceBuild, {
    runPlan,
    nextAgenda,
    nextRunPlan,
    nextRaceBuild,
    today,
  });
}

function paintPlanEndurance(
  goalValue: EnduranceGoalRow | null,
  compliance: EnduranceComplianceRow | null,
  agenda: EnduranceAgenda | null,
  plan: unknown,
  settings: Record<string, unknown> | null,
  raceBuild?: EnduranceRaceBuild | null,
  extra?: EndurancePaintExtra | null,
): void {
  const body = view.querySelector("#endPlanBody");
  if (!body) return;
  _endDrafting = false;

  const goal = goalValue;
  const today = extra?.today || (typeof localISO === "function" ? localISO() : "");
  const briefing = enduranceModel().buildBriefing({
    today,
    agenda,
    runPlan: extra?.runPlan,
    raceBuild,
    nextAgenda: extra?.nextAgenda,
    nextRunPlan: extra?.nextRunPlan,
    nextRaceBuild: extra?.nextRaceBuild,
  });
  const liveRaceBuild = briefing.horizon === "next_week" ? (extra?.nextRaceBuild || raceBuild) : raceBuild;
  const briefingHtml = enduranceModel().briefingHtml(briefing, 0);
  const goalHtml = goal
    ? `<div class="card-stack-item">${enduranceGoalCard(goal)}</div>`
    : `<div class="end-goal card-stack-item reveal" style="${stagger(0)}">
         <div class="end-goal-head"><span class="lbl">Running goal</span></div>
         <div class="end-goal-name">No goal set yet</div>
         <div class="end-goal-sub">Set a race or a standing readiness target in <b>Settings → You → Profile</b> and the coach will periodize your running toward it.</div>
       </div>`;

  const raceBuildHtml = liveRaceBuild && liveRaceBuild.available !== false && liveRaceBuild.race && typeof raceBuildCard === "function"
    ? raceBuildCard(liveRaceBuild, { underGoal: true, legMap: typeof loadPlanWeekStrip !== "function", compact: true })
    : "";
  // The race build's own week-by-week ladder supersedes the generic "typical
  // arc" ramp placeholder — show one or the other, never both.
  const rampHtml = raceBuildHtml ? "" : rampHtmlForGoal(goal);
  const standingNote = goal && goal.mode === "standing"
    ? `<div class="end-ramp-note reveal" style="${stagger(1)}"><span class="lbl">Steady readiness</span> — no race to peak for, so the plan holds a sustainable rhythm rather than ramping.${goal.weekly_km ? ` Target around <b>${escHtml(goal.weekly_km)} km/wk</b>.` : ""}</div>`
    : "";

  const templateRuns = enduranceModel().runs(plan);
  const emptyHtml = !briefing.next && !briefing.remaining.length
    ? `<div class="end-runs-empty card-stack-item reveal" style="${stagger(2)}">
         <div class="lbl">Upcoming runs</div>
         <p>${templateRuns.length
           ? "No open run this week. The week strip above is the hybrid picture; shape the next week below, or edit the template in Training."
           : "No runs waiting. The week strip above is the hybrid picture; ask below if you want the coach to shape the next week around your lifting."}</p>
       </div>`
    : "";
  const complianceHtml = typeof runComplianceLine === "function" ? runComplianceLine(compliance) : "";
  const syncHtml = typeof cardioSyncLine === "function" ? cardioSyncLine(settings, {}) : "";

  const presets = enduranceModel().presets(goal);
  const chips = presets.map((preset, index) => `<button class="end-chip" data-egi="${index}">${escHtml(preset.t)}</button>`).join("");
  const composer = `<details class="end-shape-fold card-stack-item reveal" style="${stagger(4)}">
      <summary><span class="lbl">Shape this week's runs</span></summary>
      <div class="end-shape">
        <p class="end-shape-sub">Tell the coach what you want — it drafts run prescriptions you review and apply. Your lifting plan is never touched. <button class="linkbtn end-link" id="endEditRuns">Edit in Training →</button></p>
        <div class="end-chips">${chips}</div>
        <textarea id="endInstr" class="form-textarea" rows="2" placeholder="e.g. ease my long run, my knee's cranky — or find a tempo opening later this week"></textarea>
        <button id="endDraftBtn" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ASK THE COACH</button>
        <div id="endDraftStatus" class="end-shape-status"></div>
        <div id="endDraft"></div>
      </div>
    </details>`;

  body.innerHTML =
    `<div class="card-stack">` +
    `<div id="endWeekSlot" class="card-stack-item"></div>` +
    `<div id="endUpcomingSlot" class="card-stack-item"></div>` +
    briefingHtml +
    emptyHtml +
    goalHtml +
    (raceBuildHtml ? `<div class="card-stack-item">${raceBuildHtml}</div>` : "") +
    (rampHtml ? `<div class="card-stack-item">${rampHtml}</div>` : "") +
    (standingNote ? `<div class="card-stack-item">${standingNote}</div>` : "") +
    (complianceHtml ? `<div class="card-stack-item">${complianceHtml}</div>` : "") +
    composer +
    (syncHtml ? `<div class="card-stack-item">${syncHtml}</div>` : "") +
    `</div>`;

  // Same connected week strip Strength shows — one projection, both Plan segments.
  if (typeof loadPlanWeekStrip === "function") loadPlanWeekStrip(pollToken, "#endWeekSlot");
  // The same calm forward look the Plan edit segment shows — a reshaped/lighter
  // week announces itself here too (running changes are ledgered under the
  // 'training' domain, so there's no separate 'running' filter to apply).
  if (typeof loadPlanUpcomingNote === "function") loadPlanUpcomingNote(pollToken, "#endUpcomingSlot");

  body.querySelector("#endEditRuns")?.addEventListener("click", () => renderPlanEditor());
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

function draftEnduranceRuns(instruction: unknown): void {
  if (_endDrafting) return;
  enduranceComposerLock();
  const button = view.querySelector("#endDraftBtn");
  if (button) btnBusy(button, "Asking…");
  const status = view.querySelector("#endDraftStatus");
  if (status) status.innerHTML = CairnUi.jobCaptionHtml();
  const draftWrap = view.querySelector("#endDraft");
  if (draftWrap) draftWrap.innerHTML = "";
  runOp("proposal", { agent: "auto", instruction: String(instruction || "") }, enduranceProposalOpOpts());
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
        ? "Drafting runs needs a coaching agent — connect one in Settings. You can still edit runs in Training."
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
    status.innerHTML = `The coach proposed plan changes but no runs this time. <button class="linkbtn end-link" id="endToCoach">Review in Coach →</button>`;
    status.querySelector("#endToCoach")?.addEventListener("click", () => renderCoach());
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

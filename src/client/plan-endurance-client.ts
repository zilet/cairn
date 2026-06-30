// @ts-check
// Plan -> Endurance renderers plus the running-plan screen orchestration.

type EnduranceGoalRow = {
  mode?: unknown;
  phase?: unknown;
};

type EnduranceProposalRun = {
  day_number?: unknown;
  label?: unknown;
  exercise?: unknown;
  reason?: unknown;
  note?: unknown;
};

type EnduranceProposal = {
  id?: unknown;
  agent?: unknown;
  parsed?: {
    summary?: unknown;
    cardio?: EnduranceProposalRun[];
  } | null;
};

type EndurancePreset = {
  t: string;
  i: string;
};

type EndurancePlanDay = {
  day_number?: unknown;
  items?: Array<Record<string, unknown>>;
};

type EnduranceRunRow = {
  it: Record<string, unknown>;
  day_number: unknown;
};

type EnduranceBusyElement = Element & { _busyRestore?: () => void };

(() => {
const ENDURANCE_PHASES = [
  { key: "base", label: "Base", when: "11+ weeks out", desc: "Build aerobic volume — easy, conversational running." },
  { key: "build", label: "Build", when: "5–10 weeks out", desc: "Add tempo and longer runs; raise the ceiling." },
  { key: "sharpen", label: "Sharpen", when: "3–4 weeks out", desc: "Race-pace work as volume trims back." },
  { key: "taper", label: "Taper", when: "final 2 weeks", desc: "Freshen up — let the training surface." },
] as const;

function enduranceRampHtml(goal: EnduranceGoalRow | null | undefined): string {
  if (!goal || goal.mode !== "race" || !goal.phase || goal.phase === "past") return "";
  const curIdx = ENDURANCE_PHASES.findIndex((phase) => phase.key === goal.phase);
  if (curIdx < 0) return "";
  const steps = ENDURANCE_PHASES.map((phase, index) => {
    const cls = index < curIdx ? "is-done" : index === curIdx ? "is-current" : "is-next";
    const here = index === curIdx ? `<span class="ramp-here lbl">You're here</span>` : "";
    return `<li class="ramp-step ${cls}">
        <span class="ramp-dot" aria-hidden="true"></span>
        <div class="ramp-body">
          <div class="ramp-top"><span class="ramp-name">${escHtml(phase.label)}</span><span class="ramp-when lbl">${escHtml(phase.when)}</span>${here}</div>
          <div class="ramp-desc">${escHtml(phase.desc)}</div>
        </div>
      </li>`;
  }).join("");
  return `<div class="end-ramp reveal" style="${stagger(1)}">
      <div class="end-ramp-h"><span class="lbl">The ramp to race day</span></div>
      <ol class="ramp-list">${steps}</ol>
      <p class="end-ramp-cap">A typical arc — the coach adapts each phase to the running you've actually banked, not a fixed schedule.</p>
    </div>`;
}

function endurancePresets(goal: EnduranceGoalRow | null | undefined): EndurancePreset[] {
  const out = [{ t: "Plan this week's runs", i: "Plan my runs for this coming week toward my running goal — concrete sessions (easy / long / tempo or intervals) on specific days, conservative and aerobic-first." }];
  if (goal && goal.mode === "race") {
    out.push({ t: "Progress my long run", i: "Gently progress my long run this week toward my race, keeping it easy and aerobic — no more than about a 10% step up." });
    out.push({ t: "Ease back — feeling flat", i: "I'm feeling flat and a bit run-down. Ease my running this week — hold or reduce volume, keep it easy, protect recovery." });
  } else {
    out.push({ t: "Keep me race-ready", i: "Plan a steady week of running that keeps me ready for my standing distance goal — maintain, don't peak." });
    out.push({ t: "Ease back this week", i: "Ease my running this week — keep it light and easy, I want to recover." });
  }
  return out;
}

function endDraftCardHtml(proposal: EnduranceProposal): string {
  const cardio = proposal.parsed && Array.isArray(proposal.parsed.cardio) ? proposal.parsed.cardio : [];
  const rows = cardio.map((run) =>
    `<div class="sess-line run-line"><span class="run-pin" aria-hidden="true">▸</span><b>D${escHtml(run.day_number)} ${escHtml(run.label || run.exercise || "Run")}</b> <span class="numeral">${escHtml(runTargetText(run))}</span>${(run.reason || run.note) ? ` <span style="color:var(--muted)">(${escHtml(run.reason || run.note)})</span>` : ""}</div>`
  ).join("");
  return `<div class="mp-card end-draft-card reveal">
      <div class="mp-hero"><span class="lbl">Proposed runs · ${escHtml(proposal.agent)} · #${escHtml(proposal.id)}</span></div>
      ${proposal.parsed && proposal.parsed.summary ? `<div class="sess-line">${escHtml(proposal.parsed.summary)}</div>` : ""}
      ${rows}
      <div class="logrow" style="margin-top:10px">
        <button class="logbtn" style="width:auto;padding:0 16px;font-size:.85rem" data-egapply="${escAttr(proposal.id)}">APPLY TO MY PLAN</button>
        <button class="ghostbtn" style="width:auto;padding:0 14px" data-egdiscard="${escAttr(proposal.id)}">DISCARD</button>
      </div>
    </div>`;
}

function enduranceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function endurancePlanRows(value: unknown): EndurancePlanDay[] {
  return Array.isArray(value) ? value.filter((row): row is EndurancePlanDay => !!row && typeof row === "object") : [];
}

function enduranceGoalRecord(value: unknown): (EnduranceGoalRow & Record<string, unknown>) | null {
  const row = enduranceRecord(value) as EnduranceGoalRow & Record<string, unknown>;
  return row.mode ? row : null;
}

function enduranceRuns(plan: unknown): EnduranceRunRow[] {
  const runs: EnduranceRunRow[] = [];
  for (const day of endurancePlanRows(plan)) {
    const items = Array.isArray(day.items) ? day.items : [];
    for (const item of items) {
      if (isCardioItem(item)) runs.push({ it: item, day_number: day.day_number });
    }
  }
  return runs;
}

async function renderPlanEndurance(): Promise<void> {
  headerTitle.textContent = "Plan";
  state.planSeg = "endurance";
  view.innerHTML = segBar("endurance", planSeg()) + `<div id="endPlanBody">${loadingState("Reading your running…")}</div>`;
  wireSeg(PLAN_HANDLERS);
  const token = ++pollToken;
  let goal: unknown = null;
  let compliance: unknown = null;
  let plan: unknown = [];
  let settings: Record<string, unknown> | null = null;
  try {
    [goal, compliance, plan, settings] = await Promise.all([
      api("/endurance-goal").catch(() => null),
      api("/run-compliance").catch(() => null),
      api("/plan").catch(() => []),
      api("/settings").then((response) => (enduranceRecord(response).settings as Record<string, unknown> | null) || null).catch(() => null),
    ]);
  } catch { /* paint with whatever resolved */ }
  if (token !== pollToken || !view.querySelector("#endPlanBody")) return;
  paintPlanEndurance(goal, compliance, plan, settings);
}

function paintPlanEndurance(goalValue: unknown, compliance: unknown, plan: unknown, settings: Record<string, unknown> | null): void {
  const body = view.querySelector("#endPlanBody");
  if (!body) return;
  _endDrafting = false;

  const goal = enduranceGoalRecord(goalValue);
  const goalHtml = goal
    ? enduranceGoalCard(goal)
    : `<div class="end-goal reveal" style="${stagger(0)}">
         <div class="end-goal-head"><span class="lbl">Running goal</span></div>
         <div class="end-goal-name">No goal set yet</div>
         <div class="end-goal-sub">Set a race or a standing readiness target in <b>Me → Profile</b> and the coach will periodize your running toward it.</div>
       </div>`;

  const rampHtml = rampHtmlForGoal(goal);
  const standingNote = goal && goal.mode === "standing"
    ? `<div class="end-ramp-note reveal" style="${stagger(1)}"><span class="lbl">Steady readiness</span> — no race to peak for, so the plan holds a sustainable rhythm rather than ramping.${goal.weekly_km ? ` Target around <b>${escHtml(goal.weekly_km)} km/wk</b>.` : ""}</div>`
    : "";

  const runs = enduranceRuns(plan);
  const totalKm = runs.reduce((sum, { it }) => sum + (Number(it.target_distance_km) || 0), 0);
  const totalMin = runs.reduce((sum, { it }) => sum + (Number(it.target_duration_min) || 0), 0);
  let volumeText = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
  if (totalKm > 0) volumeText += ` · ${fmtKm(totalKm)} km planned`;
  else if (totalMin > 0) volumeText += ` · ${Math.round(totalMin)} min planned`;
  if (totalKm > 0 && goal && goal.weekly_km) volumeText += ` · target ~${goal.weekly_km} km/wk`;
  const volumeLine = runs.length ? `<div class="end-runs-total numeral">${escHtml(volumeText)}</div>` : "";
  const runRows = runs.map(({ it, day_number }, index) => `
      <div class="end-run-row reveal" style="${stagger(index + 2)}">
        <span class="run-pin" aria-hidden="true">▸</span>
        <div class="end-run-main">
          <span class="end-run-name">${escHtml(cardioLabel(it))}</span>
          <span class="end-run-day lbl">Day ${escHtml(day_number)}</span>
        </div>
        <span class="end-run-pres numeral">${escHtml(cardioPrescription(it) || "—")}</span>
      </div>`).join("");
  const complianceHtml = typeof runComplianceLine === "function" ? runComplianceLine(compliance) : "";
  const syncHtml = typeof cardioSyncLine === "function" ? cardioSyncLine(settings, {}) : "";
  const runsSection = runs.length
    ? `<div class="end-runs reveal" style="${stagger(2)}">
         <div class="end-runs-h"><span class="lbl">This week's runs</span>
           <button class="end-link" id="endEditRuns">Edit in Training →</button></div>
         ${volumeLine}
         ${runRows}
       </div>${complianceHtml}${syncHtml}`
    : `<div class="end-runs-empty reveal" style="${stagger(2)}">
         <div class="lbl">This week's runs</div>
         <p>No runs in your plan yet. Ask the coach below to build your week — each run lands on its day and keeps your lifts intact.</p>
       </div>${complianceHtml}${syncHtml}`;

  const presets = endurancePresets(goal);
  const chips = presets.map((preset, index) => `<button class="end-chip" data-egi="${index}">${escHtml(preset.t)}</button>`).join("");
  const composer = `<div class="end-shape reveal" style="${stagger(3)}">
      <div class="end-shape-h"><span class="lbl">Shape your running</span></div>
      <p class="end-shape-sub">Tell the coach what you want — it drafts run prescriptions you review and apply. Your lifting plan is never touched.</p>
      <div class="end-chips">${chips}</div>
      <textarea id="endInstr" class="form-textarea" rows="2" placeholder="e.g. ease my long run, my knee's cranky — or add a tempo on Thursday"></textarea>
      <button id="endDraftBtn" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ASK THE COACH</button>
      <div id="endDraftStatus" class="end-shape-status"></div>
      <div id="endDraft"></div>
    </div>`;

  const leadHtml = goal
    ? `<p class="end-lead">Your running plan — the build, this week's runs, and a quick way to shape them.</p>`
    : "";
  body.innerHTML = goalHtml + leadHtml + rampHtml + standingNote + runsSection + composer;

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

function rampHtmlForGoal(goal: (EnduranceGoalRow & Record<string, unknown>) | null): string {
  return enduranceRampHtml(goal);
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
      const row = enduranceRecord(result);
      const proposal = enduranceRecord(row.proposal);
      return !result || row.ok === false || !row.proposal || !proposal.parsed;
    },
    render: (result) => renderEnduranceDraftResult(enduranceRecord(result).proposal),
    onFail: (error) => {
      enduranceComposerRestore();
      const status = view.querySelector("#endDraftStatus");
      if (!status) return;
      status.textContent = enduranceRecord(error).agent_status === "unconfigured"
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
  const p = enduranceRecord(proposal) as EnduranceProposal;
  const cardio = p.parsed && Array.isArray(p.parsed.cardio) ? p.parsed.cardio : [];
  if (!cardio.length) {
    status.innerHTML = `The coach proposed plan changes but no runs this time. <button class="end-link" id="endToCoach">Review in Coach →</button>`;
    status.querySelector("#endToCoach")?.addEventListener("click", () => renderCoach());
    return;
  }
  status.textContent = "";
  draftWrap.innerHTML = endDraftCardHtml(p);
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

const CAIRN_PLAN_ENDURANCE = {
  ENDURANCE_PHASES,
  rampHtml: enduranceRampHtml,
  presets: endurancePresets,
  draftCardHtml: endDraftCardHtml,
};

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

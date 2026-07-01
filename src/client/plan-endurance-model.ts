// @ts-check
// Pure Plan -> Endurance model and render helpers.

type PlanEnduranceGoalRow = import("../contracts/client-api.js").ClientEnduranceGoal;

type PlanEnduranceProposalRun = {
  day_number?: unknown;
  label?: unknown;
  exercise?: unknown;
  reason?: unknown;
  note?: unknown;
};

type PlanEnduranceProposal = {
  id?: unknown;
  agent?: unknown;
  parsed?: {
    summary?: unknown;
    cardio?: PlanEnduranceProposalRun[];
  } | null;
};

type PlanEndurancePreset = {
  t: string;
  i: string;
};

type PlanEndurancePlanDay = {
  day_number?: unknown;
  items?: Array<Record<string, unknown>>;
};

type PlanEnduranceRunRow = {
  it: Record<string, unknown>;
  day_number: unknown;
};

const PLAN_ENDURANCE_PHASES = [
  { key: "base", label: "Base", when: "11+ weeks out", desc: "Build aerobic volume — easy, conversational running." },
  { key: "build", label: "Build", when: "5–10 weeks out", desc: "Add tempo and longer runs; raise the ceiling." },
  { key: "sharpen", label: "Sharpen", when: "3–4 weeks out", desc: "Race-pace work as volume trims back." },
  { key: "taper", label: "Taper", when: "final 2 weeks", desc: "Freshen up — let the training surface." },
] as const;

function planEnduranceRampHtml(goal: PlanEnduranceGoalRow | null | undefined): string {
  if (!goal || goal.mode !== "race" || !goal.phase || goal.phase === "past") return "";
  const curIdx = PLAN_ENDURANCE_PHASES.findIndex((phase) => phase.key === goal.phase);
  if (curIdx < 0) return "";
  const steps = PLAN_ENDURANCE_PHASES.map((phase, index) => {
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

function planEndurancePresets(goal: PlanEnduranceGoalRow | null | undefined): PlanEndurancePreset[] {
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

function planEnduranceDraftCardHtml(proposal: PlanEnduranceProposal): string {
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

function planEnduranceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function planEndurancePlanRows(value: unknown): PlanEndurancePlanDay[] {
  return Array.isArray(value) ? value.filter((row): row is PlanEndurancePlanDay => !!row && typeof row === "object") : [];
}

function planEnduranceRuns(plan: unknown): PlanEnduranceRunRow[] {
  const runs: PlanEnduranceRunRow[] = [];
  for (const day of planEndurancePlanRows(plan)) {
    const items = Array.isArray(day.items) ? day.items : [];
    for (const item of items) {
      if (isCardioItem(item)) runs.push({ it: item, day_number: day.day_number });
    }
  }
  return runs;
}

const CAIRN_PLAN_ENDURANCE_MODEL = {
  ENDURANCE_PHASES: PLAN_ENDURANCE_PHASES,
  rampHtml: planEnduranceRampHtml,
  presets: planEndurancePresets,
  draftCardHtml: planEnduranceDraftCardHtml,
  record: planEnduranceRecord,
  runs: planEnduranceRuns,
};

Object.assign(globalThis, {
  CairnPlanEnduranceModel: CAIRN_PLAN_ENDURANCE_MODEL,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnPlanEnduranceModel: CAIRN_PLAN_ENDURANCE_MODEL,
  });
}

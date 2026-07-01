// @ts-check
// Progress Endurance run-plan presentation helpers.

type WeeklyRunPlan = import("../contracts/client-api.js").ClientWeeklyRunPlan;
type EnduranceGoal = import("../contracts/client-api.js").ClientEnduranceGoal;
type RunCompliance = import("../contracts/client-api.js").ClientRunCompliance;

function runKindClass(kind: unknown): string {
  if (kind === "quality") return "wrun-quality";
  if (kind === "long") return "wrun-long";
  return "wrun-easy";
}

function runKindLabel(kind: unknown): string {
  if (kind === "quality") return "Quality";
  if (kind === "long") return "Long";
  return "Easy";
}

function weeklyRunPlanCard(plan: WeeklyRunPlan | null | undefined): string {
  if (!plan || plan.available === false || !plan.runs.length) return "";
  const runs = plan.runs
    .map((run) => {
      const prescription = cardioPrescription({
        target_distance_km: run.target_distance_km,
        target_duration_min: run.target_duration_min,
        target_zone: run.target_zone,
        interval: run.interval,
        note: run.note,
      });
      const kind = runKindClass(run.kind_label);
      const label = run.label || (run.kind_label ? `${runKindLabel(run.kind_label)} run` : "Run");
      return `<div class="wrun-row ${kind}">
        <div class="wrun-row-head">
          <span class="wrun-kind">${escHtml(runKindLabel(run.kind_label))}</span>
          <span class="wrun-label">${escHtml(label)}</span>
        </div>
        ${prescription ? `<div class="wrun-pres numeral">${escHtml(prescription)}</div>` : ""}
        ${run.note && run.note !== label ? `<div class="wrun-note">${escHtml(run.note)}</div>` : ""}
      </div>`;
    })
    .join("");
  const rationale = plan.rationale.filter(Boolean);
  const whyBits = [plan.why, ...rationale].filter(Boolean);
  return `<div class="wrun-card reveal" style="${stagger(0)}">
      <div class="wrun-head">
        <span class="lbl">This week's runs</span>
        ${plan.mix_summary ? `<span class="wrun-mix">${escHtml(plan.mix_summary)}</span>` : ""}
      </div>
      ${plan.quality_focus ? `<div class="wrun-focus"><span class="lbl">Quality focus</span> ${escHtml(plan.quality_focus)}</div>` : ""}
      <div class="wrun-rows">${runs}</div>
      ${whyBits.length ? `<div class="wrun-why"><span class="lbl">Why this week looks like this</span>${whyBits.map((why) => `<p>${escHtml(why)}</p>`).join("")}</div>` : ""}
    </div>`;
}

function enduranceGoalCard(goal: EnduranceGoal | null | undefined): string {
  if (!goal || !goal.mode) return "";
  if (goal.mode === "race") {
    const days = typeof goal.days_to_race === "number" ? goal.days_to_race : null;
    const when =
      days == null
        ? ""
        : days < 0
          ? "race day passed"
          : days === 0
            ? "race day"
            : days <= 14
              ? `${days} day${days === 1 ? "" : "s"} to go`
              : `${goal.weeks_to_race} weeks to go`;
    const phaseLabels: Record<NonNullable<EnduranceGoal["phase"]>, string> = {
      base: "Base building",
      build: "Building",
      sharpen: "Sharpening",
      taper: "Tapering",
      past: "Race done",
    };
    const phaseLabel = goal.phase ? phaseLabels[goal.phase] : "";
    const sub = [goal.distance_km ? `${goal.distance_km} km` : null, goal.target ? `target ${goal.target}` : null, goal.date ? absDate(goal.date) : null].filter(Boolean).join(" · ");
    return `<div class="end-goal reveal" style="${stagger(0)}">
        <div class="end-goal-head"><span class="lbl">Race goal</span>${phaseLabel ? `<span class="end-goal-phase">${escHtml(phaseLabel)}</span>` : ""}</div>
        <div class="end-goal-name">${escHtml(goal.event || "Your race")}</div>
        ${sub ? `<div class="end-goal-sub">${escHtml(sub)}</div>` : ""}
        ${when ? `<div class="end-goal-count numeral">${escHtml(when)}</div>` : ""}
      </div>`;
  }
  const sub = [goal.distance_km ? `${goal.distance_km} km` : null, goal.weekly_km ? `~${goal.weekly_km} km/wk` : null].filter(Boolean).join(" · ");
  return `<div class="end-goal reveal" style="${stagger(0)}">
      <div class="end-goal-head"><span class="lbl">Standing goal</span></div>
      <div class="end-goal-name">Staying ${escHtml(goal.label || "race-ready")}</div>
      ${sub ? `<div class="end-goal-sub">${escHtml(sub)}</div>` : ""}
    </div>`;
}

function runComplianceLine(compliance: RunCompliance | null | undefined): string {
  if (!compliance || !compliance.in_words) return "";
  if (!compliance.prescribed_sessions && !compliance.actual_sessions) return "";
  return `<div class="end-compliance reveal" style="${stagger(0)}">
      <span class="lbl">This week's runs</span>
      <span class="end-compliance-v">${escHtml(compliance.in_words)}</span>
    </div>`;
}

function enduranceCoachLine(plan: WeeklyRunPlan | null | undefined): string {
  if (!plan || plan.available === false || !Array.isArray(plan.runs) || !plan.runs.length) return "";
  const long = plan.runs.find((run) => run.kind_label === "long");
  const quality = plan.runs.find((run) => run.kind_label === "quality");
  let sentence: string;
  if (long) {
    const distance = long.target_distance_km ? `${fmtKm(long.target_distance_km)} km ` : "";
    sentence = `This week, your ${distance}long run is the one that matters.`;
  } else if (quality) {
    sentence = `This week, your quality session is the one that matters.`;
  } else {
    sentence = "This week, keep your easy runs genuinely easy — that's the work.";
  }
  return `<div class="prog-headline reveal" style="${stagger(0)}">${escHtml(sentence)}</div>`;
}

const CAIRN_PROGRESS_RUN_PLAN = {
  runKindClass,
  runKindLabel,
  weeklyRunPlanCard,
  enduranceGoalCard,
  runComplianceLine,
  enduranceCoachLine,
};

Object.assign(globalThis, {
  CairnProgressRunPlan: CAIRN_PROGRESS_RUN_PLAN,
  runKindClass,
  runKindLabel,
  weeklyRunPlanCard,
  enduranceGoalCard,
  runComplianceLine,
  enduranceCoachLine,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressRunPlan: CAIRN_PROGRESS_RUN_PLAN,
    runKindClass,
    runKindLabel,
    weeklyRunPlanCard,
    enduranceGoalCard,
    runComplianceLine,
    enduranceCoachLine,
  });
}

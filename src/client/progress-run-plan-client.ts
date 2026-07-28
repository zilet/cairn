// @ts-check
// Progress Endurance run-plan presentation helpers.

type WeeklyRunPlan = import("../contracts/client-api.js").ClientWeeklyRunPlan;
type EnduranceGoal = import("../contracts/client-api.js").ClientEnduranceGoal;
type RunCompliance = import("../contracts/client-api.js").ClientRunCompliance;
type FlexibleTrainingAgenda = import("../contracts/client-api.js").ClientFlexibleTrainingAgenda;
type FlexibleRunIntent = import("../contracts/client-api.js").ClientFlexibleRunIntent;

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

function trainingAgendaDate(date: unknown): string {
  return humanDate(String(date || ""));
}

function trainingAgendaDose(intent: FlexibleRunIntent): string {
  const parts: string[] = [];
  if (intent.target_distance_km != null && Number(intent.target_distance_km) > 0) {
    parts.push(`${fmtKm(intent.target_distance_km)} km`);
  } else if (intent.target_duration_min != null && Number(intent.target_duration_min) > 0) {
    parts.push(`${Math.round(Number(intent.target_duration_min))} min`);
  }
  if (intent.target_zone) parts.push(String(intent.target_zone));
  return parts.join(" · ");
}

function trainingAgendaCard(agenda: FlexibleTrainingAgenda | null | undefined): string {
  if (!agenda || agenda.available === false || !Array.isArray(agenda.intents) || !agenda.intents.length) return "";
  const rows = agenda.intents.map((intent) => {
    const kind = runKindClass(intent.kind);
    const label = intent.label || `${runKindLabel(intent.kind)} run`;
    const dose = trainingAgendaDose(intent);
    let state: string;
    let evidence = "";
    if (intent.status === "completed" && intent.completion) {
      const completion = intent.completion;
      const bits: string[] = [];
      if (completion.distance_km != null && Number(completion.distance_km) > 0) {
        bits.push(`${fmtKm(completion.distance_km)} km`);
      }
      if (completion.duration_min != null && Number(completion.duration_min) > 0) {
        bits.push(`${Math.round(Number(completion.duration_min))} min`);
      }
      bits.push(completion.intensity === "quality" ? "quality effort matched" : "easy effort matched");
      state = `Completed ${trainingAgendaDate(completion.date)}`;
      evidence = bits.join(" · ");
    } else {
      const suggested = intent.suggested_date
        ? `Suggested opening ${trainingAgendaDate(intent.suggested_date)}`
        : "Open for a compatible opening";
      const window =
        `Flexible window ${trainingAgendaDate(intent.window_start)}–${trainingAgendaDate(intent.window_end)}`;
      state = `${suggested} · ${window}`;
      evidence = dose;
    }
    const exactDate = intent.status === "completed" && intent.completion
      ? absDate(String(intent.completion.date || ""))
      : intent.suggested_date
        ? absDate(String(intent.suggested_date))
        : "";
    return `<div class="wrun-row ${kind}">
        <div class="wrun-row-head">
          <span class="wrun-kind">${escHtml(intent.status === "completed" ? `Done · ${runKindLabel(intent.kind)}` : `Open · ${runKindLabel(intent.kind)}`)}</span>
          <span class="wrun-label">${escHtml(label)}</span>
        </div>
        <div class="wrun-pres"${exactDate ? ` title="${escAttr(exactDate)}"` : ""}>${escHtml(state)}</div>
        ${evidence ? `<div class="wrun-note">${escHtml(evidence)}</div>` : ""}
      </div>`;
  }).join("");
  const hasOpen = agenda.intents.some((intent) => intent.status === "open");
  const next = agenda.next
    ? `Next suggested opening: ${runKindLabel(agenda.next.kind)} · ${trainingAgendaDate(agenda.next.suggested_date)}`
    : hasOpen
      ? "No clean opening remains this week"
      : "The week's run intentions are covered";
  return `<div class="wrun-card reveal" style="${stagger(0)}" data-training-agenda>
      <div class="wrun-head">
        <span class="lbl">Movable running week</span>
        <span class="wrun-mix">${escHtml(next)}</span>
      </div>
      <p class="wrun-note">${escHtml(agenda.why || "Run intentions move with the work you actually do.")}</p>
      <div class="wrun-rows">${rows}</div>
      <div class="wrun-why">
        <p>Suggested openings can move with your actual lifting, riding, and running. Nothing unfinished is owed as catch-up.</p>
      </div>
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
  trainingAgendaCard,
  enduranceGoalCard,
  runComplianceLine,
  enduranceCoachLine,
};

Object.assign(globalThis, {
  CairnProgressRunPlan: CAIRN_PROGRESS_RUN_PLAN,
  runKindClass,
  runKindLabel,
  weeklyRunPlanCard,
  trainingAgendaCard,
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
    trainingAgendaCard,
    enduranceGoalCard,
    runComplianceLine,
    enduranceCoachLine,
  });
}

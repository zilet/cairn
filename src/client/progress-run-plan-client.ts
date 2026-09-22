// @ts-check
// Progress Endurance run-plan presentation helpers.

type WeeklyRunPlan = import("../contracts/client-api.js").ClientWeeklyRunPlan;
type EnduranceGoal = import("../contracts/client-api.js").ClientEnduranceGoal;
type RunCompliance = import("../contracts/client-api.js").ClientRunCompliance;
type FlexibleTrainingAgenda = import("../contracts/client-api.js").ClientFlexibleTrainingAgenda;
type FlexibleRunIntent = import("../contracts/client-api.js").ClientFlexibleRunIntent;
type CalibrationStatus = import("../contracts/client-api.js").ClientCalibrationStatus;
type CalibrationStatusItem = import("../contracts/client-api.js").ClientCalibrationStatusItem;

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
  return `<div class="wrun-card reveal" style="${stagger(5)}">
      <div class="wrun-head">
        <span class="lbl">This week's runs</span>
        ${plan.mix_summary ? `<span class="wrun-mix">${escHtml(plan.mix_summary)}</span>` : ""}
      </div>
      ${plan.quality_focus ? `<div class="wrun-focus"><span class="lbl">Quality focus</span> ${escHtml(plan.quality_focus)}</div>` : ""}
      <div class="wrun-rows">${runs}</div>
      ${whyBits.length ? `<div class="wrun-why"><span class="lbl">Why this week looks like this</span>${whyBits.map((why) => `<p>${escHtml(why)}</p>`).join("")}</div>` : ""}
    </div>`;
}

// ---- the race build ----
// One card between the goal and this week's runs: where the estimate sits against
// the target and how it has moved, the paces the sessions should touch, the ladder
// to race week, and the seven-day leg map with the ride and heavy-lower days. Every
// number is the server's; nothing here is a grade.
type RaceBuild = import("../contracts/client-api.js").ClientRaceBuild;

function raceClock(sec: unknown): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function racePace(secPerKm: unknown, units?: unknown): string {
  if (typeof fmtPaceFromSecPerKm === "function") return fmtPaceFromSecPerKm(secPerKm, units);
  const s = Math.max(0, Math.round(Number(secPerKm) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function racePaceLine(secPerKm: unknown, units?: unknown): string {
  const suffix = typeof fmtRunUnitSuffix === "function" ? fmtRunUnitSuffix(units) : "/km";
  return `${racePace(secPerKm, units)} ${suffix}`;
}

function raceDist(km: unknown, units?: unknown): string {
  if (typeof fmtDist === "function") return fmtDist(km, units);
  if (typeof fmtKm === "function") return `${fmtKm(km)} km`;
  return `${km} km`;
}

const RACE_FIT_WORD: Record<string, string> = {
  fits: "inside the target",
  stretch: "a stretch the build can close",
  beyond_horizon: "train from today's shape; the target stays the reach",
};

const RACE_WEEK_KIND_WORD: Record<string, string> = {
  build: "Build",
  down: "Down week",
  peak: "Peak",
  taper: "Taper",
  race: "Race week",
};

function raceBuildCard(build: RaceBuild | null | undefined, opts?: { underGoal?: boolean; legMap?: boolean; compact?: boolean; units?: unknown }): string {
  if (!build || build.available === false || !build.race) return "";
  const units = opts?.units;
  const race = build.race;
  const p = build.prediction;
  const target = race.target;

  // The headline pair: estimate vs target.
  let numbers = "";
  if (p || target) {
    const estimate = p
      ? `<div class="rbuild-num"><span class="lbl">Reads like</span><span class="numeral rbuild-clock">${escHtml(raceClock(p.estimate_sec))}</span><span class="rbuild-pace">${escHtml(racePaceLine(p.estimate_pace_sec_per_km, units))}</span></div>`
      : "";
    const goal = target
      ? `<div class="rbuild-num"><span class="lbl">Shooting for</span><span class="numeral rbuild-clock">${escHtml(raceClock(target.sec))}</span><span class="rbuild-pace">${escHtml(racePaceLine(target.pace_sec_per_km, units))}</span></div>`
      : "";
    numbers = `<div class="rbuild-nums">${estimate}${goal}</div>`;
  }
  const trendBits: string[] = [];
  if (p?.trend) {
    trendBits.push(
      p.trend.word === "steady"
        ? "Holding steady over the last month."
        : `${Math.max(1, Math.round(Math.abs(p.trend.delta_sec) / 60))} min ${p.trend.word} over the last month.`
    );
  }
  if (p?.fit && target) {
    const fitWord = RACE_FIT_WORD[p.fit] || "";
    const lead = p.fit === "fits" ? fitWord.charAt(0).toUpperCase() + fitWord.slice(1) : `${raceClock(Math.abs(p.gap_sec || 0))} off — ${fitWord}`;
    trendBits.push(`${lead}.`);
  }
  if (p) trendBits.push(`From ${p.basis_detail}.`);
  const trend = trendBits.length ? `<div class="wrun-note rbuild-trend">${escHtml(trendBits.join(" "))}</div>` : "";

  // This week's quality session, with a pace on it.
  const q = build.this_week?.quality;
  const quality = q
    ? `<div class="wrun-focus"><span class="lbl">This week's quality</span> ${escHtml(q.label)}${q.pace ? ` · <span class="numeral">${escHtml(typeof fmtPaceBand === "function" ? fmtPaceBand(q.pace, units) : q.pace.text)}</span>` : " · by effort"}</div>`
    : "";

  // Pace bands.
  const bands = build.paces?.bands?.filter((b) => b.key !== "race") || [];
  const paces = bands.length
    ? `<div class="rbuild-paces">${bands
        .map((b) => `<div class="rbuild-band"><span class="rbuild-band-k">${escHtml(b.label)}</span><span class="numeral rbuild-band-v">${escHtml(typeof fmtPaceBand === "function" ? fmtPaceBand(b, units) : b.text)}</span></div>`)
        .join("")}</div>`
    : "";

  // The leg map: one ring, seven cells.
  // The Plan tab's Endurance segment already shows the connected week strip (the
  // log for done days, the agenda for runs); a second forecast ring under it would
  // contradict the first on any week the athlete traded days. Callers with the strip
  // pass legMap:false; Progress keeps the ring.
  const legMap = opts?.legMap !== false && Array.isArray(build.leg_map) && build.leg_map.length
    ? `<div class="rbuild-map">${build.leg_map
        .map((d) => {
          const bits: string[] = [];
          if (d.run) bits.push(`${runKindLabel(d.run.kind)} run${d.run.km != null ? ` ${raceDist(d.run.km, units)}` : ""}`);
          if (d.strength) bits.push(d.strength.heavy_lower ? `Heavy legs · ${d.strength.name}` : d.strength.name);
          if (d.ride) bits.push(build.ride ? build.ride.label : "ride");
          return `<div class="rbuild-day${d.hard ? " is-hard" : ""}"><span class="rbuild-day-k">${escHtml(d.weekday.slice(0, 3))}</span><span class="rbuild-day-v">${bits.length ? escHtml(bits.join(" · ")) : "—"}</span></div>`;
        })
        .join("")}</div>`
    : "";

  // The ladder.
  const ladder = Array.isArray(build.weeks) && build.weeks.length
    ? `<div class="wrun-rows rbuild-ladder">${build.weeks
        .map((w) => `<div class="wrun-row ${w.kind === "peak" || w.kind === "build" ? "wrun-quality" : "wrun-easy"}${w.current ? " is-current" : ""}">
            <div class="wrun-row-head">
              <span class="wrun-kind">${escHtml(w.weeks_to_race === 0 ? "Race week" : `${w.weeks_to_race} wk out`)}</span>
              <span class="wrun-label">${escHtml(RACE_WEEK_KIND_WORD[w.kind] || w.kind)}${w.current ? " · this week" : ""}</span>
              <span class="numeral rbuild-week-km">${escHtml(`${raceDist(w.km, units)} · long ${raceDist(w.long_km, units)}`)}</span>
            </div>
            <div class="wrun-note">${escHtml(w.quality_hint)}</div>
          </div>`)
        .join("")}</div>`
    : "";

  const strengthBits: string[] = [];
  if (build.strength) {
    strengthBits.push(build.strength.principle);
    if (build.strength.layout) strengthBits.push(build.strength.layout);
  }
  if (build.ride) strengthBits.push(build.ride.placement);
  const whyBits = [build.why, ...strengthBits].filter(Boolean);

  const phaseLabel = { base: "Base", build: "Building", sharpen: "Sharpening", taper: "Tapering", past: "Done" }[race.phase] || "";
  // Match the ladder's own label at the edges: 0 weeks out is "race week", 1
  // is singular ("1 week to go") — never "1 weeks to go".
  const countdownWord = race.weeks_to_race === 0
    ? "race week"
    : race.weeks_to_race === 1
      ? "1 week to go"
      : `${race.weeks_to_race} weeks to go`;
  // The goal card directly above already states the countdown + phase — when
  // this card is placed right under it (Plan -> Endurance, and Progress ->
  // Endurance which also stacks goal then race build), don't say it twice.
  const countHtml = opts?.underGoal
    ? ""
    : `<span class="wrun-mix">${escHtml(`${countdownWord}${phaseLabel ? ` · ${phaseLabel}` : ""}`)}</span>`;
  const whyHtml = whyBits.length
    ? `<div class="wrun-why"><span class="lbl">How it fits together</span>${whyBits.map((why) => `<p>${escHtml(why)}</p>`).join("")}</div>`
    : "";
  // Plan → Endurance already briefs the next session; the clocks, pace library,
  // and ladder stay one tap away so the card orients without repeating the week.
  const compactBody = opts?.compact
    ? `${trend}${`${numbers}${quality}${paces}${legMap}${ladder}${whyHtml}`
      ? `<details class="rbuild-more"><summary>The rest of the program</summary>${numbers}${quality}${paces}${legMap}${ladder}${whyHtml}</details>`
      : ""}`
    : `${numbers}${trend}${quality}${paces}${legMap}${ladder ? `<details class="rbuild-more"><summary>The build, week by week</summary>${ladder}</details>` : ""}${whyHtml}`;
  return `<div class="wrun-card rbuild reveal" style="${stagger(1)}" data-race-build>
      <div class="wrun-head">
        <span class="lbl">Race build</span>
        ${countHtml}
      </div>
      ${compactBody}
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
  return `<div class="wrun-card reveal" style="${stagger(2)}" data-training-agenda>
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

function enduranceGoalCard(goal: EnduranceGoal | null | undefined, opts?: { units?: unknown }): string {
  if (!goal || !goal.mode) return "";
  const units = opts?.units;
  const dist = goal.distance_km ? raceDist(goal.distance_km, units) : null;
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
    const sub = [dist, goal.target ? `target ${goal.target}` : null, goal.date ? absDate(goal.date) : null].filter(Boolean).join(" · ");
    return `<div class="end-goal reveal" style="${stagger(0)}">
        <div class="end-goal-head"><span class="lbl">Race goal</span>${phaseLabel ? `<span class="end-goal-phase">${escHtml(phaseLabel)}</span>` : ""}</div>
        <div class="end-goal-name">${escHtml(goal.event || "Your race")}</div>
        ${sub ? `<div class="end-goal-sub">${escHtml(sub)}</div>` : ""}
        ${when ? `<div class="end-goal-count numeral">${escHtml(when)}</div>` : ""}
      </div>`;
  }
  const sub = [dist, goal.weekly_km ? `~${raceDist(goal.weekly_km, units)}/wk` : null].filter(Boolean).join(" · ");
  return `<div class="end-goal reveal" style="${stagger(0)}">
      <div class="end-goal-head"><span class="lbl">Standing goal</span></div>
      <div class="end-goal-name">Staying ${escHtml(goal.label || "race-ready")}</div>
      ${sub ? `<div class="end-goal-sub">${escHtml(sub)}</div>` : ""}
    </div>`;
}

function runComplianceLine(compliance: RunCompliance | null | undefined): string {
  if (!compliance || !compliance.in_words) return "";
  if (!compliance.prescribed_sessions && !compliance.actual_sessions) return "";
  return `<div class="end-compliance reveal" style="${stagger(3)}">
      <span class="lbl">This week's runs</span>
      <span class="end-compliance-v">${escHtml(compliance.in_words)}</span>
    </div>`;
}

// The lead sentence used to read ONLY the live prescription, so it went on
// naming the long run the athlete had already run ("your 4.9 km long run is the
// one that matters" the day after a 9.1 km long run). Completion lives in the
// agenda payload the same controller already fetches, so the line now speaks to
// what actually happened first and falls back to the prescription only while the
// week's headline run is still open. Every phrasing rotates by date — a stable
// input must not print one literal verbatim for a week (VISION Amendment 2).
const RUN_BANKED_LONG_DOSE = [
  "Your long run is already banked — {dose} this week.",
  "The long one is done: {dose} in the bank this week.",
  "{dose} long run, already behind you this week.",
  "This week's long run is banked at {dose}.",
] as const;

const RUN_BANKED_LONG_PLAIN = [
  "Your long run is already banked this week.",
  "The long one is done — it's behind you this week.",
  "This week's long run is in the bank.",
] as const;

const RUN_BANKED_QUALITY = [
  "Your quality session is already banked this week.",
  "The hard one is done — it's behind you this week.",
  "This week's quality work is in the bank.",
] as const;

function runIntentDose(completion: NonNullable<FlexibleRunIntent["completion"]>): string {
  if (completion.distance_km != null && Number(completion.distance_km) > 0) {
    return `${fmtKm(completion.distance_km)} km`;
  }
  if (completion.duration_min != null && Number(completion.duration_min) > 0) {
    return `${Math.round(Number(completion.duration_min))} min`;
  }
  return "";
}

function runAgendaIntent(agenda: FlexibleTrainingAgenda | null | undefined, kind: string): FlexibleRunIntent | null {
  if (!agenda || agenda.available === false || !Array.isArray(agenda.intents)) return null;
  return agenda.intents.find((intent) => intent.kind === kind) || null;
}

// The date the rotation keys off — the agenda's own as-of when it has one, so
// the sentence is stable for the day the payload describes.
function runAgendaDate(agenda: FlexibleTrainingAgenda | null | undefined): string {
  const asOf = String(agenda?.as_of || "").slice(0, 10);
  return asOf || localISO();
}

function enduranceBankedSentence(
  plan: WeeklyRunPlan | null | undefined,
  agenda: FlexibleTrainingAgenda | null | undefined
): string {
  const date = runAgendaDate(agenda);
  const long = runAgendaIntent(agenda, "long");
  if (long && long.status === "completed" && long.completion) {
    const dose = runIntentDose(long.completion);
    return dose
      ? pickDayVariant(RUN_BANKED_LONG_DOSE, date, "endurance-lead:long-banked").replace("{dose}", dose)
      : pickDayVariant(RUN_BANKED_LONG_PLAIN, date, "endurance-lead:long-banked-plain");
  }
  // Quality only speaks for the week when there is no long run to lead with —
  // an open long run stays the headline even once the hard session is done.
  if (long) return "";
  const plannedLong = Array.isArray(plan?.runs) ? plan.runs.some((run) => run.kind_label === "long") : false;
  if (plannedLong) return "";
  const quality = runAgendaIntent(agenda, "quality");
  if (quality && quality.status === "completed" && quality.completion) {
    return pickDayVariant(RUN_BANKED_QUALITY, date, "endurance-lead:quality-banked");
  }
  return "";
}

function enduranceCoachLine(
  plan: WeeklyRunPlan | null | undefined,
  agenda?: FlexibleTrainingAgenda | null
): string {
  const banked = enduranceBankedSentence(plan, agenda);
  if (banked) return `<div class="prog-headline reveal" style="${stagger(0)}">${escHtml(banked)}</div>`;
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

// ---- calibration freshness (endurance only) ----
// One quiet line saying how well-anchored the numbers steering the week actually
// are. Freshness words only — never a count, never a days-stale number, never a
// nag: the athlete reads it if they look, and nothing here gates a run.
const CALIBRATION_FRESHNESS_ORDER = ["never", "stale", "aging", "anchored"] as const;

const CALIBRATION_LINES: Record<CalibrationStatusItem["freshness"], readonly string[]> = {
  never: [
    "{label} has never been anchored to a test.",
    "Nothing has anchored {label} yet.",
    "{label} is still running on an estimate.",
  ],
  stale: [
    "{label} was anchored a long while back.",
    "{label} is running on an old anchor.",
    "It has been a long time since {label} was tested.",
  ],
  aging: [
    "{label} is starting to age.",
    "{label} was anchored a while ago now.",
    "{label} could use a fresher anchor before long.",
  ],
  anchored: [
    "{label} is freshly anchored.",
    "{label} is anchored to recent work.",
    "{label} is current.",
  ],
};

function enduranceCalibrationLine(status: CalibrationStatus | null | undefined, dateISO?: string): string {
  const items = Array.isArray(status?.items) ? status.items.filter((item) => item && item.domain === "endurance") : [];
  if (!items.length) return "";
  let lead: CalibrationStatusItem | null = null;
  let leadRank: number = CALIBRATION_FRESHNESS_ORDER.length;
  for (const item of items) {
    const rank = CALIBRATION_FRESHNESS_ORDER.indexOf(item.freshness);
    if (rank >= 0 && rank < leadRank) {
      lead = item;
      leadRank = rank;
    }
  }
  if (!lead) return "";
  const variants = CALIBRATION_LINES[lead.freshness];
  if (!variants || !variants.length) return "";
  const label = String(lead.label || "Your zones").trim() || "Your zones";
  const date = String(dateISO || status?.as_of || "").slice(0, 10) || localISO();
  const sentence = pickDayVariant(variants, date, `endurance-calibration:${lead.key}`).replace("{label}", label);
  return `<div class="end-compliance reveal" style="${stagger(4)}">
      <span class="lbl">Anchors</span>
      <span class="end-compliance-v">${escHtml(sentence)}</span>
    </div>`;
}

const CAIRN_PROGRESS_RUN_PLAN = {
  runKindClass,
  runKindLabel,
  weeklyRunPlanCard,
  raceBuildCard,
  trainingAgendaCard,
  enduranceGoalCard,
  runComplianceLine,
  enduranceCoachLine,
  enduranceCalibrationLine,
};

Object.assign(globalThis, {
  CairnProgressRunPlan: CAIRN_PROGRESS_RUN_PLAN,
  runKindClass,
  runKindLabel,
  weeklyRunPlanCard,
  raceBuildCard,
  trainingAgendaCard,
  enduranceGoalCard,
  runComplianceLine,
  enduranceCoachLine,
  enduranceCalibrationLine,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressRunPlan: CAIRN_PROGRESS_RUN_PLAN,
    runKindClass,
    runKindLabel,
    weeklyRunPlanCard,
    raceBuildCard,
    trainingAgendaCard,
    enduranceGoalCard,
    runComplianceLine,
    enduranceCoachLine,
    enduranceCalibrationLine,
  });
}

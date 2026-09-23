// @ts-check
// Pure Plan -> Endurance model and render helpers.

type PlanEnduranceGoalRow = import("../contracts/client-api.js").ClientEnduranceGoal;
type PlanEnduranceRunPlan = import("../contracts/client-api.js").ClientWeeklyRunPlan;
type PlanEnduranceRunPrescription = import("../contracts/client-api.js").ClientRunPlanPrescription;
type PlanEnduranceAgenda = import("../contracts/client-api.js").ClientFlexibleTrainingAgenda;
type PlanEnduranceIntent = import("../contracts/client-api.js").ClientFlexibleRunIntent;
type PlanEnduranceRaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
type PlanEndurancePaceBand = import("../contracts/client-api.js").ClientRacePaceBand;
type PlanEnduranceLegDay = import("../contracts/client-api.js").ClientLegMapDay;
type PlanEnduranceRunKind = import("../contracts/client-api.js").ClientFlexibleRunKind;

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

type PlanEnduranceHorizon = "this_week" | "next_week" | "later";

type PlanEnduranceBriefingSession = {
  kind: PlanEnduranceRunKind;
  label: string;
  when: string;
  date: string | null;
  day_number: number | null;
  prescription: string;
  setup: string;
  expect: string;
  sitsBy: string;
  status: "open" | "completed";
  // Today's run only: the server's morning call on it, in its own words (empty otherwise).
  morning?: string;
};

type PlanEnduranceBriefing = {
  horizon: PlanEnduranceHorizon;
  kicker: string;
  headline: string;
  units: "km" | "mi";
  next: PlanEnduranceBriefingSession | null;
  remaining: PlanEnduranceBriefingSession[];
  later: PlanEnduranceBriefingSession[];
};

type PlanEnduranceBriefingWeek = {
  agenda?: PlanEnduranceAgenda | null;
  runPlan?: PlanEnduranceRunPlan | null;
  raceBuild?: PlanEnduranceRaceBuild | null;
};

type PlanEnduranceBriefingInput = {
  today: string;
  units?: unknown;
  agenda?: PlanEnduranceAgenda | null;
  runPlan?: PlanEnduranceRunPlan | null;
  raceBuild?: PlanEnduranceRaceBuild | null;
  nextAgenda?: PlanEnduranceAgenda | null;
  nextRunPlan?: PlanEnduranceRunPlan | null;
  nextRaceBuild?: PlanEnduranceRaceBuild | null;
  laterAgenda?: PlanEnduranceAgenda | null;
  laterRunPlan?: PlanEnduranceRunPlan | null;
  laterRaceBuild?: PlanEnduranceRaceBuild | null;
  weeks?: PlanEnduranceBriefingWeek[];
};

const PLAN_ENDURANCE_REVIEW_COUNT = 3;
const PLAN_ENDURANCE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const PLAN_ENDURANCE_PHASES = [
  { key: "base", label: "Base", when: "11+ weeks out", desc: "Build aerobic volume — easy, conversational running." },
  { key: "build", label: "Build", when: "5–10 weeks out", desc: "Add tempo and longer runs; raise the ceiling." },
  { key: "sharpen", label: "Sharpen", when: "3–4 weeks out", desc: "Race-pace work as volume trims back." },
  { key: "taper", label: "Taper", when: "final 2 weeks", desc: "Freshen up — let the training surface." },
] as const;

const PLAN_ENDURANCE_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

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

function planEnduranceDayKey(iso: unknown): string {
  return String(iso || "").slice(0, 10);
}

function planEnduranceAddDays(iso: string, days: number): string {
  const t = Date.parse(`${planEnduranceDayKey(iso)}T00:00:00Z`);
  if (!Number.isFinite(t)) return "";
  return new Date(t + days * 864e5).toISOString().slice(0, 10);
}

function planEnduranceMondayOf(iso: string): string {
  const key = planEnduranceDayKey(iso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const d = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function planEnduranceNextMonday(iso: string): string {
  const monday = planEnduranceMondayOf(iso);
  return monday ? planEnduranceAddDays(monday, 7) : "";
}

function planEnduranceWeekdayName(iso: string | null | undefined, dayNumber?: number | null): string {
  const key = planEnduranceDayKey(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const d = new Date(`${key}T00:00:00Z`);
    if (Number.isFinite(d.getTime())) return PLAN_ENDURANCE_WEEKDAYS[(d.getUTCDay() + 6) % 7];
  }
  const n = Number(dayNumber);
  if (Number.isFinite(n) && n >= 1 && n <= 7) return PLAN_ENDURANCE_WEEKDAYS[n - 1];
  return "";
}

function planEnduranceRunAvailable(plan: PlanEnduranceRunPlan | null | undefined): plan is PlanEnduranceRunPlan {
  return !!(plan && plan.available !== false && Array.isArray(plan.runs) && plan.runs.length);
}

function planEnduranceWeekBanked(agenda: PlanEnduranceAgenda | null | undefined): boolean {
  if (!agenda || agenda.available === false || !Array.isArray(agenda.intents) || !agenda.intents.length) return false;
  return agenda.intents.every((intent) => intent.status === "completed");
}

function planEnduranceKindLabel(kind: unknown): string {
  if (kind === "quality") return "Quality";
  if (kind === "long") return "Long";
  return "Easy";
}

function planEnduranceKindClass(kind: unknown): string {
  if (kind === "quality") return "wrun-quality";
  if (kind === "long") return "wrun-long";
  return "wrun-easy";
}

function planEnduranceRunUnits(value: unknown): "km" | "mi" {
  if (typeof runUnits === "function") return runUnits(value);
  const s = String(value || "").trim().toLowerCase();
  return s === "mi" || s === "mile" || s === "miles" ? "mi" : "km";
}

function planEnduranceKmText(km: unknown, units?: unknown): string {
  if (km == null || km === "") return "";
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (typeof fmtDist === "function") return fmtDist(n, units);
  if (typeof fmtKm === "function") return `${fmtKm(n)} km`;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} km`;
}

function planEnduranceIntervalText(interval: unknown): string {
  if (!Array.isArray(interval) || !interval.length) return "";
  return interval
    .map((item) => {
      const row = planEnduranceRecord(item);
      const on = String(row.on || "").trim();
      if (!on) return "";
      const reps = row.reps != null && Number(row.reps) > 0 ? `${Number(row.reps)} × ${on}` : on;
      const off = String(row.off || "").trim();
      return off ? `${reps}, ${off}` : reps;
    })
    .filter(Boolean)
    .join("; ");
}

function planEnduranceQualityPaceKey(label: string | null | undefined): PlanEndurancePaceBand["key"] | null {
  const s = String(label || "").toLowerCase();
  if (!s) return null;
  if (/hill/.test(s)) return null;
  if (/threshold|cruise/.test(s)) return "threshold";
  if (/vo2|400|800|1k rep|repeat|interval/.test(s)) return "vo2";
  if (/tempo|race[- ]pace|steady/.test(s)) return "tempo";
  return null;
}

function planEndurancePaceBand(
  kind: PlanEnduranceRunKind,
  label: string,
  raceBuild: PlanEnduranceRaceBuild | null | undefined
): PlanEndurancePaceBand | null {
  const bands = raceBuild && Array.isArray(raceBuild.paces?.bands) ? raceBuild.paces.bands : [];
  if (!bands.length) return null;
  if (kind === "easy") return bands.find((band) => band.key === "easy") || null;
  if (kind === "long") return bands.find((band) => band.key === "long") || null;
  const key = planEnduranceQualityPaceKey(label);
  if (!key) return null;
  return bands.find((band) => band.key === key) || null;
}

function planEnduranceSitsBy(
  dayNumber: number | null,
  date: string | null,
  raceBuild: PlanEnduranceRaceBuild | null | undefined
): string {
  const map = raceBuild && Array.isArray(raceBuild.leg_map) ? raceBuild.leg_map : [];
  if (!map.length) return "";
  const weekday = planEnduranceWeekdayName(date, dayNumber);
  const idx = map.findIndex((day) => {
    if (dayNumber != null && Number(day.day_number) === Number(dayNumber)) return true;
    return weekday && String(day.weekday || "") === weekday;
  });
  if (idx < 0) return "";
  const day = map[idx] as PlanEnduranceLegDay;
  if (day.strength) {
    const name = String(day.strength.name || "lifting").trim();
    return day.strength.heavy_lower
      ? `Shares the day with heavy legs (${name}) — keep the run honest.`
      : `Shares the day with ${name}.`;
  }
  const prev = idx > 0 ? map[idx - 1] : null;
  if (prev?.strength?.heavy_lower) {
    return `Day after heavy legs (${String(prev.strength.name || "lifting").trim()}).`;
  }
  const next = idx < map.length - 1 ? map[idx + 1] : null;
  if (next?.strength) {
    return `Day before ${String(next.strength.name || "lifting").trim()}.`;
  }
  if (day.ride && raceBuild?.ride) {
    return `${raceBuild.ride.label} also sits here — keep it the easy half.`;
  }
  return "";
}

function planEnduranceSetup(kind: PlanEnduranceRunKind, interval: unknown, note: string): string {
  const structure = planEnduranceIntervalText(interval);
  if (structure) return `Warm-up, then ${structure}. Easy cool-down.`;
  if (kind === "quality" && note) return note;
  if (kind === "quality") return "Continuous quality after an easy warm-up.";
  return "Easy throughout — that is the session.";
}

function planEnduranceExpect(kind: PlanEnduranceRunKind, note: string, pace: PlanEndurancePaceBand | null, setup: string): string {
  if (note && note !== setup) return note;
  if (kind === "quality" && !pace) return "By effort — the hill is the work.";
  if (kind === "long") return "The last stretch should still feel easy. If it doesn't, that's the signal.";
  if (kind === "easy") return "You should be able to talk. If you can't, you're doing the quality day's work.";
  return "";
}

function planEndurancePaceText(pace: PlanEndurancePaceBand | null, units?: unknown): string {
  if (!pace) return "";
  if (typeof fmtPaceBand === "function" && (pace.fast_sec_per_km != null || pace.slow_sec_per_km != null)) {
    return fmtPaceBand(pace, units);
  }
  return String(pace.text || "");
}

function planEnduranceShortDate(iso: string | null | undefined): string {
  const key = planEnduranceDayKey(iso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const d = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return "";
  return `${PLAN_ENDURANCE_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function planEnduranceHorizonOf(date: string | null | undefined, today: string): PlanEnduranceHorizon {
  const dateMon = planEnduranceMondayOf(date || "");
  const thisMon = planEnduranceMondayOf(today);
  if (!dateMon || !thisMon || dateMon === thisMon) return "this_week";
  if (dateMon === planEnduranceNextMonday(today)) return "next_week";
  return "later";
}

function planEnduranceKicker(horizon: PlanEnduranceHorizon): string {
  if (horizon === "next_week") return "Next week";
  if (horizon === "later") return "Coming up";
  return "This week";
}

function planEnduranceWhen(date: string | null, today: string, dayNumber: number | null): string {
  const weekday = planEnduranceWeekdayName(date, dayNumber);
  if (date && date === today) return weekday ? `Today · ${weekday}` : "Today";
  const tomorrow = planEnduranceAddDays(today, 1);
  if (date && date === tomorrow) return weekday ? `Tomorrow · ${weekday}` : "Tomorrow";
  const horizon = planEnduranceHorizonOf(date, today);
  if (horizon === "next_week") return weekday ? `Next ${weekday}` : "Next week";
  if (horizon === "later") {
    const short = planEnduranceShortDate(date);
    if (weekday && short) return `${weekday} · ${short}`;
    return weekday || short || "Open";
  }
  return weekday || "Open";
}

function planEndurancePrescription(
  km: unknown,
  min: unknown,
  interval: unknown,
  zone: unknown,
  pace: PlanEndurancePaceBand | null,
  units?: unknown
): string {
  const parts: string[] = [];
  const kmText = planEnduranceKmText(km, units);
  if (kmText) parts.push(kmText);
  else if (min != null && Number(min) > 0) parts.push(`${Math.round(Number(min))} min`);
  const structure = planEnduranceIntervalText(interval);
  if (structure) parts.push(structure);
  const paceText = planEndurancePaceText(pace, units);
  if (paceText) parts.push(paceText);
  else if (!structure && zone) parts.push(String(zone));
  return parts.join(" · ");
}

function planEnduranceMatchRun(
  runPlan: PlanEnduranceRunPlan | null | undefined,
  kind: PlanEnduranceRunKind,
  dayNumber: number | null
): PlanEnduranceRunPrescription | null {
  if (!planEnduranceRunAvailable(runPlan)) return null;
  const byKind = runPlan.runs.filter((run) => run.kind_label === kind);
  if (dayNumber != null) {
    const byDay = byKind.find((run) => Number(run.day_number) === Number(dayNumber));
    if (byDay) return byDay;
  }
  return byKind[0] || runPlan.runs.find((run) => Number(run.day_number) === Number(dayNumber)) || null;
}

function planEnduranceSessionFromParts(
  opts: {
    kind: PlanEnduranceRunKind;
    label: string;
    date: string | null;
    dayNumber: number | null;
    km: unknown;
    min: unknown;
    zone: unknown;
    interval: unknown;
    note: string;
    status: "open" | "completed";
    today: string;
    raceBuild: PlanEnduranceRaceBuild | null | undefined;
    units?: unknown;
    morning?: string;
  }
): PlanEnduranceBriefingSession {
  const pace = planEndurancePaceBand(opts.kind, opts.label, opts.raceBuild);
  const setup = planEnduranceSetup(opts.kind, opts.interval, opts.note);
  return {
    kind: opts.kind,
    label: opts.label,
    when: planEnduranceWhen(opts.date, opts.today, opts.dayNumber),
    date: opts.date,
    day_number: opts.dayNumber,
    prescription: planEndurancePrescription(opts.km, opts.min, opts.interval, opts.zone, pace, opts.units),
    setup,
    expect: planEnduranceExpect(opts.kind, opts.note, pace, setup),
    sitsBy: planEnduranceSitsBy(opts.dayNumber, opts.date, opts.raceBuild),
    status: opts.status,
    ...(opts.morning ? { morning: opts.morning } : {}),
  };
}

function planEnduranceIntentDate(intent: PlanEnduranceIntent): string | null {
  if (intent.status === "completed" && intent.completion?.date) return planEnduranceDayKey(intent.completion.date) || null;
  return planEnduranceDayKey(intent.suggested_date || intent.provisional_date) || null;
}

function planEnduranceSessionsFromAgenda(
  agenda: PlanEnduranceAgenda,
  runPlan: PlanEnduranceRunPlan | null | undefined,
  raceBuild: PlanEnduranceRaceBuild | null | undefined,
  today: string,
  units?: unknown
): PlanEnduranceBriefingSession[] {
  return agenda.intents
    .filter((intent) => intent.status !== "completed")
    .map((intent) => {
      const dayNumber = Number(intent.provisional_day_number);
      const matched = planEnduranceMatchRun(
        runPlan,
        intent.kind,
        Number.isFinite(dayNumber) ? dayNumber : null
      );
      const label = String(intent.label || matched?.label || `${planEnduranceKindLabel(intent.kind)} run`);
      const note = String(matched?.note || "").trim();
      const date = planEnduranceIntentDate(intent);
      // Today's quality or long run carries the server's morning call on it.
      const morning = date && date === today ? String(intent.adjustment?.why || "").trim() : "";
      return planEnduranceSessionFromParts({
        kind: intent.kind,
        label,
        date,
        dayNumber: Number.isFinite(dayNumber) ? dayNumber : null,
        km: intent.target_distance_km ?? matched?.target_distance_km,
        min: intent.target_duration_min ?? matched?.target_duration_min,
        zone: intent.target_zone ?? matched?.target_zone,
        interval: matched?.interval ?? null,
        note,
        status: "open",
        today,
        raceBuild,
        units,
        morning,
      });
    })
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function planEnduranceSessionsFromPlan(
  runPlan: PlanEnduranceRunPlan,
  raceBuild: PlanEnduranceRaceBuild | null | undefined,
  today: string,
  units?: unknown
): PlanEnduranceBriefingSession[] {
  const weekStart = planEnduranceDayKey(runPlan.week_start);
  return runPlan.runs
    .map((run) => {
      const dayNumber = Number(run.day_number);
      const date = weekStart && Number.isFinite(dayNumber) && dayNumber >= 1
        ? planEnduranceAddDays(weekStart, dayNumber - 1)
        : null;
      if (date && date < today) return null;
      const kind = (run.kind_label === "quality" || run.kind_label === "long" ? run.kind_label : "easy") as PlanEnduranceRunKind;
      const label = String(run.label || `${planEnduranceKindLabel(kind)} run`);
      return planEnduranceSessionFromParts({
        kind,
        label,
        date,
        dayNumber: Number.isFinite(dayNumber) ? dayNumber : null,
        km: run.target_distance_km,
        min: run.target_duration_min,
        zone: run.target_zone,
        interval: run.interval ?? null,
        note: String(run.note || "").trim(),
        status: "open",
        today,
        raceBuild,
        units,
      });
    })
    .filter((session): session is PlanEnduranceBriefingSession => !!session)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function planEnduranceCollectWeek(
  week: PlanEnduranceBriefingWeek | null | undefined,
  today: string,
  units?: unknown
): { sessions: PlanEnduranceBriefingSession[]; why: string } {
  if (!week) return { sessions: [], why: "" };
  let sessions: PlanEnduranceBriefingSession[] = [];
  if (week.agenda && week.agenda.available !== false && Array.isArray(week.agenda.intents) && week.agenda.intents.length) {
    sessions = planEnduranceSessionsFromAgenda(week.agenda, week.runPlan, week.raceBuild, today, units);
  } else if (planEnduranceRunAvailable(week.runPlan)) {
    sessions = planEnduranceSessionsFromPlan(week.runPlan, week.raceBuild, today, units);
  }
  const why = String(week.runPlan?.why || week.raceBuild?.this_week?.why || "").trim();
  return { sessions, why };
}

function planEnduranceBuildBriefing(input: PlanEnduranceBriefingInput): PlanEnduranceBriefing {
  const today = planEnduranceDayKey(input.today);
  const units = planEnduranceRunUnits(input.units);
  const weeks: PlanEnduranceBriefingWeek[] = Array.isArray(input.weeks) && input.weeks.length
    ? input.weeks
    : [
        { agenda: input.agenda, runPlan: input.runPlan, raceBuild: input.raceBuild },
        { agenda: input.nextAgenda, runPlan: input.nextRunPlan, raceBuild: input.nextRaceBuild },
        { agenda: input.laterAgenda, runPlan: input.laterRunPlan, raceBuild: input.laterRaceBuild },
      ];
  const collected = weeks.map((week) => planEnduranceCollectWeek(week, today, units)).filter((row) => row.sessions.length);
  const sessions = collected.flatMap((row) => row.sessions);
  const next = sessions[0] || null;
  const remaining = sessions.slice(1, PLAN_ENDURANCE_REVIEW_COUNT);
  const later = sessions.slice(PLAN_ENDURANCE_REVIEW_COUNT);
  const horizon = planEnduranceHorizonOf(next?.date, today);
  return {
    horizon,
    kicker: planEnduranceKicker(horizon),
    headline: collected[0]?.why || "",
    units,
    next,
    remaining,
    later,
  };
}

function planEnduranceContrib(label: string, state: string, tone: "ok" | "watch" | "quiet"): string {
  if (!label.trim() && !state.trim()) return "";
  const t = tone === "ok" || tone === "watch" ? tone : "quiet";
  const labelHtml = label.trim() ? `<span class="read-contrib-label">${escHtml(label)}</span>` : "";
  const stateHtml = state.trim() ? `<span class="read-contrib-state">${escHtml(state)}</span>` : "";
  return `<div class="read-contrib"><span class="read-contrib-pip ${t}" aria-hidden="true"></span>${labelHtml}${stateHtml}</div>`;
}

function planEnduranceUnitsToggle(units: "km" | "mi"): string {
  const btn = (value: "km" | "mi", label: string) =>
    `<button type="button" class="end-unit-btn${units === value ? " on" : ""}" data-run-units="${value}" aria-pressed="${units === value}">${escHtml(label)}</button>`;
  return `<div class="end-units" role="group" aria-label="Distance and pace units">${btn("km", "km")}${btn("mi", "mi")}</div>`;
}

function planEnduranceThenRows(sessions: PlanEnduranceBriefingSession[]): string {
  return sessions.map((session) =>
    `<div class="end-then-row ${planEnduranceKindClass(session.kind)}">
        <span class="end-then-when">${escHtml(session.when)}</span>
        <span class="end-then-name">${escHtml(session.label)}</span>
        ${session.prescription ? `<span class="end-then-pres numeral">${escHtml(session.prescription)}</span>` : ""}
      </div>`
  ).join("");
}

function planEnduranceBriefingHtml(briefing: PlanEnduranceBriefing | null | undefined, start = 0): string {
  if (!briefing) return "";
  const lead = briefing.headline
    ? `<p class="end-brief-lead reveal" style="${stagger(start)}"><span class="lbl">${escHtml(briefing.kicker)}</span> ${escHtml(briefing.headline)}</p>`
    : briefing.next
      ? `<p class="end-brief-lead reveal" style="${stagger(start)}"><span class="lbl">${escHtml(briefing.kicker)}</span></p>`
      : "";
  const next = briefing.next;
  const nextHtml = next
    ? `<div class="end-next reveal" style="${stagger(start + 1)}" data-end-next>
        <span class="lbl end-next-kicker">${escHtml(next.date && next.when.startsWith("Today") ? "Today" : "Next")}</span>
        <div class="end-next-when">${escHtml(next.when)}</div>
        <div class="end-next-name">${escHtml(next.label)}</div>
        ${next.prescription ? `<div class="end-next-pres numeral">${escHtml(next.prescription)}</div>` : ""}
        <div class="read-contribs">
          ${next.morning ? planEnduranceContrib("This morning", next.morning, "quiet") : ""}
          ${planEnduranceContrib("Setup", next.setup, "quiet")}
          ${planEnduranceContrib("Expect", next.expect, "quiet")}
          ${planEnduranceContrib("Sits by", next.sitsBy, "quiet")}
        </div>
      </div>`
    : "";
  const remainingHtml = briefing.remaining.length
    ? `<div class="end-then reveal" style="${stagger(start + 2)}">
        <span class="lbl">Then</span>
        <div class="end-then-rows">${planEnduranceThenRows(briefing.remaining)}</div>
      </div>`
    : "";
  const laterHtml = briefing.later.length
    ? `<details class="end-later reveal" style="${stagger(start + 3)}">
        <summary><span class="lbl">Later in the build</span></summary>
        <div class="end-then-rows">${planEnduranceThenRows(briefing.later)}</div>
      </details>`
    : "";
  if (!lead && !nextHtml && !remainingHtml && !laterHtml) return "";
  return `<div class="end-brief card-stack-item">
    <div class="end-brief-bar">${lead || `<p class="end-brief-lead"><span class="lbl">${escHtml(briefing.kicker)}</span></p>`}${planEnduranceUnitsToggle(briefing.units)}</div>
    ${nextHtml}${remainingHtml}${laterHtml}
  </div>`;
}

const CAIRN_PLAN_ENDURANCE_MODEL = {
  ENDURANCE_PHASES: PLAN_ENDURANCE_PHASES,
  rampHtml: planEnduranceRampHtml,
  presets: planEndurancePresets,
  draftCardHtml: planEnduranceDraftCardHtml,
  record: planEnduranceRecord,
  mondayOf: planEnduranceMondayOf,
  nextMonday: planEnduranceNextMonday,
  weekBanked: planEnduranceWeekBanked,
  buildBriefing: planEnduranceBuildBriefing,
  briefingHtml: planEnduranceBriefingHtml,
};

Object.assign(globalThis, {
  CairnPlanEnduranceModel: CAIRN_PLAN_ENDURANCE_MODEL,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnPlanEnduranceModel: CAIRN_PLAN_ENDURANCE_MODEL,
  });
}

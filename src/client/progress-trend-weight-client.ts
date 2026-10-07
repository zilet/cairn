// @ts-check
// Progress trend and bodyweight presentation helpers.

// A one-lb noise band: a session-to-session wobble under this reads as "holding",
// never a false climb/slide.
const ONE_RM_FLAT_BAND_LB = 2;

const ONE_RM_CLIMB_VARIANTS = [
  "{name} is climbing steadily{sessions}.",
  "{name} keeps trending up{sessions}.",
  "{name} is on the rise{sessions}.",
];
const ONE_RM_HOLD_VARIANTS = [
  "{name} is holding steady{sessions}.",
  "{name}'s holding right where it's been{sessions}.",
  "{name} is level for now{sessions}.",
];
const ONE_RM_SLIDE_VARIANTS = [
  "{name} has eased back a touch{sessions}.",
  "{name} has drifted down recently{sessions}.",
  "{name} is a little lighter than its peak{sessions}.",
];
const ONE_RM_THIN_VARIANTS = [
  "Just getting started with {name} — a few more sessions and there'll be a real trend to read.",
  "Still early for {name} — the trend comes into focus after a few more sessions.",
];

// ONE lead sentence for the est-1RM trend (Amendment 2: read before chart). Pure
// over the same points array the chart already draws — no new payload needed.
// `pts` is oldest-first, one best-set-of-the-day per entry.
function oneRmReadLine(name: string, pts: Array<{ date: string; v: number }>): string {
  const label = String(name || "this lift");
  if (pts.length < 2) {
    return pickDayVariant(ONE_RM_THIN_VARIANTS, pts[0]?.date, `1rm-lead:thin:${label}`).replace(/\{name\}/g, label);
  }
  const latestDate = pts[pts.length - 1].date;
  const delta = pts[pts.length - 1].v - pts[0].v;
  // "This month" = the trailing 30 days off the latest logged date, so the count
  // reads honestly against a routed past date too, not just today.
  const cutoff = new Date(`${latestDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const monthCount = pts.filter((p) => p.date >= cutoffISO).length;
  const sessions = monthCount > 0 ? ` — ${monthCount} best-set${monthCount === 1 ? "" : "s"} this month` : "";
  const variants =
    delta > ONE_RM_FLAT_BAND_LB ? ONE_RM_CLIMB_VARIANTS : delta < -ONE_RM_FLAT_BAND_LB ? ONE_RM_SLIDE_VARIANTS : ONE_RM_HOLD_VARIANTS;
  const dirKey = delta > ONE_RM_FLAT_BAND_LB ? "up" : delta < -ONE_RM_FLAT_BAND_LB ? "down" : "flat";
  return pickDayVariant(variants, latestDate, `1rm-lead:${dirKey}:${label}`)
    .replace(/\{name\}/g, label)
    .replace("{sessions}", sessions);
}

// The 1RM picker lists loaded lifts: mobility drills, core work and timed holds have
// no one-rep max to chart. It opens on the lift trained most recently, never on the
// alphabet's first drill with "No data".
function oneRmPickerExercises(exercises: ProgressExercise[]): ProgressExercise[] {
  const loaded = exercises.filter((e) => {
    const group = String(e.muscle_group ?? "").toLowerCase();
    return group !== "mobility" && group !== "core" && String(e.mode ?? "reps") !== "timed";
  });
  return loaded.length ? loaded : exercises;
}

function lastTrainedExercise(exercises: ProgressExercise[]): string | undefined {
  let best: ProgressExercise | undefined;
  for (const e of exercises) {
    const at = typeof e.last_logged === "string" ? e.last_logged : "";
    if (at && (!best || at > String(best.last_logged))) best = e;
  }
  return best?.name ?? exercises[0]?.name;
}

// The chosen lift's series (/progress/<name>) carries the hero line above the chart,
// so the body paints once it is in hand: from its SWR peek at once on a warm open,
// else after the read (the skeleton holds). Painting the shell first and the hero
// later pushed the picker and chart down under the athlete's thumb.
const ONE_RM_SERIES_KEY = "progress:1rm:";

function paintProgressBody(exercises: ProgressExercise[]): void {
  const token = pollToken;
  const allExercises = exercises;
  exercises = oneRmPickerExercises(allExercises);
  const saved =
    state.progressEx && allExercises.some((e) => e.name === state.progressEx)
      ? state.progressEx
      : lastTrainedExercise(exercises);
  const name = saved ?? "";
  const key = ONE_RM_SERIES_KEY + name;
  const peek = name ? peekCached(key) : null;
  const live = () => token === pollToken && state.tab === "progress" && state.progressSeg === "trend";
  const series = name
    ? cachedApi(`/progress/${encodeURIComponent(name)}`, {
        key,
        onUpgrade: (data, { changed }) => {
          if (peek && changed && live() && $<HTMLSelectElement>("#exsel")?.value === name) paintOneRm(name, data);
        },
      })
    : Promise.resolve(null);
  if (peek) {
    paintProgressShell(exercises, allExercises, saved);
    paintOneRm(name, peek.data);
    return;
  }
  void series
    .catch(() => null)
    .then((data) => {
      if (!live()) return;
      paintProgressShell(exercises, allExercises, saved);
      if (name) paintOneRm(name, data);
    });
}

function paintProgressShell(exercises: ProgressExercise[], allExercises: ProgressExercise[], saved: string | undefined): void {
  view.innerHTML = segBar("trend", PROGRESS_SEG) + `<div id="trendHero"></div>
    <div class="field"><label>Exercise</label>
    <select id="exsel">${(exercises.some((e) => e.name === saved) ? exercises : [...exercises, ...allExercises.filter((e) => e.name === saved)]).map((e) => `<option ${e.name === saved ? "selected" : ""}>${escHtml(e.name)}</option>`).join("")}</select></div>
    <canvas id="chart" class="pchart is-strength"></canvas><div id="pstats"></div>`;
  wireSeg(PROGRESS_HANDLERS);
  const select = $<HTMLSelectElement>("#exsel");
  if (select) select.addEventListener("change", () => { state.progressEx = select.value; drawProgress(select.value); });
}

// Pounds still between the athlete and their goal, in the goal's direction (never
// negative-means-done for a gain): the stated goal mode wins, then the recorded
// start weight, then the first weigh-in on the chart.
function weightToGoal(last: number, goal: number, profile: ProgressRecord, first: number): number {
  const mode = profile.goal_mode;
  const start = profile.start_weight_lb != null ? CairnProgressData.number(profile.start_weight_lb) : first;
  const gaining = mode === "gain" || (mode !== "lose" && mode !== "maintain" && start < goal);
  if (mode === "maintain") return Math.round(Math.abs(last - goal) * 10) / 10;
  return Math.max(0, Math.round((gaining ? goal - last : last - goal) * 10) / 10);
}

function paintWeightBody(rows: ProgressWeightRow[], profile: ProgressRecord): void {
  const head = segBar("weight", PROGRESS_SEG);
  const pts = rows.map((p) => ({ date: CairnProgressData.string(p.date), v: CairnProgressData.number(p.weight_lb) }));
  if (!pts.length) {
    view.innerHTML = head + progressHero("Bodyweight", []) +
      emptyStateHtml(art("activity", "walk"), "No weigh-ins yet — log one from the Today strip.");
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const goalW = profile.goal_weight_lb != null ? CairnProgressData.number(profile.goal_weight_lb) : null;
  const first = pts[0].v, last = pts[pts.length - 1].v;
  const delta = Math.round((last - first) * 10) / 10;
  // "To go" is measured in the goal's own direction: a gain reads its shortfall
  // below the goal, a cut its excess above it. Only a reading within half a pound,
  // or already past the goal in that direction, is "at your goal".
  const toGoal = goalW != null ? weightToGoal(last, goalW, profile, first) : null;
  // One voice line and one fact; the goal-pace read above carries the pace. Every
  // weight in the athlete's unit (CairnFmt); the series stays canonical lb.
  const w = (lb: number): string => CairnFmt.weight(lb);
  const hero = progressHero("Bodyweight", [], {
    line:
      toGoal == null
        ? `${w(last)} today.`
        : toGoal > 0.5
          ? `${w(last)}, ${CairnFmt.weight(toGoal, undefined, true)} ${profile.goal_mode === "maintain" ? "from your goal" : "to go"}.`
          : `${w(last)} — at your goal.`,
    fact: pts.length > 1 ? `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${w(Math.abs(delta))} since ${fmtShortDate(pts[0].date)}` : "",
    meta: `${pts.length} weigh-in${pts.length === 1 ? "" : "s"}${goalW != null ? ` · goal ${w(goalW)}` : ""}`,
  });
  // The goal-pace read (when it resolves) is unified to LEAD, ahead of the numeral
  // hero — see mountGoalPaceChart in progress-screen.ts, which fills this anchor.
  view.innerHTML = head + `<div id="weightLeadMount"></div>` + hero + `<canvas id="chart" class="pchart is-body"></canvas>`;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  drawLineChart($<HTMLCanvasElement>("#chart"), pts, { goal: goalW ?? null, fmt: (v) => w(v) });
}

async function drawProgress(name: string): Promise<void> {
  const data = await cachedApi(`/progress/${encodeURIComponent(name)}`, { key: ONE_RM_SERIES_KEY + name }).catch(() => null);
  paintOneRm(name, data);
}

function paintOneRm(name: string, data: unknown): void {
  const row = CairnProgressData.record(data);
  const canvas = $<HTMLCanvasElement>("#chart"), stats = $<HTMLElement>("#pstats"), heroWrap = $<HTMLElement>("#trendHero");
  if (!canvas || !canvas.isConnected) return; // navigated away mid-fetch
  const pts = CairnProgressData.rows<ProgressRecord>(row.points).map((p) => ({
    date: CairnProgressData.string(p.date),
    v: CairnProgressData.number(p.best1rm),
  }));
  if (!pts.length) {
    if (heroWrap) heroWrap.innerHTML = progressHero("Estimated 1RM", []);
    canvas.style.display = "none";
    if (stats) stats.innerHTML = emptyStateHtml(art("exercise", name), `No data for ${name} yet.`);
    return;
  }
  canvas.style.display = "";
  // The read IS the voice line; one fact carries the number it is about.
  const first = pts[0].v, last = pts[pts.length - 1].v;
  const delta = Math.round((last - first) * 10) / 10;
  const unit = String(row.unit || "lb");
  if (heroWrap) {
    heroWrap.innerHTML = progressHero("Estimated 1RM", [], {
      line: oneRmReadLine(name, pts),
      fact: `est. 1RM ${Math.round(last)} ${unit}${pts.length > 1 ? ` · ${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} since the first` : ""}`,
    });
  }
  drawLineChart(canvas, pts, { peak: true });
  if (stats) stats.innerHTML = `<div class="chart-foot lbl">Epley est. · best set per day · ${escHtml(row.unit || "lb")} · ▲ all-time peak</div>`;
}

const CAIRN_PROGRESS_TREND_WEIGHT = {
  paintProgressBody,
  paintWeightBody,
  drawProgress,
  oneRmReadLine,
};

Object.assign(globalThis, {
  CairnProgressTrendWeight: CAIRN_PROGRESS_TREND_WEIGHT,
  paintProgressBody,
  paintWeightBody,
  drawProgress,
  oneRmReadLine,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressTrendWeight: CAIRN_PROGRESS_TREND_WEIGHT,
    paintProgressBody,
    paintWeightBody,
    drawProgress,
    oneRmReadLine,
  });
}

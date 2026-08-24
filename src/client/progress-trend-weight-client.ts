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

function paintProgressBody(exercises: ProgressExercise[]): void {
  const saved = state.progressEx || exercises[0]?.name;
  view.innerHTML = segBar("trend", PROGRESS_SEG) + `<p id="trendLead" class="progress-read"></p>
    <div id="trendHero"></div>
    <div class="field"><label>Exercise</label>
    <select id="exsel">${exercises.map((e) => `<option ${e.name === saved ? "selected" : ""}>${escHtml(e.name)}</option>`).join("")}</select></div>
    <canvas id="chart"></canvas><div id="pstats"></div>`;
  wireSeg(PROGRESS_HANDLERS);
  const select = $<HTMLSelectElement>("#exsel");
  if (select) select.addEventListener("change", () => { state.progressEx = select.value; drawProgress(select.value); });
  drawProgress(saved);
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
  const toGoal = goalW != null ? Math.round((last - goalW) * 10) / 10 : null;
  const hero = progressHero("Bodyweight", [
    ["current · lb", last, { text: true }],
    ["change", `${delta >= 0 ? "+" : ""}${delta}`, { text: true }],
    toGoal != null ? ["to goal", toGoal > 0 ? String(toGoal) : "at goal", { text: true }] : null,
  ]);
  // The goal-pace read (when it resolves) is unified to LEAD, ahead of the numeral
  // hero — see mountGoalPaceChart in progress-screen.ts, which fills this anchor.
  view.innerHTML = head + `<div id="weightLeadMount"></div>` + hero + `<canvas id="chart"></canvas>
    <div class="chart-foot lbl">${pts.length} weigh-in${pts.length === 1 ? "" : "s"}${goalW != null ? ` · goal ${goalW} lb` : ""}</div>`;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  drawLineChart($<HTMLCanvasElement>("#chart"), pts, { goal: goalW ?? null, fmt: (v) => `${Math.round(v * 10) / 10} lb` });
}

async function drawProgress(name: string): Promise<void> {
  const data = await api("/progress/" + encodeURIComponent(name));
  const row = CairnProgressData.record(data);
  const canvas = $<HTMLCanvasElement>("#chart"), stats = $<HTMLElement>("#pstats"), heroWrap = $<HTMLElement>("#trendHero");
  const leadWrap = $<HTMLElement>("#trendLead");
  if (!canvas || !canvas.isConnected) return; // navigated away mid-fetch
  const pts = CairnProgressData.rows<ProgressRecord>(row.points).map((p) => ({
    date: CairnProgressData.string(p.date),
    v: CairnProgressData.number(p.best1rm),
  }));
  if (!pts.length) {
    if (leadWrap) leadWrap.innerHTML = "";
    if (heroWrap) heroWrap.innerHTML = progressHero("Estimated 1RM", []);
    canvas.style.display = "none";
    if (stats) stats.innerHTML = emptyStateHtml(art("exercise", name), `No data for ${name} yet.`);
    return;
  }
  canvas.style.display = "";
  if (leadWrap) leadWrap.innerHTML = escHtml(oneRmReadLine(name, pts));
  const first = pts[0].v, last = pts[pts.length - 1].v;
  const delta = Math.round((last - first) * 10) / 10;
  if (heroWrap) {
    heroWrap.innerHTML = progressHero("Estimated 1RM", [
      ["current est-1rm", Math.round(last)],
      ["since first", `${delta >= 0 ? "+" : ""}${delta}`, { text: true }],
      ["sessions", pts.length],
    ]);
    runCountUps(heroWrap);
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

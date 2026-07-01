// @ts-check
// Progress trend and bodyweight presentation helpers.

function paintProgressBody(exercises: ProgressExercise[]): void {
  const saved = state.progressEx || exercises[0]?.name;
  view.innerHTML = segBar("trend", PROGRESS_SEG) + `<div id="trendHero"></div>
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
  view.innerHTML = head + hero + `<canvas id="chart"></canvas>
    <div class="chart-foot lbl">${pts.length} weigh-in${pts.length === 1 ? "" : "s"}${goalW != null ? ` · goal ${goalW} lb` : ""}</div>`;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  drawLineChart($<HTMLCanvasElement>("#chart"), pts, { goal: goalW ?? null, fmt: (v) => `${Math.round(v * 10) / 10} lb` });
}

async function drawProgress(name: string): Promise<void> {
  const data = await api("/progress/" + encodeURIComponent(name));
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
};

Object.assign(globalThis, {
  CairnProgressTrendWeight: CAIRN_PROGRESS_TREND_WEIGHT,
  paintProgressBody,
  paintWeightBody,
  drawProgress,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressTrendWeight: CAIRN_PROGRESS_TREND_WEIGHT,
    paintProgressBody,
    paintWeightBody,
    drawProgress,
  });
}

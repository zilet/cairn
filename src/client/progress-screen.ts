// ==== 05-progress.js ====
// ---------- Progress: est-1RM trend ----------
// SWR over /exercises (key progress:exercises): the 1RM seg paints its exercise
// picker + chart shell instantly on a warm re-entry, then revalidates.
async function renderProgress() {
  headerTitle.textContent = "1RM";
  state.progressSeg = "trend";
  const token = ++pollToken;
  const peek = peekCached("progress:exercises");
  if (!peek) view.innerHTML = segSkeleton("trend", PROGRESS_SEG, 1); // cold: skeleton-first
  return paintSWR({
    key: "progress:exercises",
    path: "/exercises",
    peek: peek as never,
    token,
    tab: "progress",
    render: (exercises: unknown) => CairnProgressTrendWeight.paintProgressBody(CairnProgressData.rows<ProgressExercise>(exercises)),
  });
}

// ---------- Progress: bodyweight ----------
// SWR over /bodyweight?limit=90 (key progress:weight) + the shared /profile (key
// `profile`, for the goal line): the Weight seg paints its chart instantly on a
// warm re-entry, then revalidates. A bodyweight log invalidates progress:weight.
async function renderWeight() {
  headerTitle.textContent = "Weight";
  state.progressSeg = "weight";
  const token = ++pollToken;
  const peekRows = peekCached("progress:weight");
  const peekProfile = peekCached("profile");
  if (!peekRows) view.innerHTML = segSkeleton("weight", PROGRESS_SEG, 1); // cold: skeleton-first
  // The goal-pace read rides alongside the weigh-in series: a separate,
  // best-effort fetch that overlays the honest "trend vs the pace you need to
  // hit your goal" chart onto the Weight view. It stays null until it resolves
  // (and when the endpoint is absent), so the existing view is untouched without it.
  let goalPace: unknown = null;
  const paint = (rows: unknown, profile: unknown) => {
    if (token !== pollToken || state.tab !== "progress") return;
    CairnProgressTrendWeight.paintWeightBody(CairnProgressData.rows<ProgressWeightRow>(rows), CairnProgressData.record(profile));
    mountGoalPaceChart(token, goalPace);
  };
  // Profile rides along (peeked + revalidated under its shared key); the weight
  // rows are the SWR-keyed surface that actually changes here.
  let profile = peekProfile ? peekProfile.data : null;
  cachedApi("/profile", { key: "profile", onUpgrade: (data) => { profile = data; } }).catch(() => {});
  // Best-effort goal-pace overlay; a missing endpoint leaves the Weight view
  // exactly as it was (it never throws into the render path).
  api("/nutrition/goal-pace?days=90").then((gp) => { goalPace = gp; mountGoalPaceChart(token, goalPace); }).catch(() => {});
  if (peekRows) { paint(peekRows.data, profile); if (!peekRows.fresh) markRefreshing(true); }
  cachedApi("/bodyweight?limit=90", {
    key: "progress:weight",
    onUpgrade: (rows, { changed }) => { if (peekRows && !peekRows.fresh) markRefreshing(false); if (changed || !peekRows) skelSwap(() => paint(rows, profile)); },
  }).catch(() => { if (peekRows && !peekRows.fresh) markRefreshing(false); });
}

// ---------- Progress: goal-pace chart (Weight view) ----------
// The single most honest lean-out visual: the athlete's actual weigh-in trend
// against the pace needed to reach their goal by its date. Built as a pure
// function (payload in -> SVG card string out) so it renders identically on every
// surface and is unit-testable without a DOM. Returns "" when there's nothing
// honest to draw (no endpoint, no weigh-ins, no goal to aim at with a single
// point) so the existing Weight view is left exactly as it was. Numbers go into
// geometry attributes; every text label is escaped. Adherence-NEUTRAL: the read
// states the trend and, only if behind, the pace that would meet the date —
// information, never blame. No score, ever (constitution).

// A ms timestamp -> "Oct 4". UTC to match the UTC-parsed ISO dates (no off-by-one).
function gpaceMonthDay(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(ms);
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// A signed weekly rate with a true minus sign: "−0.8" (bare) / "−0.8 lb/wk".
function gpaceRateNum(r: number): string {
  const a = Math.round(Math.abs(r) * 10) / 10;
  return `${r < 0 ? "−" : r > 0 ? "+" : ""}${a}`;
}
function gpaceRate(r: number): string {
  return `${gpaceRateNum(r)} lb/wk`;
}

function gpaceLb(v: number): string {
  return String(Math.round(v * 10) / 10);
}

// A finite number or NaN — treating null/undefined/"" as ABSENT (NaN), not 0.
// The server hands back {weight_lb:null, lb_wk:null, …} rather than dropping the
// keys, and Number(null) === 0 would silently invent a "0 lb" goal or a
// "Trending 0 lb/wk" read; NaN makes every Number.isFinite guard do the right thing.
function gpaceNum(v: unknown): number {
  if (v == null || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// A server-provided 2-point line ({date,weight_lb}×2) -> sorted [{t,v},{t,v}], or
// [] when it isn't a usable pair (null / short / non-numeric).
function gpaceLine(line: unknown): Array<{ t: number; v: number }> {
  const out = CairnProgressData.rows<ProgressRecord>(line)
    .map((p) => ({ t: Date.parse(CairnProgressData.string(p.date)), v: gpaceNum(p.weight_lb) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  return out.length === 2 ? out.sort((a, b) => a.t - b.t) : [];
}

// Nicely-rounded gridline step near `rough` (1/2/5 × 10ⁿ).
function gpaceNiceStep(rough: number): number {
  const r = Math.max(0.5, rough);
  const pow = 10 ** Math.floor(Math.log10(r));
  const n = r / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return m * pow;
}

function goalPaceChartHtml(gp: unknown): string {
  const rec = CairnProgressData.record(gp);
  const pts = CairnProgressData.rows<ProgressRecord>(rec.points)
    .map((p) => ({ t: Date.parse(CairnProgressData.string(p.date)), v: gpaceNum(p.weight_lb) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return "";

  const goal = CairnProgressData.record(rec.goal);
  const goalW = gpaceNum(goal.weight_lb);
  const goalT = Date.parse(CairnProgressData.string(goal.date));
  const hasGoal = Number.isFinite(goalW) && Number.isFinite(goalT);
  // A single weigh-in with nothing to aim at has no honest pace story — leave the
  // existing view untouched rather than plotting a lone dot.
  if (pts.length < 2 && !hasGoal) return "";

  const trend = CairnProgressData.record(rec.trend);
  const needed = CairnProgressData.record(rec.needed);
  const trendLine = gpaceLine(trend.line);
  const neededLine = hasGoal ? gpaceLine(needed.line) : [];

  // Domains over everything we'll actually draw (the goal sits in the future, so
  // the x-axis naturally extends past the last weigh-in toward the target).
  const ts = [...pts.map((p) => p.t), ...trendLine.map((p) => p.t), ...neededLine.map((p) => p.t)];
  const vs = [...pts.map((p) => p.v), ...trendLine.map((p) => p.v), ...neededLine.map((p) => p.v)];
  if (hasGoal) { ts.push(goalT); vs.push(goalW); }
  const xMin = Math.min(...ts);
  let xMax = Math.max(...ts);
  if (xMax === xMin) xMax = xMin + 1;
  let yMin = Math.min(...vs), yMax = Math.max(...vs);
  // Never dramatize a 2-lb wiggle: floor the visible weight span to ≥8 lb (or 5%
  // of current bodyweight, whichever is larger), then pad.
  const ref = pts[pts.length - 1].v;
  const minSpan = Math.max(8, ref * 0.05);
  if (yMax - yMin < minSpan) {
    const mid = (yMax + yMin) / 2;
    yMin = mid - minSpan / 2;
    yMax = mid + minSpan / 2;
  }
  const padY = (yMax - yMin) * 0.12;
  yMin -= padY;
  yMax += padY;

  const W = 328, H = 168, L = 14, R = 16, T = 16, B = 26;
  const px = (t: number) => L + ((t - xMin) / (xMax - xMin)) * (W - L - R);
  const py = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);

  // 2–3 unobtrusive y gridlines at nicely-rounded weights.
  const step = gpaceNiceStep((yMax - yMin) / 2.4);
  const ticks: number[] = [];
  for (let tk = Math.ceil(yMin / step) * step; tk <= yMax + 1e-6 && ticks.length < 4; tk += step) ticks.push(tk);
  const grid = ticks.map((tk) =>
    `<line class="gpace-grid" x1="${L}" y1="${py(tk).toFixed(1)}" x2="${W - R}" y2="${py(tk).toFixed(1)}" stroke="#e7dfd2" stroke-width="1"/>` +
    `<text class="gpace-ylbl" x="${L}" y="${(py(tk) - 3).toFixed(1)}" fill="#9a907d" font-size="9">${escHtml(gpaceLb(tk))}</text>`
  ).join("");

  // The weigh-in series: a soft dotted line + quiet dots that recede so the trend pops.
  const seriesPts = pts.map((p) => `${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`).join(" ");
  const seriesLine = pts.length > 1
    ? `<polyline class="gpace-series" points="${seriesPts}" fill="none" stroke="#c0b6a0" stroke-width="1.5" stroke-dasharray="1.5 3.5" stroke-linecap="round"/>`
    : "";
  const seriesDots = pts.map((p) => `<circle class="gpace-dot" cx="${px(p.t).toFixed(1)}" cy="${py(p.v).toFixed(1)}" r="2" fill="#a1937c"/>`).join("");

  // The trend line — terracotta, solid, a touch heavier (the honest current trajectory).
  let trendSvg = "";
  if (trendLine.length === 2) {
    const [a, b] = trendLine;
    trendSvg = `<line class="gpace-trend" x1="${px(a.t).toFixed(1)}" y1="${py(a.v).toFixed(1)}" x2="${px(b.t).toFixed(1)}" y2="${py(b.v).toFixed(1)}" stroke="#b4552d" stroke-width="2.6" stroke-linecap="round"/>` +
      `<circle class="gpace-trend-dot" cx="${px(b.t).toFixed(1)}" cy="${py(b.v).toFixed(1)}" r="3.4" fill="#b4552d"/>`;
  }

  // The needed pace — sage, dashed, from today to the goal point.
  let neededSvg = "";
  if (neededLine.length === 2) {
    const [a, b] = neededLine;
    neededSvg = `<line class="gpace-needed" x1="${px(a.t).toFixed(1)}" y1="${py(a.v).toFixed(1)}" x2="${px(b.t).toFixed(1)}" y2="${py(b.v).toFixed(1)}" stroke="#6e7f5c" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>`;
  }

  // The goal — a quiet sage ring with a small label ("172 lb · Oct 4"), placed to
  // read inward so it never overflows the right edge.
  let goalSvg = "";
  if (hasGoal) {
    const gx = px(goalT), gy = py(goalW);
    const rightish = gx > W * 0.6;
    const lx = rightish ? gx - 9 : gx + 9;
    const label = `${gpaceLb(goalW)} lb · ${gpaceMonthDay(goalT)}`;
    goalSvg = `<circle class="gpace-goal-ring" cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="5" fill="#fffdf8" stroke="#6e7f5c" stroke-width="2"/>` +
      `<circle class="gpace-goal-dot" cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="1.8" fill="#6e7f5c"/>` +
      `<text class="gpace-goal-lbl" x="${lx.toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="${rightish ? "end" : "start"}" fill="#5f6e4f" font-size="9.5" font-weight="600">${escHtml(label)}</text>`;
  }

  // Axis date labels: left = first weigh-in; the right end is the goal (its marker
  // already carries the date), so only add a right axis date when there's no goal.
  const axis =
    `<text class="gpace-xlbl" x="${L}" y="${H - 7}" text-anchor="start" fill="#9a907d" font-size="9">${escHtml(gpaceMonthDay(pts[0].t))}</text>` +
    (hasGoal ? "" : `<text class="gpace-xlbl" x="${W - R}" y="${H - 7}" text-anchor="end" fill="#9a907d" font-size="9">${escHtml(gpaceMonthDay(pts[pts.length - 1].t))}</text>`);

  // The one-line read beneath — only with a goal (per spec, no goal → no read line).
  const trendRate = gpaceNum(trend.lb_wk);
  const neededRate = gpaceNum(needed.lb_wk);
  let read = "";
  let readCls = "gpace-read";
  if (hasGoal && Number.isFinite(trendRate)) {
    const goalLabel = gpaceMonthDay(goalT);
    if (Number.isFinite(neededRate)) {
      const dir = neededRate < 0 ? -1 : neededRate > 0 ? 1 : 0;
      const progress = trendRate * dir; // movement toward the goal per week
      const onPace = dir === 0 ? Math.abs(trendRate) <= 0.15 : progress >= Math.abs(neededRate) - 0.05;
      // Lean-safe-first: a cut running well past the needed rate (>=1.5x, both
      // negative) is still "on pace" for styling, but the copy should say so
      // plainly rather than read as if it exactly matched the target rate.
      const aheadOfPace =
        onPace && trendRate < 0 && neededRate < 0 && Math.abs(trendRate) >= 1.5 * Math.abs(neededRate);
      read = aheadOfPace
        ? `Trending ${gpaceRate(trendRate)} — ahead of the needed pace for ${goalLabel}.`
        : onPace
          ? `Trending ${gpaceRate(trendRate)} — on pace for ${goalLabel}.`
          : `Trending ${gpaceRate(trendRate)}; ${gpaceRateNum(neededRate)} would meet ${goalLabel}.`;
      readCls = onPace ? "gpace-read gpace-read-on" : "gpace-read gpace-read-behind";
    } else {
      read = `Trending ${gpaceRate(trendRate)} toward ${goalLabel}.`;
    }
  }
  const readHtml = read ? `<div class="${readCls}">${escHtml(read)}</div>` : "";
  const aria = read || (hasGoal ? "Your weight trend against goal pace." : "Your weight trend.");

  return `<div class="gpace reveal" style="${stagger(1)}">` +
    `<div class="gpace-head lbl">Goal pace</div>` +
    `<svg class="gpace-chart" viewBox="0 0 ${W} ${H}" data-yspan="${(yMax - yMin).toFixed(1)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escAttr(aria)}">` +
      grid + seriesLine + seriesDots + neededSvg + trendSvg + goalSvg + axis +
    `</svg>` +
    readHtml +
    `</div>`;
}

// Inject (or refresh) the goal-pace card into the current Weight body. The body
// itself is painted by CairnProgressTrendWeight.paintWeightBody in a sibling
// module, so we compose from the route here: drop the SVG card in above the
// weigh-in canvas and hide that canvas (the goal-pace chart supersedes it). When
// there's nothing honest to draw we remove any prior card and restore the canvas,
// so the Weight view is byte-for-byte its old self whenever the endpoint is absent.
function mountGoalPaceChart(token: number, gp: unknown): void {
  if (token !== pollToken || state.tab !== "progress" || state.progressSeg !== "weight") return;
  const prior = view.querySelector(".gpace-mount");
  if (prior) prior.remove();
  const canvas = view.querySelector<HTMLCanvasElement>("#chart");
  const html = goalPaceChartHtml(gp);
  if (!html) { if (canvas) canvas.hidden = false; return; }
  const parent = canvas?.parentNode;
  if (!canvas || !parent) return;
  const mount = document.createElement("div");
  mount.className = "gpace-mount";
  mount.innerHTML = html; // fully escaped inside goalPaceChartHtml
  parent.insertBefore(mount, canvas);
  canvas.hidden = true;
}

// ---------- Progress: body measurements + indicators ----------
// The Body group's second leaf: at-home tape measurements + derived indicators
// (BMI / waist-to-height / Navy body-fat) and per-site trends. The seg bar keeps the
// two-level Progress nav; the self-contained body-metrics client paints into the mount.
async function renderMeasurements() {
  headerTitle.textContent = "Measurements";
  state.progressSeg = "measurements";
  view.innerHTML = segBar("measurements", PROGRESS_SEG) + `<div id="bodyMetricsMount"></div>`;
  wireSeg(PROGRESS_HANDLERS);
  renderBodyMetrics(document.getElementById("bodyMetricsMount"));
}

// ---------- Progress: volume by muscle group ----------
// SWR over /volume?days=30 (key progress:volume): the Volume seg paints the
// per-muscle bars instantly on a warm re-entry, then revalidates.
async function renderVolume() {
  headerTitle.textContent = "Volume";
  state.progressSeg = "volume";
  const token = ++pollToken;
  const peek = peekCached("progress:volume");
  if (!peek) view.innerHTML = segSkeleton("volume", PROGRESS_SEG, 2); // cold: skeleton-first
  return paintSWR({
    key: "progress:volume",
    path: "/volume?days=30",
    peek: peek as never,
    token,
    tab: "progress",
    render: (data: unknown) => paintVolumeBody(CairnProgressData.record(data)),
  });
}

function paintVolumeBody(data: ProgressRecord) {
  const groups = CairnProgressData.rows<ProgressVolumeGroup>(data.by_muscle).slice()
    .sort((a, b) => CairnProgressData.number(b.sets) - CairnProgressData.number(a.sets));
  const head = segBar("volume", PROGRESS_SEG);
  if (!groups.length) {
    view.innerHTML = head + progressHero("Volume", []) +
      emptyStateHtml(art("exercise", "barbell row"), `Nothing logged in the last ${CairnProgressData.number(data.days, 30)} days.`);
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const totalSets = groups.reduce((t, g) => t + CairnProgressData.number(g.sets), 0);
  const maxSets = Math.max(1, ...groups.map((g) => CairnProgressData.number(g.sets)));
  const hero = progressHero("Volume", [
    ["sets · 30d", totalSets],
    ["lb moved · 30d", data.total_tonnage || 0, { k: true }],
    ["top muscle", groups[0].muscle_group, { text: true }],
  ]);
  const rows = groups.map((g, i) => `
    <div class="volrow reveal" style="${stagger(i + 2)}">
      <div class="volrow-top">
        <span class="volrow-name">${escHtml(g.muscle_group)}</span>
        <span class="volrow-meta"><b>${CairnProgressData.number(g.sets)}</b> set${CairnProgressData.number(g.sets) === 1 ? "" : "s"} · ${CairnProgressData.number(g.tonnage).toLocaleString()} lb</span>
      </div>
      <div class="volbar"><div class="volbar-fill barfill" style="width:${Math.max(3, Math.round((CairnProgressData.number(g.sets) / maxSets) * 100))}%"></div></div>
    </div>`).join("");
  view.innerHTML = head + hero +
    `<div id="volBalanceSlot" class="vol-balance-slot reveal" style="${stagger(1)}"></div>` +
    `<div class="vol-kicker lbl reveal" style="${stagger(2)}">Last ${CairnProgressData.number(data.days, 30)} days · ranked by sets</div>` + rows;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  // The balance read settles in above the bars (best-effort, async) — the engine
  // reads your volume per canonical muscle group, names what's DUE and what's
  // running high, and flags the patterns (core / grip / mobility) that are absent.
  loadVolumeBalance();
}

// ---------- Volume: the balance read (which groups are due / high / missing) ----------
// Fed by GET /api/program/balance — working-set volume per CANONICAL group banded
// against the volume landmarks, in PLAIN WORDS (never a 0–100 grade). Surfaces the
// adherence skew (summary) + the due / high groups + the missing-pattern gaps the
// new taxonomy made visible (core, forearms/grip). Best-effort + null-safe: the
// SURFACE endpoint may not be wired yet (404) — guard like every optional fetch,
// leaving the bars untouched if it's missing. Constitution: pull, never push.
async function loadVolumeBalance() {
  const slot = view.querySelector("#volBalanceSlot");
  if (!slot) return;
  let bal = null;
  try { bal = await api("/program/balance"); } catch { bal = null; }
  if (state.tab !== "progress" || state.progressSeg !== "volume" || !slot.isConnected) return;
  const html = volBalanceHtml(bal);
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
}

// ---------- Progress: Endurance (runner/cyclist-first read) ----------
async function renderEndurance() {
  await CairnProgressEnduranceController.render(CairnProgressRouteDeps.endurance(() => renderEndurance()));
}

function _paintEnduranceBody(
  end: unknown,
  prs: import("../contracts/client-api.js").ClientEndurancePRs | null,
  goal: import("../contracts/client-api.js").ClientEnduranceGoal | null,
  compliance: import("../contracts/client-api.js").ClientRunCompliance | null,
  settings: unknown,
  runPlan: import("../contracts/client-api.js").ClientWeeklyRunPlan | null,
) {
  CairnProgressEnduranceController.paint(
    end,
    prs,
    goal,
    compliance,
    settings,
    runPlan,
    null,
    CairnProgressRouteDeps.endurance(() => renderEndurance()),
  );
}

// SWR over /calendar?days=84 (key progress:calendar): the Calendar seg paints its
// month grids instantly on a warm re-entry, then revalidates.
async function renderCalendar() {
  headerTitle.textContent = "Calendar";
  state.progressSeg = "calendar";
  const token = ++pollToken;
  const peek = peekCached("progress:calendar");
  if (!peek) view.innerHTML = segSkeleton("calendar", PROGRESS_SEG, 2); // cold: skeleton-first
  return paintSWR({
    key: "progress:calendar",
    path: "/calendar?days=84",
    peek: peek as never,
    token,
    tab: "progress",
    render: (data: unknown) => paintCalendarBody(CairnProgressData.record(data)),
  });
}

function paintCalendarBody(data: ProgressRecord) {
  const cells = CairnProgressData.rows<ProgressCalendarCell>(data.cells);
  const head = segBar("calendar", PROGRESS_SEG);
  if (!cells.length) {
    view.innerHTML = head + progressHero("Calendar", []) +
      emptyStateHtml(art("activity", "run"), "No activity logged yet.");
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const todayIso = localISO();
  const byDate = new Map(cells.map((c) => [CairnProgressData.string(c.date), c]));
  const ym = todayIso.slice(0, 7);
  const monthSessions = cells.filter((c) => (c.date || "").slice(0, 7) === ym && c.lifted).length;
  const activeDays = cells.filter((c) => c.lifted || c.activity).length;
  // Honest continuity, not a streak: cumulative session counts that never reset.
  // (A reset-on-miss "day streak" is the chain-you-fear-breaking mechanic the
  // constitution rules out — §2/§6C of VISION.md. The deterministic streak value
  // still exists in getWeeklyStats for agent context; it just isn't surfaced here.)
  const windowSessions = cells.filter((c) => c.lifted).length;
  const hero = progressHero("Calendar", [
    ["sessions this month", monthSessions],
    ["sessions · 12wk", windowSessions],
    ["active days · 84d", activeDays],
  ]);
  const months = [...new Set(cells.map((c) => CairnProgressData.string(c.date).slice(0, 7)))].filter(Boolean).reverse();
  const grids = months.map((mo, i) => calMonthHtml(mo, byDate, todayIso, i + 1)).join("");
  const legend = `<div class="cal-legend"><span>Less</span><i class="cl0"></i><i class="cl1"></i><i class="cl2"></i><i class="cl3"></i><i class="cl4"></i><span>More</span></div>`;
  view.innerHTML = head + hero + grids + legend;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  // tap a day with data → open it on Today
  view.querySelectorAll<HTMLElement>(".cal-day[data-goto]").forEach((el) =>
    el.addEventListener("click", () => {
      state.logDate = el.dataset.goto || state.logDate;
      state.day = null;
      state.dayPicked = false;
      activateTab("today");
    })
  );
}

// ---------- Progress: Energy Balance (adaptive, MacroFactor-style) ----------
// A calm editorial read of derived expenditure (real TDEE from intake −
// Δweighted-bodyweight). Adherence-NEUTRAL: never scolds about logging gaps,
// never shows a gauge or a score. When there's not enough data, a quiet
// "keep logging when you can". A subtle "run a check-in" affordance sits below;
// the check-in is an ADVISORY recommendation (no clean one-click target field —
// calories live in the meal plan), never an auto-apply.
// SWR over /nutrition/expenditure?window=21 (key progress:energy): the Energy
// Balance seg paints its derived read instantly on a warm re-entry, then
// revalidates. The shell (#checkinResult) is preserved across re-fills so an
// in-flight nutrition check-in card is never clobbered by a background refresh.
async function renderEnergy() {
  headerTitle.textContent = "Energy";
  state.progressSeg = "energy";
  const token = ++pollToken;
  const head = segBar("energy", PROGRESS_SEG);
  const peek = peekCached("progress:energy");
  // Verbal read leads (Amendment 2); the numeric hero is demoted below it. Always
  // paint the shell; only the #energyCard slot shows a loading state on cold.
  view.innerHTML = head + `<div id="energyCard">${peek ? "" : loadingState("Reading your trend…")}</div>
    <div id="energyHero"></div>
    <div id="checkinResult" class="checkin-result"></div>`;
  wireSeg(PROGRESS_HANDLERS);

  const paint = (exp: unknown) => {
    if (token !== pollToken || !view.querySelector("#energyCard")) return;
    paintEnergyBody(exp);
  };
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/nutrition/expenditure?window=21", {
    key: "progress:energy",
    onUpgrade: (exp, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(exp); },
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); });
}

// Energy Balance DOM painting and durable nutrition check-in reconnect live in
// /js/progress-energy-surface-client.js so Progress and Plan Food share one
// implementation. This screen keeps only the route/SWR shell above.

// ---------- Progress: Program (adaptive program intelligence) ----------
// The controller owns Program SWR orchestration, conductor state, DOM composition,
// and actions. The shared route dependency adapter lives in progress-route-deps-client.
async function renderProgram() {
  return CairnProgressProgramController.render(CairnProgressRouteDeps.program(() => renderProgram()));
}

Object.assign(globalThis, {
  renderCalendar,
  renderEnergy,
  renderEndurance,
  renderProgram,
  renderProgress,
  renderVolume,
  renderWeight,
  renderMeasurements,
  goalPaceChartHtml,
  mountGoalPaceChart,
});

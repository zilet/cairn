// ==== 05-progress.js ====
// ---------- Progress: shared premium helpers ----------
const fmtShortDate = (iso) => {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return String(iso || "");
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

// Hero band at the top of every Progress sub-view: serif heading + key numerals.
// stats: [label, value, opts?] \u2014 opts.text renders as-is (no count-up), opts.k humanizes.
function progressHero(title, stats) {
  const cells = (stats || []).filter(Boolean).map(([label, value, opts = {}]) => {
    const fig = opts.text
      ? `<span class="phero-n numeral${String(value).length > 6 ? " phero-n-sm" : ""}">${escHtml(String(value))}</span>`
      : `<span class="phero-n numeral" data-cu="${Number(value) || 0}"${opts.k ? ` data-cufmt="k"` : ""}>0</span>`;
    return `<div class="phero-stat">${fig}<span class="lbl">${escHtml(label)}</span></div>`;
  }).join("");
  return `<div class="phero reveal" style="${stagger(0)}">
      <h2 class="phero-title">${escHtml(title)}</h2>
      ${cells ? `<div class="phero-stats">${cells}</div>` : ""}
    </div>`;
}

// Consistent empty state: illustration plate + one serif line.
function emptyStateHtml(svg, line) {
  return `<div class="empty-state reveal" style="${stagger(1)}">
      <div class="artile artile-lg">${svg || art("exercise", "")}</div>
      <div class="empty-state-line">${escHtml(line)}</div>
    </div>`;
}

// Canvas charts read their palette from the :root CSS tokens (never hardcoded
// hexes) so they can't drift from the design system. Resolved once per draw.
// `gridline`/`grid-label` have no token, so they derive from the palette here.
// Hex (#rgb / #rrggbb) → "rgba(r,g,b,a)" so canvas fills can layer a token color
// at a given opacity (gridlines, area gradient, halo) without hardcoding the hex.
function withAlpha(hex, a) {
  let h = String(hex || "").trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  if (h.length < 6) return `rgba(0,0,0,${a})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  return {
    accent: v("--accent", "#b4552d"),
    sage: v("--sage", "#6e7f5c"),
    gold: v("--gold", "#c9a86a"),
    ink: v("--ink", "#211d17"),
    paper: v("--paper", "#f4efe7"),
    card: v("--card", "#fffdf8"),
    line2: v("--line-2", "#d8cfbd"),
    label: v("--muted", "#746c5c"),
  };
}

// Shared premium line chart: monotone-cubic curve, soft gradient area fill, light
// gridlines with y labels, first/last date x labels, emphasized final point with
// an ink value badge, optional sage dashed goal line and \u25b2 at the all-time peak.
function drawLineChart(canvas, pts, opts = {}) {
  if (!canvas) return;
  const C = chartColors();
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const c = canvas.getContext("2d"); c.scale(dpr, dpr);
  c.clearRect(0, 0, W, H);
  const n = pts.length;
  if (!n) return;
  const vals = pts.map((p) => p.v);
  const allV = opts.goal != null ? [...vals, opts.goal] : vals;
  let min = Math.min(...allV), max = Math.max(...allV);
  if (max === min) { max += 1; min -= 1; }
  const spread = max - min;
  min -= spread * 0.14; max += spread * 0.2;
  const padL = 36, padR = 16, padT = 30, padB = 28;
  const x = (i) => n === 1 ? (padL + W - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => H - padB - ((v - min) / (max - min)) * (H - padT - padB);
  const fmtVal = opts.fmt || ((v) => String(Math.round(v)));

  // gridlines + y labels
  c.font = "10px 'Schibsted Grotesk', sans-serif";
  for (let g = 0; g <= 3; g++) {
    const v = min + ((max - min) * g) / 3;
    const yy = y(v);
    c.strokeStyle = withAlpha(C.line2, 0.55); c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, yy); c.lineTo(W - padR, yy); c.stroke();
    c.fillStyle = C.label;
    c.textAlign = "right";
    c.fillText(String(Math.round(v)), padL - 7, yy + 3);
  }
  c.textAlign = "left";

  // goal reference line (sage, dashed)
  if (opts.goal != null) {
    const gy = y(opts.goal);
    c.save();
    c.strokeStyle = C.sage; c.setLineDash([5, 5]); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(padL, gy); c.lineTo(W - padR, gy); c.stroke();
    c.restore();
    c.fillStyle = C.sage; c.font = "600 9px 'Schibsted Grotesk', sans-serif";
    c.fillText(`GOAL ${opts.goal}`, padL + 3, gy - 5);
  }

  const xs = vals.map((_, i) => x(i)), ys = vals.map((v) => y(v));

  // monotone-cubic tangents (Fritsch\u2013Carlson) so the smooth curve never overshoots
  const ms = new Array(n).fill(0);
  if (n > 1) {
    const d = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    ms[0] = d[0]; ms[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) ms[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { ms[i] = 0; ms[i + 1] = 0; continue; }
      const a = ms[i] / d[i], b = ms[i + 1] / d[i], h = Math.hypot(a, b);
      if (h > 3) { ms[i] = (3 * a / h) * d[i]; ms[i + 1] = (3 * b / h) * d[i]; }
    }
  }
  const tracePath = () => {
    c.beginPath();
    c.moveTo(xs[0], ys[0]);
    for (let i = 0; i < n - 1; i++) {
      const dx = (xs[i + 1] - xs[i]) / 3;
      c.bezierCurveTo(xs[i] + dx, ys[i] + ms[i] * dx, xs[i + 1] - dx, ys[i + 1] - ms[i + 1] * dx, xs[i + 1], ys[i + 1]);
    }
  };

  if (n > 1) {
    // soft terracotta area fill fading to nothing
    tracePath();
    c.lineTo(xs[n - 1], H - padB); c.lineTo(xs[0], H - padB); c.closePath();
    const grad = c.createLinearGradient(0, padT, 0, H - padB);
    grad.addColorStop(0, withAlpha(C.accent, 0.16));
    grad.addColorStop(1, withAlpha(C.accent, 0));
    c.fillStyle = grad; c.fill();
    // the line itself
    tracePath();
    c.strokeStyle = C.accent; c.lineWidth = 2.25; c.lineJoin = "round"; c.lineCap = "round";
    c.stroke();
    // quiet intermediate points
    c.fillStyle = C.accent;
    for (let i = 0; i < n - 1; i++) { c.beginPath(); c.arc(xs[i], ys[i], 2, 0, 7); c.fill(); }
  }

  // \u25b2 at the all-time peak (when it isn't the final point)
  if (opts.peak && n > 1) {
    let pi = 0; vals.forEach((v, i) => { if (v > vals[pi]) pi = i; });
    if (pi !== n - 1) {
      c.fillStyle = C.gold; c.font = "10px 'Schibsted Grotesk', sans-serif"; c.textAlign = "center";
      c.fillText("\u25b2", xs[pi], ys[pi] - 9);
      c.textAlign = "left";
    }
  }

  // emphasized final point + ink value badge
  const lx = xs[n - 1], ly = ys[n - 1];
  c.beginPath(); c.arc(lx, ly, 8, 0, 7); c.fillStyle = withAlpha(C.accent, 0.16); c.fill();
  c.beginPath(); c.arc(lx, ly, 4.5, 0, 7); c.fillStyle = C.accent; c.fill();
  c.beginPath(); c.arc(lx, ly, 4.5, 0, 7); c.strokeStyle = C.card; c.lineWidth = 1.6; c.stroke();
  const lastTxt = fmtVal(vals[n - 1]);
  c.font = "600 11px 'Schibsted Grotesk', sans-serif";
  const tw = c.measureText(lastTxt).width;
  const bx = Math.min(Math.max(lx - tw / 2 - 8, padL), W - padR - tw - 16);
  let by = ly - 32; if (by < 4) by = ly + 14;
  c.fillStyle = C.ink;
  if (c.roundRect) { c.beginPath(); c.roundRect(bx, by, tw + 16, 20, 10); c.fill(); }
  else c.fillRect(bx, by, tw + 16, 20);
  c.fillStyle = C.paper;
  c.fillText(lastTxt, bx + 8, by + 14);

  // first / last date labels
  c.fillStyle = C.label; c.font = "10px 'Schibsted Grotesk', sans-serif";
  c.textAlign = "left"; c.fillText(fmtShortDate(pts[0].date), padL, H - 8);
  if (n > 1) { c.textAlign = "right"; c.fillText(fmtShortDate(pts[n - 1].date), W - padR, H - 8); }
  c.textAlign = "left";
}

// ---------- Progress: History ----------
// One editorial session card: serif weekday, date kicker, tonnage/duration chips,
// per-exercise lines with the best set emphasized.
function sessionCardHtml(s, i) {
  const [y, m, d] = (s.date || "").split("-").map(Number);
  const weekday = y ? new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long" }) : "";
  const byEx = {};
  for (const set of s.sets || []) (byEx[set.exercise] ??= []).push(set);
  const score = (x) => x.duration_sec != null ? x.duration_sec
    : (x.weight > 0 && x.reps ? x.weight * (1 + x.reps / 30) : (x.reps || 0));
  const lines = Object.entries(byEx).map(([ex, sets]) => {
    let bi = 0; sets.forEach((x, j) => { if (score(x) > score(sets[bi])) bi = j; });
    const figs = sets.map((x, j) => {
      const fig = x.duration_sec != null ? fmtDur(x.duration_sec) : `${fmtWeight(x.weight)}\u00d7${x.reps}`;
      return `<span class="hist-set${j === bi && sets.length > 1 ? " hist-best" : ""}">${fig}</span>`;
    }).join(`<span class="hist-sep">\u00b7</span>`);
    return `<div class="hist-line"><span class="hist-ex">${escHtml(ex)}</span><span class="hist-sets">${figs}</span></div>`;
  }).join("");
  const tonnage = setsTonnage(s.sets);
  const nSets = (s.sets || []).length;
  const chips = [
    tonnage ? `${fmtK(Math.round(tonnage))} lb` : null,
    s.duration_min ? `${s.duration_min} min` : null,
    `${nSets} set${nSets === 1 ? "" : "s"}`,
  ].filter(Boolean).map((t) => `<span class="hist-chip">${t}</span>`).join("");
  return `<div class="sess hist hist-tap reveal" data-sessid="${s.id}" role="button" tabindex="0" style="${stagger(i)}" aria-label="Edit ${escAttr(weekday)} session">
      <div class="hist-head">
        <div>
          <div class="hist-kicker lbl">${fmtShortDate(s.date)}${s.day_name ? ` \u00b7 ${escHtml(s.day_name)}` : ""}</div>
          <div class="hist-day">${escHtml(weekday)}<span class="hist-edit" aria-hidden="true">edit</span></div>
        </div>
        <div class="hist-chips">${chips}</div>
      </div>
      ${lines || `<div class="hist-line"><span class="hist-ex" style="color:var(--muted)">No sets</span></div>`}
      ${s.notes ? `<div class="hist-notes">\u201c${escHtml(s.notes)}\u201d</div>` : ""}
    </div>`;
}

// SWR over /sessions?limit=30 (key history:sessions): a warm re-entry into the
// History seg paints the hero + session cards instantly, then revalidates and
// re-paints only on change. A set-log / session-edit invalidates the key.
async function renderHistory() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "sessions"; // remember the chosen seg so the default never yanks back
  const token = ++pollToken;
  const peek = peekCached("history:sessions");
  if (!peek) view.innerHTML = segSkeleton("sessions", PROGRESS_SEG, 3); // cold: skeleton-first
  return paintSWR({
    key: "history:sessions",
    path: "/sessions?limit=30",
    peek,
    token,
    tab: "progress",
    render: (sessions) => paintHistoryBody(sessions || []),
  });
}

// Build + wire the History view from a sessions list. Idempotent: re-queries the
// freshly-written DOM each call (warm peek + changed revalidate both route here).
function paintHistoryBody(sessions) {
  const head = segBar("sessions", PROGRESS_SEG);
  if (!sessions.length) {
    view.innerHTML = head + progressHero("Training history", []) +
      emptyStateHtml(art("exercise", "barbell squat"), "No sessions logged yet \u2014 your story starts on Today.");
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const ym = localISO().slice(0, 7);
  const iso30 = localISO(new Date(Date.now() - 30 * 864e5));
  const inMonth = sessions.filter((s) => (s.date || "").slice(0, 7) === ym).length;
  const last30 = sessions.filter((s) => (s.date || "") >= iso30);
  const t30 = last30.reduce((t, s) => t + setsTonnage(s.sets), 0);
  const sets30 = last30.reduce((t, s) => t + (s.sets || []).length, 0);
  const hero = progressHero("Training history", [
    ["sessions this month", inMonth],
    ["lb moved \u00b7 30d", Math.round(t30), { k: true }],
    ["sets \u00b7 30d", sets30],
  ]);
  view.innerHTML = head + hero + `<div class="sess-grid">${sessions.map((s, i) => sessionCardHtml(s, i + 1)).join("")}</div>`;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  // Tap a past session → edit its logged sets + notes (corrections flow into the brain).
  const openFrom = (card) => {
    const sess = sessions.find((s) => s.id === Number(card.dataset.sessid));
    if (sess) openSessionEdit(sess, card);
  };
  view.querySelectorAll(".hist-tap[data-sessid]").forEach((card) => {
    card.addEventListener("click", () => openFrom(card));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFrom(card); } });
  });
}

// Edit a past session: correct any logged set's numbers (or duration), delete a
// mis-entry, fix the notes. Saves via PUT /sets/:id + PUT /sessions/:id/notes — and
// because trainingSignals re-reads sessions live, the coach sees the correction on
// its next read. No score, no judgement — just "fix what you logged".
async function openSessionEdit(sess, fromEl) {
  const sets = (sess.sets || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  const byEx = {};
  for (const s of sets) (byEx[s.exercise] ??= []).push(s);
  const groups = Object.entries(byEx).map(([ex, list]) => {
    const setRows = list.map((s) => {
      const timed = s.duration_sec != null || s.mode === "timed";
      const fields = timed
        ? `<input class="edset-dur" inputmode="numeric" value="${s.duration_sec != null ? fmtDur(s.duration_sec) : ""}" placeholder="1:30" aria-label="duration">`
        : `<input class="edset-w" type="number" inputmode="decimal" value="${s.weight ?? ""}" placeholder="wt" aria-label="weight">
           <input class="edset-r" type="number" inputmode="numeric" value="${s.reps ?? ""}" placeholder="reps" aria-label="reps">
           <input class="edset-rir" type="number" inputmode="numeric" value="${s.rir ?? ""}" placeholder="rir" aria-label="rir">`;
      return `<div class="edset" data-setid="${s.id}" data-kind="${timed ? "timed" : "reps"}">
          ${fields}
          <button class="edset-del" data-eddel="${s.id}" title="Delete set" aria-label="Delete set">×</button>
        </div>`;
    }).join("");
    return `<div class="ed-exgroup"><div class="ed-exname">${escHtml(ex)}</div>${setRows}</div>`;
  }).join("");

  openDetailFrom(fromEl, () => {
    const el = mountDetail(`
      <h2 class="detail-title">${escHtml(sess.day_name || "Session")}</h2>
      <div class="detail-ctx lbl">${escHtml(fmtShortDate(sess.date))} · edit logged sets</div>
      <div class="ed-sets">${groups || `<div class="detail-body" style="color:var(--muted)">No sets logged.</div>`}</div>
      <div class="detail-section"><div class="lbl">Session notes</div>
        <textarea id="edNotes" class="ed-notes" rows="2" placeholder="How did it go?">${escHtml(sess.notes || "")}</textarea></div>
      <div class="detail-actions">
        <button class="pillbtn pill-accent" id="edSave">Save changes</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`);
    wireDetailCommon();
    // delete a set inline — two-tap armed × (the one destructive-confirm pattern),
    // then the row collapses out (deletion is committed on the confirming tap).
    el.querySelectorAll("[data-eddel]").forEach((b) => b.addEventListener("click", () => armDelete(b, async () => {
      try { await api(`/sets/${b.dataset.eddel}`, { method: "DELETE" }); } catch { toast("Couldn't delete set"); return; }
      const row = b.closest(".edset"); if (row) collapseEl(row, () => row.remove());
    })));
    const save = el.querySelector("#edSave");
    if (save) save.addEventListener("click", async () => {
      save.disabled = true;
      const tasks = [];
      el.querySelectorAll(".edset").forEach((row) => {
        if (!row.isConnected) return; // a set deleted mid-edit
        const id = row.dataset.setid;
        const body = row.dataset.kind === "timed"
          ? { duration_sec: parseDur(row.querySelector(".edset-dur").value) }
          : {
              weight: numOrNull(row.querySelector(".edset-w").value),
              reps: numOrNull(row.querySelector(".edset-r").value),
              rir: numOrNull(row.querySelector(".edset-rir").value),
            };
        tasks.push(api(`/sets/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      });
      tasks.push(api(`/sessions/${sess.id}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: el.querySelector("#edNotes").value.trim() }) }));
      try { await Promise.all(tasks); toast("Updated"); } catch { toast("Some changes didn't save"); }
      // corrected sets/notes change the History list, weekly stats, volume, and (if
      // it's that date's session) Today — drop the caches so renderHistory below and
      // any later paint read truth.
      swrInvalidate("history:sessions");
      swrInvalidate("stats");
      swrInvalidate("progress:volume");
      if (sess.date) swrInvalidate("today:session:" + sess.date);
      closeDetail(true);
      renderHistory();
    });
  });
}
// Coerce an edit-field value to a number or null. The empty-string guard is
// load-bearing: a blank input must clear the field, but Number("") is 0 — so don't
// "simplify" it away to a bare Number.isFinite check.
function numOrNull(v) { return v === "" || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null); }

// ---------- Progress: est-1RM trend ----------
// SWR over /exercises (key progress:exercises): the 1RM seg paints its exercise
// picker + chart shell instantly on a warm re-entry, then revalidates.
async function renderProgress() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "trend";
  const token = ++pollToken;
  const peek = peekCached("progress:exercises");
  if (!peek) view.innerHTML = segSkeleton("trend", PROGRESS_SEG, 1); // cold: skeleton-first
  return paintSWR({
    key: "progress:exercises",
    path: "/exercises",
    peek,
    token,
    tab: "progress",
    render: (exercises) => paintProgressBody(exercises || []),
  });
}

function paintProgressBody(exercises) {
  const saved = state.progressEx || exercises[0]?.name;
  view.innerHTML = segBar("trend", PROGRESS_SEG) + `<div id="trendHero"></div>
    <div class="field"><label>Exercise</label>
    <select id="exsel">${exercises.map((e) => `<option ${e.name === saved ? "selected" : ""}>${escHtml(e.name)}</option>`).join("")}</select></div>
    <canvas id="chart"></canvas><div id="pstats"></div>`;
  wireSeg(PROGRESS_HANDLERS);
  $("#exsel").addEventListener("change", (e) => { state.progressEx = e.target.value; drawProgress(e.target.value); });
  drawProgress(saved);
}

// ---------- Progress: bodyweight ----------
// SWR over /bodyweight?limit=90 (key progress:weight) + the shared /profile (key
// `profile`, for the goal line): the Weight seg paints its chart instantly on a
// warm re-entry, then revalidates. A bodyweight log invalidates progress:weight.
async function renderWeight() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "weight";
  const token = ++pollToken;
  const peekRows = peekCached("progress:weight");
  const peekProfile = peekCached("profile");
  if (!peekRows) view.innerHTML = segSkeleton("weight", PROGRESS_SEG, 1); // cold: skeleton-first
  const paint = (rows, profile) => {
    if (token !== pollToken || state.tab !== "progress") return;
    paintWeightBody(rows || [], profile || null);
  };
  // Profile rides along (peeked + revalidated under its shared key); the weight
  // rows are the SWR-keyed surface that actually changes here.
  let profile = peekProfile ? peekProfile.data : null;
  cachedApi("/profile", { key: "profile", onUpgrade: (data) => { profile = data; } }).catch(() => {});
  if (peekRows) { paint(peekRows.data, profile); if (!peekRows.fresh) markRefreshing(true); }
  cachedApi("/bodyweight?limit=90", {
    key: "progress:weight",
    onUpgrade: (rows, { changed }) => { if (peekRows && !peekRows.fresh) markRefreshing(false); if (changed || !peekRows) skelSwap(() => paint(rows, profile)); },
  }).catch(() => { if (peekRows && !peekRows.fresh) markRefreshing(false); });
}

function paintWeightBody(rows, profile) {
  const head = segBar("weight", PROGRESS_SEG);
  const pts = (rows || []).map((p) => ({ date: p.date, v: p.weight_lb }));
  if (!pts.length) {
    view.innerHTML = head + progressHero("Bodyweight", []) +
      emptyStateHtml(art("activity", "walk"), "No weigh-ins yet — log one from the Today strip.");
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const goalW = profile?.goal_weight_lb;
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
  drawLineChart($("#chart"), pts, { goal: goalW ?? null, fmt: (v) => `${Math.round(v * 10) / 10} lb` });
}

async function drawProgress(name) {
  const data = await api("/progress/" + encodeURIComponent(name));
  const canvas = $("#chart"), stats = $("#pstats"), heroWrap = $("#trendHero");
  if (!canvas || !canvas.isConnected) return; // navigated away mid-fetch
  const pts = (data.points || []).map((p) => ({ date: p.date, v: p.best1rm }));
  if (!pts.length) {
    if (heroWrap) heroWrap.innerHTML = progressHero("Estimated 1RM", []);
    canvas.style.display = "none";
    stats.innerHTML = emptyStateHtml(art("exercise", name), `No data for ${name} yet.`);
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
  stats.innerHTML = `<div class="chart-foot lbl">Epley est. · best set per day · ${escHtml(data.unit || "lb")} · ▲ all-time peak</div>`;
}

// ---------- Progress: volume by muscle group ----------
// SWR over /volume?days=30 (key progress:volume): the Volume seg paints the
// per-muscle bars instantly on a warm re-entry, then revalidates.
async function renderVolume() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "volume";
  const token = ++pollToken;
  const peek = peekCached("progress:volume");
  if (!peek) view.innerHTML = segSkeleton("volume", PROGRESS_SEG, 2); // cold: skeleton-first
  return paintSWR({
    key: "progress:volume",
    path: "/volume?days=30",
    peek,
    token,
    tab: "progress",
    render: (data) => paintVolumeBody(data || {}),
  });
}

function paintVolumeBody(data) {
  const groups = (data.by_muscle || []).slice().sort((a, b) => (b.sets || 0) - (a.sets || 0));
  const head = segBar("volume", PROGRESS_SEG);
  if (!groups.length) {
    view.innerHTML = head + progressHero("Volume", []) +
      emptyStateHtml(art("exercise", "barbell row"), `Nothing logged in the last ${data.days || 30} days.`);
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const totalSets = groups.reduce((t, g) => t + (g.sets || 0), 0);
  const maxSets = Math.max(1, ...groups.map((g) => g.sets || 0));
  const hero = progressHero("Volume", [
    ["sets · 30d", totalSets],
    ["lb moved · 30d", data.total_tonnage || 0, { k: true }],
    ["top muscle", groups[0].muscle_group, { text: true }],
  ]);
  const rows = groups.map((g, i) => `
    <div class="volrow reveal" style="${stagger(i + 2)}">
      <div class="volrow-top">
        <span class="volrow-name">${escHtml(g.muscle_group)}</span>
        <span class="volrow-meta"><b>${g.sets}</b> set${g.sets === 1 ? "" : "s"} · ${(g.tonnage || 0).toLocaleString()} lb</span>
      </div>
      <div class="volbar"><div class="volbar-fill barfill" style="width:${Math.max(3, Math.round(((g.sets || 0) / maxSets) * 100))}%"></div></div>
    </div>`).join("");
  view.innerHTML = head + hero +
    `<div class="vol-kicker lbl reveal" style="${stagger(1)}">Last ${data.days || 30} days · ranked by sets</div>` + rows;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
}

// ---------- Progress: Endurance (runner/cyclist-first read) ----------
// The endurance analogue to the 1RM view: this week's mileage + moving time, the
// longest single effort, a calm time-in-HR-zone bar, the pace trend in plain words
// (never a grade), and endurance PRs (longest distance + best pace by distance).
// Fed by /api/stats `.endurance` + /api/endurance-prs. No 0–100 scores anywhere.
// Plain-word pace-trend read. Never a verdict, never a grade — just direction.
function paceTrendWord(pt) {
  if (!pt || pt.dir == null || pt.this_min_per_km == null) return "";
  if (pt.dir === "steady") return "holding about the same pace as last week";
  if (pt.prev_min_per_km == null) return `averaging ${fmtPaceKm(pt.this_min_per_km)}/km`;
  const delta = Math.abs(pt.this_min_per_km - pt.prev_min_per_km);
  const mag = delta < 0.15 ? "a touch" : delta < 0.5 ? "a little" : "noticeably";
  return pt.dir === "faster" ? `${mag} faster than last week` : `${mag} easier than last week`;
}

// Calm time-in-HR-zone bar (reuses the Today garmin-card .gz-* vocabulary). zones is
// the { Z1: secs, Z2: secs, … } map from /stats .endurance.time_in_zone. "" when empty.
function zoneBarHtml(zones) {
  const entries = Object.entries(zones || {})
    .map(([k, secs]) => ({ zi: Math.min(5, Math.max(1, Number(String(k).replace(/\D/g, "")) || 1)), secs: Number(secs) || 0 }))
    .filter((z) => z.secs > 0)
    .sort((a, b) => a.zi - b.zi);
  const total = entries.reduce((t, z) => t + z.secs, 0);
  if (total <= 0) return "";
  const colors = (typeof HR_ZONE_COLORS !== "undefined" && HR_ZONE_COLORS) || ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"];
  const segs = entries.map((z) => {
    const pct = (z.secs / total) * 100;
    const mins = Math.round(z.secs / 60);
    return `<span class="gz-seg" style="width:${pct.toFixed(1)}%;background:${colors[z.zi - 1]}" title="Zone ${z.zi} · ${mins} min"></span>`;
  }).join("");
  return `<div class="end-zones reveal" style="${stagger(3)}">
      <div class="lbl" style="margin-bottom:6px">Time in heart-rate zones · this week</div>
      <div class="gz-bar">${segs}</div>
      <div class="gz-legend lbl">${entries.map((z) => `Z${z.zi} ${Math.round(z.secs / 60)}m`).join(" · ")}</div>
    </div>`;
}

async function renderEndurance() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "endurance";
  const token = ++pollToken;
  view.innerHTML = segBar("endurance", PROGRESS_SEG) + `<div id="endBody">${loadingState("Reading your week…")}</div>`;
  wireSeg(PROGRESS_HANDLERS);
  // Two reads in parallel: the weekly endurance block (off /stats) + the PRs.
  let stats = null, prs = null;
  try { [stats, prs] = await Promise.all([api("/stats"), api("/endurance-prs").catch(() => null)]); }
  catch { stats = null; }
  if (token !== pollToken || !view.querySelector("#endBody")) return;
  paintEnduranceBody(stats && stats.endurance ? stats.endurance : null, prs);
}

function paintEnduranceBody(end, prs) {
  const body = view.querySelector("#endBody");
  if (!body) return;
  const hasWeek = end && (end.week_km > 0 || end.week_moving_min > 0 || end.longest_km != null || end.longest_min != null);
  const hasPRs = prs && (prs.longest_km || prs.longest_min || (prs.best_pace || []).length);
  if (!hasWeek && !hasPRs) {
    body.innerHTML = progressHero("Endurance", []) +
      emptyStateHtml(art("activity", "run"),
        "No runs or rides logged yet — log one on Today (a phrase like “ran 8 km easy” is plenty) and your mileage, zones, and pace will read here.");
    return;
  }

  // Hero: this week's mileage + moving time + longest effort.
  const heroStats = [];
  if (end) {
    heroStats.push(["km · this week", end.week_km || 0]);
    if (end.week_moving_min != null) heroStats.push(["moving min · wk", Math.round(end.week_moving_min)]);
    if (end.longest_km != null) heroStats.push(["longest · km", end.longest_km, { text: true }]);
    else if (end.longest_min != null) heroStats.push(["longest · min", Math.round(end.longest_min), { text: true }]);
  }
  let html = progressHero("Endurance", heroStats);

  // Longest effort line (when we have one and it didn't already lead the hero).
  if (end && (end.longest_km != null || end.longest_min != null)) {
    const lbits = [];
    if (end.longest_km != null) lbits.push(`${fmtKm(end.longest_km)} km`);
    if (end.longest_min != null) lbits.push(`${Math.round(end.longest_min)} min`);
    const tlabel = end.longest_type ? `${escHtml(end.longest_type)} · ` : "";
    html += `<div class="end-line reveal" style="${stagger(1)}"><span class="lbl">Longest this week</span><span class="end-line-v">${tlabel}${lbits.join(" · ")}</span></div>`;
  }

  // Pace trend, in plain words (never a grade).
  const word = paceTrendWord(end && end.pace_trend);
  if (word) {
    html += `<div class="end-pace reveal" style="${stagger(2)}">
        <span class="lbl">Pace</span>
        <span class="end-pace-read">${escHtml(word.charAt(0).toUpperCase() + word.slice(1))}.</span>
        ${end.pace_trend.this_min_per_km != null ? `<span class="end-pace-num numeral">${fmtPaceKm(end.pace_trend.this_min_per_km)}<span class="end-pace-unit">/km</span></span>` : ""}
      </div>`;
  }

  // Time-in-zone bar.
  html += zoneBarHtml(end && end.time_in_zone);

  // Endurance PRs — the endurance analogue of the est-1RM view. Longest distance +
  // best pace at each standard distance, each a plain number with its date.
  if (hasPRs) {
    const prRows = [];
    if (prs.longest_km) prRows.push({ label: "Longest distance", val: `${fmtKm(prs.longest_km.value)} km`, date: prs.longest_km.date, type: prs.longest_km.type });
    if (prs.longest_min) prRows.push({ label: "Longest duration", val: `${Math.round(prs.longest_min.value)} min`, date: prs.longest_min.date, type: prs.longest_min.type });
    for (const bp of (prs.best_pace || [])) {
      prRows.push({ label: `Best ${prDistLabel(bp.distance_km)} pace`, val: `${fmtPaceKm(bp.min_per_km)}/km`, date: bp.date, type: bp.type });
    }
    const rows = prRows.map((r, i) => `
      <div class="end-pr reveal" style="${stagger(i + 4)}">
        <div class="end-pr-id">
          <span class="end-pr-label">${escHtml(r.label)}</span>
          ${r.date ? `<span class="end-pr-when lbl" title="${escAttr(absDate(r.date))}">${escHtml(relAge(r.date))}${r.type ? ` · ${escHtml(r.type)}` : ""}</span>` : ""}
        </div>
        <span class="end-pr-val numeral">${escHtml(r.val)}</span>
      </div>`).join("");
    html += `<div class="end-prs">
        <div class="lbl end-prs-head reveal" style="${stagger(3)}">Personal bests</div>
        <div class="end-pr-card">${rows}</div>
      </div>`;
  }

  body.innerHTML = html;
  runCountUps(body);
}

// ---------- Progress: training calendar (refined month grids) ----------
function calMonthHtml(ym, byDate, todayIso, idx) {
  const [y, m] = ym.split("-").map(Number);
  const firstDow = new Date(y, m - 1, 1).getDay();
  const daysIn = new Date(y, m, 0).getDate();
  const monthName = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const dows = ["S", "M", "T", "W", "T", "F", "S"];
  let cellsHtml = "";
  for (let i = 0; i < firstDow; i++) cellsHtml += `<span class="cal-day cal-pad"></span>`;
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${ym}-${String(d).padStart(2, "0")}`;
    const c = byDate.get(iso);
    const future = iso > todayIso;
    const lvl = !future && c ? (c.level || 0) : null; // null = outside the window / future
    const hasData = !future && c && (c.sets || c.activity);
    const isToday = iso === todayIso;
    const title = c && !future
      ? `${iso} · ${c.sets || 0} sets · ${(c.tonnage || 0).toLocaleString()} lb${c.activity ? " · activity" : ""}`
      : iso;
    cellsHtml += `<span class="cal-day${lvl != null ? ` cl${lvl}` : " cal-out"}${isToday ? " cal-today" : ""}${hasData ? " cal-has" : ""}"${hasData ? ` data-goto="${iso}"` : ""} title="${escAttr(title)}">${d}</span>`;
  }
  return `<div class="cal-month reveal" style="${stagger(idx)}">
      <div class="cal-name">${escHtml(monthName)}</div>
      <div class="cal-dows">${dows.map((l) => `<span class="lbl">${l}</span>`).join("")}</div>
      <div class="cal-grid">${cellsHtml}</div>
    </div>`;
}

// SWR over /calendar?days=84 (key progress:calendar): the Calendar seg paints its
// month grids instantly on a warm re-entry, then revalidates.
async function renderCalendar() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "calendar";
  const token = ++pollToken;
  const peek = peekCached("progress:calendar");
  if (!peek) view.innerHTML = segSkeleton("calendar", PROGRESS_SEG, 2); // cold: skeleton-first
  return paintSWR({
    key: "progress:calendar",
    path: "/calendar?days=84",
    peek,
    token,
    tab: "progress",
    render: (data) => paintCalendarBody(data || {}),
  });
}

function paintCalendarBody(data) {
  const cells = data.cells || [];
  const head = segBar("calendar", PROGRESS_SEG);
  if (!cells.length) {
    view.innerHTML = head + progressHero("Calendar", []) +
      emptyStateHtml(art("activity", "run"), "No activity logged yet.");
    wireSeg(PROGRESS_HANDLERS);
    return;
  }
  const todayIso = localISO();
  const byDate = new Map(cells.map((c) => [c.date, c]));
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
  const months = [...new Set(cells.map((c) => (c.date || "").slice(0, 7)))].filter(Boolean).reverse();
  const grids = months.map((mo, i) => calMonthHtml(mo, byDate, todayIso, i + 1)).join("");
  const legend = `<div class="cal-legend"><span>Less</span><i class="cl0"></i><i class="cl1"></i><i class="cl2"></i><i class="cl3"></i><i class="cl4"></i><span>More</span></div>`;
  view.innerHTML = head + hero + grids + legend;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
  // tap a day with data → open it on Today
  view.querySelectorAll(".cal-day[data-goto]").forEach((el) =>
    el.addEventListener("click", () => {
      state.logDate = el.dataset.goto;
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
const kcalFmt = (n) => Math.round(Number(n) || 0).toLocaleString();

function energyRead(exp) {
  // Plain-language synthesis. Never a number-first framing.
  if (!exp || exp.tdee == null || exp.confidence === "none") {
    return {
      lead: "Not enough logged yet to estimate.",
      body: "Keep logging meals and the odd weigh-in when you can — once there's a few weeks of data, I'll read your real energy balance here.",
      tone: "quiet",
    };
  }
  const trend = exp.trend_lb_wk;
  const dir = trend == null ? null : (trend < -0.05 ? "down" : trend > 0.05 ? "up" : "flat");
  const rate = trend == null ? "" : `about ${Math.abs(Math.round(trend * 10) / 10)} lb/week`;
  const intake = exp.intake_avg_kcal != null ? `eating ~${kcalFmt(exp.intake_avg_kcal)} kcal/day` : "";
  let movement = "";
  if (dir === "down") movement = `trending down ${rate}`;
  else if (dir === "up") movement = `trending up ${rate}`;
  else if (dir === "flat") movement = "holding steady";
  const lead = [intake, movement].filter(Boolean).join(", ") || "Reading your energy balance.";
  return { lead: lead.charAt(0).toUpperCase() + lead.slice(1) + ".", body: "", tone: "read", dir };
}

const CONF_WORD = { high: "well-established", medium: "settling in", low: "still early" };

// SWR over /nutrition/expenditure?window=21 (key progress:energy): the Energy
// Balance seg paints its derived read instantly on a warm re-entry, then
// revalidates. The shell (#checkinResult) is preserved across re-fills so an
// in-flight nutrition check-in card is never clobbered by a background refresh.
async function renderEnergy() {
  headerTitle.textContent = "Progress";
  const token = ++pollToken;
  const head = segBar("energy", PROGRESS_SEG);
  const peek = peekCached("progress:energy");
  // Always paint the shell; only the #energyCard slot shows a loading state on cold.
  view.innerHTML = head + `<div id="energyHero"></div>
    <div id="energyCard">${peek ? "" : loadingState("Reading your trend…")}</div>
    <div id="checkinResult" class="checkin-result"></div>`;
  wireSeg(PROGRESS_HANDLERS);

  const paint = (exp) => {
    if (token !== pollToken || !view.querySelector("#energyCard")) return;
    paintEnergyBody(exp);
  };
  if (peek) { paint(peek.data); if (!peek.fresh) markRefreshing(true); }
  cachedApi("/nutrition/expenditure?window=21", {
    key: "progress:energy",
    onUpgrade: (exp, { changed }) => { if (peek && !peek.fresh) markRefreshing(false); if (changed || !peek) paint(exp); },
  }).catch(() => { if (peek && !peek.fresh) markRefreshing(false); });
}

// Fill the Energy Balance hero + card from a derived-expenditure payload. Leaves
// #checkinResult untouched (the check-in renders there independently). Idempotent.
function paintEnergyBody(exp) {
  const read = energyRead(exp);
  const usable = exp && exp.tdee != null && exp.confidence !== "none";

  const heroWrap = view.querySelector("#energyHero");
  if (heroWrap) {
    heroWrap.innerHTML = usable
      ? progressHero("Energy Balance", [
          ["est. expenditure · kcal", exp.tdee],
          exp.intake_avg_kcal != null ? ["avg intake · kcal", exp.intake_avg_kcal] : null,
          exp.trend_lb_wk != null ? ["trend · lb/wk", `${exp.trend_lb_wk > 0 ? "+" : ""}${Math.round(exp.trend_lb_wk * 10) / 10}`, { text: true }] : null,
        ])
      : progressHero("Energy Balance", []);
    runCountUps(heroWrap);
  }

  const card = view.querySelector("#energyCard");
  if (!card) return;
  const ctx = usable
    ? `<div class="eb-ctx lbl">${escHtml(CONF_WORD[exp.confidence] || "")} · ${exp.points} day${exp.points === 1 ? "" : "s"} of data · ${exp.window_days}-day window</div>`
    : "";
  card.innerHTML = `<section class="eb-card reveal" style="--i:1">
      <div class="eb-kicker lbl"><span class="eb-glyph" aria-hidden="true">◇</span> ${usable ? "How you're tracking" : "Not enough data yet"}</div>
      <p class="eb-lead">${escHtml(read.lead)}</p>
      ${read.body ? `<p class="eb-body">${escHtml(read.body)}</p>` : ""}
      ${ctx}
      <div class="eb-foot">
        <button class="ghostbtn eb-checkin" id="runCheckin" type="button">Run a check-in</button>
        <span class="eb-note lbl">a reviewed read — costs an agent call</span>
      </div>
    </section>`;

  const btn = view.querySelector("#runCheckin");
  if (btn) btn.addEventListener("click", () => runNutritionCheckin(btn));
}

// Nutrition check-in: a REVIEWED recommendation, never auto-applied. The common
// case is "no change needed". When the trend has genuinely moved, the agent
// drafts a target the user can take into their meal plan — advisory, dismissible.
// Run the nutrition check-in as a durable background job (POST /nutrition/checkin),
// so a long agentic read survives a tab switch / reload mid-run and streams its
// evolving caption into #checkinResult. runOp renders the inline result at once
// when background ops are off. The render mirrors the old await path exactly:
// no-change card on r.change===false, the advisory proposal otherwise; ok:false
// (or unreachable) is the gentle failure line.
function runNutritionCheckin(btn) {
  const out = view.querySelector("#checkinResult");
  if (!out) return;
  const restore = btnBusy(btn, "Checking…");
  // A .job-cap carries the evolving thinkingCaption while the agent reads.
  out.innerHTML = `<div class="eb-checking lbl"><span class="aspin aspin-xs"></span> <span class="job-cap">reading your trend…</span></div>`;
  runOp("nutrition_checkin", { window: 21 }, nutritionCheckinOpOpts(restore));
}

// Shared runOp options for the nutrition check-in — used by the live trigger and
// the reload reconnector, so the render/fail behavior is identical either way.
function nutritionCheckinOpOpts(restore) {
  const done = () => { try { restore && restore(); } catch {} };
  return {
    path: "/nutrition/checkin",
    anchor: "#checkinResult",
    caption: "nutrition_checkin",
    guard: () => { const gone = !view.querySelector("#checkinResult")?.isConnected; if (gone) done(); return gone; },
    isFail: (r) => !r || r.ok === false || !!r.error,
    render: (r) => {
      done();
      const out = view.querySelector("#checkinResult");
      if (!out) return;
      if (!r.change) {
        const summary = r.summary && String(r.summary).trim();
        out.innerHTML = `<div class="eb-checkin-ok settle-in">
            <span class="eb-ok-mark" aria-hidden="true">✓</span>
            <div><div class="eb-ok-lead">No change needed — you're tracking well.</div>
            ${summary ? `<p class="eb-ok-body">${escHtml(summary)}</p>` : ""}</div>
          </div>`;
        return;
      }
      renderCheckinProposal(out, r);
    },
    onFail: () => {
      done();
      const out = view.querySelector("#checkinResult");
      if (out) out.innerHTML = `<div class="eb-checkin-quiet">Couldn't run a check-in right now — no worries, your read above still stands. Try again in a bit.</div>`;
    },
  };
}

// Reconnector: after a reload mid-check-in, rebuild the loading line in
// #checkinResult and return the handlers runOp would have used.
function reconnectNutritionCheckin() {
  const out = view.querySelector("#checkinResult");
  if (!out) return null; // not on Energy — a later renderEnergy() retries reconnect
  out.innerHTML = `<div class="eb-checking lbl"><span class="aspin aspin-xs"></span> <span class="job-cap">reading your trend…</span></div>`;
  const o = nutritionCheckinOpOpts(null);
  let stop = () => {};
  const capEl = out.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  return {
    guard: o.guard,
    onDone: (result) => { stop(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { stop(); o.onFail(null); },
    onCanceled: () => { stop(); o.onFail(null); },
  };
}

// A calm, reviewable advisory card. NOT applied — there's no apply endpoint for
// this; calories live in the meal plan's daily_kcal. The user takes the read
// into a meal-plan regenerate, or just acknowledges it.
function renderCheckinProposal(out, r) {
  const pj = (r.proposal && (r.proposal.parsed || r.proposal.parsed_json)) || r.proposal || {};
  let parsed = pj;
  if (typeof pj === "string") { try { parsed = JSON.parse(pj); } catch { parsed = {}; } }
  const n = parsed.nutrition || {};
  const target = Number(n.target_kcal);
  const prev = n.prev_target_kcal != null ? Number(n.prev_target_kcal) : null;
  const delta = prev != null && Number.isFinite(target) ? target - prev : null;
  const macroBits = [];
  if (n.protein_g != null) macroBits.push(`${Math.round(Number(n.protein_g))}g protein`);
  if (n.carbs_g != null) macroBits.push(`${Math.round(Number(n.carbs_g))}g carbs`);
  if (n.fat_g != null) macroBits.push(`${Math.round(Number(n.fat_g))}g fat`);
  const reason = n.reason || parsed.summary || "";
  const notes = parsed.notes && String(parsed.notes).trim();
  out.innerHTML = `<section class="eb-proposal settle-in">
      <div class="eb-kicker lbl"><span class="eb-glyph" aria-hidden="true">◇</span> A target worth considering</div>
      <div class="eb-target">
        <span class="numeral numeral-lg"${Number.isFinite(target) ? ` data-cu="${Math.round(target)}"` : ""}>${Number.isFinite(target) ? "0" : "—"}</span>
        <span class="eb-target-unit lbl">kcal / day${delta != null ? ` · ${delta > 0 ? "+" : ""}${kcalFmt(delta)} vs now` : ""}</span>
      </div>
      ${macroBits.length ? `<div class="eb-macros lbl">${escHtml(macroBits.join(" · "))}</div>` : ""}
      ${reason ? `<p class="eb-why">${escHtml(String(reason))}</p>` : ""}
      ${notes ? `<p class="eb-body">${escHtml(notes)}</p>` : ""}
      <div class="eb-foot">
        <button class="draftbtn" id="ckGoMeals" type="button">Regenerate meal plan around this</button>
        <button class="ghostbtn" id="ckDismiss" type="button">Got it</button>
      </div>
      <div class="eb-advisory lbl">advisory — nothing changes until you act on it</div>
    </section>`;
  runCountUps(out);
  const go = out.querySelector("#ckGoMeals");
  if (go) go.addEventListener("click", () => {
    state.planJump = "meals";
    activateTab("plan");
  });
  const dismiss = out.querySelector("#ckDismiss");
  if (dismiss) dismiss.addEventListener("click", () => {
    const card = out.querySelector(".eb-proposal");
    if (card) collapseEl(card, () => { out.innerHTML = ""; });
    else out.innerHTML = "";
  });
}


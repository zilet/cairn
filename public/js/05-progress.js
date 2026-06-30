// ==== 05-progress.js ====
// Shared premium line chart: monotone-cubic curve, soft gradient area fill, light
// gridlines with y labels, first/last date x labels, emphasized final point with
// an ink value badge, optional sage dashed goal line and \u25b2 at the all-time peak.
// Interactive: hover (mouse) or drag (touch) scrubs across the points \u2014 a dashed
// guide + highlighted dot + a "value \u00b7 date" badge follow the nearest reading, so
// every past value is legible, not just the final one. `paint(null)` is the calm
// default (final point emphasized); a point index shows that reading.
function drawLineChart(canvas, pts, opts = {}) {
  if (!canvas) return;
  const C = chartColors();
  const n = pts.length;
  if (!n) return;
  const vals = pts.map((p) => p.v);
  const allV = opts.goal != null ? [...vals, opts.goal] : vals;
  let min = Math.min(...allV), max = Math.max(...allV);
  if (max === min) { max += 1; min -= 1; }
  const spread = max - min;
  min -= spread * 0.14; max += spread * 0.2;
  const padL = 36, padR = 16, padT = 30, padB = 28;
  const fmtVal = opts.fmt || ((v) => String(Math.round(v)));

  // Size + DPR transform are set once per draw (handles a resize/re-render), then
  // the geometry is computed once and reused by every animation frame \u2014 the canvas
  // box is layout-stable across a scrub, so x()/y() never need recomputing mid-loop.
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const c = canvas.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = (i) => n === 1 ? (padL + W - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => H - padB - ((v - min) / (max - min)) * (H - padT - padB);
  const xs = vals.map((_, i) => x(i)), ys = vals.map((v) => y(v));
  canvas._chartXs = xs; // hit-test target for the pointer handlers (CSS px)

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

  // The static layer: gridlines, goal line, area fill, curve, quiet dots, peak \u25b2,
  // and the first/last date axis labels. Re-rendered each frame under the highlight.
  const drawBase = () => {
    c.clearRect(0, 0, W, H);
    c.font = "10px system-ui, sans-serif";
    for (let g = 0; g <= 3; g++) {
      const v = min + ((max - min) * g) / 3, yy = y(v);
      c.strokeStyle = withAlpha(C.line2, 0.55); c.lineWidth = 1;
      c.beginPath(); c.moveTo(padL, yy); c.lineTo(W - padR, yy); c.stroke();
      c.fillStyle = C.label; c.textAlign = "right";
      c.fillText(String(Math.round(v)), padL - 7, yy + 3);
    }
    c.textAlign = "left";
    if (opts.goal != null) {
      const gy = y(opts.goal);
      c.save(); c.strokeStyle = C.sage; c.setLineDash([5, 5]); c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(padL, gy); c.lineTo(W - padR, gy); c.stroke(); c.restore();
      c.fillStyle = C.sage; c.font = "600 9px system-ui, sans-serif";
      c.fillText(`GOAL ${opts.goal}`, padL + 3, gy - 5);
    }
    const tracePath = () => {
      c.beginPath(); c.moveTo(xs[0], ys[0]);
      for (let i = 0; i < n - 1; i++) {
        const dx = (xs[i + 1] - xs[i]) / 3;
        c.bezierCurveTo(xs[i] + dx, ys[i] + ms[i] * dx, xs[i + 1] - dx, ys[i + 1] - ms[i + 1] * dx, xs[i + 1], ys[i + 1]);
      }
    };
    if (n > 1) {
      tracePath();
      c.lineTo(xs[n - 1], H - padB); c.lineTo(xs[0], H - padB); c.closePath();
      const grad = c.createLinearGradient(0, padT, 0, H - padB);
      grad.addColorStop(0, withAlpha(C.accent, 0.16)); grad.addColorStop(1, withAlpha(C.accent, 0));
      c.fillStyle = grad; c.fill();
      tracePath();
      c.strokeStyle = C.accent; c.lineWidth = 2.25; c.lineJoin = "round"; c.lineCap = "round"; c.stroke();
      c.fillStyle = C.accent;
      for (let i = 0; i < n - 1; i++) { c.beginPath(); c.arc(xs[i], ys[i], 2, 0, 7); c.fill(); }
    }
    if (opts.peak && n > 1) {
      let pi = 0; vals.forEach((v, i) => { if (v > vals[pi]) pi = i; });
      if (pi !== n - 1) {
        c.fillStyle = C.gold; c.font = "10px system-ui, sans-serif"; c.textAlign = "center";
        c.fillText("\u25b2", xs[pi], ys[pi] - 9); c.textAlign = "left";
      }
    }
    c.fillStyle = C.label; c.font = "10px system-ui, sans-serif";
    c.textAlign = "left"; c.fillText(fmtShortDate(pts[0].date), padL, H - 8);
    if (n > 1) { c.textAlign = "right"; c.fillText(fmtShortDate(pts[n - 1].date), W - padR, H - 8); }
    c.textAlign = "left";
  };

  // The highlight overlay at an animated (hx,hy): `idx` selects the real value/date
  // (never interpolated \u2014 we don't invent readings), `pop` (0\u21921, decaying) springs
  // the dot's radius as it lands, `withDate` adds the date + guide while scrubbing.
  const drawHighlight = (hx, hy, idx, pop, withDate) => {
    if (withDate && n > 1) {
      c.save(); c.strokeStyle = withAlpha(C.ink, 0.22); c.lineWidth = 1; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(hx, padT - 6); c.lineTo(hx, H - padB); c.stroke(); c.restore();
    }
    const r = 4.5 + 2.2 * pop;
    c.beginPath(); c.arc(hx, hy, r + 3.5, 0, 7); c.fillStyle = withAlpha(C.accent, 0.16); c.fill();
    c.beginPath(); c.arc(hx, hy, r, 0, 7); c.fillStyle = C.accent; c.fill();
    c.beginPath(); c.arc(hx, hy, r, 0, 7); c.strokeStyle = C.card; c.lineWidth = 1.6; c.stroke();
    const badgeTxt = withDate ? `${fmtVal(vals[idx])} \u00b7 ${fmtShortDate(pts[idx].date)}` : fmtVal(vals[idx]);
    c.font = "600 11px system-ui, sans-serif";
    const tw = c.measureText(badgeTxt).width;
    const bx = Math.min(Math.max(hx - tw / 2 - 8, padL), W - padR - tw - 16);
    let by = hy - 32; if (by < 4) by = hy + 14;
    c.fillStyle = C.ink;
    if (c.roundRect) { c.beginPath(); c.roundRect(bx, by, tw + 16, 20, 10); c.fill(); }
    else c.fillRect(bx, by, tw + 16, 20);
    c.fillStyle = C.paper; c.fillText(badgeTxt, bx + 8, by + 14);
  };

  // Animation state lives on the element so a re-render cleanly cancels the prior
  // loop and re-homes the highlight to the final point (data may have changed).
  if (canvas._raf) { cancelAnimationFrame(canvas._raf); canvas._raf = null; }
  const finalIdx = n - 1;
  const hl = { x: xs[finalIdx], y: ys[finalIdx], pop: 0 };
  const target = { x: xs[finalIdx], y: ys[finalIdx], idx: finalIdx, scrubbing: false };
  canvas._hl = hl;
  const render = () => { drawBase(); drawHighlight(hl.x, hl.y, target.idx, hl.pop, target.scrubbing); };
  const tick = () => {
    hl.x += (target.x - hl.x) * 0.32;
    hl.y += (target.y - hl.y) * 0.32;
    hl.pop *= 0.8;
    const settled = Math.abs(hl.x - target.x) < 0.4 && Math.abs(hl.y - target.y) < 0.4 && hl.pop < 0.02;
    if (settled) { hl.x = target.x; hl.y = target.y; hl.pop = 0; }
    render();
    canvas._raf = settled ? null : requestAnimationFrame(tick);
  };
  // Move the highlight (eased) to point `idx`; null rests it at the final point.
  // The dot only "pops" when it lands on a genuinely different reading.
  canvas._setTarget = (idx, scrubbing) => {
    const i = idx == null ? finalIdx : Math.max(0, Math.min(n - 1, idx));
    if (i !== target.idx) hl.pop = 1;
    target.x = xs[i]; target.y = ys[i]; target.idx = i; target.scrubbing = !!scrubbing;
    if (reducedMotion()) { hl.x = target.x; hl.y = target.y; hl.pop = 0; render(); return; }
    if (!canvas._raf) canvas._raf = requestAnimationFrame(tick);
  };

  // Pointer handlers wired ONCE per canvas (drawProgress re-draws the same element
  // on dropdown change; re-attaching would stack listeners). They read the latest
  // geometry + _setTarget, both refreshed above on every draw.
  if (!canvas._scrubWired) {
    canvas._scrubWired = true;
    let touchActive = false;
    const idxFromEvent = (e) => {
      const ax = canvas._chartXs; if (!ax || !ax.length) return null;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      let idx = 0, best = Infinity;
      for (let i = 0; i < ax.length; i++) { const dd = Math.abs(ax[i] - px); if (dd < best) { best = dd; idx = i; } }
      return idx;
    };
    const show = (e) => { const i = idxFromEvent(e); if (i != null) canvas._setTarget(i, true); };
    const rest = () => { if (canvas._setTarget) canvas._setTarget(null, false); };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") { touchActive = true; try { canvas.setPointerCapture(e.pointerId); } catch {} }
      show(e);
    });
    canvas.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || touchActive) show(e); });
    canvas.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") { touchActive = false; rest(); } });
    canvas.addEventListener("pointercancel", () => { touchActive = false; rest(); });
    canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") rest(); });
  }

  render();
}

// ---------- Progress: History ----------
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
      <h2 class="detail-title">${escHtml(sess.title || sess.day_name || "Session")}</h2>
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
    `<div id="volBalanceSlot" class="vol-balance-slot reveal" style="${stagger(1)}"></div>` +
    `<div class="vol-kicker lbl reveal" style="${stagger(2)}">Last ${data.days || 30} days · ranked by sets</div>` + rows;
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
// The endurance analogue to the 1RM view: this week's mileage + moving time, the
// longest single effort, a calm time-in-HR-zone bar, the pace trend in plain words
// (never a grade), and endurance PRs (longest distance + best pace by distance).
// Fed by /api/stats `.endurance` + /api/endurance-prs. No 0–100 scores anywhere.
async function renderEndurance() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "endurance";
  const token = ++pollToken;
  view.innerHTML = segBar("endurance", PROGRESS_SEG) + `<div id="endBody">${loadingState("Reading your week…")}</div>`;
  wireSeg(PROGRESS_HANDLERS);
  // Reads in parallel: the weekly endurance block (off /stats), the PRs, the endurance
  // goal (race countdown / standing target), the run compliance ("32 of 40 km this
  // week"), and /settings for Garmin sync freshness.
  let stats = null, prs = null, goal = null, compliance = null, settings = null, runPlan = null;
  try {
    [stats, prs, goal, compliance, settings, runPlan] = await Promise.all([
      api("/stats"),
      api("/endurance-prs").catch(() => null),
      api("/endurance-goal").catch(() => null),
      api("/run-compliance").catch(() => null),
      api("/settings").then((r) => (r && r.settings) || null).catch(() => null),
      api("/run-plan").catch(() => null),
    ]);
  } catch { stats = null; }
  if (token !== pollToken || !view.querySelector("#endBody")) return;
  paintEnduranceBody(stats && stats.endurance ? stats.endurance : null, prs, goal, compliance, settings, runPlan);
}

function paintEnduranceBody(end, prs, goal, compliance, settings, runPlan) {
  const body = view.querySelector("#endBody");
  if (!body) return;
  const goalHtml = enduranceGoalCard(goal);
  const complianceHtml = runComplianceLine(compliance);
  const runPlanHtml = weeklyRunPlanCard(runPlan);
  // Sync trust: a quiet "synced 2h ago · Sync now" line, only when Garmin is
  // configured (cardioSyncLine returns "" otherwise). Shared with Today's run card.
  const syncHtml = (typeof cardioSyncLine === "function") ? cardioSyncLine(settings, {}) : "";
  const hasWeek = end && (end.week_km > 0 || end.week_moving_min > 0 || end.longest_km != null || end.longest_min != null);
  const hasPRs = prs && ((prs.sports || []).length || prs.longest_km || prs.longest_min || (prs.best_pace || []).length);
  if (!hasWeek && !hasPRs) {
    body.innerHTML = progressHero("Endurance", []) + goalHtml + complianceHtml + runPlanHtml + syncHtml +
      emptyStateHtml(art("activity", "run"),
        goalHtml
          ? "No runs logged yet — log one on Today (a phrase like “ran 8 km easy” is plenty) and your weekly runs build toward this."
          : "No runs or rides logged yet — log one on Today (a phrase like “ran 8 km easy” is plenty) and your mileage, zones, and pace will read here.");
    if (syncHtml && typeof wireCardioSync === "function") wireCardioSync(body, () => renderEndurance());
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

  // Lead: hero + the coach's one line + the persistent goal/compliance anchors + the
  // week's run plan (Endurance is its home). The deep stats collapse below.
  const coachLineHtml = enduranceCoachLine(runPlan);
  const leadHtml = progressHero("Endurance", heroStats) + coachLineHtml + goalHtml + complianceHtml + runPlanHtml;
  const hasLead = !!(runPlanHtml || goalHtml || coachLineHtml);

  // Deep read — longest effort, pace trend, time-in-zone, personal bests, and the
  // Garmin sync line. Collapses behind one "The full read" disclosure when there's a
  // lead; otherwise stacks beneath the hero (graceful degradation).
  let deep = "";

  if (end && (end.longest_km != null || end.longest_min != null)) {
    const lbits = [];
    if (end.longest_km != null) lbits.push(`${fmtKm(end.longest_km)} km`);
    if (end.longest_min != null) lbits.push(`${Math.round(end.longest_min)} min`);
    const tlabel = end.longest_type ? `${escHtml(end.longest_type)} · ` : "";
    deep += `<div class="end-line reveal" style="${stagger(1)}"><span class="lbl">Longest this week</span><span class="end-line-v">${tlabel}${lbits.join(" · ")}</span></div>`;
  }

  // Pace trend, in plain words (never a grade).
  const word = paceTrendWord(end && end.pace_trend);
  if (word) {
    deep += `<div class="end-pace reveal" style="${stagger(2)}">
        <span class="lbl">Pace</span>
        <span class="end-pace-read">${escHtml(word.charAt(0).toUpperCase() + word.slice(1))}.</span>
        ${end.pace_trend.this_min_per_km != null ? `<span class="end-pace-num numeral">${fmtPaceKm(end.pace_trend.this_min_per_km)}<span class="end-pace-unit">/km</span></span>` : ""}
      </div>`;
  }

  // Time-in-zone bar.
  deep += zoneBarHtml(end && end.time_in_zone);

  // Endurance PRs — the endurance analogue of the est-1RM view, GROUPED BY SPORT so
  // a best is read in its own modality: running pace leads (the athlete's sport),
  // cross-training (cycling/MTB/swim) sits in a quiet disclosure with distance /
  // duration / speed — never a min/km "pace", which only makes sense on foot.
  if (hasPRs) {
    // Prefer the server's per-sport grouping; fall back to a single synthesized group
    // from the flat fields for an older API response.
    let groups = (prs.sports || []).map((g) => ({ ...g })).filter((g) => enduranceBestRows(g).length);
    if (!groups.length) {
      groups = [{
        sport: prs.primary_sport || "run", label: "", paced: true,
        longest_km: prs.longest_km, longest_min: prs.longest_min, best_pace: prs.best_pace || [], best_speed_kmh: null,
      }].filter((g) => enduranceBestRows(g).length);
    }
    if (groups.length) {
      // With a single sport, the bests are unambiguous — drop the redundant label.
      if (groups.length === 1) groups[0] = { ...groups[0], label: "" };
      const lead = groups[0];
      const others = groups.slice(1);
      const otherHtml = others.length
        ? `<details class="end-pr-more">
            <summary>Cross-training bests</summary>
            <div class="end-pr-more-body">${others.map((g, gi) => enduranceSportCardHtml(g, 5 + gi)).join("")}</div>
          </details>`
        : "";
      deep += `<div class="end-prs">
          <div class="lbl end-prs-head reveal" style="${stagger(3)}">Personal bests</div>
          ${enduranceSportCardHtml(lead, 4)}
          ${otherHtml}
        </div>`;
    }
  }

  // The Garmin sync-trust line lives at the foot of the deep read.
  deep += syncHtml;

  let html;
  if (hasLead && deep.trim()) {
    html = leadHtml +
      `<details class="full-read reveal" style="${stagger(3)}">
        <summary>The full read</summary>
        <div class="full-read-body">${deep}</div>
      </details>`;
  } else {
    // No lead (non-runner, no plan/goal) — keep the stats stacked beneath the hero.
    html = leadHtml + deep;
  }

  body.innerHTML = html;
  runCountUps(body);
  // "Sync now" on the freshness line → pull, then re-read the endurance view in place.
  if (syncHtml && typeof wireCardioSync === "function") wireCardioSync(body, () => renderEndurance());
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
  out.innerHTML = `<div class="eb-checking lbl"><span class="aspin aspin-xs"></span> ${CairnUi.jobCaptionHtml({ text: "reading your trend…" })}</div>`;
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
  out.innerHTML = `<div class="eb-checking lbl"><span class="aspin aspin-xs"></span> ${CairnUi.jobCaptionHtml({ text: "reading your trend…" })}</div>`;
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

// ---------- Progress: Program (adaptive program intelligence) ----------
// Renders GET /api/program-state as a calm editorial read of how the athlete's
// program is evolving. No 0–100 scores. Constitution: calm, suggestion-not-a-gate,
// pull-never-push. Skeleton-first paint; empty state when lifts is empty.

// "Evolve my plan" button — POSTs to /api/program/evolve. Degrades gracefully
// if the endpoint 404s (not yet wired). ok:false at 200 = designed failure signal.
// Evolve the plan — a durable background job (streams an evolving caption, survives
// a reload), exactly like session-suggest. runOp transparently handles the stream
// (bg on) or the inline result (bg off). The draft lands in the Plan proposals for
// review — nothing auto-applies.
async function triggerProgramEvolve(btn) {
  const foot = btn.closest(".prog-evolve-foot") || btn.parentElement;
  const restore = btnBusy(btn, "Drafting your plan…");
  // A caption line runOp animates while the coach thinks.
  let cap = foot && foot.querySelector(".prog-evolve-cap");
  if (foot && !cap) {
    cap = document.createElement("div");
    cap.className = "prog-evolve-cap job-cap lbl";
    foot.appendChild(cap);
  }
  const cleanup = () => { restore(); cap?.remove(); };
  await runOp("evolve_program", {}, {
    path: "/program/evolve",
    anchor: ".prog-evolve-foot",
    caption: [
      "reading how your lifts are trending",
      "spotting what's stalled",
      "drafting how your plan should evolve",
      "checking it against your constraints",
    ],
    guard: () => !document.querySelector(".prog-evolve-foot")?.isConnected,
    render: () => {
      cleanup();
      toast("Drafted — review it in your Plan");
      swrInvalidate("progress:program");
      swrInvalidate("plan:coach");
      swrInvalidate("plan:proposals");
      if (state.tab === "progress") renderProgram();
    },
    onFail: () => { cleanup(); toast("Couldn't draft right now — try again in a bit."); },
  });
}

// SWR over /program-state (key progress:program). Skeleton-first on cold;
// paints the full program read instantly on warm re-entry, then revalidates.
// The conductor lead for Progress→Program — the cross-domain "one block focus" card
// (GET /api/coaching-focus → coachingFocusCardHtml). Cached as a rendered HTML string
// ("" when unavailable) so paintProgramBody can branch its layout: present → lead with
// it and collapse the deep sections behind "The full read"; absent → the existing
// stacked sections, untouched (graceful degradation).
let _progFocusCard;

async function renderProgram() {
  headerTitle.textContent = "Progress";
  state.progressSeg = "program";
  const token = ++pollToken;
  const peek = peekCached("progress:program");
  if (!peek) view.innerHTML = segSkeleton("program", PROGRESS_SEG, 3);
  // Fetch the conductor in parallel (own try/catch → never throws). When it lands or
  // its presence changes, re-paint from the cached program-state so the layout can
  // collapse the pile. Never blocks the warm paint below.
  api("/coaching-focus").then((f) => {
    const card = (typeof coachingFocusCardHtml === "function") ? coachingFocusCardHtml(f) : "";
    const prev = _progFocusCard;
    _progFocusCard = card;
    if (card === prev) return;
    if (!card && (prev === undefined || prev === "")) return; // stayed flat — no re-paint
    if (token === pollToken && state.tab === "progress" && state.progressSeg === "program") {
      const cached = peekCached("progress:program");
      if (cached) paintProgramBody(cached.data || {});
    }
  }).catch(() => {});
  return paintSWR({
    key: "progress:program",
    path: "/program-state",
    peek,
    token,
    tab: "progress",
    render: (data) => paintProgramBody(data || {}),
  });
}

function paintProgramBody(data) {
  const head = segBar("program", PROGRESS_SEG);
  const lifts = data.lifts || [];
  const volume = data.volume || [];
  const meso = data.mesocycle || null;
  const endurance = data.endurance || null;
  const headline = data.headline || "";
  const adaptations = data.adaptations_due || [];

  if (!lifts.length && !volume.length && !meso && !endurance) {
    view.innerHTML = head + progressHero("Program", []) +
      emptyStateHtml(art("exercise", "barbell squat"),
        "Not enough data yet — log a few sessions and your program intelligence will read here.");
    wireSeg(PROGRESS_HANDLERS);
    return;
  }

  const sorted = sortLifts(lifts);

  // Count stalled/regressing for a quiet hero stat (no score — just a direction indicator).
  const nStalled = sorted.filter((l) => l.status === "plateaued" || l.status === "regressing").length;
  const nGood = sorted.filter((l) => l.status === "progressing").length;
  const heroStats = [];
  if (lifts.length) heroStats.push(["lifts tracked", lifts.length]);
  if (nGood) heroStats.push(["climbing", nGood]);
  if (nStalled) heroStats.push(["stalled", nStalled]);

  const conductor = (typeof _progFocusCard === "string") ? _progFocusCard : "";
  const hasConductor = !!conductor;

  // The deterministic headline — the single most important program sentence. When the
  // conductor leads it's redundant (the conductor states the through-line), so it tucks
  // into the disclosure with the rest of the deep read.
  const headlineHtml = headline ? `<div class="prog-headline reveal" style="${stagger(1)}">${escHtml(headline)}</div>` : "";

  // The async slots (loaded after paint): a "test week due" banner, the capacity
  // benchmark, the periodization block, the "what changed & why" digest, the muscle
  // advance/stall strip, and DEXA targeting. Each renders nothing until it has data.
  const testSlot = `<div id="progTestSlot" class="ptest-slot reveal" style="${stagger(1)}"></div>`;
  const perfSlot = `<div id="progPerfSlot" class="pperf-slot reveal" style="${stagger(2)}"></div>`;
  const blockSlot = `<div id="progBlockSlot" class="pblock-slot reveal" style="${stagger(2)}"></div>`;
  const adjustSlot = `<div id="progAdjustSlot" class="padj-slot reveal" style="${stagger(3)}"></div>`;
  const muscleSlot = `<div id="progMuscleSlot" class="pmus-slot reveal" style="${stagger(3)}"></div>`;
  const dexaSlot = `<div id="progDexaSlot" class="pdexa-slot reveal" style="${stagger(3)}"></div>`;
  const adaptHtml = adaptations.length ? adaptationsHtml(adaptations, 4) : "";

  // Lift rows — the per-lift trajectory, kept visible beneath the lead.
  let liftsHtml = "";
  if (sorted.length) {
    liftsHtml += `<div class="prow-section-head lbl reveal" style="${stagger(5)}">Lifts</div>`;
    liftsHtml += sorted.map((lift, i) => liftRowHtml(lift, 6 + i)).join("");
  }

  const volumeHtml = volume.length
    ? `<div class="pvol-head lbl reveal" style="${stagger(2)}">Weekly volume by muscle</div>` + volumeBlockHtml(volume, 3)
    : "";
  const mesoHtml = meso ? mesoBlockHtml(meso, 4) : "";
  const endHtml = endurance ? enduranceBlockHtml(endurance, 5) : "";

  const evolveFoot = `<div class="prog-evolve-foot reveal" style="${stagger(7)}">
    <button class="draftbtn prog-evolve-btn" id="progEvolveBtn" type="button">Evolve my plan</button>
    <span class="prog-evolve-note lbl">asks the coach to draft an updated plan — you review before anything changes</span>
    <button id="progTidyBtn" class="ghostbtn" style="width:100%;text-align:center;padding:9px;margin-top:11px" type="button">Tidy exercise names</button>
    <span class="prog-evolve-note lbl">Different logs name the same lift differently — Cairn merges duplicates so each one tracks as one line. Runs automatically as you log.</span>
  </div>`;

  let html;
  if (hasConductor) {
    // Conductor leads. Lift rows stay visible beneath it; the rest of the deep read —
    // the deterministic headline, capacity benchmark, DEXA targeting, muscle strip,
    // weekly volume, mesocycle, and the adaptations digest — collapses behind ONE "The
    // full read" disclosure. The lever is de-triplicated: the conductor is the one lever
    // now (performance's standalone .pperf-lever is suppressed in loadPerformance).
    html = head + progressHero("Program", heroStats) + conductor + liftsHtml +
      `<details class="full-read reveal" style="${stagger(6)}">
        <summary>The full read</summary>
        <div class="full-read-body">${
          headlineHtml + testSlot + perfSlot + blockSlot + adjustSlot + muscleSlot + dexaSlot +
          adaptHtml + volumeHtml + mesoHtml + endHtml
        }</div>
      </details>` + evolveFoot;
  } else {
    // No conductor — the existing stacked layout, untouched (graceful degradation).
    html = head + progressHero("Program", heroStats) +
      headlineHtml + testSlot + perfSlot + blockSlot + adjustSlot + muscleSlot + dexaSlot +
      adaptHtml + liftsHtml + volumeHtml + mesoHtml + endHtml + evolveFoot;
  }

  view.innerHTML = html;
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);

  const btn = view.querySelector("#progEvolveBtn");
  if (btn) btn.addEventListener("click", () => triggerProgramEvolve(btn));

  const tidyBtn = view.querySelector("#progTidyBtn");
  if (tidyBtn) tidyBtn.addEventListener("click", () => tidyExerciseNames(tidyBtn));

  loadPerformance(); // the "where you stand" capacity benchmark hero
  loadProgramBlock(); // periodization block card (active) or a "start a block" affordance
  loadProgramAdjustments(); // the "what changed & why" digest
  loadTestWeek(); // the "a test week is about due" banner
  loadMuscleTrajectory(); // per-muscle-group advancing/stalling strip
  loadDexaTargeting("progDexaSlot"); // "from your DEXA, what to focus on next"
}

// "Tidy exercise names" — the exercise-canon analogue to Health's "Align lab names".
// Merges duplicate movements (e.g. "Dead hang" / "Dead hang timed") so each lift
// tracks as one line. Calm, low-friction; degrades calmly on failure. Refreshes the
// program read on success so the merged history shows immediately.
async function tidyExerciseNames(btn) {
  const restore = btnBusy(btn, "tidying…");
  let r = null;
  try { r = await api("/exercises/reconcile-names", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { r = null; }
  restore();
  if (!r || r.ok === false) { toast("Couldn't tidy names — try again."); return; }
  const n = Number(r.aligned ?? r.applied) || 0;
  toast(n ? `Tidied ${n} exercise name${n === 1 ? "" : "s"}` : "Names already tidy");
  if (n) { swrInvalidate("progress:program"); renderProgram(); }
}

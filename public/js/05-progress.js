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
          <div class="hist-kicker lbl">${fmtShortDate(s.date)}${(s.title || s.day_name) ? ` \u00b7 ${escHtml(s.title || s.day_name)}` : ""}</div>
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

// The canonical taxonomy's first-class patterns the elite-build added — used to
// name a missing VOLUME pattern in plain words ("no core or grip work lately").
// Mobility is intentionally excluded: it's non-volume-counting, so the balance
// endpoint never reports it — flagging it "not programmed" would be a false signal.
const PATTERN_WORD = { core: "core", forearms: "grip" };

// Render the balance read. Returns "" when there's nothing meaningful to say.
function volBalanceHtml(bal) {
  if (!bal || !Array.isArray(bal.groups) || !bal.groups.length) return "";
  const due = Array.isArray(bal.due) ? bal.due : [];
  const over = Array.isArray(bal.over) ? bal.over : [];
  // Missing patterns: a first-class taxonomy group with NO sets logged in the window.
  const trained = new Set(bal.groups.map((g) => String(g.group).toLowerCase()));
  const missing = Object.keys(PATTERN_WORD).filter((p) => !trained.has(p));

  // Calm chip rows — due (terracotta-quiet), high (gold-quiet), missing (muted).
  const chip = (label, cls) => `<span class="vbal-chip ${cls}">${escHtml(label)}</span>`;
  // Broad-low (most groups due at once) → the summary already says "volume's light
  // across the board", so cap the Due row to the few that matter + a quiet "+N more"
  // instead of a wall of terracotta chips. Otherwise show them all.
  const dueShown = bal.broad_low ? due.slice(0, 4) : due;
  const dueMore = due.length - dueShown.length;
  const dueChips = dueShown.map((g) => chip(capWord(g), "vbal-due")).join("")
    + (dueMore > 0 ? chip(`+${dueMore} more`, "vbal-miss") : "");
  const overChips = over.map((g) => chip(capWord(g), "vbal-high")).join("");
  const missChips = missing.map((p) => chip(PATTERN_WORD[p], "vbal-miss")).join("");

  const rows = [];
  if (dueShown.length) rows.push(`<div class="vbal-row"><span class="vbal-lead lbl">Due</span><span class="vbal-chips">${dueChips}</span></div>`);
  if (overChips) rows.push(`<div class="vbal-row"><span class="vbal-lead lbl">Running high</span><span class="vbal-chips">${overChips}</span></div>`);
  if (missChips) rows.push(`<div class="vbal-row"><span class="vbal-lead lbl">Not programmed</span><span class="vbal-chips">${missChips}</span></div>`);

  const summary = bal.summary ? `<div class="vbal-summary">${escHtml(bal.summary)}</div>` : "";
  if (!rows.length && !summary) return "";
  return `<div class="vbal">
      <div class="vbal-head lbl">Balance</div>
      ${summary}
      ${rows.join("")}
    </div>`;
}

// Capitalize a single group/pattern word for display.
function capWord(s) {
  s = String(s || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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

// The periodized "This week's runs" card — the deterministic weekly run mix from
// GET /api/run-plan (easy / quality / long, each with a bpm-bearing zone + the one
// quality focus + a plain "why this week looks like this"). Endurance analogue of the
// program-state read. {available:false} for a non-runner → "". No scores; a calm plan.
function runKindClass(k) {
  if (k === "quality") return "wrun-quality"; // the one hard session — gold (steady, earned)
  if (k === "long") return "wrun-long";       // the long run — sage
  return "wrun-easy";                          // easy Z2 — sage, the bread-and-butter
}
function runKindLabel(k) {
  if (k === "quality") return "Quality";
  if (k === "long") return "Long";
  return "Easy";
}
function weeklyRunPlanCard(plan) {
  if (!plan || plan.available === false || !Array.isArray(plan.runs) || !plan.runs.length) return "";
  const runs = plan.runs.map((r) => {
    const pres = cardioPrescription({
      target_distance_km: r.target_distance_km,
      target_duration_min: r.target_duration_min,
      target_zone: r.target_zone,
      interval: r.interval,
      note: r.note,
    });
    const kind = runKindClass(r.kind_label);
    const label = r.label || (r.kind_label ? `${runKindLabel(r.kind_label)} run` : "Run");
    return `<div class="wrun-row ${kind}">
        <div class="wrun-row-head">
          <span class="wrun-kind">${escHtml(runKindLabel(r.kind_label))}</span>
          <span class="wrun-label">${escHtml(label)}</span>
        </div>
        ${pres ? `<div class="wrun-pres numeral">${escHtml(pres)}</div>` : ""}
        ${r.note && r.note !== label ? `<div class="wrun-note">${escHtml(r.note)}</div>` : ""}
      </div>`;
  }).join("");
  const rationale = Array.isArray(plan.rationale) ? plan.rationale.filter(Boolean) : [];
  const whyBits = [plan.why, ...rationale].filter(Boolean);
  return `<div class="wrun-card reveal" style="${stagger(0)}">
      <div class="wrun-head">
        <span class="lbl">This week's runs</span>
        ${plan.mix_summary ? `<span class="wrun-mix">${escHtml(plan.mix_summary)}</span>` : ""}
      </div>
      ${plan.quality_focus ? `<div class="wrun-focus"><span class="lbl">Quality focus</span> ${escHtml(plan.quality_focus)}</div>` : ""}
      <div class="wrun-rows">${runs}</div>
      ${whyBits.length ? `<div class="wrun-why"><span class="lbl">Why this week looks like this</span>${whyBits.map((w) => `<p>${escHtml(w)}</p>`).join("")}</div>` : ""}
    </div>`;
}

// Race countdown / standing-readiness banner — the persistent home for the endurance
// goal. Race: event + phase + how long to go. Standing: what you're staying ready for.
// No 0–100 scores; a calm anchor, never a gate.
function enduranceGoalCard(g) {
  if (!g || !g.mode) return "";
  if (g.mode === "race") {
    const d = g.days_to_race;
    const when = d == null ? "" : d < 0 ? "race day passed"
      : d === 0 ? "race day" : d <= 14 ? `${d} day${d === 1 ? "" : "s"} to go` : `${g.weeks_to_race} weeks to go`;
    const phaseLabel = { base: "Base building", build: "Building", sharpen: "Sharpening", taper: "Tapering", past: "Race done" }[g.phase] || "";
    const sub = [g.distance_km ? `${g.distance_km} km` : null, g.target ? `target ${g.target}` : null, g.date ? absDate(g.date) : null].filter(Boolean).join(" · ");
    return `<div class="end-goal reveal" style="${stagger(0)}">
        <div class="end-goal-head"><span class="lbl">Race goal</span>${phaseLabel ? `<span class="end-goal-phase">${escHtml(phaseLabel)}</span>` : ""}</div>
        <div class="end-goal-name">${escHtml(g.event || "Your race")}</div>
        ${sub ? `<div class="end-goal-sub">${escHtml(sub)}</div>` : ""}
        ${when ? `<div class="end-goal-count numeral">${escHtml(when)}</div>` : ""}
      </div>`;
  }
  const sub = [g.distance_km ? `${g.distance_km} km` : null, g.weekly_km ? `~${g.weekly_km} km/wk` : null].filter(Boolean).join(" · ");
  return `<div class="end-goal reveal" style="${stagger(0)}">
      <div class="end-goal-head"><span class="lbl">Standing goal</span></div>
      <div class="end-goal-name">Staying ${escHtml(g.label || "race-ready")}</div>
      ${sub ? `<div class="end-goal-sub">${escHtml(sub)}</div>` : ""}
    </div>`;
}

// A calm run-compliance line for the Endurance view — "32 of 40 km this week" in
// plain words from GET /api/run-compliance (in_words). A ratio, never a 0–100 grade.
// "" when there's nothing prescribed AND nothing logged (no week to speak to).
function runComplianceLine(c) {
  if (!c || !c.in_words) return "";
  if (!c.prescribed_sessions && !c.actual_sessions) return ""; // nothing to say
  return `<div class="end-compliance reveal" style="${stagger(0)}">
      <span class="lbl">This week's runs</span>
      <span class="end-compliance-v">${escHtml(c.in_words)}</span>
    </div>`;
}

// The bests for ONE sport, as scannable rows — pace at standard distances for foot
// sports (run/walk), distance/duration/speed for everything else. A cyclist's best
// is read in km/h, never as a min/km "pace" (the whole point of the sport split).
function enduranceBestRows(g) {
  const rows = [];
  if (g.longest_km) rows.push({ label: "Longest distance", val: `${fmtKm(g.longest_km.value)} km`, date: g.longest_km.date, type: g.longest_km.type });
  if (g.longest_min) rows.push({ label: "Longest duration", val: `${Math.round(g.longest_min.value)} min`, date: g.longest_min.date, type: g.longest_min.type });
  if (g.paced) {
    for (const bp of (g.best_pace || [])) rows.push({ label: `Best ${prDistLabel(bp.distance_km)} pace`, val: `${fmtPaceKm(bp.min_per_km)}/km`, date: bp.date, type: bp.type });
  } else if (g.best_speed_kmh) {
    rows.push({ label: "Best speed", val: `${fmtSpeedKmh(g.best_speed_kmh.value)} km/h`, date: g.best_speed_kmh.date, type: g.best_speed_kmh.type });
  }
  return rows;
}

// One sport's bests as a labelled card (sport name + the rows). `idx` seeds the
// reveal stagger so groups cascade in order.
function enduranceSportCardHtml(g, idx) {
  const rows = enduranceBestRows(g);
  if (!rows.length) return "";
  const body = rows.map((r, i) => `
    <div class="end-pr reveal" style="${stagger(idx + i)}">
      <div class="end-pr-id">
        <span class="end-pr-label">${escHtml(r.label)}</span>
        ${r.date ? `<span class="end-pr-when lbl" title="${escAttr(absDate(r.date))}">${escHtml(relAge(r.date))}${r.type ? ` · ${escHtml(r.type)}` : ""}</span>` : ""}
      </div>
      <span class="end-pr-val numeral">${escHtml(r.val)}</span>
    </div>`).join("");
  const head = g.label ? `<div class="end-pr-sport reveal" style="${stagger(idx)}">${escHtml(g.label)}</div>` : "";
  return `${head}<div class="end-pr-card">${body}</div>`;
}

// The Endurance lead — ONE calm coach sentence derived from this week's run plan: the
// long run is the session that matters, else the quality day, else "keep easy easy".
// Reuses .prog-headline (the lead-sentence style); "" for a non-runner / no plan, so
// the view degrades to its stacked sections. The full plan still renders below in the
// weekly run-plan card (Endurance is its home; Today shows just today's run).
function enduranceCoachLine(plan) {
  if (!plan || plan.available === false || !Array.isArray(plan.runs) || !plan.runs.length) return "";
  const long = plan.runs.find((r) => r.kind_label === "long");
  const quality = plan.runs.find((r) => r.kind_label === "quality");
  let s;
  if (long) {
    const dist = long.target_distance_km ? `${fmtKm(long.target_distance_km)} km ` : "";
    s = `This week, your ${dist}long run is the one that matters.`;
  } else if (quality) {
    s = `This week, your quality session is the one that matters.`;
  } else {
    s = `This week, keep your easy runs genuinely easy — that's the work.`;
  }
  return `<div class="prog-headline reveal" style="${stagger(0)}">${escHtml(s)}</div>`;
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

// ---------- Progress: Program (adaptive program intelligence) ----------
// Renders GET /api/program-state as a calm editorial read of how the athlete's
// program is evolving. No 0–100 scores. Constitution: calm, suggestion-not-a-gate,
// pull-never-push. Skeleton-first paint; empty state when lifts is empty.

// Map the raw status enum to calm plain-language labels. NEVER show the raw enum.
function liftStatusWord(lift) {
  const { status, weeks_static } = lift;
  if (status === "progressing") return "climbing";
  if (status === "plateaued") {
    const w = weeks_static != null && weeks_static > 0 ? `~${weeks_static} wk` : null;
    return w ? `stalled ${w}` : "stalled";
  }
  if (status === "regressing") return "trending down";
  if (status === "maintaining") return "holding";
  if (status === "new") return "building baseline";
  return "";
}

// A quiet figure line like "+2 lb/wk" or "+4 sec/wk", or "" when null.
function liftTrendFig(lift) {
  const t = lift.trend_per_wk;
  if (t == null) return "";
  if (lift.mode === "timed") {
    const secs = Math.round(Math.abs(t));
    return secs === 0 ? "" : `${t > 0 ? "+" : "−"}${secs} sec/wk`;
  }
  const lb = Math.abs(Math.round(t * 10) / 10);
  return lb === 0 ? "" : `${t > 0 ? "+" : "−"}${lb} lb/wk`;
}

// The est-1RM or best-hold as a quiet figure ("185 lb" or "1:45"), or "".
function liftBestFig(lift) {
  if (lift.mode === "timed" && lift.best_seconds != null) return fmtDur(lift.best_seconds);
  if (lift.est_1rm != null) return `${Math.round(lift.est_1rm)} lb`;
  return "";
}

// Sort order: stalled/regressing first (actionable), then progressing, then
// maintaining/new. Within each bucket keep original order.
function sortLifts(lifts) {
  const rank = (l) => {
    if (l.status === "plateaued" || l.status === "regressing") return 0;
    if (l.status === "progressing") return 1;
    return 2; // maintaining, new
  };
  return lifts.slice().sort((a, b) => rank(a) - rank(b));
}

// Volume band → calm word.
function volBandWord(band) {
  if (band === "low") return "below productive range";
  if (band === "productive") return "in the productive zone";
  if (band === "high") return "above ideal range";
  return band || "";
}

// Volume trend arrow (tiny, not a score).
function volTrendGlyph(trend) {
  if (trend === "rising") return " ↑";
  if (trend === "falling") return " ↓";
  return "";
}

// Mesocycle phase → calm word for display.
function phaseWord(phase) {
  if (phase === "accumulation") return "Accumulation";
  if (phase === "intensification") return "Intensification";
  if (phase === "deload-due") return "Deload due";
  if (phase === "deload") return "Deload";
  return "";
}

// Render a single lift row. Stalled/regressing get a subtle terracotta tint; progressing get sage.
function liftRowHtml(lift, i) {
  const statusWord = liftStatusWord(lift);
  const trendFig = liftTrendFig(lift);
  const bestFig = liftBestFig(lift);
  const isBad = lift.status === "plateaued" || lift.status === "regressing";
  const isGood = lift.status === "progressing";
  const modCls = isBad ? " prow-stalled" : isGood ? " prow-good" : "";
  const figBits = [bestFig, trendFig].filter(Boolean);
  return `<div class="prow reveal${modCls}" style="${stagger(i)}">
    <div class="prow-head">
      <span class="prow-name">${escHtml(lift.exercise)}</span>
      <span class="prow-status${isBad ? " prow-status-warn" : isGood ? " prow-status-ok" : ""}">${escHtml(statusWord)}</span>
    </div>
    ${figBits.length ? `<div class="prow-figs lbl">${escHtml(figBits.join(" · "))}</div>` : ""}
    ${lift.why ? `<div class="prow-why">${escHtml(lift.why)}</div>` : ""}
  </div>`;
}

// Volume block: compact rows, one per muscle group.
function volumeBlockHtml(volume, startIdx) {
  if (!volume || !volume.length) return "";
  const rows = volume.map((v, i) => {
    const bandWord = volBandWord(v.band);
    const glyph = volTrendGlyph(v.trend);
    const bandCls = v.band === "high" ? " pvol-high" : v.band === "low" ? " pvol-low" : " pvol-ok";
    return `<div class="pvol-row reveal" style="${stagger(startIdx + i)}">
      <span class="pvol-name">${escHtml(v.muscle_group)}</span>
      <span class="pvol-meta lbl"><b>${escHtml(String(v.weekly_sets))}</b> sets/wk<span class="pvol-band${bandCls}">${escHtml(glyph + " " + bandWord)}</span></span>
    </div>`;
  }).join("");
  return `<div class="pvol-card">${rows}</div>`;
}

// Mesocycle block — the note is the keystone, phase is secondary context.
function mesoBlockHtml(meso, idx) {
  if (!meso) return "";
  const ph = phaseWord(meso.phase);
  const bits = [];
  if (ph) bits.push(ph);
  if (meso.weeks_since_deload != null) bits.push(`${meso.weeks_since_deload} wk since deload`);
  return `<div class="pmeso reveal" style="${stagger(idx)}">
    ${bits.length ? `<div class="pmeso-phase lbl">${escHtml(bits.join(" · "))}</div>` : ""}
    <div class="pmeso-note">${escHtml(meso.note || "")}</div>
  </div>`;
}

// Endurance block — only rendered when the server provides it.
// Plain-English endurance status (never the raw enum — matches liftStatusWord /
// phaseWord / volBandWord; "spiking" reads as a technical term, so soften it).
function enduranceStatusWord(status) {
  if (status === "building") return "Building";
  if (status === "maintaining") return "Ticking over";
  if (status === "detraining") return "Fading";
  if (status === "spiking") return "Load spiked";
  return "";
}

function enduranceBlockHtml(end, idx) {
  if (!end) return "";
  const figs = [];
  if (end.last_week_km != null) figs.push(`${fmtKm(end.last_week_km)} km last week`);
  if (end.longest_km_4wk != null) figs.push(`${fmtKm(end.longest_km_4wk)} km longest · 4wk`);
  const statusWord = enduranceStatusWord(end.status);
  return `<div class="pend reveal" style="${stagger(idx)}">
    <div class="pend-head lbl">Endurance</div>
    ${statusWord ? `<div class="pend-status">${escHtml(statusWord)}</div>` : ""}
    ${figs.length ? `<div class="pend-figs lbl">${escHtml(figs.join(" · "))}</div>` : ""}
    ${end.why ? `<div class="pend-why">${escHtml(end.why)}</div>` : ""}
  </div>`;
}

// "What to evolve next" list — the keystone of the whole view.
function adaptationsHtml(adaptations, idx) {
  if (!adaptations || !adaptations.length) return "";
  const items = adaptations.map((a) => `<li class="padapt-item">${escHtml(a)}</li>`).join("");
  return `<div class="padapt reveal" style="${stagger(idx)}">
    <div class="padapt-head lbl">What to evolve next</div>
    <ul class="padapt-list">${items}</ul>
  </div>`;
}

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

// ---------- Performance standing — the "where you stand" capacity read ----------
// Fed by GET /api/performance: where each benchmark lift sits as a sex/age
// percentile/level against proven strength standards, VO2max-for-age, the strength
// imbalances, the single lever, lifts worth re-testing, a variety nudge, and a
// holistic balance line. The athletic counterpart to the health Standing — the
// motivational, scientific "where am I, really" the athlete asked for. No scores:
// percentile + the recognized level ladder (beginner→elite) are reference reads.
async function loadPerformance() {
  const slot = view.querySelector("#progPerfSlot");
  if (!slot) return;
  let p = null;
  try { p = await api("/performance"); } catch { p = null; }
  if (!p || (!(p.capacities || []).length && !p.endurance && !p.lever)) { slot.innerHTML = ""; return; }
  // When the conductor leads Program, IT is the one lever — drop performance's
  // standalone lever well so the lever isn't triplicated (conductor + here + adaptations).
  slot.innerHTML = performanceHtml(p, { suppressLever: !!_progFocusCard });
}

function pctClamp(n) { const x = Number(n); return Number.isFinite(x) ? Math.max(2, Math.min(99, Math.round(x))) : 0; }

function capacityRowHtml(c, sexWord) {
  const tone = c.tone === "strong" ? "strong" : c.tone === "watch" ? "watch" : "steady";
  const pct = pctClamp(c.percentile);
  const sub = [];
  if (c.exercise) sub.push(escHtml(c.exercise));
  if (c.est_1rm) sub.push(`~${escHtml(String(c.est_1rm))} lb 1RM`);
  sub.push(`stronger than ${pct}% of ${escHtml(sexWord || "people")} your age`);
  if (c.to_next) sub.push(`+${escHtml(String(c.to_next.lb))} lb → ${escHtml(c.to_next.level)}`);
  return `<div class="pcap">
    <div class="pcap-top"><span class="pcap-label">${escHtml(c.label)}</span><span class="pcap-level pcap-${tone}">${escHtml(c.level)}</span></div>
    <div class="pcap-bar"><span class="pcap-fill pcap-fill-${tone}" style="width:${pct}%"></span><span class="pcap-mark" style="left:${pct}%"></span></div>
    <div class="pcap-sub lbl">${sub.join(" · ")}</div>
  </div>`;
}

function performanceHtml(p, opts) {
  const suppressLever = !!(opts && opts.suppressLever);
  const caps = p.capacities || [];
  const chips = (p.momentum && p.momentum.chips) || [];
  let h = `<section class="pperf">`;

  // Hero — the one-line "where you are".
  if (p.hero && p.hero.headline) {
    h += `<div class="pperf-hero">
      <div class="pperf-hero-mast lbl">Where you stand</div>
      <div class="pperf-hero-head">${escHtml(p.hero.headline)}</div>
      ${p.hero.sub ? `<div class="pperf-hero-sub">${escHtml(p.hero.sub)}</div>` : ""}
      ${chips.length ? `<div class="pperf-chips">${chips.map((c) => `<span class="pperf-chip pperf-chip-${c.dir === "good" ? "good" : "neutral"}">${escHtml(c.text)}</span>`).join("")}</div>` : ""}
    </div>`;
  }

  // Capacity rows — the benchmarked "level for your age" per movement.
  if (caps.length) {
    const sexWord = p.sex === "female" ? "women" : "men";
    h += `<div class="pperf-caps">${caps.map((c) => capacityRowHtml(c, sexWord)).join("")}</div>`;
  }

  // Aerobic capacity (endurance/hybrid).
  if (p.endurance && p.endurance.headline && p.endurance.vo2max != null) {
    const tone = p.endurance.tone === "strong" ? "strong" : p.endurance.tone === "watch" ? "watch" : "steady";
    h += `<div class="pperf-aero pperf-aero-${tone}">${escHtml(p.endurance.headline)}</div>`;
  }

  // The one lever — terracotta well, the single biggest focus. Suppressed when the
  // conductor already leads with the lever (de-triplication).
  if (!suppressLever && p.lever && p.lever.headline) {
    h += `<div class="pperf-lever">
      <div class="pperf-lever-lbl lbl">The lever</div>
      <div class="pperf-lever-head">${escHtml(p.lever.headline)}</div>
      ${p.lever.why ? `<div class="pperf-lever-why">${escHtml(p.lever.why)}</div>` : ""}
      ${p.lever.target ? `<div class="pperf-lever-target">${escHtml(p.lever.target)}</div>` : ""}
    </div>`;
  }

  // Imbalances to address.
  if ((p.imbalances || []).length) {
    h += `<div class="pperf-block"><div class="pperf-block-lbl lbl">Balance &amp; symmetry</div>${p.imbalances
      .map((i) => `<div class="pperf-imb pperf-imb-${i.severity === "watch" ? "watch" : "note"}"><div class="pperf-imb-title">${escHtml(i.title)}</div><div class="pperf-imb-why">${escHtml(i.why)}</div></div>`)
      .join("")}</div>`;
  }

  // Worth re-testing.
  if ((p.tests_due || []).length) {
    h += `<div class="pperf-block"><div class="pperf-block-lbl lbl">Worth re-testing</div>${p.tests_due
      .map((t) => `<div class="pperf-test"><span class="pperf-test-ex">${escHtml(t.exercise)}</span><span class="pperf-test-why">${escHtml(t.why)}</span></div>`)
      .join("")}</div>`;
  }

  // Variety nudge.
  if (p.variety && p.variety.note) {
    h += `<div class="pperf-variety"><div class="pperf-block-lbl lbl">A little variety</div><div class="pperf-variety-note">${escHtml(p.variety.note)}</div>${
      (p.variety.suggestions || []).length ? `<div class="pperf-variety-opts">${p.variety.suggestions.map((s) => `<span class="pperf-opt">${escHtml(s)}</span>`).join("")}</div>` : ""
    }</div>`;
  }

  // Holistic balance & life line.
  if (p.balance_note) h += `<div class="pperf-balance">${escHtml(p.balance_note)}</div>`;

  h += `</section>`;
  return h;
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

// ---------- "What changed & why" — the program-adjustments digest ----------
// Fed by GET /api/program/adjustments — the handful of concrete adaptations the
// engine has noticed, each with a plain-words reason. So the athlete always
// understands WHAT the system did and WHY. Constitution: calm, one-at-a-time,
// pull-never-push, NO scores. Best-effort + null-safe: an unwired endpoint (404)
// leaves the slot empty, the rest of the view untouched.
// Calm per-kind glyph + tint class for an adjustment.
const PADJ_KIND = {
  progression: { glyph: "↑", cls: "padj-prog" },
  balance: { glyph: "◆", cls: "padj-bal" },
  deload: { glyph: "↓", cls: "padj-deload" },
  gap: { glyph: "○", cls: "padj-gap" },
  cardio: { glyph: "↗", cls: "padj-cardio" }, // this week's run mix
  dexa: { glyph: "◇", cls: "padj-dexa" },     // a DEXA-driven focus
  test: { glyph: "✦", cls: "padj-test" },     // a test week is about due
};

async function loadProgramAdjustments() {
  const slot = view.querySelector("#progAdjustSlot");
  if (!slot) return;
  let rows = null;
  try { rows = await api("/program/adjustments"); } catch { rows = null; }
  if (state.tab !== "progress" || state.progressSeg !== "program" || !slot.isConnected) return;
  const html = programAdjustmentsHtml(rows);
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
}

// Render the digest. `rows` is an array of {kind,title,why,exercise?}. "" when empty.
function programAdjustmentsHtml(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const items = rows.slice(0, 6).map((a) => {
    const meta = PADJ_KIND[a && a.kind] || PADJ_KIND.gap;
    return `<div class="padj-item ${meta.cls}">
        <span class="padj-glyph" aria-hidden="true">${meta.glyph}</span>
        <div class="padj-body">
          <div class="padj-title">${escHtml((a && a.title) || "")}</div>
          ${a && a.why ? `<div class="padj-why">${escHtml(a.why)}</div>` : ""}
        </div>
      </div>`;
  }).join("");
  return `<div class="padj-card">
      <div class="padj-card-head lbl">What changed &amp; why</div>
      ${items}
    </div>`;
}

// ---------- a "test week is about due" banner ----------
// Fed by GET /api/test-week — {due, why, key_lifts, cadence_weeks, last_test_week}.
// Renders only when due: a calm invitation to re-measure true capacity (the cadenced
// counterpart to the reactive "Worth re-testing" rows). Pull-never-push, no score.
async function loadTestWeek() {
  const slot = view.querySelector("#progTestSlot");
  if (!slot) return;
  let t = null;
  try { t = await api("/test-week"); } catch { t = null; }
  if (state.tab !== "progress" || state.progressSeg !== "program" || !slot.isConnected) return;
  if (!t || !t.due) { slot.innerHTML = ""; return; }
  slot.innerHTML = testWeekBannerHtml(t);
}
function testWeekBannerHtml(t) {
  const lifts = Array.isArray(t.key_lifts) ? t.key_lifts.filter(Boolean) : [];
  return `<div class="ptest-banner">
      <div class="ptest-head"><span class="ptest-glyph" aria-hidden="true">✦</span><span class="ptest-title">A test week is about due</span></div>
      ${t.why ? `<div class="ptest-why">${escHtml(t.why)}</div>` : ""}
      ${lifts.length ? `<div class="ptest-lifts">${lifts.map((l) => `<span class="ptest-lift">${escHtml(l)}</span>`).join("")}</div>` : ""}
    </div>`;
}

// ---------- per-muscle-group advancing/stalling strip ----------
// Fed by GET /api/muscle-trajectory — {available, headline, groups:[{group,label,
// verdict,lead_lift,stalled_signal,vary_options,volume_band,trend,note}]}. The owner's
// "which groups advance, which stall" framing; a stalling group exposes its
// vary_options as a "rotate one in" menu. Monotonic tone: sage = advancing, gold =
// building/maintaining, warn ONLY for a genuine stall. No scores.
async function loadMuscleTrajectory() {
  const slot = view.querySelector("#progMuscleSlot");
  if (!slot) return;
  let m = null;
  try { m = await api("/muscle-trajectory"); } catch { m = null; }
  if (state.tab !== "progress" || state.progressSeg !== "program" || !slot.isConnected) return;
  const html = muscleTrajectoryHtml(m);
  slot.innerHTML = html || "";
}
function muscleVerdictTone(v) {
  if (v === "advancing") return "strong";   // sage
  if (v === "stalling") return "watch";      // warn — the only genuinely below-par read
  return "steady";                            // building / maintaining — gold
}
function muscleVerdictWord(v) {
  if (v === "advancing") return "Advancing";
  if (v === "stalling") return "Stalling";
  if (v === "building") return "Building";
  if (v === "maintaining") return "Holding";
  return "";
}
function muscleTrendGlyph(t) {
  if (t === "rising") return "↑";
  if (t === "falling") return "↓";
  if (t === "stable") return "→";
  return "";
}
function muscleGroupRowHtml(g) {
  const tone = muscleVerdictTone(g.verdict);
  const word = muscleVerdictWord(g.verdict);
  const figs = [];
  if (g.lead_lift) figs.push(escHtml(g.lead_lift));
  if (g.volume_band) figs.push(`${escHtml(g.volume_band)} volume`);
  const trendG = muscleTrendGlyph(g.trend);
  if (trendG) figs.push(`${trendG} ${escHtml(g.trend)}`);
  const opts = Array.isArray(g.vary_options) ? g.vary_options.filter((o) => o && o.name) : [];
  const varyHtml = (g.verdict === "stalling" && opts.length)
    ? `<div class="pmus-vary"><span class="pmus-vary-lbl lbl">rotate one in</span><div class="pmus-opts">${
        opts.slice(0, 3).map((o) => `<span class="pmus-opt"${o.why ? ` title="${escAttr(o.why)}"` : ""}>${escHtml(o.name)}</span>`).join("")
      }</div></div>`
    : "";
  return `<div class="pmus-row pmus-${tone}">
      <div class="pmus-row-head">
        <span class="pmus-name">${escHtml(g.label || g.group || "")}</span>
        ${word ? `<span class="pmus-verdict pmus-v-${tone}">${escHtml(word)}</span>` : ""}
      </div>
      ${figs.length ? `<div class="pmus-figs lbl">${figs.join(" · ")}</div>` : ""}
      ${g.stalled_signal ? `<div class="pmus-signal">${escHtml(g.stalled_signal)}</div>` : ""}
      ${g.note ? `<div class="pmus-note">${escHtml(g.note)}</div>` : ""}
      ${varyHtml}
    </div>`;
}
function muscleTrajectoryHtml(m) {
  if (!m || m.available === false || !Array.isArray(m.groups) || !m.groups.length) return "";
  return `<div class="pmus-card">
      <div class="pmus-card-head lbl">Muscle groups — advancing vs stalling</div>
      ${m.headline ? `<div class="pmus-headline">${escHtml(m.headline)}</div>` : ""}
      <div class="pmus-rows">${m.groups.map(muscleGroupRowHtml).join("")}</div>
    </div>`;
}

// ---------- DEXA-driven exercise targeting ----------
// Fed by GET /api/dexa-targeting — {available, targets:[{area,signal,bias,moves,
// domain,path,groups,informational}], lead, next_dexa_focus}. Maps regional DEXA
// signals → what to focus on before the next scan. Shared by Progress→Program and
// the top-level Me→Standing review (co-located with the regional read). {available:false} → "".
// informational:true targets (e.g. low BMD) are clinician-framed, never a directive.
async function loadDexaTargeting(slotId) {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  let d = null;
  try { d = await api("/dexa-targeting"); } catch { d = null; }
  if (!slot.isConnected) return;
  slot.innerHTML = dexaTargetingHtml(d) || "";
}
function dexaTargetToneCls(t) {
  if (t.informational) return "pdexa-info"; // clinician-framed (e.g. BMD) — neutral/steady
  if (t.domain === "nutrition") return "pdexa-nut";
  return "pdexa-train";
}
function dexaTargetHtml(t) {
  const moves = Array.isArray(t.moves) ? t.moves.filter(Boolean) : [];
  return `<div class="pdexa-target ${dexaTargetToneCls(t)}">
      <div class="pdexa-target-head">
        <span class="pdexa-area">${escHtml(t.area || "")}</span>
        ${t.informational ? `<span class="pdexa-tag lbl">worth discussing with your clinician</span>` : ""}
      </div>
      ${t.signal ? `<div class="pdexa-signal">${escHtml(t.signal)}</div>` : ""}
      ${t.bias ? `<div class="pdexa-bias">${escHtml(t.bias)}</div>` : ""}
      ${moves.length ? `<div class="pdexa-moves">${moves.map((m) => `<span class="pdexa-move">${escHtml(m)}</span>`).join("")}</div>` : ""}
      ${t.path ? `<div class="pdexa-path"><span class="lbl">Path to your next scan</span>${escHtml(t.path)}</div>` : ""}
    </div>`;
}
function dexaTargetingHtml(d) {
  if (!d || d.available === false || !Array.isArray(d.targets) || !d.targets.length) return "";
  const heading = (d.lead && d.lead.next_dexa_focus) || d.next_dexa_focus || "From your DEXA — what to focus on next";
  return `<div class="pdexa-card">
      <div class="pdexa-card-head">
        <span class="lbl">From your DEXA</span>
        <div class="pdexa-focus">${escHtml(heading)}</div>
      </div>
      <div class="pdexa-targets">${d.targets.map(dexaTargetHtml).join("")}</div>
    </div>`;
}

// ---- periodization block (the mesocycle the coach periodizes toward) ----
function blockFocusWord(f) {
  if (f === "strength") return "Strength";
  if (f === "hypertrophy") return "Hypertrophy";
  if (f === "endurance-base") return "Endurance base";
  if (f === "peak") return "Peak";
  return f || "";
}

function activeBlockHtml(b) {
  const meta = [blockFocusWord(b.focus), phaseWord(b.phase)].filter(Boolean).join(" · ");
  return `<div class="pblock pblock-active">
    <div class="pblock-head">
      <span class="pblock-kicker lbl">Current block</span>
      <span class="pblock-week lbl">week ${Number(b.week_index)} of ${Number(b.total_weeks)}</span>
    </div>
    <div class="pblock-goal">${escHtml(b.goal || "Training block")}</div>
    ${meta ? `<div class="pblock-meta lbl">${escHtml(meta)}</div>` : ""}
    <div class="pblock-actions">
      <button class="pillbtn" type="button" data-blockadvance="${b.id}">Advance week</button>
      <button class="pillbtn" type="button" data-blockcomplete="${b.id}">Complete</button>
    </div>
  </div>`;
}

function startBlockHtml() {
  return `<div class="pblock">
    <button class="linkbtn" type="button" data-blockstart>+ Start a training block</button>
    <div class="pblock-composer" hidden>
      <input class="pblock-goal-in" type="text" autocomplete="off" placeholder="goal — e.g. Build squat + 10k base" aria-label="Block goal">
      <div class="pblock-composer-row">
        <select class="pblock-focus-in" aria-label="Focus">
          <option value="strength">Strength</option>
          <option value="hypertrophy">Hypertrophy</option>
          <option value="endurance-base">Endurance base</option>
          <option value="peak">Peak</option>
        </select>
        <input class="pblock-weeks-in" type="number" inputmode="numeric" min="2" max="12" value="5" aria-label="Weeks">
        <span class="lbl">weeks</span>
        <button class="pillbtn pill-accent" type="button" data-blockcreate>Start</button>
      </div>
    </div>
  </div>`;
}

async function loadProgramBlock() {
  const slot = view.querySelector("#progBlockSlot");
  if (!slot) return;
  let block = null;
  try { block = await api("/program/blocks/active"); } catch { return; }
  if (state.tab !== "progress" || !slot.isConnected) return;
  slot.innerHTML = block ? activeBlockHtml(block) : startBlockHtml();
  wireProgramBlock(slot);
}

function wireProgramBlock(slot) {
  const refresh = () => { swrInvalidate("plan:coach"); loadProgramBlock(); };
  const post = async (path, okMsg) => {
    try {
      const r = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (r && r.error) { toast("Couldn't update the block"); return; }
      if (okMsg) toast(okMsg);
      refresh();
    } catch { toast("Couldn't update the block"); }
  };
  slot.querySelector("[data-blockstart]")?.addEventListener("click", () => {
    const c = slot.querySelector(".pblock-composer");
    if (c) { c.hidden = false; slot.querySelector(".pblock-goal-in")?.focus(); }
  });
  slot.querySelector("[data-blockcreate]")?.addEventListener("click", async () => {
    const goal = (slot.querySelector(".pblock-goal-in")?.value || "").trim();
    const focus = slot.querySelector(".pblock-focus-in")?.value || "strength";
    const total_weeks = Number(slot.querySelector(".pblock-weeks-in")?.value) || 5;
    try {
      const r = await api("/program/blocks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal: goal || "Training block", focus, total_weeks }) });
      if (r && r.id) { toast("Block started — the coach will periodize toward it"); refresh(); }
      else toast("Couldn't start the block");
    } catch { toast("Couldn't start the block"); }
  });
  const adv = slot.querySelector("[data-blockadvance]");
  if (adv) adv.addEventListener("click", () => post(`/program/blocks/${adv.dataset.blockadvance}/advance`, "Moved to the next week"));
  const comp = slot.querySelector("[data-blockcomplete]");
  if (comp) comp.addEventListener("click", () => armDelete(comp, () => post(`/program/blocks/${comp.dataset.blockcomplete}/complete`, "Block completed")));
}

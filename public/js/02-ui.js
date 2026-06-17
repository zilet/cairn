// ==== 02-ui.js ====
// ---------- header date control (Today) ----------
// On the Today tab the big header title IS the date control: tapping it opens a
// native date picker via a visually-hidden input anchored under the header.
let _hdrDate = null;
function ensureHeaderDateInput() {
  if (_hdrDate) return _hdrDate;
  _hdrDate = document.createElement("input");
  _hdrDate.type = "date";
  _hdrDate.className = "hdr-datepick";
  _hdrDate.setAttribute("aria-hidden", "true");
  _hdrDate.tabIndex = -1;
  document.querySelector("header").appendChild(_hdrDate);
  _hdrDate.addEventListener("change", () => {
    if (!_hdrDate.value) return;
    state.logDate = _hdrDate.value;
    state.day = null;
    state.dayPicked = false;
    renderToday();
  });
  return _hdrDate;
}
function setTodayHeaderTitle() {
  headerTitle.innerHTML = `${escHtml(dateLabel(state.logDate))}<span class="hdr-chev" aria-hidden="true">▾</span>`;
  headerTitle.classList.add("hdr-tappable");
}
// On Today the header pins to the top so the date control is always reachable.
// At rest it's the full editorial header; once the page scrolls past a few px it
// condenses into a slim blurred band (CSS scoped to body[data-tab="today"]).
function updateHeaderCondense() {
  const on = state.tab === "today" && window.scrollY > 6;
  document.querySelector("header").classList.toggle("condensed", on);
}
window.addEventListener("scroll", updateHeaderCondense, { passive: true });
headerTitle.addEventListener("click", () => {
  if (state.tab !== "today") return;
  const inp = ensureHeaderDateInput();
  inp.value = state.logDate || localISO();
  inp.max = localISO();
  try { inp.showPicker(); } catch { inp.click(); inp.focus(); }
});

// toast(msg) — fire-and-forget pill. toast(msg, {action, onAction}) — actionable
// variant (e.g. UNDO) that lingers longer and accepts one tap.
let _toastTimer = null;
function toast(msg, opts = {}) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  clearTimeout(_toastTimer);
  if (opts.action) {
    t.textContent = "";
    const span = document.createElement("span");
    span.textContent = msg;
    const btn = document.createElement("button");
    btn.className = "toast-act";
    btn.textContent = opts.action;
    btn.addEventListener("click", () => {
      clearTimeout(_toastTimer);
      t.classList.remove("show", "toast-actionable");
      opts.onAction && opts.onAction();
    });
    t.append(span, btn);
    t.classList.add("toast-actionable");
  } else {
    t.textContent = msg;
    t.classList.remove("toast-actionable");
  }
  t.classList.add("show");
  _toastTimer = setTimeout(() => t.classList.remove("show", "toast-actionable"), opts.action ? 5000 : 1400);
}

// ---------- rest timer ----------
const rest = { id: null, remaining: 0, total: 0 };
function ensureRestBar() {
  let bar = document.querySelector(".rest");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "rest";
    bar.innerHTML = `<div class="rest-fill"></div>
      <div class="rest-row">
        <button class="rest-btn" data-r="-15">−15</button>
        <span class="rest-time"></span>
        <button class="rest-btn" data-r="15">+15</button>
        <button class="rest-btn rest-skip" data-r="0">Skip</button>
      </div>`;
    document.body.appendChild(bar);
    bar.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
      const v = Number(b.dataset.r);
      if (v === 0) return stopRest();
      rest.remaining = Math.max(1, rest.remaining + v);
      rest.total = Math.max(rest.total, rest.remaining);
      paintRest();
    }));
  }
  return bar;
}
function paintRest() {
  const bar = document.querySelector(".rest"); if (!bar) return;
  const m = Math.floor(rest.remaining / 60), s = String(rest.remaining % 60).padStart(2, "0");
  bar.querySelector(".rest-time").textContent = `Rest ${m}:${s}`;
  bar.querySelector(".rest-fill").style.width = `${Math.max(0, (rest.remaining / rest.total) * 100)}%`;
}
function startRest(seconds) {
  rest.total = seconds || Number(localStorage.getItem("restSec") || 120);
  rest.remaining = rest.total;
  ensureRestBar().classList.add("show");
  // give the page bottom clearance so the bar never traps the FINISH row / chatbar
  document.body.classList.add("resting");
  paintRest();
  clearInterval(rest.id);
  rest.id = setInterval(() => {
    rest.remaining -= 1;
    if (rest.remaining <= 0) { stopRest(); toast("Rest done"); if (navigator.vibrate) navigator.vibrate(150); return; }
    paintRest();
  }, 1000);
}
function stopRest() {
  clearInterval(rest.id); rest.id = null;
  const bar = document.querySelector(".rest"); if (bar) bar.classList.remove("show");
  document.body.classList.remove("resting");
}

// ---------- floating unsaved-changes save bar ----------
// One body-level pill shared by every screen with a Save flow (Settings, Plan
// editor, Me → Profile, Meals → planning preferences). It is the ONLY save
// affordance on those screens. mountSaveBar() re-arms it on each render; delegated
// input/change listeners mark the screen dirty, and a childList observer on
// #view dismisses the bar the moment a re-render disconnects the owning screen
// (tab/sub-view switches) — so it never leaks listeners or duplicates itself.
let saveCtx = null; // { sentinel, fields, onSave, onDiscard, dirty, busy }
let saveBarHideTimer = null;

function ensureSaveBar() {
  let bar = document.querySelector(".savebar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "savebar";
  bar.setAttribute("role", "status");
  bar.innerHTML = `
    <div class="savebar-row">
      <span class="savebar-dot" aria-hidden="true"></span>
      <span class="savebar-msg">Unsaved changes</span>
      <button type="button" class="savebar-discard">Discard</button>
      <button type="button" class="savebar-save">Save</button>
    </div>
    <div class="savebar-done" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path class="savebar-tick" d="M4.5 12.5l5 5L19.5 7"/></svg>
      <span>Saved</span>
    </div>`;
  document.body.appendChild(bar);
  bar.querySelector(".savebar-save").addEventListener("click", saveBarCommit);
  bar.querySelector(".savebar-discard").addEventListener("click", () => {
    const ctx = saveCtx;
    if (!ctx || ctx.busy) return;
    hideSaveBar();
    if (ctx.onDiscard) ctx.onDiscard();
  });
  return bar;
}

function hideSaveBar() {
  clearTimeout(saveBarHideTimer);
  const bar = document.querySelector(".savebar");
  if (bar) {
    bar.classList.remove("show", "busy", "saved");
    const btn = bar.querySelector(".savebar-save");
    btn.disabled = false; btn.textContent = "Save";
  }
  document.body.classList.remove("savebar-open");
  if (saveCtx) saveCtx.dirty = false;
}

function setSaveDirty() {
  if (!saveCtx || saveCtx.dirty || saveCtx.busy) return;
  saveCtx.dirty = true;
  clearTimeout(saveBarHideTimer);
  const bar = ensureSaveBar();
  bar.classList.remove("saved", "busy");
  const btn = bar.querySelector(".savebar-save");
  btn.disabled = false; btn.textContent = "Save";
  void bar.offsetHeight; // a freshly created bar still gets its slide-in
  bar.classList.add("show");
  document.body.classList.add("savebar-open");
}

async function saveBarCommit() {
  const ctx = saveCtx;
  if (!ctx || ctx.busy) return;
  const bar = ensureSaveBar();
  const btn = bar.querySelector(".savebar-save");
  const wasShown = bar.classList.contains("show");
  ctx.busy = true;
  bar.classList.add("busy");
  btn.disabled = true;
  btn.textContent = "Saving…";
  let ok = false;
  try { ok = (await ctx.onSave()) !== false; }
  catch { ok = false; if (wasShown) toast("Couldn't save"); }
  ctx.busy = false;
  bar.classList.remove("busy");
  btn.disabled = false; btn.textContent = "Save";
  if (!ok) return; // stay dirty — the screen surfaces its own error detail
  ctx.dirty = false;
  if (!wasShown) { toast("Saved"); return; } // inline save with no pending edits
  // success flash: the row cross-fades to a sage check that draws itself in,
  // then the bar slips back down behind the tab bar
  bar.classList.add("saved");
  clearTimeout(saveBarHideTimer);
  saveBarHideTimer = setTimeout(() => {
    bar.classList.remove("show", "saved");
    document.body.classList.remove("savebar-open");
  }, reducedMotion() ? 700 : 1300);
}

// Re-arm the bar for the screen just rendered. `sentinel` must be an element
// that survives the screen's internal redraws (e.g. a wrapper whose innerHTML
// is redrawn) but dies on a full re-render; `fields` scopes which inputs mark
// it dirty.
function mountSaveBar({ sentinel, fields, onSave, onDiscard }) {
  const bar = ensureSaveBar();
  saveCtx = { sentinel, fields, onSave, onDiscard, dirty: false, busy: false };
  // reset any previous screen's bar — but never cut a commit/success flash short
  if (!bar.classList.contains("saved") && !bar.classList.contains("busy")) hideSaveBar();
  return { markDirty: setSaveDirty, save: saveBarCommit };
}

// dirty tracking: any input/change inside the mounted screen's fields
for (const evt of ["input", "change"]) {
  document.addEventListener(evt, (e) => {
    if (!saveCtx || saveCtx.dirty || saveCtx.busy) return;
    if (!saveCtx.sentinel?.isConnected) return;
    if (saveCtx.fields && saveCtx.fields.contains(e.target)) setSaveDirty();
  }, true);
}
// auto-dismiss when a re-render replaces the owning screen (tab/seg switches)
new MutationObserver(() => {
  if (saveCtx && !saveCtx.sentinel?.isConnected) {
    saveCtx = null;
    const bar = document.querySelector(".savebar");
    if (bar && bar.classList.contains("show") && !bar.classList.contains("saved")) hideSaveBar();
  }
}).observe(view, { childList: true });

// ---------- exercise detail (full-screen overlay, Morsel-style) ----------

// Wire every [data-guide] in scope + make the card's art tile tappable; both
// open the exercise detail with a shared-element zoom from the tile.
function wireGuides(scope) {
  (scope || view).querySelectorAll("[data-guide]").forEach((b) => {
    if (b._wired) return; b._wired = true;
    const name = decodeURIComponent(b.dataset.guide);
    const tileOf = () => b.closest(".ex, .prog-row")?.querySelector(".artile") || null;
    b.addEventListener("click", () => openExerciseModal(name, tileOf()));
    const tile = tileOf();
    if (tile && !tile._wired) {
      tile._wired = true;
      tile.style.cursor = "pointer";
      tile.addEventListener("click", () => openExerciseModal(name, tile));
    }
  });
}

async function openExerciseModal(name, fromTile) {
  const d = await api("/exercise/" + encodeURIComponent(name));
  const svg = art("exercise", name, d?.muscle_group);
  if (!d || !d.found) {
    openDetailFrom(fromTile, () => {
      mountDetail(`
        <div class="detail-art"><div class="detail-art-zoom">${artImg("exercise", name, "artile-xl", svg)}</div></div>
        <h2 class="detail-title">${escHtml(name)}</h2>
        <div class="empty">No data for this exercise yet.</div>
        <div class="detail-actions"><button class="pillbtn" data-close>Close</button></div>`);
      wireDetailCommon();
    });
    return;
  }

  const recent = d.recent || [];
  const timed = d.mode === "timed" || recent.some((r) => r.duration_sec != null);
  const pts = d.progress?.points || [];
  const latest = pts.slice(-1)[0];
  const hasPR = recent.some((r) => r.pr);

  // hero figure: est-1RM for reps work, best duration for timed
  let heroVal = 0, heroLbl = "", heroTxt = "", sparkVals = [];
  if (timed) {
    const durs = recent.filter((r) => r.duration_sec != null).map((r) => r.duration_sec);
    const best = durs.length ? Math.max(...durs) : 0;
    heroVal = best; heroLbl = "best duration";
    heroTxt = fmtDur(best);
    sparkVals = durs.slice().reverse(); // recent[] is newest-first
  } else if (latest) {
    heroVal = latest.best1rm; heroLbl = `est 1RM · ${escHtml(d.unit || "lb")} · epley`;
    sparkVals = pts.map((p) => p.best1rm);
  }
  const appears = (d.appears || []).map((a) => `D${a.day_number} ${escHtml(a.day_name)}`).join(" · ");
  const recentLines = recent.map((r) => {
    const fig = r.duration_sec != null ? fmtDur(r.duration_sec) : `${fmtWeight(r.weight)}×${r.reps}${r.rir != null ? ` @${r.rir}` : ""}`;
    return `<div class="detail-setline"><span>${escHtml(r.date || "")}</span><span class="numeral">${fig}${r.pr ? ` <span class="prbadge">PR</span>` : ""}</span></div>`;
  }).join("");

  openDetailFrom(fromTile, () => {
    const el = mountDetail(`
      <div class="detail-art"><div class="detail-art-zoom">${artImg("exercise", d.name, "artile-xl", svg)}</div></div>
      <h2 class="detail-title">${escHtml(d.name)}</h2>
      <div class="detail-ctx lbl">${escHtml(d.muscle_group || "exercise")}${hasPR ? ` <span class="prbadge">PR</span>` : ""}</div>
      ${heroVal ? `<div class="detail-kcal"><span class="numeral detail-num" ${timed ? "" : `data-cu="${heroVal}"`}>${timed ? heroTxt : "0"}</span><span class="detail-unit lbl">${heroLbl}</span></div>` : ""}
      ${sparkVals.length > 1 ? `<div class="detail-spark">${sparklineSvg(sparkVals)}</div>` : ""}
      ${d.constraint_note ? `<div class="ex-flag">${escHtml(d.constraint_note)}</div>` : ""}
      ${d.cues ? `<div class="detail-section"><div class="lbl">Form cues</div><div class="detail-body">${escHtml(d.cues)}</div></div>` : ""}
      ${appears ? `<div class="detail-section"><div class="lbl">In your plan</div><div class="detail-body">${appears}</div></div>` : ""}
      <div class="detail-section"><div class="lbl">Recent sets</div>
        ${recentLines || `<div class="detail-body" style="color:var(--muted)">None logged yet.</div>`}</div>
      <div class="detail-section detail-manage">
        <div class="lbl">This exercise</div>
        <div class="manage-row">
          <button class="pillbtn pill-sm" id="exType">Make ${timed ? "reps-based" : "timed (hold)"}</button>
          <button class="pillbtn pill-sm pill-warn" id="exDelete">Delete</button>
        </div>
      </div>
      <div class="detail-actions">
        <button class="pillbtn" id="askForm">Ask coach</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`);
    runCountUps(el);
    wireDetailCommon();
    const ask = el.querySelector("#askForm");
    if (ask) ask.addEventListener("click", () => {
      closeDetail(true);
      gotoChatWith(`How should I perform ${name} with good form? Flag anything for my injury constraints.`);
    });
    // Change an exercise's type (reps ⇄ timed) — upsert-by-name updates the mode.
    const typeBtn = el.querySelector("#exType");
    if (typeBtn) typeBtn.addEventListener("click", async () => {
      typeBtn.disabled = true;
      const next = timed ? "reps" : "timed";
      try {
        await postExerciseMode(d.name, next);
        if (state.exModes) state.exModes[d.name] = next;
        toast(`${d.name} is now ${next === "timed" ? "timed (hold)" : "reps-based"}`);
        closeDetail(true);
        if (state.tab === "today") renderToday();
      } catch { typeBtn.disabled = false; toast("Couldn't change type — try again"); }
    });
    // Delete an exercise — refuses (with a reason) if it has logged sets or is in a plan.
    const delBtn = el.querySelector("#exDelete");
    if (delBtn) delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      let r;
      try { r = await api("/exercises/" + encodeURIComponent(d.name), { method: "DELETE" }); }
      catch { delBtn.disabled = false; toast("Couldn't delete — try again"); return; }
      if (r && r.ok) {
        toast(`Deleted ${d.name}`);
        closeDetail(true);
        if (state.tab === "today") renderToday();
      } else {
        delBtn.disabled = false;
        toast(r && r.error ? `Can't delete ${d.name}. ${r.error}` : "Couldn't delete");
      }
    });
  });
}

// shared detail wiring: zoomable art + close pills + parallax drift on scroll
function wireDetailCommon() {
  const el = document.querySelector(".detail");
  if (!el) return;
  wireArtZoom(el.querySelector(".detail-art"));
  el.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeDetail()));
  const scroller = el.querySelector(".detail-scroll");
  const artEl = el.querySelector(".detail-art");
  if (scroller && artEl && !reducedMotion()) {
    scroller.addEventListener("scroll", () => {
      artEl.style.translate = `0 ${Math.min(40, scroller.scrollTop * 0.35)}px`;
      artEl.style.opacity = String(Math.max(0.25, 1 - scroller.scrollTop / 420));
    }, { passive: true });
  }
}

// ---------- food-note detail (tap a note → full-screen) ----------
async function openFoodDetail(n, fromTile) {
  const pj = parsedNote(n);
  const text = n.raw || n.raw_text || n.raw_output || "";
  const title = (pj && pj.summary) || foodTitleFromIngredients(pj) || text || "Food note";
  const kcal = foodNum(pj?.kcal) || 0;
  const macros = pj ? [["Protein", pj.protein_g], ["Carbs", pj.carbs_g], ["Fat", pj.fat_g], ["Fiber", pj.fiber_g]]
    .filter(([, v]) => v != null && v !== "" && !isNaN(Number(v))) : [];
  const maxG = Math.max(1, ...macros.map(([, v]) => Number(v)));
  const ingredients = foodIngredients(pj);
  const items = ingredients.length ? ingredients.map(ingredientLabel).join(", ") : foodItemsText(pj);
  const time = (n.created_at || "").slice(11, 16);

  // share of the day's lean-safe target, when we know both numbers
  if (kcal && !state._goal) { try { state._goal = await api("/goal"); } catch { state._goal = null; } }
  const target = state._goal?.recommended?.target_intake_kcal;
  const ctxBits = [];
  if (kcal && target) ctxBits.push(`${Math.round((kcal / target) * 100)}% of the day`);
  if (time) ctxBits.push(time);

  const q = text || title;
  const svg = art("food", q);
  const photoSrc = artEnabled && q ? withToken(`/api/art?kind=food&q=${encodeURIComponent(String(q).trim().slice(0, 120))}`) : "";

  openDetailFrom(fromTile, () => {
    const el = mountDetail(`
      <div class="detail-art"><div class="detail-art-zoom">${artImg("food", q, "artile-xl", svg)}</div></div>
      <h2 class="detail-title">${escHtml(title)}</h2>
      ${items ? `<div class="detail-items">${escHtml(items)}</div>` : ""}
      ${kcal ? `<div class="detail-kcal"><span class="numeral detail-num" data-cu="${kcal}">0</span><span class="detail-unit lbl">cal</span></div>` : ""}
      ${ctxBits.length ? `<div class="detail-ctx lbl">${escHtml(ctxBits.join(" · "))}</div>` : ""}
      ${macros.length ? `<div class="detail-macros">${macros.map(([l, v]) => `
        <div class="macrobar">
          <div class="macrobar-top"><span class="lbl">${l}</span><span class="macrobar-val">${escHtml(formatFoodNum(v))}g</span></div>
          <div class="macrobar-track"><div class="macrobar-fill barfill" style="width:${Math.max(3, Math.round((Number(v) / maxG) * 100))}%"></div></div>
        </div>`).join("")}</div>` : ""}
      ${ingredients.length ? `<div class="detail-section"><div class="lbl">Ingredients</div><div class="ing-breakdown">${ingredients.map((ing) => `
        <div class="ing-row">
          <div class="ing-main">
            <span>${escHtml(ing.item)}</span>
            ${ing.amount ? `<small>${escHtml(ing.amount)}</small>` : ""}
          </div>
          <div class="ing-nutri">${escHtml(foodMacroText(ing, { kcal: true, short: true }) || "estimated")}</div>
        </div>`).join("")}</div></div>` : ""}
      ${text && text !== title ? `<div class="detail-section"><div class="lbl">As logged</div><div class="detail-body">“${escHtml(text)}”</div></div>` : ""}
      ${pj?.notes ? `<div class="detail-section"><div class="detail-body" style="color:var(--muted)">${escHtml(pj.notes)}</div></div>` : ""}
      <div class="detail-actions">
        <button class="pillbtn pill-warn" data-remove>Remove</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`, photoSrc);
    runCountUps(el);
    wireDetailCommon();
    const rm = el.querySelector("[data-remove]");
    if (rm) rm.addEventListener("click", async () => {
      try {
        const r = await api(`/food-notes/${n.id}`, { method: "DELETE" });
        if (r && r.error) throw new Error(r.error);
        toast("Removed");
        closeDetail(true);
        document.querySelector(`.fnent[data-noteid="${n.id}"]`)?.remove();
      } catch { toast("Couldn't remove"); }
    });
  });
}
function gotoChatWith(text) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  const t = document.querySelector('.tab[data-tab="chat"]');
  if (t) t.classList.add("active");
  state.tab = "chat";
  document.body.dataset.tab = "chat"; // keep the header's Today-scoped styling off
  renderChat().then(() => { const i = $("#chatInput"); if (i) { i.value = text; autosizeChatInput(i); i.focus(); } });
}

function fmtWeight(w) {
  if (w === null || w === undefined) return "BW";
  return w < 0 ? `${-w} assist` : `${w}`;
}

// segmented sub-nav: items = [[key,label]]; handlers = {key: renderFn}
// Emits a sliding ink thumb (.seg-thumb) behind the active button; sub-view swaps
// go through a view transition so the thumb glides between renders. Wrapped in a
// sticky .segwrap band so the sub-nav stays pinned to the top while you scroll a
// long sub-view — one tap back to another section, never lost from focus.
function segBar(active, items) {
  const idx = Math.max(0, items.findIndex(([k]) => k === active));
  return `<div class="segwrap"><div class="seg seg-sliding" style="--segn:${items.length};--segi:${idx}"><span class="seg-thumb"></span>${items.map(([k, l]) => `<button class="segbtn${k === active ? " active" : ""}" data-seg="${k}">${l}</button>`).join("")}</div></div>`;
}
function wireSeg(handlers) {
  view.querySelectorAll(".segbtn").forEach((b, _i) =>
    b.addEventListener("click", () => {
      const f = handlers[b.dataset.seg]; if (!f) return;
      // slide the thumb immediately, then swap the sub-view inside a transition
      const seg = b.closest(".seg");
      if (seg) {
        const idx = [...seg.querySelectorAll(".segbtn")].indexOf(b);
        seg.style.setProperty("--segi", idx);
      }
      withViewTransition(() => Promise.resolve(f()).then(viewEnter));
    })
  );
  view.querySelectorAll(".seg").forEach(fitSeg);
}

// Pill / segment bars stay on ONE line and SCROLL when they don't fit, rather than
// clipping the last pill (e.g. "Calendar" on a narrow phone). Measure with
// content-width pills (the .seg-scroll layout); if that overflows, keep scroll mode
// — the sliding ink thumb assumes equal-width segments, so it yields to the solid
// active-pill background — and center the active pill. Otherwise drop back to the
// equal-width thumb. Adapts per-bar and per-viewport; no fixed breakpoint.
function fitSeg(seg) {
  if (!seg) return;
  seg.classList.add("seg-scroll");
  const overflow = seg.scrollWidth > seg.clientWidth + 1;
  seg.classList.toggle("seg-scroll", overflow);
  if (overflow) {
    const active = seg.querySelector(".segbtn.active");
    if (active) seg.scrollLeft = active.offsetLeft - (seg.clientWidth - active.offsetWidth) / 2;
  }
}
let _segFitRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(_segFitRaf);
  _segFitRaf = requestAnimationFrame(() => view.querySelectorAll(".seg").forEach(fitSeg));
});
const PROGRESS_SEG = [["sessions", "History"], ["trend", "1RM"], ["volume", "Volume"], ["weight", "Weight"], ["energy", "Energy"], ["calendar", "Calendar"]];
const PROGRESS_HANDLERS = { trend: () => renderProgress(), volume: () => renderVolume(), weight: () => renderWeight(), energy: () => renderEnergy(), calendar: () => renderCalendar(), sessions: () => renderHistory() };
const PLAN_SEG = [["edit", "Training"], ["meals", "Meals"], ["coach", "Coach"]];
const PLAN_HANDLERS = { edit: () => renderPlanEditor(), meals: () => renderMeals(), coach: () => renderCoach() };

function escHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escAttr(s) { return escHtml(s).replace(/"/g, "&quot;"); }

// ---------- markdown (chat bubbles) ----------
// Tiny dependency-free renderer for assistant replies: headings, bold/italic,
// inline code + fenced blocks, links, images, bullet/numbered lists, tables,
// blockquotes, hr. Escape-first: every line is escHtml'd BEFORE any tags are
// built, and URLs pass a scheme allowlist, so nothing user/agent-supplied can
// inject markup.
function mdSafeUrl(u) {
  const url = String(u ?? "").trim();
  return /^(https?:\/\/|mailto:|\/)/i.test(url) ? url.replace(/"/g, "&quot;") : null;
}
function mdInline(s) {
  // s is already HTML-escaped
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (m, alt, url) => {
      const u = mdSafeUrl(url); return u ? `<img src="${u}" alt="${alt.replace(/"/g, "&quot;")}" loading="lazy">` : alt || m;
    })
    .replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_m, txt, url) => {
      const u = mdSafeUrl(url); return u ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${txt}</a>` : txt;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
}
function mdToHtml(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let html = "", i = 0, para = [];
  const flush = () => { if (para.length) { html += `<p>${para.map(mdInline).join("<br>")}</p>`; para = []; } };
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => mdInline(escHtml(c.trim())));
  while (i < lines.length) {
    const raw = lines[i];
    const fence = raw.match(/^\s*```/);
    if (fence) {
      flush(); i++;
      const code = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      html += `<pre><code>${escHtml(code.join("\n"))}</code></pre>`;
      continue;
    }
    if (isTableRow(raw) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(raw); i += 2;
      let rows = "";
      while (i < lines.length && isTableRow(lines[i])) rows += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      html += `<div class="md-tablewrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
      continue;
    }
    const line = escHtml(raw);
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const lvl = Math.min(h[1].length + 2, 6); html += `<h${lvl}>${mdInline(h[2])}</h${lvl}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) { flush(); html += "<hr>"; i++; continue; }
    if (/^\s*&gt;\s?/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(mdInline(escHtml(lines[i++].replace(/^\s*>\s?/, ""))));
      html += `<blockquote>${q.join("<br>")}</blockquote>`;
      continue;
    }
    const ul = /^\s*[-*•]\s+/, ol = /^\s*\d+[.)]\s+/;
    if (ul.test(raw) || ol.test(raw)) {
      flush();
      const ordered = ol.test(raw), re = ordered ? ol : ul;
      let items = "";
      while (i < lines.length && re.test(lines[i])) items += `<li>${mdInline(escHtml(lines[i++].replace(re, "")))}</li>`;
      html += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      continue;
    }
    if (!raw.trim()) { flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return html;
}

// CairnArt (public/art.js) returns trusted static SVG strings — never user text — so its
// output is inserted raw. Guarded so a missing/stale art.js can't crash a render.
const art = (fn, ...a) => { try { return window.CairnArt?.[fn]?.(...a) || ""; } catch { return ""; } };
// staggered entrance delay for `.reveal` cards; index capped so long lists don't crawl in
const stagger = (i) => `--i:${Math.min(i ?? 0, 12)}`;

// ---------- motion utilities ----------
const reducedMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Subtle fade+rise re-triggered whenever #view's content is swapped wholesale
// (tab switches + segmented sub-view swaps). No-op under reduced motion.
function viewEnter() {
  if (reducedMotion()) return;
  view.classList.remove("view-in");
  void view.offsetWidth; // force reflow so the animation restarts
  view.classList.add("view-in");
}

// Soft fade for the skeleton→content swap: replace the busy skeleton with real
// content inside a view transition so the skeleton crossfades out as the content
// fades in, instead of a hard pop. Falls back to an instant swap when view
// transitions aren't supported or under reduced motion — exactly today's behavior.
// `fn` performs the actual `view.innerHTML = …` swap. When this render is ALREADY
// running inside a transition (a seg-tap wraps the handler in one, and finishes with
// viewEnter()), we DON'T nest a second one — stacking startViewTransition() aborts the
// outer and flickers. We just swap and let the surrounding fade carry it.
function skelSwap(fn) {
  if (_vtActive) { return Promise.resolve(fn()); }
  return withViewTransition(fn);
}

// Run a DOM-swapping fn inside a shared-element view transition when supported.
// `_vtActive` guards against accidentally nesting a transition inside another
// (which the browser would resolve by aborting the outer one).
let _vtActive = false;
function withViewTransition(fn) {
  const run = () => {
    try { return Promise.resolve(fn()); }
    catch (err) { return Promise.reject(err); }
  };
  if (document.startViewTransition && !reducedMotion() && !_vtActive) {
    try {
      _vtActive = true;
      const tx = document.startViewTransition(run);
      const done = tx.updateCallbackDone || tx.finished || Promise.resolve();
      Promise.resolve(done).finally(() => { _vtActive = false; });
      return done;
    } catch { _vtActive = false; /* fall through */ }
  }
  return run();
}

// Put a button into a calm "working" state for the length of an agentic call:
// swap its label for a quiet ring + working text, disable it, and pin the current
// width so the footprint never jumps. Returns restore() — call it in `finally`.
// `label` defaults to the button's current text; `ghost` uses a light ring (for
// dark/accent buttons). Safe on a null button.
function btnBusy(btn, label, { ghost = false } = {}) {
  if (!btn) return () => {};
  if (btn._busyRestore) return btn._busyRestore; // already working — don't stack
  const html = btn.innerHTML;
  const wasDisabled = btn.disabled;
  const minW = btn.style.minWidth;
  const text = label != null ? label : (btn.textContent || "").trim();
  btn.style.minWidth = btn.offsetWidth + "px"; // freeze footprint before swap
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.classList.add("btn-busy");
  btn.innerHTML = `<span class="btn-working"><span class="aspin aspin-sm${ghost ? " aspin-ghost" : ""}"></span>${escHtml(text)}</span>`;
  const restore = () => {
    if (btn._busyRestore !== restore) return;
    btn._busyRestore = null;
    btn.innerHTML = html;
    btn.disabled = wasDisabled;
    btn.removeAttribute("aria-busy");
    btn.classList.remove("btn-busy");
    btn.style.minWidth = minW;
  };
  btn._busyRestore = restore;
  return restore;
}

// Count a numeral up from 0 → target. Respects prefers-reduced-motion (snaps).
function countUp(el, target, { dur = 750, fmt = (v) => Math.round(v).toLocaleString() } = {}) {
  if (!el) return;
  const t = Number(target) || 0;
  if (reducedMotion() || !t) { el.textContent = fmt(t); return; }
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - p) ** 3; // settle, don't snap
    el.textContent = fmt(t * eased);
    if (p < 1 && el.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Full-area working state: the house .aspin ring + an italic label, centered in
// a region that's fetching/thinking (chat log hydrating, history overlay). The
// inline button-busy / typing-dots / filament cases live in btnBusy + the
// .aspin/.typing/.is-thinking CSS — see docs/DESIGN.md › Loading & progress.
function loadingState(label) {
  return `<div class="loadstate" role="status" aria-live="polite">
    <span class="aspin aspin-sm" aria-hidden="true"></span>
    <div class="loadstate-label">${escHtml(label)}</div>
  </div>`;
}

// Curated, op-specific "an agent is thinking" scripts — calm, Atelier-voiced, a
// few lines each so a long wait reads as quiet motion rather than a frozen line.
// thinkingCaption() crossfades through these (~2.6s/line) and loops the tail.
const THINKING_SCRIPTS = {
  session_suggest: ["Reading your week…", "Weighing recovery…", "Shaping today's session…", "Choosing the right load…"],
  meal_plan: ["Reading your week…", "Balancing the macros…", "Plating the days…", "Checking the protein floor…"],
  meal_swap: ["Reading the meal…", "Finding a match…", "Holding the macros…", "Plating the swap…"],
  recipe: ["Opening the kitchen…", "Sourcing the ingredients…", "Writing the steps…", "Tasting as it goes…"],
  nutrition_checkin: ["Reading your intake…", "Tracing the trend…", "Weighing the drift…", "Settling on a number…"],
  day_read_override: ["Hearing you…", "Re-reading the day…", "Reshaping the brief…"],
  chat_distill: ["Looking back over the thread…", "Keeping what matters…", "Tidying the rest away…"],
  insight: ["Connecting the dots…", "Crossing the domains…", "Listening for one real thread…"],
};

// Rotate an op's script through `el` with a gentle crossfade (reusing the chat
// `.typing-cap` / capfade vocabulary), ~2.6s a line, looping the tail. Under
// reduced motion it shows line 1 statically. Returns stop() — call it when the
// op settles. Safe on a null element / unknown op (falls back to a calm line).
function thinkingCaption(el, op) {
  if (!el) return () => {};
  const lines = THINKING_SCRIPTS[op] || ["Thinking…"];
  const paint = (txt) => {
    el.textContent = txt;
    if (!reducedMotion()) { el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; }
  };
  el.classList.add("typing-cap");
  paint(lines[0]);
  if (reducedMotion() || lines.length < 2) return () => {};
  let i = 0;
  const timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(timer); return; }
    i = i + 1 >= lines.length ? Math.max(1, lines.length - 2) : i + 1; // loop the tail, never restart at the intro
    paint(lines[i]);
  }, 2600);
  return () => clearInterval(timer);
}

// Calm fallback when a tab's (possibly agentic) render rejects — e.g. a network
// blip during a skeleton-first paint. Replaces the stranded shimmer with a quiet
// retry instead of freezing on the skeleton. No nag, just an option.
function tabErrorState(tab) {
  view.innerHTML = `<div class="loadstate" role="alert">
    <div class="loadstate-label">Couldn't load this view — check your connection.</div>
    <button class="ghostbtn" data-tabretry style="margin-top:10px">Try again</button>
  </div>`;
  const btn = view.querySelector("[data-tabretry]");
  if (btn) btn.addEventListener("click", () => switchTab(tab));
}

// Skeleton-first paint helpers — reuse the .hshimmer shimmer primitive so every
// tab paints its shape instantly, then hydrates. Never invent a one-off spinner;
// these mirror the loading vocabulary in docs/DESIGN.md. `aria-hidden` because the
// real content carries its own labels once it lands.
function skelLines(n = 3) {
  let s = `<div class="skel-card" aria-hidden="true"><div class="hshimmer hshimmer-lg"></div>`;
  for (let i = 0; i < n; i++) s += `<div class="hshimmer${i === n - 1 ? " hshimmer-sm" : ""}"></div>`;
  return s + `</div>`;
}
// Today: a Brief-shaped block + a couple of card silhouettes.
function todaySkeleton() {
  return `<div class="today-wrap today-skel" aria-busy="true">
    <div class="skel-brief" aria-hidden="true">
      <div class="hshimmer hshimmer-sm" style="width:34%"></div>
      <div class="hshimmer hshimmer-lg" style="width:64%;height:26px"></div>
      <div class="hshimmer"></div>
    </div>
    ${skelLines(2)}
    ${skelLines(3)}
  </div>`;
}
// A seg-bar tab (Progress / Plan / Me sub-views) — paint the REAL segmented
// control synchronously (it's constant, no await) so the thumb sits where the
// user tapped, then a hero + a couple of card silhouettes shimmer below until the
// data lands. The seg is already wired by the real render that follows.
function segSkeleton(active, seg, cards = 2) {
  let s = segBar(active, seg) + `<div class="skel-region" aria-busy="true">${skelLines(2)}`;
  for (let i = 0; i < cards; i++) s += skelLines(3);
  return s + `</div>`;
}

// humanized big numbers: 12450 → "12.4k"
const fmtK = (n) => {
  const v = Number(n) || 0;
  return v >= 10000 ? `${Math.round(v / 100) / 10}k` : Math.round(v).toLocaleString();
};

// Run count-ups for every [data-cu] numeral in scope (data-cufmt="k" → humanized).
// `snap:true` writes the final value with no animation — used when a warm SWR
// re-render replaces already-shown numerals, so they don't re-count from zero.
function runCountUps(scope, { snap = false } = {}) {
  (scope || view).querySelectorAll("[data-cu]").forEach((el) => {
    const fmt = el.dataset.cufmt === "k" ? fmtK : (x) => Math.round(x).toLocaleString();
    if (snap) { el.textContent = fmt(Number(el.dataset.cu) || 0); return; }
    countUp(el, Number(el.dataset.cu) || 0, { fmt });
  });
}

// ---------- duration helpers (timed exercises) ----------
// "90" → 90 · "1:30" → 90 · "2m" → 120 · "45s" → 45. null on garbage.
function parseDur(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*m(?:in)?$/);
  if (m) return Math.round(Number(m[1]) * 60);
  m = s.match(/^(\d+)\s*s(?:ec)?$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}
// 90 → "1:30", 45 → "0:45"
function fmtDur(sec) {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

// ---------- progressive artwork (CairnArt SVG → generated photo) ----------
// Server contract: GET /api/art?kind=&q= → 200 image/* when cached, 204 when not ready
// (the 204 itself kicks off background generation; an <img> treats 204 as an error).
let artEnabled = true; // refreshed from /settings at boot + on Settings save

window._artOk = (img) => { img.classList.add("on"); };
window._artErr = (img) => {
  img.classList.remove("on");
  if (img.dataset.retried) return; // one quiet retry only
  img.dataset.retried = "1";
  const token = pollToken;
  setTimeout(() => {
    if (token !== pollToken || !img.isConnected) return; // stale tab / re-render — bail
    img.src = img.src.includes("&r=") ? img.src : img.src + "&r=1";
  }, 20000);
};

// Art tile that renders the CairnArt SVG instantly and fades a generated photo in
// over it when /api/art has one. `svg` may be passed (exercise art needs muscleGroup);
// defaults to art(kind, q). Falls back to SVG-only when artwork generation is off.
function artImg(kind, q, cls = "artile-md", svg = null) {
  const s = svg != null ? svg : art(kind, q);
  if (!s) return "";
  const query = String(q || "").trim().slice(0, 120);
  if (!artEnabled || !query) return `<div class="artile ${cls}">${s}</div>`;
  const src = withToken(`/api/art?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}`);
  return `<div class="artile artimg ${cls}">${s}<img class="artimg-photo" alt="${escAttr(query)}" loading="lazy" decoding="async" src="${escAttr(src)}" onload="_artOk(this)" onerror="_artErr(this)"></div>`;
}

// tiny inline sparkline (numbers only — safe for innerHTML)
function sparklineSvg(vals, w = 132, h = 30) {
  const v = (vals || []).map(Number).filter((x) => !isNaN(x));
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v);
  const x = (i) => 2 + (i * (w - 4)) / (v.length - 1);
  const y = (n) => max === min ? h / 2 : h - 3 - ((n - min) / (max - min)) * (h - 6);
  const pts = v.map((n, i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  const last = v[v.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="#b4552d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="#b4552d"/>
    </svg>`;
}

// ---------- full-screen detail overlay (Morsel-style) ----------
let _detailOrigin = null; // the tapped tile, for the reverse shared-element zoom
function closeDetail(instant) {
  const d = document.querySelector(".detail");
  if (!d) return;
  const origin = _detailOrigin;
  _detailOrigin = null;
  if (instant || !document.startViewTransition || reducedMotion()) {
    if (origin && origin.isConnected) origin.style.viewTransitionName = "";
    d.remove();
    return;
  }
  // old state: overlay art carries the name; new state: the originating tile does —
  // the photo glides back into its list tile, then the name is released.
  withViewTransition(() => {
    d.remove();
    if (origin && origin.isConnected) {
      origin.style.viewTransitionName = "detail-art";
      setTimeout(() => { origin.style.viewTransitionName = ""; }, 450);
    }
  });
}

// Open a detail overlay with a shared-element zoom from `tile` (an .artile in the list).
function openDetailFrom(tile, build) {
  closeDetail(true);
  _detailOrigin = tile || null;
  if (tile && document.startViewTransition && !reducedMotion()) {
    tile.style.viewTransitionName = "detail-art";
    try {
      const t = document.startViewTransition(() => { tile.style.viewTransitionName = ""; build(); });
      t.finished.catch(() => {});
      return;
    } catch { tile.style.viewTransitionName = ""; }
  }
  build();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".sheet")) { closeMealSheet(); return; }
  closeDetail();
});

// Mount the overlay scaffold; returns the .detail element. Caller fills .detail-scroll.
function mountDetail(inner, photoSrc) {
  const d = document.createElement("div");
  d.className = "detail";
  d.innerHTML = `<div class="detail-bg">${photoSrc ? `<img alt="" src="${escAttr(photoSrc)}" onerror="this.remove()">` : ""}</div>
    <button class="detail-x" aria-label="Close">✕</button>
    <div class="detail-scroll">${inner}</div>`;
  document.body.appendChild(d);
  d.querySelector(".detail-x").addEventListener("click", () => closeDetail());
  d.addEventListener("click", (e) => { if (e.target === d) closeDetail(); });
  return d;
}

// "Lean in": wheel / pinch zoom on the detail art, CSS transform clamped 1–2.2.
function wireArtZoom(artEl) {
  if (!artEl) return;
  const inner = artEl.firstElementChild || artEl;
  let scale = 1;
  const apply = () => { inner.style.transform = `scale(${scale})`; };
  artEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    scale = Math.min(2.2, Math.max(1, scale - e.deltaY * 0.0028));
    apply();
  }, { passive: false });
  const touches = new Map();
  let pinchBase = 0, pinchScale = 1;
  const dist = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  artEl.addEventListener("pointerdown", (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) { pinchBase = dist(); pinchScale = scale; }
  });
  artEl.addEventListener("pointermove", (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinchBase > 0) {
      scale = Math.min(2.2, Math.max(1, pinchScale * (dist() / pinchBase)));
      apply();
    }
  });
  const lift = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinchBase = 0; };
  artEl.addEventListener("pointerup", lift);
  artEl.addEventListener("pointercancel", lift);
}

// ---------- background enrichment (poll a row until its status settles) ----------
// pollToken is bumped on every full re-render so in-flight polls can detect a stale tab and bail.
let pollToken = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function enrichmentActive(status) {
  return status === "pending" || status === "in_progress";
}
// Poll GET path/:id every ~1.5s up to ~10 tries. onUpdate(row) runs per fetch while the tab
// is still current; resolves once status leaves the active states (or the cap is hit). Returns the last row.
async function pollEnrichment(path, id, { tab, token, onUpdate, tries = 10, interval = 1500 } = {}) {
  let row = null;
  for (let i = 0; i < tries; i++) {
    await sleep(interval);
    if (token !== pollToken || state.tab !== tab) return null; // navigated away / re-rendered
    try { row = await api(`${path}/${id}`); } catch { continue; }
    if (!row || row.error) continue;
    if (token !== pollToken || state.tab !== tab) return null;
    onUpdate && onUpdate(row);
    if (!enrichmentActive(row.enrichment_status)) return row;
  }
  return row;
}

// Status badge: shows a spinner while pending, a subtle "noted" tag when the coach captured something.
function enrichBadge(status) {
  if (enrichmentActive(status)) return `<span class="enr enr-pending">enriching...</span>`;
  if (status === "done") return `<span class="enr enr-done" title="coach captured a note">✦ noted</span>`;
  return ""; // skipped / failed / undefined -> no noise
}

// One-line description of an activity row from its (possibly refined) fields.
function activityLine(a) {
  const bits = [
    a.type,
    a.duration_min ? `${a.duration_min} min` : null,
    a.distance_km ? `${a.distance_km} km` : null,
    a.pace || null,
    a.rpe != null ? `RPE ${a.rpe}` : null,
  ].filter(Boolean).join(" · ");
  return bits || a.raw_text || a.notes || "";
}


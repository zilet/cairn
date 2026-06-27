// ==== 02-ui.js ====
// ---------- header date control (Today) ----------
// On the Today tab the big header title IS the date control — change the date to
// review OR log a past workout. A REAL full-size (transparent) date input overlays
// the title, so a genuine tap opens the native picker on every browser (the old
// showPicker()-over-a-1px-hidden-input failed silently where showPicker throws).
// Other tabs set headerTitle via textContent, which removes this input automatically.
function setTodayHeaderTitle() {
  headerTitle.innerHTML =
    `${escHtml(dateLabel(state.logDate))}<span class="hdr-chev" aria-hidden="true">▾</span>` +
    `<input type="date" class="hdr-datepick" aria-label="Choose a date to view or log a past workout">`;
  headerTitle.classList.add("hdr-tappable");
  const inp = headerTitle.querySelector(".hdr-datepick");
  inp.value = state.logDate || localISO();
  inp.max = localISO();
  // Desktop: a click on a date input only focuses it (the calendar indicator is
  // hidden by appearance:none) — showPicker opens the calendar. Mobile taps open
  // the native picker on their own. Either way the change handler reloads Today.
  inp.addEventListener("click", () => { try { inp.showPicker?.(); } catch { /* unsupported → native focus */ } });
  inp.addEventListener("change", () => {
    if (!inp.value) return;
    state.logDate = inp.value;
    state.day = null;
    state.dayPicked = false;
    renderToday();
  });
}
// On Today the header pins to the top so the date control is always reachable.
// At rest it's the full editorial header; once the page scrolls past a few px it
// condenses into a slim blurred band (CSS scoped to body[data-tab="today"]).
function updateHeaderCondense() {
  const on = state.tab === "today" && window.scrollY > 6;
  document.querySelector("header").classList.toggle("condensed", on);
}
window.addEventListener("scroll", updateHeaderCondense, { passive: true });

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

// ---------- one destructive-confirm pattern: the two-tap armed × ----------
// Every delete in the app uses THIS: first tap arms the × into a "remove?" chip,
// a second tap (within ~3s, or until blur) confirms; otherwise it disarms. One
// idiom across Memory / Life / Family / Health docs / session-set edits — never a
// blocking dialog, never an immediate destructive click. `onConfirm` runs on the
// confirming tap; it owns the actual delete + any toast/UI update.
function armDelete(btn, onConfirm, { label = "remove?" } = {}) {
  if (!btn) return;
  if (btn.dataset.armed) { onConfirm(); return; }
  if (!btn.dataset.restGlyph) btn.dataset.restGlyph = btn.textContent || "×";
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.textContent = label;
  const reset = () => {
    delete btn.dataset.armed;
    btn.classList.remove("armed");
    btn.textContent = btn.dataset.restGlyph || "×";
    clearTimeout(t);
  };
  const t = setTimeout(reset, 3000);
  btn.addEventListener("blur", reset, { once: true });
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
  bar.setAttribute("aria-hidden", "true");
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
    bar.setAttribute("aria-hidden", "true");
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
  bar.removeAttribute("aria-hidden");
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
    bar.setAttribute("aria-hidden", "true");
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

// True when a form control still holds its rendered-in value (selects/inputs are
// rendered with `selected`/`value`/`checked` attributes, which set the DOM defaults).
// Used to ignore a spurious mount-time change event that doesn't actually change a
// value — the cause of the bar flashing "Unsaved changes" on a fresh Settings load.
function controlAtDefault(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === "SELECT") { const o = el.selectedOptions && el.selectedOptions[0]; return !o || o.defaultSelected; }
  if (el.type === "checkbox" || el.type === "radio") return el.checked === el.defaultChecked;
  if ("defaultValue" in el) return el.value === el.defaultValue;
  return false;
}

// dirty tracking: any input/change inside the mounted screen's fields
for (const evt of ["input", "change"]) {
  document.addEventListener(evt, (e) => {
    if (!saveCtx || saveCtx.dirty || saveCtx.busy) return;
    if (!saveCtx.sentinel?.isConnected) return;
    if (!saveCtx.fields || !saveCtx.fields.contains(e.target)) return;
    if (controlAtDefault(e.target)) return; // no real change → not a user edit (mount-time noise)
    setSaveDirty();
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

function exerciseExplanation(d) {
  const name = String(d?.name || "").toLowerCase();
  const mg = String(d?.muscle_group || "").toLowerCase();
  const line = (setup, move, feel, avoid = "Stop if pain changes your position or range.") => ({ setup, move, feel, avoid });

  if (/bulgarian|split squat|lunge/.test(name)) return line(
    "Front foot far enough forward that you can stay balanced; rear foot is just support.",
    "Lower under control with a slight torso lean, then drive through the front midfoot.",
    "Front-leg quad and glute. Stop short of any knee or hip pinch.",
    "Do not push off the rear leg or let the front knee cave inward."
  );
  if (/romanian|rdl|deadlift|hinge/.test(name) || mg.includes("posterior")) return line(
    "Soft knees, ribs down, bar or dumbbells close to the legs.",
    "Push the hips back until the hamstrings stretch, then stand tall without leaning back.",
    "Hamstrings and glutes, not the low back."
  );
  if (/squat/.test(name)) return line(
    "Feet planted, brace before each rep, eyes fixed slightly ahead.",
    "Sit between the hips, let knees track over toes, then drive the floor away.",
    "Quads and glutes with a stable torso."
  );
  if (/pull.?up|pulldown/.test(name)) return line(
    "Start tall with shoulders set down away from the ears.",
    "Pull elbows toward the ribs, pause with the chest lifted, then control the stretch.",
    "Lats and mid-back. Avoid turning it into a shrug."
  );
  if (/row/.test(name)) return line(
    "Brace the trunk and keep the chest quiet.",
    "Pull elbows back toward the pockets, pause, then return without rounding forward.",
    "Mid-back and lats, with minimal torso swing."
  );
  if (/overhead|shoulder press/.test(name)) return line(
    "Ribs down, glutes tight, forearms vertical.",
    "Press up and slightly back so the weight finishes over the shoulders.",
    "Shoulders and triceps without low-back arch."
  );
  if (/press/.test(name) && /incline|bench|db|dumbbell/.test(name)) return line(
    "Shoulder blades tucked, feet steady, elbows about 30-45 degrees from the body.",
    "Control the stretch, then press without letting the shoulders roll forward.",
    "Chest and triceps, not the front of the shoulder."
  );
  if (/lateral raise/.test(name)) return line(
    "Use a light load, slight lean, soft elbows.",
    "Lead with the elbows to shoulder height, pause briefly, then lower slowly.",
    "Side delts. If traps take over, go lighter."
  );
  if (/face pull|rear delt/.test(name)) return line(
    "Cable set high, light load, ribs down.",
    "Pull toward eye level with high elbows and rotate the hands back.",
    "Rear delts and upper back, not neck tension."
  );
  if (/curl/.test(name)) return line(
    "Elbows pinned near the ribs, wrists quiet.",
    "Curl without swinging, squeeze, then lower all the way under control.",
    "Biceps or forearms, depending on grip."
  );
  if (/triceps|pushdown|extension/.test(name)) return line(
    "Elbows stay fixed; shoulders stay out of it.",
    "Extend to a strong squeeze, then return until the triceps stretch.",
    "Triceps, with no elbow pain."
  );
  if (/calf/.test(name)) return line(
    "Use the full foot on the platform with knees tracking over toes.",
    "Sink into a deep stretch, pause, rise high, and pause again.",
    "Calves through the full range, no bouncing."
  );
  if (/leg extension/.test(name)) return line(
    "Seat set so the knee lines up with the machine pivot.",
    "Lift smoothly, pause near lockout, then lower without the stack bouncing.",
    "Quads, especially near the knee, without joint irritation."
  );
  if (/leg curl/.test(name)) return line(
    "Hips pinned down and knees lined up with the machine pivot.",
    "Curl to a hard squeeze, then take the eccentric slowly.",
    "Hamstrings, not hips lifting off the pad."
  );

  return line(
    "Pick a load you can control through the full comfortable range.",
    "Move deliberately, pause where the target muscle is working, and keep the reps repeatable.",
    "The target muscle should work more than joints or momentum."
  );
}

function exerciseExplanationHtml(d, explanation) {
  const ex = explanation || exerciseExplanation(d);
  if (!ex) return "";
  const rows = [
    ["Set up", ex.setup],
    ["Move", ex.move],
    ["Feel", ex.feel],
    ["Avoid", ex.avoid],
  ].filter(([, text]) => text);
  return `<div class="detail-section ex-explain" data-exercise-explain data-exercise="${escAttr(d?.name || "")}">
      <div class="lbl">How to do it</div>
      ${rows.map(([label, text]) => `<div class="explain-row"><span>${escHtml(label)}</span><p>${escHtml(text)}</p></div>`).join("")}
    </div>`;
}

const exerciseExplainMisses = new Set();

function validExerciseExplanationPayload(r) {
  return !!(r && r.ok && r.explanation && r.explanation.setup && r.explanation.move && r.explanation.feel);
}

function replaceExerciseExplanation(el, d, explanation) {
  const current = el.querySelector("[data-exercise-explain]");
  if (!current || current.dataset.exercise !== String(d?.name || "")) return;
  const wrap = document.createElement("template");
  wrap.innerHTML = exerciseExplanationHtml(d, explanation).trim();
  const next = wrap.content.firstElementChild;
  if (next) current.replaceWith(next);
}

async function hydrateExerciseExplanation(el, d) {
  const key = String(d?.name || "");
  if (!key || exerciseExplainMisses.has(key)) return;
  try {
    const cached = await api("/exercise/" + encodeURIComponent(key) + "/explanation");
    if (validExerciseExplanationPayload(cached)) {
      replaceExerciseExplanation(el, d, cached.explanation);
      if (!cached.stale) return;
    }
  } catch {
    return;
  }
  try {
    const generated = await api("/exercise/" + encodeURIComponent(key) + "/explanation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "auto" }),
    });
    if (validExerciseExplanationPayload(generated)) {
      replaceExerciseExplanation(el, d, generated.explanation);
    } else {
      exerciseExplainMisses.add(key);
    }
  } catch {
    exerciseExplainMisses.add(key);
  }
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
      ${exerciseExplanationHtml(d)}
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
    hydrateExerciseExplanation(el, d);
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
// Energy Balance (TDEE + the nutrition check-in) lives in Plan → Food with the
// logged-day journal, so it is no longer an orphaned Progress pill. Progress stays
// training-history focused.
const PROGRESS_SEG = [["sessions", "History"], ["trend", "1RM"], ["volume", "Volume"], ["endurance", "Endurance"], ["weight", "Weight"], ["calendar", "Calendar"], ["program", "Program"]];
const PROGRESS_HANDLERS = { trend: () => renderProgress(), volume: () => renderVolume(), endurance: () => renderEndurance(), weight: () => renderWeight(), calendar: () => renderCalendar(), sessions: () => renderHistory(), program: () => renderProgram() };
// The Plan sub-nav is dynamic: a runner/hybrid (or anyone with an endurance goal)
// gets a dedicated ENDURANCE tab — the home for the periodized ramp, this week's
// prescribed runs, and shaping the running plan. A pure strength athlete with no
// running goal never sees it (calm, no empty surface).
function planSeg() {
  return showEnduranceTab()
    ? [["edit", "Training"], ["endurance", "Endurance"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]]
    : [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]];
}
const PLAN_HANDLERS = { edit: () => renderPlanEditor(), endurance: () => renderPlanEndurance(), food: () => renderFoodJournal(), meals: () => renderMeals(), coach: () => renderCoach() };

function escHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ─── The conductor: one sequenced whole-athlete focus card ──────────────────
// Shared renderer for GET /api/coaching-focus — the cross-domain analog of the
// health focus. It speaks as ONE coach: a headline through-line, the single
// highest-leverage LEAD (sage-spined hero), the few things handled alongside,
// what's explicitly deferred, the plain cross-domain ties, and ONE batched
// re-test. Constitution: a coach's note, never a metrics wall — no scores.
// Returns "" when there's nothing trustworthy to lead with, so any surface can
// inject it unconditionally and degrade to its existing content.
// Domains: training | running | nutrition | health | recovery | body.
const CFOCUS_DOMAIN_LABEL = {
  training: "Training", running: "Running", nutrition: "Nutrition",
  health: "Health", recovery: "Recovery", body: "Body",
};
function cfocusDomainTag(domain) {
  const label = CFOCUS_DOMAIN_LABEL[domain] || "";
  return label ? `<span class="cfocus-dom lbl">${escHtml(label)}</span>` : "";
}
function coachingFocusCardHtml(focus) {
  if (!focus || !focus.available || !focus.lead) return "";
  const lead = focus.lead;
  const parallel = Array.isArray(focus.parallel) ? focus.parallel.filter(Boolean) : [];
  const later = Array.isArray(focus.later) ? focus.later.filter((l) => l && l.title) : [];
  const connections = Array.isArray(focus.connections) ? focus.connections.filter(Boolean) : [];
  const retest = focus.retest;

  let h = `<div class="cfocus settle-in">`;
  h += `<span class="cfocus-mast lbl">Where to focus</span>`;
  if (focus.headline) h += `<p class="cfocus-headline">${escHtml(focus.headline)}</p>`;

  // The lead — the single highest-leverage lever, the hero line. Tappable: it
  // routes to where the work actually happens (training → Program, running →
  // Endurance, …) so the read is a launchpad into the plan, not a dead overview.
  h += `<div class="cfocus-lead cfocus-go" data-cfocus-go="${escAttr(lead.domain || "")}" role="link" tabindex="0">`;
  h += `<div class="cfocus-lead-top">${cfocusDomainTag(lead.domain)}<h3 class="cfocus-lead-title">${escHtml(lead.title || "")}</h3><span class="cfocus-go-arrow" aria-hidden="true">→</span></div>`;
  if (lead.why) h += `<p class="cfocus-lead-why">${escHtml(lead.why)}</p>`;
  if (lead.move) h += `<p class="cfocus-lead-move"><span class="lbl">Move</span>${escHtml(lead.move)}</p>`;
  h += `</div>`;

  // Alongside — the parallel levers, compact lines tagged with their domain, each
  // tapping through to its own surface.
  if (parallel.length) {
    h += `<div class="cfocus-along"><span class="cfocus-sec-lbl lbl">Alongside</span>`;
    for (const p of parallel) {
      h += `<div class="cfocus-along-row cfocus-go" data-cfocus-go="${escAttr(p.domain || "")}" role="link" tabindex="0">${cfocusDomainTag(p.domain)}`;
      h += `<span class="cfocus-along-title">${escHtml(p.title || "")}</span>`;
      h += `<span class="cfocus-go-arrow" aria-hidden="true">→</span>`;
      if (p.why) h += `<span class="cfocus-along-why">${escHtml(p.why)}</span>`;
      if (p.move) h += `<span class="cfocus-along-move">${escHtml(p.move)}</span>`;
      h += `</div>`;
    }
    h += `</div>`;
  }

  // Later — the deferred sequence, one calm line.
  if (later.length) {
    h += `<p class="cfocus-later"><span class="cfocus-later-lbl">Next:</span> ${later.map((l) => escHtml(l.title)).join(" · ")}</p>`;
  }

  // The cross-domain ties — plain italic.
  for (const c of connections) {
    h += `<p class="cfocus-conn">${escHtml(c)}</p>`;
  }

  // One batched re-test — the single check-in, not four nag feeds.
  if (retest && Array.isArray(retest.focus) && retest.focus.length) {
    const when = (typeof retest.in_weeks === "number" && retest.in_weeks > 0)
      ? `~${retest.in_weeks} week${retest.in_weeks === 1 ? "" : "s"}`
      : "due now";
    h += `<div class="cfocus-retest cfocus-go" data-cfocus-go="program" role="link" tabindex="0"><span class="cfocus-retest-lbl lbl">Next check-in</span>`;
    h += `<span class="cfocus-retest-body">${escHtml(retest.focus.join(" · "))} <span class="cfocus-retest-when">${escHtml(when)}</span></span>`;
    if (retest.why) h += `<span class="cfocus-retest-why">${escHtml(retest.why)}</span>`;
    h += `</div>`;
  }

  h += `</div>`;
  return h;
}

// Fetch + inject the conductor into a slot. Mirrors the other Today loaders:
// its own try/catch, clears the slot when unavailable, never throws. The slot
// is found via querySelector (defaults to the document, but pass `root` to scope
// to a freshly-rendered view). Safe to call unconditionally on any surface.
async function loadCoachingFocus(slotSelector, root) {
  const scope = root || view || document;
  const slot = scope.querySelector ? scope.querySelector(slotSelector) : null;
  if (!slot) return;
  let focus = null;
  try { focus = await api("/coaching-focus"); } catch { focus = null; }
  if (!slot.isConnected) return;
  const html = coachingFocusCardHtml(focus);
  slot.innerHTML = html; // "" cleanly clears the slot when unavailable
  // On the Standing review, the conductor IS the lead — drop the health "one lever"
  // section so the two don't compete (loadHealthStanding does the mirror suppression
  // when it paints after this; this handles the conductor-lands-second order).
  if (html && slot.id === "cfocusStandingSlot") (scope.querySelector ? scope : document).querySelector(".hstand-lever")?.remove();
}

// The Today form of the conductor: ONE calm line, not the full analytics card.
// Today answers "what do I do now"; the multi-week focus is a review that lives
// on Me → Standing, so here we surface only the lead as a tappable thread that
// opens the full card. Returns "" when there's nothing to lead with.
function coachingFocusThreadHtml(focus) {
  if (!focus || !focus.available || !focus.lead) return "";
  const title = focus.lead.title || "";
  if (!title) return "";
  return `<button class="cfocus-thread" type="button" data-cfocus-go="me-standing">
    <span class="cfocus-thread-arrow" aria-hidden="true">↳</span>
    <span class="cfocus-thread-lbl lbl">Focus now</span>
    <span class="cfocus-thread-txt">${escHtml(title)}</span>
    <span class="cfocus-thread-go" aria-hidden="true">→</span>
  </button>`;
}

// Route a focus-card tap to where that work actually happens. A bare domain
// token maps to its planning surface; explicit tokens ("me-standing","program")
// are honored verbatim. Globals (state, activateTab) resolve at call time.
function cfocusRoute(go) {
  switch (go) {
    case "me-standing": state.meSeg = "standing"; activateTab("me"); break;
    case "running": case "endurance":
      state.progressSeg = "endurance"; activateTab("progress"); break;
    case "nutrition": case "meals": case "body":
      state.planJump = "meals"; activateTab("plan"); break;
    case "health": case "markers":
      state.meSeg = "health"; state.healthSeg = "markers"; state.healthSegPicked = true; activateTab("me"); break;
    // training | recovery | program | anything else → the Program / periodization view
    default:
      state.progressSeg = "program"; activateTab("progress"); break;
  }
}
// ONE delegated listener for every [data-cfocus-go] across the focus card +
// thread, wherever they're injected — no per-render wiring. Enter/Space mirror
// the click for the role="link" rows.
document.addEventListener("click", (e) => {
  const el = e.target.closest && e.target.closest("[data-cfocus-go]");
  if (el) cfocusRoute(el.dataset.cfocusGo);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target.closest && e.target.closest('[data-cfocus-go][role="link"]');
  if (el) { e.preventDefault(); cfocusRoute(el.dataset.cfocusGo); }
});

// PWA / phone coach helpers (loaded early; used by Today + Settings)
// We capture Chromium's beforeinstallprompt the moment it fires so the Today coach
// can offer a REAL one-tap install on platforms that support it (desktop Chrome/Edge,
// Android), and fall back to honest, platform-correct manual steps everywhere else —
// never iOS "Share → Add to Home Screen" copy on a desktop browser that can't do that.
let deferredInstallPrompt = null;
try {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();          // suppress the browser's own mini-infobar; we drive the prompt
    deferredInstallPrompt = e;
    refreshPhoneCoach();         // upgrade an already-shown banner to the one-tap Install path
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    try { localStorage.setItem("cairn_phone_coach_dismissed", "1"); } catch {}
    document.querySelectorAll(".phone-coach").forEach((el) => el.remove());
  });
} catch {}

function isStandalonePWA() {
  try {
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
    if (navigator.standalone) return true;
  } catch {}
  return false;
}

// Detect what THIS device/browser can actually do about installing, so the coach
// shows the right steps (or stays quiet). Returns a mode, or null when there's no
// actionable install path here (e.g. desktop Firefox).
function getInstallGuidance() {
  if (isStandalonePWA()) return null;                   // already installed
  if (deferredInstallPrompt) return { mode: "prompt" }; // Chromium desktop/Android: real one-tap install
  const ua = navigator.userAgent || "";
  const maxTouch = navigator.maxTouchPoints || 0;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouch > 1); // iPadOS poses as Mac
  const isAndroid = /Android/.test(ua);
  const isChromium = /\b(Chrome|Chromium|CriOS|Edg|EdgA|OPR|SamsungBrowser)\b/.test(ua);
  const isMacSafari = /Macintosh/.test(ua) && maxTouch === 0 && /Version\/.+Safari/.test(ua) && !isChromium;
  if (isIOS) return { mode: "ios" };                    // iOS/iPadOS Safari (or Chrome-on-iOS — same WebKit)
  if (isMacSafari) return { mode: "safari-desktop" };   // macOS Safari 17+: File → Add to Dock
  if (isChromium) return { mode: "chromium-menu" };     // Chromium, prompt not (yet) available → menu/address bar
  if (isAndroid) return { mode: "menu-generic" };       // e.g. Firefox Android → browser menu
  return null;                                          // desktop Firefox & friends: no install path → stay quiet
}

// Per-mode markup. Honest about what an install does — a faster shell; data still lives
// on the Cairn server (the constitution forbids a fake offline brain).
function phoneCoachContent(mode) {
  const dismiss = `<button class="ghostbtn phone-coach-dismiss" type="button">Got it</button>`;
  if (mode === "prompt") {
    return `
      <div class="sess-line"><b>Install Cairn as an app</b> — it opens in its own window, instantly.</div>
      <div class="sess-line phone-coach-sub">Your training data still lives on your Cairn server; the app is just a faster shell.</div>
      <div class="phone-coach-actions">
        <button class="phone-coach-install" type="button">Install Cairn</button>
        ${dismiss}
      </div>`;
  }
  if (mode === "ios") {
    return `
      <div class="sess-line"><b>Add Cairn to your home screen</b> — it opens like a real app, instantly.</div>
      <div class="sess-line phone-coach-sub">
        Tap <b>Share</b> → <b>Add to Home Screen</b>. HTTPS (Tailscale Serve) works best on iOS.
        Logging and a fresh Brief still need your Cairn server reachable.
      </div>
      <div class="phone-coach-actions">${dismiss}</div>`;
  }
  if (mode === "safari-desktop") {
    return `
      <div class="sess-line"><b>Add Cairn to your Dock</b> — it opens in its own window.</div>
      <div class="sess-line phone-coach-sub">In Safari: <b>File</b> → <b>Add to Dock</b>.</div>
      <div class="phone-coach-actions">${dismiss}</div>`;
  }
  if (mode === "menu-generic") {
    return `
      <div class="sess-line"><b>Add Cairn to your home screen</b> — it opens like a real app.</div>
      <div class="sess-line phone-coach-sub">
        Open your browser menu → <b>Install</b> / <b>Add to Home Screen</b>.
        Logging and a fresh Brief still need your Cairn server reachable.
      </div>
      <div class="phone-coach-actions">${dismiss}</div>`;
  }
  // chromium-menu
  return `
    <div class="sess-line"><b>Install Cairn as an app</b> — it opens in its own window.</div>
    <div class="sess-line phone-coach-sub">Click the install icon in the address bar, or your browser menu → <b>Install Cairn</b>.</div>
    <div class="phone-coach-actions">${dismiss}</div>`;
}

// Wire the dismiss-forever button + the one-tap Install (where the prompt is available).
function wirePhoneCoach(el) {
  const dismissBtn = el.querySelector(".phone-coach-dismiss");
  if (dismissBtn) dismissBtn.addEventListener("click", () => {
    try { localStorage.setItem("cairn_phone_coach_dismissed", "1"); } catch {}
    el.remove();
  });
  const installBtn = el.querySelector(".phone-coach-install");
  if (installBtn) installBtn.addEventListener("click", async () => {
    const prompt = deferredInstallPrompt;
    if (!prompt) { refreshPhoneCoach(); return; }       // raced away → re-render with manual steps
    installBtn.disabled = true;
    try {
      prompt.prompt();
      await prompt.userChoice;                           // { outcome: 'accepted' | 'dismissed' }
    } catch {}
    deferredInstallPrompt = null;                        // a deferred prompt can only be used once
    // Accepted → appinstalled removes the banner. Dismissed → fall back to manual steps.
    if (document.body.contains(el)) refreshPhoneCoach();
  });
}

function renderPhoneCoachBanner(container) {
  if (!container || isStandalonePWA()) return;
  if (localStorage.getItem("cairn_phone_coach_dismissed") === "1") return;
  if (container.querySelector(".phone-coach")) return; // idempotent across warm re-renders
  const guidance = getInstallGuidance();
  if (!guidance) return;                                // nothing actionable on this platform → stay quiet
  const el = document.createElement("div");
  el.className = "sess phone-coach";
  el.dataset.coachMode = guidance.mode;
  el.innerHTML = phoneCoachContent(guidance.mode);
  wirePhoneCoach(el);
  container.append(el);
}

// beforeinstallprompt often arrives AFTER Today first paints (the common race), and a
// used/declined prompt changes the right copy too — so re-fill any visible banner to match.
function refreshPhoneCoach() {
  try {
    document.querySelectorAll(".phone-coach").forEach((el) => {
      if (isStandalonePWA() || localStorage.getItem("cairn_phone_coach_dismissed") === "1") { el.remove(); return; }
      const guidance = getInstallGuidance();
      if (!guidance) { el.remove(); return; }
      if (el.dataset.coachMode === guidance.mode) return; // already correct
      el.dataset.coachMode = guidance.mode;
      el.innerHTML = phoneCoachContent(guidance.mode);
      wirePhoneCoach(el);
    });
  } catch {}
}
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
  proposal: ["Reading your training…", "Weighing your recent sessions…", "Drafting next week's targets…", "Keeping the progression honest…"],
  endurance_runs: ["Reading your running…", "Checking your mileage and goal…", "Shaping this week's runs…", "Keeping it aerobic and conservative…"],
  meal_plan: ["Reading your week…", "Balancing the macros…", "Plating the days…", "Checking the protein floor…"],
  meal_swap: ["Reading the meal…", "Finding a match…", "Holding the macros…", "Plating the swap…"],
  recipe: ["Opening the kitchen…", "Sourcing the ingredients…", "Writing the steps…", "Tasting as it goes…"],
  nutrition_checkin: ["Reading your intake…", "Tracing the trend…", "Weighing the drift…", "Settling on a number…"],
  day_read_override: ["Hearing you…", "Re-reading the day…", "Reshaping the brief…"],
  chat_distill: ["Looking back over the thread…", "Keeping what matters…", "Tidying the rest away…"],
  onboard: ["Hearing you out…", "Folding it into your picture…", "Noting what matters…", "Setting things up…"],
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

// Primary training discipline ('strength'|'endurance'|'hybrid'), read once from the
// profile and used for a GENTLE emphasis reframe — never to hide a surface. Default
// 'strength' so a profile that never set it behaves exactly as before. Refreshed by
// the profile loader (renderToday/renderMeProfile) and on a profile save.
let primaryDiscipline = "strength";
function setDiscipline(d) {
  primaryDiscipline = d === "endurance" || d === "hybrid" ? d : "strength";
  return primaryDiscipline;
}
const isEndurance = () => primaryDiscipline === "endurance";
const isHybrid = () => primaryDiscipline === "hybrid";

// Whether the athlete has an endurance OBJECTIVE on file (a race or a standing
// readiness target). Primed from the profile alongside the discipline (warm-load +
// on save). Used to surface the Plan → Endurance tab even when the discipline label
// is 'strength' — setting a running goal is a clear signal you want a running plan.
let enduranceGoalSet = false;
function setEnduranceGoalSet(present) { enduranceGoalSet = !!present; return enduranceGoalSet; }
// A runner home is warranted when the athlete trains endurance OR has set a goal.
const showEnduranceTab = () => isEndurance() || isHybrid() || enduranceGoalSet;

// ---------- endurance formatting (min/km pace, distance, plain-word trend) ----------
// All null-safe. Pace is min/km → "m:ss/km". Never a score, never a grade.
function fmtPaceKm(minPerKm) {
  const v = Number(minPerKm);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const m = Math.floor(v);
  const s = Math.round((v - m) * 60);
  // 60s rounding carry
  const mm = s === 60 ? m + 1 : m;
  const ss = s === 60 ? 0 : s;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
function fmtKm(km) {
  const v = Number(km);
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}
// Speed in km/h (the metric riders read, the counterpart to a runner's min/km).
// Null-safe, one decimal. Never a score.
function fmtSpeedKmh(kmh) {
  const v = Number(kmh);
  if (!Number.isFinite(v) || v <= 0) return "—";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}
// Human label for a standard PR distance (1/5/10/half/full + anything else).
function prDistLabel(km) {
  const v = Number(km);
  if (Math.abs(v - 21.0975) < 0.01) return "Half";
  if (Math.abs(v - 42.195) < 0.01) return "Full";
  return `${fmtKm(v)} km`;
}

// ---------- planned cardio (kind:'cardio') shared rendering ----------
// A cardio plan item carries an endurance prescription (no loaded exercise). Its
// label rides in `note`; the structured interval is JSON server-side. These helpers
// are shared by the Plan view, the Plan editor, and Today's session surface.
const isCardioItem = (it) => it && it.kind === "cardio";
// Pull a plain-text interval note out of the structured interval blob. The run
// engine now emits a STRUCTURED array — [{reps,on,off,zone}] — so we collapse that
// to a compact "6 × 800m" note for the label/sport sniffers; we still tolerate the
// legacy {note} object or a bare string.
function cardioIntervalNote(interval) {
  if (interval == null) return "";
  if (typeof interval === "string") return interval.trim();
  if (Array.isArray(interval)) {
    return interval
      .map((s) => (s && s.reps != null && s.on ? `${Number(s.reps)} × ${String(s.on).trim()}` : (s && s.on ? String(s.on).trim() : "")))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof interval === "object" && typeof interval.note === "string") return interval.note.trim();
  return "";
}
// Render a STRUCTURED interval block as a plain prescription:
//   [{reps:6, on:"800m", off:"90s", zone:"Z5"}] → "6 × 800m @ Z5 (165–175 bpm), 90s jog"
// The per-segment zone is upgraded to the bpm-bearing band when `target_zone` names
// the same zone (e.g. "Z5 (165-175 bpm)"), so the runner sees the pulse target right
// on the rep line. A bare `off` like "90s" reads as "90s jog" (the easy recovery).
// "" for a non-array / empty interval. Never a score — a concrete prescription.
function cardioIntervalStructure(interval, targetZone) {
  if (!Array.isArray(interval) || !interval.length) return "";
  const tz = String(targetZone || "").trim();
  const tzZone = (tz.match(/^\s*(Z[1-5])\b/i) || [])[1];
  const tzBand = tzZone ? tz : ""; // the full bpm-bearing string when it leads with one zone
  const segs = interval.map((seg) => {
    if (!seg || typeof seg !== "object") return "";
    const on = String(seg.on || "").trim();
    if (!on) return "";
    const reps = seg.reps != null ? Number(seg.reps) : null;
    let zone = String(seg.zone || "").trim().toUpperCase();
    if (zone && tzZone && zone === String(tzZone).toUpperCase() && tzBand) zone = tzBand; // upgrade to bpm band
    const head = reps != null && reps > 0 ? `${reps} × ${on}` : on;
    let s = zone ? `${head} @ ${zone}` : head;
    const off = String(seg.off || "").trim();
    if (off) s += `, ${/^\d+\s*(s|sec|secs|m|min|mins)?$/i.test(off) ? `${off} jog` : off}`;
    return s;
  }).filter(Boolean);
  return segs.join("; ");
}
// A phrase to feed CairnArt.activity / artImg for a cardio item — its label text
// (which keyword-maps to run/ride/swim/row in art.js), falling back to "run".
function cardioArtPhrase(it) {
  const label = (it.note || "").trim();
  return label || "run";
}
// A cardio item's `note` is MEANT to be a short title ("Long run", "Easy ride") — but
// a coach sometimes writes a whole guidance sentence into it ("Nasal-breathing pace.
// Watch the ~3rd-km dip…"). That prose belongs in the card's description, never crammed
// into the head. This draws the line: long, many-worded, or sentence-punctuated reads
// as prose, not a title. (The `[.!?]\s` guard needs a space after the stop, so a decimal
// like "3.5 km" never counts as a sentence.)
function cardioNoteIsDescriptive(note) {
  const n = String(note || "").trim();
  if (!n) return false;
  return n.length > 38 || n.split(/\s+/).length > 7 || /[.!?]\s/.test(n);
}
// The sport behind a cardio item, sniffed from its note/interval text — run / ride /
// swim / row, defaulting to "run" (endurance plans are predominantly running). Only used
// to build a clean derived label; matching + log copy stay lenient via cardioVerb.
function cardioSport(it) {
  const text = `${it.note || ""} ${cardioIntervalNote(it.interval) || it.interval_note || ""}`.toLowerCase();
  if (/ride|bike|cycl|spin/.test(text)) return "ride";
  if (/swim/.test(text)) return "swim";
  if (/\brow|erg\b/.test(text)) return "row";
  return "run";
}
// A short, scannable label derived from the prescription when the note can't serve as a
// title — intensity (zone first, else a note/distance cue) + sport: "Easy run", "Tempo
// ride", "Long run", "Run intervals".
function derivedCardioLabel(it) {
  const sport = cardioSport(it);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const ivl = (cardioIntervalNote(it.interval) || it.interval_note || "").toLowerCase();
  const zone = String(it.target_zone || "").toLowerCase();
  const blob = `${it.note || ""} ${zone}`.toLowerCase();
  if (/interval|fartlek|\d\s*[×x]\s*\d/.test(`${ivl} ${blob}`)) return `${cap(sport)} intervals`;
  const km = it.target_distance_km != null ? Number(it.target_distance_km) : null;
  let mood = "";
  if (/tempo|threshold|z3|z4|z5/.test(zone)) mood = "Tempo";
  else if (/easy|recovery|z1|z2/.test(zone)) mood = "Easy";
  else if (/tempo|threshold|hard|fast/.test(blob)) mood = "Tempo";
  else if (/easy|relaxed|nasal|recovery|shakeout/.test(blob)) mood = "Easy";
  else if (km != null && km >= 12) mood = "Long";
  return mood ? `${mood} ${sport}` : cap(sport);
}
// The label (card head) for a cardio item: its note when that reads as a short title,
// otherwise a clean derived label — the prose note then rides in cardioDescription.
function cardioLabel(it) {
  const note = (it.note || "").trim();
  if (note && !cardioNoteIsDescriptive(note)) return note;
  if (note) return derivedCardioLabel(it);
  if (it.target_distance_km != null && Number(it.target_distance_km) >= 12) return "Long run";
  return "Cardio";
}
// The descriptive subtext for a cardio item — the coach's guidance sentence, surfaced
// only when it was displaced from the head (a long prose note). "" for a titley note, so
// the head label already says everything (no duplicate line under it).
function cardioDescription(it) {
  const note = (it.note || "").trim();
  return cardioNoteIsDescriptive(note) ? note : "";
}
// The prescription line: "12 km · Z2 (120–135 bpm)", "45 min · Z3", "8 km · 6 × 800m
// @ Z5 (165–175 bpm), 90s jog". Distance preferred; duration when no distance. When a
// structured interval is present it carries the zone+bpm itself (so we don't also
// append the bare zone); otherwise the bpm-bearing `target_zone` + any legacy note.
function cardioPrescription(it) {
  const bits = [];
  if (it.target_distance_km != null) bits.push(`${fmtKm(it.target_distance_km)} km`);
  else if (it.target_duration_min != null) bits.push(`${Math.round(Number(it.target_duration_min))} min`);
  const structure = cardioIntervalStructure(it.interval, it.target_zone);
  if (structure) {
    bits.push(structure);
  } else {
    if (it.target_zone) bits.push(String(it.target_zone));
    const ivl = cardioIntervalNote(it.interval) || it.interval_note;
    if (ivl) bits.push(ivl);
  }
  return bits.join(" · ");
}

// ---------- art readiness (instant, flash-free rendering of generated images) ----------
// Generated art is content-keyed + immutable on the server, so once we know an
// image exists we can render it IMMEDIATELY — eager, no fade, photo straight over
// the SVG — instead of starting from the wire placeholder every render. We track
// which "kind|query" tokens are ready in `artReady`, hydrated from three sources:
//   • localStorage  — every image this client has ever loaded (instant, at module load)
//   • /api/art/manifest — what the server already has on disk (covers a cold client)
//   • a live onload — anything generated after the page opened
// Keyed token-free (no auth token / retry param) so it survives token rotation.
const artReady = new Set();
const artKey = (kind, q) => `${kind}|${String(q || "").trim().slice(0, 120)}`;
const ART_READY_LS = "cairn-art-ready";
let _artReadyTimer = 0;
function persistArtReady() {
  clearTimeout(_artReadyTimer);
  _artReadyTimer = setTimeout(() => {
    // Cap so it can't grow unbounded; keep the most recently-added tokens.
    try { localStorage.setItem(ART_READY_LS, JSON.stringify([...artReady].slice(-3000))); } catch {}
  }, 600);
}
function markArtReady(token) {
  if (token && !artReady.has(token)) { artReady.add(token); persistArtReady(); }
}
(function loadArtReady() {
  try { JSON.parse(localStorage.getItem(ART_READY_LS) || "[]").forEach((k) => artReady.add(k)); } catch {}
})();
// Prime from the server's on-disk manifest — makes a cold client (cleared cache,
// new browser) render already-generated art instantly instead of re-flashing the
// wire on its first paint. Fire-and-forget at boot; failures are silent.
async function primeArtManifest() {
  try {
    const m = await api("/art/manifest");
    if (m && "enabled" in m) artEnabled = !!m.enabled;
    if (m && Array.isArray(m.ready) && m.ready.length) {
      m.ready.forEach((k) => artReady.add(k));
      persistArtReady();
    }
  } catch {}
}

window._artOk = (img) => {
  img.classList.add("on");
  markArtReady(img.dataset.artkey); // remember for instant render next time
};
window._artErr = (img) => {
  // Drop BOTH reveal classes — `.instant` also forces opacity:1, so leaving it on
  // would keep a failed image visible instead of falling back to the SVG beneath.
  img.classList.remove("on", "instant");
  // A token we promised was ready didn't load (server cache cleared, file gone) —
  // forget it so we stop rendering it eager and fall back to the SVG cleanly.
  const k = img.dataset.artkey;
  if (k && artReady.has(k)) { artReady.delete(k); persistArtReady(); }
  if (img.dataset.retried) return; // one quiet retry only
  img.dataset.retried = "1";
  const token = pollToken;
  setTimeout(() => {
    if (token !== pollToken || !img.isConnected) return; // stale tab / re-render — bail
    img.src = img.src.includes("&r=") ? img.src : img.src + "&r=1";
  }, 20000);
};

// Art tile that renders the generated studio photo over a CairnArt SVG. `svg` may
// be passed (exercise art needs muscleGroup); defaults to art(kind, q). Falls back
// to SVG-only when artwork generation is off.
//   • Known-ready (cache/manifest/seen) → eager, no fade — the photo is served
//     instantly from the SW/HTTP cache, so it paints over the SVG with no flash.
//   • Unknown → lazy, fades in on first load, then remembered for next time.
function artImg(kind, q, cls = "artile-md", svg = null) {
  const s = svg != null ? svg : art(kind, q);
  if (!s) return "";
  const query = String(q || "").trim().slice(0, 120);
  if (!artEnabled || !query) return `<div class="artile ${cls}">${s}</div>`;
  const token = artKey(kind, query);
  const src = withToken(`/api/art?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}`);
  const ready = artReady.has(token);
  const imgCls = ready ? "artimg-photo on instant" : "artimg-photo";
  const load = ready ? "eager" : "lazy";
  return `<div class="artile artimg ${cls}">${s}<img class="${imgCls}" alt="${escAttr(query)}" loading="${load}" decoding="async" data-artkey="${escAttr(token)}" src="${escAttr(src)}" onload="_artOk(this)" onerror="_artErr(this)"></div>`;
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
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="currentColor"/>
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

// Status badge: a quiet spinner ONLY while the coach is still refining a just-logged
// entry. Once it settles there's NO permanent tag — the refined entry itself is the
// result, and the capture toast already confirmed the log at the moment of action.
// (A persistent "✦ noted" used to sit on every entry forever; that was pure noise.)
function enrichBadge(status) {
  if (enrichmentActive(status)) return `<span class="enr enr-pending">enriching...</span>`;
  return ""; // done / skipped / failed / undefined -> no lingering tag
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

// ---------- in-app agent-login terminal (xterm over a WebSocket PTY) ----------
// Some coaching CLIs (Claude Code, Codex, Grok, …) authenticate with an
// interactive device login: they print a URL + code, you authorize in a browser,
// they finish. This modal pipes that interactive subprocess to the device over a
// WebSocket and renders it with xterm.js (vendored, UMD globals `Terminal` and
// `FitAddon.FitAddon`). One login runs server-side at a time. Self-contained and
// global so Settings can launch it: `openAgentLoginModal("claude")`.
//
// Styling lives in a JS-injected <style> (this module can't touch styles.css);
// the chrome harmonizes with the Atelier palette, the terminal panel is a calm
// dark slate. The vendored assets load lazily on first open (one cached promise).

let _xtermAssets = null; // Promise<void>, resolved once xterm + fit addon are loaded
function loadXtermAssets() {
  if (_xtermAssets) return _xtermAssets;
  _xtermAssets = new Promise((resolve, reject) => {
    try {
      if (!document.querySelector('link[data-xterm-css]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/vendor/xterm.css";
        link.setAttribute("data-xterm-css", "1");
        document.head.appendChild(link);
      }
      // Already present (e.g. a second open before the first resolved)?
      if (window.Terminal && window.FitAddon) { resolve(); return; }
      // the fit addon's UMD references the core, so always load core first
      const loadScript = (src) => new Promise((res, rej) => {
        let el = document.querySelector(`script[data-xterm-src="${src}"]`);
        if (el) { el.addEventListener("load", () => res()); el.addEventListener("error", () => rej(new Error("load " + src))); if (el.dataset.loaded) res(); return; }
        el = document.createElement("script");
        el.src = src;
        el.async = false;
        el.setAttribute("data-xterm-src", src);
        el.addEventListener("load", () => { el.dataset.loaded = "1"; res(); });
        el.addEventListener("error", () => rej(new Error("load " + src)));
        document.head.appendChild(el);
      });
      // core then addon, in order
      loadScript("/vendor/xterm.js")
        .then(() => loadScript("/vendor/xterm-addon-fit.js"))
        .then(() => resolve())
        .catch(reject);
    } catch (e) { reject(e); }
  });
  return _xtermAssets;
}

// Inject the modal + terminal chrome once. Kept out of styles.css on purpose
// (another stream owns that file); scoped under .agent-login-* so it's inert
// until a modal mounts.
function ensureAgentLoginStyles() {
  if (document.getElementById("agent-login-styles")) return;
  const s = document.createElement("style");
  s.id = "agent-login-styles";
  s.textContent = `
.agent-login-ov{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
  padding:max(env(safe-area-inset-top),18px) 16px max(env(safe-area-inset-bottom),18px);
  background:rgba(33,29,23,.46);backdrop-filter:saturate(1.1) blur(2px);
  animation:agentLoginFade .16s ease both}
@keyframes agentLoginFade{from{opacity:0}to{opacity:1}}
.agent-login{width:min(720px,100%);max-height:100%;display:flex;flex-direction:column;
  background:var(--card,#fffdf8);color:var(--ink,#211d17);border:1px solid var(--line,#e7dfd2);
  border-radius:var(--radius,18px);box-shadow:var(--shadow-lg,0 28px 64px rgba(0,0,0,.3));
  overflow:hidden;font-family:var(--font-ui,system-ui,sans-serif)}
.agent-login-hd{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line,#e7dfd2)}
.agent-login-hd h2{margin:0;font-family:var(--font-display,Georgia,serif);font-size:19px;font-weight:600;flex:1;line-height:1.2}
.agent-login-x{appearance:none;border:0;background:transparent;color:var(--muted,#746c5c);
  font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px}
.agent-login-x:hover{color:var(--ink,#211d17);background:var(--paper,#f4efe7)}
.agent-login-bd{padding:14px 16px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.agent-login-term{background:var(--stone-deep,#2c2620);border-radius:12px;padding:10px 8px 8px;
  border:1px solid var(--stone,#473f36);min-height:180px;height:clamp(180px,42vh,340px)}
.agent-login-term .xterm{padding:0}
.agent-login-status{font-size:13px;color:var(--muted,#746c5c);min-height:18px;display:flex;align-items:center;gap:6px}
.agent-login-status.is-ok{color:var(--sage,#6e7f5c);font-weight:600}
.agent-login-status.is-err{color:var(--accent,#b4552d);font-weight:600}
.agent-login-hint{font-size:12.5px;color:var(--muted,#746c5c);line-height:1.5;margin:0}
.agent-login-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
  background:var(--paper,#f4efe7);padding:1px 5px;border-radius:5px;border:1px solid var(--line,#e7dfd2)}
.agent-login-ft{display:flex;justify-content:flex-end;gap:10px;padding-top:2px}
.agent-login-btn{appearance:none;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;
  padding:9px 16px;border-radius:11px;border:1px solid var(--line,#e7dfd2);
  background:var(--paper,#f4efe7);color:var(--ink,#211d17)}
.agent-login-btn:hover{background:var(--card,#fffdf8)}
.agent-login-btn:focus-visible,.agent-login-x:focus-visible{outline:2px solid var(--accent,#b4552d);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.agent-login-ov{animation:none}}
`;
  document.head.appendChild(s);
}

// Tear down a mounted login modal: close the socket (kills the server session),
// dispose the terminal, drop window listeners, remove the overlay.
function closeAgentLoginModal(ov) {
  if (!ov || ov.dataset.closing) return;
  ov.dataset.closing = "1";
  try { ov._ws && ov._ws.close(); } catch {}
  try { ov._term && ov._term.dispose(); } catch {}
  try { window.removeEventListener("resize", ov._onResize); } catch {}
  try { document.removeEventListener("keydown", ov._onKey); } catch {}
  ov.remove();
}

// Open the interactive agent-login terminal for `agentName`.
async function openAgentLoginModal(agentName) {
  const name = String(agentName || "").trim();
  if (!name) return;
  ensureAgentLoginStyles();

  // Build the modal shell immediately (so a slow asset load still shows chrome).
  const ov = document.createElement("div");
  ov.className = "agent-login-ov";
  const grokNote = name.toLowerCase() === "grok"
    ? `<p class="agent-login-hint">Grok can also authenticate with an API key — set <code>XAI_API_KEY</code> in the server environment instead of this device login.</p>`
    : "";
  ov.innerHTML = `
    <div class="agent-login" role="dialog" aria-modal="true" aria-label="Connect ${escAttr(name)}">
      <div class="agent-login-hd">
        <h2>Connect ${escHtml(name)}</h2>
        <button class="agent-login-x" type="button" aria-label="Close">✕</button>
      </div>
      <div class="agent-login-bd">
        <div class="agent-login-status" role="status">Connecting…</div>
        <div class="agent-login-term"></div>
        ${grokNote}
        <p class="agent-login-hint">Follow the prompts. If a URL and a code appear, open the URL in your browser to authorize.</p>
        <div class="agent-login-ft">
          <button class="agent-login-btn" type="button" data-close>Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const statusEl = ov.querySelector(".agent-login-status");
  const termHost = ov.querySelector(".agent-login-term");
  const closeBtn = ov.querySelector(".agent-login-ft [data-close]");
  const setStatus = (text, cls) => {
    statusEl.textContent = text;
    statusEl.classList.remove("is-ok", "is-err");
    if (cls) statusEl.classList.add(cls);
  };
  const footer = ov.querySelector(".agent-login-ft");
  // On a failed/aborted login, keep the modal open so the terminal output stays
  // readable, turn Cancel into Close, and offer a one-tap retry (reopen).
  const markFailed = (msg) => {
    setStatus(msg, "is-err");
    ov._failed = true;
    if (closeBtn) closeBtn.textContent = "Close";
    if (footer && !footer.querySelector("[data-retry]")) {
      const r = document.createElement("button");
      r.className = "agent-login-btn"; r.type = "button"; r.dataset.retry = "1"; r.textContent = "Try again";
      r.addEventListener("click", () => { closeAgentLoginModal(ov); openAgentLoginModal(name); });
      footer.insertBefore(r, closeBtn);
    }
  };
  // Esc + the × and Cancel buttons all tear down (which closes the WS session). Tab
  // is trapped within the modal chrome so focus can't escape to the page behind
  // (the terminal owns Tab while focused, so this mainly guards the chrome buttons).
  ov._onKey = (e) => {
    if (e.key === "Escape") { closeAgentLoginModal(ov); return; }
    if (e.key !== "Tab") return;
    const f = [...ov.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
    if (f.length < 2) return;
    const first = f[0], last = f[f.length - 1], act = document.activeElement;
    if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", ov._onKey);
  ov.querySelector(".agent-login-x").addEventListener("click", () => closeAgentLoginModal(ov));
  closeBtn.addEventListener("click", () => closeAgentLoginModal(ov));

  // Load xterm + fit, then spin up the terminal and the socket.
  let Terminal, FitAddon;
  try {
    await loadXtermAssets();
    Terminal = window.Terminal;
    FitAddon = window.FitAddon && window.FitAddon.FitAddon;
    if (typeof Terminal !== "function" || typeof FitAddon !== "function") {
      throw new Error("terminal library unavailable");
    }
  } catch {
    setStatus("Couldn't load the terminal. Reload and try again.", "is-err");
    return;
  }
  if (!ov.isConnected) return; // closed while loading

  const term = new Terminal({
    convertEol: false,
    fontSize: 13,
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    theme: {
      // warm near-black from the brand mark (--stone-deep) — xterm needs a
      // literal, so this mirrors the CSS .agent-login-term surface above.
      background: "#2c2620",
      foreground: "#ece6da",
      cursor: "#d9b48a",
      selectionBackground: "#3a3733",
      black: "#2c2620", red: "#d2795a", green: "#9bb07e", yellow: "#d9b48a",
      blue: "#7f9bb0", magenta: "#b08a9b", cyan: "#7fb0a8", white: "#ece6da",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termHost);
  try { fit.fit(); } catch {}
  ov._term = term;
  ov._onResize = () => { try { fit.fit(); } catch {} };
  window.addEventListener("resize", ov._onResize);

  // Build the WS URL the way the rest of the PWA reaches the API + token.
  const token = (typeof authToken === "function" && authToken()) || "";
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host +
    "/api/agent-login/ws?agent=" + encodeURIComponent(name) +
    (token ? "&token=" + encodeURIComponent(token) : "");

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    setStatus("Couldn't open the connection.", "is-err");
    return;
  }
  ws.binaryType = "arraybuffer";
  ov._ws = ws;

  // Server control protocol (JSON text frames). Binary frames are raw PTY bytes.
  const handleControl = (m) => {
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "exit": {
        if (m.code === 0) {
          // Success: brief confirm, then close + refresh the cards (Installed → ✓ Connected).
          setStatus("✓ Connected", "is-ok");
          setTimeout(() => {
            closeAgentLoginModal(ov);
            if (typeof renderSettings === "function") renderSettings();
          }, 1200);
        } else {
          // Non-zero exit (cancelled / wrong code / login refused): leave the modal
          // up so the terminal output is readable; offer Close + Try again.
          markFailed("Login didn't complete — check the terminal above, then try again.");
        }
        break;
      }
      case "busy":
        // The server closes the socket right after, so there's nothing to do here —
        // surface it as a toast and dismiss the empty terminal.
        if (typeof toast === "function") toast("Another login is already running — try again in a moment.");
        closeAgentLoginModal(ov);
        break;
      case "error":
        markFailed(m.message ? String(m.message) : "Something went wrong.");
        break;
      default:
        break;
    }
  };

  ws.onopen = () => {
    setStatus("Connected — follow the prompts below.");
    try { term.focus(); } catch {}
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try { handleControl(JSON.parse(ev.data)); } catch {}
    } else {
      term.write(new Uint8Array(ev.data));
    }
  };
  ws.onerror = () => {
    if (!ov._failed) markFailed("Connection error — make sure the server is reachable, then try again.");
  };
  ws.onclose = () => {
    // Surface only an UNEXPECTED drop — don't clobber a success flash or an already-
    // shown failure message (exit/error handlers own those).
    if (ov.isConnected && !ov.dataset.closing && !ov._failed && !statusEl.classList.contains("is-ok")) {
      markFailed("Disconnected before the login finished — try again.");
    }
  };

  // Keystrokes → raw frames; xterm resize → JSON resize control frame.
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ t: "resize", cols, rows })); } catch {}
    }
  });
  // Push the initial geometry once connected.
  ws.addEventListener("open", () => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows })); } catch {}
    }
  });
}

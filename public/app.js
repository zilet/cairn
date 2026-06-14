const $ = (s) => document.querySelector(s);
const view = $("#view");
const headerTitle = $("#header-title");

// ---------- optional shared-token auth ----------
// No-op unless the server has CAIRN_AUTH_TOKEN set. The token lives in
// localStorage; api() sends it as a header, withToken() appends it to direct
// resource URLs (art images, file/export downloads) that can't carry a header.
function authToken() {
  try { return (localStorage.getItem("cairn_token") || "").trim(); } catch { return ""; }
}
function withToken(url) {
  const t = authToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}
let promptingAuth = false;
function handleUnauthorized() {
  if (promptingAuth) return;
  promptingAuth = true;
  try { localStorage.removeItem("cairn_token"); } catch {}
  const t = window.prompt("Cairn needs an access token (CAIRN_AUTH_TOKEN) to continue:");
  if (t && t.trim()) { try { localStorage.setItem("cairn_token", t.trim()); } catch {} }
  location.reload();
}
const api = (p, opts = {}) => {
  const t = authToken();
  const headers = { ...(opts.headers || {}) };
  if (t) headers["X-Cairn-Token"] = t;
  return fetch("/api" + p, { ...opts, headers }).then((r) => {
    if (r.status === 401) { handleUnauthorized(); return new Promise(() => {}); }
    setOffline(false); // a real response landed — Cairn is reachable
    return r.json();
  }).catch((err) => {
    setOffline(true); // the network dropped — surface the calm hairline banner
    throw err;
  });
};

// ---------- offline hairline ----------
// A calm, non-alarming banner ("Can't reach Cairn — changes will retry") that
// rides just under the header whenever a fetch fails or the browser reports
// offline. It clears itself the moment any request succeeds (or `online` fires).
// Constitution: information, never an alarm — one thin warm line, no modal.
let _offline = false;
function setOffline(on) {
  on = !!on;
  if (on === _offline) return;
  _offline = on;
  let bar = document.querySelector(".offline-bar");
  if (on) {
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "offline-bar";
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-live", "polite");
      bar.innerHTML = `<span class="offline-dot" aria-hidden="true"></span><span>Can't reach Cairn — changes will retry</span>`;
      document.body.appendChild(bar);
    }
    requestAnimationFrame(() => bar.classList.add("show"));
    document.body.classList.add("is-offline");
  } else if (bar) {
    bar.classList.remove("show");
    document.body.classList.remove("is-offline");
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setOffline(true));
  window.addEventListener("online", () => setOffline(false));
  if (navigator.onLine === false) setOffline(true);
}

function localISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Human label for the date being viewed on Today: "Today" / "Yesterday" / "Fri, Jun 5".
function dateLabel(iso) {
  if (iso === localISO()) return "Today";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (iso === localISO(y)) return "Yesterday";
  const [yr, mo, da] = iso.split("-").map(Number);
  return new Date(yr, mo - 1, da).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Compact relative timestamp for status lines: "just now" / "12m ago" / "3h ago" / "2d ago".
function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Friendly calendar-date label: "today" / "yesterday" / "3 days ago" / "2 weeks ago" /
// "Apr 2024". Recent dates read relative; older ones fall back to month + year, which is
// what makes sense for lab results spanning years. Accepts a YYYY-MM-DD string.
function humanDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d)) return String(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days < 0) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 45) return `${Math.round(days / 7)} weeks ago`;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Relative-age label that never falls back to a bare month-year: "today" / "yesterday" /
// "N days ago" / "N weeks ago" / "N months ago" / "a year ago" / "N years ago". Used for
// lab-marker recency where "3 months ago" reads better than "Apr 2024". Pair it with a
// title= absolute date for precision on hover. Accepts a YYYY-MM-DD string.
function relAge(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d)) return String(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days < 0) return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 45) return `${Math.round(days / 7)} weeks ago`;
  if (days < 320) return `${Math.max(1, Math.round(days / 30))} months ago`;
  if (days < 550) return "a year ago";
  return `${Math.round(days / 365)} years ago`;
}

// Full absolute date for title= tooltips alongside relAge ("June 11, 2026").
function absDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// Coaching prose tends to restate the most-recent panel date in every line
// ("LDL-C is 207 on 2026-06-11", "ApoB is 148 on 2026-06-11", …). We surface that
// date once as an "As of …" caption and clean it out of the body, then humanize any
// remaining (older, contextual) ISO dates so nothing reads as a raw YYYY-MM-DD.
function humanizeReviewText(text, latestISO) {
  if (!text) return text || "";
  let s = String(text);
  if (latestISO && /^\d{4}-\d{2}-\d{2}$/.test(latestISO)) {
    const esc = latestISO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "… on 2026-06-11", "as of 2026-06-11", "(2026-06-11)" → drop (shown once in caption)
    s = s.replace(new RegExp(`\\s*[([]?\\b(?:on|as of|dated|measured on|recorded on|taken on)\\s+${esc}\\b[)\\]]?`, "gi"), "");
    s = s.replace(new RegExp(`\\s*[([]\\s*${esc}\\s*[)\\]]`, "g"), "");
  }
  // remaining ISO dates → friendly labels ("Apr 2024", "yesterday", …)
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m0) => humanDate(m0));
  // tidy whatever stripping left behind: stray spaces before punctuation, empty (), leading commas
  return s.replace(/\(\s*\)/g, "").replace(/\s+([,.;:])/g, "$1").replace(/\s{2,}/g, " ").replace(/^\s*[,.;:]\s*/, "").trim();
}

// Newest YYYY-MM-DD mentioned anywhere in the parsed review (lexical max works for ISO).
function latestReviewDate(p) {
  const hits = JSON.stringify(p || {}).match(/\d{4}-\d{2}-\d{2}/g);
  return hits && hits.length ? hits.sort()[hits.length - 1] : null;
}

let state = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: localISO() };

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
function closeModal() { const m = document.querySelector(".modal"); if (m) m.remove(); }

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
  renderChat().then(() => { const i = $("#chatInput"); if (i) { i.value = text; i.focus(); } });
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
  view.querySelectorAll(".segbtn").forEach((b, i) =>
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
}
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
    .replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (m, txt, url) => {
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

// Run a DOM-swapping fn inside a shared-element view transition when supported.
function withViewTransition(fn) {
  const run = () => {
    try { return Promise.resolve(fn()); }
    catch (err) { return Promise.reject(err); }
  };
  if (document.startViewTransition && !reducedMotion()) {
    try {
      const tx = document.startViewTransition(run);
      return tx.updateCallbackDone || tx.finished || Promise.resolve();
    } catch { /* fall through */ }
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
    const eased = 1 - Math.pow(1 - p, 3); // settle, don't snap
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
function runCountUps(scope) {
  (scope || view).querySelectorAll("[data-cu]").forEach((el) => {
    const fmt = el.dataset.cufmt === "k" ? fmtK : (x) => Math.round(x).toLocaleString();
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

// ---------- Today ----------
// Build one exercise logging card. `it` = plan item (or synthetic {exercise} for off-plan).
// `logged` = sets already logged for this exercise in the loaded session.
// `prefill` = {weight,reps,rir} to seed the inputs.
function exTimed(it, logged) {
  if (it.mode === "timed" || it.target_seconds != null) return true;
  if ((state.exModes || {})[it.exercise] === "timed") return true;
  return (logged || []).some((s) => s.duration_sec != null);
}

function exCard(it, logged, prefill, revealIdx) {
  const offPlan = !it.fromPlan;
  const timed = exTimed(it, logged);
  const range = offPlan ? "" : (it.rep_low === it.rep_high ? `${it.rep_low}` : `${it.rep_low}–${it.rep_high}`);
  const targetTxt = timed
    ? `${it.sets ?? "?"} × ${it.target_seconds != null ? fmtDur(it.target_seconds) : "time"}`
    : `${it.sets} × ${range}`;
  const target = offPlan
    ? `<span class="ex-sets ex-offplan">off-plan</span>`
    : `<span class="ex-sets">${targetTxt}${!timed && it.target_weight != null ? ` @ <span class="ex-target numeral">${fmtWeight(it.target_weight)}</span>` : ""}</span>`;
  const done = logged.length;
  const goal = offPlan ? 0 : (it.sets || 0);
  const complete = goal && done >= goal;
  const progress = `<span class="ex-prog${complete ? " done" : ""}" data-prog>${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span></span>`;
  const pw = prefill.weight, pr = prefill.reps, prir = prefill.rir;
  const tile = artImg("exercise", it.exercise, "artile-sm ex-art", art("exercise", it.exercise, it.muscle_group));
  const logrow = timed
    ? `<div class="logrow" data-ex="${encodeURIComponent(it.exercise)}" data-day="${state.day}" data-mode="timed">
        <input type="text" inputmode="numeric" autocomplete="off" placeholder="TIME · 1:30" class="in-dur" value="${prefill.duration_sec != null ? fmtDur(prefill.duration_sec) : ""}">
        <button class="logbtn">+</button>
      </div>`
    : `<div class="logrow" data-ex="${encodeURIComponent(it.exercise)}" data-day="${state.day}">
        <input type="number" inputmode="decimal" placeholder="WT" class="in-w" value="${pw ?? ""}">
        <input type="number" inputmode="numeric" placeholder="REPS" class="in-r" value="${pr ?? ""}">
        <input type="number" inputmode="decimal" placeholder="RIR" class="in-rir" value="${prir ?? ""}">
        <button class="logbtn">+</button>
      </div>`;
  // "Not today" — only a planned exercise with nothing logged yet is skippable
  // (once a set lands, the log wins; the control disappears).
  const skipBtn = (!offPlan && !done)
    ? `<button class="ex-skip" data-skip="${encodeURIComponent(it.exercise)}" title="Not today" aria-label="Skip ${escAttr(it.exercise)} today">✕</button>`
    : "";
  return `<div class="ex${complete ? " ex-complete" : ""}${revealIdx != null ? " reveal" : ""}" data-card="${escAttr(it.exercise)}"${revealIdx != null ? ` style="${stagger(revealIdx)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <button class="ex-name" data-guide="${encodeURIComponent(it.exercise)}">${escHtml(it.exercise)} <span class="guide-i">ⓘ</span></button>
        ${target}
        ${skipBtn}
      </div>
      <div class="ex-meta">${progress}</div>
      ${it.note ? `<div class="ex-note">${escHtml(it.note)}</div>` : ""}
      ${it.constraint_note ? `<div class="ex-flag">${escHtml(it.constraint_note)}</div>` : ""}
      <div class="logged" data-logged>${logged.map(setChip).join("")}</div>
      ${logrow}
    </div>`;
}

function setChip(s, i) {
  const n = s.set_number ?? (i != null ? i + 1 : null);
  const figure = s.duration_sec != null
    ? fmtDur(s.duration_sec)
    : `${fmtWeight(s.weight)} <span>×</span> ${s.reps}${s.rir != null ? ` <span>@${s.rir}</span>` : ""}`;
  return `<span class="chip" data-set="${s.id}">${n != null ? `<span class="chip-n">#${n}</span> ` : ""}${figure}<button class="chip-x" data-del="${s.id}" title="delete">×</button></span>`;
}

function planDayNumberForSession(session, plan) {
  if (!session || !(session.sets || []).length) return null;
  const byId = plan.find((d) => Number(d.id) === Number(session.plan_day_id));
  if (byId) return byId.day_number;

  const loggedNames = new Set((session.sets || []).map((s) => s.exercise).filter(Boolean));
  let best = null;
  for (const d of plan) {
    const plannedNames = new Set((d.items || []).map((it) => it.exercise));
    let hits = 0;
    loggedNames.forEach((name) => { if (plannedNames.has(name)) hits++; });
    if (hits && (!best || hits > best.hits)) best = { day_number: d.day_number, hits };
  }
  return best?.day_number ?? null;
}

function nextPlanDayNumber(dayNumber, plan) {
  const ordered = [...plan].sort((a, b) => a.day_number - b.day_number);
  if (!ordered.length) return null;
  const idx = ordered.findIndex((d) => d.day_number === dayNumber);
  return ordered[idx >= 0 ? (idx + 1) % ordered.length : 0].day_number;
}

async function suggestedPlanDayNumber(session, isToday) {
  const currentLoggedDay = planDayNumberForSession(session, state.plan);
  if (currentLoggedDay) return currentLoggedDay;
  if (!isToday) return state.plan[0]?.day_number ?? 1;

  try {
    const recent = await api("/sessions?limit=20");
    const latest = (recent || []).find((s) =>
      s.date !== state.logDate && planDayNumberForSession(s, state.plan)
    );
    const latestDay = planDayNumberForSession(latest, state.plan);
    return latestDay ? nextPlanDayNumber(latestDay, state.plan) : (state.plan[0]?.day_number ?? 1);
  } catch {
    return state.plan[0]?.day_number ?? 1;
  }
}

// ---------- The Brief (day-read) ----------
// Phase 1: Today opens with a calm day-read — rest / easy / train — fetched from
// GET /api/today-read. It's a SUGGESTION, never a gate: every read carries one-tap
// redirects (train anyway · ask for a session · pull in your plan) so the rest of
// the surface is always one move away. The read is cached per-date on state.brief
// (keyed by date+override) so re-renders that don't change the day don't re-fetch.

// Map the read kind to its calm copy + glyph. Restful for rest, light for easy,
// energetic-but-quiet for train. Phrasing is plain language — never a score.
const BRIEF_KIND = {
  rest: { word: "Rest", glyph: "◐", lead: "A quiet day" },
  easy: { word: "Easy", glyph: "◑", lead: "Keep it light" },
  train: { word: "Train", glyph: "◆", lead: "Good to go" },
};
// Escape-hatch chips — each reshapes the read via ?override=. They open, never scold.
// "Train anyway" intentionally lives only in the launchpad (an instant plan-reveal),
// not here: an override chip of the same name would be a slow agentic round-trip AND
// a confusing duplicate of the primary button.
const BRIEF_OVERRIDES = [
  { intent: "rough night", label: "Rough night" },
  { intent: "short on time", label: "Short on time" },
  { intent: "give me an easy day", label: "Easy day instead" },
];

// Fetch (or reuse) the day-read for the selected date. Always resolves to a read
// object — the endpoint is always 200 (agentic or deterministic fallback). On a
// hard network failure we synthesize a minimal "train" read so the launchpad still
// works; the Brief never blocks the rest of Today.
// A bare provisional read used only to paint Today's structure instantly when the
// agentic read isn't warm yet. Marked _provisional so the background upgrade knows
// to replace it; it's never cached as the final read.
function provisionalRead(date) {
  return { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic", _provisional: true };
}

async function loadBrief(date, override, opts = {}) {
  const cached = state.brief;
  // Reuse a non-provisional cached read for the same date/override.
  if (cached && cached.date === date && cached.override === (override || "") && !cached.read._provisional) return cached.read;
  const fetchRead = (async () => {
    let read = null;
    try {
      const qs = new URLSearchParams({ date, agent: "auto" });
      if (override) qs.set("override", override);
      read = await api("/today-read?" + qs.toString());
    } catch { read = null; }
    if (!read || !read.kind) read = provisionalRead(date);
    return read;
  })();
  // Fast mode (first paint): never block more than ~the timeout. The endpoint
  // returns a cached read instantly, so the common case resolves immediately;
  // only a cold cache (first-ever agentic compute) hits the timeout, where we
  // paint a provisional read and let the background upgrade swap the real one in.
  if (opts.fast) {
    const TIMEOUT = 1200;
    const raced = await Promise.race([
      fetchRead.then((r) => ({ r })),
      new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT)),
    ]);
    if (raced && raced.r && !raced.r._provisional) {
      // Adopt the server-persisted steer (read.override) on a fresh open/reload —
      // the warm-cache reload hits this fast path, so the steer must survive here.
      state.brief = { date, override: override || raced.r.override || "", read: raced.r };
      return raced.r;
    }
    // timed out (or only got a provisional) — keep the real fetch alive so the
    // upgrade can await the SAME promise instead of firing a second request.
    state._briefInflight = { date, override: override || "", promise: fetchRead };
    const prov = (raced && raced.r) || provisionalRead(date);
    state.brief = { date, override: override || "", read: prov };
    return prov;
  }
  state._briefInflight = null; // a non-fast (deliberate) load supersedes any pending upgrade
  const read = await fetchRead;
  // The server PERSISTS the athlete's steer on the read (read.override). When we
  // didn't request one explicitly (a fresh open / reload), adopt the persisted steer
  // so the chips filter correctly and the active-steer styling shows — this is what
  // makes "Easy day instead" survive a reload instead of snapping back to canonical.
  state.brief = { date, override: override || read.override || "", read };
  return read;
}

// Upgrade a provisionally-painted Brief to the real (agentic) read in place,
// without re-rendering the rest of Today. Runs the .is-thinking filament while
// it waits, then swaps the .brief element. No-op if the read was already real,
// the tab changed, or the date/override moved on. Pull-never-push: it just
// quietly settles into the better read; nothing nags.
async function upgradeBriefInPlace(date, isToday) {
  const inflight = state._briefInflight;
  if (!inflight || inflight.date !== date) return; // nothing provisional to upgrade
  const briefEl = view.querySelector(".brief");
  if (briefEl && !reducedMotion()) briefEl.classList.add("is-thinking");
  let read = null;
  try { read = await inflight.promise; } catch { read = null; }
  // Stale-guard: bail if we navigated away or the date moved while waiting.
  if (state.tab !== "today" || state.logDate !== date) return;
  if (state._briefInflight === inflight) state._briefInflight = null;
  if (!read || read._provisional) { briefEl?.classList.remove("is-thinking"); return; }
  // Adopt the server-persisted steer when the real read settles (cold-cache path).
  state.brief = { date, override: inflight.override || read.override || "", read };
  const live = view.querySelector(".brief");
  if (!live) return;
  // Re-derive showPlan in case the real read flipped train↔rest/easy; only the
  // Brief element is swapped, so the logging surface below is untouched.
  const day = state.plan.find((d) => d.day_number === state.day) || state.plan[0] || { items: [] };
  const hasPlanDay = (day.items || []).length > 0;
  const showPlan = !!view.querySelector(".plansurface");
  const tmp = document.createElement("div");
  tmp.innerHTML = briefHtml(read, { showPlan, hasPlanDay, isToday });
  const fresh = tmp.firstElementChild;
  if (!fresh) { live.classList.remove("is-thinking"); return; }
  fresh.classList.add(reducedMotion() ? "" : "brief-settle");
  live.replaceWith(fresh);
  wireBrief(read, { isToday });
  runCountUps(fresh);
  if (showPlan) loadTrainingProvenance(isToday); // re-attach the causal line after the swap
}

// A relevant log just reshaped today (an activity, a check-in) — drop the cached
// Brief so it re-fetches the server-recomputed read, and if Today is the live
// surface, re-render it with the hero morph so the change shows immediately. A
// logged set doesn't need this: the first set already re-renders Today, and
// nulling state.brief there lets that render pick up the fresh read.
async function reshapeToday() {
  state.brief = null;
  if (state.tab !== "today") return;
  // Re-fetch the read BEFORE the transition so renderToday's loadBrief hits the
  // warm cache and the DOM update is instant — running the (slow, agentic) fetch
  // inside withViewTransition trips its ~4s timeout and aborts the morph. This
  // mirrors the override-chip path. The fetch can take a few seconds; the "Logged"
  // toast already gave feedback, and the old read stays put until the flip lands.
  await loadBrief(state.logDate, "");
  if (state.tab !== "today") return; // navigated away during the await
  const morph = !reducedMotion();
  if (morph) { view.querySelector(".brief")?.classList.add("brief-morph"); state._briefMorph = true; }
  try {
    await withViewTransition(() => renderToday());
  } finally {
    state._briefMorph = false;
    view.querySelector(".brief")?.classList.remove("brief-morph");
  }
}

// One launchpad redirect chip. `primary` gets the accent treatment (the day's
// smart default action); the rest are quiet hairline pills.
function briefRedirect(action, label, primary) {
  return `<button class="brief-redirect${primary ? " brief-redirect-primary" : ""}" data-redirect="${escAttr(action)}">${escHtml(label)}</button>`;
}

function visibleBriefOverrides({ kind, estMinutes, activeOverride }) {
  return BRIEF_OVERRIDES.filter((o) => {
    if (o.intent === activeOverride) return false;
    if (kind === "easy" && o.intent === "give me an easy day") return false;
    if (kind === "rest" && o.intent === "rough night") return false;
    if (estMinutes != null && estMinutes <= 30 && o.intent === "short on time") return false;
    return true;
  });
}

// Build the Brief hero + actions row + steer line. `showPlan` = the plan surface
// is already (or about to be) visible. The controls split into two clear tiers:
// an ACTIONS row (one primary thing to do, scaled to the day) and a quiet, labeled
// STEER line ("tell me different" — each option reshapes the read agentically).
function briefHtml(read, { showPlan, hasPlanDay, isToday }) {
  const kind = BRIEF_KIND[read.kind] ? read.kind : "train";
  const meta = BRIEF_KIND[kind];
  const focus = read.focus ? escHtml(read.focus) : "";
  const estMinutes = read.est_minutes != null && Number(read.est_minutes) > 0 ? Math.round(read.est_minutes) : null;
  const est = estMinutes != null ? `${estMinutes} min` : "";
  // Headline leads; on a train day the focus IS the headline-adjacent line.
  const headline = escHtml(read.headline || meta.lead);
  const why = read.why ? escHtml(read.why) : "";

  // ---- Actions: ONE clear thing to do. The accent primary is reserved for a
  // train day ("start the session"); easy/rest stay calm with NO accent CTA, so
  // the card never contradicts a read the athlete just chose to take easy.
  const actions = [];
  if (kind === "train") {
    actions.push(briefRedirect("start-session", "Start session", true));
  } else if (!showPlan) {
    // easy / rest — a quiet way into the plan if they want it, never shouted
    actions.push(briefRedirect("reveal-plan", "Train anyway", false));
  }
  actions.push(briefRedirect("ask-session", "Ask for a session", false));

  // ---- Steer line: visually subordinate to the actions. Only meaningful for
  // today (a live read to reshape). When a steer is already active, the label
  // shifts and a quiet "back to today's read" clears it (the un-steer escape).
  const activeOverride = state.brief && state.brief.date === state.logDate ? state.brief.override : "";
  const steered = !!activeOverride;
  const opts = visibleBriefOverrides({ kind, estMinutes, activeOverride });
  let steer = "";
  if (isToday && (opts.length || steered)) {
    const optBtns = opts.map((o) =>
      `<button class="brief-steer-opt" data-override="${escAttr(o.intent)}">${escHtml(o.label)}</button>`
    ).join(`<span class="brief-steer-dot" aria-hidden="true">·</span>`);
    const reset = steered ? `<button class="brief-steer-reset" data-steerreset>back to today's read</button>` : "";
    steer = `<div class="brief-steer">
        <span class="brief-steer-lead">${steered ? "Changed your mind?" : "Not quite right?"}</span>
        <span class="brief-steer-opts">${optBtns}</span>
        ${reset}
      </div>`;
  }

  // When reshaping via a steer, the hero morphs through a view transition —
  // skip the entrance `rise` so the two motions don't stack.
  const morph = state._briefMorph ? " brief-morph" : "";
  const enter = state._briefMorph ? "" : " reveal";
  // A provisional (cold-cache) read paints with the terracotta→gold filament so
  // the wait reads as the agentic read still arriving, not a stalled guess.
  const thinking = read._provisional && !reducedMotion() ? " is-thinking" : "";
  const busy = read._provisional ? ` aria-busy="true"` : "";
  return `<section class="brief brief-${kind}${morph}${enter}${thinking}" style="--i:0" aria-live="polite"${busy}>
      <div class="brief-kicker lbl"><span class="brief-glyph" aria-hidden="true">${meta.glyph}</span> ${meta.word.toUpperCase()} DAY${est ? ` · ${escHtml(est)}` : ""}</div>
      <h2 class="brief-headline">${headline}</h2>
      ${focus && kind === "train" ? `<div class="brief-focus">${focus}</div>` : ""}
      ${why ? `<p class="brief-why">${why}</p>` : ""}
      <div id="briefProvenance" class="prov-slot"></div>
      <div class="brief-launch">${actions.join("")}</div>
      ${steer}
      <button class="brief-why-more" data-briefwhy hidden>tap to see why</button>
    </section>`;
}

// ---- Focus mode: a distraction-free logging view for a training day ----
// Per the constitution it's a calm OPTION, never forced: it auto-engages once you've
// logged a set today (you've committed to the work), you can toggle it on/off any
// time, and an explicit choice for the date always wins over the auto rule. When on,
// Today sheds the Brief/insight/capture/week chrome and keeps just a slim sticky
// header (day · progress · one-line read · exit) above the logging cards.
function focusEngaged(date, { showPlan, hasLoggedSets, isToday }) {
  if (!showPlan) return false;
  const f = state.focus;
  if (f && f.date === date) return f.on;   // the athlete's explicit choice for this date
  return !!(isToday && hasLoggedSets);      // auto: engage once logging is underway
}
function setFocus(date, on) { state.focus = { date, on }; }

// The slim sticky header shown in focus mode — day name, sets-of-exercises progress,
// the one-line Brief read for context, and a one-tap exit back to the full Today.
function focusBarHtml(read, day, { exDone, exTotal, isToday }) {
  const meta = BRIEF_KIND[BRIEF_KIND[read.kind] ? read.kind : "train"];
  const line = read.headline || read.focus || meta.lead;
  const dayName = day && day.name ? day.name : "Today's session";
  const prog = exTotal
    ? `<span class="focus-prog"><span class="focus-prog-done">${exDone}</span><span class="focus-prog-sep">/</span>${exTotal} done</span>`
    : "";
  return `<div class="focus-bar reveal" style="--i:0" aria-label="Workout focus">
      <div class="focus-bar-row">
        ${!isToday ? `<button class="focus-back" id="backToday" aria-label="Back to today">←</button>` : `<span class="focus-glyph" aria-hidden="true">${meta.glyph}</span>`}
        <div class="focus-id">
          <span class="focus-day">${escHtml(dayName)}</span>
          ${prog}
        </div>
        <button class="focus-exit" id="focusExit">Exit focus</button>
      </div>
      ${line ? `<div class="focus-read">${escHtml(line)}</div>` : ""}
    </div>`;
}

// The optional "tap to see why" detail — plain-language signals, never raw numbers
// as a verdict. Built lazily into a toast-like inline expander under the Brief.
function briefSignalsText(read) {
  const s = read.signals || {};
  const bits = [];
  if (s.consecutive_training_days != null && s.consecutive_training_days > 0) {
    bits.push(`${s.consecutive_training_days} day${s.consecutive_training_days === 1 ? "" : "s"} of training in a row`);
  }
  if (s.low_sleep) bits.push("your sleep's been running short");
  else if (s.avg_sleep_min != null && s.has_recovery_data) bits.push("sleep's been about normal for you");
  if (s.checkin) bits.push("you mentioned how you're feeling");
  if (!bits.length) return "Reading your recent training and recovery.";
  return bits.join("; ") + ".";
}

// Render one session-suggest item line (sets × reps, or seconds for timed; assisted
// / bodyweight per the weight convention). `it` is one item from the suggested session.
function suggestItemHtml(it, i = 0) {
  const name = escHtml(it.exercise || "Exercise");
  const timed = it.mode === "timed" || it.target_seconds != null;
  let prescription;
  if (timed) {
    const secs = it.target_seconds != null ? fmtDur(it.target_seconds) : "time";
    prescription = `${it.sets ?? "?"} × ${secs}`;
  } else {
    const lo = it.rep_low, hi = it.rep_high;
    const reps = lo != null && hi != null ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : (lo ?? hi ?? "");
    prescription = `${it.sets ?? "?"}${reps ? ` × ${reps}` : ""}`;
    if (it.target_weight != null) {
      prescription += it.target_weight < 0 ? ` · ${-it.target_weight} assist` : ` · ${it.target_weight} lb`;
    } else {
      prescription += " · BW";
    }
  }
  const tile = artImg("exercise", it.exercise || "", "artile-sm sug-art", art("exercise", it.exercise || ""));
  return `<div class="sug-item reveal" style="${stagger(i + 1)}">
      ${tile}
      <div class="sug-item-main">
        <div class="sug-item-name">${name}</div>
        ${it.note ? `<div class="sug-item-note">${escHtml(it.note)}</div>` : ""}
      </div>
      <div class="sug-item-rx numeral">${escHtml(prescription)}</div>
    </div>`;
}

// Render the suggested session as a reviewable card under the Brief. It is a
// SUGGESTION — not saved. "Log these" surfaces the items in the existing Today
// logging UI (reuse appendOffPlanCard); "Dismiss" clears it.
function suggestCardHtml(session) {
  const name = escHtml(session.name || "Session");
  const focus = session.focus ? escHtml(session.focus) : "";
  const est = session.est_minutes != null && Number(session.est_minutes) > 0 ? `${Math.round(session.est_minutes)} min` : "";
  const why = session.why ? escHtml(session.why) : "";
  const items = (Array.isArray(session.items) ? session.items : []).map((it, i) => suggestItemHtml(it, i)).join("");
  return `<section class="sug-card settle-in">
      <div class="sug-head">
        <div class="sug-kicker lbl">A session for today${est ? ` · ${escHtml(est)}` : ""}</div>
        <h3 class="sug-name">${name}</h3>
        ${focus ? `<div class="sug-focus">${focus}</div>` : ""}
      </div>
      ${why ? `<p class="sug-why">${why}</p>` : ""}
      <div class="sug-items">${items || `<div class="sug-empty">No exercises came back — try again.</div>`}</div>
      ${session.notes ? `<div class="sug-notes">${escHtml(session.notes)}</div>` : ""}
      <div class="sug-actions">
        <button class="pillbtn pill-accent" data-sugaction="log">Log these</button>
        <button class="pillbtn" data-sugaction="dismiss">Not now</button>
      </div>
      <div class="sug-hint">A suggestion to follow or ignore — it isn't saved as your plan.</div>
    </section>`;
}

// Ask the buddy for a session right now. POSTs /session-suggest (with optional
// minutes for the short-on-time path). Mirrors the meal-swap failure UX: ok:false
// (or a thrown 500 with no ok) surfaces as a gentle inline line, never a hard error.
let sessionSuggestInFlight = false;
async function askForSession(opts = {}) {
  if (sessionSuggestInFlight) { toast("Already drafting a session…"); return; }
  const slot = view.querySelector("#sugSlot");
  if (!slot) return;
  sessionSuggestInFlight = true;
  const token = pollToken;
  slot.innerHTML = `<div class="sug-card sug-loading settle-in">
      <span class="aspin" aria-hidden="true"></span>
      <div class="sug-loading-line">Asking your buddy for a session…</div>
    </div>`;
  const body = { date: state.logDate };
  if (opts.minutes != null) body.minutes = opts.minutes;
  if (opts.focus) body.focus = opts.focus;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let r = null;
  try {
    r = await api("/session-suggest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
  } catch { r = null; }
  clearTimeout(timer);
  sessionSuggestInFlight = false;
  if (token !== pollToken) return; // re-rendered since — the fresh render owns the DOM
  if (!slot.isConnected) return;

  if (r && r.ok === true && r.session) {
    state.suggestedSession = r.session;
    slot.innerHTML = suggestCardHtml(r.session);
    runCountUps(slot);
    wireSuggestCard(slot);
    slot.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
  } else {
    // designed failure (ok:false) or unreachable — gentle, never an error
    slot.innerHTML = `<div class="sug-card sug-fail settle-in">
        <div class="sug-fail-line">Couldn't draft a session just now — your buddy may be offline. You can train anyway or try again.</div>
        <div class="sug-actions"><button class="pillbtn" data-sugaction="retry">Try again</button></div>
      </div>`;
    wireSuggestCard(slot);
  }
}

// Wire the suggest card's actions (log these / dismiss / retry).
function wireSuggestCard(slot) {
  slot.querySelectorAll("[data-sugaction]").forEach((b) =>
    b.addEventListener("click", () => {
      const act = b.dataset.sugaction;
      const card = slot.querySelector(".sug-card");
      if (act === "dismiss") {
        // ease the card out instead of a hard clear
        state.suggestedSession = null;
        if (card) collapseEl(card, () => { slot.innerHTML = ""; }); else slot.innerHTML = "";
        return;
      }
      if (act === "retry") { askForSession(); return; }
      if (act === "log") {
        const session = state.suggestedSession;
        if (!session || !Array.isArray(session.items)) return;
        // reveal the plan surface so the off-plan cards have somewhere to land,
        // then drop each suggested item in via the existing add-exercise path.
        const handoff = () => {
          revealPlanThen(() => {
            for (const it of session.items) {
              if (!it || !it.exercise) continue;
              appendOffPlanCard(it.exercise, it.mode === "timed" || it.target_seconds != null ? "timed" : "reps");
            }
            state.suggestedSession = null;
            const s = view.querySelector("#sugSlot");
            if (s) s.innerHTML = "";
            toast("Added to today — log as you go");
          });
        };
        // when the plan surface is already shown the hand-off happens in place, so
        // collapse the card first for continuity; otherwise the full re-render
        // replaces the empty slot and the collapse would be cut short — go straight.
        if (card && view.querySelector(".addex")) collapseEl(card, handoff); else handoff();
      }
    })
  );
}

// Reveal the plan/logging surface for the selected date, then run `after` once the
// surface exists in the DOM. If it's already shown, run immediately.
function revealPlanThen(after) {
  if (view.querySelector(".addex")) { after && after(); return; }
  state.planReveal = { date: state.logDate, on: true };
  Promise.resolve(renderToday()).then(() => { after && after(); });
}

async function renderToday() {
  pollToken++; // invalidate any in-flight enrichment polls from a previous render
  if (!state.logDate) state.logDate = localISO();
  setTodayHeaderTitle();
  // Skeleton-first: paint the shell synchronously so a tab switch never leaves the
  // previous tab frozen during the data/agent awaits below. The real render swaps
  // view.innerHTML wholesale once the data is in hand. Skip when re-rendering
  // in-place (the Brief is already on screen — a skeleton flash would be jarring).
  if (!view.querySelector(".today-wrap")) view.innerHTML = todaySkeleton();
  if (!state.plan.length) state.plan = await api("/plan");
  const isToday = state.logDate === localISO();

  // session for the selected date (single object or null)
  const session = await api("/sessions?date=" + state.logDate);
  const loggedByEx = {};
  if (session) for (const s of session.sets) (loggedByEx[s.exercise] ??= []).push(s);
  for (const k of Object.keys(loggedByEx)) loggedByEx[k].sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0));

  const hasSelectedDay = state.plan.some((d) => d.day_number === state.day);
  if (!state.dayPicked || state.day === null || !hasSelectedDay) {
    state.day = await suggestedPlanDayNumber(session, isToday);
    state.dayPicked = false;
  }

  const day = state.plan.find((d) => d.day_number === state.day) || state.plan[0] || { items: [] };
  const planNames = new Set((day.items || []).map((it) => it.exercise));

  // "Not today" skips for this session. A skip only holds while the exercise
  // has no logged sets — if sets exist (e.g. logged via chat/MCP), the card wins.
  const skippedSet = new Set(((session && session.skips) || []).map((n) => String(n).toLowerCase()));
  const isSkipped = (it) => skippedSet.has(it.exercise.toLowerCase()) && !(loggedByEx[it.exercise] || []).length;
  const activeItems = (day.items || []).filter((it) => !isSkipped(it));
  const skippedItems = (day.items || []).filter(isSkipped);

  // prefill: for plan exercises with no set yet this session, fetch most-recent-ever once.
  const planEx = activeItems.map((it) => it.exercise);
  const offPlanEx = Object.keys(loggedByEx).filter((ex) => !planNames.has(ex));
  const needLast = [...new Set(planEx)].filter((ex) => !(loggedByEx[ex] && loggedByEx[ex].length));
  const lastSets = {};
  await Promise.all(needLast.map(async (ex) => {
    try { lastSets[ex] = await api("/last-set?exercise=" + encodeURIComponent(ex)); } catch { lastSets[ex] = null; }
  }));

  function prefillFor(it) {
    const logged = loggedByEx[it.exercise] || [];
    if (logged.length) { const s = logged[logged.length - 1]; return { weight: s.weight, reps: s.reps, rir: s.rir, duration_sec: s.duration_sec ?? null }; }
    const last = lastSets[it.exercise];
    if (last) return { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
    return { weight: it.target_weight ?? null, reps: it.rep_low ?? null, rir: null, duration_sec: it.target_seconds ?? null };
  }

  const [stats, profile, exercises] = await Promise.all([
    api("/stats"), api("/profile").catch(() => null), api("/exercises").catch(() => []),
  ]);
  // exercise → mode map ('reps'|'timed'), used by exCard + the add-exercise flow
  state.exModes = Object.fromEntries((exercises || []).map((e) => [e.name, e.mode || "reps"]));
  const curW = stats.weight_lb ?? (profile && profile.weight_lb != null ? profile.weight_lb : null);
  // Compass strip: adherence to this week's plan + weight-trend pace vs the
  // goal — the two numbers that actually steer the week (raw tonnage/sets/
  // streak live on in the Progress hero bands).
  const planned = stats.week_planned || 0, done = stats.week_done || 0;
  const dots = planned
    ? `<div class="stat-dots">${Array.from({ length: planned }, (_, i) => `<span class="stat-dot${i < done ? " on" : ""}"></span>`).join("")}</div>`
    : "";
  const fmtPace = (v) => (v > 0 ? "+" : "") + (Math.round(v * 10) / 10);
  const PACE_WORD = { on: "on pace", behind: "behind", fast: "too fast" };
  let paceTile;
  if (stats.trend_lb_wk == null) {
    paceTile = `<div class="stat stat-pace"><div class="stat-n numeral stat-dim">—</div><div class="stat-l lbl">pace · log weigh-ins</div></div>`;
  } else if (stats.needed_lb_wk == null) {
    paceTile = `<div class="stat stat-pace"><div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div><div class="stat-l lbl">lb/wk · set a goal</div></div>`;
  } else {
    paceTile = `<div class="stat stat-pace pace-${stats.pace_status || "on"}" title="Trend ${fmtPace(stats.trend_lb_wk)} lb/wk over recent weigh-ins · need ${fmtPace(stats.needed_lb_wk)} to reach ${stats.goal_weight_lb} lb by ${stats.goal_date}">
        <div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div>
        <div class="stat-sub">${PACE_WORD[stats.pace_status] || ""} · need ${fmtPace(stats.needed_lb_wk)}</div>
        <div class="stat-l lbl">lb / week</div>
      </div>`;
  }
  // Pace offer: when the weight-trend pace deviates, one calm OPTIONAL line that
  // drops the athlete into Chat with the question already written — the coach
  // agent sees the full context and can draft the fix (kcal, plan, both). Only
  // appears on a real deviation; a low signal is information, never a verdict, so
  // it reads as an offer to look together — not a warning or a goal-compliance score.
  const maxSafe = curW != null ? Math.round(curW * 0.01 * 10) / 10 : null;
  const PACE_OFFER = {
    fast: {
      line: "Trending a bit fast — want to look at your pace together?",
      ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but the lean-safe ceiling for me is about -${maxSafe} lb/wk (needed pace ${fmtPace(stats.needed_lb_wk ?? 0)}). Should we add calories or adjust the plan to protect lean mass?`,
    },
    behind: {
      line: "A little behind your goal pace — want to look together?",
      ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but I need ${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk to hit ${stats.goal_weight_lb} lb by ${stats.goal_date}. What should we tighten — meals, cardio, or the timeline?`,
    },
  };
  const paceOffer = isToday && PACE_OFFER[stats.pace_status]
    ? `<button class="pace-offer pace-offer-${stats.pace_status}" id="paceOffer">${escHtml(PACE_OFFER[stats.pace_status].line)} · <span class="pace-offer-cta">ask the coach →</span></button>`
    : "";

  // ---- The Brief: the day-read leads. A suggestion, never a gate. ----
  // The plan/logging surface is revealed when the read says "train", when the
  // user has already logged on this date (they've committed), when they tapped
  // "train anyway"/"log these" (state.planReveal), or when reviewing a past date.
  const hasLoggedSets = !!(session && (session.sets || []).length);
  const hasPlanDay = (day.items || []).length > 0;
  const revealOn = state.planReveal && state.planReveal.date === state.logDate && state.planReveal.on;
  // Non-blocking Brief: fetch the read in FAST mode — the endpoint returns a warm
  // cached read instantly, so the common case is immediate; a cold cache resolves
  // to a provisional read (painted with the .is-thinking filament) and the real
  // agentic read swaps in via upgradeBriefInPlace() once it lands. First paint
  // never waits on agent:"auto". (Honors an active override.)
  const briefOverride = state.brief && state.brief.date === state.logDate ? state.brief.override : "";
  const read = await loadBrief(state.logDate, briefOverride, { fast: true });
  const hasGarmin = !!(session && session.garmin);
  const showPlan = !isToday || hasLoggedSets || hasGarmin || revealOn || read.kind === "train";
  // Focus mode strips Today to the logging surface (see focusEngaged). Progress for
  // the slim header: how many of today's exercises have at least one logged set.
  const focus = focusEngaged(state.logDate, { showPlan, hasLoggedSets, isToday });
  const exDone = activeItems.filter((it) => (loggedByEx[it.exercise] || []).length).length;
  const exTotal = activeItems.length;

  // In focus mode the chrome (context banner, Brief, insight, capture) gives way to
  // the slim sticky focus header; otherwise the Brief leads as always.
  let html = focus
    ? focusBarHtml(read, day, { exDone, exTotal, isToday })
    : `${isToday ? "" : `<button id="backToday" class="ghostbtn back-today">← Back to today</button>`}
    <div id="ctxBanner"><div id="ctxEvents"></div><div id="ctxHealth"></div></div>
    ${briefHtml(read, { showPlan, hasPlanDay, isToday })}
    <div id="insightSlot" class="insight-slot"></div>
    <div id="sugSlot" class="sug-slot"></div>
    <div class="capture-row reveal" style="--i:1">
      <div class="wt-inline" id="wtInline" hidden>
        <input id="wtInlineInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (lb)">
        <button id="wtInlineGo" class="logbtn">+</button>
      </div>
      <div class="quicklog">
        <input id="qlInput" type="text" placeholder="Log a ride, run, meal, or weight…">
        <button id="qlMic" class="qlmic" type="button" hidden aria-label="Dictate" title="Say it out loud">${MIC_GLYPH}</button>
        <button id="qlBtn" class="logbtn">↵</button>
        <button id="wtChipMini" class="wt-mini" title="Log bodyweight">${curW != null ? `${curW}<span class="wt-mini-unit">lb</span>` : "weight"}<span class="stat-plus">+</span></button>
      </div>
      <div id="freqFoods" class="freq-foods"></div>
      ${isToday ? `<div id="checkinSlot" class="checkin-slot"></div>` : ""}
      <div id="qlRecent" class="ql-recent"></div>
    </div>`;

  // ---- Plan / logging surface — the launchpad, shown when the day calls for it ----
  if (showPlan) {
    html += `<div class="plansurface reveal" style="--i:2">`;
    // When not already focused, offer a one-tap "Focus" pill above the day switcher.
    if (!focus) html += `<div class="focus-enterrow"><button class="focus-enter" id="focusEnter" title="Distraction-free logging">${BRIEF_KIND.train.glyph} Focus</button></div>`;
    html += `<div class="day-switch">`;
    for (const d of state.plan) {
      html += `<button class="daybtn ${d.day_number === state.day ? "active" : ""}" data-day="${d.day_number}">${d.day_number} · ${escHtml(d.name)}</button>`;
    }
    html += `</div><div id="tableHint"></div>`;

    // Garmin "body's reaction" card — the strength session's physiology layer
    // (HR / zones / calories / training effect), reconciled from a synced watch.
    if (hasGarmin) html += garminSessionCard(session.garmin);

    let cardIdx = 0;
    for (const it of activeItems) {
      html += exCard({ ...it, fromPlan: true }, loggedByEx[it.exercise] || [], prefillFor(it), cardIdx++);
    }
    for (const ex of offPlanEx) {
      const logged = loggedByEx[ex];
      const s = logged[logged.length - 1];
      html += exCard({ exercise: ex, fromPlan: false }, logged, { weight: s.weight, reps: s.reps, rir: s.rir }, cardIdx++);
    }
    html += `<div class="addex">
      <button id="addExBtn" class="ghostbtn addex-btn">+ Add exercise</button>
      <div id="addExForm" class="addex-form" hidden>
        <div class="addex-row">
          <input id="addExInput" type="text" autocomplete="off" placeholder="Search or type an exercise" list="exOptions">
          <datalist id="exOptions"></datalist>
          <button id="addExGo" class="logbtn">+</button>
        </div>
        <div class="addex-mode" id="addExMode" role="group" aria-label="Exercise type">
          <button class="modebtn active" data-exmode="reps">Reps</button>
          <button class="modebtn" data-exmode="timed">Timed</button>
        </div>
      </div>
    </div>`;
    if (hasLoggedSets) {
      const tonnage = session.sets.reduce((t, s) => t + (s.weight > 0 && s.reps ? s.weight * s.reps : 0), 0);
      html += `<div class="finish">
        <div class="finish-stat" data-finishstat>${session.sets.length} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + state.logDate}</div>
        <div id="feedbackSlot" class="feedback-slot"></div>
        <div class="logrow" style="margin-top:8px">
          <input id="sessNotes" type="text" placeholder="Session notes (optional)" value="${escAttr(session.notes || "")}" style="text-align:left">
          <button id="finishBtn" class="logbtn" style="width:auto;padding:0 16px;font-size:.82rem;letter-spacing:.04em">FINISH</button>
        </div>
      </div>`;
    }
    // Skipped exercises live on as one slim, muted line at the very bottom —
    // recoverable later in the day (tap a name to restore), never buried.
    html += skipLineHtml(skippedItems.map((it) => it.exercise));
    html += `</div>`; // .plansurface
  }

  // ---- Trajectory tier (this week), quiet, below the fold — hidden in focus ----
  if (!focus) {
    html += `${paceOffer}
    <details class="weekfold" id="weekFold">
      <summary class="weekfold-sum"><span class="lbl">This week</span><span class="weekfold-chev" aria-hidden="true">▾</span></summary>
      <div class="statstrip statstrip-compass">
        <div class="stat" title="Training sessions logged this week vs your plan">
          <div class="stat-n numeral"><span data-cu="${done}">0</span><span class="stat-frac">/${planned || "—"}</span></div>
          ${dots}
          <div class="stat-l lbl">this week</div>
        </div>
        ${paceTile}
        <button class="stat stat-wt" id="wtChip" title="Log bodyweight">
          <div class="stat-n numeral" data-wtval>${curW != null ? curW : "—"}<span class="stat-plus">+</span></div>
          <div class="stat-l lbl">${stats.goal_weight_lb != null ? `lb → ${escHtml(String(stats.goal_weight_lb))}` : "weight · lb"}</div>
        </button>
      </div>
      <div id="wearStrip"></div>
    </details>`;
  }

  // Scope the focus class to this render via a wrapper, so a tab switch (which
  // replaces #view wholesale) can never leave the class stranded.
  view.innerHTML = `<div class="today-wrap${focus ? " today-focus" : ""}">${html}</div>`;
  updateHeaderCondense(); // re-render may reset scroll → recompute the pinned-header state
  runCountUps(view);

  const qlBtn = view.querySelector("#qlBtn");
  const qlInput = view.querySelector("#qlInput");
  if (qlBtn) qlBtn.addEventListener("click", quickLog);
  if (qlInput) qlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") quickLog(); });

  wireBrief(read, { isToday });
  // If we painted a provisional (cold-cache) read, upgrade it to the agentic read
  // in place — the filament keeps running until the real read settles in.
  if (read._provisional) upgradeBriefInPlace(state.logDate, isToday);
  // Connected-brain provenance: a quiet causal line under the Brief on a training
  // day, if a training/watch directive shaped it ("eased volume — RHR ran high · why").
  if (!focus && showPlan) loadTrainingProvenance(isToday);

  loadTableHint();
  // The chrome — capture row, context banners, insight, frequents, week tier — only
  // exists outside focus mode; skip its wiring entirely when focused.
  if (!focus) {
    setupWeightChip();
    setupVoiceCapture();
    loadFrequentFoods();
    loadRecentActivities();
    loadContextBanner();
    loadHealthFocusBanner();
    loadWearable(isToday);
    if (isToday) { loadInsightCard(); loadCheckin(); }
  }

  // Focus toggle — enter (pill above the cards) / exit (slim header), each a smooth
  // view-transition morph between the full Today and the focused logging view.
  const focusEnterBtn = view.querySelector("#focusEnter");
  if (focusEnterBtn) focusEnterBtn.addEventListener("click", () => {
    setFocus(state.logDate, true);
    withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
  });
  const focusExitBtn = view.querySelector("#focusExit");
  if (focusExitBtn) focusExitBtn.addEventListener("click", () => {
    setFocus(state.logDate, false);
    withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
  });

  const paceOfferBtn = view.querySelector("#paceOffer");
  if (paceOfferBtn) paceOfferBtn.addEventListener("click", () => {
    state.chatPrefill = PACE_OFFER[stats.pace_status]?.ask || "";
    activateTab("chat");
  });

  const backBtn = view.querySelector("#backToday");
  if (backBtn) backBtn.addEventListener("click", () => {
    state.logDate = localISO();
    state.day = null;
    state.dayPicked = false;
    renderToday();
  });

  view.querySelectorAll(".daybtn").forEach((b) =>
    b.addEventListener("click", () => {
      state.day = Number(b.dataset.day);
      state.dayPicked = true;
      renderToday();
    })
  );

  wireDeletes();

  wireSkips();

  wireGuides(view);

  const finishBtn = view.querySelector("#finishBtn");
  if (finishBtn) finishBtn.addEventListener("click", async () => {
    const notes = view.querySelector("#sessNotes").value.trim();
    const r = await api(`/sessions/${session.id}/finish`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }),
    });
    const sm = r.summary || {};
    stopRest();
    toast(`Done · ${sm.sets || 0} sets · ${(sm.tonnage || 0).toLocaleString()} lb`);
  });

  view.querySelectorAll(".ex .logrow").forEach((row) => wireLogRow(row));

  if (hasLoggedSets) renderFeedback(view.querySelector("#feedbackSlot"), session);

  setupAddExercise();
}

// ---------- Autoregulation: gentle 1-tap "how did that feel?" ----------
// Optional, calm, dismissible. A 1-5 soreness + 1-5 performance tap and an
// optional joint/area field, on a session that already has logged sets. The
// session object (from GET /api/sessions?date=) already carries any prior
// answer, so we render it as recorded when it's set. Recovery INFORMS the
// coach — it never auto-changes a plan (you drive).
function hasFeedback(session) {
  return session && (session.soreness != null || session.performance != null ||
    (session.joint_pain != null && String(session.joint_pain).trim()));
}

function renderFeedback(slot, session) {
  if (!slot) return;
  if (hasFeedback(session)) { renderFeedbackDone(slot, session); return; }
  // collapsed by default — one quiet line, opt-in
  slot.innerHTML = `<button class="checkin-open" id="feedbackOpen" type="button">
      <span class="checkin-open-dot" aria-hidden="true"></span>
      how did that feel?
    </button>`;
  const open = slot.querySelector("#feedbackOpen");
  if (open) open.addEventListener("click", () => renderFeedbackForm(slot, session));
}

function renderFeedbackForm(slot, session) {
  slot.innerHTML = `<div class="checkin-form feedback-form chip-in">
      ${feelScale("soreness", "soreness")}
      ${feelScale("performance", "performance")}
      <input id="feedbackJoint" class="feedback-joint" type="text" autocomplete="off"
        placeholder="any joint or area? (e.g. left knee)" value="${escAttr(session.joint_pain || "")}">
      <button class="checkin-dismiss" id="feedbackDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
  const date = session.date || state.logDate;
  const picked = {};
  const save = async () => {
    const joint = slot.querySelector("#feedbackJoint");
    const jointVal = joint ? joint.value.trim() : "";
    try {
      const saved = await api(`/sessions/${date}/feedback`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soreness: picked.soreness, performance: picked.performance,
          joint_pain: jointVal || null,
        }),
      });
      if (saved && !saved.error) { Object.assign(session, saved); }
    } catch { /* silent — it's optional */ }
  };
  slot.querySelectorAll(".feel-dot").forEach((b) =>
    b.addEventListener("click", async () => {
      const kind = b.dataset.feel, val = Number(b.dataset.val);
      picked[kind] = val;
      slot.querySelectorAll(`.feel-dot[data-feel="${kind}"]`).forEach((d) =>
        d.classList.toggle("feel-dot-on", Number(d.dataset.val) <= val));
      await save();
      toast("Noted");
    }));
  // a joint/area entered on its own is still worth recording
  const joint = slot.querySelector("#feedbackJoint");
  if (joint) joint.addEventListener("change", () => { if (picked.soreness || picked.performance || joint.value.trim()) save(); });
  const dismiss = slot.querySelector("#feedbackDismiss");
  if (dismiss) dismiss.addEventListener("click", () => { slot.innerHTML = ""; });
}

function renderFeedbackDone(slot, session) {
  const parts = [];
  if (session.soreness != null) parts.push(`soreness ${Number(session.soreness)}/5`);
  if (session.performance != null) parts.push(`performance ${Number(session.performance)}/5`);
  if (session.joint_pain && String(session.joint_pain).trim()) parts.push(escHtml(String(session.joint_pain).trim()));
  if (!parts.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="checkin-done feedback-done chip-in">
      <span class="checkin-done-mark" aria-hidden="true">✓</span> ${parts.join(" · ")}
      <button class="feedback-edit" id="feedbackEdit" type="button">edit</button>
    </div>`;
  const edit = slot.querySelector("#feedbackEdit");
  if (edit) edit.addEventListener("click", () => renderFeedbackForm(slot, session));
}

// Wire the Brief's launchpad: override chips reshape the read; redirects open the
// rest of Today (train anyway / pull in plan / ask for a session). Nothing here is
// a gate — each control is one tap to a different path through the day.
function wireBrief(read, { isToday }) {
  const brief = view.querySelector(".brief");
  if (!brief) return;

  // Steer options → re-fetch today-read with ?override= and re-render the Brief.
  brief.querySelectorAll("[data-override]").forEach((b) =>
    b.addEventListener("click", async () => {
      const intent = b.dataset.override;
      if (brief.classList.contains("is-thinking")) return; // a reshape is already in flight
      // Visible "thinking" state for the (slow, agentic) reshape: the tapped option
      // carries a ring, the rest freeze, a filament sweeps the card, and a quiet line
      // makes the wait read as intentional rather than stalled.
      const chipLabel = (b.textContent || "").trim();
      brief.querySelectorAll(".brief-steer-opt").forEach((c) => {
        c.classList.toggle("brief-steer-active", c === b);
        if (c !== b) c.disabled = true;
      });
      const resetBtn = brief.querySelector("[data-steerreset]");
      if (resetBtn) resetBtn.disabled = true;
      b.classList.add("brief-steer-busy");
      b.innerHTML = `<span class="aspin aspin-xs"></span>${escHtml(chipLabel)}`;
      brief.classList.add("is-thinking");
      brief.setAttribute("aria-busy", "true"); // screen readers hear "busy" while the read reshapes
      const note = document.createElement("div");
      note.className = "athinking-note chip-in";
      note.setAttribute("role", "status");
      note.textContent = "Reading the day again…";
      (b.closest(".brief-steer") || b.parentElement).after(note); // the line sits under the steer block
      // bust the per-date cache so loadBrief re-fetches with the override
      state.brief = null;
      const reshaped = await loadBrief(state.logDate, intent);
      // "short on time" also offers a shorter session straight away. The re-render
      // runs inside a view transition so the hero (brief-hero shared element)
      // morphs to its reshaped read fluidly instead of popping. Name the hero only
      // for this moment: tag the live brief now, and the fresh render re-tags via
      // state._briefMorph, so old+new both carry brief-hero during the capture.
      if (state.tab === "today") {
        const morph = !reducedMotion();
        if (morph) { brief.classList.add("brief-morph"); state._briefMorph = true; }
        try {
          await withViewTransition(() => renderToday());
        } finally {
          state._briefMorph = false;
          // drop the transient name so ordinary tab transitions keep the root crossfade
          view.querySelector(".brief")?.classList.remove("brief-morph");
        }
        if (/short on time/i.test(intent)) askForSession({ minutes: 30, focus: reshaped.focus || read.focus || undefined });
      }
    })
  );

  // Redirects: start the session (reveal + scroll), reveal the plan, pull in a
  // plan day, or ask for a session. None is a gate — each is one tap to a path.
  brief.querySelectorAll("[data-redirect]").forEach((b) =>
    b.addEventListener("click", () => {
      const action = b.dataset.redirect;
      if (action === "ask-session") { askForSession(); return; }
      if (action === "start-session") {
        // the day's primary on a train day: make sure the logging surface exists,
        // then bring its first card into view so "start" lands you in the work.
        revealPlanThen(() => {
          const surface = view.querySelector(".plansurface") || view.querySelector(".addex");
          surface?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
        });
        return;
      }
      if (action === "reveal-plan") {
        state.planReveal = { date: state.logDate, on: true };
        renderToday();
        return;
      }
      if (action === "pull-plan") {
        // surface the planned day's logging cards (the day switcher + cards)
        state.planReveal = { date: state.logDate, on: true };
        state.dayPicked = true;
        renderToday();
        return;
      }
    })
  );

  // "Back to today's read" — clear a persisted steer and recompute the canonical
  // read (?reset=1 invalidates the cached steer server-side). The athlete is never
  // trapped in an override they changed their mind about.
  const steerReset = brief.querySelector("[data-steerreset]");
  if (steerReset) steerReset.addEventListener("click", async () => {
    if (brief.classList.contains("is-thinking")) return;
    brief.querySelectorAll(".brief-steer-opt").forEach((c) => { c.disabled = true; });
    steerReset.disabled = true;
    steerReset.innerHTML = `<span class="aspin aspin-xs"></span>back to today's read`;
    brief.classList.add("is-thinking");
    const note = document.createElement("div");
    note.className = "athinking-note chip-in";
    note.textContent = "Reading the day again…";
    (steerReset.closest(".brief-steer") || steerReset.parentElement).after(note);
    state.brief = null;
    try {
      const qs = new URLSearchParams({ date: state.logDate, agent: "auto", reset: "1" });
      const fresh = await api("/today-read?" + qs.toString());
      state.brief = {
        date: state.logDate,
        override: fresh && fresh.override ? fresh.override : "",
        read: fresh && fresh.kind ? fresh : { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic" },
      };
    } catch { state.brief = null; }
    if (state.tab !== "today") return;
    const morph = !reducedMotion();
    if (morph) { brief.classList.add("brief-morph"); state._briefMorph = true; }
    try { await withViewTransition(() => renderToday()); }
    finally { state._briefMorph = false; view.querySelector(".brief")?.classList.remove("brief-morph"); }
  });

  // "Tap to see why" — plain-language signals (never raw numbers as a verdict),
  // shown only on a deliberate tap, in a quiet inline line under the headline.
  const whyBtn = brief.querySelector("[data-briefwhy]");
  if (whyBtn && read.signals && Object.keys(read.signals).length) {
    whyBtn.hidden = false;
    whyBtn.addEventListener("click", () => {
      if (brief.querySelector(".brief-signals")) {
        brief.querySelector(".brief-signals").remove();
        whyBtn.textContent = "tap to see why";
        return;
      }
      const sig = document.createElement("p");
      sig.className = "brief-signals chip-in";
      sig.textContent = briefSignalsText(read);
      whyBtn.before(sig);
      whyBtn.textContent = "hide";
    });
  }
}

// delete wiring (re-callable after inline chip inserts; guards against double-binding)
function wireDeletes() {
  view.querySelectorAll("[data-del]").forEach((b) => {
    if (b._wired) return; b._wired = true;
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/sets/${b.dataset.del}`, { method: "DELETE" });
      // refresh from server so set numbers + counts stay correct
      renderToday();
    });
  });
}

// ---------- skip an exercise for the day ("not today") ----------
// Smooth in-flow collapse: the element's box (height/padding/margin) eases to
// zero with a fade, then done() fires. Cancellable — expandEl() on the same
// element mid-flight reverses from wherever it is (the done callback is
// suppressed via the _collapsed flag). House motion tokens, reduced-motion safe.
function collapseEl(el, done) {
  el._collapsed = true;
  clearTimeout(el._animTimer);
  if (reducedMotion()) { done && done(); return; }
  el._h = el.offsetHeight;
  el.style.height = el._h + "px";
  el.style.overflow = "hidden";
  void el.offsetHeight; // commit the measured start state
  el.style.transition = "height var(--dur-2) var(--ease),opacity var(--dur-1) ease,margin var(--dur-2) var(--ease),padding var(--dur-2) var(--ease),transform var(--dur-2) var(--ease)";
  el.style.height = "0px"; el.style.opacity = "0"; el.style.transform = "scale(.97)";
  el.style.marginBottom = "0px"; el.style.paddingTop = "0px"; el.style.paddingBottom = "0px";
  el._animTimer = setTimeout(() => { if (el._collapsed && done) done(); }, 380);
}
function expandEl(el) {
  clearTimeout(el._animTimer);
  el._collapsed = false;
  const clear = () => {
    ["height", "overflow", "transition", "opacity", "transform", "margin-bottom", "padding-top", "padding-bottom"]
      .forEach((p) => el.style.removeProperty(p));
  };
  if (reducedMotion()) { clear(); return; }
  void el.offsetHeight;
  el.style.height = (el._h || el.scrollHeight) + "px";
  el.style.opacity = ""; el.style.transform = "";
  el.style.marginBottom = ""; el.style.paddingTop = ""; el.style.paddingBottom = "";
  el._animTimer = setTimeout(clear, 380);
}

// The slim "Skipped: …" line at the very bottom of Today. Hidden while empty.
function skipNameHtml(name) {
  return `<button class="skip-name" data-unskip="${encodeURIComponent(name)}" title="Restore ${escAttr(name)}">${escHtml(name)}<span class="skip-undo">↺</span></button>`;
}
function skipLineHtml(names) {
  return `<div class="skipline${names.length ? "" : " skipline-empty"}" id="skipLine" aria-live="polite">
      <span class="lbl">Skipped</span>
      <span class="skipline-names">${names.map(skipNameHtml).join("")}</span>
    </div>`;
}
function addSkipName(name) {
  const line = view.querySelector("#skipLine");
  if (!line) return;
  const names = line.querySelector(".skipline-names");
  const dup = [...names.querySelectorAll("[data-unskip]")]
    .some((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase());
  if (!dup) {
    const tpl = document.createElement("template");
    tpl.innerHTML = skipNameHtml(name).trim();
    const el = tpl.content.firstChild;
    el.classList.add("chip-in");
    names.appendChild(el);
  }
  line.classList.remove("skipline-empty");
}
function removeSkipName(name) {
  const line = view.querySelector("#skipLine");
  if (!line) return;
  [...line.querySelectorAll("[data-unskip]")]
    .filter((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase())
    .forEach((b) => b.remove());
  if (!line.querySelector("[data-unskip]")) line.classList.add("skipline-empty");
}

async function skipFromCard(card, exercise) {
  let res;
  try {
    res = await api("/sessions/skip", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: state.logDate, exercise }),
    });
  } catch { toast("Couldn't skip — try again"); return; }
  if (!res || res.ok !== true) {
    toast(res && res.error ? "Sets already logged — delete them first" : "Couldn't skip — try again");
    return;
  }
  // remember where the card sat so UNDO can put it back in place, wiring intact
  const anchor = card.nextElementSibling;
  collapseEl(card, () => { card.remove(); addSkipName(exercise); });
  toast(`${exercise} skipped today`, { action: "Undo", onAction: () => undoSkip(card, anchor, exercise) });
}

async function undoSkip(card, anchor, exercise) {
  try {
    await api("/sessions/skip", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: state.logDate, exercise }),
    });
  } catch { toast("Couldn't restore — try again"); return; }
  if (state.tab !== "today") return;
  removeSkipName(exercise);
  if (!card.isConnected) {
    // the detached card kept all its listeners — slot it back where it was.
    // Insert relative to the ref node's own parent (.plansurface), since
    // insertBefore needs the ref to be a direct child of the caller.
    const before = anchor && anchor.isConnected ? anchor : view.querySelector(".addex");
    if (!before || !before.parentNode) { renderToday(); return; }
    before.parentNode.insertBefore(card, before);
  }
  expandEl(card);
}

function wireSkips() {
  view.querySelectorAll(".ex-skip").forEach((b) => {
    if (b._wired) return; b._wired = true;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      skipFromCard(b.closest(".ex"), decodeURIComponent(b.dataset.skip));
    });
  });
  const line = view.querySelector("#skipLine");
  if (line && !line._wired) {
    line._wired = true;
    line.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-unskip]");
      if (!b) return;
      const exercise = decodeURIComponent(b.dataset.unskip);
      try {
        await api("/sessions/skip", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: state.logDate, exercise }),
        });
      } catch { toast("Couldn't restore — try again"); return; }
      toast(`${exercise} is back on`);
      renderToday(); // full refresh rebuilds the card in its plan position
    });
  }
}

// Log one set from a card's logrow; update the card inline without a full re-render.
function wireLogRow(row) {
  row.querySelector(".logbtn").addEventListener("click", async () => {
    const timed = row.dataset.mode === "timed";
    let body;
    if (timed) {
      const durEl = row.querySelector(".in-dur");
      const sec = parseDur(durEl.value);
      if (sec == null || sec <= 0) { toast("Time? e.g. 1:30 or 90"); durEl.focus(); return; }
      durEl.value = fmtDur(sec); // normalise the display for the next tap
      body = {
        exercise: decodeURIComponent(row.dataset.ex),
        weight: null, reps: null, rir: null,
        duration_sec: sec, exercise_mode: "timed",
        day_number: Number(row.dataset.day),
        date: state.logDate,
      };
    } else {
      const wEl = row.querySelector(".in-w"), rEl = row.querySelector(".in-r"), rirEl = row.querySelector(".in-rir");
      const w = wEl.value, r = rEl.value, rir = rirEl.value;
      if (r === "") { toast("Reps?"); rEl.focus(); return; }
      body = {
        exercise: decodeURIComponent(row.dataset.ex),
        weight: w === "" ? null : Number(w),
        reps: Number(r),
        rir: rir === "" ? null : Number(rir),
        day_number: Number(row.dataset.day),
        date: state.logDate,
      };
    }
    const res = await api("/sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.brief = null; // a logged set reshapes today — the next Today render re-reads the Brief
    // inline: append chip, tick progress, keep inputs populated for the next tap
    const card = row.closest(".ex");
    const loggedWrap = card.querySelector("[data-logged]");
    const tpl = document.createElement("template");
    tpl.innerHTML = setChip({ id: res.id, set_number: res.set_number, weight: res.weight, reps: res.reps, rir: res.rir, duration_sec: res.duration_sec ?? null }).trim();
    const chipEl = tpl.content.firstChild;
    chipEl.classList.add("chip-in");
    loggedWrap.appendChild(chipEl);
    wireDeletes();
    bumpProgress(card);
    const skipCtl = card.querySelector(".ex-skip");
    if (skipCtl) skipCtl.remove(); // a logged set makes the card no longer skippable
    if (res.pr) { toast("🏆 New PR!"); if (navigator.vibrate) navigator.vibrate([60, 40, 120]); }
    else toast("Set logged");
    startRest();
    refreshFinishStat();
  });
}

function bumpProgress(card) {
  const prog = card.querySelector("[data-prog]");
  if (!prog) return;
  const done = card.querySelectorAll("[data-logged] .chip").length;
  const m = (prog.textContent.match(/\/\s*(\d+)/) || [])[1];
  const goal = m ? Number(m) : 0;
  prog.innerHTML = `${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span>`;
  const complete = goal && done >= goal;
  prog.classList.toggle("done", !!complete);
  card.classList.toggle("ex-complete", !!complete);
}

function refreshFinishStat() {
  const chips = view.querySelectorAll(".ex [data-logged] .chip");
  if (!chips.length) return;
  const stat = view.querySelector("[data-finishstat]");
  if (!stat) {
    // first set on a previously empty date — re-render to bring in the FINISH block.
    // This is also where focus mode auto-engages (hasLoggedSets just flipped true),
    // so morph through a view transition: Today gently collapses into the focus view.
    withViewTransition(() => Promise.resolve(renderToday()).then(viewEnter));
    return;
  }
  let sets = 0, tonnage = 0;
  chips.forEach((c) => {
    sets++;
    const mm = c.textContent.match(/(-?\d+(?:\.\d+)?)\s*×\s*(\d+)/);
    if (mm) { const wt = Number(mm[1]), reps = Number(mm[2]); if (wt > 0) tonnage += wt * reps; }
  });
  const isToday = state.logDate === localISO();
  stat.textContent = `${sets} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + state.logDate}`;
}

async function setupAddExercise() {
  const btn = view.querySelector("#addExBtn");
  const form = view.querySelector("#addExForm");
  const input = view.querySelector("#addExInput");
  const go = view.querySelector("#addExGo");
  const datalist = view.querySelector("#exOptions");
  if (!btn || !form) return;

  let mode = "reps";
  const modeWrap = view.querySelector("#addExMode");
  modeWrap.querySelectorAll("[data-exmode]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.exmode;
    modeWrap.querySelectorAll(".modebtn").forEach((x) => x.classList.toggle("active", x === b));
  }));
  const setMode = (m) => {
    mode = m;
    modeWrap.querySelectorAll(".modebtn").forEach((x) => x.classList.toggle("active", x.dataset.exmode === m));
  };

  btn.addEventListener("click", async () => {
    form.hidden = false; btn.hidden = true; input.focus();
    if (!datalist.children.length) {
      try {
        const exs = await api("/exercises");
        state.exModes = Object.fromEntries((exs || []).map((e) => [e.name, e.mode || "reps"]));
        datalist.innerHTML = (exs || []).map((e) => `<option value="${escAttr(e.name)}">${escHtml(e.muscle_group || "")}</option>`).join("");
      } catch { /* free-typed names still work */ }
    }
  });
  // picking a known timed exercise flips the toggle automatically
  input.addEventListener("input", () => {
    const m = (state.exModes || {})[input.value.trim()];
    if (m) setMode(m);
  });

  function resetAddForm() { input.value = ""; form.hidden = true; btn.hidden = false; setMode("reps"); }
  const add = async () => {
    const name = (input.value || "").trim();
    if (!name) { input.focus(); return; }
    const existing = [...view.querySelectorAll(".ex[data-card]")].find((el) => el.dataset.card === name);
    if (existing) { existing.scrollIntoView({ behavior: "smooth", block: "center" }); (existing.querySelector(".in-r") || existing.querySelector(".in-dur"))?.focus(); resetAddForm(); return; }
    // typed a name that's sitting in today's skipped line → restore it instead
    const skippedBtn = [...view.querySelectorAll("#skipLine [data-unskip]")]
      .find((b) => decodeURIComponent(b.dataset.unskip).toLowerCase() === name.toLowerCase());
    if (skippedBtn) { resetAddForm(); skippedBtn.click(); return; }
    if (mode === "timed" && (state.exModes || {})[name] !== "timed") {
      // register the exercise as timed so logging + history know its mode
      try {
        await api("/exercises", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mode: "timed" }) });
        (state.exModes ??= {})[name] = "timed";
      } catch { /* fall through — the set itself still carries exercise_mode */ }
    }
    appendOffPlanCard(name, mode);
    resetAddForm();
  };
  go.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
}

async function appendOffPlanCard(name, mode) {
  let prefill = { weight: null, reps: null, rir: null, duration_sec: null };
  try {
    const last = await api("/last-set?exercise=" + encodeURIComponent(name));
    if (last) prefill = { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
  } catch {}
  const tpl = document.createElement("template");
  tpl.innerHTML = exCard({ exercise: name, fromPlan: false, mode: mode || null }, [], prefill).trim();
  const cardEl = tpl.content.firstChild;
  // .addex lives inside .plansurface — insert relative to its real parent
  // (insertBefore requires the ref node to be a direct child of the caller).
  const addBlock = view.querySelector(".addex");
  if (addBlock) addBlock.before(cardEl);
  else (view.querySelector(".plansurface") || view).appendChild(cardEl);
  wireGuides(cardEl);
  wireLogRow(cardEl.querySelector(".logrow"));
  cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
  (cardEl.querySelector(".in-r") || cardEl.querySelector(".in-dur"))?.focus();
}

// Bare activity types make ambiguous image prompts ("ride" → horseback), so map
// common types to an explicit phrase for the generated photo; the SVG fallback
// still keys off the raw type.
const ACT_ART_PHRASE = {
  ride: "riding a road bicycle", bike: "riding a road bicycle", cycl: "riding a road bicycle",
  run: "running", jog: "jogging", hike: "hiking with a backpack",
  walk: "walking briskly", swim: "swimming freestyle", row: "rowing on a rowing machine",
  yoga: "holding a yoga pose", climb: "climbing an indoor wall", ski: "cross-country skiing",
};
function actArtText(a) {
  const t = (a.type || "").toLowerCase();
  for (const k in ACT_ART_PHRASE) if (t.includes(k)) return ACT_ART_PHRASE[k];
  return a.type || a.raw_text || "";
}

// Render one activity row (instant or enriched). `live` adds the pending badge while enriching.
function actEntryHtml(a) {
  const tile = artImg("activity", actArtText(a), "artile-sm qlent-art", art("activity", a.type));
  return `<div class="qlent" data-actid="${a.id}">
      ${tile}
      <div class="qlent-line">${escHtml(activityLine(a))}</div>
      <div class="qlent-badge">${enrichBadge(a.enrichment_status)}</div>
    </div>`;
}

// Shared poll-update for an activity entry: refresh text, badge, and (if present) the art tile.
function updateActEntry(el, row) {
  el.querySelector(".qlent-line").textContent = activityLine(row);
  el.querySelector(".qlent-badge").innerHTML = enrichBadge(row.enrichment_status);
  const tileEl = el.querySelector(".qlent-art");
  if (tileEl) {
    const t = artImg("activity", actArtText(row), "artile-sm qlent-art", art("activity", row.type));
    if (t) tileEl.outerHTML = t;
  }
  if (row.enrichment_status === "done") el.classList.add("qlent-done");
}

// Today: the "body's reaction" card for a strength session reconciled from Garmin —
// HR / calories / training-effect tiles + a time-in-HR-zone bar + the agent's
// one-line read. All server strings via escHtml; numbers coerced. "" without data.
const HR_ZONE_COLORS = ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"]; // z1..z5, calm → hot
function garminSessionCard(g) {
  if (!g) return "";
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const tiles = [];
  const tile = (val, lbl) => tiles.push(`<span class="wear-cell"><span class="wear-n numeral">${val}</span><span class="wear-l lbl">${lbl}</span></span>`);
  const dur = num(g.duration_min); if (dur != null) tile(`${Math.round(dur * 10) / 10}`, "min");
  const ahr = num(g.avg_hr); if (ahr != null) tile(`${Math.round(ahr)}`, "avg hr");
  const mhr = num(g.max_hr); if (mhr != null) tile(`${Math.round(mhr)}`, "max hr");
  const kcal = num(g.calories); if (kcal != null) tile(`${Math.round(kcal)}`, "kcal");
  const te = num(g.training_effect); if (te != null) tile(`${Math.round(te * 10) / 10}`, "effect");

  let bar = "";
  const zones = (Array.isArray(g.hr_zones) ? g.hr_zones : [])
    .filter((z) => z && num(z.secs) != null && num(z.secs) > 0)
    .sort((a, b) => (num(a.zone) || 0) - (num(b.zone) || 0));
  const total = zones.reduce((t, z) => t + (num(z.secs) || 0), 0);
  if (total > 0) {
    const segs = zones.map((z) => {
      const zi = Math.min(5, Math.max(1, num(z.zone) || 1));
      const pct = ((num(z.secs) || 0) / total) * 100;
      const mins = Math.round((num(z.secs) || 0) / 60);
      return `<span class="gz-seg" style="width:${pct.toFixed(1)}%;background:${HR_ZONE_COLORS[zi - 1]}" title="Zone ${zi} · ${mins} min"></span>`;
    }).join("");
    bar = `<div class="gz-bar">${segs}</div><div class="gz-legend lbl">time in HR zones</div>`;
  }

  if (!tiles.length && !bar && !g.summary) return "";
  const tag = g.extrapolated ? `<span class="garmin-tag">✦ logged from Garmin</span>` : "";
  return `<div class="garmin-card reveal" style="--i:2">
      <div class="garmin-card-h"><span class="lbl">Garmin · body's reaction</span>${tag}</div>
      ${tiles.length ? `<div class="garmin-tiles">${tiles.join("")}</div>` : ""}
      ${bar}
      ${g.summary ? `<div class="garmin-sum">${escHtml(g.summary)}</div>` : ""}
    </div>`;
}

async function loadRecentActivities() {
  const wrap = view.querySelector("#qlRecent");
  if (!wrap) return;
  let acts = [];
  try { acts = await api("/activities?limit=4"); } catch { acts = []; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  if (!acts || !acts.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<div class="ql-recent-h lbl">Recent</div>` + acts.map((a) => actEntryHtml(a)).join("");
}

// Today: slim Garmin wearable strip under the compass — steps · sleep · resting
// HR (· HRV) from the most recent garmin_daily_metrics row. Renders nothing at
// all unless that row is from today or yesterday, so non-Garmin users (and the
// past-date view) see zero clutter. Values are numeric — server text never
// reaches innerHTML here.
async function loadWearable(isToday) {
  const slot = view.querySelector("#wearStrip");
  if (!slot || !isToday) return;
  let rows = [];
  try { rows = await api("/garmin/daily?limit=1"); } catch { return; }
  if (state.tab !== "today" || !slot.isConnected) return;
  const m = Array.isArray(rows) ? rows[0] : null;
  if (!m || !m.date) return;
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (m.date !== localISO() && m.date !== localISO(yest)) return;
  const cells = [];
  if (m.steps != null) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Number(m.steps) || 0}" data-cufmt="k">0</span><span class="wear-l lbl">steps</span></span>`);
  }
  if (m.sleep_min != null) {
    const v = Math.max(0, Math.round(Number(m.sleep_min) || 0));
    const score = m.sleep_score != null ? ` · ${Math.round(Number(m.sleep_score))}` : "";
    cells.push(`<span class="wear-cell"><span class="wear-n numeral">${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}</span><span class="wear-l lbl">sleep${score}</span></span>`);
  }
  if (m.resting_hr != null) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.resting_hr)) || 0}">0</span><span class="wear-l lbl">rest hr</span></span>`);
  }
  if (m.hrv_ms != null && cells.length < 4) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.hrv_ms)) || 0}">0</span><span class="wear-l lbl">hrv</span></span>`);
  }
  if (m.body_battery_avg != null && cells.length < 4) {
    cells.push(`<span class="wear-cell"><span class="wear-n numeral" data-cu="${Math.round(Number(m.body_battery_avg)) || 0}">0</span><span class="wear-l lbl">battery</span></span>`);
  }
  if (!cells.length) return;
  slot.innerHTML = `<div class="wearstrip reveal" style="${stagger(0)}">
      <span class="wear-kicker lbl">Garmin${m.date !== localISO() ? " · yest" : ""}</span>
      ${cells.join("")}
    </div>`;
  runCountUps(slot);
}

// Today: a one-line pointer to the day's planned meals — deliberately quiet
// (the full planner lives in Plan → Meals; this is just the shortcut there).
async function loadTableHint() {
  const wrap = view.querySelector("#tableHint");
  if (!wrap) return;
  let plans = [];
  try { plans = await api("/mealplans?limit=6"); } catch { return; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  const p = (plans || []).find((x) => x.status === "accepted" && x.parsed) ||
            (plans || []).find((x) => x.status === "draft" && x.parsed);
  const days = p && Array.isArray(p.parsed.days) ? p.parsed.days : [];
  const lbl = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(state.logDate + "T12:00:00").getDay()];
  const day = days.find((d) => String(d.day || "").toLowerCase().startsWith(lbl));
  const meals = day && Array.isArray(day.meals) ? day.meals : [];
  if (!meals.length) return;
  const first = meals[0].name || meals[0].meal || "";
  wrap.innerHTML = `<button class="tablehint" id="tableHintBtn">
      <span class="lbl">Table</span> ${escHtml(first)}${meals.length > 1 ? `<span class="tablehint-more"> +${meals.length - 1}</span>` : ""}<span class="tablehint-go">→</span>
    </button>`;
  wrap.querySelector("#tableHintBtn").addEventListener("click", () => { state.planJump = "meals"; activateTab("plan"); });
}

// Today: a subtle banner summarising active/upcoming context (trips, injuries, life events).
const CTX_ICONS = { trip: "✈", injury: "🤕", life_event: "◆" };
function ctxBannerLine(ev) {
  let meta = ev.meta_json;
  if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = null; } }
  meta = meta || {};
  const icon = CTX_ICONS[ev.kind] || "◆";
  const title = ev.title || ev.kind;
  if (ev.kind === "trip") {
    const today = localISO();
    let when = "";
    if (ev.start_date && ev.start_date > today) {
      const d = new Date(ev.start_date + "T00:00:00"), now = new Date(today + "T00:00:00");
      const days = Math.round((d - now) / 86400000);
      when = days === 0 ? " today" : ` in ${days} day${days === 1 ? "" : "s"}`;
    } else if (ev.start_date && (!ev.end_date || ev.end_date >= today)) {
      when = " now";
    }
    return `${icon} ${escHtml(title)}${meta.location ? ` to ${escHtml(meta.location)}` : ""}${escHtml(when)}`;
  }
  if (ev.kind === "injury") {
    return `${icon} ${escHtml(title)}${meta.area && !String(title).toLowerCase().includes(String(meta.area).toLowerCase()) ? ` (${escHtml(meta.area)})` : ""} — go easy`;
  }
  return `${icon} ${escHtml(title)}`;
}

async function loadContextBanner() {
  const wrap = view.querySelector("#ctxEvents");
  if (!wrap) return;
  let events = [];
  try { events = await api("/context-events?active=1"); } catch { events = []; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  events = (events || []).filter((e) => !e.archived);
  if (!events.length) { wrap.innerHTML = ""; return; }
  const lines = events.slice(0, 3).map(ctxBannerLine);
  wrap.innerHTML = `<div class="ctxbanner">${lines.join('<span class="ctxbanner-sep">·</span>')}</div>`;
}

// Today: one quiet health-focus line from the latest whole-picture review (first
// focus title + action), mirroring the context banner. Tap → Me → Health.
// Renders nothing when there's no review or no focus items — zero noise.
async function loadHealthFocusBanner() {
  const wrap = view.querySelector("#ctxHealth");
  if (!wrap) return;
  let review = null;
  try { review = await api("/health/review"); } catch { review = null; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  if (review && !review.error) state.healthReview = review;
  let parsed = review && review.parsed;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
  const f = parsed && Array.isArray(parsed.focus) ? parsed.focus.find((x) => x && x.title) : null;
  if (!f) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<button class="ctxbanner ctxbanner-health" id="ctxHealthGo">
      <span class="ctxbanner-health-line">✦ ${escHtml(f.title)}${f.action ? ` — ${escHtml(f.action)}` : ""}</span>
      <span class="ctxbanner-go" aria-hidden="true">→</span>
    </button>`;
  wrap.querySelector("#ctxHealthGo").addEventListener("click", () => {
    state.meSeg = "health";
    state.healthSeg = "analysis"; // the focus line comes from the review
    activateTab("me");
  });
}

// ====================================================================
// Connected-brain provenance — make the product's deepest differentiator
// FELT at the point of consumption. When a flagged lab marker shaped a meal
// plan or the day's training (via a cross-domain directive), surface ONE quiet
// causal line right where the consequence lands ("tilted toward fish — ApoB
// came back high · why"), deep-linking to Me → Health → Brain. Informational,
// never a verdict; soft/uncertain directives read tentative.
// ====================================================================

// Active directives for a domain, newest-first. Short-lived in-memory cache so the
// Brief + Meals don't double-fetch within one render pass. Always degrades to [].
let _provCache = null;
async function activeDirectives() {
  if (_provCache && Date.now() - _provCache.at < 4000) return _provCache.rows;
  let rows = [];
  try {
    const res = await api("/directives");
    rows = (res && Array.isArray(res.directives) ? res.directives : []).filter((d) => !d.status || d.status === "active");
  } catch { rows = []; }
  _provCache = { at: Date.now(), rows };
  return rows;
}

// Build the quiet causal line for one directive. The "consequence" half comes from
// the directive text (already plain-language); the "because" half is the marker.
// Returns {html} or null when there's nothing worth saying.
function provenanceLineHtml(d, label) {
  if (!d) return null;
  const consequence = String(d.directive || "").trim();
  if (!consequence) return null;
  const soft = d.uncertain && !d.citation;
  const because = d.marker ? `<span class="prov-marker">${escHtml(String(d.marker))}</span>` : "";
  const lead = soft ? `<span class="prov-soft">Worth looking into · </span>` : "";
  // The whole line is the deep-link to Me → Health → Brain (where the directive lives).
  return `<button class="prov-line" data-prov aria-label="${escAttr(label + ": " + consequence)}">
      <span class="prov-glyph" aria-hidden="true">✦</span>
      <span class="prov-text">${lead}${escHtml(consequence)}${because ? ` — ${because}` : ""}</span>
      <span class="prov-why" aria-hidden="true">why</span>
    </button>`;
}

// Wire any rendered provenance line to deep-link into Me → Health → Brain.
function wireProvenance(scope) {
  (scope || view).querySelectorAll("[data-prov]").forEach((b) => b.addEventListener("click", () => {
    state.meSeg = "health";
    state.healthSeg = "brain"; // the directives live in the Brain view
    activateTab("me");
  }));
}

// Today's Brief: the training/watch directive shaping the day, rendered under the why.
async function loadTrainingProvenance(isToday) {
  const slot = view.querySelector("#briefProvenance");
  if (!slot) return;
  const rows = await activeDirectives();
  if (state.tab !== "today" || !slot.isConnected) return;
  // training first (it's what shapes the session), then a watch item
  const d = rows.find((x) => (x.domain || "watch") === "training") || rows.find((x) => (x.domain || "watch") === "watch");
  const html = provenanceLineHtml(d, "Training shaped by your labs");
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
  wireProvenance(slot);
}

// Meals: the nutrition directive that tilted the plan, rendered under the hero.
async function loadMealProvenance() {
  const slot = view.querySelector("#mealProvenance");
  if (!slot) return;
  const rows = await activeDirectives();
  if (state.tab !== "plan" || !slot.isConnected) return;
  const d = rows.find((x) => (x.domain || "watch") === "nutrition");
  const html = provenanceLineHtml(d, "Meals shaped by your labs");
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
  wireProvenance(slot);
}

async function quickLog() {
  const inp = document.querySelector("#qlInput");
  const text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  const wrap = view.querySelector("#qlRecent");
  let a;
  try {
    a = await api("/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) { toast("Failed"); return; }
  if (a && a.error) { toast("Failed"); return; }
  toast("Logged");

  // Instant feedback: show the regex result at the top of Recent right away.
  if (wrap) {
    const head = wrap.querySelector(".ql-recent-h") ? "" : `<div class="ql-recent-h lbl">Recent</div>`;
    wrap.insertAdjacentHTML("afterbegin", head + actEntryHtml(a));
  }

  // A logged activity is movement — refresh the Brief so it reflects the day. This
  // re-renders Today once the recomputed (agentic) read is ready; the entry above
  // persists (rebuilt from server state). reshapeToday bumps pollToken, retiring any
  // prior poll, so resume enrichment polling against the fresh DOM afterward.
  await reshapeToday();
  if (state.tab === "today" && a && a.id && enrichmentActive(a.enrichment_status)) {
    const tab = state.tab, token = pollToken;
    pollEnrichment("/activities", a.id, {
      tab, token,
      onUpdate: (row) => {
        const el = view.querySelector(`.qlent[data-actid="${row.id}"]`);
        if (el) updateActEntry(el, row);
      },
    });
  }
}

function setupWeightChip() {
  const chip = view.querySelector("#wtChip");          // compass tile (in the week fold)
  const mini = view.querySelector("#wtChipMini");      // always-on capture-row chip
  const inline = view.querySelector("#wtInline");
  const input = view.querySelector("#wtInlineInput");
  const go = view.querySelector("#wtInlineGo");
  if (!inline || !input) return;
  const toggle = () => {
    inline.hidden = !inline.hidden;
    if (!inline.hidden) { input.focus(); input.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" }); }
  };
  if (chip) chip.addEventListener("click", toggle);
  if (mini) mini.addEventListener("click", toggle);
  const save = async () => {
    const w = +input.value;
    if (!w) { input.focus(); return; }
    try {
      await api("/bodyweight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weight_lb: w }) });
    } catch { toast("Failed"); return; }
    const valEl = chip && chip.querySelector("[data-wtval]");
    if (valEl) valEl.innerHTML = `${w}<span class="stat-plus">+</span>`;
    if (mini) mini.innerHTML = `${w}<span class="wt-mini-unit">lb</span><span class="stat-plus">+</span>`;
    input.value = ""; inline.hidden = true;
    toast("Weight logged");
  };
  if (go) go.addEventListener("click", save);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

// ---------- effortless capture: voice (Web Speech), frequents, check-in ----------
// Inline mic glyph — static SVG, no caller text, safe for innerHTML.
const MIC_GLYPH = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>`;

// Feature-detect once. Absent (e.g. Firefox/older Safari) → the mic stays hidden.
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let _voiceRec = null; // live recognition instance while listening

// Press-to-talk dictation into #qlInput. The transcript (interim + final) flows
// through the SAME quicklog routing as typed text — say "ran 50 easy" and it
// logs exactly like typing it. Degrades to text-only where speech is absent.
function setupVoiceCapture() {
  const mic = view.querySelector("#qlMic");
  const inp = view.querySelector("#qlInput");
  if (!mic || !inp) return;
  if (!SpeechRec) { mic.hidden = true; return; } // no API → no broken control
  mic.hidden = false;

  const stop = () => {
    if (_voiceRec) { try { _voiceRec.stop(); } catch {} _voiceRec = null; }
    mic.classList.remove("qlmic-live");
  };

  mic.addEventListener("click", () => {
    if (_voiceRec) { stop(); return; }          // tap again to stop early
    let rec;
    try { rec = new SpeechRec(); } catch { mic.hidden = true; return; }
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    // remember what was already typed so dictation appends, never clobbers
    const base = inp.value.trim();
    let finalText = "";
    let heard = false; // only auto-log when speech was actually captured
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      const said = (finalText + interim).trim();
      if (said) heard = true;
      inp.value = (base ? base + " " : "") + said;
    };
    rec.onerror = (e) => {
      // permission denial / no-speech / network — all handled quietly, no toast spam
      if (e && (e.error === "not-allowed" || e.error === "service-not-allowed")) {
        mic.hidden = true; // user said no; don't keep offering a control that won't work
      }
      heard = false; // an error means nothing usable was dictated
      stop();
    };
    rec.onend = () => {
      mic.classList.remove("qlmic-live");
      _voiceRec = null;
      // a finished phrase logs through the normal path, just like Enter
      if (heard && inp.value.trim()) quickLog();
    };
    _voiceRec = rec;
    mic.classList.add("qlmic-live");
    try { rec.start(); } catch { stop(); }
  });
}

// hour → meal slot, used both to label the re-logged food and to query frequents
function mealForHour(h) {
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 18) return "snack";
  return "dinner";
}

// One-tap re-log of the foods most often eaten near this time of day. The chip
// POSTs the summary to /food-notes; enrichment polling then upgrades it in place.
// Quiet by default: nothing renders if there are no frequents.
async function loadFrequentFoods() {
  const wrap = view.querySelector("#freqFoods");
  if (!wrap) return;
  const hour = new Date().getHours();
  let foods = [];
  try { foods = await api("/frequent-foods?hour=" + hour); } catch { foods = []; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  if (!Array.isArray(foods) || !foods.length) { wrap.innerHTML = ""; return; }
  const chips = foods.slice(0, 6).map((f) => {
    const summary = String(f.summary || "").trim();
    if (!summary) return "";
    const kcal = f.kcal != null ? `<span class="freq-chip-kcal">${Math.round(Number(f.kcal))}</span>` : "";
    return `<button class="freq-chip" data-freq="${escAttr(summary)}">
        <span class="freq-chip-art">${art("food", summary)}</span>
        <span class="freq-chip-name">${escHtml(summary)}</span>${kcal}
      </button>`;
  }).join("");
  if (!chips) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<div class="freq-head lbl">Usual around now</div>
    <div class="freq-chips">${chips}</div>`;
  wrap.querySelectorAll("[data-freq]").forEach((b) =>
    b.addEventListener("click", () => relogFrequent(b.dataset.freq, b)));
}

let _relogInFlight = false;
async function relogFrequent(summary, chip) {
  if (_relogInFlight || !summary) return;
  _relogInFlight = true;
  if (chip) chip.classList.add("freq-chip-busy");
  const meal = mealForHour(new Date().getHours());
  let f = null;
  try {
    f = await api("/food-notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meal, text: summary }),
    });
  } catch { f = null; }
  _relogInFlight = false;
  if (chip) chip.classList.remove("freq-chip-busy");
  if (!f || f.error) { toast("Failed"); return; }
  toast("Logged · " + meal);
  // poll the enrichment upgrade quietly (no visible row on Today; the meal lives in Plan → Meals)
  if (f.id && enrichmentActive(f.enrichment_status)) {
    pollEnrichment("/food-notes", f.id, { tab: state.tab, token: pollToken });
  }
}

// ---------- optional how-you-feel (offered, never required) ----------
// A subtle, dismissible 1–5 mood/energy tap. If a check-in already exists for
// today it shows as a calm "noted" line; otherwise a small "how are you feeling?"
// affordance that expands on tap. Feeds the Brief's day-read; never nags.
async function loadCheckin() {
  const slot = view.querySelector("#checkinSlot");
  if (!slot) return;
  let existing = null;
  try { existing = await api("/checkins?date=" + localISO()); } catch { existing = null; }
  if (state.tab !== "today" || !slot.isConnected) return;
  if (existing && (existing.mood != null || existing.energy != null)) {
    renderCheckinDone(slot, existing);
    return;
  }
  // collapsed by default — one quiet line, opt-in
  slot.innerHTML = `<button class="checkin-open" id="checkinOpen" type="button">
      <span class="checkin-open-dot" aria-hidden="true"></span>
      how are you feeling?
    </button>`;
  const open = slot.querySelector("#checkinOpen");
  if (open) open.addEventListener("click", () => renderCheckinForm(slot));
}

const FEEL_FACES = ["·", "◦", "○", "◍", "●"]; // 1→5, quiet glyphs, no emoji
function feelScale(kind, label) {
  const dots = FEEL_FACES.map((g, i) =>
    `<button class="feel-dot" data-feel="${kind}" data-val="${i + 1}" aria-label="${escAttr(label + " " + (i + 1))}">${g}</button>`
  ).join("");
  return `<div class="feel-row"><span class="feel-lbl lbl">${escHtml(label)}</span><div class="feel-dots">${dots}</div></div>`;
}

function renderCheckinForm(slot) {
  slot.innerHTML = `<div class="checkin-form chip-in">
      ${feelScale("mood", "mood")}
      ${feelScale("energy", "energy")}
      <button class="checkin-dismiss" id="checkinDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
  const picked = {};
  slot.querySelectorAll(".feel-dot").forEach((b) =>
    b.addEventListener("click", async () => {
      const kind = b.dataset.feel, val = Number(b.dataset.val);
      picked[kind] = val;
      // highlight selected + everything below it (a 1–5 scale fill)
      slot.querySelectorAll(`.feel-dot[data-feel="${kind}"]`).forEach((d) =>
        d.classList.toggle("feel-dot-on", Number(d.dataset.val) <= val));
      try {
        const saved = await api("/checkins", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mood: picked.mood, energy: picked.energy }),
        });
        if (saved && !saved.error) {
          renderCheckinDone(slot, saved);
          toast("Noted");
          reshapeToday(); // a fresh check-in can shift today's read — reflect it now
        }
      } catch { /* silent — it's optional */ }
    }));
  const dismiss = slot.querySelector("#checkinDismiss");
  if (dismiss) dismiss.addEventListener("click", () => { slot.innerHTML = ""; });
}

function renderCheckinDone(slot, c) {
  const parts = [];
  if (c.mood != null) parts.push(`mood ${Number(c.mood)}/5`);
  if (c.energy != null) parts.push(`energy ${Number(c.energy)}/5`);
  if (!parts.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="checkin-done chip-in"><span class="checkin-done-mark" aria-hidden="true">✓</span> ${escHtml(parts.join(" · "))}</div>`;
}

// ---------- quiet insight card (pull, never push; one at a time) ----------
// Surfaces the first of GET /api/insights as a calm card under the Brief. On
// view we mark it seen; thumbs up/down record feedback. Empty list → nothing.
async function loadInsightCard() {
  const slot = view.querySelector("#insightSlot");
  if (!slot) return;
  let list = [];
  try { list = await api("/insights"); } catch { list = []; }
  if (state.tab !== "today" || !slot.isConnected) return;
  let ins = Array.isArray(list) && list.length ? list[0] : null;
  if (!ins) {
    slot.innerHTML = ""; // quiet by default — no empty-state nag
    // Pull-based producer: nothing scheduled writes insights, so when the stream
    // is empty, opportunistically ask the agent to look for ONE — gated to at most
    // once per ~20h so opening Today never spams the agent. Never a push.
    ins = await maybeGenerateInsight();
    if (!ins || state.tab !== "today" || !slot.isConnected) return;
  }
  renderInsightCard(slot, ins);
  // mark seen on view (fire-and-forget; only when still new)
  if (ins.status === "new") {
    api(`/insights/${ins.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "seen" }),
    }).catch(() => {});
  }
}

// Opportunistic, gated insight generation — the pull-based producer for the Brief
// insight card. At most ~once per 20h (the agent "looking" — ok:true or ok:false
// — burns the gate; a network error does not, so a transient failure retries on
// the next open). Returns the new insight, or null when there's nothing to say.
async function maybeGenerateInsight() {
  try {
    const last = Number(localStorage.getItem("cairn:lastInsightGen") || 0);
    if (Date.now() - last < 20 * 3600 * 1000) return null;
    const r = await api("/insights/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    localStorage.setItem("cairn:lastInsightGen", String(Date.now()));
    return r && r.ok && r.insight ? r.insight : null;
  } catch { return null; }
}

// The card leads with the headline (the one thing to read), renders an optional
// concrete suggestion as its own scannable line, and tucks the reasoning behind a
// quiet "why this" disclosure — same calm idiom as the Brief's "tap to see why",
// so the card is a glance with depth on demand, never a wall of text on open.
function renderInsightCard(slot, ins) {
  const text = escHtml(String(ins.text || ""));
  const step = String(ins.next_step || "").trim();
  const why = String(ins.rationale || "").trim();
  const kicker = ins.kind === "weekly_read" ? "This week" : "A connection worth noting";
  const up = ins.feedback === "up";
  slot.innerHTML = `<section class="insight-card settle-in">
      <div class="insight-kicker lbl"><span class="insight-glyph" aria-hidden="true">✦</span> ${kicker}</div>
      <p class="insight-text">${text}</p>
      ${step ? `<p class="insight-step"><span class="insight-step-lbl">Worth trying</span>${escHtml(step)}</p>` : ""}
      ${why ? `<p class="insight-why" hidden>${escHtml(why)}</p>` : ""}
      <div class="insight-foot">
        <div class="insight-thumbs">
          <button class="insight-thumb ${up ? "insight-thumb-on" : ""}" data-ifb="up" aria-label="Helpful" title="Helpful">▲</button>
          <button class="insight-thumb" data-ifb="down" aria-label="Not useful" title="Not useful">▼</button>
        </div>
        ${why ? `<button class="insight-why-more" data-iwhy aria-expanded="false">why this</button>` : ""}
      </div>
    </section>`;
  slot.querySelectorAll("[data-ifb]").forEach((b) =>
    b.addEventListener("click", () => insightFeedback(slot, ins, b.dataset.ifb)));
  const whyBtn = slot.querySelector("[data-iwhy]");
  const whyEl = slot.querySelector(".insight-why");
  if (whyBtn && whyEl) {
    whyBtn.addEventListener("click", () => {
      const opening = whyEl.hidden;
      whyEl.hidden = !opening;
      if (opening) { whyEl.classList.remove("chip-in"); void whyEl.offsetWidth; whyEl.classList.add("chip-in"); }
      whyBtn.setAttribute("aria-expanded", String(opening));
      whyBtn.textContent = opening ? "hide" : "why this";
    });
  }
}

async function insightFeedback(slot, ins, dir) {
  if (dir === "up") {
    const upBtn = slot.querySelector('[data-ifb="up"]');
    if (upBtn) upBtn.classList.add("insight-thumb-on");
    api(`/insights/${ins.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "up" }),
    }).catch(() => {});
    toast("Noted — I'll remember");
    return;
  }
  // thumbs down → dismiss: it drops out of the list. Gentle collapse, no toast.
  const card = slot.querySelector(".insight-card");
  api(`/insights/${ins.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "dismissed" }),
  }).catch(() => {});
  if (card) collapseEl(card, () => { slot.innerHTML = ""; });
  else slot.innerHTML = "";
}

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

// Shared premium line chart: monotone-cubic curve, soft gradient area fill, light
// gridlines with y labels, first/last date x labels, emphasized final point with
// an ink value badge, optional sage dashed goal line and \u25b2 at the all-time peak.
function drawLineChart(canvas, pts, opts = {}) {
  if (!canvas) return;
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
    c.strokeStyle = "rgba(216,207,189,.55)"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(padL, yy); c.lineTo(W - padR, yy); c.stroke();
    c.fillStyle = "#a89f8d";
    c.textAlign = "right";
    c.fillText(String(Math.round(v)), padL - 7, yy + 3);
  }
  c.textAlign = "left";

  // goal reference line (sage, dashed)
  if (opts.goal != null) {
    const gy = y(opts.goal);
    c.save();
    c.strokeStyle = "#6e7f5c"; c.setLineDash([5, 5]); c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(padL, gy); c.lineTo(W - padR, gy); c.stroke();
    c.restore();
    c.fillStyle = "#6e7f5c"; c.font = "600 9px 'Schibsted Grotesk', sans-serif";
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
    grad.addColorStop(0, "rgba(180,85,45,.16)");
    grad.addColorStop(1, "rgba(180,85,45,0)");
    c.fillStyle = grad; c.fill();
    // the line itself
    tracePath();
    c.strokeStyle = "#b4552d"; c.lineWidth = 2.25; c.lineJoin = "round"; c.lineCap = "round";
    c.stroke();
    // quiet intermediate points
    c.fillStyle = "#b4552d";
    for (let i = 0; i < n - 1; i++) { c.beginPath(); c.arc(xs[i], ys[i], 2, 0, 7); c.fill(); }
  }

  // \u25b2 at the all-time peak (when it isn't the final point)
  if (opts.peak && n > 1) {
    let pi = 0; vals.forEach((v, i) => { if (v > vals[pi]) pi = i; });
    if (pi !== n - 1) {
      c.fillStyle = "#c9a86a"; c.font = "10px 'Schibsted Grotesk', sans-serif"; c.textAlign = "center";
      c.fillText("\u25b2", xs[pi], ys[pi] - 9);
      c.textAlign = "left";
    }
  }

  // emphasized final point + ink value badge
  const lx = xs[n - 1], ly = ys[n - 1];
  c.beginPath(); c.arc(lx, ly, 8, 0, 7); c.fillStyle = "rgba(180,85,45,.16)"; c.fill();
  c.beginPath(); c.arc(lx, ly, 4.5, 0, 7); c.fillStyle = "#b4552d"; c.fill();
  c.beginPath(); c.arc(lx, ly, 4.5, 0, 7); c.strokeStyle = "#fffdf8"; c.lineWidth = 1.6; c.stroke();
  const lastTxt = fmtVal(vals[n - 1]);
  c.font = "600 11px 'Schibsted Grotesk', sans-serif";
  const tw = c.measureText(lastTxt).width;
  const bx = Math.min(Math.max(lx - tw / 2 - 8, padL), W - padR - tw - 16);
  let by = ly - 32; if (by < 4) by = ly + 14;
  c.fillStyle = "#211d17";
  if (c.roundRect) { c.beginPath(); c.roundRect(bx, by, tw + 16, 20, 10); c.fill(); }
  else c.fillRect(bx, by, tw + 16, 20);
  c.fillStyle = "#f4efe7";
  c.fillText(lastTxt, bx + 8, by + 14);

  // first / last date labels
  c.fillStyle = "#a89f8d"; c.font = "10px 'Schibsted Grotesk', sans-serif";
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
  const tonnage = (s.sets || []).reduce((t, x) => t + (x.weight > 0 && x.reps ? x.weight * x.reps : 0), 0);
  const nSets = (s.sets || []).length;
  const chips = [
    tonnage ? `${fmtK(Math.round(tonnage))} lb` : null,
    s.duration_min ? `${s.duration_min} min` : null,
    `${nSets} set${nSets === 1 ? "" : "s"}`,
  ].filter(Boolean).map((t) => `<span class="hist-chip">${t}</span>`).join("");
  return `<div class="sess hist reveal" style="${stagger(i)}">
      <div class="hist-head">
        <div>
          <div class="hist-kicker lbl">${fmtShortDate(s.date)}${s.day_name ? ` \u00b7 ${escHtml(s.day_name)}` : ""}</div>
          <div class="hist-day">${escHtml(weekday)}</div>
        </div>
        <div class="hist-chips">${chips}</div>
      </div>
      ${lines || `<div class="hist-line"><span class="hist-ex" style="color:var(--muted)">No sets</span></div>`}
      ${s.notes ? `<div class="hist-notes">\u201c${escHtml(s.notes)}\u201d</div>` : ""}
    </div>`;
}

async function renderHistory() {
  headerTitle.textContent = "Progress";
  view.innerHTML = segSkeleton("sessions", PROGRESS_SEG, 3); // skeleton-first: seg paints now, cards hydrate
  const sessions = await api("/sessions?limit=30");
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
  const t30 = last30.reduce((t, s) => t + (s.sets || []).reduce((tt, x) => tt + (x.weight > 0 && x.reps ? x.weight * x.reps : 0), 0), 0);
  const sets30 = last30.reduce((t, s) => t + (s.sets || []).length, 0);
  const hero = progressHero("Training history", [
    ["sessions this month", inMonth],
    ["lb moved \u00b7 30d", Math.round(t30), { k: true }],
    ["sets \u00b7 30d", sets30],
  ]);
  view.innerHTML = head + hero + sessions.map((s, i) => sessionCardHtml(s, i + 1)).join("");
  wireSeg(PROGRESS_HANDLERS);
  runCountUps(view);
}

// ---------- Progress: est-1RM trend ----------
async function renderProgress() {
  headerTitle.textContent = "Progress";
  view.innerHTML = segSkeleton("trend", PROGRESS_SEG, 1);
  const exercises = await api("/exercises");
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
async function renderWeight() {
  headerTitle.textContent = "Progress";
  view.innerHTML = segSkeleton("weight", PROGRESS_SEG, 1);
  const [rows, profile] = await Promise.all([api("/bodyweight?limit=90"), api("/profile")]);
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
async function renderVolume() {
  headerTitle.textContent = "Progress";
  view.innerHTML = segSkeleton("volume", PROGRESS_SEG, 2);
  const data = await api("/volume?days=30");
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

async function renderCalendar() {
  headerTitle.textContent = "Progress";
  view.innerHTML = segSkeleton("calendar", PROGRESS_SEG, 2);
  const [data, stats] = await Promise.all([api("/calendar?days=84"), api("/stats").catch(() => ({}))]);
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

async function renderEnergy() {
  headerTitle.textContent = "Progress";
  const head = segBar("energy", PROGRESS_SEG);
  view.innerHTML = head + `<div id="energyHero"></div>
    <div id="energyCard">${loadingState("Reading your trend…")}</div>
    <div id="checkinResult" class="checkin-result"></div>`;
  wireSeg(PROGRESS_HANDLERS);

  let exp = null;
  try { exp = await api("/nutrition/expenditure?window=21"); } catch { exp = null; }
  if (state.tab !== "progress" || !view.querySelector("#energyCard")) return; // navigated away

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
async function runNutritionCheckin(btn) {
  const out = view.querySelector("#checkinResult");
  if (!out) return;
  const restore = btnBusy(btn, "Checking…");
  out.innerHTML = `<div class="eb-checking lbl"><span class="aspin aspin-xs"></span> reading your trend…</div>`;
  let r = null;
  try {
    r = await api("/nutrition/checkin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ window: 21 }),
    });
  } catch { r = null; }
  if (!view.querySelector("#checkinResult")) return; // navigated away
  restore();

  if (!r || r.ok === false || r.error) {
    out.innerHTML = `<div class="eb-checkin-quiet">Couldn't run a check-in right now — no worries, your read above still stands. Try again in a bit.</div>`;
    return;
  }
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

// ---------- Coach ----------
async function renderCoach() {
  headerTitle.textContent = "Coach";
  view.innerHTML = segSkeleton("coach", PLAN_SEG, 2);
  const agents = await api("/agents");
  const proposals = await api("/proposals?limit=10");
  const agentOpts =
    `<option value="auto">⟳ Auto · rotate enabled agents</option>` +
    agents.map((a) =>
      `<option value="${a.name}"${a.enabled ? "" : " disabled"}>${a.name}${a.enabled ? "" : " (off)"}${a.env_ok ? "" : " · no key"}</option>`
    ).join("");

  view.innerHTML = segBar("coach", PLAN_SEG) + `
    <div class="field"><label>Agent</label>
      <select id="agentsel">${agentOpts || "<option>none configured</option>"}</select></div>
    <div class="field"><label>Instruction (optional)</label>
      <select id="presetsel">
        <option value="">Review recent sessions, propose next-week targets</option>
        <option value="Only adjust lower-body lifts; hold everything else.">Lower body only</option>
        <option value="Be extra conservative; I felt beat up this week.">Extra conservative</option>
        <option value="custom">Custom\u2026</option>
      </select></div>
    <div class="field" id="customwrap" style="display:none">
      <textarea id="custominstr" rows="3" style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:11px;font-size:.9rem" placeholder="Tell the coach what to focus on\u2026"></textarea>
    </div>
    <button id="runbtn" class="logbtn" style="width:100%;height:46px;font-size:1rem;letter-spacing:.05em">DRAFT PLAN UPDATE</button>
    <div id="runstatus" style="margin-top:10px;color:var(--muted);font-size:.85rem"></div>
    <button id="mealbtn" class="draftbtn" style="width:100%;height:46px;font-size:1rem;margin-top:14px;letter-spacing:.05em">DRAFT WEEKLY MEAL PLAN</button>
    <div id="mealstatus" style="margin-top:10px;color:var(--muted);font-size:.85rem"></div>
    <h1 class="lbl" style="margin:24px 0 8px">Proposals</h1>
    <div id="proplist"></div>
    <h1 class="lbl" style="margin:24px 0 8px">Meal plans</h1>
    <div id="meallist"></div>`;

  wireSeg(PLAN_HANDLERS);
  $("#presetsel").addEventListener("change", (e) => {
    $("#customwrap").style.display = e.target.value === "custom" ? "block" : "none";
  });
  $("#runbtn").addEventListener("click", runCoach);
  $("#mealbtn").addEventListener("click", runMealPlan);
  renderProposals(proposals);
  renderMealPlans(await api("/mealplans?limit=8"));
}

function instructionValue() {
  const preset = $("#presetsel").value;
  if (preset === "custom") return $("#custominstr").value.trim();
  return preset;
}

async function runCoach() {
  const agent = $("#agentsel").value;
  const status = $("#runstatus");
  const btn = $("#runbtn");
  btn.disabled = true; btn.style.opacity = ".6";
  status.textContent = `Running ${agent}\u2026 this can take 10\u201360s.`;
  try {
    const r = await api("/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, instruction: instructionValue() }),
    });
    if (r.error) { status.textContent = "Error: " + r.error; }
    else if (!r.ok) { status.textContent = "Agent ran but returned no valid JSON. See raw output below."; }
    else { status.textContent = "Draft ready \u2014 review below."; }
    const proposals = await api("/proposals?limit=10");
    renderProposals(proposals);
  } catch (e) {
    status.textContent = "Request failed: " + e.message;
  } finally {
    btn.disabled = false; btn.style.opacity = "1";
  }
}

// Shared status chip for proposals + meal plans (mp-badge per contract).
function statusBadge(status) {
  const cls = status === "accepted" || status === "applied" || status === "kept" ? "ok"
    : status === "discarded" ? "off" : "draft";
  return `<span class="mp-badge ${cls}">${escHtml(status || "draft")}</span>`;
}

function renderProposals(proposals) {
  const wrap = $("#proplist");
  if (!proposals.length) { wrap.innerHTML = `<div class="empty">No proposals yet.</div>`; return; }
  wrap.innerHTML = proposals.map((p, pi) => {
    const parsed = p.parsed;
    const changes = parsed && Array.isArray(parsed.changes) ? parsed.changes : [];
    const body = parsed
      ? `<div class="sess-line">${escHtml(parsed.summary || "")}</div>` +
        changes.map((c) => `<div class="sess-line"><b>D${c.day_number} ${escHtml(c.exercise)}</b> \u2192 <span class="numeral">${escHtml(c.target_weight)}</span> <span style="color:var(--muted)">(${escHtml(c.reason || "")})</span></div>`).join("") +
        (parsed.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(parsed.notes)}</div>` : "")
      : `<div class="sess-line" style="color:var(--warn)">Unparseable output</div><div class="sess-line" style="color:var(--muted);font-size:.78rem">${escHtml((p.raw_output || "").slice(0, 200))}\u2026</div>`;
    const actions = p.status === "draft" && changes.length
      ? `<div class="logrow" style="margin-top:10px"><button class="logbtn" style="width:auto;padding:0 14px;font-size:.85rem" data-apply="${p.id}">APPLY</button>
         <button class="ghostbtn" style="width:auto;padding:0 14px" data-discard="${p.id}">DISCARD</button></div>`
      : "";
    return `<div class="mp-card reveal" style="${stagger(pi)}">
      <div class="mp-hero">
        <span class="lbl">${escHtml(p.agent)} \u00b7 #${p.id} \u00b7 ${escHtml(p.created_at || "")}</span>
        ${statusBadge(p.status)}
      </div>
      ${body}${actions}</div>`;
  }).join("");

  wrap.querySelectorAll("[data-apply]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/proposals/${b.dataset.apply}/apply`, { method: "POST" });
      toast("Applied"); state.plan = []; renderCoach();
    })
  );
  wrap.querySelectorAll("[data-discard]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/proposals/${b.dataset.discard}/discard`, { method: "POST" });
      renderCoach();
    })
  );
}

// ---------- meal plans ----------
async function runMealPlan() {
  const agent = $("#agentsel").value;
  const status = $("#mealstatus");
  const btn = $("#mealbtn");
  const restore = btnBusy(btn, "Drafting\u2026");
  status.textContent = `Drafting meal plan with ${agent}\u2026 10\u201360s.`;
  try {
    const r = await api("/coach/mealplan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, instruction: instructionValue() }),
    });
    status.textContent = r.error ? "Error: " + r.error : (r.ok ? "Meal plan ready." : "Ran but returned no valid JSON.");
    renderMealPlans(await api("/mealplans?limit=8"));
  } catch (e) { status.textContent = "Failed: " + e.message; }
  finally { restore(); }
}

// One meal row: studio food art | name + items | macros column.
// When `opts` ({di, count}) is passed (the weekly planner), the row also carries
// Swap + ▲▼ reorder controls and is followed by a hidden inline swap panel.
const MEAL_HINT_CHIPS = ["Fish", "Chicken", "Beef", "Veggie", "Lighter", "Bigger", "Quick to make"];
function mealRowHtml(x, mi, opts) {
  const items = Array.isArray(x.items) ? x.items.join(", ") : (x.items || "");
  const q = `${x.name || x.meal || ""} ${items}`.trim();
  const tile = artImg("food", q, "artile-md meal-art", art("food", q));
  const figs = [["P", x.protein_g], ["C", x.carbs_g], ["F", x.fat_g]]
    .filter(([l, v]) => v != null && v !== "" && (l === "P" || Number(v) > 0))
    .map(([l, v]) => `<span class="lbl">${l} ${escHtml(String(v))}</span>`).join("");
  // mi (meal index within the day) marks planner rows as loggable: "I ate this"
  // writes the planned meal straight into the food journal with its macros.
  const loggable = typeof mi === "number";
  const planner = loggable && opts && typeof opts.di === "number";
  const logBtn = loggable ? `<button class="meal-log" data-mlog="${escAttr(JSON.stringify({
    name: x.name || x.meal || "", items, kcal: x.kcal ?? null,
    protein_g: x.protein_g ?? null, carbs_g: x.carbs_g ?? null, fat_g: x.fat_g ?? null, i: mi,
  }))}">+ Log it</button>` : "";
  const tools = planner
    ? `<div class="meal-rowtools">${logBtn}<button class="meal-swapbtn" data-mswap aria-label="Swap this meal">⇄ Swap</button><span class="meal-mvgrp"><button class="meal-mv" data-mv="-1" aria-label="Move up" ${mi === 0 ? "disabled" : ""}>▲</button><button class="meal-mv" data-mv="1" aria-label="Move down" ${mi >= opts.count - 1 ? "disabled" : ""}>▼</button></span></div>`
    : logBtn;
  const row = `<div class="meal-row"${planner ? ` data-di="${opts.di}" data-mi="${mi}"` : ""}>
      ${tile}
      <div class="meal-main">
        <div class="meal-name">${escHtml(x.name || x.meal || "")}</div>
        ${items ? `<div class="meal-items">${escHtml(items)}</div>` : ""}
        ${tools}
      </div>
      <div class="meal-macros">
        ${x.kcal ? `<span class="numeral">${escHtml(String(x.kcal))}</span>` : ""}
        ${figs}
      </div>
    </div>`;
  if (!planner) return row;
  return row + `<div class="meal-swap" hidden data-di="${opts.di}" data-mi="${mi}">
      <input class="meal-swap-hint" type="text" maxlength="140" placeholder="Optional hint — fish, lighter, quick…">
      <div class="meal-swap-chips">${MEAL_HINT_CHIPS.map((h) =>
        `<button type="button" class="chip hintchip" data-hint="${escAttr(h)}">${escHtml(h)}</button>`).join("")}</div>
      <div class="meal-swap-actions">
        <button type="button" class="pillbtn pill-accent meal-swap-go">Swap it</button>
        <button type="button" class="pillbtn meal-swap-cancel">Cancel</button>
      </div>
    </div>`;
}

// Planned meal → journal entry. Meal slot comes from the name when it's a
// conventional one, else from its position in the day.
function mealSlotFor(name, i) {
  const n = (name || "").toLowerCase();
  for (const s of ["breakfast", "lunch", "dinner", "snack"]) if (n.includes(s)) return s;
  return ["breakfast", "lunch", "dinner"][i] || "snack";
}

function renderMealPlans(plans, sel = "#meallist", refresh = null) {
  const wrap = $(sel);
  if (!wrap) return;
  if (!plans.length) { wrap.innerHTML = `<div class="empty">No meal plans yet.</div>`; return; }
  wrap.innerHTML = plans.map((p, pi) => {
    const m = p.parsed;
    let hero, body;
    if (m) {
      hero = `<div class="mp-hero">
          <div class="mp-hero-head">
            <span class="lbl">${escHtml(p.agent)} \u00b7 #${p.id}</span>
            ${statusBadge(p.status)}
          </div>
          <div class="mp-hero-nums">
            <div class="mp-hero-kcal">
              <span class="numeral numeral-xl">${escHtml(String(m.daily_kcal ?? "?"))}</span>
              <span class="lbl">kcal per day</span>
            </div>
            <div class="mp-hero-protein">
              <span class="numeral numeral-lg">${escHtml(String(m.daily_protein_g ?? "?"))}g</span>
              <span class="lbl">protein</span>
            </div>
          </div>
          ${m.summary ? `<div class="sess-line">${escHtml(m.summary)}</div>` : ""}
        </div>`;
      const dayDetail = Array.isArray(m.days) ? m.days.map((d) => {
        const meals = (d.meals || []).map((mm) => mealRowHtml(mm)).join("");
        return `<div class="mp-day"><div class="mp-dayname">${escHtml(d.day || "")}</div>${meals || `<div class="sess-line" style="color:var(--muted)">No meals</div>`}</div>`;
      }).join("") : "";
      body = dayDetail + (m.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(m.notes)}</div>` : "");
    } else {
      hero = `<div class="mp-hero">
          <div class="mp-hero-head">
            <span class="lbl">${escHtml(p.agent)} \u00b7 #${p.id}</span>
            ${statusBadge(p.status)}
          </div>
        </div>`;
      body = `<div class="sess-line" style="color:var(--warn)">Unparseable output</div>`;
    }
    const actions = p.status === "draft"
      ? `<div class="logrow" style="margin-top:10px"><button class="logbtn" style="width:auto;padding:0 14px;font-size:.85rem" data-accept="${p.id}">ACCEPT</button>
         <button class="ghostbtn" style="width:auto;padding:0 14px" data-discard="${p.id}">DISCARD</button></div>`
      : "";
    return `<div class="mp-card reveal" style="${stagger(pi)}">
      ${hero}${body}${actions}</div>`;
  }).join("");

  wrap.querySelectorAll("[data-accept]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.accept}/accept`, { method: "POST" });
      toast("Meal plan accepted");
      if (refresh) refresh(); else renderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
  wrap.querySelectorAll("[data-discard]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.discard}/discard`, { method: "POST" });
      toast("Discarded");
      if (refresh) refresh(); else renderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
}

// ---------- Meals planner (Plan tab · Meals) ----------
// A Morsel-style journal over the current weekly meal plan: big serif day names,
// floating food art, per-meal macro chips, per-day totals. The classic mp-card
// list survives as a collapsed history beneath it.
const MEAL_PREFS_PLACEHOLDER = "Tell the coach how you train & eat — e.g. fasted morning training, simple prep on busy days";
const MEAL_PREF_CHIPS = ["Fasted AM training", "Train before lunch some days", "Simple prep, busy weekdays", "More fish, less red meat"];

// Collapsed-by-default "Planning preferences" card: shows the saved meal_prefs (or a
// muted placeholder); expands into a textarea + quick-insert chips. Edits surface
// the shared floating save bar (PUT /settings) — see wireMealPrefs().
function mealPrefsHtml(prefs, idx) {
  return `<div class="mealprefs reveal" style="${stagger(idx)}" id="mealPrefs">
      <button type="button" class="mealprefs-head" id="mealPrefsToggle" aria-expanded="false">
        <span class="lbl">Planning preferences<span class="mealprefs-caret">▾</span></span>
        <span class="mealprefs-preview${prefs ? "" : " mealprefs-placeholder"}">${escHtml(prefs || MEAL_PREFS_PLACEHOLDER)}</span>
      </button>
      <div class="mealprefs-body" hidden>
        <textarea id="mealPrefsText" rows="3" placeholder="${escAttr(MEAL_PREFS_PLACEHOLDER)}">${escHtml(prefs)}</textarea>
        <div class="mealprefs-chips">${MEAL_PREF_CHIPS.map((c) =>
          `<button type="button" class="chip prefchip" data-pref="${escAttr(c)}">${escHtml(c)}</button>`).join("")}</div>
      </div>
    </div>`;
}

function wireMealPrefs() {
  const card = view.querySelector("#mealPrefs");
  if (!card) return;
  const head = card.querySelector("#mealPrefsToggle");
  const bodyEl = card.querySelector(".mealprefs-body");
  const ta = card.querySelector("#mealPrefsText");
  head.addEventListener("click", () => {
    const open = bodyEl.hidden;
    bodyEl.hidden = !open;
    card.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
    if (open) ta.focus();
  });
  // floating save bar — the prefs textarea is the only save flow on the Meals
  // view, so the card owns the view's bar (one bar per screen, never two)
  const bar = mountSaveBar({
    sentinel: card,
    fields: bodyEl,
    onSave: async () => {
      const r = await api("/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meal_prefs: ta.value.trim() }),
      });
      if (r && r.error) { toast("Couldn't save preferences"); return false; }
      const v = ta.value.trim();
      const prev = card.querySelector(".mealprefs-preview");
      prev.textContent = v || MEAL_PREFS_PLACEHOLDER;
      prev.classList.toggle("mealprefs-placeholder", !v);
      bodyEl.hidden = true; // collapse back to the preview; the bar flashes Saved
      card.classList.remove("open");
      head.setAttribute("aria-expanded", "false");
      return true;
    },
    onDiscard: () => renderMeals(), // re-render from server state
  });
  card.querySelectorAll("[data-pref]").forEach((c) =>
    c.addEventListener("click", () => {
      const t = c.dataset.pref;
      const cur = ta.value.trim();
      if (cur.toLowerCase().includes(t.toLowerCase())) return; // already in there
      ta.value = cur ? cur.replace(/[.;,]\s*$/, "") + ". " + t : t;
      bar.markDirty(); // programmatic insert fires no input event
      ta.focus();
    })
  );
}

// One planner day section — extracted so swap/reorder can re-render a single day
// in place (data-mday hook). ctx = { weekOf, targetKcal, todayName }.
function mealDayHtml(d, di, ctx) {
  const meals = d.meals || [];
  const kcal = meals.reduce((t, x) => t + (Number(x.kcal) || 0), 0);
  const prot = meals.reduce((t, x) => t + (Number(x.protein_g) || 0), 0);
  const isToday = (d.day || "").toLowerCase().startsWith(ctx.todayName);
  const totals = kcal || prot
    ? `<div class="mealday-total"><span class="numeral" data-cu="${kcal}">0</span><span class="lbl"> cal${prot ? ` · ${prot}g protein` : ""}</span></div>`
    : "";
  // hairline: day total vs the plan's daily target (Morsel's red rule)
  const bar = kcal && ctx.targetKcal
    ? `<div class="mealday-bar"><div class="mealday-bar-fill barfill" style="width:${Math.min(100, Math.round((kcal / ctx.targetKcal) * 100))}%"></div></div>`
    : "";
  return `<section class="mealday${isToday ? " mealday-today" : ""} reveal" style="${stagger(di + 2)}" data-mday="${di}">
      <div class="mealday-head">
        <div><div class="lbl">${isToday ? `<span class="mealday-now">Today</span> · ` : ""}${escHtml(ctx.weekOf)}</div><h2 class="mealday-name">${escHtml(d.day || `Day ${di + 1}`)}</h2></div>
        ${totals}
      </div>
      ${bar}
      <div class="mealday-card">${meals.map((mm, mi) => mealRowHtml(mm, mi, { di, count: meals.length })).join("") || `<div class="empty">No meals</div>`}</div>
      ${d.note ? `<div class="mealday-note">${escHtml(d.note)}</div>` : ""}
    </section>`;
}

// Re-render a single planner day from the in-memory plan (after swap/reorder) —
// regenerates data-* indices, totals, the target bar, and re-runs count-ups.
// settleMi: meal index to flash with the gentle settle highlight.
function rerenderMealDay(current, di, ctx, settleMi = null) {
  const sec = view.querySelector(`.mealday[data-mday="${di}"]`);
  const d = current.parsed?.days?.[di];
  if (!sec || !d) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = mealDayHtml(d, di, ctx);
  const fresh = tmp.firstElementChild;
  fresh.classList.remove("reveal"); // no re-entrance rise on an in-place update
  sec.replaceWith(fresh);
  wireMealRows(fresh, current, ctx);
  runCountUps(fresh);
  if (settleMi != null) fresh.querySelector(`.meal-row[data-mi="${settleMi}"]`)?.classList.add("meal-settled");
}

// Agentic swap of one planned meal — POST /meal-plans/:id/swap runs an external CLI
// agent (15–120s). Row goes busy (non-blocking, the rest of the view stays live);
// one swap in flight at a time; pollToken guards stale renders.
let mealSwapInFlight = false;
async function submitMealSwap(current, ctx, di, mi, panel) {
  if (mealSwapInFlight) { toast("A swap is already running"); return; }
  const day = current.parsed?.days?.[di];
  if (!day) return;
  const hint = panel.querySelector(".meal-swap-hint")?.value.trim() || "";
  const row = panel.previousElementSibling;
  const go = panel.querySelector(".meal-swap-go");
  mealSwapInFlight = true;
  const token = pollToken;
  if (row) row.classList.add("meal-busy");
  panel.classList.add("meal-swap-busy");
  const restoreGo = btnBusy(go, "Asking the coach…", { ghost: true });
  panel.querySelectorAll("button,input").forEach((el) => { if (el !== go) el.disabled = true; });

  // browsers don't time fetch out on their own — belt-and-braces abort at 180s
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let r = null;
  try {
    r = await api(`/meal-plans/${current.id}/swap`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hint ? { day: day.day, meal_index: mi, hint } : { day: day.day, meal_index: mi }),
      signal: ctrl.signal,
    });
  } catch { r = null; } // network error / abort / non-JSON (e.g. a 404 page) → failure
  clearTimeout(timer);
  mealSwapInFlight = false;
  if (token !== pollToken) return; // view re-rendered since — the fresh render owns the DOM

  if (r && r.ok && (r.plan?.parsed || r.meal)) {
    if (r.plan?.parsed) current.parsed = r.plan.parsed; // server copy is the source of truth
    else day.meals[mi] = r.meal;
    rerenderMealDay(current, di, ctx, mi);
    toast("Meal swapped");
  } else {
    if (row && row.isConnected) row.classList.remove("meal-busy");
    panel.classList.remove("meal-swap-busy");
    panel.querySelectorAll("button,input").forEach((el) => { if (el !== go) el.disabled = false; });
    restoreGo();
    toast("Coach couldn't draft a swap — try again");
  }
}

// Move a meal up/down within its day: optimistic re-render, then persist the full
// days array via PUT /meal-plans/:id/days. Revert + toast on failure.
async function moveMealRow(current, ctx, di, mi, dir) {
  const meals = current.parsed?.days?.[di]?.meals;
  const j = mi + dir;
  if (!meals || mi < 0 || mi >= meals.length || j < 0 || j >= meals.length) return;
  const token = pollToken;
  [meals[mi], meals[j]] = [meals[j], meals[mi]];
  rerenderMealDay(current, di, ctx, j); // optimistic — indices regenerate from the array
  try {
    const r = await api(`/meal-plans/${current.id}/days`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: current.parsed.days }),
    });
    if (!r || r.error) throw new Error(r && r.error);
  } catch {
    [meals[mi], meals[j]] = [meals[j], meals[mi]]; // revert in memory
    if (token === pollToken) {
      rerenderMealDay(current, di, ctx);
      toast("Couldn't save order — reverted");
    }
  }
}

// Wire all planner meal-row controls inside `scope`: "+ Log it", the ⇄ Swap panel
// (hint chips + agent call), and ▲▼ reorder. Called for the whole view on render
// and again for each day section rerenderMealDay swaps in.
function wireMealRows(scope, current, ctx) {
  // "+ Log it" — write the planned meal into today's food journal as-is.
  scope.querySelectorAll("[data-mlog]").forEach((b) =>
    b.addEventListener("click", async () => {
      let x; try { x = JSON.parse(b.dataset.mlog); } catch { return; }
      b.disabled = true;
      // plans often name meals by slot ("Breakfast") with the dish in items —
      // the journal entry's title should be the dish, not the slot
      const generic = /^(breakfast|lunch|dinner|snack|pre[- ]?workout|post[- ]?workout)$/i.test((x.name || "").trim());
      const title = generic && x.items ? x.items : (x.name || x.items || "Planned meal");
      try {
        await api("/food-notes", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meal: mealSlotFor(x.name, x.i), raw: "",
            parsed: { summary: title, items: x.items || "", kcal: x.kcal, protein_g: x.protein_g, carbs_g: x.carbs_g, fat_g: x.fat_g },
          }),
        });
        b.textContent = "✓ Logged"; b.classList.add("meal-log-done");
        toast(`${x.name || "Meal"} logged`);
      } catch { b.disabled = false; toast("Couldn't log meal"); }
    })
  );

  // ⇄ Swap — toggle the inline hint panel under the row
  scope.querySelectorAll("[data-mswap]").forEach((b) =>
    b.addEventListener("click", () => {
      const row = b.closest(".meal-row");
      const panel = row?.nextElementSibling;
      if (!panel || !panel.classList.contains("meal-swap") || row.classList.contains("meal-busy")) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector(".meal-swap-hint")?.focus();
    })
  );
  scope.querySelectorAll(".meal-swap-cancel").forEach((b) =>
    b.addEventListener("click", () => { b.closest(".meal-swap").hidden = true; })
  );
  scope.querySelectorAll(".hintchip").forEach((c) =>
    c.addEventListener("click", () => {
      const panel = c.closest(".meal-swap");
      const input = panel.querySelector(".meal-swap-hint");
      const on = c.classList.contains("on");
      panel.querySelectorAll(".hintchip").forEach((x) => x.classList.remove("on"));
      c.classList.toggle("on", !on);
      input.value = on ? "" : c.dataset.hint;
    })
  );
  scope.querySelectorAll(".meal-swap-hint").forEach((i) =>
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); i.closest(".meal-swap").querySelector(".meal-swap-go")?.click(); }
    })
  );
  scope.querySelectorAll(".meal-swap-go").forEach((b) =>
    b.addEventListener("click", () => {
      const panel = b.closest(".meal-swap");
      submitMealSwap(current, ctx, Number(panel.dataset.di), Number(panel.dataset.mi), panel);
    })
  );

  // ▲▼ — move a meal within its day, persist the whole days array
  scope.querySelectorAll(".meal-mv").forEach((b) =>
    b.addEventListener("click", () => {
      const row = b.closest(".meal-row");
      if (!row || row.classList.contains("meal-busy")) return;
      moveMealRow(current, ctx, Number(row.dataset.di), Number(row.dataset.mi), Number(b.dataset.mv));
    })
  );

  // tap a meal row's body → detail bottom sheet (buttons and the swap panel keep their own taps)
  scope.querySelectorAll(".meal-row[data-di]").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, input, a, .meal-swap")) return;
      if (row.classList.contains("meal-busy")) return;
      openMealSheet(current, Number(row.dataset.di), Number(row.dataset.mi));
    })
  );
}

// ---------- meal detail bottom sheet (Plan tab · Meals) ----------
// Tapping a planner meal row opens a bottom sheet: hero food art, macros, and an
// agent-written recipe (cached on the plan by the server once fetched).
let _recipeInFlight = false;

function closeMealSheet(instant) {
  const s = document.querySelector(".sheet");
  if (!s) return;
  document.body.classList.remove("sheet-open");
  if (instant || reducedMotion()) { s.remove(); return; }
  s.classList.remove("sheet-in"); // slide down + fade the backdrop, then remove
  setTimeout(() => s.remove(), 360);
}

function openMealSheet(current, di, mi) {
  closeMealSheet(true);
  const day = current.parsed?.days?.[di];
  const meal = day?.meals?.[mi];
  if (!meal) return;
  const dayLabel = day.day || `Day ${di + 1}`;
  const items = Array.isArray(meal.items) ? meal.items.join(", ") : (meal.items || "");
  const q = `${meal.name || meal.meal || ""} ${items}`.trim(); // EXACTLY the row's art query
  const figs = [["P", meal.protein_g], ["C", meal.carbs_g], ["F", meal.fat_g]]
    .filter(([l, v]) => v != null && v !== "" && (l === "P" || Number(v) > 0))
    .map(([l, v]) => `<span class="sheet-chip"><span class="lbl">${l} ${escHtml(String(v))}g</span></span>`).join("");
  const kcal = meal.kcal
    ? `<span class="sheet-chip sheet-chip-kcal"><span class="numeral">${escHtml(String(meal.kcal))}</span><span class="lbl">cal</span></span>`
    : "";
  const s = document.createElement("div");
  s.className = "sheet";
  s.dataset.key = `${current.id}:${di}:${mi}`;
  s.innerHTML = `
    <div class="sheet-card" role="dialog" aria-modal="true" aria-label="${escAttr(meal.name || meal.meal || "Meal")}">
      <div class="sheet-grab" aria-hidden="true"></div>
      <button class="sheet-x" aria-label="Close">✕</button>
      <div class="sheet-scroll">
        <div class="sheet-hero">${artImg("food", q, "artile-xl sheet-art", art("food", q))}</div>
        <div class="sheet-kicker lbl">${escHtml(dayLabel)}</div>
        <h2 class="sheet-title">${escHtml(meal.name || meal.meal || "Meal")}</h2>
        ${items ? `<div class="sheet-items">${escHtml(items)}</div>` : ""}
        ${kcal || figs ? `<div class="sheet-macros">${kcal}${figs}</div>` : ""}
        <div class="sheet-recipe" data-recipe>${meal.recipe ? recipeHtml(meal.recipe) : recipeCtaHtml()}</div>
      </div>
    </div>`;
  document.body.appendChild(s);
  document.body.classList.add("sheet-open"); // lock body scroll while open
  requestAnimationFrame(() => s.classList.add("sheet-in"));
  s.addEventListener("click", (e) => { if (e.target === s) closeMealSheet(); });
  s.querySelector(".sheet-x").addEventListener("click", () => closeMealSheet());
  wireRecipeCta(s, current, dayLabel, di, mi);
}

function recipeCtaHtml() {
  return `<div class="sheet-section sheet-section-c">
      <div class="lbl">Recipe</div>
      <button class="pillbtn pill-accent sheet-recipe-cta" data-getrecipe>Get the recipe from the coach</button>
      <div class="sheet-recipe-note">Written for this exact meal — can take 15–120s.</div>
    </div>`;
}

// recipe = { summary, time_min, servings, ingredients:[{item,qty}], steps:[], tips:[] }
function recipeHtml(r) {
  if (!r || typeof r !== "object") return "";
  const chips = [
    r.time_min ? `<span class="sheet-chip"><span class="numeral">${escHtml(String(r.time_min))}</span><span class="lbl">min</span></span>` : "",
    r.servings ? `<span class="sheet-chip"><span class="lbl">serves ${escHtml(String(r.servings))}</span></span>` : "",
  ].join("");
  const ings = Array.isArray(r.ingredients) && r.ingredients.length
    ? `<div class="sheet-section"><div class="lbl">Ingredients</div>
        <div class="recipe-ings">${r.ingredients.map((x) => `
          <div class="recipe-ing"><span class="recipe-ing-item">${escHtml(x && typeof x === "object" ? x.item ?? "" : String(x ?? ""))}</span><span class="recipe-ing-qty">${escHtml(x && typeof x === "object" ? x.qty ?? "" : "")}</span></div>`).join("")}</div></div>`
    : "";
  const steps = Array.isArray(r.steps) && r.steps.length
    ? `<div class="sheet-section"><div class="lbl">Method</div>
        <ol class="recipe-steps">${r.steps.map((st) => `<li>${escHtml(String(st))}</li>`).join("")}</ol></div>`
    : "";
  const tips = Array.isArray(r.tips) && r.tips.length
    ? `<div class="sheet-section"><div class="lbl">Tips</div>
        <div class="recipe-tips">${r.tips.map((t) => `<div class="recipe-tip">${escHtml(String(t))}</div>`).join("")}</div></div>`
    : "";
  return `${r.summary ? `<div class="recipe-lede">${escHtml(r.summary)}</div>` : ""}
    ${chips ? `<div class="recipe-meta">${chips}</div>` : ""}
    ${ings}${steps}${tips}`;
}

// POST /meal-plans/:id/recipe — runs an external CLI agent (15–120s). The sheet
// stays open and scrollable; closing it mid-flight is fine (the result is still
// stored into the in-memory plan, the DOM is only touched if the sheet survives).
function wireRecipeCta(sheet, current, dayLabel, di, mi) {
  const btn = sheet.querySelector("[data-getrecipe]");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (_recipeInFlight) { toast("A recipe is already being written"); return; }
    _recipeInFlight = true;
    const key = sheet.dataset.key;
    btnBusy(btn, "Writing the recipe…", { ghost: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000);
    let r = null;
    try {
      r = await api(`/meal-plans/${current.id}/recipe`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: dayLabel, meal_index: mi }),
        signal: ctrl.signal,
      });
    } catch { r = null; } // abort / network / non-JSON (e.g. a 404 page) → failure path
    clearTimeout(timer);
    _recipeInFlight = false;

    if (r && r.ok && r.recipe) {
      // store into the in-memory plan first so it survives rerenders & reopen
      if (r.plan?.parsed) current.parsed = r.plan.parsed;
      else {
        const m = current.parsed?.days?.[di]?.meals?.[mi];
        if (m) m.recipe = r.recipe;
      }
      const live = document.querySelector(`.sheet[data-key="${key}"] [data-recipe]`);
      if (live) {
        live.innerHTML = recipeHtml(r.recipe);
        live.classList.add("meal-settled"); // gentle sage settle flash
      }
    } else {
      const liveSheet = document.querySelector(`.sheet[data-key="${key}"]`);
      const wrap = liveSheet?.querySelector("[data-recipe]");
      if (wrap) {
        wrap.innerHTML = recipeCtaHtml();
        wireRecipeCta(liveSheet, current, dayLabel, di, mi);
      }
      toast("Coach couldn't write the recipe — try again");
    }
  });
}

async function renderMeals() {
  headerTitle.textContent = "Plan";
  pollToken++;
  view.innerHTML = segSkeleton("meals", PLAN_SEG, 3); // skeleton-first: seg paints now, plan hydrates
  const [plansRes, settingsData] = await Promise.all([
    api("/mealplans?limit=12").catch(() => []),
    api("/settings").catch(() => null),
  ]);
  const plans = plansRes || [];
  const mealPrefs = String(settingsData?.settings?.meal_prefs || "");
  const KEPT = ["accepted", "applied", "kept"];
  const current =
    plans.find((p) => KEPT.includes(p.status) && p.parsed) ||
    plans.find((p) => p.status === "draft" && p.parsed) || null;

  let body, ctx = null;
  if (!current) {
    body = `<div class="meals-empty reveal" style="${stagger(0)}">
        <div class="artile artile-xl meals-empty-art">${art("food", "meal plate")}</div>
        <div class="meals-empty-title">No meal plan yet</div>
        <div class="meals-empty-sub">Ask the coach to draft a week of meals built around your training and lean-safe targets.</div>
        <button id="mealDraftBtn" class="logbtn meals-cta">DRAFT WEEKLY MEAL PLAN</button>
        <div id="mealDraftStatus" class="meals-status"></div>
      </div>` + mealPrefsHtml(mealPrefs, 1);
  } else {
    const m = current.parsed;
    const weekOf = current.week_of || (current.created_at || "").slice(0, 10);
    const isDraft = current.status === "draft";
    const days = Array.isArray(m.days) ? m.days : [];
    const targetKcal = Number(m.daily_kcal) || 0;
    const todayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
    ctx = { weekOf, targetKcal, todayName };
    const dayHtml = days.map((d, di) => mealDayHtml(d, di, ctx)).join("");
    const shopChecked = new Set(JSON.parse(localStorage.getItem(`shop:${current.id}`) || "[]"));
    const shopping = Array.isArray(m.shopping) && m.shopping.length
      ? `<div class="detail-section reveal" style="${stagger(days.length + 2)}"><div class="lbl">Shopping</div>
          <div class="shop-chips">${m.shopping.map((s, si) =>
            `<button class="chip shop-chip${shopChecked.has(si) ? " chip-done" : ""}" data-shop="${si}">${escHtml(String(s))}</button>`).join("")}</div></div>`
      : "";
    const actions = isDraft
      ? `<div class="meals-actions">
           <button class="pillbtn pill-accent" data-mkeep="${current.id}">Keep this plan</button>
           <button class="pillbtn" data-mdiscard="${current.id}">Discard</button>
         </div>`
      : "";
    body = `<div class="mealhero reveal" style="${stagger(0)}">
        <div class="mp-hero-head">
          <span class="lbl">Week of ${escHtml(weekOf)} · ${escHtml(current.agent || "")}</span>
          ${statusBadge(current.status)}
        </div>
        <div class="mp-hero-nums">
          <div><span class="numeral numeral-xl" data-cu="${Number(m.daily_kcal) || 0}">0</span><span class="lbl" style="display:block;margin-top:3px">kcal per day</span></div>
          <div><span class="numeral numeral-lg" data-cu="${Number(m.daily_protein_g) || 0}">0</span><span class="lbl" style="display:block;margin-top:3px">g protein</span></div>
        </div>
        ${m.summary ? `<div class="sess-line">${escHtml(m.summary)}</div>` : ""}
        <div id="mealProvenance" class="prov-slot"></div>
        ${actions}
      </div>
      ${mealPrefsHtml(mealPrefs, 1)}
      ${dayHtml}
      ${shopping}
      ${m.notes ? `<div class="sess-line reveal" style="color:var(--muted);${stagger(days.length + 3)}">${escHtml(m.notes)}</div>` : ""}
      <div class="meals-redraft">
        <button id="mealDraftBtn" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Draft a new weekly plan</button>
        <div id="mealDraftStatus" class="meals-status"></div>
      </div>`;
  }

  view.innerHTML = segBar("meals", PLAN_SEG) + body + `
    <details class="mp-history">
      <summary class="lbl">Past meal plans</summary>
      <div id="mealHist" style="margin-top:10px"></div>
    </details>`;
  wireSeg(PLAN_HANDLERS);
  runCountUps(view);

  renderMealPlans(plans, "#mealHist", () => renderMeals());
  wireMealPrefs();
  if (current) { wireMealRows(view, current, ctx); loadMealProvenance(); }

  // shopping chips check off (persisted per plan, local-only)
  if (current) view.querySelectorAll("[data-shop]").forEach((c) =>
    c.addEventListener("click", () => {
      c.classList.toggle("chip-done");
      const done = [...view.querySelectorAll("[data-shop].chip-done")].map((el) => Number(el.dataset.shop));
      localStorage.setItem(`shop:${current.id}`, JSON.stringify(done));
    })
  );

  const keep = view.querySelector("[data-mkeep]");
  if (keep) keep.addEventListener("click", async () => {
    await api(`/mealplans/${keep.dataset.mkeep}/accept`, { method: "POST" });
    toast("Meal plan kept"); renderMeals();
  });
  const disc = view.querySelector("[data-mdiscard]");
  if (disc) disc.addEventListener("click", async () => {
    await api(`/mealplans/${disc.dataset.mdiscard}/discard`, { method: "POST" });
    toast("Discarded"); renderMeals();
  });

  const draftBtn = view.querySelector("#mealDraftBtn");
  if (draftBtn) draftBtn.addEventListener("click", async () => {
    const status = view.querySelector("#mealDraftStatus");
    const restore = btnBusy(draftBtn, "Drafting…", { ghost: true });
    status.textContent = "Drafting with the auto rotation… 10–60s.";
    try {
      const r = await api("/coach/mealplan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "auto" }),
      });
      if (r.error) { status.textContent = "Error: " + r.error; }
      else if (!r.ok) { status.textContent = "Agent ran but returned no valid JSON."; }
      else { toast("Meal plan drafted"); renderMeals(); return; }
    } catch (e) { status.textContent = "Failed: " + e.message; }
    restore();
  });
}

// ---------- Me (segmented: Profile / Memory / Health / Life) ----------
const ME_SEG = [["profile", "Profile"], ["memory", "Memory"], ["health", "Health"], ["life", "Life"], ["family", "Family"]];
const ME_HANDLERS = { profile: renderMeProfile, memory: renderMemory, health: renderHealth, life: renderLife, family: renderFamily };
function renderMe() {
  headerTitle.textContent = "Me";
  pollToken++; // invalidate in-flight enrichment polls
  if (!state.meSeg) state.meSeg = "profile";
  return (ME_HANDLERS[state.meSeg] || renderMeProfile)();
}

async function renderMeProfile() {
  headerTitle.textContent = "Me";
  state.meSeg = "profile";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segSkeleton("profile", ME_SEG, 2); // skeleton-first: seg paints now, fields hydrate
  const [profile, goal, acts, notes] = await Promise.all([
    api("/profile"), api("/goal"), api("/activities?limit=8"), api("/food-notes?limit=10"),
  ]);
  const p = profile || {};
  const num = (id, label, val, step) =>
    `<div class="field" style="margin-bottom:9px"><label>${label}</label>
     <input id="${id}" type="number" step="${step||1}" value="${val ?? ""}"
       style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px"></div>`;

  const reqWarn = goal?.requested?.aggressive
    ? `<div class="ex-flag" style="margin-top:0"><b>Goal too aggressive for lean mass.</b> ${goal.message}</div>`
    : `<div class="sess-line">${goal?.message || ""}</div>`;

  view.innerHTML = segBar("profile", ME_SEG) + `
    <div class="sess">
      <div class="sess-head"><span class="sess-date">Goal check</span><span class="sess-day">${goal?.tdee ? goal.tdee + " kcal TDEE" : ""}</span></div>
      ${reqWarn}
      ${goal?.recommended ? `<div class="sess-line" style="margin-top:6px"><b>Lean-safe target:</b> ${goal.recommended.target_intake_kcal} kcal \u00b7 ${goal.recommended.protein_g} g protein \u00b7 ${goal.recommended.weekly_rate_lb} lb/wk</div>` : ""}
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Profile</h1>
    <div id="profFields">
    ${num("age","Age",p.age)}
    ${num("height_cm","Height (cm)",p.height_cm,0.1)}
    ${num("weight_lb","Weight (lb)",p.weight_lb,0.1)}
    ${num("goal_weight_lb","Goal weight (lb)",p.goal_weight_lb,0.1)}
    <div class="field" style="margin-bottom:9px"><label>Goal date</label>
      <input id="goal_date" type="date" value="${p.goal_date || ""}" style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px"></div>
    ${num("activity_factor","Activity factor (1.3\u20131.8)",p.activity_factor,0.05)}

    <div class="field aboutme" style="margin-bottom:0">
      <label for="about_me">About you</label>
      <p class="aboutme-hint">What "better" means to you, a little of your history, the foods you love and avoid, how work and life run. Optional \u2014 the coach reads it to make the pointing yours.</p>
      <textarea id="about_me" rows="6" placeholder="e.g. I've lifted on and off for 15 years; fasted mornings suit me; I'll never give up bread; two young kids, so evenings are unpredictable. Getting strong and staying around for the long game is what 'better' means."
        maxlength="8000">${escHtml(p.about_me || "")}</textarea>
    </div>
    </div>

    <h1 class="lbl" style="margin:24px 0 8px">Log bodyweight</h1>
    <div class="logrow">
      <input id="bwInput" type="number" inputmode="decimal" step="0.1" placeholder="Weight (lb)" style="text-align:left">
      <button id="bwBtn" class="logbtn">+</button>
    </div>

    <h1 class="lbl" style="margin:24px 0 8px">Log activity</h1>
    <div class="logrow">
      <input id="actText" type="text" placeholder="e.g. ran 50 min @ 5:30/km" style="text-align:left">
      <button id="actBtn" class="logbtn">+</button>
    </div>
    <div id="actlist" style="margin-top:12px"></div>

    <h1 class="lbl" style="margin:24px 0 8px">Nutrition notes</h1>
    <div class="logrow">
      <select id="noteMeal" class="selflex" style="flex:0 0 auto;width:auto;font-size:.9rem">
        <option value="breakfast">Breakfast</option>
        <option value="lunch">Lunch</option>
        <option value="dinner">Dinner</option>
        <option value="snack">Snack</option>
      </select>
      <input id="noteText" type="text" placeholder="e.g. 2 eggs, oats, banana" style="text-align:left">
      <button id="noteBtn" class="logbtn">+</button>
    </div>
    <div id="notelist" style="margin-top:12px"></div>`;

  wireSeg(ME_HANDLERS);

  const persistProfile = async () => {
    const body = {
      age: +$("#age").value || null, height_cm: +$("#height_cm").value || null,
      weight_lb: +$("#weight_lb").value || null, goal_weight_lb: +$("#goal_weight_lb").value || null,
      goal_date: $("#goal_date").value || null, activity_factor: +$("#activity_factor").value || null,
      about_me: ($("#about_me")?.value ?? "").trim(),
    };
    await api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    renderMe(); // refresh the goal check with the new numbers; flash continues on top
    return true;
  };
  // floating save bar: scoped to the profile fields only — the bodyweight /
  // activity / nutrition quick-logs below save instantly and never show it
  mountSaveBar({
    sentinel: $("#profFields"),
    fields: $("#profFields"),
    onSave: persistProfile,
    onDiscard: () => renderMeProfile(),
  });
  $("#bwBtn").addEventListener("click", async () => {
    const w = +$("#bwInput").value;
    if (!w) return;
    await api("/bodyweight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weight_lb: w }) });
    toast("Weight logged"); renderMe();
  });
  $("#actBtn").addEventListener("click", async () => {
    const text = $("#actText").value.trim();
    if (!text) return;
    $("#actText").value = "";
    let a;
    try { a = await api("/activities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }); }
    catch { toast("Failed"); return; }
    toast("Logged");
    const wrap = $("#actlist");
    if (wrap) wrap.insertAdjacentHTML("afterbegin", actEntryHtml(a));
    if (a && a.id && enrichmentActive(a.enrichment_status)) {
      const tab = state.tab, token = pollToken;
      pollEnrichment("/activities", a.id, {
        tab, token,
        onUpdate: (row) => {
          const el = $(`#actlist .qlent[data-actid="${row.id}"]`);
          if (el) updateActEntry(el, row);
        },
      });
    }
  });
  $("#noteBtn").addEventListener("click", async () => {
    const raw = $("#noteText").value.trim();
    if (!raw) return;
    const meal = $("#noteMeal").value;
    $("#noteText").value = "";
    let n;
    try { n = await api("/food-notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meal, raw }) }); }
    catch { toast("Failed"); return; }
    toast("Note logged");
    const wrap = $("#notelist");
    if (wrap) {
      (state._notesById ??= {})[String(n.id)] = n;
      wrap.insertAdjacentHTML("afterbegin", noteEntryHtml(n));
      wireNoteCard(wrap.querySelector(`.fnent[data-noteid="${n.id}"]`));
    }
    if (n && n.id && enrichmentActive(n.enrichment_status)) {
      const tab = state.tab, token = pollToken;
      pollEnrichment("/food-notes", n.id, {
        tab, token,
        onUpdate: (row) => {
          const el = $(`#notelist .fnent[data-noteid="${row.id}"]`);
          if (!el) return;
          (state._notesById ??= {})[String(row.id)] = row;
          el.innerHTML = noteEntryInner(row);
          if (row.enrichment_status === "done") el.classList.add("fnent-done");
        },
      });
    }
  });
  renderActs(acts);
  renderNotes(notes);
}

function foodNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function formatFoodNum(v) {
  const n = foodNum(v);
  if (n === null) return "";
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}
function foodIngredients(pj) {
  if (!pj || typeof pj !== "object") return [];
  if (Array.isArray(pj.ingredients)) {
    return pj.ingredients.map((x) => {
      if (typeof x === "string") return { item: x };
      if (!x || typeof x !== "object") return null;
      const item = String(x.item || x.name || "").trim();
      if (!item) return null;
      return {
        item,
        amount: x.amount || x.qty || x.quantity || "",
        kcal: foodNum(x.kcal),
        protein_g: foodNum(x.protein_g),
        carbs_g: foodNum(x.carbs_g),
        fat_g: foodNum(x.fat_g),
      };
    }).filter(Boolean);
  }
  if (Array.isArray(pj.items)) {
    return pj.items.map((x) => {
      if (typeof x === "string") return { item: x };
      if (!x || typeof x !== "object") return null;
      const item = String(x.item || x.name || "").trim();
      return item ? { item, amount: x.amount || x.qty || x.quantity || "" } : null;
    }).filter(Boolean);
  }
  return [];
}
function ingredientLabel(ing) {
  const amount = String(ing?.amount || "").trim();
  const item = String(ing?.item || "").trim();
  if (!amount) return item;
  if (item.toLowerCase().startsWith(amount.toLowerCase())) return item;
  return `${amount} ${item}`;
}
function foodItemsText(pj) {
  if (!pj || typeof pj !== "object") return "";
  if (Array.isArray(pj.items)) return pj.items.map((x) => typeof x === "string" ? x : (x?.item || x?.name || "")).filter(Boolean).join(", ");
  return pj.items || "";
}
function foodTitleFromIngredients(pj) {
  const items = foodIngredients(pj).map((x) => x.item).filter(Boolean);
  if (!items.length) return "";
  return items.slice(0, 3).join(", ") + (items.length > 3 ? "..." : "");
}
function foodMacroText(pj, opts = {}) {
  if (!pj || typeof pj !== "object") return "";
  const parts = [];
  if (opts.kcal !== false && foodNum(pj.kcal) !== null) parts.push(`${formatFoodNum(pj.kcal)} kcal`);
  const labels = opts.short
    ? [["P", "protein_g"], ["C", "carbs_g"], ["F", "fat_g"], ["Fiber", "fiber_g"]]
    : [["protein", "protein_g"], ["carbs", "carbs_g"], ["fat", "fat_g"], ["fiber", "fiber_g"]];
  for (const [label, key] of labels) {
    if (foodNum(pj[key]) !== null) parts.push(`${formatFoodNum(pj[key])}g ${label}`);
  }
  return parts.join(" · ");
}

// food-note parsed_json may arrive as a JSON string or an object
function parsedNote(n) {
  let pj = n?.parsed && typeof n.parsed === "object" ? n.parsed : n?.parsed_json;
  if (typeof pj === "string") { try { pj = JSON.parse(pj); } catch { pj = null; } }
  return pj || null;
}
function noteEntryInner(n) {
  const pj = parsedNote(n);
  const date = (n.created_at || "").slice(0, 10);
  let detail;
  const text = n.raw || n.raw_output || "";
  if (pj) {
    const macros = foodMacroText(pj, { kcal: true, short: true });
    const ingredients = foodIngredients(pj);
    const items = ingredients.length ? ingredients.map(ingredientLabel).join(", ") : foodItemsText(pj);
    const title = pj.summary || foodTitleFromIngredients(pj) || text;
    detail = `<div class="meal-name">${escHtml(title)}</div>` +
      (items ? `<div class="meal-items">${escHtml(items)}</div>` : "") +
      (macros ? `<span class="fn-macros">${escHtml(macros)}</span>` : "") +
      (pj.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(pj.notes)}</div>` : "");
  } else {
    detail = `<div class="meal-name">${escHtml(text)}</div>`;
  }
  const q = n.raw_text || n.raw || n.raw_output || (pj && (pj.summary || pj.items)) || "";
  const tile = artImg("food", q, "artile-sm meal-art", art("food", q));
  const body = tile
    ? `<div class="meal-row">${tile}<div class="meal-main">${detail}</div></div>`
    : detail;
  return `<div class="sess-head"><span class="sess-date" style="font-size:.9rem">${escHtml(n.meal || "")} · ${escHtml(date)}</span><span class="fnent-badge">${enrichBadge(n.enrichment_status)}</span></div>${body}`;
}
function noteEntryHtml(n, i) {
  const rev = typeof i === "number";
  return `<div class="sess fnent tappable${rev ? " reveal" : ""}" data-noteid="${n.id}"${rev ? ` style="${stagger(i)}"` : ""}>${noteEntryInner(n)}</div>`;
}

// tap a note card → full-screen food detail (zooming from its art tile)
function wireNoteCard(el) {
  if (!el || el._wired) return; el._wired = true;
  el.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input")) return;
    const n = (state._notesById || {})[el.dataset.noteid];
    if (n) openFoodDetail(n, el.querySelector(".artile"));
  });
}

function renderNotes(notes) {
  const wrap = $("#notelist");
  if (!notes || !notes.length) { wrap.innerHTML = `<div class="empty">No nutrition notes yet.</div>`; return; }
  state._notesById = Object.fromEntries(notes.map((n) => [String(n.id), n]));
  wrap.innerHTML = notes.map((n, i) => noteEntryHtml(n, i)).join("");
  wrap.querySelectorAll(".fnent").forEach(wireNoteCard);
}

function renderActs(acts) {
  const wrap = $("#actlist");
  if (!acts.length) { wrap.innerHTML = `<div class="empty">No activities yet.</div>`; return; }
  wrap.innerHTML = acts.map((a) => actEntryHtml(a)).join("");
}

// ---------- Me: Memory (what the coach remembers) ----------
const MEM_KINDS = ["note", "preference", "constraint", "goal", "fact"];
async function renderMemory() {
  headerTitle.textContent = "Me";
  state.meSeg = "memory";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("memory", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Facts and preferences the coach carries between sessions. Edit or remove anything that's stale.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">What the coach remembers</h1>
    <div class="memadd">
      <select id="memKind">${MEM_KINDS.map((k) => `<option value="${k}">${k}</option>`).join("")}</select>
      <input id="memInput" type="text" placeholder="Add something to remember…">
      <button id="memAdd" class="logbtn">+</button>
    </div>
    <div id="memlist" style="margin-top:12px"></div>`;
  wireSeg(ME_HANDLERS);

  const addBtn = $("#memAdd"), input = $("#memInput");
  const add = async () => {
    const content = input.value.trim();
    if (!content) { input.focus(); return; }
    const kind = $("#memKind").value;
    input.value = "";
    try { await api("/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, kind }) }); }
    catch { toast("Failed"); return; }
    toast("Remembered");
    loadMemory();
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  loadMemory();
}

async function loadMemory() {
  const wrap = $("#memlist");
  if (!wrap) return;
  let items = [];
  try { items = await api("/memory"); } catch { items = []; }
  if (state.tab !== "me" || state.meSeg !== "memory" || !wrap.isConnected) return;
  if (!items || !items.length) { wrap.innerHTML = `<div class="empty">Nothing remembered yet.</div>`; return; }
  wrap.innerHTML = items.map((m, i) => {
    const date = (m.created_at || "").slice(0, 10);
    const src = m.source && m.source !== "user" ? ` · ${escHtml(m.source)}` : "";
    return `<div class="memrow reveal" style="${stagger(i)}" data-mem="${m.id}">
      <div class="memrow-main">
        <div class="memrow-top"><span class="memtag">${escHtml(m.kind || "note")}</span><span class="memdate">${escHtml(date)}${src}</span></div>
        <div class="memcontent" data-memcontent>${escHtml(m.content || "")}</div>
      </div>
      <div class="memctl">
        <button class="iconbtn" data-memedit title="edit">✎</button>
        <button class="iconbtn memdel" data-memdel title="delete">×</button>
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll("[data-memedit]").forEach((b) => b.addEventListener("click", () => startMemEdit(b.closest(".memrow"))));
  wrap.querySelectorAll("[data-memdel]").forEach((b) => b.addEventListener("click", () => startMemDelete(b)));
}

// inline edit: swap the content line for an input + save/cancel
function startMemEdit(row) {
  if (!row || row.querySelector(".memedit-box")) return;
  const id = row.dataset.mem;
  const contentEl = row.querySelector("[data-memcontent]");
  const current = contentEl.textContent;
  contentEl.hidden = true;
  const box = document.createElement("div");
  box.className = "memedit-box";
  box.innerHTML = `<input class="memedit-in" type="text" value="${escAttr(current)}">
    <button class="iconbtn memok" title="save">✓</button>
    <button class="iconbtn" data-memcancel title="cancel">×</button>`;
  contentEl.after(box);
  const inp = box.querySelector(".memedit-in");
  inp.focus(); inp.setSelectionRange(current.length, current.length);
  const cancel = () => { box.remove(); contentEl.hidden = false; };
  const save = async () => {
    const content = inp.value.trim();
    if (!content) { inp.focus(); return; }
    try { await api(`/memory/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); }
    catch { toast("Failed"); return; }
    toast("Updated"); loadMemory();
  };
  box.querySelector(".memok").addEventListener("click", save);
  box.querySelector("[data-memcancel]").addEventListener("click", cancel);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") cancel(); });
}

// inline confirm: × turns into a "remove?" chip; second tap deletes, blur/timeout cancels
function startMemDelete(btn) {
  const row = btn.closest(".memrow");
  const id = row.dataset.mem;
  if (btn.dataset.armed) {
    api(`/memory/${id}`, { method: "DELETE" }).then(() => { toast("Removed"); loadMemory(); }).catch(() => toast("Failed"));
    return;
  }
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.textContent = "remove?";
  const reset = () => { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = "×"; clearTimeout(t); };
  const t = setTimeout(reset, 3000);
  btn.addEventListener("blur", reset, { once: true });
}

// ---------- Me: Health (uploaded docs + agentic analysis) ----------
const HEALTH_KINDS = [["bloodwork", "Bloodwork"], ["dexa", "DEXA"], ["other", "Other"]];
const MAX_DOC_BYTES = 15 * 1024 * 1024; // ~15MB client cap
const MAX_DOC_TEXT = 400000;

function healthKindLabel(k) {
  const m = HEALTH_KINDS.find((x) => x[0] === k);
  return m ? m[1] : (k || "Doc");
}

// parsed_json may arrive as a JSON string or an object
function parsedDoc(d) {
  let pj = d.parsed_json;
  if (typeof pj === "string") { try { pj = JSON.parse(pj); } catch { pj = null; } }
  return pj || null;
}

// flag -> color class. "low"/"high"/"abnormal" -> warn accent; "normal"/"ok" -> muted.
function markerFlagClass(flag) {
  const f = String(flag || "").toLowerCase();
  if (f === "low" || f === "high" || f === "abnormal" || f === "critical") return "hm-flag warn";
  if (f) return "hm-flag ok";
  return "";
}

function markersTable(pj) {
  const markers = pj && Array.isArray(pj.markers) ? pj.markers : [];
  if (!markers.length) return "";
  const rows = markers.map((mk) => {
    const flag = mk.flag ? `<span class="${markerFlagClass(mk.flag)}">${escHtml(mk.flag)}</span>` : "";
    const val = [mk.value, mk.unit].filter((x) => x != null && x !== "").join(" ");
    return `<tr>
      <td class="hm-name">${escHtml(mk.name || "")}</td>
      <td class="hm-val">${escHtml(val)}</td>
      <td class="hm-fl">${flag}</td>
    </tr>`;
  }).join("");
  return `<table class="hmarkers"><tbody>${rows}</tbody></table>`;
}

// True when a card holds enough analyzed substance to be worth collapsing behind
// a one-line teaser (a done analysis with markers or a summary). Shared by the
// card renderer and the initial collapsed-state decision so they never drift.
function docCollapsible(d) {
  const pj = parsedDoc(d);
  const markers = pj && Array.isArray(pj.markers) ? pj.markers : [];
  return d.enrichment_status === "done" && (markers.length > 0 || !!d.summary);
}

// Inner content of one health-doc card (re-rendered in place while enriching).
function healthDocInner(d) {
  const pj = parsedDoc(d);
  const status = d.enrichment_status;
  const derived = !!d.source_doc_id; // a dated panel split out of a multi-record import
  let analysisBadge = "";
  if (enrichmentActive(status)) analysisBadge = `<span class="enr enr-pending">analyzing...</span>`;
  else if (status === "failed") analysisBadge = `<span class="enr" style="color:var(--warn)">analysis failed</span>`;
  else if (status === "skipped") analysisBadge = `<span class="enr enr-done">not analyzed</span>`;
  else if (status === "done") analysisBadge = `<span class="enr enr-done" title="analyzed">✦ analyzed</span>`;

  let detail = "";
  if (status === "done") {
    if (d.summary) detail += `<div class="sess-line" style="margin-top:7px">${escHtml(d.summary)}</div>`;
    detail += markersTable(pj);
    if (pj && pj.type && !d.summary) detail += `<div class="sess-line" style="color:var(--muted)">${escHtml(pj.type)}</div>`;
  } else if (enrichmentActive(status)) {
    detail = `<div class="sess-line" style="color:var(--muted)">Reading the document and splitting it by date...</div>`;
  } else if (status === "failed") {
    detail = `<div class="sess-line" style="color:var(--muted)">Couldn't extract markers automatically. The original file is still saved — try Re-analyze.</div>`;
  }

  // "view file" resolves to this row's binary, or the source upload's for a panel.
  const fileId = d.has_file ? d.id : (d.source_doc_id || null);
  const busy = enrichmentActive(status);

  // Collapsible cards stand in a one-line teaser for the detail when collapsed, so
  // a growing record history stays scannable: marker + flagged counts at a glance,
  // tap the header (or teaser) to open the full table. Newest opens by default.
  const collapsible = docCollapsible(d);
  const markers = pj && Array.isArray(pj.markers) ? pj.markers : [];
  const flagged = markers.filter((mk) => {
    const f = String(mk.flag || "").toLowerCase();
    return f && f !== "normal" && f !== "optimal" && f !== "in range" && f !== "in-range";
  }).length;
  const teaser = markers.length
    ? `${markers.length} marker${markers.length === 1 ? "" : "s"}${flagged ? ` · ${flagged} flagged` : " · all in range"}`
    : "Analyzed";

  const head = `<div class="sess-head${collapsible ? " hdoc-head" : ""}"${collapsible ? ` data-hdoc-toggle role="button" tabindex="0" aria-label="Toggle record detail"` : ""}>
      <span class="sess-date">${escHtml(healthKindLabel(d.kind))}${d.doc_date ? ` · ${escHtml(d.doc_date)}` : ""}${derived ? `<span class="hdoc-tag">from import</span>` : ""}</span>
      <span class="hdoc-headright">
        <span class="hdoc-badge">${analysisBadge}</span>
        ${collapsible ? `<span class="hdoc-chev" aria-hidden="true">▾</span>` : ""}
      </span>
    </div>`;

  const teaserHtml = collapsible
    ? `<button class="hdoc-teaser" type="button" data-hdoc-toggle><span class="hdoc-teaser-txt">${escHtml(teaser)}</span><span class="hdoc-teaser-more">view</span></button>`
    : "";

  return `${head}
    ${teaserHtml}
    <div class="hdoc-detail">
      ${d.original_name && !derived ? `<div class="sess-line" style="color:var(--muted);font-size:.78rem">${escHtml(d.original_name)}</div>` : ""}
      ${detail}
    </div>
    <div class="hdoc-foot">
      <div class="hdoc-date-wrap">
        <button class="hdoc-datebtn" data-hdate-edit="${d.id}" title="Change the result date">
          <span class="hdoc-date-ico" aria-hidden="true">✎</span>
          <span class="hdoc-date-val">${d.doc_date ? escHtml(d.doc_date) : "Set date"}</span>
        </button>
        <span class="hdoc-date-edit" data-hdate-editor="${d.id}" hidden>
          <input class="hdoc-date" data-hdate="${d.id}" type="date" value="${escAttr(d.doc_date || "")}" max="${localISO()}" aria-label="Result date">
          <button class="hdoc-date-save" data-hdate-save="${d.id}">Save</button>
          <button class="hdoc-date-cancel" data-hdate-cancel="${d.id}">Cancel</button>
        </span>
        <span class="hdoc-date-flash" data-hdate-flash="${d.id}" hidden>✓ updated</span>
      </div>
      <div class="hdoc-actions">
        ${d.has_file ? `<button class="hdoc-link hdoc-rescan" data-hrescan="${d.id}"${busy ? " disabled" : ""} title="Re-run the scan over the original file">↻ re-analyze</button>` : ""}
        ${fileId ? `<a class="hdoc-link" href="${withToken(`/api/health-docs/${fileId}/file`)}" target="_blank" rel="noopener">view file</a>` : ""}
        <button class="iconbtn hdoc-del" data-hdel="${d.id}" title="delete">×</button>
      </div>
    </div>`;
}

function healthDocHtml(d, i) {
  const rev = typeof i === "number";
  const collapsed = docCollapsible(d) && rev && i > 0; // newest opens; older collapse
  return `<div class="sess hdoc${rev ? " reveal" : ""}${collapsed ? " hdoc-collapsed" : ""}" data-hdoc="${d.id}"${rev ? ` style="${stagger(i)}"` : ""}>${healthDocInner(d)}</div>`;
}

// ---------- Me: Health — the whole picture (review · markers · records) ----------
// _hPic caches what the picture panel needs across in-place repaints; the in-flight
// review run lives at module level so it survives sub-view re-renders (the POST can
// take minutes — an agent CLI run) and quietly lands wherever the user is.
let _hPic = null;        // { review, docCount, newestDocAt }
let _hReviewRun = null;  // in-flight POST /health/review promise
let _hReviewErr = null;  // gentle inline message after a failed run

const H_FILE_PROMPT = "Drop a lab PDF, MyChart export (.zip), HTML, XML, a photo, or text…";

// Browsers leave file.type empty for many .zip/.xml picks — infer from the name
// so the server's MIME allowlist accepts it. Unknown → octet-stream (rejected).
function guessUploadMime(f) {
  const t = (f.type || "").toLowerCase();
  if (t) return t;
  const name = (f.name || "").toLowerCase();
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html";
  if (name.endsWith(".xml")) return "application/xml";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

// review.parsed may arrive as a JSON string or an object
function parsedReview(r) {
  if (!r || r.error) return null;
  let p = r.parsed;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  return p && typeof p === "object" ? p : null;
}

// flag/status → dot modifier. Colors mirror the marker flag pills:
// low/high → warn, "watch" → gold, normal → sage, none → neutral hairline.
function healthDotClass(flag) {
  const f = String(flag || "").toLowerCase();
  if (f === "low" || f === "high" || f === "abnormal" || f === "critical") return "hdot-warn";
  if (f === "normal" || f === "ok") return "hdot-ok";
  return f ? "hdot-watch" : "hdot-mute";
}

// Static studio plate for the no-docs hero (trusted SVG, no caller text — same
// rules as art.js: cream circle, ink line, one terracotta accent).
const HEALTH_HERO_ART = `<svg viewBox="0 0 96 96" aria-hidden="true">
  <circle cx="48" cy="48" r="44" fill="#efe8db"/>
  <ellipse cx="48" cy="78" rx="24" ry="5" fill="rgba(72,58,35,.10)"/>
  <polyline points="18,54 32,54 38,40 47,66 54,44 59,54 70,54" fill="none" stroke="#211d17" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="74" cy="54" r="4" fill="#b4552d"/>
</svg>`;

function reviewBusyHtml() {
  return `<div class="hpic hpic-busy">
    <div class="hpic-top"><span class="lbl">Your picture</span><span class="hpic-when">reviewing…</span></div>
    <div class="hshimmer hshimmer-lg"></div>
    <div class="hshimmer"></div>
    <div class="hshimmer hshimmer-sm"></div>
    <div class="hpic-busynote">Reading every record and trend — this can take a few minutes. You can keep using Cairn.</div>
  </div>`;
}

function healthHeroHtml(err) {
  return `<div class="hpic hpic-hero reveal" style="${stagger(0)}">
    <div class="artile artile-lg hpic-hero-art">${HEALTH_HERO_ART}</div>
    <div class="hpic-hero-title">Build your whole picture</div>
    <div class="hpic-hero-sub">Share your bloodwork or a DEXA scan and Cairn reads it — markers, trends, and a coach's-eye view of what to do next.</div>
    ${err}
    <button id="hHeroShare" class="logbtn hpic-cta-btn">SHARE A DOCUMENT</button>
  </div>`;
}

function buildPictureHtml(err, docCount) {
  const n = Number(docCount) || 0;
  return `<div class="hpic hpic-build reveal" style="${stagger(0)}">
    <span class="lbl">Your picture</span>
    <div class="hpic-headline">Your records are in.</div>
    <div class="hpic-hero-sub">One review across ${n === 1 ? "your document" : `all ${n} documents`} — what's strong, what to watch, and what to do this week.</div>
    ${err}
    <button id="hRevBtn" class="logbtn hpic-cta-btn">BUILD MY PICTURE</button>
  </div>`;
}

function reviewHtml(review, stale, err) {
  const p = parsedReview(review) || {};
  const latestISO = latestReviewDate(p);
  const hz = (t) => escHtml(humanizeReviewText(t, latestISO)); // humanize, then escape
  const focus = (Array.isArray(p.focus) ? p.focus : []).filter((f) => f && (f.title || f.action)).map((f) => `
    <div class="hfocus">
      ${f.title ? `<div class="hfocus-title">${hz(f.title)}</div>` : ""}
      ${f.why ? `<div class="hfocus-why">${hz(f.why)}</div>` : ""}
      ${f.action ? `<div class="hfocus-act">→ ${hz(f.action)}</div>` : ""}
    </div>`).join("");
  const watch = (Array.isArray(p.watchlist) ? p.watchlist : []).filter((w) => w && (w.marker || w.why)).map((w) => `
    <div class="hwatch">
      <span class="hdot ${healthDotClass(w.status)}"></span>
      <div class="hwatch-main">
        <div class="hwatch-line"><span class="hwatch-name">${escHtml(w.marker || "")}</span>${w.status ? `<span class="hwatch-st">${escHtml(w.status)}</span>` : ""}</div>
        ${w.why ? `<div class="hwatch-why">${hz(w.why)}</div>` : ""}
        ${w.action ? `<div class="hwatch-act">${hz(w.action)}</div>` : ""}
      </div>
    </div>`).join("");
  const wins = (Array.isArray(p.wins) ? p.wins : []).filter(Boolean).map((w) => `<li>${hz(w)}</li>`).join("");
  const fu = (Array.isArray(p.followups) ? p.followups : []).filter((f) => f && f.what).map((f) => `
    <div class="hfu"><span class="hfu-what">${hz(f.what)}</span>${f.when ? `<span class="hfu-when">${escHtml(f.when)}</span>` : ""}</div>`).join("");
  const impacts = [["Training", p.training_impact], ["Nutrition", p.nutrition_impact]]
    .filter(([, v]) => v)
    .map(([l, v]) => `<div class="himpact"><span class="lbl">${l}</span><span class="himpact-t">${hz(v)}</span></div>`).join("");
  const when = review.created_at ? `Reviewed ${relTime(review.created_at)}` : "Reviewed";
  const asOf = latestISO ? `<span class="hpic-asof lbl">As of ${escHtml(humanDate(latestISO))}</span>` : "";
  const refresh = stale
    ? `<button id="hRevBtn" class="hpic-refresh hpic-refresh-stale" title="New results since this review"><span class="hdot hdot-warn"></span>New results — refresh</button>`
    : `<button id="hRevBtn" class="hpic-refresh">↻ refresh</button>`;
  return `<div class="hpic reveal" style="${stagger(0)}">
    <span class="lbl">Your picture</span>
    ${p.headline ? `<div class="hpic-headline">${hz(p.headline)}</div>` : ""}
    ${asOf}
    ${focus ? `<span class="hpic-sub lbl">This week's focus</span><div class="hfocus-list">${focus}</div>` : ""}
    ${watch ? `<span class="hpic-sub lbl">Watchlist</span><div class="hwatch-list">${watch}</div>` : ""}
    ${wins ? `<span class="hpic-sub lbl">Going well</span><ul class="hwins">${wins}</ul>` : ""}
    ${fu ? `<span class="hpic-sub lbl">Follow-ups</span><div class="hfu-list">${fu}</div>` : ""}
    ${impacts ? `<div class="himpacts">${impacts}</div>` : ""}
    ${err}
    <div class="hpic-foot">
      <span class="hpic-when">${escHtml(when)}${review.agent ? ` · ${escHtml(review.agent)}` : ""}</span>
      ${refresh}
    </div>
  </div>`;
}

// Paint #hPicture from _hPic + the in-flight run state. Safe to call anytime —
// bails unless the Health sub-view is live.
function paintHealthPicture() {
  const wrap = $("#hPicture");
  if (!wrap || state.tab !== "me" || state.meSeg !== "health" || state.healthSeg !== "analysis" || !wrap.isConnected) return;
  if (_hReviewRun) { wrap.innerHTML = reviewBusyHtml(); return; }
  const pic = _hPic || {};
  const err = _hReviewErr ? `<div class="hpic-err">${escHtml(_hReviewErr)}</div>` : "";
  const p = parsedReview(pic.review);
  if (!p && !(pic.docCount > 0)) {
    // nothing shared yet → inviting hero; CTA jumps to the Records tab + file picker
    wrap.innerHTML = healthHeroHtml(err);
    const b = $("#hHeroShare");
    if (b) b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
    return;
  }
  if (!p) {
    // records exist but no review yet → primary "build" action
    wrap.innerHTML = buildPictureHtml(err, pic.docCount);
    const b = $("#hRevBtn"); if (b) b.addEventListener("click", runHealthReview);
    return;
  }
  const rT = Date.parse(pic.review.created_at || "") || 0;
  const dT = Date.parse(pic.newestDocAt || "") || 0;
  wrap.innerHTML = reviewHtml(pic.review, rT > 0 && dT > rT, err);
  const b = $("#hRevBtn"); if (b) b.addEventListener("click", runHealthReview);
}

// POST /api/health/review — an agent run that can take minutes. One in-flight run
// max; the shimmer card holds the slot, and ok:false lands as a gentle inline note.
async function runHealthReview() {
  if (_hReviewRun) return;
  _hReviewErr = null;
  _hReviewRun = api("/health/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .catch(() => null);
  paintHealthPicture();
  const res = await _hReviewRun;
  _hReviewRun = null;
  if (res && res.ok && res.review) {
    state.healthReview = res.review;
    _hPic = { ...(_hPic || {}), review: res.review };
    toast("Your picture is ready");
  } else {
    _hReviewErr = res && res.error
      ? `The review didn't finish: ${res.error}`
      : "The review didn't come back — give it another try in a bit.";
  }
  paintHealthPicture();
}

async function loadHealthPicture(token, docsP) {
  let review = null, docs = [];
  try { review = await api("/health/review"); } catch { review = null; }
  try { docs = (await docsP) || []; } catch { docs = []; }
  if (review && review.error) review = null;
  if (review) state.healthReview = review;
  if (token !== pollToken) return; // navigated away / re-rendered
  const newest = docs.reduce((m, d) => (d.created_at && (!m || d.created_at > m) ? d.created_at : m), null);
  _hPic = { review, docCount: docs.length, newestDocAt: newest };
  paintHealthPicture();
}

// ---- markers (trends) ----
function fmtMkNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v ?? "");
  const a = Math.abs(n);
  const r = a >= 100 ? Math.round(n) : a >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
  return String(r);
}

function sparkDateLabel(d) {
  if (!d) return "";
  const s = String(d);
  const t = new Date(s.length === 10 ? s + "T00:00:00" : s);
  if (isNaN(t)) return s;
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

// Plain-language trend phrase from the server's `trend` (no numeric grade — the
// constitution bans scores). Falls back to deriving direction from the points span.
function markerTrendWord(m) {
  const t = m.trend || {};
  const dir = t.dir;
  if (!dir || dir === "stable") {
    // an explicit stable read, or not enough movement to call
    const pts = (m.points || []).filter((p) => p && isFinite(Number(p.value)));
    if (dir === "stable" || pts.length >= 2) return "holding steady";
    return "";
  }
  const span = markerSpanWord(t.span_days);
  return `${dir}${span ? ` over ${span}` : ""}`;
}

// "~14 mo" / "~3 wk" / "~9 days" — a soft span for the trend phrase.
function markerSpanWord(days) {
  const d = Number(days);
  if (!isFinite(d) || d <= 0) return "";
  if (d < 21) return `~${Math.round(d)} days`;
  if (d < 75) return `~${Math.round(d / 7)} wk`;
  return `~${Math.max(1, Math.round(d / 30))} mo`;
}

// Richer inline progress chart — hand-built SVG, no library. Shades the optimal-zone
// band (when present, folded into the y-domain so it's always visible), draws a
// Catmull-Rom curve through the readings (the house line), plots every numeric point
// as a flag-tinted dot, and labels the date axis at the ends. Numbers go in as
// attributes; the only text (endpoint dates) is escHtml'd — same rules as the old sparkline.
function markerChartSvg(m) {
  const raw = (m.points || []).filter((p) => p && isFinite(Number(p.value)));
  if (raw.length < 2) return "";
  const W = 300, H = 108, L = 14, R = 14, T = 14, B = 26;
  const vals = raw.map((p) => Number(p.value));
  let min = Math.min(...vals), max = Math.max(...vals);
  const opt = m.optimal && isFinite(Number(m.optimal.low)) && isFinite(Number(m.optimal.high)) ? m.optimal : null;
  // fold the optimal band into the y-domain so the shaded zone is always on-screen
  if (opt) { min = Math.min(min, Number(opt.low)); max = Math.max(max, Number(opt.high)); }
  if (max === min) { max += 1; min -= 1; }
  // a touch of headroom so dots & the band edge don't kiss the frame
  const pad = (max - min) * 0.08; min -= pad; max += pad;
  const x = (i) => L + (i * (W - L - R)) / (raw.length - 1);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const P = raw.map((p, i) => [x(i), y(Number(p.value))]);
  // optimal band rectangle (clamped to the plot)
  let band = "";
  if (opt) {
    const yHi = Math.max(T, y(Number(opt.high))), yLo = Math.min(H - B, y(Number(opt.low)));
    band = `<rect class="hchart-band" x="${L}" y="${yHi.toFixed(1)}" width="${(W - L - R).toFixed(1)}" height="${Math.max(1, yLo - yHi).toFixed(1)}" rx="3"/>`;
  }
  // gentle Catmull-Rom curve through the points
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const dots = P.map(([px, py], i) => {
    const f = String(raw[i].flag || "").toLowerCase();
    const flagged = f === "low" || f === "high" || f === "abnormal" || f === "critical";
    return `<circle class="hchart-dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${i === P.length - 1 ? 4 : 2.8}" fill="${flagged ? "#b3402e" : "#6e7f5c"}"/>`;
  }).join("");
  return `<svg class="hchart" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${band}
      <path class="hchart-line" d="${d}" fill="none" stroke="#211d17" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      <text class="hchart-txt" x="${L}" y="${H - 7}" text-anchor="start">${escHtml(sparkDateLabel(raw[0].date))}</text>
      <text class="hchart-txt" x="${W - R}" y="${H - 7}" text-anchor="end">${escHtml(sparkDateLabel(raw[raw.length - 1].date))}</text>
    </svg>`;
}

// The full expanded panel: the chart, an optimal-band caption + trend words, and the
// latest reading with its relative recency. No numeric grade anywhere.
function markerPanelHtml(m) {
  const latest = m.latest || {};
  const chart = markerChartSvg(m);
  if (!chart) return "";
  const band = m.optimal && isFinite(Number(m.optimal.low)) && isFinite(Number(m.optimal.high))
    ? `optimal ${escHtml(fmtMkNum(m.optimal.low))}–${escHtml(fmtMkNum(m.optimal.high))}${m.unit ? " " + escHtml(m.unit) : ""}`
    : "";
  const trend = markerTrendWord(m);
  const caption = [band, trend].filter(Boolean).join(" · ");
  const lv = latest.value != null && latest.value !== "" ? fmtMkNum(latest.value) : "";
  const age = latest.date ? relAge(latest.date) : "";
  const latestLine = lv
    ? `<div class="hchart-latest">
        <span class="hchart-latest-v">${escHtml(lv)}${m.unit ? `<span class="hmk-unit">${escHtml(m.unit)}</span>` : ""}</span>
        ${age ? `<span class="hchart-latest-when" title="${escAttr(absDate(latest.date))}">latest · ${escHtml(age)}</span>` : ""}
      </div>`
    : "";
  return `${latestLine}${chart}${caption ? `<div class="hchart-cap">${caption}</div>` : ""}`;
}

function hmkRowHtml(m, i) {
  const latest = m.latest || {};
  const exp = (m.points || []).filter((p) => p && isFinite(Number(p.value))).length >= 2;
  const lv = Number(latest.value), pv = m.prev ? Number(m.prev.value) : NaN;
  let delta = "";
  if (isFinite(lv) && isFinite(pv) && lv !== pv) {
    const df = lv - pv;
    delta = `<span class="hmk-delta">${df > 0 ? "▲" : "▼"} ${escHtml(fmtMkNum(Math.abs(df)))}</span>`;
  }
  const age = latest.date ? relAge(latest.date) : "";
  const when = age ? `<span class="hmk-when" title="${escAttr(absDate(latest.date))}">${escHtml(age)}</span>` : "";
  const rowInner = `<span class="hdot ${healthDotClass(latest.flag)}"></span>
      <span class="hmk-id">
        <span class="hmk-name">${escHtml(m.name || m.key || "")}</span>
        ${when}
      </span>
      <span class="hmk-right">
        ${delta}
        <span class="hmk-val">${escHtml(fmtMkNum(latest.value))}${m.unit ? `<span class="hmk-unit">${escHtml(m.unit)}</span>` : ""}</span>
        <span class="hmk-chev${exp ? "" : " hmk-chev-ghost"}" aria-hidden="true">${exp ? "▾" : ""}</span>
      </span>`;
  return `<div class="hmk reveal${exp ? " hmk-x" : ""}" style="${stagger(i)}" data-mkey="${escAttr(m.key || "")}">
    ${exp
      ? `<button class="hmk-row" aria-expanded="false">${rowInner}</button>
        <div class="hmk-panel"><div class="hmk-panel-in">${markerPanelHtml(m)}</div></div>`
      : `<div class="hmk-row">${rowInner}</div>`}
  </div>`;
}

async function loadHealthMarkers(token) {
  const wrap = $("#hMarkers");
  if (!wrap || !wrap.isConnected) return;
  let res = null;
  // /markers/priority is the superset: it carries the optimal bands (for the chart) plus
  // group + trend on top of the flat marker shape /health/markers returns.
  try { res = await api("/markers/priority"); } catch { res = null; }
  if (token !== pollToken || !wrap.isConnected) return;
  const markers = res && Array.isArray(res.markers) ? res.markers : [];
  if (!markers.length) {
    wrap.innerHTML = healthMarkersEmptyHtml();
    const b = wrap.querySelector("#hMkToRecords");
    if (b) b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
    return;
  }
  // Server `groups` is the canonical ordered list of groups that hold ≥1 marker; render
  // headers in that order, preserving each group's server order (flagged/impact-first).
  // Degrade gracefully if the backend hasn't shipped grouping yet: derive an ordered list
  // from the markers themselves, falling everything ungrouped into a single "Markers" bucket.
  let groups = res && Array.isArray(res.groups) ? res.groups.filter((g) => g && g.key) : [];
  if (!groups.length) {
    const seen = new Set(), derived = [];
    for (const m of markers) {
      const key = m.group || "other";
      if (!seen.has(key)) { seen.add(key); derived.push({ key, label: m.group_label || (m.group ? m.group : "Markers") }); }
    }
    groups = derived;
  }
  const byGroup = new Map(groups.map((g) => [g.key, []]));
  for (const m of markers) {
    const key = byGroup.has(m.group) ? m.group : (groups[0] && groups[0].key);
    if (byGroup.has(key)) byGroup.get(key).push(m);
  }
  let i = 0;
  const sections = groups.map((g) => {
    const list = byGroup.get(g.key) || [];
    if (!list.length) return "";
    const rows = list.map((m) => hmkRowHtml(m, i++)).join("");
    // single-group view (e.g. ungrouped fallback) skips the header — no value labelling one bucket
    const head = groups.length > 1
      ? `<div class="hmk-grouphead lbl reveal" style="${stagger(i)}">${escHtml(g.label || g.key)}</div>`
      : "";
    return `${head}<div class="hmk-card">${rows}</div>`;
  }).join("");
  wrap.innerHTML = `<div class="hmk-groups">${sections}</div>`;
  wrap.querySelectorAll(".hmk-x .hmk-row").forEach((b) =>
    b.addEventListener("click", () => {
      const item = b.closest(".hmk");
      const open = item.classList.toggle("open");
      b.setAttribute("aria-expanded", open ? "true" : "false");
    }));
}

const HEALTH_SEG = [["analysis", "Analysis"], ["brain", "Brain"], ["markers", "Markers"], ["records", "Records"]];

// Health is a nested view: the Me seg picks "Health", then an inner seg picks
// Analysis (the whole-picture review) / Markers (trends) / Records (upload +
// documents). Splitting these bounds each tab's scroll and keeps it focused.
async function renderHealth() {
  headerTitle.textContent = "Me";
  state.meSeg = "health";
  if (!state.healthSeg) state.healthSeg = "analysis";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  const idx = Math.max(0, HEALTH_SEG.findIndex(([k]) => k === state.healthSeg));
  view.innerHTML = segBar("health", ME_SEG)
    + `<div class="segwrap hsegwrap"><div class="seg seg-sliding hseg" style="--segn:${HEALTH_SEG.length};--segi:${idx}">`
    +   `<span class="seg-thumb"></span>`
    +   HEALTH_SEG.map(([k, l]) => `<button class="segbtn${k === state.healthSeg ? " active" : ""}" data-hseg="${k}">${l}</button>`).join("")
    + `</div></div>`
    + `<div id="hContent"></div>`;
  wireSeg(ME_HANDLERS);
  const hseg = view.querySelector(".hseg");
  hseg.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.hseg === state.healthSeg) return;
    setHealthSegActive(b.dataset.hseg);
    withViewTransition(() => paintHealthTab());
  }));
  paintHealthTab();
}

// Slide the inner seg thumb + flip the active button to `seg` (no repaint).
function setHealthSegActive(seg) {
  state.healthSeg = seg;
  const hseg = view.querySelector(".hseg");
  if (!hseg) return;
  const btns = [...hseg.querySelectorAll(".segbtn")];
  const target = btns.find((b) => b.dataset.hseg === seg);
  if (!target) return;
  hseg.style.setProperty("--segi", btns.indexOf(target));
  btns.forEach((x) => x.classList.toggle("active", x === target));
}

// Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
// same user gesture (so the file dialog isn't blocked) — hence no view transition.
function switchHealthSeg(seg, opts = {}) {
  if (state.tab !== "me" || state.meSeg !== "health") return;
  setHealthSegActive(seg);
  if (opts.openPicker) {
    paintHealthTab();
    const f = $("#hFile"); if (f) f.click();
  } else {
    withViewTransition(() => paintHealthTab());
  }
}

// Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
// poll from the tab we're leaving stops cleanly (Records resumes on return).
function paintHealthTab() {
  pollToken++;
  if (state.healthSeg === "brain") return paintHealthBrainTab();
  if (state.healthSeg === "markers") return paintHealthMarkersTab();
  if (state.healthSeg === "records") return paintHealthRecordsTab();
  return paintHealthAnalysisTab();
}

// ---- Analysis tab: the whole-picture agentic review ----
function paintHealthAnalysisTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `<div id="hRecovery"></div>
    <div id="hPicture">
      <div class="hpic hpic-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div>
    </div>`;
  loadRecoverySummary(pollToken, "#hRecovery");
  if (_hReviewRun) { paintHealthPicture(); return; } // a run is still cooking
  loadHealthPicture(pollToken, api("/health-docs"));
}

// =====================================================================
// The connected brain (Brain tab): recovery read · what matters now
// (priority markers, optimal-zone framing) · cross-domain directives.
// Plain language only — no numeric scores, ever. Informational, not advice.
// =====================================================================

function paintHealthBrainTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `
    <div class="hbrain-intro sess"><div class="sess-line" style="color:var(--muted)">
      One brain across your whole picture. A finding in your labs can quietly shape your meals, your training, and what to keep an eye on. It's here to inform — never medical advice — and nothing changes your plan on its own.
    </div></div>
    <div id="hbRecovery"></div>
    <div id="hbMarkers"><div class="hb-load">Reading what matters most…</div></div>
    <div id="hbDirectives"><div class="hb-load">Gathering directives…</div></div>`;
  loadRecoverySummary(pollToken, "#hbRecovery");
  loadPriorityMarkers(pollToken);
  loadDirectives(pollToken);
}

// ---- Recovery (calm, plain-language; never a score) ----
// Render a quiet line about how recovery's been over the window. Used both at the
// top of Analysis and inside the Brain tab. Bails to nothing / a quiet hint when
// there's no wearable or check-in data.
async function loadRecoverySummary(token, sel) {
  const wrap = $(sel);
  if (!wrap || !wrap.isConnected) return;
  let r = null;
  try { r = await api("/recovery?days=14"); } catch { r = null; }
  if (token !== pollToken || !wrap.isConnected) return;
  if (!r || !r.has_data) {
    // quiet hint, not a nag — capture is offered, never demanded
    wrap.innerHTML = `<div class="hb-recovery hb-recovery-empty reveal" style="${stagger(0)}">
      <span class="lbl">Recovery</span>
      <p class="hb-recovery-hint">No sleep or recovery signal yet. Connect a wearable, or jot how you're feeling, and the buddy will fold it into your day.</p>
    </div>`;
    return;
  }
  wrap.innerHTML = recoveryHtml(r);
}

// Plain-language recovery summary. Each chip is a phrase, not a number you must
// interpret; we lean on rough bands (sleeping well / a little short, resting HR
// steady) so it reads like a friend's note. Numbers are kept to quiet captions.
function recoveryHtml(r) {
  const rc = r.recovery || {};
  const lines = [];
  const cap = (txt, sub) => `<div class="hb-rline"><span class="hb-rphrase">${escHtml(txt)}</span>${sub ? `<span class="hb-rsub">${escHtml(sub)}</span>` : ""}</div>`;

  const sm = Number(rc.avg_sleep_min);
  if (isFinite(sm) && sm > 0) {
    const h = Math.floor(sm / 60), m = Math.round(sm % 60);
    const hrs = sm / 60;
    const phrase = hrs >= 7.5 ? "Sleeping well" : hrs >= 6.5 ? "Sleep's about right" : hrs >= 5.5 ? "Sleep's run a little short" : "Sleep's been short";
    // Fold deep/REM architecture into the caption when the wearable reports it.
    const deep = Number(rc.avg_deep_sleep_min), rem = Number(rc.avg_rem_sleep_min);
    const arch = [
      isFinite(deep) && deep > 0 ? `${Math.round(deep)}m deep` : null,
      isFinite(rem) && rem > 0 ? `${Math.round(rem)}m REM` : null,
    ].filter(Boolean).join(" · ");
    lines.push(cap(phrase, `${h}h${m ? " " + m + "m" : ""} a night${arch ? " · " + arch : ""}`));
  }
  const rhr = Number(rc.avg_resting_hr);
  if (isFinite(rhr) && rhr > 0) lines.push(cap("Resting heart rate steady", `~${Math.round(rhr)} bpm`));
  const hrv = Number(rc.avg_hrv_ms);
  if (isFinite(hrv) && hrv > 0) {
    const st = String(rc.hrv_status || "").toLowerCase();
    const phrase = st === "balanced" ? "Heart-rate variability balanced"
      : st === "unbalanced" ? "Heart-rate variability a touch off"
      : (st === "low" || st === "poor") ? "Heart-rate variability running low"
      : "Heart-rate variability holding";
    lines.push(cap(phrase, `~${Math.round(hrv)} ms`));
  }
  const stress = Number(rc.avg_stress);
  if (isFinite(stress) && stress > 0) {
    const phrase = stress < 26 ? "Stress load's low" : stress < 51 ? "Stress load's moderate" : "Stress load's run high";
    lines.push(cap(phrase, ""));
  }
  const bb = Number(rc.avg_body_battery);
  if (isFinite(bb) && bb > 0) {
    const phrase = bb >= 60 ? "Energy reserves look good" : bb >= 40 ? "Energy reserves middling" : "Running a bit low on reserves";
    lines.push(cap(phrase, ""));
  }
  // Breathing + blood-oxygen — a quiet illness/altitude tell when it drifts.
  const resp = Number(rc.avg_respiration), spo2 = Number(rc.avg_spo2);
  if ((isFinite(resp) && resp > 0) || (isFinite(spo2) && spo2 > 0)) {
    const sub = [
      isFinite(resp) && resp > 0 ? `~${Math.round(resp)}/min` : null,
      isFinite(spo2) && spo2 > 0 ? `SpO₂ ${Math.round(spo2)}%` : null,
    ].filter(Boolean).join(" · ");
    const phrase = isFinite(spo2) && spo2 > 0 && spo2 < 93 ? "Blood oxygen ran low overnight" : "Breathing steady overnight";
    lines.push(cap(phrase, sub));
  }
  // Skin-temperature deviation — surface only when it meaningfully drifts (a soft
  // strain/illness signal on supported devices).
  const skin = Number(rc.skin_temp_dev_c);
  if (isFinite(skin) && Math.abs(skin) >= 0.3) {
    lines.push(cap(skin > 0 ? "Skin temp ran warm overnight" : "Skin temp ran cool overnight", `${skin > 0 ? "+" : ""}${skin}°C vs baseline`));
  }
  const tr = Number(rc.avg_training_readiness);
  if (isFinite(tr) && tr > 0) {
    const phrase = tr >= 75 ? "Primed to train" : tr >= 50 ? "Ready for a normal day" : tr >= 25 ? "Ease in — recovery's partial" : "Body's asking for a lighter day";
    lines.push(cap(phrase, ""));
  }
  // VO2max + training status read as objective fitness, not a verdict.
  const vo2 = Number(rc.vo2max);
  if (isFinite(vo2) && vo2 > 0) {
    const status = String(rc.training_status || "").replace(/_/g, " ").toLowerCase();
    lines.push(cap("Aerobic fitness", `VO₂max ~${Math.round(vo2)}${status ? " · " + status : ""}`));
  }
  const steps = Number(rc.avg_steps);
  if (isFinite(steps) && steps > 0) {
    const phrase = steps >= 8000 ? "Moving plenty day to day" : steps >= 4000 ? "Moving a fair bit" : "Fairly sedentary lately";
    lines.push(cap(phrase, `~${fmtK(steps)} steps`));
  }
  // Body composition (latest weigh-in from a connected scale).
  const wt = Number(rc.weight_kg), bf = Number(rc.body_fat_pct), mm = Number(rc.muscle_mass_kg);
  if ((isFinite(wt) && wt > 0) || (isFinite(bf) && bf > 0)) {
    const sub = [
      isFinite(wt) && wt > 0 ? `${Math.round(wt * 10) / 10} kg` : null,
      isFinite(bf) && bf > 0 ? `${Math.round(bf * 10) / 10}% fat` : null,
      isFinite(mm) && mm > 0 ? `${Math.round(mm * 10) / 10} kg muscle` : null,
    ].filter(Boolean).join(" · ");
    lines.push(cap("Body composition", sub));
  }
  if (!lines.length) {
    return `<div class="hb-recovery hb-recovery-empty reveal" style="${stagger(0)}">
      <span class="lbl">Recovery</span>
      <p class="hb-recovery-hint">Recovery data's coming in but nothing to call out yet.</p>
    </div>`;
  }
  const srcLabel = (r.sources || []).map((s) => s === "garmin" ? "Garmin" : s === "apple" ? "Apple Health" : s).filter(Boolean).join(" · ");
  return `<div class="hb-recovery reveal" style="${stagger(0)}">
    <div class="hb-rtop"><span class="lbl">Recovery · last 2 weeks</span>${srcLabel ? `<span class="hb-rsrc">${escHtml(srcLabel)}</span>` : ""}</div>
    <div class="hb-rlist">${lines.join("")}</div>
  </div>`;
}

// ---- Priority markers (optimal-zone framing, never a score) ----
// Phrase each marker in plain language against its optimal zone: "ApoB — above
// optimal", "HbA1c — in your optimal range", "Ferritin — below optimal". Order
// comes from the server (impact_score); we NEVER render that number.
function optimalPhrase(m) {
  const opt = m.optimal;
  const latest = m.latest || {};
  const flag = String(latest.flag || "").toLowerCase();
  // No optimal band: lean on the lab's own flag, still plain language.
  if (!opt) {
    if (flag === "high") return { word: "running high", tone: "warn" };
    if (flag === "low") return { word: "running low", tone: "warn" };
    if (flag === "normal" || flag === "ok") return { word: "in range", tone: "ok" };
    return { word: "worth a look", tone: "watch" };
  }
  if (m.in_optimal === true) return { word: "in your optimal range", tone: "ok" };
  if (m.in_optimal === false) {
    const v = Number(latest.value);
    // which side of the band — "above" / "below" optimal, in plain words
    if (isFinite(v)) {
      if (v > opt.high) return { word: "above optimal", tone: "warn" };
      if (v < opt.low) return { word: "below optimal", tone: "warn" };
    }
    if (opt.dir === "low") return { word: "below optimal", tone: "warn" };
    if (opt.dir === "high") return { word: "above optimal", tone: "warn" };
    return { word: "outside your optimal range", tone: "warn" };
  }
  // optimal exists but no numeric latest → soft
  return { word: "worth a look", tone: "watch" };
}

function priorityMarkerHtml(m, i) {
  const latest = m.latest || {};
  const phrase = optimalPhrase(m);
  const dotClass = phrase.tone === "ok" ? "hdot-ok" : phrase.tone === "warn" ? "hdot-warn" : "hdot-watch";
  const val = latest.value != null && latest.value !== "" ? fmtMkNum(latest.value) : "";
  const valLine = val ? `<span class="hb-mkval">${escHtml(val)}${m.unit ? `<span class="hmk-unit">${escHtml(m.unit)}</span>` : ""}</span>` : "";
  const points = (m.points || []).filter((p) => p && isFinite(Number(p.value)));
  const trend = points.length >= 2 ? `<div class="hb-mktrend">${sparklineSvg(points.map((p) => Number(p.value)))}</div>` : "";
  // a calm word on the optimal band itself (where it sits), no numbers-as-grade
  const bandNote = m.optimal
    ? `<span class="hb-mkband">optimal ${escHtml(fmtMkNum(m.optimal.low))}–${escHtml(fmtMkNum(m.optimal.high))}${m.unit ? " " + escHtml(m.unit) : ""}</span>`
    : "";
  const when = latest.date ? `<span class="hb-mkwhen" title="${escAttr(absDate(latest.date))}">${escHtml(relAge(latest.date))}</span>` : "";
  return `<div class="hb-mk reveal" style="${stagger(i)}">
    <div class="hb-mktop">
      <span class="hdot ${dotClass}"></span>
      <span class="hb-mkname">${escHtml(m.name || m.key || "")}</span>
      <span class="hb-mkphrase hb-mkphrase-${phrase.tone}">${escHtml(phrase.word)}</span>
      <span class="hb-mkright">${valLine}</span>
    </div>
    ${bandNote || when ? `<div class="hb-mkmeta">${bandNote}${bandNote && when ? `<span class="hb-mkdot">·</span>` : ""}${when}</div>` : ""}
    ${trend}
  </div>`;
}

async function loadPriorityMarkers(token) {
  const wrap = $("#hbMarkers");
  if (!wrap || !wrap.isConnected) return;
  let res = null;
  try { res = await api("/markers/priority"); } catch { res = null; }
  if (token !== pollToken || !wrap.isConnected) return;
  const markers = res && Array.isArray(res.markers) ? res.markers : [];
  if (!markers.length) {
    wrap.innerHTML = `<div class="hb-section">
      <div class="hb-sechead"><span class="lbl">What matters now</span></div>
      <div class="empty">No markers yet. Add a lab report on the Records tab and Cairn pulls out what matters most.</div>
    </div>`;
    return;
  }
  // Lead with the few that genuinely matter (flagged or out-of-optimal); keep the
  // good ones quietly behind a fold so already-optimal markers stay silent.
  const matters = markers.filter((m) => {
    const ph = optimalPhrase(m);
    return ph.tone !== "ok";
  });
  const good = markers.filter((m) => optimalPhrase(m).tone === "ok");
  const lead = (matters.length ? matters : markers).slice(0, 4);
  const rest = (matters.length ? matters.slice(4).concat(good) : markers.slice(4));
  wrap.innerHTML = `<div class="hb-section">
    <div class="hb-sechead"><span class="lbl">What matters now</span>${matters.length ? `<span class="hb-secnote">${matters.length} to keep an eye on</span>` : `<span class="hb-secnote">all looking good</span>`}</div>
    <div class="hb-mklist">${lead.map((m, i) => priorityMarkerHtml(m, i)).join("")}</div>
    ${rest.length ? `<details class="hb-more"><summary>Everything else (${rest.length})</summary><div class="hb-mklist hb-mklist-quiet">${rest.map((m, i) => priorityMarkerHtml(m, i)).join("")}</div></details>` : ""}
  </div>`;
}

// ---- Cross-domain directives, grouped by domain (the review side) ----
const DIRECTIVE_DOMAINS = [
  ["nutrition", "Nutrition", "❧"],
  ["training", "Training", "◇"],
  ["watch", "Watch", "◉"],
];

function directiveHtml(d, i = 0) {
  const soft = d.uncertain && !d.citation;
  const marker = d.marker ? `<span class="hb-dmarker">${escHtml(d.marker)}</span>` : "";
  // uncertain (no citation) reads tentative — a lead, not gospel
  const lead = soft ? `<span class="hb-dsoft">Worth looking into · </span>` : "";
  const cite = d.citation ? `<div class="hb-dcite">${escHtml(d.citation)}</div>` : "";
  return `<div class="hb-directive reveal${soft ? " hb-directive-soft" : ""}" style="${stagger(i + 1)}" data-dir="${d.id}">
    <div class="hb-dmain">
      ${marker}
      <p class="hb-dtext">${lead}${escHtml(d.directive || "")}</p>
      ${d.rationale ? `<p class="hb-drat">${escHtml(d.rationale)}</p>` : ""}
      ${cite}
    </div>
    <div class="hb-dctl">
      <button class="hb-dbtn hb-ddone" data-ddone="${d.id}" title="Mark handled; the coach will stop carrying this unless new results change">Done</button>
      <button class="hb-dbtn hb-ddismiss" data-ddismiss="${d.id}" title="Dismiss; the coach will avoid repeating this unless the marker materially changes">Dismiss</button>
    </div>
  </div>`;
}

async function loadDirectives(token) {
  const wrap = $("#hbDirectives");
  if (!wrap || !wrap.isConnected) return;
  let res = null;
  try { res = await api("/directives"); } catch { res = null; }
  if (token !== pollToken || !wrap.isConnected) return;
  const all = res && Array.isArray(res.directives) ? res.directives : [];
  const active = all.filter((d) => !d.status || d.status === "active");
  paintDirectives(wrap, active);
}

function paintDirectives(wrap, active) {
  if (!active.length) {
    wrap.innerHTML = `<div class="hb-section hb-dir-section">
      <div class="hb-sechead"><span class="lbl">Across your life</span><button class="hb-derive" id="hbDerive" title="Refresh from your latest labs">refresh from labs</button></div>
      <div class="empty">Nothing to carry across domains right now. When a lab finding has a clear lever, it'll show up here as something to review.</div>
    </div>`;
    $("#hbDerive")?.addEventListener("click", deriveDirectives);
    return;
  }
  // running index across groups → directives settle in one continuous stagger
  let dIdx = 0;
  const groups = DIRECTIVE_DOMAINS.map(([key, label, glyph]) => {
    const rows = active.filter((d) => (d.domain || "watch") === key);
    if (!rows.length) return "";
    return `<div class="hb-dgroup">
      <div class="hb-dgrouphead"><span class="hb-dglyph" aria-hidden="true">${glyph}</span><span class="hb-dgname">${label}</span></div>
      <div class="hb-dlist">${rows.map((d) => directiveHtml(d, dIdx++)).join("")}</div>
    </div>`;
  }).filter(Boolean).join("");
  wrap.innerHTML = `<div class="hb-section hb-dir-section">
    <div class="hb-sechead"><span class="lbl">Across your life</span><button class="hb-derive" id="hbDerive" title="Refresh from your latest labs">refresh from labs</button></div>
    ${groups}
  </div>`;
  $("#hbDerive")?.addEventListener("click", deriveDirectives);
  wrap.querySelectorAll("[data-ddone]").forEach((b) => b.addEventListener("click", () => resolveDirective(b.dataset.ddone, "resolved")));
  wrap.querySelectorAll("[data-ddismiss]").forEach((b) => b.addEventListener("click", () => resolveDirective(b.dataset.ddismiss, "dismissed")));
}

// Flip a directive's status (the review side — nothing auto-applies). The card
// collapses out gently on success.
async function resolveDirective(id, status) {
  const card = $(`#hbDirectives .hb-directive[data-dir="${id}"]`);
  let res = null;
  try {
    res = await api(`/directives/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
  } catch { res = null; }
  if (!res || !res.ok) { toast("Couldn't update"); return; }
  toast(status === "resolved" ? "Marked done" : "Dismissed");
  const after = () => {
    // if the group is now empty, drop its header too; reload to re-group cleanly
    loadDirectives(pollToken);
  };
  if (card) collapseEl(card, after); else after();
}

// Quiet "refresh from latest labs" — re-run the deterministic propagation engine.
async function deriveDirectives() {
  const btn = $("#hbDerive");
  const restore = btnBusy(btn, "refreshing…");
  let res = null;
  try { res = await api("/directives/derive", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { res = null; }
  if (!res || !res.ok) { toast("Couldn't refresh"); restore(); return; }
  toast(res.derived ? `Refreshed — ${res.derived} found` : "Up to date");
  loadDirectives(pollToken);
}

// ---- Markers tab: trends across every document ----
function paintHealthMarkersTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `<div id="hMarkers">
      <div class="hmk-card"><div class="hmk-row" style="color:var(--muted);font-size:.85rem">Loading markers…</div></div>
    </div>`;
  loadHealthMarkers(pollToken);
}

function healthMarkersEmptyHtml() {
  return `<div class="empty-state reveal" style="${stagger(0)}">
    <div class="artile artile-lg" style="margin:0 auto 14px">${HEALTH_HERO_ART}</div>
    <div class="empty-state-line">No markers yet</div>
    <div class="hpic-hero-sub">Add a lab report or DEXA scan and Cairn pulls out the markers — then tracks each one's trend here.</div>
    <button id="hMkToRecords" class="logbtn hpic-cta-btn">ADD A DOCUMENT</button>
  </div>`;
}

// ---- Records tab: upload affordance + the document list ----
function paintHealthRecordsTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `
    <div class="hupload" id="hUploadBox">
      <label class="hupload-file" id="hFileLabel">
        <input id="hFile" type="file" accept="image/*,application/pdf,.zip,.htm,.html,.xml,application/zip,text/html,application/xml" hidden>
        <span class="hupload-plus" aria-hidden="true">+</span>
        <span id="hFileName">${H_FILE_PROMPT}</span>
      </label>
      <textarea id="hText" class="hupload-text" rows="4" placeholder="Paste result text or HTML export"></textarea>
      <button id="hUpload" class="logbtn hupload-btn" disabled>ADD &amp; ANALYZE</button>
      <div id="hStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <div id="hlist"></div>`;
  wireHealthUpload();
  loadHealthDocs();
}

// Wire the Records upload affordance (file picker / drag / paste / submit).
// Extracted from renderHealth so each inner tab paints independently.
function wireHealthUpload() {
  const fileInput = $("#hFile");
  const fileName = $("#hFileName");
  const uploadBox = $("#hUploadBox");
  const textInput = $("#hText");
  const uploadBtn = $("#hUpload");
  const status = $("#hStatus");
  if (!fileInput || !uploadBox) return;
  let pendingFile = null;

  const setUploadReady = () => {
    const hasText = textInput.value.trim().length > 0;
    uploadBtn.disabled = !pendingFile && !hasText;
  };

  const setPendingFile = (f) => {
    if (!f) {
      pendingFile = null;
      fileName.textContent = H_FILE_PROMPT;
      setUploadReady();
      return;
    }
    if (f.size > MAX_DOC_BYTES) {
      toast("File too large (max 15MB)");
      fileInput.value = "";
      pendingFile = null;
      fileName.textContent = H_FILE_PROMPT;
      setUploadReady();
      return;
    }
    pendingFile = f;
    fileName.textContent = f.name || "Pasted image";
    setUploadReady();
  };

  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    setPendingFile(f || null);
  });

  textInput.addEventListener("input", setUploadReady);

  uploadBox.addEventListener("dragover", (e) => {
    e.preventDefault();
    $("#hFileLabel").classList.add("dragover");
  });
  uploadBox.addEventListener("dragleave", () => $("#hFileLabel").classList.remove("dragover"));
  uploadBox.addEventListener("drop", (e) => {
    e.preventDefault();
    $("#hFileLabel").classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setPendingFile(f);
  });
  uploadBox.addEventListener("paste", (e) => {
    const files = e.clipboardData && Array.from(e.clipboardData.files || []);
    const img = files.find((f) => (f.type || "").startsWith("image/"));
    if (img) {
      e.preventDefault();
      setPendingFile(img);
      return;
    }
    if (e.target !== textInput) {
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (text) {
        e.preventDefault();
        textInput.value = text;
        setUploadReady();
      }
    }
  });

  uploadBtn.addEventListener("click", async () => {
    const f = pendingFile;
    const pastedText = textInput.value.trim();
    if (!f && !pastedText) { toast("Add a file or text first"); return; }
    if (f && f.size > MAX_DOC_BYTES) { toast("File too large (max 15MB)"); return; }
    if (!f && pastedText.length > MAX_DOC_TEXT) { toast("Text is too long"); return; }
    uploadBtn.disabled = true; uploadBtn.style.opacity = ".6";
    status.textContent = "Uploading…";

    const body = {};
    if (f) {
      let dataUrl;
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(new Error("read failed"));
          fr.readAsDataURL(f);
        });
      } catch {
        status.textContent = "Couldn't read that file.";
        uploadBtn.disabled = false; uploadBtn.style.opacity = "1";
        return;
      }
      body.original_name = f.name || "Pasted image";
      body.mime = guessUploadMime(f);
      body.data_base64 = String(dataUrl).split(",")[1] || "";
    } else {
      body.original_name = "Pasted results";
      body.text = pastedText;
    }

    let row;
    try {
      row = await api("/health-docs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) { status.textContent = "Upload failed: " + e.message; uploadBtn.disabled = false; uploadBtn.style.opacity = "1"; return; }

    if (!row || row.error) { status.textContent = "Upload failed" + (row && row.error ? ": " + row.error : ""); uploadBtn.disabled = false; uploadBtn.style.opacity = "1"; return; }

    status.textContent = "";
    toast("Uploaded");
    // reset the picker
    fileInput.value = ""; textInput.value = ""; pendingFile = null; fileName.textContent = H_FILE_PROMPT;
    uploadBtn.style.opacity = "1"; // stays disabled until a new file is picked

    // prepend the new doc and poll for analysis if pending
    const wrap = $("#hlist");
    if (wrap) {
      const emptyEl = wrap.querySelector(".empty"); if (emptyEl) emptyEl.remove();
      wrap.insertAdjacentHTML("afterbegin", healthDocHtml(row));
      wireHealthDoc(wrap.querySelector(`.hdoc[data-hdoc="${row.id}"]`));
    }
    if (row.id && enrichmentActive(row.enrichment_status)) pollHealthDoc(row.id);

    // the Analysis picture cares: doc count + newest-doc stamp drive its empty/stale states
    if (_hPic) {
      _hPic.docCount = (_hPic.docCount || 0) + 1;
      const stamp = row.created_at || new Date().toISOString();
      if (!_hPic.newestDocAt || stamp > _hPic.newestDocAt) _hPic.newestDocAt = stamp;
    } else {
      _hPic = { review: null, docCount: 1, newestDocAt: row.created_at || new Date().toISOString() };
    }
    paintHealthPicture(); // no-op unless the Analysis tab is showing
  });
}

function wireHealthDoc(el) {
  if (!el) return;
  const id = el.dataset.hdoc;
  const del = el.querySelector("[data-hdel]");
  if (del && !del._wired) { del._wired = true; del.addEventListener("click", () => startHealthDelete(del)); }

  // Date is read-only until the user explicitly asks to change it.
  const editBtn = el.querySelector("[data-hdate-edit]");
  if (editBtn && !editBtn._wired) {
    editBtn._wired = true;
    editBtn.addEventListener("click", () => {
      const editor = el.querySelector("[data-hdate-editor]");
      const flash = el.querySelector("[data-hdate-flash]");
      if (flash) flash.hidden = true;
      editBtn.hidden = true;
      if (editor) {
        editor.hidden = false;
        const inp = editor.querySelector("[data-hdate]");
        if (inp) inp.focus();
      }
    });
  }
  const saveBtn = el.querySelector("[data-hdate-save]");
  if (saveBtn && !saveBtn._wired) { saveBtn._wired = true; saveBtn.addEventListener("click", () => saveHealthDocDate(id)); }
  const cancelBtn = el.querySelector("[data-hdate-cancel]");
  if (cancelBtn && !cancelBtn._wired) {
    cancelBtn._wired = true;
    cancelBtn.addEventListener("click", () => {
      const editor = el.querySelector("[data-hdate-editor]");
      const inp = el.querySelector("[data-hdate]");
      if (inp) inp.value = inp.defaultValue; // discard the unsaved change
      if (editor) editor.hidden = true;
      if (editBtn) editBtn.hidden = false;
    });
  }
  const rescan = el.querySelector("[data-hrescan]");
  if (rescan && !rescan._wired) { rescan._wired = true; rescan.addEventListener("click", () => reanalyzeHealthDoc(id)); }

  // Collapse / expand the record's detail (the header and the collapsed teaser
  // both carry data-hdoc-toggle). Keeps a long history scannable.
  el.querySelectorAll("[data-hdoc-toggle]").forEach((t) => {
    if (t._wired) return;
    t._wired = true;
    const toggle = () => el.classList.toggle("hdoc-collapsed");
    t.addEventListener("click", toggle);
    if (t.getAttribute("role") === "button") {
      t.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    }
  });
}

// Save an explicitly-changed result date, confirm with a brief "✓ updated", and
// re-run the downstream trends + whole-picture review so analysis stays in sync.
async function saveHealthDocDate(id) {
  const row = $(`#hlist .hdoc[data-hdoc="${id}"]`);
  if (!row) return;
  const inp = row.querySelector("[data-hdate]");
  const save = row.querySelector("[data-hdate-save]");
  if (!inp) return;
  if (save) { save.disabled = true; save.textContent = "Saving…"; }
  let updated = null;
  try {
    updated = await api(`/health-docs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_date: inp.value || null }),
    });
  } catch {
    if (save) { save.disabled = false; save.textContent = "Save"; }
    toast("Couldn't update date");
    return;
  }
  if (updated && !updated.error) {
    row.innerHTML = healthDocInner(updated); // back to view mode with the new date
    wireHealthDoc(row);
    const flash = row.querySelector("[data-hdate-flash]");
    if (flash) { flash.hidden = false; setTimeout(() => { if (flash.isConnected) flash.hidden = true; }, 2200); }
    loadHealthMarkers(pollToken);
    paintHealthPicture(); // the review is now stale (date moved) → re-run nudge appears
  } else {
    if (save) { save.disabled = false; save.textContent = "Save"; }
    toast((updated && updated.error) || "Couldn't update date");
  }
}

// Re-run the agentic scan over a document's original file (re-extracts panels).
async function reanalyzeHealthDoc(id) {
  const row = $(`#hlist .hdoc[data-hdoc="${id}"]`);
  let updated = null;
  try {
    updated = await api(`/health-docs/${id}/reanalyze`, { method: "POST" });
  } catch {
    toast("Couldn't start re-analysis");
    return;
  }
  if (!updated || updated.error) { toast((updated && updated.error) || "Couldn't re-analyze"); return; }
  toast("Re-analyzing…");
  if (row) { row.innerHTML = healthDocInner(updated); wireHealthDoc(row); }
  pollHealthDoc(id);
}

function pollHealthDoc(id) {
  const tab = state.tab, token = pollToken;
  // Health ingestion reads PDFs/whole export folders and can run for minutes —
  // poll far longer than the activity/food default (~15s).
  pollEnrichment("/health-docs", id, {
    tab, token, tries: 100, interval: 4000,
    onUpdate: (row) => {
      if (state.meSeg !== "health" || state.healthSeg !== "records") return;
      const el = $(`#hlist .hdoc[data-hdoc="${row.id}"]`);
      if (el) { el.innerHTML = healthDocInner(row); wireHealthDoc(el); }
      if (row.enrichment_status === "done") {
        // An import may have split into NEW dated panels → reload the whole list
        // so they appear; also refresh the trends + the whole-picture review.
        loadHealthDocs();
        loadHealthMarkers(pollToken);
        paintHealthPicture();
      }
    },
  });
}

async function loadHealthDocs() {
  const wrap = $("#hlist");
  if (!wrap) return [];
  let docs = [];
  try { docs = await api("/health-docs"); } catch { docs = []; }
  if (state.tab !== "me" || state.meSeg !== "health" || !wrap.isConnected) return docs || [];
  if (!docs || !docs.length) { wrap.innerHTML = `<div class="empty">No documents yet.</div>`; return []; }
  wrap.innerHTML = docs.map((d, i) => healthDocHtml(d, i)).join("");
  wrap.querySelectorAll(".hdoc").forEach((el) => {
    wireHealthDoc(el);
    if (el.dataset.hdoc) {
      // resume polling any still-pending doc
      const status = el.querySelector(".enr-pending");
      if (status) pollHealthDoc(Number(el.dataset.hdoc));
    }
  });
  return docs;
}

// armed-× delete (no confirm dialog)
function startHealthDelete(btn) {
  const row = btn.closest(".hdoc");
  const id = row.dataset.hdoc;
  if (btn.dataset.armed) {
    api(`/health-docs/${id}`, { method: "DELETE" })
      .then(() => {
        toast("Removed"); row.remove();
        if (!$("#hlist").children.length) $("#hlist").innerHTML = `<div class="empty">No documents yet.</div>`;
        if (_hPic && _hPic.docCount > 0) { _hPic.docCount--; paintHealthPicture(); }
        loadHealthMarkers(pollToken);
      })
      .catch(() => toast("Failed"));
    return;
  }
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.textContent = "remove?";
  const reset = () => { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = "×"; clearTimeout(t); };
  const t = setTimeout(reset, 3000);
  btn.addEventListener("blur", reset, { once: true });
}

// ---------- Me: Life (trips / injuries / life events) ----------
const LIFE_KINDS = [["trip", "Trip"], ["injury", "Injury"], ["life_event", "Life event"]];
const LIFE_ICONS = { trip: "✈", injury: "🤕", life_event: "◆" };

function lifeKindLabel(k) {
  const m = LIFE_KINDS.find((x) => x[0] === k);
  return m ? m[1] : (k || "Event");
}

// meta_json may arrive as a JSON string or an object
function parsedMeta(ev) {
  let mj = ev.meta_json;
  if (typeof mj === "string") { try { mj = JSON.parse(mj); } catch { mj = null; } }
  return mj || {};
}

function fmtDateRange(start, end) {
  if (start && end && start !== end) return `${escHtml(start)} → ${escHtml(end)}`;
  if (start) return escHtml(start);
  if (end) return `until ${escHtml(end)}`;
  return "";
}

// Days until a start date (positive = upcoming, 0 = today/active, negative = past). null if no date.
function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(localISO() + "T00:00:00");
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return null;
  return Math.round((d - today) / 86400000);
}

// Is an event currently active or upcoming (not fully in the past, not archived)?
function eventActive(ev) {
  if (ev.archived) return false;
  const todayIso = localISO();
  if (ev.end_date) return ev.end_date >= todayIso;       // ends today or later
  if (ev.start_date) return true;                         // open-ended (e.g. ongoing injury)
  return true;
}

async function renderLife() {
  headerTitle.textContent = "Me";
  state.meSeg = "life";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("life", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Trips, injuries, and life events. The coach factors these into the workout you see — easing off around travel or an injury.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">Add to your timeline</h1>
    <div class="lifeadd">
      <div class="field" style="margin-bottom:9px"><label>Kind</label>
        <select id="lKind" class="selflex">${LIFE_KINDS.map(([k, l]) => `<option value="${k}">${LIFE_ICONS[k]} ${l}</option>`).join("")}</select>
      </div>
      <div id="lFields"></div>
      <button id="lAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
      <div id="lStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Timeline</h1>
    <div id="llist"></div>`;
  wireSeg(ME_HANDLERS);

  const kindSel = $("#lKind");
  kindSel.addEventListener("change", () => drawLifeFields(kindSel.value));
  drawLifeFields(kindSel.value);

  $("#lAdd").addEventListener("click", submitLifeEvent);

  loadLifeEvents();
}

// Render the kind-specific add fields into #lFields.
function drawLifeFields(kind) {
  const wrap = $("#lFields");
  if (!wrap) return;
  const inputStyle = `style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px"`;
  const text = (id, label, ph = "") =>
    `<div class="field" style="margin-bottom:9px"><label>${label}</label><input id="${id}" type="text" placeholder="${escAttr(ph)}" ${inputStyle}></div>`;
  const date = (id, label) =>
    `<div class="field" style="margin-bottom:9px"><label>${label}</label><input id="${id}" type="date" ${inputStyle} value=""></div>`;
  if (kind === "trip") {
    wrap.innerHTML =
      text("lTitle", "Title", "e.g. Lisbon work trip") +
      text("lLocation", "Location", "e.g. Lisbon") +
      `<div class="ob-grid">${date("lStart", "Start")}${date("lEnd", "End")}</div>` +
      text("lDetail", "Detail (optional)");
  } else if (kind === "injury") {
    wrap.innerHTML =
      text("lTitle", "Title", "e.g. Right knee") +
      text("lArea", "Area", "e.g. knee / lower back") +
      `<div class="field" style="margin-bottom:9px"><label>Severity</label>
        <select id="lSeverity" class="selflex">
          <option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option>
        </select></div>` +
      date("lStart", "Since") +
      date("lEnd", "Expected resolved (optional)") +
      text("lDetail", "Detail (optional)");
  } else {
    wrap.innerHTML =
      text("lTitle", "Title", "e.g. New baby") +
      `<div class="ob-grid">${date("lStart", "Start")}${date("lEnd", "End (optional)")}</div>` +
      `<div class="field" style="margin-bottom:9px"><label>Impact</label>
        <select id="lImpact" class="selflex">
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select></div>` +
      text("lDetail", "Detail (optional)");
  }
}

function collectLifeForm() {
  const kind = $("#lKind").value;
  const val = (id) => { const el = $("#" + id); return el && el.value.trim() ? el.value.trim() : null; };
  const title = val("lTitle");
  const detail = val("lDetail");
  const start_date = val("lStart");
  const end_date = val("lEnd");
  const meta = {};
  if (kind === "trip") { const loc = val("lLocation"); if (loc) meta.location = loc; }
  else if (kind === "injury") { const area = val("lArea"); if (area) meta.area = area; const sev = $("#lSeverity"); if (sev) meta.severity = sev.value; }
  else { const imp = $("#lImpact"); if (imp) meta.impact = imp.value; }
  return { kind, title, detail, start_date, end_date, meta };
}

async function submitLifeEvent() {
  const status = $("#lStatus");
  const body = collectLifeForm();
  if (!body.title) { status.textContent = "Add a title first."; $("#lTitle")?.focus(); return; }
  const btn = $("#lAdd");
  btn.disabled = true; btn.style.opacity = ".6";
  try {
    const r = await api("/context-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r && r.error) { status.textContent = "Failed: " + r.error; return; }
    status.textContent = "";
    toast("Added");
    // reset the text + dates but keep the kind
    drawLifeFields($("#lKind").value);
    loadLifeEvents();
  } catch (e) { status.textContent = "Failed: " + e.message; }
  finally { btn.disabled = false; btn.style.opacity = "1"; }
}

// One timeline card (view mode).
function lifeEventInner(ev) {
  const meta = parsedMeta(ev);
  const icon = LIFE_ICONS[ev.kind] || "◆";
  const range = fmtDateRange(ev.start_date, ev.end_date);
  const du = daysUntil(ev.start_date);
  let when = "";
  if (!ev.archived && du != null) {
    if (du > 0) when = `in ${du} day${du === 1 ? "" : "s"}`;
    else if (du === 0) when = `today`;
    else if (ev.kind !== "injury" && (!ev.end_date || ev.end_date < localISO())) when = "past";
    else when = "active";
  }
  const metaBits = [];
  if (meta.location) metaBits.push(escHtml(meta.location));
  if (meta.area) metaBits.push(escHtml(meta.area));
  if (meta.severity) metaBits.push(escHtml(meta.severity));
  if (meta.impact) metaBits.push(escHtml(meta.impact) + " impact");
  const metaLine = metaBits.join(" · ");
  return `<div class="sess-head">
      <span class="sess-date"><span class="life-ico">${icon}</span> ${escHtml(ev.title || lifeKindLabel(ev.kind))}</span>
      ${when ? `<span class="sess-day">${escHtml(when)}</span>` : ""}
    </div>
    ${range ? `<div class="sess-line" style="color:var(--muted)">${range}</div>` : ""}
    ${metaLine ? `<div class="sess-line" style="color:var(--muted);font-size:.78rem">${metaLine}</div>` : ""}
    ${ev.detail ? `<div class="sess-line">${escHtml(ev.detail)}</div>` : ""}
    <div class="hdoc-ctl">
      <button class="iconbtn" data-ledit="${ev.id}" title="edit">✎</button>
      <button class="iconbtn life-del" data-ldel="${ev.id}" title="delete">×</button>
    </div>`;
}

function lifeEventHtml(ev, i) {
  const past = !eventActive(ev) || ev.archived;
  const rev = typeof i === "number";
  return `<div class="sess life-ev${past ? " life-past" : ""}${rev ? " reveal" : ""}" data-life="${ev.id}"${rev ? ` style="${stagger(i)}"` : ""}>${lifeEventInner(ev)}</div>`;
}

async function loadLifeEvents() {
  const wrap = $("#llist");
  if (!wrap) return;
  let events = [];
  try { events = await api("/context-events"); } catch { events = []; }
  if (state.tab !== "me" || state.meSeg !== "life" || !wrap.isConnected) return;
  if (!events || !events.length) { wrap.innerHTML = `<div class="empty">Nothing on your timeline yet.</div>`; return; }
  // active/upcoming first (sorted by soonest start), then past/archived
  const active = events.filter((e) => eventActive(e));
  const past = events.filter((e) => !eventActive(e));
  const byStart = (a, b) => (a.start_date || "9999") < (b.start_date || "9999") ? -1 : 1;
  active.sort(byStart);
  past.sort((a, b) => byStart(b, a)); // most recent past first
  state._lifeById = Object.fromEntries(events.map((e) => [String(e.id), e]));
  wrap.innerHTML = [...active, ...past].map((ev, i) => lifeEventHtml(ev, i)).join("");

  wrap.querySelectorAll("[data-ledit]").forEach((b) => b.addEventListener("click", () => startLifeEdit(b.closest(".life-ev"))));
  wrap.querySelectorAll("[data-ldel]").forEach((b) => b.addEventListener("click", () => startLifeDelete(b)));
}

// Inline edit: swap the card body for a compact editable form.
function startLifeEdit(card) {
  if (!card || card.querySelector(".life-edit")) return;
  const id = card.dataset.life;
  const ev = (state._lifeById || {})[id];
  if (!ev) return;
  const meta = parsedMeta(ev);
  const inputStyle = `style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:8px 9px;font-size:.9rem"`;
  const metaField = ev.kind === "trip"
    ? `<input class="le-meta" placeholder="Location" value="${escAttr(meta.location || "")}" ${inputStyle}>`
    : ev.kind === "injury"
      ? `<input class="le-meta" placeholder="Area" value="${escAttr(meta.area || "")}" ${inputStyle}>`
      : "";
  const box = document.createElement("div");
  box.className = "life-edit";
  box.innerHTML = `
    <input class="le-title" placeholder="Title" value="${escAttr(ev.title || "")}" ${inputStyle}>
    ${metaField}
    <div class="ob-grid" style="margin-top:6px">
      <input class="le-start" type="date" value="${escAttr(ev.start_date || "")}" ${inputStyle}>
      <input class="le-end" type="date" value="${escAttr(ev.end_date || "")}" ${inputStyle}>
    </div>
    <input class="le-detail" placeholder="Detail" value="${escAttr(ev.detail || "")}" ${inputStyle} >
    <div class="life-edit-ctl">
      <button class="iconbtn memok le-save" title="save">✓</button>
      <button class="iconbtn le-cancel" title="cancel">×</button>
    </div>`;
  const prev = card.innerHTML;
  card.innerHTML = "";
  card.appendChild(box);
  box.querySelector(".le-title").focus();

  const cancel = () => { card.innerHTML = prev; rewireLifeCard(card); };
  const save = async () => {
    const v = (cls) => { const el = box.querySelector(cls); return el && el.value.trim() ? el.value.trim() : null; };
    const title = v(".le-title");
    if (!title) { box.querySelector(".le-title").focus(); return; }
    const newMeta = { ...meta };
    const metaEl = box.querySelector(".le-meta");
    if (metaEl) { const mv = metaEl.value.trim(); if (ev.kind === "trip") newMeta.location = mv || undefined; else if (ev.kind === "injury") newMeta.area = mv || undefined; }
    try {
      await api(`/context-events/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: ev.kind, title, detail: v(".le-detail"), start_date: v(".le-start"), end_date: v(".le-end"), meta: newMeta }),
      });
    } catch { toast("Failed"); return; }
    toast("Updated"); loadLifeEvents();
  };
  box.querySelector(".le-save").addEventListener("click", save);
  box.querySelector(".le-cancel").addEventListener("click", cancel);
}

function rewireLifeCard(card) {
  const e = card.querySelector("[data-ledit]"); if (e) e.addEventListener("click", () => startLifeEdit(card));
  const d = card.querySelector("[data-ldel]"); if (d) d.addEventListener("click", () => startLifeDelete(d));
}

// armed-× delete (no confirm dialog)
function startLifeDelete(btn) {
  const card = btn.closest(".life-ev");
  const id = card.dataset.life;
  if (btn.dataset.armed) {
    api(`/context-events/${id}`, { method: "DELETE" })
      .then(() => { toast("Removed"); loadLifeEvents(); })
      .catch(() => toast("Failed"));
    return;
  }
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.textContent = "remove?";
  const reset = () => { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = "×"; clearTimeout(t); };
  const t = setTimeout(reset, 3000);
  btn.addEventListener("blur", reset, { once: true });
}

// ---------- Me: Family (the people the coach plans around) ----------
// Family is warm context, not surveillance: who's in your life, so the buddy
// plans around the school run and the 6am-with-kids reality. Recurring
// commitments (soccer Tuesdays) live on the Life timeline as family_event
// context_events — this roster is the people, not their calendar.

// A small Atelier swatch palette drawn from the design tokens. Each entry is the
// stored color value (the token's hex) plus a display label.
const FAMILY_COLORS = [
  { v: "#b4552d", l: "Terracotta" },
  { v: "#6e7f5c", l: "Sage" },
  { v: "#c9a86a", l: "Gold" },
  { v: "#8e4f6d", l: "Plum" },
  { v: "#57503f", l: "Ink" },
  { v: "#7d8f5e", l: "Olive" },
];
const FAMILY_DEFAULT_COLOR = FAMILY_COLORS[0].v;

function familyColor(c) {
  const v = String(c || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : FAMILY_DEFAULT_COLOR;
}

// Plain-language age from a free-text YYYY-MM-DD birthdate. Babies read in months;
// everyone else in years. Null/garbage → "" (no age line shown).
function ageFromBirthdate(bd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(bd || ""));
  if (!m) return "";
  const b = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(b)) return "";
  const now = new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months--;
  if (months < 0) return "";
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yr`;
}

// Two-initials monogram from a name (deterministic, no caller text in markup risk —
// it's escHtml'd at the call site).
function familyInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function familyCardInner(f) {
  const color = familyColor(f.color);
  const age = ageFromBirthdate(f.birthdate);
  const meta = [];
  if (f.relationship) meta.push(escHtml(f.relationship));
  if (age) meta.push(escHtml(age));
  return `<div class="fam-head">
      <span class="fam-mono" style="--fam:${escAttr(color)}">${escHtml(familyInitials(f.name))}</span>
      <div class="fam-id">
        <span class="fam-name">${escHtml(f.name || "Someone")}</span>
        ${meta.length ? `<span class="fam-meta">${meta.join(" · ")}</span>` : ""}
      </div>
    </div>
    ${f.notes ? `<div class="sess-line fam-notes">${escHtml(f.notes)}</div>` : ""}
    <div class="hdoc-ctl">
      <button class="iconbtn" data-fedit="${f.id}" title="edit">✎</button>
      <button class="iconbtn fam-del" data-fdel="${f.id}" title="delete">×</button>
    </div>`;
}

function familyCardHtml(f, i) {
  const rev = typeof i === "number";
  return `<div class="sess fam-card${rev ? " reveal" : ""}" data-fam="${f.id}"${rev ? ` style="${stagger(i)}"` : ""}>${familyCardInner(f)}</div>`;
}

// The swatch row for the add/edit forms. `selected` is the chosen hex.
function familySwatches(selected) {
  const sel = familyColor(selected);
  return `<div class="fam-swatches" role="radiogroup" aria-label="Colour">
    ${FAMILY_COLORS.map((c) => `<button type="button" class="fam-swatch${c.v === sel ? " fam-swatch-on" : ""}" data-color="${escAttr(c.v)}" style="--fam:${escAttr(c.v)}" title="${escAttr(c.l)}" aria-label="${escAttr(c.l)}"></button>`).join("")}
  </div>`;
}

async function renderFamily() {
  headerTitle.textContent = "Me";
  state.meSeg = "family";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("family", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      The people in your life, so the coach plans around them — never the hardest session on the chaos day. Recurring commitments like the school run or a kid's soccer night live on your <button class="linkbtn" id="famToLife">Life timeline</button> as events.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">Add someone</h1>
    <div class="lifeadd famadd">
      <div class="field" style="margin-bottom:9px"><label>Name</label>
        <input id="fName" type="text" placeholder="e.g. Mara" style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px"></div>
      <div class="field" style="margin-bottom:9px"><label>Relationship (optional)</label>
        <input id="fRel" type="text" placeholder="e.g. daughter / partner" style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px"></div>
      <div class="field" style="margin-bottom:9px"><label>Birthday (optional)</label>
        <input id="fBirth" type="date" max="${localISO()}" style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px;color-scheme:light"></div>
      <div class="field" style="margin-bottom:9px"><label>Colour</label>${familySwatches(FAMILY_DEFAULT_COLOR)}</div>
      <div class="field" style="margin-bottom:9px"><label>Notes (optional)</label>
        <input id="fNotes" type="text" placeholder="e.g. trains with me on weekends" style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:10px"></div>
      <button id="fAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
      <div id="fStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Your people</h1>
    <div id="flist"></div>`;
  wireSeg(ME_HANDLERS);

  $("#famToLife")?.addEventListener("click", () => withViewTransition(() => renderLife().then(viewEnter)));

  // swatch picker (add form)
  let addColor = FAMILY_DEFAULT_COLOR;
  view.querySelectorAll(".famadd .fam-swatch").forEach((b) => b.addEventListener("click", () => {
    addColor = b.dataset.color;
    view.querySelectorAll(".famadd .fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
  }));

  $("#fAdd").addEventListener("click", async () => {
    const status = $("#fStatus");
    const name = $("#fName").value.trim();
    if (!name) { status.textContent = "Add a name first."; $("#fName").focus(); return; }
    const body = {
      name,
      relationship: $("#fRel").value.trim() || null,
      birthdate: $("#fBirth").value || null,
      color: addColor,
      notes: $("#fNotes").value.trim() || null,
    };
    const btn = $("#fAdd");
    btn.disabled = true; btn.style.opacity = ".6";
    try {
      const r = await api("/family", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r && r.error) { status.textContent = "Failed: " + r.error; return; }
      status.textContent = "";
      toast("Added");
      $("#fName").value = ""; $("#fRel").value = ""; $("#fBirth").value = ""; $("#fNotes").value = "";
      loadFamily();
    } catch (e) { status.textContent = "Failed: " + e.message; }
    finally { btn.disabled = false; btn.style.opacity = "1"; }
  });

  loadFamily();
}

async function loadFamily() {
  const wrap = $("#flist");
  if (!wrap) return;
  let people = [];
  try { people = await api("/family"); } catch { people = []; }
  if (state.tab !== "me" || state.meSeg !== "family" || !wrap.isConnected) return;
  if (!Array.isArray(people) || !people.length) {
    wrap.innerHTML = `<div class="empty">No one here yet. Add the people you plan your weeks around.</div>`;
    return;
  }
  state._famById = Object.fromEntries(people.map((f) => [String(f.id), f]));
  wrap.innerHTML = people.map((f, i) => familyCardHtml(f, i)).join("");
  wrap.querySelectorAll("[data-fedit]").forEach((b) => b.addEventListener("click", () => startFamilyEdit(b.closest(".fam-card"))));
  wrap.querySelectorAll("[data-fdel]").forEach((b) => b.addEventListener("click", () => startFamilyDelete(b)));
}

// Inline edit: swap the card body for a compact editable form (mirrors Life's pattern).
function startFamilyEdit(card) {
  if (!card || card.querySelector(".fam-edit")) return;
  const id = card.dataset.fam;
  const f = (state._famById || {})[id];
  if (!f) return;
  const inputStyle = `style="width:100%;background:var(--card-2);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:8px 9px;font-size:.9rem"`;
  let editColor = familyColor(f.color);
  const box = document.createElement("div");
  box.className = "fam-edit";
  box.innerHTML = `
    <input class="fe-name" placeholder="Name" value="${escAttr(f.name || "")}" ${inputStyle}>
    <input class="fe-rel" placeholder="Relationship" value="${escAttr(f.relationship || "")}" ${inputStyle}>
    <input class="fe-birth" type="date" max="${localISO()}" value="${escAttr(f.birthdate || "")}" ${inputStyle} style="color-scheme:light">
    ${familySwatches(editColor)}
    <input class="fe-notes" placeholder="Notes" value="${escAttr(f.notes || "")}" ${inputStyle}>
    <div class="life-edit-ctl">
      <button class="iconbtn memok fe-save" title="save">✓</button>
      <button class="iconbtn fe-cancel" title="cancel">×</button>
    </div>`;
  const prev = card.innerHTML;
  card.innerHTML = "";
  card.appendChild(box);
  box.querySelector(".fe-name").focus();
  box.querySelectorAll(".fam-swatch").forEach((b) => b.addEventListener("click", () => {
    editColor = b.dataset.color;
    box.querySelectorAll(".fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
  }));

  const cancel = () => { card.innerHTML = prev; rewireFamilyCard(card); };
  const save = async () => {
    const v = (cls) => { const el = box.querySelector(cls); return el && el.value.trim() ? el.value.trim() : null; };
    const name = v(".fe-name");
    if (!name) { box.querySelector(".fe-name").focus(); return; }
    try {
      await api(`/family/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, relationship: v(".fe-rel"), birthdate: v(".fe-birth"), color: editColor, notes: v(".fe-notes") }),
      });
    } catch { toast("Failed"); return; }
    toast("Updated"); loadFamily();
  };
  box.querySelector(".fe-save").addEventListener("click", save);
  box.querySelector(".fe-cancel").addEventListener("click", cancel);
}

function rewireFamilyCard(card) {
  const e = card.querySelector("[data-fedit]"); if (e) e.addEventListener("click", () => startFamilyEdit(card));
  const d = card.querySelector("[data-fdel]"); if (d) d.addEventListener("click", () => startFamilyDelete(d));
}

// armed-× delete (no confirm dialog) — same idiom as Life / Memory / Health docs.
function startFamilyDelete(btn) {
  const card = btn.closest(".fam-card");
  const id = card.dataset.fam;
  if (btn.dataset.armed) {
    api(`/family/${id}`, { method: "DELETE" })
      .then(() => { toast("Removed"); loadFamily(); })
      .catch(() => toast("Failed"));
    return;
  }
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.textContent = "remove?";
  const reset = () => { delete btn.dataset.armed; btn.classList.remove("armed"); btn.textContent = "×"; clearTimeout(t); };
  const t = setTimeout(reset, 3000);
  btn.addEventListener("blur", reset, { once: true });
}

// ---------- Plan editor (manual) ----------
async function renderPlanEditor() {
  headerTitle.textContent = "Plan";
  view.innerHTML = segSkeleton("edit", PLAN_SEG, 3);
  const plan = await api("/plan");
  view.innerHTML = segBar("edit", PLAN_SEG) + `<div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>`;
  wireSeg(PLAN_HANDLERS);

  const model = plan.map((d) => ({
    day_number: d.day_number, name: d.name, focus: d.focus || "",
    items: d.items.map((it) => ({
      exercise: it.exercise, sets: it.sets, rep_low: it.rep_low, rep_high: it.rep_high, target_weight: it.target_weight,
      note: it.note ?? "", warmup_sets: it.warmup_sets ?? null, muscle_group: it.muscle_group ?? null,
      target_seconds: it.target_seconds ?? null, mode: it.mode ?? null, // carried through so saving never drops timed targets
    })),
  }));
  const editing = new Set(); // day indices currently flipped into the editor

  function sync() {
    view.querySelectorAll(".pday").forEach((dayEl) => {
      const d = model[+dayEl.dataset.d]; if (!d) return;
      d.name = dayEl.querySelector(".pday-name").value;
      d.focus = dayEl.querySelector(".pday-focus").value;
    });
    view.querySelectorAll(".pitem").forEach((itEl) => {
      const d = model[+itEl.dataset.d]; const it = d && d.items[+itEl.dataset.i]; if (!it) return;
      const num = (sel) => { const v = itEl.querySelector(sel).value; return v === "" ? null : Number(v); };
      it.exercise = itEl.querySelector(".pi-ex").value;
      it.sets = num(".pi-sets") ?? 3; it.rep_low = num(".pi-lo"); it.rep_high = num(".pi-hi"); it.target_weight = num(".pi-tw");
      it.warmup_sets = num(".pi-wu"); it.note = itEl.querySelector(".pi-note").value;
    });
  }

  // Gallery card: the default, beautiful state of a plan day (read-only catalog page).
  function progDayHtml(d, di) {
    const strip = d.items.map((it) => {
      const t = artImg("exercise", it.exercise, "artile-md strip-tile", art("exercise", it.exercise, it.muscle_group));
      return t ? `<div data-guide="${encodeURIComponent(it.exercise)}" style="cursor:pointer">${t}</div>` : "";
    }).join("");
    const rows = d.items.map((it) => {
      const t = artImg("exercise", it.exercise, "artile-sm", art("exercise", it.exercise, it.muscle_group));
      const timed = it.mode === "timed" || it.target_seconds != null;
      const range = timed
        ? (it.target_seconds != null ? fmtDur(it.target_seconds) : "time")
        : (it.rep_low === it.rep_high ? `${it.rep_low ?? ""}` : `${it.rep_low ?? "?"}–${it.rep_high ?? "?"}`);
      const hints = [
        it.warmup_sets ? `${it.warmup_sets} warmup` : null,
        it.note ? escHtml(it.note) : null,
      ].filter(Boolean).join(" · ");
      return `<div class="prog-row">
          ${t}
          <div class="prog-row-main">
            <button class="prog-row-name" data-guide="${encodeURIComponent(it.exercise)}">${escHtml(it.exercise)}</button>
            ${hints ? `<div class="prog-row-hint">${hints}</div>` : ""}
          </div>
          <div class="prog-row-nums">
            <span class="numeral">${it.sets ?? "?"} × ${range}</span>
            ${!timed && it.target_weight != null ? `<span class="numeral prog-row-wt">${fmtWeight(it.target_weight)}</span>` : ""}
          </div>
        </div>`;
    }).join("");
    return `<div class="prog-day reveal" style="${stagger(di)}" data-pd="${di}">
        <div class="prog-head">
          <div class="prog-head-main">
            <div class="lbl">Day ${d.day_number}</div>
            <div class="prog-name">${escHtml(d.name || `Day ${d.day_number}`)}</div>
            ${d.focus ? `<div class="prog-focus">${escHtml(d.focus)}</div>` : ""}
          </div>
          <button class="ghostbtn prog-edit" data-editday="${di}">Edit day</button>
        </div>
        ${strip ? `<div class="prog-strip">${strip}</div>` : ""}
        <div class="prog-list">${rows || `<div class="empty">No exercises yet — tap Edit day.</div>`}</div>
      </div>`;
  }

  // Editor card: the pre-existing .pday / .pi-* markup, flipped in per day via "Edit day".
  function pdayHtml(d, di) {
    return `<div class="pday" data-d="${di}">
        <div class="pday-head">
          <input class="pday-name" value="${escAttr(d.name)}" placeholder="Day name">
          <button class="ghostbtn pday-done" data-doneday="${di}">Done</button>
          <button class="delbtn" data-delday="${di}">✕</button>
        </div>
        <input class="pday-focus" value="${escAttr(d.focus)}" placeholder="Focus (optional)">
        ${d.items.map((it, ii) => `
          <div class="pitem" data-d="${di}" data-i="${ii}">
            <div class="pi-row1">
              <input class="pi-ex" value="${escAttr(it.exercise)}" placeholder="Exercise">
              <div class="pi-ord">
                <button class="ordbtn" data-upitem="${di}:${ii}" ${ii === 0 ? "disabled" : ""}>↑</button>
                <button class="ordbtn" data-downitem="${di}:${ii}" ${ii === d.items.length - 1 ? "disabled" : ""}>↓</button>
              </div>
            </div>
            <div class="pi-nums">
              <input class="pi-sets" type="number" inputmode="numeric" value="${it.sets ?? ""}" placeholder="sets">
              <input class="pi-lo" type="number" inputmode="numeric" value="${it.rep_low ?? ""}" placeholder="lo">
              <input class="pi-hi" type="number" inputmode="numeric" value="${it.rep_high ?? ""}" placeholder="hi">
              <input class="pi-tw" type="number" inputmode="decimal" value="${it.target_weight ?? ""}" placeholder="wt">
              <input class="pi-wu" type="number" inputmode="numeric" value="${it.warmup_sets ?? ""}" placeholder="WU">
              <button class="delbtn" data-delitem="${di}:${ii}">✕</button>
            </div>
            <input class="pi-note" value="${escAttr(it.note || "")}" placeholder="Note (optional)">
          </div>`).join("")}
        <button class="ghostbtn" data-additem="${di}">+ exercise</button>
      </div>`;
  }

  function draw() {
    $("#planedit").innerHTML = model.map((d, di) => editing.has(di) ? pdayHtml(d, di) : progDayHtml(d, di)).join("");
    wireGuides($("#planedit"));

    view.querySelectorAll("[data-editday]").forEach((b) => b.addEventListener("click", () => {
      sync(); editing.add(+b.dataset.editday); draw();
    }));
    view.querySelectorAll("[data-doneday]").forEach((b) => b.addEventListener("click", () => {
      sync(); editing.delete(+b.dataset.doneday); draw();
    }));
    view.querySelectorAll("[data-delday]").forEach((b) => b.addEventListener("click", () => {
      sync();
      const del = +b.dataset.delday;
      model.splice(del, 1);
      const keep = [...editing].filter((i) => i !== del).map((i) => (i > del ? i - 1 : i));
      editing.clear(); keep.forEach((i) => editing.add(i));
      planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-delitem]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii] = b.dataset.delitem.split(":").map(Number); model[di].items.splice(ii, 1); planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-additem]").forEach((b) => b.addEventListener("click", () => {
      sync(); model[+b.dataset.additem].items.push({ exercise: "", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, note: "", warmup_sets: null }); planBar.markDirty(); draw();
    }));
    view.querySelectorAll("[data-upitem]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii] = b.dataset.upitem.split(":").map(Number);
      const items = model[di].items;
      if (ii > 0) { [items[ii - 1], items[ii]] = [items[ii], items[ii - 1]]; planBar.markDirty(); draw(); }
    }));
    view.querySelectorAll("[data-downitem]").forEach((b) => b.addEventListener("click", () => {
      sync(); const [di, ii] = b.dataset.downitem.split(":").map(Number);
      const items = model[di].items;
      if (ii < items.length - 1) { [items[ii + 1], items[ii]] = [items[ii], items[ii + 1]]; planBar.markDirty(); draw(); }
    }));
  }

  $("#addDay").addEventListener("click", () => {
    sync();
    const next = model.reduce((m, d) => Math.max(m, d.day_number), 0) + 1;
    model.push({ day_number: next, name: `Day ${next}`, focus: "", items: [] });
    editing.add(model.length - 1); // a fresh day opens straight into the editor
    planBar.markDirty(); draw();
  });

  const persistPlan = async () => {
    sync();
    const days = model.map((d, i) => ({
      day_number: i + 1, name: d.name || `Day ${i + 1}`, focus: d.focus || null,
      items: d.items.filter((it) => it.exercise && it.exercise.trim()).map((it) => ({
        exercise: it.exercise.trim(), sets: it.sets, rep_low: it.rep_low, rep_high: it.rep_high,
        target_weight: it.target_weight, note: it.note && it.note.trim() ? it.note.trim() : null,
        warmup_sets: it.warmup_sets ?? null,
        target_seconds: it.target_seconds ?? null, // preserve timed targets across edits
      })),
    }));
    if (!days.length) { $("#planstatus").textContent = "Add at least one day before saving."; return false; }
    const r = await api("/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
    if (r.error) { $("#planstatus").textContent = "Error: " + r.error; return false; }
    state.plan = [];
    renderPlanEditor(); // fresh render — the save bar finishes its success flash on top
    return true;
  };
  // floating save bar: edits inside any day editor (or structural changes via
  // markDirty above) surface Save/Discard right above the tab bar
  const planBar = mountSaveBar({
    sentinel: $("#planedit"),
    fields: $("#planedit"),
    onSave: persistPlan,
    onDiscard: () => renderPlanEditor(),
  });

  draw();
}

// ---------- Chat ----------
// Document-level paste listener for the chat view; swapped on every renderChat.
let chatPasteHandler = null;
// Downscale + re-encode a picked photo to JPEG before upload: phone camera
// shots are 3-12MB HEIC/JPEG; ~1280px @ q0.82 is plenty for a plate estimate
// (and Safari decodes HEIC natively, so re-encoding also normalizes the type).
async function compressChatImage(file, maxEdge = 1280, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Couldn't read that image"));
      i.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", quality);
    return { dataUrl, base64: dataUrl.split(",")[1], mime: "image/jpeg" };
  } finally { URL.revokeObjectURL(url); }
}

// Convert a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") to a local YYYY-MM-DD
// for day grouping; falls back to today on anything unparseable.
function chatDayISO(ts) {
  if (!ts) return localISO();
  const d = new Date(String(ts).replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? localISO() : localISO(d);
}

function chatDivider(iso) {
  const el = document.createElement("div");
  el.className = "chat-divider";
  el.dataset.day = iso;
  el.innerHTML = `<span>${escHtml(dateLabel(iso))}</span>`;
  return el;
}

// Starter chips shown while the conversation is empty (fresh chat / after a
// fresh start); tapping one prefills the input and sends through the normal
// send path. They vanish as soon as the first message lands (appendMsg removes them).
const CHAT_STARTERS = ["Plan my week", "Evaluate my last meal", "How's my progress?", "Swap today's workout"];
function drawChatChips(log) {
  const wrap = document.createElement("div");
  wrap.className = "chat-chips";
  wrap.innerHTML = CHAT_STARTERS.map((t, i) => `<button class="chat-chip" style="--i:${i}">${escHtml(t)}</button>`).join("");
  log.appendChild(wrap);
  wrap.querySelectorAll(".chat-chip").forEach((b) => b.addEventListener("click", () => {
    const input = $("#chatInput");
    if (!input) return;
    input.value = b.textContent;
    const send = $("#chatSend");
    if (send) send.click();
  }));
}

// Expand the collapsed history block at the top of the chat log: smooth
// max-height + fade per the motion rules, while keeping the messages the
// athlete is looking at visually still. Anchoring re-measures the first
// visible element every frame (rather than accumulating deltas), so scroll
// clamping while the scroller is still shorter than its viewport self-corrects.
function expandChatEarlier(log, bar, block) {
  const logTop = log.getBoundingClientRect().top;
  const anchor = [...log.children].find((el) => el !== bar && el !== block && el.getBoundingClientRect().bottom > logTop) || null;
  const anchorY = anchor ? anchor.getBoundingClientRect().top : 0;
  const keep = () => { if (anchor) log.scrollTop += anchor.getBoundingClientRect().top - anchorY; };
  if (reducedMotion()) {
    bar.remove();
    block.hidden = false;
    keep();
    return;
  }
  block.hidden = false;
  block.style.overflow = "hidden";
  block.style.maxHeight = "0px";
  block.style.opacity = "0";
  bar.remove();
  keep();
  const target = block.scrollHeight;
  void block.offsetHeight; // commit the collapsed start state
  block.style.transition = "max-height var(--dur-3) var(--ease), opacity var(--dur-3) var(--ease)";
  block.style.maxHeight = target + "px";
  block.style.opacity = "1";
  const t0 = performance.now();
  const step = (t) => {
    if (!block.isConnected) return;
    keep();
    if (t - t0 < 600) { requestAnimationFrame(step); return; } // --dur-3 + settle
    block.style.maxHeight = ""; block.style.overflow = ""; block.style.transition = ""; block.style.opacity = "";
    keep();
  };
  requestAnimationFrame(step);
}

// Fresh-start affordance in the global header (sparkle, two-tap confirm).
// Re-created idempotently on every renderChat; renderTab removes it when the
// athlete leaves the Chat tab — no listeners outlive their element.
// Header affordances for Chat: a history/search button + the fresh-start
// (distill & archive) button, in one flex cluster anchored to the header.
// Re-created idempotently per renderChat; renderTab removes the cluster when
// the athlete leaves Chat — no listeners outlive their elements.
function ensureChatHeaderBtns() {
  document.getElementById("hdrChatActions")?.remove();
  const wrap = document.createElement("div");
  wrap.id = "hdrChatActions";
  wrap.className = "hdr-chat-actions";

  // history + search: always available (past conversations live on even when
  // the current thread is empty).
  const hist = document.createElement("button");
  hist.id = "hdrHistory";
  hist.className = "hdrcircbtn";
  hist.setAttribute("aria-label", "Past conversations & search");
  hist.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3.5 12a8.5 8.5 0 1 1 2.5 6"/><path d="M3.5 12H6M3.5 12V9.5"/><path d="M12 7.5V12l3 2"/>
    </svg>`;
  hist.addEventListener("click", openChatHistory);

  // fresh start (sparkle, two-tap confirm) — unchanged behavior.
  const b = document.createElement("button");
  b.id = "hdrFresh";
  b.className = "freshbtn";
  b.hidden = true;
  b.setAttribute("aria-label", "Start a fresh conversation");
  b.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 4.2l1.7 4.1 4.1 1.7-4.1 1.7L12 15.8l-1.7-4.1-4.1-1.7 4.1-1.7Z"/>
      <path d="M18.6 14.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7Z"/>
      <path d="M5.4 16.2l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55Z"/>
    </svg><span class="freshbtn-txt">Start fresh?</span>`;
  let disarm = null;
  b.addEventListener("click", () => {
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      clearTimeout(disarm);
      disarm = setTimeout(() => b.classList.remove("armed"), 4000);
      return;
    }
    clearTimeout(disarm);
    b.classList.remove("armed");
    chatFreshStart();
  });

  wrap.appendChild(hist);
  wrap.appendChild(b);
  document.querySelector("header").appendChild(wrap);
  return { freshBtn: b, historyBtn: hist };
}

// POST /api/chat/reset with an elegant in-log transition. The server distills
// durable facts into memory, then archives the conversation — archiving never
// blocks on the agent, so this always lands on a clean empty chat.
async function chatFreshStart() {
  const log = $("#chatlog");
  if (!log || state.tab !== "chat") return;
  const token = pollToken; // any full re-render bumps this — treat as stale
  const fresh = document.getElementById("hdrFresh");
  if (fresh) fresh.hidden = true;
  const sendBtn = $("#chatSend");
  if (sendBtn) sendBtn.disabled = true; // a mid-distill send would race the archive
  log.innerHTML = `<div class="distill"><span class="aspin aspin-sm" aria-hidden="true"></span><span>Distilling what matters…</span></div>`;
  log.scrollTop = 0;
  let r = null;
  try {
    r = await api("/chat/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch { /* archive happens server-side; a network blip just means we re-render */ }
  if (token !== pollToken || state.tab !== "chat" || !log.isConnected) return;
  const n = (r && r.ok && r.distilled) || 0;
  const el = log.querySelector(".distill");
  if (el) {
    el.innerHTML = `<span class="distill-check">✓</span><span>${n ? `${n} thing${n === 1 ? "" : "s"} remembered` : "Fresh start"}</span>`;
  }
  setTimeout(() => {
    if (token !== pollToken || state.tab !== "chat" || !log.isConnected) return;
    if (sendBtn) sendBtn.disabled = false;
    drawChat([]);
  }, 1200);
}

async function renderChat() {
  headerTitle.textContent = "Chat";
  document.body.classList.add("chat-mode"); // the chat column owns the viewport; drop body's tab-bar padding
  const token = ++pollToken; // bump so the async hydrate below can detect a stale tab
  const { freshBtn } = ensureChatHeaderBtns();
  // Paint the shell FIRST so the composer is usable instantly; the log hydrates
  // in the background. The flex viewport column keeps the composer pinned above
  // the tab bar no matter how the OS zooms (height is re-measured, not magic).
  view.innerHTML = `
    <div class="chatview">
      <div class="chatlog-wrap">
        <div id="chatlog" class="chatlog" aria-live="polite"></div>
        <button id="chatJump" class="chat-jump" hidden aria-label="Jump to latest">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="chatdock">
        <div id="chatPreview" class="chat-preview" hidden>
          <img alt="">
          <span class="chat-preview-hint">Photo attached — I'll estimate &amp; log it</span>
          <button id="chatPreviewX" class="chip-x" aria-label="Remove photo">✕</button>
        </div>
        <div class="chatbar">
          <button id="chatCam" class="attachbtn cambtn" aria-label="Take a photo of your plate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.1-1.7A1.5 1.5 0 0 1 10.05 3.6h3.9a1.5 1.5 0 0 1 1.25.7L16.3 6h1.2A2.5 2.5 0 0 1 20 8.5V17a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17Z"/>
              <circle cx="12" cy="12.5" r="3.4"/>
            </svg>
          </button>
          <button id="chatAttach" class="attachbtn" aria-label="Attach a photo from your library or files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="4" y="5" width="16" height="14" rx="2.5"/>
              <circle cx="9.2" cy="10" r="1.5"/>
              <path d="M4 16.5l4.4-4.2 3.4 3.2 3.1-2.9L20 16.5"/>
            </svg>
          </button>
          <input id="chatCamFile" type="file" accept="image/*" capture="environment" hidden>
          <input id="chatFile" type="file" accept="image/*" hidden>
          <input id="chatInput" type="text" autocomplete="off" placeholder="Ask your coach, log a ride, snap a plate…">
          <button id="chatSend" class="logbtn">↑</button>
        </div>
        <div class="chatnote">Logs apply instantly · plan changes arrive as drafts you Apply</div>
      </div>
    </div>`;

  const log = $("#chatlog");
  log.innerHTML = loadingState("Catching up…");
  wireChatJump(log, $("#chatJump"));
  measureChatTop();
  requestAnimationFrame(measureChatTop); // re-measure once layout/fonts settle

  const input = $("#chatInput"), sendBtn = $("#chatSend");
  const fileInput = $("#chatFile"), camInput = $("#chatCamFile");
  const attachBtn = $("#chatAttach"), camBtn = $("#chatCam"), preview = $("#chatPreview");
  let attached = null; // { dataUrl, base64, mime }

  const clearAttach = () => {
    attached = null;
    fileInput.value = "";
    camInput.value = "";
    preview.hidden = true;
    attachBtn.classList.remove("has-img");
    camBtn.classList.remove("has-img");
  };
  const attachFile = async (f) => {
    if (!f) return;
    try {
      attached = await compressChatImage(f);
      preview.querySelector("img").src = attached.dataUrl;
      preview.hidden = false;
      attachBtn.classList.add("has-img");
      camBtn.classList.add("has-img");
    } catch (e) { toast(e.message || "Couldn't read that image"); clearAttach(); }
  };
  attachBtn.addEventListener("click", () => fileInput.click());
  camBtn.addEventListener("click", () => camInput.click());
  $("#chatPreviewX").addEventListener("click", clearAttach);
  for (const inp of [fileInput, camInput]) {
    inp.addEventListener("change", () => {
      const f = inp.files && inp.files[0];
      if (f) attachFile(f);
    });
  }
  // Paste-an-image support (desktop screenshots, iOS "Copy Photo"). One live
  // handler at a time: re-renders swap it out, and it bails when chat isn't
  // the active tab so it never touches a stale DOM.
  if (chatPasteHandler) document.removeEventListener("paste", chatPasteHandler);
  chatPasteHandler = (e) => {
    if (state.tab !== "chat" || !input.isConnected) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); attachFile(f); }
        return;
      }
    }
  };
  document.addEventListener("paste", chatPasteHandler);

  const send = async () => {
    const text = input.value.trim();
    const img = attached;
    if (!text && !img) return;
    input.value = "";
    clearAttach();
    // Optimistic user bubble lands instantly; the assistant turn shows phased
    // captions ("Thinking…" → "Drafting…") so the (one-shot JSON) CLI round-trip
    // never reads as a frozen three-dot stall. True token streaming is out of
    // scope — the backend returns one blob — so this is the strongest honest
    // non-streaming latency UX: a phase the user can believe, never faked tokens.
    appendMsg({ role: "user", content: text || "(photo)", meta: img ? { image: img.dataUrl } : null });
    const pending = appendMsg({ role: "assistant", content: img ? "Reading your plate…" : "Thinking…", pending: true });
    const stopPhases = runChatPhases(pending, img);
    sendBtn.disabled = true;
    try {
      const body = { message: text };
      if (img) { body.image_base64 = img.base64; body.image_mime = img.mime; }
      const r = await api("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      stopPhases();
      pending.remove();
      appendMsg(r.message || { role: "assistant", content: r.reply || r.error || "(no reply)" });
      if ((r.drafts || []).length) { state.plan = []; toast("Draft ready — Apply below"); }
    } catch (e) {
      stopPhases();
      pending.remove();
      appendMsg({ role: "assistant", content: "Failed: " + e.message });
    } finally { sendBtn.disabled = false; if (matchMedia("(hover:hover)").matches) input.focus(); }
  };
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  // Deep links (e.g. the compass nudge) arrive with the question pre-written —
  // leave it editable rather than auto-sending.
  if (state.chatPrefill) { input.value = state.chatPrefill; state.chatPrefill = null; }
  // desktop only — on mobile, auto-focus pops the keyboard over half the view
  if (matchMedia("(hover:hover)").matches) input.focus();

  // Hydrate the log in the background — the shell above is already interactive.
  let msgs = [];
  try { msgs = await api("/chat?limit=200"); } catch { msgs = []; }
  if (token !== pollToken || !log.isConnected) return; // navigated away / re-rendered
  freshBtn.hidden = !msgs.length;
  drawChat(msgs);
  requestAnimationFrame(measureChatTop);
}

function drawChat(msgs) {
  const log = $("#chatlog");
  log.innerHTML = "";
  if (!msgs.length) {
    log.innerHTML = `<div class="empty">Say hi, log a ride, or ask the coach to change your plan.</div>`;
    drawChatChips(log);
    return;
  }
  // Group chronologically by local calendar day, splitting only at day
  // boundaries so dividers never duplicate across the collapse seam.
  const groups = [];
  for (const m of msgs) {
    const iso = chatDayISO(m.created_at);
    if (!groups.length || groups[groups.length - 1].iso !== iso) groups.push({ iso, msgs: [] });
    groups[groups.length - 1].msgs.push(m);
  }
  // The most recent stretch stays expanded: today's messages, or — when today
  // is empty — whole recent days until ~12 messages are visible.
  let cut = groups.length - 1;
  if (groups[cut].iso !== localISO()) {
    let count = groups[cut].msgs.length;
    while (cut > 0 && count < 12) { cut--; count += groups[cut].msgs.length; }
  }
  const earlier = groups.slice(0, cut);
  if (earlier.length) {
    const bar = document.createElement("div");
    bar.className = "chat-earlierbar";
    bar.innerHTML = `<button class="earlierbtn">Show earlier ↑</button>`;
    log.appendChild(bar);
    const block = document.createElement("div");
    block.className = "chat-earlier";
    block.hidden = true;
    for (const g of earlier) {
      block.appendChild(chatDivider(g.iso));
      for (const m of g.msgs) appendMsg(m, true, block);
    }
    log.appendChild(block);
    bar.querySelector("button").addEventListener("click", () => expandChatEarlier(log, bar, block));
  }
  for (const g of groups.slice(cut)) {
    log.appendChild(chatDivider(g.iso));
    for (const m of g.msgs) appendMsg(m, true);
  }
  log.scrollTop = log.scrollHeight;
}

// Local clock time for a chat turn ("2:14 PM"); now when no timestamp (the
// optimistic user bubble). Empty string if unparseable.
function chatClock(ts) {
  const d = ts ? new Date(String(ts).replace(" ", "T") + "Z") : new Date();
  if (isNaN(d.getTime())) return "";
  try { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
}

// Copy text to the clipboard with a graceful fallback + a confirming toast.
function copyText(text) {
  const t = String(text || "");
  if (!t) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(t).then(() => toast("Copied"), () => toast("Couldn't copy"));
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand("copy"); toast("Copied"); } catch { toast("Couldn't copy"); }
  ta.remove();
}
// Touch long-press → copy (the hover copy button is desktop-only).
function attachLongPressCopy(el, text) {
  let timer = 0;
  const cancel = () => clearTimeout(timer);
  el.addEventListener("touchstart", () => { cancel(); timer = setTimeout(() => copyText(text), 500); }, { passive: true });
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
}

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>`;

// Render one chat turn. `opts.readonly` (history overlay) renders drafts as a
// static note instead of an Apply button. Consecutive same-role turns group:
// the previous one drops its tail + time, this one becomes the run's last.
function appendMsg(m, noScroll, parent, opts = {}) {
  const log = $("#chatlog");
  const host = parent || log;
  const readonly = !!opts.readonly;
  if (!noScroll && !parent) {
    // a live turn: clear the loading/empty state + starter chips, and make sure
    // it lands under a "Today" divider
    log.querySelector(".loadstate")?.remove();
    log.querySelector(".empty")?.remove();
    log.querySelector(".chat-chips")?.remove();
    const divs = log.querySelectorAll(".chat-divider[data-day]");
    const last = divs[divs.length - 1];
    if (!last || last.dataset.day !== localISO()) log.appendChild(chatDivider(localISO()));
    const fresh = document.getElementById("hdrFresh");
    if (fresh && state.tab === "chat") fresh.hidden = false;
  }
  // Grouping: continue a same-role run (skip for the pending typing bubble).
  const prev = m.pending ? null : host.lastElementChild;
  const cont = !!prev && prev.classList?.contains("bubble") && prev.classList.contains(m.role) && !prev.classList.contains("pending");
  if (cont) { prev.classList.add("grouped"); prev.querySelector(".bubble-time")?.remove(); }

  const el = document.createElement("div");
  el.className = `bubble ${m.role}${m.pending ? " pending" : ""}${cont ? " cont" : ""}${noScroll ? "" : " bubble-in"}`;

  // Pending = the house typing indicator (breathing dots); an optional caption
  // ("Reading your plate…") leads, the dots follow. Early-return so a pending
  // bubble never picks up a timestamp or copy affordance.
  if (m.pending) {
    // role=status + aria-busy couples the visible "thinking" dots to a screen-
    // reader signal; the caption is the live phase ("Thinking…" → "Drafting…").
    el.setAttribute("role", "status");
    el.setAttribute("aria-busy", "true");
    const lead = m.content && m.content !== "…" ? `${escHtml(m.content)} ` : "";
    el.innerHTML = `<div class="bubble-text"><span class="typing-cap">${lead}</span><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
    host.appendChild(el);
    if (!noScroll && log) log.scrollTop = log.scrollHeight;
    return el;
  }

  const meta = m.meta;
  let extra = "";
  if (meta?.applied?.length) {
    extra += `<div class="bubble-meta">${meta.applied.map((a) => `<span class="bubble-tag">✓ ${escHtml(String(a.type).replace(/_/g, " "))}${a.error ? " ⚠" : ""}</span>`).join("")}</div>`;
  }
  if (meta?.drafts?.length) {
    // Each draft reflects its CURRENT proposal status (stamped server-side). An
    // applied one is a calm "done" note — no more Apply button to re-trigger it.
    extra += meta.drafts.map((d) => {
      const label = escHtml(d.summary || (d.kind === "restructure" ? "plan restructure" : "plan update"));
      if (d.status === "applied")
        return `<div class="draftbtn applied" aria-disabled="true">✓ Applied · ${label}</div>`;
      if (readonly)
        return `<div class="bubble-meta"><span class="bubble-tag">plan draft</span></div>`;
      return `<button class="draftbtn" data-apply="${escAttr(d.id)}">Apply: ${label}</button>`;
    }).join("");
  }
  const hideText = meta?.image && (!m.content || m.content === "(photo)");
  const body = hideText ? "" : m.role === "assistant"
    ? `<div class="bubble-text md">${mdToHtml(m.content)}</div>`
    : `<div class="bubble-text">${escHtml(m.content)}</div>`;
  const photo = meta?.image ? `<img class="bubble-img" alt="attached photo" loading="lazy" src="${escAttr(meta.image)}" onerror="this.remove()">` : "";
  const time = `<span class="bubble-time">${escHtml(chatClock(m.created_at))}</span>`;
  const canCopy = m.role === "assistant" && !hideText && !!m.content;
  const copyBtn = canCopy ? `<button class="bubble-copy" aria-label="Copy reply" title="Copy">${COPY_ICON}</button>` : "";
  el.innerHTML = `${copyBtn}${photo}${body}${extra}${time}`;
  host.appendChild(el);
  el.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    const r = await api(`/proposals/${b.dataset.apply}/apply`, { method: "POST" });
    toast(r.restructured ? "Plan restructured" : "Applied"); state.plan = [];
    // Settle into the same calm "done" note the message renders on reload, so a
    // just-applied draft and a long-applied one look identical.
    const label = b.textContent.replace(/^Apply:\s*/, "");
    const done = document.createElement("div");
    done.className = "draftbtn applied";
    done.setAttribute("aria-disabled", "true");
    done.textContent = `✓ Applied · ${label}`;
    b.replaceWith(done);
  }));
  if (canCopy) {
    el.querySelector(".bubble-copy")?.addEventListener("click", () => copyText(m.content));
    attachLongPressCopy(el, m.content);
  }
  if (!noScroll && log) log.scrollTop = log.scrollHeight;
  return el;
}

// Advance a pending assistant bubble's caption through honest phases while the
// (one-shot) chat round-trip runs, so the wait reads as a process rather than a
// frozen spinner. The agent returns one JSON blob — we never fake streamed
// tokens — so these are TIME-based phase labels, not content. Returns a stop()
// to call the moment the real reply (or an error) lands; idempotent + safe if
// the bubble was already removed. Captions are gentle, never urgent.
function runChatPhases(bubble, isPhoto) {
  // [delayMs, caption] — only advance to a phase once enough time has passed that
  // it's a believable description of where the call is. Photo logging leads with
  // its own caption from send(); both then converge on "Drafting…".
  const phases = isPhoto
    ? [[1500, "Reading your plate…"], [4500, "Estimating macros…"], [9000, "Drafting…"], [16000, "Almost there…"]]
    : [[0, "Thinking…"], [4500, "Looking at your day…"], [9000, "Drafting…"], [16000, "Almost there…"]];
  const t0 = performance.now();
  let timer = 0;
  const set = (txt) => {
    if (!bubble || !bubble.isConnected) return;
    const cap = bubble.querySelector(".typing-cap");
    if (!cap) return;
    cap.textContent = txt + " ";
    if (!reducedMotion()) { cap.style.animation = "none"; void cap.offsetWidth; cap.style.animation = ""; } // restart the gentle fade
  };
  const schedule = (i) => {
    if (i >= phases.length) return;
    const [delay, txt] = phases[i];
    const wait = Math.max(0, delay - (performance.now() - t0));
    timer = setTimeout(() => { set(txt); schedule(i + 1); }, wait);
  };
  // start from the first phase whose delay has already elapsed (delay 0 = now)
  schedule(0);
  return () => { clearTimeout(timer); };
}

// Show/hide the "jump to latest" pill as the log scrolls away from the bottom.
function wireChatJump(log, jump) {
  if (!log || !jump) return;
  const update = () => {
    const off = log.scrollHeight - log.scrollTop - log.clientHeight;
    jump.hidden = off < 120;
  };
  log.addEventListener("scroll", update, { passive: true });
  jump.addEventListener("click", () =>
    log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" }));
  update();
}

// Size the chat column to the live viewport so the composer is always pinned
// above the tab bar — re-measured on zoom/keyboard/orientation, never a magic
// number. Uses visualViewport so an open keyboard lifts the composer above it.
function measureChatTop() {
  const cv = document.querySelector(".chatview");
  if (!cv) return;
  const header = document.querySelector("header");
  const tab = document.querySelector(".tabbar");
  const vv = window.visualViewport;
  const vh = vv ? vv.height : window.innerHeight;
  const offTop = vv ? vv.offsetTop : 0;
  const headerBottom = header ? header.getBoundingClientRect().bottom - offTop : 0;
  const desktop = matchMedia("(min-width:960px)").matches;
  let bottomGap = 18; // breathing room above the viewport floor (desktop sidebar)
  if (!desktop && tab) {
    const tabTop = tab.getBoundingClientRect().top - offTop;
    bottomGap = Math.max(0, vh - tabTop); // the tab bar's footprint in the visual viewport
  }
  cv.style.height = Math.max(220, vh - headerBottom - bottomGap) + "px";
}

// ---------- chat history overlay (read-only browse + search) ----------
// A human day label for an archived UTC timestamp ("today" / "3 days ago" / …).
function histWhen(ts) { return humanDate(chatDayISO(ts)); }

// Escape text, then emphasize the search term with <mark> (safe — marks added
// after escaping). Term is regex-escaped.
function highlightTerm(text, q) {
  const esc = escHtml(text);
  const term = (q || "").trim();
  if (!term) return esc;
  try {
    const re = new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    return esc.replace(re, "<mark>$1</mark>");
  } catch { return esc; }
}

const HIST_CHEV = `<span class="chat-hist-chev" aria-hidden="true">›</span>`;
function histSessionRow(s) {
  return `<button class="chat-hist-item" data-session="${escAttr(s.archived_at)}">
    <span class="chat-hist-main">
      <span class="chat-hist-preview">${escHtml(s.preview || "Conversation")}</span>
      <span class="chat-hist-meta">${escHtml(histWhen(s.ended_at))} · ${s.count} message${s.count === 1 ? "" : "s"}</span>
    </span>${HIST_CHEV}</button>`;
}
function histHitRow(h, q) {
  const sess = h.archived_at || "live";
  return `<button class="chat-hist-item" data-open="${escAttr(sess)}">
    <span class="chat-hist-main">
      <span class="chat-hist-preview">${highlightTerm(h.snippet, q)}</span>
      <span class="chat-hist-meta">${h.role === "user" ? "You" : "Coach"} · ${escHtml(histWhen(h.created_at))}${h.archived_at ? "" : " · current"}</span>
    </span>${HIST_CHEV}</button>`;
}

// Open the read-only history/search overlay (reuses the .detail scaffold, so
// ✕ / Escape / backdrop / tab-switch all close it).
function openChatHistory() {
  const d = mountDetail(`
    <div class="chat-hist">
      <h2 class="detail-title">Conversations</h2>
      <div class="chat-hist-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="chatHistSearch" type="search" placeholder="Search every conversation…" autocomplete="off" autocapitalize="off">
      </div>
      <div id="chatHistBody" class="chat-hist-body"></div>
    </div>`);
  const body = d.querySelector("#chatHistBody");
  const searchInput = d.querySelector("#chatHistSearch");

  const renderSessions = async () => {
    body.innerHTML = loadingState("Gathering your conversations…");
    let sessions = [];
    try { sessions = await api("/chat/sessions"); } catch { sessions = []; }
    if (!d.isConnected || searchInput.value.trim()) return;
    if (!sessions.length) { body.innerHTML = `<div class="empty">No past conversations yet.<br>Start one, and a “fresh start” will tuck it here.</div>`; return; }
    body.innerHTML = `<div class="chat-hist-list">${sessions.map(histSessionRow).join("")}</div>`;
    body.querySelectorAll("[data-session]").forEach((el) =>
      el.addEventListener("click", () => openConversation(el.dataset.session)));
  };

  const runSearch = async (q) => {
    body.innerHTML = loadingState("Searching…");
    let hits = [];
    try { hits = await api("/chat/search?q=" + encodeURIComponent(q)); } catch { hits = []; }
    if (!d.isConnected || searchInput.value.trim() !== q) return; // stale / cleared
    if (!hits.length) { body.innerHTML = `<div class="empty">No matches for “${escHtml(q)}”.</div>`; return; }
    body.innerHTML = `<div class="chat-hist-list">${hits.map((h) => histHitRow(h, q)).join("")}</div>`;
    body.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => {
      const sess = el.dataset.open;
      if (sess === "live") { closeDetail(); toast("In your current conversation"); return; }
      openConversation(sess);
    }));
  };

  const openConversation = async (archivedAt) => {
    body.innerHTML = loadingState("Opening…");
    let msgs = [];
    try { msgs = await api("/chat/sessions/" + encodeURIComponent(archivedAt)); } catch { msgs = []; }
    if (!d.isConnected) return;
    body.innerHTML = `<button class="chat-hist-back">← All conversations</button><div id="chatHistConvo" class="chatlog chat-hist-convo"></div>`;
    body.querySelector(".chat-hist-back").addEventListener("click", () => { searchInput.value = ""; renderSessions(); });
    const convo = body.querySelector("#chatHistConvo");
    let lastDay = null;
    for (const m of msgs) {
      const day = chatDayISO(m.created_at);
      if (day !== lastDay) { convo.appendChild(chatDivider(day)); lastDay = day; }
      appendMsg(m, true, convo, { readonly: true });
    }
  };

  let searchTimer = 0;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) { renderSessions(); return; }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });

  renderSessions();
}

// ---------- Settings (agent rotation + auto-coach) ----------
// Garmin sync status line: colored dot + relative time + the short result the
// server recorded ("ok: 12 activities · 14 daily" / "failed: …").
function garminStatusLine(s, syncing) {
  if (syncing) return `<span class="sync-dot pulse"></span><span class="sync-text">Syncing…</span>`;
  const at = s && s.garmin_last_sync_at;
  const raw = String((s && s.garmin_last_sync_status) || "");
  if (!at) return `<span class="sync-dot"></span><span class="sync-text">Never synced</span>`;
  const ok = raw.startsWith("ok");
  const text = raw.replace(/^(ok|failed):\s*/, "");
  return `<span class="sync-dot ${ok ? "ok" : "err"}"></span>
    <span class="sync-text">${ok ? "Synced" : "Sync failed"} ${escHtml(relTime(at))}${text ? ` · ${escHtml(text)}` : ""}</span>`;
}

// Agent-health card — a small, calm read on the coaching brain's reliability:
// overall ok-rate + per-agent latency, mirroring the art-spend card's ledger
// style. NO scores, just plain words. Returns "" when the endpoint is absent or
// empty (Stream 1's GET /api/agent-stats may 404 on an older backend → silent).
function agentHealthCard(st) {
  if (!st || !Number(st.runs)) return "";
  const pct = st.ok_rate != null ? Math.round(Number(st.ok_rate) * 100) : null;
  const ms = (v) => { const n = Number(v) || 0; return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`; };
  const okLine = pct != null
    ? `<b>${pct}%</b> of recent runs returned cleanly · ${Number(st.runs)} run${Number(st.runs) === 1 ? "" : "s"} tracked`
    : `${Number(st.runs)} run${Number(st.runs) === 1 ? "" : "s"} tracked`;
  const rows = (Array.isArray(st.by_agent) ? st.by_agent : []).filter((a) => a && a.agent).map((a) => {
    const tot = (Number(a.ok) || 0) + (Number(a.fail) || 0);
    const apct = tot ? Math.round((Number(a.ok) || 0) / tot * 100) : null;
    const lat = a.p50_ms != null ? ` · ${ms(a.p50_ms)} typical` : "";
    return `<div class="agenthealth-row">
        <span class="agenthealth-name">${escHtml(String(a.agent))}</span>
        <span class="agenthealth-stat">${apct != null ? `${apct}% clean` : "—"}${lat}</span>
      </div>`;
  }).join("");
  return `
    <div class="sess agenthealth" style="margin-top:14px">
      <div class="lbl" style="margin-bottom:6px">Agent health</div>
      <div class="sess-line">${okLine}</div>
      ${rows ? `<div class="agenthealth-rows">${rows}</div>` : ""}
      <div class="sess-line" style="color:var(--muted);margin-top:8px">A failed run just falls through to the next enabled agent — this is the quiet pulse, not a verdict.</div>
    </div>`;
}

async function renderSettings() {
  headerTitle.textContent = "Settings";
  const [data, artStats, agentStats] = await Promise.all([
    api("/settings"),
    api("/art/stats").catch(() => null),
    api("/agent-stats").catch(() => null), // 404s on a backend without telemetry → degrade silently
  ]);
  const s = data.settings;
  const agents = data.agents; // ordered: {name, description, env_ok, enabled}

  const stratOpt = (v, label) => `<option value="${v}" ${s.agent_strategy === v ? "selected" : ""}>${label}</option>`;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Agent-health card (server telemetry; see GET /api/agent-stats — Stream 1).
  // Mirrors the art-spend card's calm ledger style. No scores, just ok-rate +
  // per-agent latency, plain words. Renders nothing if the endpoint is absent.
  const agentHealthHtml = agentHealthCard(agentStats);

  // Artwork spend telemetry card (server estimates; see GET /api/art/stats).
  let artSpendHtml = "";
  if (artStats) {
    const money = (v) => { const n = Number(v) || 0; return "$" + (n && n < 0.005 ? n.toFixed(4) : n.toFixed(2)); };
    const t = artStats.since_enabled, a = artStats.all_time;
    const since = artStats.enabled_at ? `since ${escHtml(String(artStats.enabled_at).slice(0, 10))}` : "all-time";
    artSpendHtml = `
    <div class="sess" style="margin-top:10px">
      <div class="sess-line"><b>${money(t.est_cost_usd)}</b> est. spend ${since} · ${t.images_generated} image${t.images_generated === 1 ? "" : "s"} generated · ${t.reused} reused (~${money(t.est_saved_usd)} saved)</div>
      <div class="sess-line" style="color:var(--muted)">All-time: ${money(a.est_cost_usd)} spent · ${a.images_generated} images · ${artStats.cached_assets} cached, served from cache forever after.</div>
    </div>`;
  }

  view.innerHTML = `
    <section class="set-group">
      <h2 class="set-group-title">Coaching</h2>
      <p class="set-group-sub">The agent brain. When you draft without naming an agent (the Coach <b>Auto</b> option and the weekly auto-coach), Cairn rotates across the agents you enable here.</p>

      <div class="field" style="margin-top:14px"><label>Selection strategy</label>
        <select id="strat">
          ${stratOpt("round_robin", "Round-robin · even rotation")}
          ${stratOpt("random", "Random · dice")}
          ${stratOpt("priority", "Priority · top first, fall back on failure")}
        </select></div>

      <h1 class="lbl" style="margin:18px 0 8px">Agents</h1>
      <div id="agentlist"></div>
      <div class="agent-update">
        <button id="updateAgentClis" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Update CLI tools</button>
        <div id="agentCliUpdateStatus" class="sess-line agent-update-status"></div>
      </div>
      ${agentHealthHtml}

      <h1 class="lbl" style="margin:22px 0 8px">Weekly auto-coach</h1>
      <label class="toggle"><input type="checkbox" id="coachEnabled" ${s.coach_enabled ? "checked" : ""}>
        <span>Draft a proposal automatically each week</span></label>
      <div class="logrow" style="margin-top:12px">
        <select id="coachDay" class="selflex">${dayNames.map((d, i) => `<option value="${i}" ${s.coach_day === i ? "selected" : ""}>${d}</option>`).join("")}</select>
        <select id="coachHour" class="selflex">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.coach_hour === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select>
      </div>
    </section>

    <section class="set-group">
      <h2 class="set-group-title">Connected sources</h2>
      <p class="set-group-sub">Where your recovery and activity data come in. Both are optional and gracefully absent.</p>

      <h1 class="lbl" style="margin:14px 0 8px">Garmin Connect</h1>
      <div class="field"><label>Garmin email</label>
        <input id="garminUsername" type="email" autocomplete="username" value="${escAttr(s.garmin_username || "")}" placeholder="you@example.com">
      </div>
      <div class="field"><label>Garmin password</label>
        <input id="garminPassword" type="password" autocomplete="current-password" placeholder="${s.garmin_password_configured ? `Configured via ${escAttr(s.garmin_credentials_source)}` : "Optional: GARMIN_PASSWORD"}">
      </div>
      <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings credentials override GARMIN_USERNAME / GARMIN_PASSWORD. Garmin remains an input source for coaching context.</div>
      <div class="syncrow">
        <div class="syncstatus" id="garminStatus">${garminStatusLine(s, false)}</div>
        <button id="garminSyncBtn" class="ghostbtn syncbtn">Sync now</button>
      </div>
      <div class="sess-line" style="color:var(--muted);margin-top:6px">Once configured, Cairn syncs automatically every ~6 hours.</div>

      <h1 class="lbl" style="margin:22px 0 8px">Apple Health (steps, sleep, recovery)</h1>
      <div class="sess-line" style="color:var(--muted)">
        No App Store, no account — an iOS Shortcut posts your daily metrics straight to Cairn. Steps
        and sleep feed the day-read and the energy-balance estimate.
      </div>
      <div class="ah-steps">
        <div class="ah-step"><span class="ah-num">1</span><div>Open <b>Shortcuts</b> on your iPhone → <b>+</b> → add the <b>Get Health Sample</b> actions you want (Steps, Sleep, Resting Heart Rate, Heart Rate Variability, Active Energy).</div></div>
        <div class="ah-step"><span class="ah-num">2</span><div>Build one JSON row per day: <code>date</code> (YYYY-MM-DD) plus any of <code>steps</code>, <code>sleep_min</code>, <code>sleep_score</code>, <code>resting_hr</code>, <code>hrv_ms</code>, <code>active_calories</code>. Wrap the rows in an array — a backfill is one array with many rows.</div></div>
        <div class="ah-step"><span class="ah-num">3</span><div>Add a <b>Get Contents of URL</b> action: method <b>POST</b>, request body <b>JSON</b> (the array), to the URL below.</div></div>
        <div class="ah-step"><span class="ah-num">4</span><div>Set it to run on an <b>Automation</b> each morning. Posts are idempotent per source + date (source defaults to <code>apple</code>), so re-running never duplicates a day.</div></div>
      </div>
      <div class="field" style="margin-top:12px"><label>POST URL</label>
        <div class="ah-url"><code id="ahUrl"></code><button id="ahUrlCopy" class="ghostbtn ah-copy" type="button">Copy</button></div>
      </div>
      <div class="ah-example">
        <span class="ah-example-lbl">Example body</span>
        <code>[{"date":"2026-06-13","steps":8421,"sleep_min":437,"resting_hr":52}]</code>
      </div>
    </section>

    <section class="set-group">
      <h2 class="set-group-title">Automation &amp; artwork</h2>
      <p class="set-group-sub">Background touches that make logging effortless. Both fall back gracefully when off.</p>

      <h1 class="lbl" style="margin:14px 0 8px">Agentic enrichment</h1>
      <label class="toggle"><input type="checkbox" id="enrichEnabled" ${s.enrich_enabled ? "checked" : ""}>
        <span>Refine free-text logs &amp; capture coaching notes via an agent</span></label>
      <div class="sess-line" style="color:var(--muted);margin-top:6px">Logs stay instant; an agent upgrades them in the background. Falls back to offline parsing when off.</div>

      <h1 class="lbl" style="margin:22px 0 8px">Artwork generation</h1>
      <label class="toggle"><input type="checkbox" id="artEnabled" ${(s.art_enabled ?? 1) ? "checked" : ""}>
        <span>Generate studio photos for foods, exercises &amp; activities</span></label>
      <div class="field" style="margin-top:10px"><label>Gemini API key</label>
        <input id="geminiApiKey" type="password" autocomplete="off" placeholder="${s.gemini_api_key_configured ? `Configured via ${escAttr(s.gemini_api_key_source)}` : "Optional: GOOGLE_AI_KEY / GEMINI_API_KEY"}">
      </div>
      <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings key overrides GOOGLE_AI_KEY / GEMINI_API_KEY from the server environment. Blank preserves the current key.</div>
      ${artSpendHtml}
    </section>

    <section class="set-group">
      <h2 class="set-group-title">Backup &amp; reset</h2>
      <p class="set-group-sub">Keep an offline copy of everything, or start the first-time setup over.</p>

      <h1 class="lbl" style="margin:14px 0 8px">Data &amp; backup</h1>
      <button id="dlJson" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Download JSON backup</button>
      <button id="dlDb" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Download SQLite snapshot</button>

      <h1 class="lbl" style="margin:22px 0 8px">Setup</h1>
      <button id="rerunSetup" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Re-run first-time setup</button>
    </section>`;

  // working copy edited in place, persisted on Save
  const order = agents.map((a) => a.name);
  const disabled = new Set(agents.filter((a) => !a.enabled).map((a) => a.name));
  const meta = Object.fromEntries(agents.map((a) => [a.name, a]));

  const persistSettings = async () => {
    await api("/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_strategy: $("#strat").value,
        agent_order: order,
        disabled_agents: [...disabled],
        enrich_enabled: $("#enrichEnabled").checked,
        art_enabled: $("#artEnabled").checked,
        gemini_api_key: $("#geminiApiKey").value.trim(),
        garmin_username: $("#garminUsername").value.trim(),
        garmin_password: $("#garminPassword").value.trim(),
        coach_enabled: $("#coachEnabled").checked,
        coach_day: +$("#coachDay").value,
        coach_hour: +$("#coachHour").value,
      }),
    });
    artEnabled = $("#artEnabled").checked; // take effect on the next render, no reload
    return true;
  };
  // floating save bar: every field edit (inputs below + agent list buttons)
  // surfaces Save/Discard right above the tab bar, no scrolling to the button
  const settingsBar = mountSaveBar({
    sentinel: $("#agentlist"),
    fields: view,
    onSave: persistSettings,
    onDiscard: () => renderSettings(),
  });

  function renderAgentList() {
    const wrap = $("#agentlist");
    wrap.innerHTML = order.map((name, i) => {
      const a = meta[name];
      const off = disabled.has(name);
      return `<div class="agentrow${off ? " off" : ""} reveal" style="${stagger(i)}">
        <div class="agentmeta">
          <div class="agentname">${name}${a.env_ok ? "" : ' <span class="warnpill">no key</span>'}</div>
          <div class="agentdesc">${a.description || ""}</div>
        </div>
        <div class="agentctl">
          <button class="ordbtn" data-up="${name}" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="ordbtn" data-down="${name}" ${i === order.length - 1 ? "disabled" : ""}>↓</button>
          <button class="togglebtn${off ? "" : " on"}" data-toggle="${name}">${off ? "OFF" : "ON"}</button>
        </div>
      </div>`;
    }).join("");
    wrap.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const n = b.dataset.toggle; disabled.has(n) ? disabled.delete(n) : disabled.add(n); settingsBar.markDirty(); renderAgentList();
    }));
    wrap.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => {
      const i = order.indexOf(b.dataset.up); if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
    wrap.querySelectorAll("[data-down]").forEach((b) => b.addEventListener("click", () => {
      const i = order.indexOf(b.dataset.down); if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
  }
  renderAgentList();

  const renderCliStatus = (r) => {
    const el = $("#agentCliUpdateStatus");
    if (!el || !r) return;
    if (r.status === "running") el.textContent = `Updating since ${(r.started_at || "").replace("T", " ").slice(0, 16)}`;
    else if (r.status === "succeeded") el.textContent = `Updated ${(r.finished_at || "").replace("T", " ").slice(0, 16)}`;
    else if (r.status === "failed") el.textContent = `Update failed${r.error ? `: ${r.error}` : ""}`;
    else el.textContent = "";
  };
  const pollCliStatus = async () => {
    const btn = $("#updateAgentClis");
    let r = await api("/agent-clis/update");
    renderCliStatus(r);
    btn.disabled = r.status === "running";
    while (r.status === "running") {
      await sleep(2000);
      r = await api("/agent-clis/update");
      renderCliStatus(r);
      btn.disabled = r.status === "running";
    }
  };
  $("#updateAgentClis").addEventListener("click", async () => {
    const btn = $("#updateAgentClis");
    btn.disabled = true;
    renderCliStatus({ status: "running", started_at: new Date().toISOString() });
    await api("/agent-clis/update", { method: "POST" });
    await pollCliStatus();
    toast("CLI update finished");
  });
  pollCliStatus().catch(() => {});

  // Manual Garmin sync: pulse while the connector runs, then re-pull /settings
  // so the status line shows exactly what the server recorded.
  $("#garminSyncBtn").addEventListener("click", async () => {
    const btn = $("#garminSyncBtn");
    const status = $("#garminStatus");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    status.innerHTML = garminStatusLine(null, true);
    let r = null;
    try { r = await api("/garmin/sync", { method: "POST" }); } catch {}
    let fresh = s;
    try { fresh = (await api("/settings")).settings; } catch {}
    // a tab switch may have replaced the view while we waited
    if (!btn.isConnected) return;
    status.innerHTML = garminStatusLine(fresh, false);
    btn.disabled = false;
    btn.textContent = "Sync now";
    toast(r && r.ok ? `Garmin synced · ${r.activities} activit${r.activities === 1 ? "y" : "ies"}` : "Garmin sync failed");
  });

  // Apple Health: show the page-origin POST URL + one-tap copy.
  const ahUrl = $("#ahUrl");
  if (ahUrl) ahUrl.textContent = location.origin + "/api/health-metrics";
  const ahCopy = $("#ahUrlCopy");
  if (ahCopy) ahCopy.addEventListener("click", async () => {
    const url = location.origin + "/api/health-metrics";
    try { await navigator.clipboard.writeText(url); ahCopy.textContent = "Copied"; }
    catch { ahCopy.textContent = "Copy failed"; }
    setTimeout(() => { ahCopy.textContent = "Copy"; }, 1600);
  });

  $("#dlJson").addEventListener("click", () => downloadFile(withToken("/api/export")));
  $("#dlDb").addEventListener("click", () => downloadFile(withToken("/api/export/db")));
  $("#rerunSetup").addEventListener("click", async () => {
    await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboarded: false }) });
    location.reload();
  });
}

function downloadFile(href) {
  const a = document.createElement("a");
  a.href = href; a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------- tabs ----------
function renderTab(tab) {
  headerTitle.classList.remove("hdr-tappable"); // only Today re-arms the date control
  document.getElementById("hdrChatActions")?.remove(); // only Chat re-creates the header affordances
  document.body.classList.remove("chat-mode");
  document.body.dataset.tab = tab; // scopes the sticky/condensing header to Today
  updateHeaderCondense();
  if (tab === "today") return renderToday();
  if (tab === "plan") {
    const jump = state.planJump; state.planJump = null;
    return jump === "meals" ? renderMeals() : renderPlanEditor();
  }
  if (tab === "progress") return renderHistory();
  if (tab === "chat") return renderChat();
  if (tab === "me") return renderMe();
  return renderSettings();
}
// Synchronous skeleton for a tab, so the view-transition crossfade lands on a
// shaped placeholder INSTANTLY — the old tab never sits frozen through the data/
// agent awaits. Each render function paints its own matching skeleton on entry
// (idempotent), then hydrates in place once data lands. Chat owns its own
// shell-first paint, so we don't pre-skeleton it.
function tabSkeleton(tab) {
  if (tab === "today") return todaySkeleton();
  if (tab === "progress") return segSkeleton("sessions", PROGRESS_SEG, 3);
  if (tab === "plan") return segSkeleton(state.planJump === "meals" ? "meals" : "edit", PLAN_SEG, 3);
  if (tab === "me") {
    const seg = state.meSeg || "profile";
    return ME_SEG.some(([k]) => k === seg) ? segSkeleton(seg, ME_SEG, 2) : segSkeleton("profile", ME_SEG, 2);
  }
  if (tab === "settings") return skelLines(2) + skelLines(3);
  return "";
}

// Switch tabs: crossfade the old tab → a synchronous skeleton (the view
// transition only waits for THIS, never the async render), then hydrate outside
// the transition. The frozen-tab problem is gone: paint is always instant.
function switchTab(tab) {
  closeDetail(true); // overlays never outlive a tab switch
  closeMealSheet(true);
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  state.tab = tab;
  const paintSkeleton = () => {
    const skel = tabSkeleton(tab);
    if (skel) { view.innerHTML = skel; viewEnter(); }
  };
  // Wrap ONLY the synchronous skeleton paint in the transition; the (possibly
  // slow, agentic) render runs after, swapping skeleton→content with no wait.
  Promise.resolve(withViewTransition(paintSkeleton)).finally(() => {
    Promise.resolve(renderTab(tab)).catch(() => tabErrorState(tab));
  });
}
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

// ---------- first-run onboarding ----------
async function maybeOnboard() {
  let onboarded = true;
  try {
    const data = await api("/settings");
    onboarded = !!data?.settings?.onboarded;
    // settings is already in hand — cache the artwork-generation flag (default on)
    if (data?.settings && "art_enabled" in data.settings) artEnabled = !!data.settings.art_enabled;
  } catch { onboarded = true; } // never block the app on a settings failure
  if (!onboarded) openOnboarding();
}

function openOnboarding() {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="modal-card">
      <h2 class="modal-title">Welcome to Cairn</h2>
      <div class="modal-sub">Let's set up your profile</div>

      <div class="ob-grid">
        <div class="field"><label>Sex</label>
          <select id="obSex"><option value="">—</option><option value="male">Male</option><option value="female">Female</option></select></div>
        <div class="field"><label>Age</label>
          <input id="obAge" type="number" inputmode="numeric" class="ob-in" placeholder="years"></div>
      </div>

      <div class="field"><label>Height</label>
        <div class="seg" id="obHtUnit" style="margin-bottom:8px">
          <button class="segbtn active" data-htu="cm">cm</button>
          <button class="segbtn" data-htu="ftin">ft + in</button>
        </div>
        <div id="obHtCm"><input id="obCm" type="number" inputmode="decimal" class="ob-in" placeholder="cm"></div>
        <div id="obHtFt" style="display:none">
          <div class="ob-grid">
            <input id="obFt" type="number" inputmode="numeric" class="ob-in" placeholder="ft">
            <input id="obIn" type="number" inputmode="numeric" class="ob-in" placeholder="in">
          </div>
        </div>
      </div>

      <div class="ob-grid">
        <div class="field"><label>Current weight (lb)</label>
          <input id="obWt" type="number" inputmode="decimal" class="ob-in" placeholder="lb"></div>
        <div class="field"><label>Goal weight (lb)</label>
          <input id="obGoalWt" type="number" inputmode="decimal" class="ob-in" placeholder="lb"></div>
      </div>

      <div class="field"><label>Goal date</label>
        <input id="obGoalDate" type="date" class="ob-in"></div>

      <div class="field"><label>Days per week</label>
        <div class="seg" id="obDays">
          <button class="segbtn" data-dpw="3">3</button>
          <button class="segbtn active" data-dpw="4">4</button>
          <button class="segbtn" data-dpw="5">5</button>
          <button class="segbtn" data-dpw="6">6</button>
        </div>
      </div>

      <button id="obFinish" class="logbtn" style="width:100%;height:46px;margin-top:8px;letter-spacing:.05em">FINISH</button>
      <button id="obSkip" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Skip — use the default plan</button>
      <div id="obStatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>
    </div>`;
  document.body.appendChild(m);

  let htUnit = "cm";
  m.querySelectorAll("#obHtUnit [data-htu]").forEach((b) => b.addEventListener("click", () => {
    htUnit = b.dataset.htu;
    m.querySelectorAll("#obHtUnit .segbtn").forEach((x) => x.classList.toggle("active", x === b));
    m.querySelector("#obHtCm").style.display = htUnit === "cm" ? "block" : "none";
    m.querySelector("#obHtFt").style.display = htUnit === "ftin" ? "block" : "none";
  }));

  let dpw = 4;
  m.querySelectorAll("#obDays [data-dpw]").forEach((b) => b.addEventListener("click", () => {
    dpw = +b.dataset.dpw;
    m.querySelectorAll("#obDays .segbtn").forEach((x) => x.classList.toggle("active", x === b));
  }));

  const heightCm = () => {
    if (htUnit === "cm") { const v = +m.querySelector("#obCm").value; return v > 0 ? v : null; }
    const ft = +m.querySelector("#obFt").value || 0, inch = +m.querySelector("#obIn").value || 0;
    const total = ft * 12 + inch;
    return total > 0 ? Math.round(total * 2.54 * 10) / 10 : null;
  };

  async function persistOnboarded() {
    await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboarded: true }) });
  }

  m.querySelector("#obSkip").addEventListener("click", async () => {
    await persistOnboarded();
    m.remove();
  });

  m.querySelector("#obFinish").addEventListener("click", async () => {
    const status = m.querySelector("#obStatus");
    status.textContent = "Saving…";
    const profile = {
      sex: m.querySelector("#obSex").value || null,
      age: +m.querySelector("#obAge").value || null,
      height_cm: heightCm(),
      weight_lb: +m.querySelector("#obWt").value || null,
      goal_weight_lb: +m.querySelector("#obGoalWt").value || null,
      goal_date: m.querySelector("#obGoalDate").value || null,
    };
    try {
      await api("/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      // optional starter template if they want a different frequency than the seeded plan
      try { await maybeBuildStarterPlan(dpw); } catch { /* never block onboarding on plan build */ }
      await persistOnboarded();
      state.plan = []; state.day = null; state.dayPicked = false;
      m.remove();
      toast("Profile saved");
      // back to Today
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      const t = document.querySelector('.tab[data-tab="today"]'); if (t) t.classList.add("active");
      state.tab = "today";
      document.body.dataset.tab = "today";
      renderToday();
    } catch (e) {
      status.textContent = "Failed: " + e.message;
    }
  });
}

// Build a minimal starter split only if it differs from the current plan's day count.
async function maybeBuildStarterPlan(dpw) {
  const current = await api("/plan");
  if (Array.isArray(current) && current.length === dpw) return; // seeded plan already matches
  const TEMPLATES = {
    3: [
      { name: "Full Body A", focus: "Squat focus", items: ["Back Squat", "Bench Press", "Barbell Row", "Plank"] },
      { name: "Full Body B", focus: "Hinge focus", items: ["Deadlift", "Overhead Press", "Lat Pulldown", "Hanging Leg Raise"] },
      { name: "Full Body C", focus: "Volume", items: ["Front Squat", "Incline Dumbbell Press", "Pull-Up", "Cable Row"] },
    ],
    4: [
      { name: "Upper A", focus: "Push", items: ["Bench Press", "Overhead Press", "Lateral Raise", "Triceps Pushdown"] },
      { name: "Lower A", focus: "Squat", items: ["Back Squat", "Romanian Deadlift", "Leg Press", "Calf Raise"] },
      { name: "Upper B", focus: "Pull", items: ["Pull-Up", "Barbell Row", "Face Pull", "Biceps Curl"] },
      { name: "Lower B", focus: "Hinge", items: ["Deadlift", "Front Squat", "Leg Curl", "Hanging Leg Raise"] },
    ],
    5: [
      { name: "Push", focus: "Chest / shoulders / triceps", items: ["Bench Press", "Overhead Press", "Incline Dumbbell Press", "Triceps Pushdown"] },
      { name: "Pull", focus: "Back / biceps", items: ["Deadlift", "Pull-Up", "Barbell Row", "Biceps Curl"] },
      { name: "Legs", focus: "Quads / hams / calves", items: ["Back Squat", "Romanian Deadlift", "Leg Press", "Calf Raise"] },
      { name: "Upper", focus: "Volume", items: ["Incline Bench Press", "Lat Pulldown", "Lateral Raise", "Cable Row"] },
      { name: "Lower", focus: "Volume", items: ["Front Squat", "Leg Curl", "Walking Lunge", "Calf Raise"] },
    ],
    6: [
      { name: "Push A", focus: "Strength", items: ["Bench Press", "Overhead Press", "Triceps Pushdown"] },
      { name: "Pull A", focus: "Strength", items: ["Deadlift", "Barbell Row", "Biceps Curl"] },
      { name: "Legs A", focus: "Strength", items: ["Back Squat", "Romanian Deadlift", "Calf Raise"] },
      { name: "Push B", focus: "Hypertrophy", items: ["Incline Dumbbell Press", "Lateral Raise", "Triceps Extension"] },
      { name: "Pull B", focus: "Hypertrophy", items: ["Pull-Up", "Cable Row", "Face Pull"] },
      { name: "Legs B", focus: "Hypertrophy", items: ["Front Squat", "Leg Press", "Leg Curl"] },
    ],
  };
  const tpl = TEMPLATES[dpw];
  if (!tpl) return;
  const days = tpl.map((d, i) => ({
    day_number: i + 1, name: d.name, focus: d.focus,
    items: d.items.map((ex) => ({ exercise: ex, sets: 3, rep_low: 8, rep_high: 12, target_weight: null, note: null, warmup_sets: null })),
  }));
  await api("/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
}

// Activate a tab programmatically (used at startup + by manifest shortcuts via ?tab=).
function activateTab(name) {
  const valid = ["today", "plan", "progress", "chat", "me", "settings"];
  const tab = valid.includes(name) ? name : "today";
  closeDetail(true);
  closeMealSheet(true);
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  state.tab = tab;
  Promise.resolve(renderTab(tab)).then(viewEnter).catch(() => tabErrorState(tab));
}

// ---------- service-worker lifecycle: register + "update ready" nudge ----------
// A new sw.js no longer skipWaiting()s on its own (see sw.js) — it waits so we can
// surface a calm, actionable "Cairn updated — tap to refresh" toast. Tapping it
// asks the waiting worker to take over and reloads once it does. Pull-never-push:
// nothing nags, nothing reloads under the user's feet.
let _swReloading = false;
function offerSwUpdate(worker) {
  if (!worker || _swReloading) return;
  toast("Cairn updated", {
    action: "Refresh",
    onAction: () => { _swReloading = true; worker.postMessage("skipWaiting"); },
  });
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    // A worker already parked in `waiting` (updated while the app was closed).
    if (reg.waiting && navigator.serviceWorker.controller) offerSwUpdate(reg.waiting);
    // A new worker is downloading — offer the refresh once it finishes installing
    // (only when one was already controlling, so the first-ever install stays silent).
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) offerSwUpdate(nw);
      });
    });
  }).catch(() => {});
  // The waiting worker activated (after our skipWaiting nudge) — reload once.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!_swReloading) return;
    _swReloading = false;
    location.reload();
  });
}
activateTab(new URLSearchParams(location.search).get("tab"));
maybeOnboard();

// Keep the bottom-fixed UI (tab bar, rest timer, toast) clear of the mobile
// browser's bottom toolbar. iOS Safari anchors position:fixed;bottom:0 to the
// full layout viewport, so a visible address/tool bar overlaps the tab bar and
// clips its labels (env(safe-area-inset-bottom) is 0 in a normal tab, only the
// installed PWA gets it). visualViewport tells us how much layout viewport is
// hidden at the bottom; we lift everything by that much via the --vvb variable.
// Re-measure the chat column whenever the viewport shifts (zoom, keyboard,
// orientation, window resize). Cheap and idempotent — bails immediately when
// Chat isn't on screen.
const syncChatViewport = () => { if (state.tab === "chat") measureChatTop(); };
window.addEventListener("resize", syncChatViewport);
window.addEventListener("orientationchange", syncChatViewport);

(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const sync = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // A large inset is the on-screen keyboard, not browser chrome — leave the
    // bar at the bottom (hidden behind the keyboard) rather than flinging it up.
    root.style.setProperty("--vvb", (inset > 160 ? 0 : Math.round(inset)) + "px");
    syncChatViewport();
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync); // keyboard open/close shifts offsetTop
  window.addEventListener("orientationchange", sync);
  sync();
})();

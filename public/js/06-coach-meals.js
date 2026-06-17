// ==== 06-coach-meals.js ====
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

  await skelSwap(() => { view.innerHTML = segBar("coach", PLAN_SEG) + `
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
    <div id="meallist"></div>`; });

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

// Clamp/verify transparency — when an applied proposal returned `clamped[]` (a code
// guardrail nudged a value to a safe step), surface it as a calm hairline note, never
// an alarm: trust through honesty. Shapes: {exercise, field, requested, applied, reason}.
// Returns "" when there was nothing to adjust. Each line reads in plain words.
function clampNoteHtml(clamped) {
  const rows = (Array.isArray(clamped) ? clamped : []).filter(Boolean);
  if (!rows.length) return "";
  const lines = rows.slice(0, 6).map((c) => {
    const what = String(c.exercise || c.field || "a value").trim();
    const reason = String(c.reason || "kept to a safe step").trim();
    const from = c.requested != null && c.requested !== "" ? `${escHtml(String(c.requested))} → ` : "";
    const to = c.applied != null && c.applied !== "" ? `<b>${escHtml(String(c.applied))}</b>` : "";
    const move = from || to ? `<span class="clampnote-move">${from}${to}</span>` : "";
    return `<div class="clampnote-row"><span class="clampnote-what">${escHtml(what)}</span>${move}<span class="clampnote-why">${escHtml(reason)}</span></div>`;
  }).join("");
  return `<div class="clampnote settle-in" role="note">
      <div class="clampnote-lbl lbl"><span class="clampnote-glyph" aria-hidden="true">⚖</span> adjusted to a safe step</div>
      ${lines}
    </div>`;
}

// Clamp/verify transparency — a quiet "checked against your floors" badge for a
// meal plan / suggested session that carried `verified.checked`. Lists the named
// adjustments behind a disclosure when present; otherwise just the calm reassurance.
// Trust through honesty, never alarm. Returns "" when nothing was checked.
function verifiedBadgeHtml(verified) {
  if (!verified || !verified.checked) return "";
  const adj = (Array.isArray(verified.adjustments) ? verified.adjustments : []).filter((a) => a != null && String(a).trim());
  const detail = adj.length
    ? `<details class="verified-detail"><summary>what was adjusted</summary>
         <ul class="verified-list">${adj.slice(0, 8).map((a) => `<li>${escHtml(String(a))}</li>`).join("")}</ul>
       </details>`
    : "";
  return `<div class="verified-badge settle-in" role="note">
      <span class="verified-mark" aria-hidden="true">✓</span>
      <span class="verified-text">Checked against your floors</span>
      ${detail}
    </div>`;
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
      let r = null;
      try { r = await api(`/proposals/${b.dataset.apply}/apply`, { method: "POST" }); } catch { r = null; }
      // A code guardrail may have nudged a load to a safe step — surface it honestly
      // inline on the card (before the re-render below replaces the list) AND in the
      // toast, so the "what changed and why" reads even as the list refreshes.
      const clamped = r && Array.isArray(r.clamped) && r.clamped.length;
      if (clamped) {
        const card = b.closest(".mp-card");
        if (card) card.insertAdjacentHTML("beforeend", clampNoteHtml(r.clamped));
        toast("Applied · adjusted to a safe step");
        // Let the user read the note; the proposal already reflects applied state.
        state.plan = []; swrInvalidate("plan"); // applied targets — the plan cache is stale
        return;
      }
      toast("Applied");
      state.plan = []; swrInvalidate("plan"); renderCoach();
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
// SWR cache keys for the meals journal — drafts/swaps/reorders/recipes mutate
// `current.parsed` in memory or change the plan server-side, so any such write
// swrInvalidate()s MEALS_KEY to keep the next warm paint honest. MEALS_SETTINGS_KEY
// caches /settings for the verbatim meal_prefs that ride along into the journal.
const MEALS_KEY = "meals:plans";
const MEALS_SETTINGS_KEY = "meals:settings";

// `verified` (the self-critique "checked against your floors" signal) is returned at
// DRAFT time on the /coach/mealplan response but is NOT persisted on the plan row, so
// we remember it by the just-drafted plan's id for the journal view to surface once.
const _verifiedByPlan = new Map();
function rememberVerified(r) {
  if (r && r.ok && r.plan && r.plan.id != null && r.verified && r.verified.checked) {
    _verifiedByPlan.set(r.plan.id, r.verified);
  }
}

// Draft a meal plan from the Coach sub-view (#mealbtn). Runs as a durable
// background job so a long draft survives a reload mid-run (streaming its evolving
// caption + determinate filament into #mealstatus); when background ops are off,
// runOp renders the inline result immediately. On done we refresh the meal-plan
// list in place and invalidate the journal SWR key so the journal paints truth.
function runMealPlan() {
  const agent = $("#agentsel").value;
  const status = $("#mealstatus");
  const btn = $("#mealbtn");
  if (btn) btnBusy(btn, "Drafting\u2026");
  if (status) status.innerHTML = `<span class="job-cap"></span>`;
  runOp("meal_plan", { agent, instruction: instructionValue() }, coachMealPlanOpOpts());
}

// Shared runOp options for a Coach-view meal-plan draft \u2014 used by the trigger and
// the reload reconnector so render/fail behavior is identical.
function coachMealPlanOpOpts() {
  return {
    path: "/coach/mealplan",
    anchor: "#mealstatus",
    caption: "meal_plan",
    guard: () => !$("#mealstatus")?.isConnected,
    isFail: (r) => !r || r.ok !== true || !r.plan,
    render: async (r) => {
      rememberVerified(r);
      const status = $("#mealstatus");
      if (status) status.textContent = "Meal plan ready.";
      const btn = $("#mealbtn");
      if (btn && btn._busyRestore) btn._busyRestore();
      swrInvalidate(MEALS_KEY); // the journal's SWR cache is now stale
      try { renderMealPlans(await api("/mealplans?limit=8")); } catch {}
    },
    onFail: (err) => {
      const status = $("#mealstatus");
      if (status) status.textContent = err ? "Failed \u2014 try again." : "Ran but returned no valid plan.";
      const btn = $("#mealbtn");
      if (btn && btn._busyRestore) btn._busyRestore();
    },
  };
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
      swrInvalidate(MEALS_KEY); // status flipped to kept — the journal's warm cache is now stale
      if (refresh) refresh(); else renderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
  wrap.querySelectorAll("[data-discard]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.discard}/discard`, { method: "POST" });
      toast("Discarded");
      swrInvalidate(MEALS_KEY); // status flipped to discarded — the journal's warm cache is now stale
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
// agent (15–120s) as a durable background job (runOp): the row goes busy while the
// rest of the view stays live, the job survives a reload mid-run (the swap caption
// streams into the busy row), and the job system itself is the in-flight lock — no
// client-side flag needed (a second swap on the same row is gated by .meal-busy).
// When background ops are off, runOp renders the inline result immediately.
async function submitMealSwap(current, ctx, di, mi, panel) {
  const day = current.parsed?.days?.[di];
  if (!day) return;
  const row = panel.previousElementSibling;
  if (row && row.classList.contains("meal-busy")) { toast("A swap is already running"); return; }
  const hint = panel.querySelector(".meal-swap-hint")?.value.trim() || "";
  const go = panel.querySelector(".meal-swap-go");
  if (row) { row.classList.add("meal-busy"); row.querySelector(".meal-cap")?.remove(); row.insertAdjacentHTML("beforeend", `<span class="meal-cap job-cap"></span>`); }
  panel.classList.add("meal-swap-busy");
  btnBusy(go, "Asking the coach…", { ghost: true });
  panel.querySelectorAll("button,input").forEach((el) => { if (el !== go) el.disabled = true; });

  const body = hint ? { day: day.day, meal_index: mi, hint } : { day: day.day, meal_index: mi };
  await runOp("meal_swap", { id: current.id, ...body }, mealSwapOpOpts(current, ctx, di, mi));
}

// Shared runOp options for a meal swap — used by the trigger and the reload
// reconnector. The anchor is the busy meal row (carrying the .meal-cap caption);
// on done the day re-renders with the new meal settled in place.
function mealSwapOpOpts(current, ctx, di, mi) {
  const rowSel = `.mealday[data-mday="${di}"] .meal-row[data-mi="${mi}"]`;
  return {
    path: `/meal-plans/${current.id}/swap`,
    anchor: rowSel,
    caption: "meal_swap",
    guard: () => !view.querySelector(rowSel)?.isConnected,
    isFail: (r) => !r || r.ok !== true || !(r.plan?.parsed || r.meal),
    render: (r) => {
      if (r.plan?.parsed) current.parsed = r.plan.parsed; // server copy is the source of truth
      else { const d = current.parsed?.days?.[di]; if (d?.meals) d.meals[mi] = r.meal; }
      swrInvalidate(MEALS_KEY); // the journal's cached plan list is now stale
      rerenderMealDay(current, di, ctx, mi);
      toast("Meal swapped");
    },
    onFail: () => {
      const row = view.querySelector(rowSel);
      if (row) { row.classList.remove("meal-busy"); row.querySelector(".meal-cap")?.remove(); }
      const panel = row?.nextElementSibling;
      if (panel && panel.classList.contains("meal-swap")) {
        panel.classList.remove("meal-swap-busy");
        panel.querySelectorAll("button,input").forEach((el) => { el.disabled = false; });
        const go = panel.querySelector(".meal-swap-go");
        if (go && go._busyRestore) go._busyRestore();
      }
      toast("Coach couldn't draft a swap — try again");
    },
  };
}

// Reconnector: after a reload mid-swap, find the meal row by the job's plan/day/meal
// and re-mark it busy so the swap (finished or finishing) settles in place. The
// current plan + ctx are rebuilt from the freshly-rendered meals view; null when the
// meals view isn't mounted (a later renderMeals retries reconnect).
function reconnectMealSwap(job) {
  const input = (job && job.input) || {};
  const planId = Number(input.id);
  // The journal view keys its rows by day INDEX, but the job carries the day NAME —
  // match it to recover di. We only have the rendered DOM here, so read the plan
  // from the SWR cache (the meals view just painted it).
  const cached = peekCached(MEALS_KEY)?.data || [];
  const current = (Array.isArray(cached) ? cached : []).find((p) => Number(p.id) === planId);
  if (!current?.parsed?.days) return null; // plan not in view — retry on a later render
  const di = current.parsed.days.findIndex(
    (d) => String(d?.day ?? "").trim().toLowerCase() === String(input.day ?? "").trim().toLowerCase()
  );
  const mi = Number(input.meal_index);
  if (di < 0 || !Number.isFinite(mi)) return null;
  const ctx = mealsCtxFor(current);
  const rowSel = `.mealday[data-mday="${di}"] .meal-row[data-mi="${mi}"]`;
  const row = view.querySelector(rowSel);
  if (!row) return null; // row not on screen (e.g. a different sub-view) — retry later
  row.classList.add("meal-busy");
  row.querySelector(".meal-cap")?.remove();
  row.insertAdjacentHTML("beforeend", `<span class="meal-cap job-cap"></span>`);
  const o = mealSwapOpOpts(current, ctx, di, mi);
  let stop = () => {};
  const capEl = row.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  if (!reducedMotion()) row.classList.add("is-thinking");
  const clear = () => { stop(); const r = view.querySelector(rowSel); if (r) { r.classList.remove("is-thinking", "is-thinking--determinate"); r.style.removeProperty("--frac"); } };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

// Rebuild the meals ctx ({weekOf, targetKcal, todayName}) for a plan row — mirrors
// the ctx renderMeals computes, so the swap reconnector can re-render a day section.
function mealsCtxFor(current) {
  const m = current.parsed || {};
  const weekOf = current.week_of || (current.created_at || "").slice(0, 10);
  const todayName = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
  return { weekOf, targetKcal: Number(m.daily_kcal) || 0, todayName };
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
    swrInvalidate(MEALS_KEY); // reorder persisted — the journal's cached plan list is stale
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
// agent-written recipe (cached on the plan by the server once fetched). A recipe in
// flight is detected by a .job-cap in the sheet's [data-recipe] (the job IS the lock).

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

// A calm recipe-loading state inside the [data-recipe] wrapper — the .job-cap
// carries the evolving "writing the recipe" caption; the host gets the filament.
function recipeLoadingHtml() {
  return `<div class="sheet-section sheet-section-c sheet-recipe-loading">
      <span class="aspin aspin-sm" aria-hidden="true"></span>
      <div class="sheet-recipe-load-line job-cap"></div>
    </div>`;
}

// POST /meal-plans/:id/recipe — runs an external CLI agent (15–120s) as a durable
// background job (runOp). A CACHED recipe comes back inline+instantly (runOp renders
// it with no job); a fresh one streams its caption into the open sheet and survives a
// reload mid-run. Closing the sheet mid-flight is fine — the result still stores into
// the in-memory plan (server-side) and the DOM is only touched if the sheet survives.
function wireRecipeCta(sheet, current, dayLabel, di, mi) {
  const btn = sheet.querySelector("[data-getrecipe]");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const key = sheet.dataset.key;
    const wrap = document.querySelector(`.sheet[data-key="${key}"] [data-recipe]`);
    if (!wrap || wrap.querySelector(".job-cap")) { if (wrap?.querySelector(".job-cap")) toast("A recipe is already being written"); return; }
    wrap.innerHTML = recipeLoadingHtml();
    runOp("recipe", { id: current.id, day: dayLabel, meal_index: mi }, recipeOpOpts(current, dayLabel, di, mi, key));
  });
}

// Shared runOp options for a recipe — used by the CTA and the reload reconnector.
// The anchor is the live sheet's [data-recipe] wrapper (keyed so a re-opened sheet
// matches); on done the recipe stores into the in-memory plan and renders with the
// gentle sage settle flash.
function recipeOpOpts(current, dayLabel, di, mi, key) {
  const wrapSel = `.sheet[data-key="${key}"] [data-recipe]`; // key is numeric (id:di:mi)
  return {
    path: `/meal-plans/${current.id}/recipe`,
    anchor: wrapSel,
    caption: "recipe",
    guard: () => !document.querySelector(wrapSel)?.isConnected, // sheet closed — keep the job alive
    isFail: (r) => !r || r.ok !== true || !r.recipe,
    render: (r) => {
      // store into the in-memory plan first so it survives rerenders & reopen
      if (r.plan?.parsed) current.parsed = r.plan.parsed;
      else {
        const m = current.parsed?.days?.[di]?.meals?.[mi];
        if (m) m.recipe = r.recipe;
      }
      if (!r.cached) swrInvalidate(MEALS_KEY); // a freshly written recipe changed the plan
      const live = document.querySelector(wrapSel);
      if (live) {
        live.innerHTML = recipeHtml(r.recipe);
        live.classList.add("meal-settled"); // gentle sage settle flash
      }
    },
    onFail: () => {
      const wrap = document.querySelector(wrapSel);
      if (wrap) {
        const liveSheet = wrap.closest(".sheet");
        wrap.innerHTML = recipeCtaHtml();
        if (liveSheet) wireRecipeCta(liveSheet, current, dayLabel, di, mi);
      }
      toast("Coach couldn't write the recipe — try again");
    },
  };
}

// Reconnector: after a reload mid-recipe, find the open sheet by its data-key and
// re-mount the loading state so a recipe that finished while away settles in. The
// plan is read from the SWR cache; null when no matching open sheet (job stays alive).
function reconnectRecipe(job) {
  const input = (job && job.input) || {};
  const planId = Number(input.id);
  const dayLabel = String(input.day ?? "");
  const mi = Number(input.meal_index);
  const cached = peekCached(MEALS_KEY)?.data || [];
  const current = (Array.isArray(cached) ? cached : []).find((p) => Number(p.id) === planId);
  if (!current?.parsed?.days) return null;
  const di = current.parsed.days.findIndex(
    (d) => String(d?.day ?? "").trim().toLowerCase() === dayLabel.trim().toLowerCase()
  );
  if (di < 0 || !Number.isFinite(mi)) return null;
  const key = `${planId}:${di}:${mi}`;
  const wrap = document.querySelector(`.sheet[data-key="${key}"] [data-recipe]`);
  if (!wrap) return null; // the sheet isn't open — a re-open will show the cached recipe
  wrap.innerHTML = recipeLoadingHtml();
  const o = recipeOpOpts(current, dayLabel, di, mi, key);
  let stop = () => {};
  const capEl = wrap.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  const host = document.querySelector(o.anchor);
  if (host && !reducedMotion()) host.classList.add("is-thinking");
  const clear = () => { stop(); const h = document.querySelector(o.anchor); if (h) { h.classList.remove("is-thinking", "is-thinking--determinate"); h.style.removeProperty("--frac"); } };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

// The meals journal paints instantly from a warm peek and upgrades on change. The
// plans list (the surface that actually changes) is the SWR-keyed surface; meal
// prefs ride along from /settings (peeked, revalidated, but a prefs-only change is
// rare enough that we just reuse whatever the peek/last fetch gave us per paint).
async function renderMeals() {
  headerTitle.textContent = "Plan";
  const token = ++pollToken;
  const peek = peekCached(MEALS_KEY);
  if (!peek) view.innerHTML = segSkeleton("meals", PLAN_SEG, 3); // cold: skeleton-first
  // meal prefs come from /settings; peek it so a warm paint has the verbatim text,
  // and revalidate in the background (cheap, shares the SWR tiers).
  let mealPrefs = String(peekCached(MEALS_SETTINGS_KEY)?.data?.settings?.meal_prefs || "");
  cachedApi("/settings", {
    key: MEALS_SETTINGS_KEY,
    onUpgrade: (data) => { mealPrefs = String(data?.settings?.meal_prefs || ""); },
  }).catch(() => {});

  return paintSWR({
    key: MEALS_KEY,
    path: "/mealplans?limit=12",
    peek,
    token,
    tab: "plan",
    render: (plansRes) => paintMealsBody(plansRes || [], mealPrefs),
  });
}

// Build + wire the whole meals journal from a plans list (+ verbatim meal prefs).
// Called synchronously on a warm peek and again on a changed revalidate; the inner
// wiring is idempotent (it re-queries the freshly-written DOM each time).
function paintMealsBody(plans, mealPrefs) {
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
        ${isDraft ? verifiedBadgeHtml(_verifiedByPlan.get(current.id)) : ""}
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
  if (draftBtn) draftBtn.addEventListener("click", () => draftWeeklyMeals());
}

// Draft a fresh weekly meal plan from the journal view. Runs as a durable
// background job (runOp) so the draft survives a reload mid-run and streams its
// evolving "thinking" caption + determinate filament into #mealDraftStatus; when
// background ops are off, runOp renders the inline result immediately. On done we
// invalidate the SWR key and re-render so the fresh plan paints from truth.
function draftWeeklyMeals() {
  const draftBtn = view.querySelector("#mealDraftBtn");
  const status = view.querySelector("#mealDraftStatus");
  if (!status) return;
  if (draftBtn) btnBusy(draftBtn, "Drafting…", { ghost: true });
  // The status line carries the .job-cap caption slot; a running draft re-attaches
  // after a reload via its registered reconnector.
  status.innerHTML = `<span class="job-cap"></span>`;
  runOp("meal_plan", { agent: "auto" }, mealPlanDraftOpOpts());
}

// Shared runOp options for a journal-view meal-plan draft — used by the trigger
// and the reload reconnector so render/fail behavior is identical.
function mealPlanDraftOpOpts() {
  return {
    path: "/coach/mealplan",
    anchor: "#mealDraftStatus",
    caption: "meal_plan",
    guard: () => !view.querySelector("#mealDraftStatus")?.isConnected,
    isFail: (r) => !r || r.ok !== true || !r.plan,
    render: (r) => {
      rememberVerified(r);
      toast("Meal plan drafted");
      swrInvalidate(MEALS_KEY);
      renderMeals();
    },
    onFail: (err) => {
      const s = view.querySelector("#mealDraftStatus");
      if (s) s.textContent = err ? "Couldn't draft a plan — try again." : "Agent ran but returned no valid plan.";
      const b = view.querySelector("#mealDraftBtn");
      if (b && b._busyRestore) b._busyRestore();
    },
  };
}

// Shared "rebuild a loading caption on a status host" reconnector body for the two
// meal-plan draft entry points (the journal #mealDraftStatus and the Coach
// #mealstatus). Both enqueue the same `meal_plan` job kind, so a single registered
// reconnector picks whichever host is currently mounted; the matching draft button
// (if present) is re-frozen and the op's render/fail lands in place.
function reconnectMealPlanStatus(o, statusSel, btnSel, ghost) {
  const status = view.querySelector(statusSel);
  if (!status) return null; // host not mounted — a later render retries
  const btn = btnSel ? view.querySelector(btnSel) : null;
  if (btn) btnBusy(btn, "Drafting…", { ghost });
  status.innerHTML = `<span class="job-cap"></span>`;
  let stop = () => {};
  const capEl = status.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  if (!reducedMotion()) status.classList.add("is-thinking");
  const clear = () => { stop(); const s = view.querySelector(statusSel); if (s) { s.classList.remove("is-thinking", "is-thinking--determinate"); s.style.removeProperty("--frac"); } };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

// The single registered reconnector for `meal_plan` jobs: prefer the journal host
// (#mealDraftStatus), else the Coach host (#mealstatus); null when neither is up.
function reconnectMealPlan() {
  if (view.querySelector("#mealDraftStatus")) {
    return reconnectMealPlanStatus(mealPlanDraftOpOpts(), "#mealDraftStatus", "#mealDraftBtn", true);
  }
  if (view.querySelector("#mealstatus")) {
    return reconnectMealPlanStatus(coachMealPlanOpOpts(), "#mealstatus", "#mealbtn", false);
  }
  return null;
}

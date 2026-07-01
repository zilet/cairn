(() => {
function isCoachMealRecord(value) {
    return !!value && typeof value === "object";
}
function coachMealRecord(value) {
    return isCoachMealRecord(value) ? value : {};
}
function coachMealRows(value) {
    return Array.isArray(value) ? value.filter(isCoachMealRecord) : [];
}
function mealPlanRows(value) {
    return coachMealRows(value);
}
function mealPlanRecord(value) {
    return coachMealRecord(value);
}
function mealParsed(value) {
    return coachMealRecord(value);
}
function htmlElement(value) {
    return value instanceof HTMLElement ? value : null;
}
function buttonElement(value) {
    return value instanceof HTMLButtonElement ? value : null;
}
function restoreBusy(value) {
    value?._busyRestore?.();
}
function agentName(agent) {
    return typeof agent.name === "string" && agent.name ? agent.name : "agent";
}
function eventElement(event) {
    return event.target instanceof Element ? event.target : null;
}
function mealPlanDays(plan) {
    const parsed = mealParsed(plan.parsed);
    return Array.isArray(parsed.days) ? parsed.days : [];
}
function mealPlanErrorMessage(value) {
    const error = coachMealRecord(value).error;
    return typeof error === "string" ? error : undefined;
}
// ---------- Coach ----------
async function renderCoach() {
    headerTitle.textContent = "Coach";
    state.planSeg = "coach";
    view.innerHTML = segSkeleton("coach", planSeg(), 2);
    const agents = coachMealRows(await api("/agents"));
    const proposals = await api("/proposals?limit=10");
    const agentOpts = `<option value="auto">⟳ Auto · rotate enabled agents</option>` +
        agents.map((a) => `<option value="${escAttr(agentName(a))}"${a.enabled ? "" : " disabled"}>${escHtml(agentName(a))}${a.enabled ? "" : " (off)"}${a.env_ok ? "" : " · no key"}</option>`).join("");
    await skelSwap(() => {
        view.innerHTML = segBar("coach", planSeg()) + `
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
      <textarea id="custominstr" rows="3" class="form-textarea" placeholder="e.g. focus on lower body; hold everything else\u2026"></textarea>
    </div>
    <button id="runbtn" class="logbtn" style="width:100%;height:46px;font-size:1rem;letter-spacing:.05em">DRAFT PLAN UPDATE</button>
    <div id="runstatus" style="margin-top:10px;color:var(--muted);font-size:.85rem"></div>
    <button id="mealbtn" class="draftbtn" style="width:100%;height:46px;font-size:1rem;margin-top:14px;letter-spacing:.05em">DRAFT WEEKLY MEAL PLAN</button>
    <div id="mealstatus" style="margin-top:10px;color:var(--muted);font-size:.85rem"></div>
    <h1 class="lbl" style="margin:24px 0 8px">Proposals</h1>
    <div id="proplist"></div>
    <h1 class="lbl" style="margin:24px 0 8px">Meal plans</h1>
    <div id="meallist"></div>`;
    });
    wireSeg(PLAN_HANDLERS);
    $("#presetsel")?.addEventListener("change", (e) => {
        const wrap = htmlElement($("#customwrap"));
        const target = e.target instanceof HTMLSelectElement ? e.target : null;
        if (wrap)
            wrap.style.display = target?.value === "custom" ? "block" : "none";
    });
    $("#runbtn")?.addEventListener("click", runCoach);
    $("#mealbtn")?.addEventListener("click", runMealPlan);
    renderProposals(proposals);
    renderMealPlans(await api("/mealplans?limit=8"));
}
function instructionValue() {
    const preset = $("#presetsel")?.value || "";
    if (preset === "custom")
        return $("#custominstr")?.value.trim() || "";
    return preset;
}
// Draft a plan-update proposal from the Coach sub-view (#runbtn). Runs as a durable
// background job so a long draft survives a reload mid-run, streaming its evolving
// caption + filament into #runstatus; when background ops are off, runOp renders the
// inline result immediately. On done we refresh the proposals list in place.
function runCoach() {
    const agent = $("#agentsel")?.value || "auto";
    const status = $("#runstatus");
    const btn = $("#runbtn");
    if (btn)
        btnBusy(btn, "Drafting\u2026");
    if (status)
        status.innerHTML = CairnUi.jobCaptionHtml();
    runOp("proposal", { agent, instruction: instructionValue() }, coachProposalOpOpts());
}
// Plain-words failure line for a proposal draft \u2014 honest about cause (no agent vs
// agent failed vs unreachable), mirroring mealDraftFailLine.
function proposalDraftFailLine(err) {
    if (coachMealRecord(err).agent_status === "unconfigured")
        return "Drafting a plan needs a coaching agent \u2014 connect one in Settings.";
    if (err)
        return "The coach replied but didn't return a plan \u2014 try again, or pick another agent in Settings.";
    return "Couldn't reach the coach \u2014 check your connection.";
}
// Shared runOp options for a Coach-view proposal draft \u2014 used by the trigger and the
// reload reconnector so render/fail behavior is identical. A draft always persists as
// a row, so we refresh the proposals list on BOTH paths (the raw row shows even on a
// no-plan reply, exactly as before).
function coachProposalOpOpts() {
    return {
        path: "/agent/run",
        anchor: "#runstatus",
        caption: "proposal",
        guard: () => !$("#runstatus")?.isConnected,
        isFail: (r) => coachMealRecord(r).ok !== true,
        render: async () => {
            const status = $("#runstatus");
            if (status)
                status.textContent = "Draft ready \u2014 review below.";
            const btn = $("#runbtn");
            restoreBusy(btn);
            try {
                renderProposals(await api("/proposals?limit=10"));
            }
            catch { }
        },
        onFail: async (err) => {
            const status = $("#runstatus");
            if (status)
                status.textContent = proposalDraftFailLine(err);
            const btn = $("#runbtn");
            restoreBusy(btn);
            try {
                renderProposals(await api("/proposals?limit=10"));
            }
            catch { }
        },
    };
}
// Clamp transparency from the most recent apply, keyed by proposal id, so a light
// re-render of the list can still surface the "adjusted to a safe step" note on the
// card that was just applied (the clamp detail isn't persisted on the row).
// Shared proposal render helpers live in /js/proposal-client.js.
const lastApplyClamp = {};
// Apply one proposal by id — the single apply path shared by the Coach list and the
// Plan → Endurance "shape your running" composer. Flips the draft to 'applied'
// server-side (surgical for run prescriptions), remembers any safe-step clamp so the
// re-render can surface the honest note, toasts, and invalidates the stale plan cache.
// Returns the apply response (or null on transport failure). Callers re-render.
async function applyProposalById(id, btn) {
    if (btn)
        btnBusy(btn, "Applying…");
    let r = null;
    try {
        r = await api(`/proposals/${id}/apply`, { method: "POST" });
    }
    catch {
        r = null;
    }
    // Honest failure: the caller re-renders, so the draft stays actionable.
    const m = applyResultMessage(r);
    if (m.failed) {
        toast(m.message);
        return r;
    }
    if (Array.isArray(r?.clamped) && r.clamped.length)
        lastApplyClamp[String(id)] = r.clamped;
    toast(m.message);
    state.plan = [];
    swrInvalidate("plan"); // applied targets — the plan cache is stale
    return r;
}
// Light refresh of just the proposals list — re-fetch + re-render, no skeleton/full
// view rebuild (keeps scroll, and the apply transition reads cleanly).
async function refreshProposals() {
    try {
        renderProposals(await api("/proposals?limit=10"));
    }
    catch { /* keep last paint */ }
}
function renderProposals(proposals) {
    const wrap = $("#proplist");
    if (!wrap)
        return;
    wrap.innerHTML = CairnProposal.coachProposalListHtml(proposals, lastApplyClamp);
    wrap.querySelectorAll("[data-apply]").forEach((b) => b.addEventListener("click", async () => {
        await applyProposalById(b.dataset.apply, b);
        refreshProposals();
    }));
    wrap.querySelectorAll("[data-discard]").forEach((b) => b.addEventListener("click", async () => {
        try {
            await api(`/proposals/${b.dataset.discard}/discard`, { method: "POST" });
        }
        catch { }
        refreshProposals();
    }));
}
// ---------- meal plans ----------
// SWR cache keys for the meals journal — drafts/swaps/reorders/recipes mutate
// `current.parsed` in memory or change the plan server-side, so any such write
// swrInvalidate()s MEALS_KEY to keep the next warm paint honest. MEALS_SETTINGS_KEY
// caches /settings for the verbatim meal_prefs that ride along into the journal.
var MEALS_KEY = "meals:plans";
var MEALS_SETTINGS_KEY = "meals:settings";
// `verified` (the self-critique "checked against your floors" signal) is returned at
// DRAFT time on the /coach/mealplan response but is NOT persisted on the plan row, so
// we remember it by the just-drafted plan's id for the journal view to surface once.
const _verifiedByPlan = new Map();
// One warm status line for a meal-plan draft that didn't land. The runOp onFail arg
// is either the RESULT object (a designed ok:false — carries agent_status) or null
// (a transport drop). When coaching is simply unconfigured, name the honest cause
// and point at Settings; otherwise a calm "try again".
function mealDraftFailLine(err) {
    if (coachMealRecord(err).agent_status === "unconfigured")
        return "Drafting a plan needs a coaching agent — connect one in Settings.";
    if (err)
        return "The coach replied but didn't return a plan — try again.";
    return "Couldn't reach the coach — check your connection.";
}
function rememberVerified(r) {
    const row = coachMealRecord(r);
    if (row.ok && row.plan && row.plan.id != null && row.verified && row.verified.checked) {
        _verifiedByPlan.set(row.plan.id, row.verified);
    }
}
// Draft a meal plan from the Coach sub-view (#mealbtn). Runs as a durable
// background job so a long draft survives a reload mid-run (streaming its evolving
// caption + determinate filament into #mealstatus); when background ops are off,
// runOp renders the inline result immediately. On done we refresh the meal-plan
// list in place and invalidate the journal SWR key so the journal paints truth.
function runMealPlan() {
    const agent = $("#agentsel")?.value || "auto";
    const status = $("#mealstatus");
    const btn = $("#mealbtn");
    if (btn)
        btnBusy(btn, "Drafting\u2026");
    if (status)
        status.innerHTML = CairnUi.jobCaptionHtml();
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
        isFail: (r) => {
            const row = coachMealRecord(r);
            return row.ok !== true || !row.plan;
        },
        render: async (r) => {
            rememberVerified(r);
            const status = $("#mealstatus");
            if (status)
                status.textContent = "Meal plan ready.";
            const btn = $("#mealbtn");
            restoreBusy(btn);
            swrInvalidate(MEALS_KEY); // the journal's SWR cache is now stale
            try {
                renderMealPlans(await api("/mealplans?limit=8"));
            }
            catch { }
        },
        onFail: (err) => {
            const status = $("#mealstatus");
            if (status)
                status.textContent = mealDraftFailLine(err);
            const btn = $("#mealbtn");
            restoreBusy(btn);
        },
    };
}
// Meal-plan row/list/day render helpers live in /js/meal-plan-client.js.
function renderMealPlans(plans, sel = "#meallist", refresh = null) {
    const wrap = $(sel);
    if (!wrap)
        return;
    wrap.innerHTML = CairnMealPlan.mealPlanListHtml(plans);
    wrap.querySelectorAll("[data-accept]").forEach((b) => b.addEventListener("click", async () => {
        await api(`/mealplans/${b.dataset.accept}/accept`, { method: "POST" });
        toast("Meal plan accepted");
        swrInvalidate(MEALS_KEY); // status flipped to kept — the journal's warm cache is now stale
        if (refresh)
            refresh();
        else
            renderMealPlans(await api("/mealplans?limit=8"), sel);
    }));
    wrap.querySelectorAll("[data-discard]").forEach((b) => b.addEventListener("click", async () => {
        await api(`/mealplans/${b.dataset.discard}/discard`, { method: "POST" });
        toast("Discarded");
        swrInvalidate(MEALS_KEY); // status flipped to discarded — the journal's warm cache is now stale
        if (refresh)
            refresh();
        else
            renderMealPlans(await api("/mealplans?limit=8"), sel);
    }));
}
// ---------- Meals planner (Plan tab · Meals) ----------
// A Morsel-style journal over the current weekly meal plan: big serif day names,
// floating food art, per-meal macro chips, per-day totals. The classic mp-card
// list survives as a collapsed history beneath it.
// Meal-plan shell/prefs/day render helpers live in /js/meal-plan-client.js.
function wireMealPrefs() {
    const card = view.querySelector("#mealPrefs");
    if (!card)
        return;
    const head = card.querySelector("#mealPrefsToggle");
    const bodyEl = card.querySelector(".mealprefs-body");
    const ta = card.querySelector("#mealPrefsText");
    if (!head || !bodyEl || !ta)
        return;
    head.addEventListener("click", () => {
        const open = bodyEl.hidden === true;
        bodyEl.hidden = !open;
        card.classList.toggle("open", open);
        head.setAttribute("aria-expanded", String(open));
        if (open)
            ta.focus();
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
            if (mealPlanErrorMessage(r)) {
                toast("Couldn't save preferences");
                return false;
            }
            const v = ta.value.trim();
            const prev = card.querySelector(".mealprefs-preview");
            if (prev) {
                prev.textContent = v || CairnMealPlan.MEAL_PREFS_PLACEHOLDER;
                prev.classList.toggle("mealprefs-placeholder", !v);
            }
            bodyEl.hidden = true; // collapse back to the preview; the bar flashes Saved
            card.classList.remove("open");
            head.setAttribute("aria-expanded", "false");
            return true;
        },
        onDiscard: () => renderMeals(), // re-render from server state
    });
    card.querySelectorAll("[data-pref]").forEach((c) => c.addEventListener("click", () => {
        const t = c.dataset.pref;
        if (!t)
            return;
        const cur = ta.value.trim();
        if (cur.toLowerCase().includes(t.toLowerCase()))
            return; // already in there
        ta.value = cur ? cur.replace(/[.;,]\s*$/, "") + ". " + t : t;
        bar.markDirty(); // programmatic insert fires no input event
        ta.focus();
    }));
}
// One planner day section lives in /js/meal-plan-client.js so swap/reorder rerenders
// use the same typed source as the initial Meals paint.
// Re-render a single planner day from the in-memory plan (after swap/reorder) —
// regenerates data-* indices, totals, the target bar, and re-runs count-ups.
// settleMi: meal index to flash with the gentle settle highlight.
function rerenderMealDay(current, di, ctx, settleMi = null) {
    const sec = view.querySelector(`.mealday[data-mday="${di}"]`);
    const d = mealPlanDays(current)[di];
    if (!sec || !d)
        return;
    const tmp = document.createElement("div");
    tmp.innerHTML = CairnMealPlan.mealDayHtml(d, di, ctx || {});
    const fresh = htmlElement(tmp.firstElementChild);
    if (!fresh)
        return;
    fresh.classList.remove("reveal"); // no re-entrance rise on an in-place update
    sec.replaceWith(fresh);
    wireMealRows(fresh, current, ctx);
    runCountUps(fresh);
    if (settleMi != null)
        fresh.querySelector(`.meal-row[data-mi="${settleMi}"]`)?.classList.add("meal-settled");
}
// Agentic swap of one planned meal — POST /meal-plans/:id/swap runs an external CLI
// agent (15–120s) as a durable background job (runOp): the row goes busy while the
// rest of the view stays live, the job survives a reload mid-run (the swap caption
// streams into the busy row), and the job system itself is the in-flight lock — no
// client-side flag needed (a second swap on the same row is gated by .meal-busy).
// When background ops are off, runOp renders the inline result immediately.
async function submitMealSwap(current, ctx, di, mi, panel) {
    const day = mealPlanDays(current)[di];
    if (!day)
        return;
    const row = htmlElement(panel.previousElementSibling);
    if (row && row.classList.contains("meal-busy")) {
        toast("A swap is already running");
        return;
    }
    const hint = panel.querySelector(".meal-swap-hint")?.value.trim() || "";
    const go = panel.querySelector(".meal-swap-go");
    if (row) {
        row.classList.add("meal-busy");
        row.querySelector(".meal-cap")?.remove();
        row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
    }
    panel.classList.add("meal-swap-busy");
    btnBusy(go, "Asking the coach…", { ghost: true });
    panel.querySelectorAll("button,input").forEach((el) => {
        if (el !== go && (el instanceof HTMLButtonElement || el instanceof HTMLInputElement))
            el.disabled = true;
    });
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
        isFail: (r) => {
            const row = coachMealRecord(r);
            const plan = mealPlanRecord(row.plan);
            return row.ok !== true || !(plan.parsed || row.meal);
        },
        render: (r) => {
            const row = coachMealRecord(r);
            const plan = mealPlanRecord(row.plan);
            if (plan.parsed)
                current.parsed = mealParsed(plan.parsed); // server copy is the source of truth
            else {
                const d = mealPlanDays(current)[di];
                if (d?.meals)
                    d.meals[mi] = coachMealRecord(row.meal);
            }
            swrInvalidate(MEALS_KEY); // the journal's cached plan list is now stale
            rerenderMealDay(current, di, ctx, mi);
            toast("Meal swapped");
        },
        onFail: () => {
            const row = view.querySelector(rowSel);
            if (row) {
                row.classList.remove("meal-busy");
                row.querySelector(".meal-cap")?.remove();
            }
            const panel = htmlElement(row?.nextElementSibling);
            if (panel && panel.classList.contains("meal-swap")) {
                panel.classList.remove("meal-swap-busy");
                panel.querySelectorAll("button,input").forEach((el) => {
                    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement)
                        el.disabled = false;
                });
                const go = panel.querySelector(".meal-swap-go");
                restoreBusy(go);
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
    const input = coachMealRecord(coachMealRecord(job).input);
    const planId = Number(input.id);
    // The journal view keys its rows by day INDEX, but the job carries the day NAME —
    // match it to recover di. We only have the rendered DOM here, so read the plan
    // from the SWR cache (the meals view just painted it).
    const cached = mealPlanRows(peekCached(MEALS_KEY)?.data || []);
    const current = cached.find((p) => Number(p.id) === planId);
    if (!current || !mealPlanDays(current).length)
        return null; // plan not in view — retry on a later render
    const di = mealPlanDays(current).findIndex((d) => String(d?.day ?? "").trim().toLowerCase() === String(input.day ?? "").trim().toLowerCase());
    const mi = Number(input.meal_index);
    if (di < 0 || !Number.isFinite(mi))
        return null;
    const ctx = CairnMealPlan.mealsCtxFor(current);
    const rowSel = `.mealday[data-mday="${di}"] .meal-row[data-mi="${mi}"]`;
    const row = view.querySelector(rowSel);
    if (!row)
        return null; // row not on screen (e.g. a different sub-view) — retry later
    row.classList.add("meal-busy");
    row.querySelector(".meal-cap")?.remove();
    row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
    const o = mealSwapOpOpts(current, ctx, di, mi);
    let stop = () => { };
    const capEl = row.querySelector(".job-cap");
    if (capEl)
        stop = thinkingCaption(capEl, o.caption);
    if (!reducedMotion())
        row.classList.add("is-thinking");
    const clear = () => { stop(); const r = view.querySelector(rowSel); if (r) {
        r.classList.remove("is-thinking", "is-thinking--determinate");
        r.style.removeProperty("--frac");
    } };
    return {
        guard: o.guard,
        onDone: (result) => { clear(); if (o.isFail(result))
            o.onFail(result);
        else
            o.render(result); },
        onError: () => { clear(); o.onFail(null); },
        onCanceled: () => { clear(); o.onFail(null); },
    };
}
// Move a meal up/down within its day: optimistic re-render, then persist the full
// days array via PUT /meal-plans/:id/days. Revert + toast on failure.
async function moveMealRow(current, ctx, di, mi, dir) {
    const days = mealPlanDays(current);
    const meals = days[di]?.meals;
    const j = mi + dir;
    if (!meals || mi < 0 || mi >= meals.length || j < 0 || j >= meals.length)
        return;
    const token = pollToken;
    [meals[mi], meals[j]] = [meals[j], meals[mi]];
    rerenderMealDay(current, di, ctx, j); // optimistic — indices regenerate from the array
    try {
        const r = await api(`/meal-plans/${current.id}/days`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ days }),
        });
        if (mealPlanErrorMessage(r))
            throw new Error(mealPlanErrorMessage(r));
        swrInvalidate(MEALS_KEY); // reorder persisted — the journal's cached plan list is stale
    }
    catch {
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
    scope.querySelectorAll("[data-mlog]").forEach((b) => b.addEventListener("click", async () => {
        let x;
        try {
            x = coachMealRecord(JSON.parse(b.dataset.mlog || "{}"));
        }
        catch {
            return;
        }
        const btn = buttonElement(b);
        if (btn)
            btn.disabled = true;
        // plans often name meals by slot ("Breakfast") with the dish in items —
        // the journal entry's title should be the dish, not the slot
        const generic = /^(breakfast|lunch|dinner|snack|pre[- ]?workout|post[- ]?workout)$/i.test(String(x.name || "").trim());
        const title = generic && x.items ? x.items : (x.name || x.items || "Planned meal");
        try {
            await api("/food-notes", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    meal: CairnMealPlan.mealSlotFor(x.name, x.i), raw: "",
                    parsed: { summary: title, items: x.items || "", kcal: x.kcal, protein_g: x.protein_g, carbs_g: x.carbs_g, fat_g: x.fat_g },
                }),
            });
            b.textContent = "✓ Logged";
            b.classList.add("meal-log-done");
            toast(`${x.name || "Meal"} logged`);
        }
        catch {
            if (btn)
                btn.disabled = false;
            toast("Couldn't log meal");
        }
    }));
    // ⇄ Swap — toggle the inline hint panel under the row
    scope.querySelectorAll("[data-mswap]").forEach((b) => b.addEventListener("click", () => {
        const row = htmlElement(b.closest(".meal-row"));
        const panel = htmlElement(row?.nextElementSibling);
        if (!row || !panel || !panel.classList.contains("meal-swap") || row.classList.contains("meal-busy"))
            return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden)
            panel.querySelector(".meal-swap-hint")?.focus();
    }));
    scope.querySelectorAll(".meal-swap-cancel").forEach((b) => b.addEventListener("click", () => { const panel = htmlElement(b.closest(".meal-swap")); if (panel)
        panel.hidden = true; }));
    scope.querySelectorAll(".hintchip").forEach((c) => c.addEventListener("click", () => {
        const panel = htmlElement(c.closest(".meal-swap"));
        const input = panel?.querySelector(".meal-swap-hint");
        if (!panel || !input)
            return;
        const on = c.classList.contains("on");
        panel.querySelectorAll(".hintchip").forEach((x) => x.classList.remove("on"));
        c.classList.toggle("on", !on);
        input.value = on ? "" : c.dataset.hint || "";
    }));
    scope.querySelectorAll(".meal-swap-hint").forEach((i) => i.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            i.closest(".meal-swap")?.querySelector(".meal-swap-go")?.click();
        }
    }));
    scope.querySelectorAll(".meal-swap-go").forEach((b) => b.addEventListener("click", () => {
        const panel = htmlElement(b.closest(".meal-swap"));
        if (!panel)
            return;
        submitMealSwap(current, ctx, Number(panel.dataset.di), Number(panel.dataset.mi), panel);
    }));
    // ▲▼ — move a meal within its day, persist the whole days array
    scope.querySelectorAll(".meal-mv").forEach((b) => b.addEventListener("click", () => {
        const row = htmlElement(b.closest(".meal-row"));
        if (!row || row.classList.contains("meal-busy"))
            return;
        moveMealRow(current, ctx, Number(row.dataset.di), Number(row.dataset.mi), Number(b.dataset.mv));
    }));
    // tap a meal row's body → detail bottom sheet (buttons and the swap panel keep their own taps)
    scope.querySelectorAll(".meal-row[data-di]").forEach((row) => row.addEventListener("click", (e) => {
        if (eventElement(e)?.closest("button, input, a, .meal-swap"))
            return;
        if (row.classList.contains("meal-busy"))
            return;
        CairnMealRecipeController.openMealSheet(current, Number(row.dataset.di), Number(row.dataset.mi));
    }));
}
// ---------- Plan → Food (daily logged-food journal + target context) ----------
// Capture mostly happens in Chat. This tab is the quick review/correction surface:
// what's logged today, where it sits against the current target, and the adaptive
// energy-balance check-in. It is intentionally separate from weekly meal plans so
// the daily log is always one header tap away.
function renderFoodJournal() {
    headerTitle.textContent = "Plan";
    state.planSeg = "food";
    const token = ++pollToken;
    view.innerHTML = segBar("food", planSeg()) + `<section class="meal-energy food-journal" id="mealEnergy">
      <div id="dayFuelSlot" class="dayfuel-slot">${loadingState("Reading today's food…")}</div>
      <div id="energyHero"></div>
      <div id="energyCard">${loadingState("Reading your trend…")}</div>
      <div id="checkinResult" class="checkin-result"></div>
    </section>`;
    wireSeg(PLAN_HANDLERS);
    CairnDayFuelController.loadDayFuel(token, {
        isCurrent: (candidate) => candidate === pollToken && Boolean(view.querySelector("#dayFuelSlot")),
        onAsk: () => gotoChatWith("How's my eating shaping up today, and does it fit my goal?"),
        onRerender: rerenderFoodSurface,
    });
    loadMealsEnergy(token);
}
function rerenderFoodSurface() {
    if (view.querySelector(".food-journal"))
        renderFoodJournal();
    else
        renderMeals();
}
// The meal-plan journal paints instantly from a warm peek and upgrades on change.
// The plans list (the surface that actually changes) is the SWR-keyed surface; meal
// prefs ride along from /settings (peeked, revalidated, but a prefs-only change is
// rare enough that we just reuse whatever the peek/last fetch gave us per paint).
async function renderMeals() {
    headerTitle.textContent = "Plan";
    state.planSeg = "meals";
    const token = ++pollToken;
    const peek = peekCached(MEALS_KEY);
    if (!peek)
        view.innerHTML = segSkeleton("meals", planSeg(), 3); // cold: skeleton-first
    // meal prefs come from /settings; peek it so a warm paint has the verbatim text,
    // and revalidate in the background (cheap, shares the SWR tiers).
    let mealPrefs = String(peekCached(MEALS_SETTINGS_KEY)?.data?.settings?.meal_prefs || "");
    cachedApi("/settings", {
        key: MEALS_SETTINGS_KEY,
        onUpgrade: (data) => { mealPrefs = String(data.settings?.meal_prefs || ""); },
    }).catch(() => { });
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
    const current = CairnMealPlan.currentMealPlan(plans);
    const currentPlan = current ? mealPlanRecord(current) : null;
    const shopChecked = currentPlan ? new Set(JSON.parse(localStorage.getItem(`shop:${currentPlan.id}`) || "[]")) : new Set();
    const painted = CairnMealPlan.mealPlannerBodyHtml(current, mealPrefs, {
        checkedShopping: shopChecked,
        verified: currentPlan ? _verifiedByPlan.get(currentPlan.id) : null,
    });
    const body = painted.html;
    const ctx = painted.context;
    view.innerHTML = segBar("meals", planSeg()) + body + `
    <details class="mp-history">
      <summary class="lbl">Past meal plans</summary>
      <div id="mealHist" style="margin-top:10px"></div>
    </details>`;
    wireSeg(PLAN_HANDLERS);
    runCountUps(view);
    renderMealPlans(plans, "#mealHist", () => renderMeals());
    wireMealPrefs();
    if (currentPlan) {
        wireMealRows(view, currentPlan, ctx);
        loadMealProvenance();
    }
    // shopping chips check off (persisted per plan, local-only)
    if (currentPlan)
        view.querySelectorAll("[data-shop]").forEach((c) => c.addEventListener("click", () => {
            c.classList.toggle("chip-done");
            const done = [...view.querySelectorAll("[data-shop].chip-done")].map((el) => Number(el.dataset.shop));
            localStorage.setItem(`shop:${currentPlan.id}`, JSON.stringify(done));
        }));
    const keep = view.querySelector("[data-mkeep]");
    if (keep)
        keep.addEventListener("click", async () => {
            await api(`/mealplans/${keep.dataset.mkeep}/accept`, { method: "POST" });
            toast("Meal plan kept");
            renderMeals();
        });
    const disc = view.querySelector("[data-mdiscard]");
    if (disc)
        disc.addEventListener("click", async () => {
            await api(`/mealplans/${disc.dataset.mdiscard}/discard`, { method: "POST" });
            toast("Discarded");
            renderMeals();
        });
    const draftBtn = view.querySelector("#mealDraftBtn");
    if (draftBtn)
        draftBtn.addEventListener("click", () => draftWeeklyMeals());
}
// SWR over the derived expenditure (key shared with the old Energy view), painted
// into whichever nutrition surface owns #energyHero/#energyCard. A warm re-entry
// paints instantly, then revalidates. Bails if the slot's gone.
function loadMealsEnergy(token) {
    if (!view.querySelector("#energyCard"))
        return;
    const peek = peekCached("progress:energy");
    const paint = (exp) => {
        if (token !== pollToken || !view.querySelector("#energyCard"))
            return;
        paintEnergyBody(exp);
    };
    if (peek) {
        paint(peek.data);
        if (!peek.fresh)
            markRefreshing(true);
    }
    cachedApi("/nutrition/expenditure?window=21", {
        key: "progress:energy",
        onUpgrade: (exp, { changed }) => { if (peek && !peek.fresh)
            markRefreshing(false); if (changed || !peek)
            paint(exp); },
    }).catch(() => { if (peek && !peek.fresh)
        markRefreshing(false); });
}
// Draft a fresh weekly meal plan from the journal view. Runs as a durable
// background job (runOp) so the draft survives a reload mid-run and streams its
// evolving "thinking" caption + determinate filament into #mealDraftStatus; when
// background ops are off, runOp renders the inline result immediately. On done we
// invalidate the SWR key and re-render so the fresh plan paints from truth.
function draftWeeklyMeals() {
    const draftBtn = view.querySelector("#mealDraftBtn");
    const status = view.querySelector("#mealDraftStatus");
    if (!status)
        return;
    if (draftBtn)
        btnBusy(draftBtn, "Drafting…", { ghost: true });
    // The status line carries the .job-cap caption slot; a running draft re-attaches
    // after a reload via its registered reconnector.
    status.innerHTML = CairnUi.jobCaptionHtml();
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
        isFail: (r) => {
            const row = coachMealRecord(r);
            return row.ok !== true || !row.plan;
        },
        render: (r) => {
            rememberVerified(r);
            toast("Meal plan drafted");
            swrInvalidate(MEALS_KEY);
            renderMeals();
        },
        onFail: (err) => {
            const s = view.querySelector("#mealDraftStatus");
            if (s)
                s.textContent = mealDraftFailLine(err);
            const b = view.querySelector("#mealDraftBtn");
            restoreBusy(b);
        },
    };
}
// Shared "rebuild a loading caption on a status host" reconnector body. Used by any
// op whose loading state is a #status host carrying a .job-cap + a frozen draft
// button (meal-plan from the journal/Coach, and proposal drafts from Coach/Endurance).
// A single registered reconnector per kind picks whichever host is currently mounted;
// the matching draft button (if present) is re-frozen and the op's render/fail lands
// in place. Generic over (opOpts, statusSelector, buttonSelector, ghost-ring).
function reconnectStatusHost(o, statusSel, btnSel, ghost) {
    const status = view.querySelector(statusSel);
    if (!status)
        return null; // host not mounted — a later render retries
    const btn = btnSel ? view.querySelector(btnSel) : null;
    if (btn)
        btnBusy(btn, "Drafting…", { ghost });
    status.innerHTML = CairnUi.jobCaptionHtml();
    let stop = () => { };
    const capEl = status.querySelector(".job-cap");
    if (capEl)
        stop = thinkingCaption(capEl, o.caption);
    if (!reducedMotion())
        status.classList.add("is-thinking");
    const clear = () => { stop(); const s = view.querySelector(statusSel); if (s) {
        s.classList.remove("is-thinking", "is-thinking--determinate");
        s.style.removeProperty("--frac");
    } };
    return {
        guard: o.guard,
        onDone: (result) => { clear(); if (o.isFail(result))
            o.onFail(result);
        else
            o.render(result); },
        onError: () => { clear(); o.onFail(null); },
        onCanceled: () => { clear(); o.onFail(null); },
    };
}
// The single registered reconnector for `meal_plan` jobs: prefer the journal host
// (#mealDraftStatus), else the Coach host (#mealstatus); null when neither is up.
function reconnectMealPlan() {
    if (view.querySelector("#mealDraftStatus")) {
        return reconnectStatusHost(mealPlanDraftOpOpts(), "#mealDraftStatus", "#mealDraftBtn", true);
    }
    if (view.querySelector("#mealstatus")) {
        return reconnectStatusHost(coachMealPlanOpOpts(), "#mealstatus", "#mealbtn", false);
    }
    return null;
}
// The single registered reconnector for `proposal` jobs: both the Coach draft
// (#runstatus) and the Plan → Endurance composer (#endDraftStatus) enqueue the same
// `proposal` kind, so this picks whichever surface is currently mounted. When neither
// is (the user navigated elsewhere), the draft still persisted server-side and shows
// on the next render — so a null reconnector is safe, no work is lost.
function reconnectProposal() {
    if (view.querySelector("#endDraftStatus")) {
        enduranceComposerLock(); // re-lock chips + the in-flight flag, not just the button
        return reconnectStatusHost(enduranceProposalOpOpts(), "#endDraftStatus", "#endDraftBtn", false);
    }
    if (view.querySelector("#runstatus")) {
        return reconnectStatusHost(coachProposalOpOpts(), "#runstatus", "#runbtn", false);
    }
    return null;
}
Object.assign(globalThis, {
    MEALS_KEY,
    applyProposalById,
    closeMealSheet,
    reconnectMealPlan,
    reconnectMealSwap,
    reconnectProposal,
    reconnectRecipe,
    renderCoach,
    renderFoodJournal,
    renderMeals,
    rerenderFoodSurface,
});
})();

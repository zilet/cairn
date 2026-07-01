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
function htmlElement(value) {
    return value instanceof HTMLElement ? value : null;
}
function restoreBusy(value) {
    value?._busyRestore?.();
}
function agentName(agent) {
    return typeof agent.name === "string" && agent.name ? agent.name : "agent";
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
    CairnMealPlannerController.renderMealPlans(await api("/mealplans?limit=8"));
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
// Planner operations/reconnectors live in /js/meal-planner-controller.js; this
// screen owns only the visible Coach/Plan routing and paint sequence.
function runMealPlan() {
    const agent = $("#agentsel")?.value || "auto";
    CairnMealPlannerController.runCoachMealPlan(agent, instructionValue());
}
// ---------- Meals planner (Plan tab · Meals) ----------
// A Morsel-style journal over the current weekly meal plan: big serif day names,
// floating food art, per-meal macro chips, per-day totals. The classic mp-card
// list survives as a collapsed history beneath it.
// Meal-plan shell/day render helpers live in /js/meal-plan-client.js.
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
    const currentPlan = current && (typeof current.id === "string" || typeof current.id === "number")
        ? current
        : null;
    const shopChecked = currentPlan ? new Set(JSON.parse(localStorage.getItem(`shop:${currentPlan.id}`) || "[]")) : new Set();
    const painted = CairnMealPlan.mealPlannerBodyHtml(current, mealPrefs, {
        checkedShopping: shopChecked,
        verified: currentPlan ? CairnMealPlannerController.verifiedForPlan(currentPlan.id) : null,
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
    CairnMealPlannerController.renderMealPlans(plans, "#mealHist", () => renderMeals());
    CairnMealPlannerController.wireMealPlannerBody(currentPlan, ctx);
    if (currentPlan)
        loadMealProvenance();
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
// The single registered reconnector for `proposal` jobs: both the Coach draft
// (#runstatus) and the Plan → Endurance composer (#endDraftStatus) enqueue the same
// `proposal` kind, so this picks whichever surface is currently mounted. When neither
// is (the user navigated elsewhere), the draft still persisted server-side and shows
// on the next render — so a null reconnector is safe, no work is lost.
function reconnectProposal() {
    if (view.querySelector("#endDraftStatus")) {
        enduranceComposerLock(); // re-lock chips + the in-flight flag, not just the button
        return CairnMealPlannerController.reconnectStatusHost(enduranceProposalOpOpts(), "#endDraftStatus", "#endDraftBtn", false);
    }
    if (view.querySelector("#runstatus")) {
        return CairnMealPlannerController.reconnectStatusHost(coachProposalOpOpts(), "#runstatus", "#runbtn", false);
    }
    return null;
}
Object.assign(globalThis, {
    applyProposalById,
    reconnectProposal,
    renderCoach,
    renderFoodJournal,
    renderMeals,
    rerenderFoodSurface,
});
})();

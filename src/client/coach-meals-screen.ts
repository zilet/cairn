// ==== 06-coach-meals.js ====
type CoachAgent = import("../contracts/client-api.js").ClientAgentInfo & { name?: string };
type CoachMealPlan = import("../contracts/client-api.js").ClientMealPlan;
type CoachMealRecord = Record<string, unknown>;

function isCoachMealRecord(value: unknown): value is CoachMealRecord {
  return !!value && typeof value === "object";
}

function coachMealRows<T extends CoachMealRecord = CoachMealRecord>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isCoachMealRecord) as T[]) : [];
}

function htmlElement<T extends HTMLElement = HTMLElement>(value: Element | null | undefined): T | null {
  return value instanceof HTMLElement ? value as T : null;
}

function agentName(agent: CoachAgent): string {
  return typeof agent.name === "string" && agent.name ? agent.name : "agent";
}

// ---------- Coach ----------
async function renderCoach(): Promise<void> {
  headerTitle.textContent = "Coach";
  state.planSeg = "coach";
  view.innerHTML = segSkeleton("coach", planSeg(), 2);
  const agents = coachMealRows<CoachAgent>(await api("/agents"));
  const proposals = await api("/proposals?limit=10");
  const agentOpts =
    `<option value="auto">⟳ Auto · rotate enabled agents</option>` +
    agents.map((a) =>
      `<option value="${escAttr(agentName(a))}"${a.enabled ? "" : " disabled"}>${escHtml(agentName(a))}${a.enabled ? "" : " (off)"}${a.env_ok ? "" : " · no key"}</option>`
    ).join("");

  await skelSwap(() => { view.innerHTML = segBar("coach", planSeg()) + `
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
    <div id="meallist"></div>`; });

  wireSeg(PLAN_HANDLERS);
  $<HTMLSelectElement>("#presetsel")?.addEventListener("change", (e) => {
    const wrap = htmlElement($("#customwrap"));
    const target = e.target instanceof HTMLSelectElement ? e.target : null;
    if (wrap) wrap.style.display = target?.value === "custom" ? "block" : "none";
  });
  $("#runbtn")?.addEventListener("click", () => {
    CairnCoachProposalController.runCoachProposal($<HTMLSelectElement>("#agentsel")?.value || "auto", instructionValue());
  });
  $("#mealbtn")?.addEventListener("click", runMealPlan);
  CairnCoachProposalController.renderProposals(proposals);
  CairnMealPlannerController.renderMealPlans(await api("/mealplans?limit=8"));
}

function instructionValue(): string {
  const preset = $<HTMLSelectElement>("#presetsel")?.value || "";
  if (preset === "custom") return $<HTMLTextAreaElement>("#custominstr")?.value.trim() || "";
  return preset;
}

// ---------- meal plans ----------
// Planner operations/reconnectors live in /js/meal-planner-controller.js;
// proposal orchestration lives in /js/coach-proposal-controller.js. This screen
// owns only the visible Coach/Plan routing and paint sequence.
function runMealPlan(): void {
  const agent = $<HTMLSelectElement>("#agentsel")?.value || "auto";
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
function renderFoodJournal(): void {
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

function rerenderFoodSurface(): void {
  if (view.querySelector(".food-journal")) renderFoodJournal();
  else renderMeals();
}

// The meal-plan journal paints instantly from a warm peek and upgrades on change.
// The plans list (the surface that actually changes) is the SWR-keyed surface; meal
// prefs ride along from /settings (peeked, revalidated, but a prefs-only change is
// rare enough that we just reuse whatever the peek/last fetch gave us per paint).
async function renderMeals(): Promise<unknown> {
  headerTitle.textContent = "Plan";
  state.planSeg = "meals";
  const token = ++pollToken;
  const peek = peekCached<CoachMealPlan[]>(MEALS_KEY);
  if (!peek) view.innerHTML = segSkeleton("meals", planSeg(), 3); // cold: skeleton-first
  // meal prefs come from /settings; peek it so a warm paint has the verbatim text,
  // and revalidate in the background (cheap, shares the SWR tiers).
  let mealPrefs = String(peekCached<import("../contracts/client-api.js").ClientSettingsResponse>(MEALS_SETTINGS_KEY)?.data?.settings?.meal_prefs || "");
  cachedApi("/settings", {
    key: MEALS_SETTINGS_KEY,
    onUpgrade: (data) => { mealPrefs = String(data.settings?.meal_prefs || ""); },
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
function paintMealsBody(plans: unknown, mealPrefs: string): void {
  const current = CairnMealPlan.currentMealPlan(plans);
  const currentPlan = current && (typeof current.id === "string" || typeof current.id === "number")
    ? current as Record<string, unknown> & { id: string | number }
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
  if (currentPlan) loadMealProvenance();
}

// SWR over the derived expenditure (key shared with the old Energy view), painted
// into whichever nutrition surface owns #energyHero/#energyCard. A warm re-entry
// paints instantly, then revalidates. Bails if the slot's gone.
function loadMealsEnergy(token: number): void {
  if (!view.querySelector("#energyCard")) return;
  const peek = peekCached("progress:energy");
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

Object.assign(globalThis, {
  renderCoach,
  renderFoodJournal,
  renderMeals,
  rerenderFoodSurface,
});

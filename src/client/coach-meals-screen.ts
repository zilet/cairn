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
  return value instanceof HTMLElement ? (value as T) : null;
}

function agentName(agent: CoachAgent): string {
  return typeof agent.name === "string" && agent.name ? agent.name : "agent";
}

// Decisions still waiting on the athlete, across every domain. The Plan tab's
// forward note is scoped to training/recovery, so a conference about labs or
// fuelling has nowhere else to land — and this screen is the one that promises "a
// clear record here". Each row shows the sentence the conference wrote for a person,
// not its machine summary. Pull-only: it waits here, it never notifies.
function coachWaitingDecisionsHtml(rows: unknown): string {
  const items = coachMealRows(rows)
    .map((d) => ({
      summary: String(d.summary ?? "").trim(),
      explanation: String(d.explanation ?? "").trim(),
    }))
    .filter((d) => d.explanation)
    .slice(0, 4);
  if (!items.length) return "";
  const body = items
    .map(
      (d) => `<div class="plan-upcoming-item">
        ${d.summary ? `<p class="plan-upcoming-line">${escHtml(d.summary)}</p>` : ""}
        <p class="plan-upcoming-why">${escHtml(d.explanation)}</p>
      </div>`
    )
    .join("");
  // Collapsed by default, same footnote-weight disclosure as the Plan tab's
  // forward note — the count stays visible so "waiting on you" never goes dark,
  // the rationale paragraphs are one tap away.
  return `<details class="plan-upcoming reveal">
    <summary><span class="lbl plan-upcoming-strip">Waiting on you (${items.length})</span></summary>
    <div class="plan-upcoming-body">${body}</div>
  </details>`;
}

// ---------- Coach ----------
async function renderCoach(): Promise<void> {
  headerTitle.textContent = "Changes";
  state.planSeg = "coach";
  view.innerHTML = skelLines(2) + skelLines(3);
  const agents = coachMealRows<CoachAgent>(await api("/agents"));
  const proposals = await api("/proposals?limit=10");
  let waiting: unknown = null;
  try {
    waiting = await api("/brain/decisions/waiting?limit=8");
  } catch {
    // A missing waiting read never blocks the change history this screen is for.
  }
  const agentOpts =
    `<option value="auto">⟳ Auto · rotate enabled agents</option>` +
    agents
      .map(
        (a) =>
          `<option value="${escAttr(agentName(a))}"${a.enabled ? "" : " disabled"}>${escHtml(agentName(a))}${a.enabled ? "" : " (off)"}${a.env_ok ? "" : " · no key"}</option>`
      )
      .join("");

  await skelSwap(() => {
    view.innerHTML = `
    <button class="linkbtn linkbtn-plain" id="changesBackToPlan" type="button">‹ Plan</button>
    <p class="changes-lede sess-line" style="color:var(--muted);margin:2px 2px 16px;line-height:1.5">Your expert team adapts training and meals in the background, then leaves a clear record here. Most changes need nothing from you: they arrive at the right boundary with a heads-up and Undo. Talk to the team anytime in the <button class="linkbtn linkbtn-plain" id="changesToChat" type="button">Coach</button> tab.</p>
    ${coachWaitingDecisionsHtml(waiting)}
    <h1 class="lbl" style="margin:24px 0 8px">Program change history</h1>
    <div id="proplist"></div>
    <h1 class="lbl" style="margin:24px 0 8px">Meal-plan change history</h1>
    <div id="meallist"></div>
    <details class="changes-manual" style="margin-top:24px">
      <summary class="lbl">Manual review</summary>
      <p class="sess-line" style="color:var(--muted);margin:10px 2px 16px;line-height:1.5">The team reviews your signals automatically. Use these controls only when you want an extra review or want to give a specific direction.</p>
      <div class="field"><label>Agent</label>
        <select id="agentsel">${agentOpts || "<option>none configured</option>"}</select></div>
      <div class="field"><label>Instruction (optional)</label>
        <select id="presetsel">
          <option value="">Review recent sessions and prepare the next useful changes</option>
          <option value="Only adjust lower-body lifts; hold everything else.">Lower body only</option>
          <option value="Be extra conservative; I felt beat up this week.">Extra conservative</option>
          <option value="custom">Custom\u2026</option>
        </select></div>
      <div class="field" id="customwrap" style="display:none">
        <textarea id="custominstr" rows="3" class="form-textarea" placeholder="e.g. focus on lower body; hold everything else\u2026"></textarea>
      </div>
      <div class="meals-actions">
        <button id="runbtn" class="pillbtn pill-accent">Ask team to review program</button>
      </div>
      <div id="runstatus" style="margin-top:10px;color:var(--muted);font-size:.85rem"></div>
      <div class="meals-actions">
        <button id="mealbtn" class="pillbtn pill-accent">Ask team to refresh meals</button>
      </div>
      <div id="mealstatus" style="margin-top:10px;color:var(--muted);font-size:.85rem"></div>
    </details>`;
  });

  $("#changesBackToPlan")?.addEventListener("click", () => {
    state.planJump = "edit";
    activateTab("plan");
  });
  $("#changesToChat")?.addEventListener("click", () => activateTab("chat"));
  $<HTMLSelectElement>("#presetsel")?.addEventListener("change", (e) => {
    const wrap = htmlElement($("#customwrap"));
    const target = e.target instanceof HTMLSelectElement ? e.target : null;
    if (wrap) wrap.style.display = target?.value === "custom" ? "block" : "none";
  });
  $("#runbtn")?.addEventListener("click", () => {
    CairnCoachProposalController.runCoachProposal(
      $<HTMLSelectElement>("#agentsel")?.value || "auto",
      instructionValue()
    );
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

type MealDecisionAction = "hold" | "undo";

async function revertMealDecision(button: HTMLElement, action: MealDecisionAction): Promise<void> {
  const rawId = action === "hold" ? button.dataset.mealDecisionHold : button.dataset.mealDecisionUndo;
  const decisionId = Number(rawId);
  if (!Number.isFinite(decisionId) || decisionId <= 0 || button.dataset.busy === "1") return;
  button.dataset.busy = "1";
  button.setAttribute("aria-busy", "true");
  const holding = action === "hold";
  try {
    const result = await api(`/brain/decisions/${decisionId}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: holding ? "hold on — keep my current meal plan" : "undo from the meal plan" }),
    });
    if (!isCoachMealRecord(result) || result.ok !== true) {
      throw new Error(
        typeof result?.error === "string"
          ? result.error
          : holding
            ? "That meal change can no longer be held."
            : "That meal change can no longer be undone."
      );
    }
    // A later accepted plan intentionally wins over an older rollback. The
    // response confirms that the decision was reverted, but not that its prior
    // plan became current, so keep this confirmation truthful under that race.
    toast(holding ? "Held — your current meals stay" : "Undo recorded — showing your current meals");
    swrInvalidate(MEALS_KEY);
    await renderMeals();
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message
        : holding
          ? "Could not hold that meal change"
          : "Could not undo that meal change"
    );
    button.dataset.busy = "";
    button.removeAttribute("aria-busy");
  }
}

function wireMealDecisionActions(): void {
  view.querySelectorAll<HTMLElement>("[data-meal-decision-hold]").forEach((button) =>
    button.addEventListener("click", () => {
      void revertMealDecision(button, "hold");
    })
  );
  view.querySelectorAll<HTMLElement>("[data-meal-decision-undo]").forEach((button) =>
    button.addEventListener("click", () => {
      void revertMealDecision(button, "undo");
    })
  );
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
  view.innerHTML =
    segBar("food", planSeg()) +
    `<section class="meal-energy food-journal" id="mealEnergy">
      <div id="dayFuelSlot" class="dayfuel-slot">${loadingState("Reading today's food…")}</div>
      <div id="energyCard">${loadingState("Reading your trend…")}</div>
      <div id="energyHero"></div>
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
  let mealPrefs = String(
    peekCached<import("../contracts/client-api.js").ClientSettingsResponse>(MEALS_SETTINGS_KEY)?.data?.settings
      ?.meal_prefs || ""
  );
  cachedApi("/settings", {
    key: MEALS_SETTINGS_KEY,
    onUpgrade: (data) => {
      mealPrefs = String(data.settings?.meal_prefs || "");
    },
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
  const upcoming = Array.isArray(plans)
    ? plans.find((plan) => {
        const row = plan && typeof plan === "object" ? (plan as Record<string, any>) : {};
        return row.status === "draft" && ["announced", "pending"].includes(String(row.autonomy?.status));
      })
    : null;
  const currentPlan =
    current && (typeof current.id === "string" || typeof current.id === "number")
      ? (current as Record<string, unknown> & { id: string | number })
      : null;
  const shopChecked = currentPlan
    ? new Set(JSON.parse(localStorage.getItem(`shop:${currentPlan.id}`) || "[]"))
    : new Set();
  const painted = CairnMealPlan.mealPlannerBodyHtml(current, mealPrefs, {
    checkedShopping: shopChecked,
    verified: currentPlan ? CairnMealPlannerController.verifiedForPlan(currentPlan.id) : null,
    upcoming,
  });
  const body = painted.html;
  const ctx = painted.context;

  view.innerHTML =
    segBar("meals", planSeg()) +
    body +
    `
    <details class="mp-history">
      <summary class="lbl">Past meal plans</summary>
      <div id="mealHist" style="margin-top:10px"></div>
    </details>`;
  wireSeg(PLAN_HANDLERS);
  runCountUps(view);

  CairnMealPlannerController.renderMealPlans(plans, "#mealHist", () => renderMeals());
  CairnMealPlannerController.wireMealPlannerBody(currentPlan, ctx);
  wireMealDecisionActions();
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
  if (peek) {
    paint(peek.data);
    if (!peek.fresh) markRefreshing(true);
  }
  cachedApi("/nutrition/expenditure?window=21", {
    key: "progress:energy",
    onUpgrade: (exp, { changed }) => {
      if (peek && !peek.fresh) markRefreshing(false);
      if (changed || !peek) paint(exp);
    },
  }).catch(() => {
    if (peek && !peek.fresh) markRefreshing(false);
  });
}

Object.assign(globalThis, {
  renderCoach,
  renderFoodJournal,
  renderMeals,
  rerenderFoodSurface,
});

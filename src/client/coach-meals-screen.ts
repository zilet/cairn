// ==== 06-coach-meals.js ====
type CoachAgent = import("../contracts/client-api.js").ClientAgentInfo & { name?: string };
type CoachMealPlan = import("../contracts/client-api.js").ClientMealPlan & {
  id: number | string;
  parsed?: MealParsed;
};
type CoachProposalResult = import("../contracts/client-api.js").ClientProposalResult & {
  clamped?: unknown[];
  plan?: CoachMealPlan;
  verified?: { checked?: unknown } & CoachMealRecord;
};
type CoachMealRecord = Record<string, unknown>;
type BusyElement<T extends Element = HTMLElement> = T & { _busyRestore?: () => void };
type CoachMealPlannerContext = { weekOf?: unknown; targetKcal?: unknown; todayName?: unknown } | null;
type MealParsed = CoachMealRecord & { days?: MealDay[]; daily_kcal?: unknown };
type MealDay = CoachMealRecord & { day?: unknown; meals?: MealRow[] };
type MealRow = CoachMealRecord & {
  name?: unknown;
  meal?: unknown;
  items?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  recipe?: unknown;
};
type MealOpOptions = ClientAgentOpHandlers & {
  path: string;
  anchor: string;
  caption: string;
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => unknown;
  onFail: (error?: unknown) => unknown;
};

function isCoachMealRecord(value: unknown): value is CoachMealRecord {
  return !!value && typeof value === "object";
}

function coachMealRecord(value: unknown): CoachMealRecord {
  return isCoachMealRecord(value) ? value : {};
}

function coachMealRows<T extends CoachMealRecord = CoachMealRecord>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isCoachMealRecord) as T[]) : [];
}

function mealPlanRows(value: unknown): CoachMealPlan[] {
  return coachMealRows<CoachMealPlan>(value);
}

function mealPlanRecord(value: unknown): CoachMealPlan {
  return coachMealRecord(value) as CoachMealPlan;
}

function mealParsed(value: unknown): MealParsed {
  return coachMealRecord(value) as MealParsed;
}

function htmlElement<T extends HTMLElement = HTMLElement>(value: Element | null | undefined): T | null {
  return value instanceof HTMLElement ? value as T : null;
}

function buttonElement(value: Element | null | undefined): HTMLButtonElement | null {
  return value instanceof HTMLButtonElement ? value : null;
}

function restoreBusy(value: Element | null | undefined): void {
  (value as BusyElement | null | undefined)?._busyRestore?.();
}

function agentName(agent: CoachAgent): string {
  return typeof agent.name === "string" && agent.name ? agent.name : "agent";
}

function eventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function mealPlanDays(plan: CoachMealPlan): MealDay[] {
  const parsed = mealParsed(plan.parsed);
  return Array.isArray(parsed.days) ? parsed.days : [];
}

function mealPlanErrorMessage(value: unknown): string | undefined {
  const error = coachMealRecord(value).error;
  return typeof error === "string" ? error : undefined;
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
  $("#runbtn")?.addEventListener("click", runCoach);
  $("#mealbtn")?.addEventListener("click", runMealPlan);
  renderProposals(proposals);
  renderMealPlans(await api("/mealplans?limit=8"));
}

function instructionValue(): string {
  const preset = $<HTMLSelectElement>("#presetsel")?.value || "";
  if (preset === "custom") return $<HTMLTextAreaElement>("#custominstr")?.value.trim() || "";
  return preset;
}

// Draft a plan-update proposal from the Coach sub-view (#runbtn). Runs as a durable
// background job so a long draft survives a reload mid-run, streaming its evolving
// caption + filament into #runstatus; when background ops are off, runOp renders the
// inline result immediately. On done we refresh the proposals list in place.
function runCoach(): void {
  const agent = $<HTMLSelectElement>("#agentsel")?.value || "auto";
  const status = $("#runstatus");
  const btn = $("#runbtn");
  if (btn) btnBusy(btn, "Drafting\u2026");
  if (status) status.innerHTML = CairnUi.jobCaptionHtml();
  runOp("proposal", { agent, instruction: instructionValue() }, coachProposalOpOpts());
}

// Plain-words failure line for a proposal draft \u2014 honest about cause (no agent vs
// agent failed vs unreachable), mirroring mealDraftFailLine.
function proposalDraftFailLine(err: unknown): string {
  if (coachMealRecord(err).agent_status === "unconfigured") return "Drafting a plan needs a coaching agent \u2014 connect one in Settings.";
  if (err) return "The coach replied but didn't return a plan \u2014 try again, or pick another agent in Settings.";
  return "Couldn't reach the coach \u2014 check your connection.";
}

// Shared runOp options for a Coach-view proposal draft \u2014 used by the trigger and the
// reload reconnector so render/fail behavior is identical. A draft always persists as
// a row, so we refresh the proposals list on BOTH paths (the raw row shows even on a
// no-plan reply, exactly as before).
function coachProposalOpOpts(): MealOpOptions {
  return {
    path: "/agent/run",
    anchor: "#runstatus",
    caption: "proposal",
    guard: () => !$("#runstatus")?.isConnected,
    isFail: (r: unknown) => coachMealRecord(r).ok !== true,
    render: async () => {
      const status = $("#runstatus");
      if (status) status.textContent = "Draft ready \u2014 review below.";
      const btn = $("#runbtn");
      restoreBusy(btn);
      try { renderProposals(await api("/proposals?limit=10")); } catch {}
    },
    onFail: async (err?: unknown) => {
      const status = $("#runstatus");
      if (status) status.textContent = proposalDraftFailLine(err);
      const btn = $("#runbtn");
      restoreBusy(btn);
      try { renderProposals(await api("/proposals?limit=10")); } catch {}
    },
  };
}

// Clamp transparency from the most recent apply, keyed by proposal id, so a light
// re-render of the list can still surface the "adjusted to a safe step" note on the
// card that was just applied (the clamp detail isn't persisted on the row).
// Shared proposal render helpers live in /js/proposal-client.js.
const lastApplyClamp: Record<string, unknown[]> = {};

// Apply one proposal by id — the single apply path shared by the Coach list and the
// Plan → Endurance "shape your running" composer. Flips the draft to 'applied'
// server-side (surgical for run prescriptions), remembers any safe-step clamp so the
// re-render can surface the honest note, toasts, and invalidates the stale plan cache.
// Returns the apply response (or null on transport failure). Callers re-render.
async function applyProposalById(id: string | number | undefined, btn?: Element | null): Promise<unknown> {
  if (btn) btnBusy(btn, "Applying…");
  let r: CoachProposalResult | null = null;
  try { r = await api(`/proposals/${id}/apply`, { method: "POST" }); } catch { r = null; }
  // Honest failure: the caller re-renders, so the draft stays actionable.
  const m = applyResultMessage(r);
  if (m.failed) { toast(m.message); return r; }
  if (Array.isArray(r?.clamped) && r.clamped.length) lastApplyClamp[String(id)] = r.clamped;
  toast(m.message);
  state.plan = []; swrInvalidate("plan"); // applied targets — the plan cache is stale
  return r;
}

// Light refresh of just the proposals list — re-fetch + re-render, no skeleton/full
// view rebuild (keeps scroll, and the apply transition reads cleanly).
async function refreshProposals(): Promise<void> {
  try { renderProposals(await api("/proposals?limit=10")); } catch { /* keep last paint */ }
}


function renderProposals(proposals: unknown): void {
  const wrap = $("#proplist");
  if (!wrap) return;
  wrap.innerHTML = CairnProposal.coachProposalListHtml(proposals, lastApplyClamp);

  wrap.querySelectorAll<HTMLElement>("[data-apply]").forEach((b) =>
    b.addEventListener("click", async () => {
      await applyProposalById(b.dataset.apply, b);
      refreshProposals();
    })
  );
  wrap.querySelectorAll<HTMLElement>("[data-discard]").forEach((b) =>
    b.addEventListener("click", async () => {
      try { await api(`/proposals/${b.dataset.discard}/discard`, { method: "POST" }); } catch {}
      refreshProposals();
    })
  );
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
const _verifiedByPlan = new Map<string | number, unknown>();

// One warm status line for a meal-plan draft that didn't land. The runOp onFail arg
// is either the RESULT object (a designed ok:false — carries agent_status) or null
// (a transport drop). When coaching is simply unconfigured, name the honest cause
// and point at Settings; otherwise a calm "try again".
function mealDraftFailLine(err: unknown): string {
  if (coachMealRecord(err).agent_status === "unconfigured") return "Drafting a plan needs a coaching agent — connect one in Settings.";
  if (err) return "The coach replied but didn't return a plan — try again.";
  return "Couldn't reach the coach — check your connection.";
}

function rememberVerified(r: unknown): void {
  const row = coachMealRecord(r) as CoachProposalResult;
  if (row.ok && row.plan && row.plan.id != null && row.verified && row.verified.checked) {
    _verifiedByPlan.set(row.plan.id, row.verified);
  }
}

// Draft a meal plan from the Coach sub-view (#mealbtn). Runs as a durable
// background job so a long draft survives a reload mid-run (streaming its evolving
// caption + determinate filament into #mealstatus); when background ops are off,
// runOp renders the inline result immediately. On done we refresh the meal-plan
// list in place and invalidate the journal SWR key so the journal paints truth.
function runMealPlan(): void {
  const agent = $<HTMLSelectElement>("#agentsel")?.value || "auto";
  const status = $("#mealstatus");
  const btn = $("#mealbtn");
  if (btn) btnBusy(btn, "Drafting\u2026");
  if (status) status.innerHTML = CairnUi.jobCaptionHtml();
  runOp("meal_plan", { agent, instruction: instructionValue() }, coachMealPlanOpOpts());
}

// Shared runOp options for a Coach-view meal-plan draft \u2014 used by the trigger and
// the reload reconnector so render/fail behavior is identical.
function coachMealPlanOpOpts(): MealOpOptions {
  return {
    path: "/coach/mealplan",
    anchor: "#mealstatus",
    caption: "meal_plan",
    guard: () => !$("#mealstatus")?.isConnected,
    isFail: (r: unknown) => {
      const row = coachMealRecord(r);
      return row.ok !== true || !row.plan;
    },
    render: async (r: unknown) => {
      rememberVerified(r);
      const status = $("#mealstatus");
      if (status) status.textContent = "Meal plan ready.";
      const btn = $("#mealbtn");
      restoreBusy(btn);
      swrInvalidate(MEALS_KEY); // the journal's SWR cache is now stale
      try { renderMealPlans(await api("/mealplans?limit=8")); } catch {}
    },
    onFail: (err?: unknown) => {
      const status = $("#mealstatus");
      if (status) status.textContent = mealDraftFailLine(err);
      const btn = $("#mealbtn");
      restoreBusy(btn);
    },
  };
}

// Meal-plan row/list/day render helpers live in /js/meal-plan-client.js.

function renderMealPlans(plans: unknown, sel = "#meallist", refresh: (() => unknown) | null = null): void {
  const wrap = $(sel);
  if (!wrap) return;
  wrap.innerHTML = CairnMealPlan.mealPlanListHtml(plans);

  wrap.querySelectorAll<HTMLElement>("[data-accept]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/mealplans/${b.dataset.accept}/accept`, { method: "POST" });
      toast("Meal plan accepted");
      swrInvalidate(MEALS_KEY); // status flipped to kept — the journal's warm cache is now stale
      if (refresh) refresh(); else renderMealPlans(await api("/mealplans?limit=8"), sel);
    })
  );
  wrap.querySelectorAll<HTMLElement>("[data-discard]").forEach((b) =>
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
// Meal-plan shell/prefs/day render helpers live in /js/meal-plan-client.js.

function wireMealPrefs(): void {
  const card = view.querySelector<HTMLElement>("#mealPrefs");
  if (!card) return;
  const head = card.querySelector<HTMLElement>("#mealPrefsToggle");
  const bodyEl = card.querySelector<HTMLElement>(".mealprefs-body");
  const ta = card.querySelector<HTMLTextAreaElement>("#mealPrefsText");
  if (!head || !bodyEl || !ta) return;
  head.addEventListener("click", () => {
    const open = bodyEl.hidden === true;
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
      if (mealPlanErrorMessage(r)) { toast("Couldn't save preferences"); return false; }
      const v = ta.value.trim();
      const prev = card.querySelector<HTMLElement>(".mealprefs-preview");
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
  card.querySelectorAll<HTMLElement>("[data-pref]").forEach((c) =>
    c.addEventListener("click", () => {
      const t = c.dataset.pref;
      if (!t) return;
      const cur = ta.value.trim();
      if (cur.toLowerCase().includes(t.toLowerCase())) return; // already in there
      ta.value = cur ? cur.replace(/[.;,]\s*$/, "") + ". " + t : t;
      bar.markDirty(); // programmatic insert fires no input event
      ta.focus();
    })
  );
}

// One planner day section lives in /js/meal-plan-client.js so swap/reorder rerenders
// use the same typed source as the initial Meals paint.

// Re-render a single planner day from the in-memory plan (after swap/reorder) —
// regenerates data-* indices, totals, the target bar, and re-runs count-ups.
// settleMi: meal index to flash with the gentle settle highlight.
function rerenderMealDay(current: CoachMealPlan, di: number, ctx: CoachMealPlannerContext, settleMi: number | null = null): void {
  const sec = view.querySelector<HTMLElement>(`.mealday[data-mday="${di}"]`);
  const d = mealPlanDays(current)[di];
  if (!sec || !d) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = CairnMealPlan.mealDayHtml(d, di, ctx || {});
  const fresh = htmlElement(tmp.firstElementChild);
  if (!fresh) return;
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
async function submitMealSwap(current: CoachMealPlan, ctx: CoachMealPlannerContext, di: number, mi: number, panel: HTMLElement): Promise<void> {
  const day = mealPlanDays(current)[di];
  if (!day) return;
  const row = htmlElement(panel.previousElementSibling);
  if (row && row.classList.contains("meal-busy")) { toast("A swap is already running"); return; }
  const hint = panel.querySelector<HTMLInputElement>(".meal-swap-hint")?.value.trim() || "";
  const go = panel.querySelector(".meal-swap-go");
  if (row) { row.classList.add("meal-busy"); row.querySelector(".meal-cap")?.remove(); row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" })); }
  panel.classList.add("meal-swap-busy");
  btnBusy(go, "Asking the coach…", { ghost: true });
  panel.querySelectorAll("button,input").forEach((el) => {
    if (el !== go && (el instanceof HTMLButtonElement || el instanceof HTMLInputElement)) el.disabled = true;
  });

  const body = hint ? { day: day.day, meal_index: mi, hint } : { day: day.day, meal_index: mi };
  await runOp("meal_swap", { id: current.id, ...body }, mealSwapOpOpts(current, ctx, di, mi));
}

// Shared runOp options for a meal swap — used by the trigger and the reload
// reconnector. The anchor is the busy meal row (carrying the .meal-cap caption);
// on done the day re-renders with the new meal settled in place.
function mealSwapOpOpts(current: CoachMealPlan, ctx: CoachMealPlannerContext, di: number, mi: number): MealOpOptions {
  const rowSel = `.mealday[data-mday="${di}"] .meal-row[data-mi="${mi}"]`;
  return {
    path: `/meal-plans/${current.id}/swap`,
    anchor: rowSel,
    caption: "meal_swap",
    guard: () => !view.querySelector(rowSel)?.isConnected,
    isFail: (r: unknown) => {
      const row = coachMealRecord(r);
      const plan = mealPlanRecord(row.plan);
      return row.ok !== true || !(plan.parsed || row.meal);
    },
    render: (r: unknown) => {
      const row = coachMealRecord(r);
      const plan = mealPlanRecord(row.plan);
      if (plan.parsed) current.parsed = mealParsed(plan.parsed); // server copy is the source of truth
      else { const d = mealPlanDays(current)[di]; if (d?.meals) d.meals[mi] = coachMealRecord(row.meal) as MealRow; }
      swrInvalidate(MEALS_KEY); // the journal's cached plan list is now stale
      rerenderMealDay(current, di, ctx, mi);
      toast("Meal swapped");
    },
    onFail: () => {
      const row = view.querySelector<HTMLElement>(rowSel);
      if (row) { row.classList.remove("meal-busy"); row.querySelector(".meal-cap")?.remove(); }
      const panel = htmlElement(row?.nextElementSibling);
      if (panel && panel.classList.contains("meal-swap")) {
        panel.classList.remove("meal-swap-busy");
        panel.querySelectorAll("button,input").forEach((el) => {
          if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = false;
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
function reconnectMealSwap(job?: unknown): ClientAgentOpHandlers | null {
  const input = coachMealRecord(coachMealRecord(job).input);
  const planId = Number(input.id);
  // The journal view keys its rows by day INDEX, but the job carries the day NAME —
  // match it to recover di. We only have the rendered DOM here, so read the plan
  // from the SWR cache (the meals view just painted it).
  const cached = mealPlanRows(peekCached<CoachMealPlan[]>(MEALS_KEY)?.data || []);
  const current = cached.find((p) => Number(p.id) === planId);
  if (!current || !mealPlanDays(current).length) return null; // plan not in view — retry on a later render
  const di = mealPlanDays(current).findIndex(
    (d) => String(d?.day ?? "").trim().toLowerCase() === String(input.day ?? "").trim().toLowerCase()
  );
  const mi = Number(input.meal_index);
  if (di < 0 || !Number.isFinite(mi)) return null;
  const ctx = CairnMealPlan.mealsCtxFor(current);
  const rowSel = `.mealday[data-mday="${di}"] .meal-row[data-mi="${mi}"]`;
  const row = view.querySelector<HTMLElement>(rowSel);
  if (!row) return null; // row not on screen (e.g. a different sub-view) — retry later
  row.classList.add("meal-busy");
  row.querySelector(".meal-cap")?.remove();
  row.insertAdjacentHTML("beforeend", CairnUi.jobCaptionHtml({ className: "meal-cap job-cap" }));
  const o = mealSwapOpOpts(current, ctx, di, mi);
  let stop = () => {};
  const capEl = row.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  if (!reducedMotion()) row.classList.add("is-thinking");
  const clear = () => { stop(); const r = view.querySelector<HTMLElement>(rowSel); if (r) { r.classList.remove("is-thinking", "is-thinking--determinate"); r.style.removeProperty("--frac"); } };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

// Move a meal up/down within its day: optimistic re-render, then persist the full
// days array via PUT /meal-plans/:id/days. Revert + toast on failure.
async function moveMealRow(current: CoachMealPlan, ctx: CoachMealPlannerContext, di: number, mi: number, dir: number): Promise<void> {
  const days = mealPlanDays(current);
  const meals = days[di]?.meals;
  const j = mi + dir;
  if (!meals || mi < 0 || mi >= meals.length || j < 0 || j >= meals.length) return;
  const token = pollToken;
  [meals[mi], meals[j]] = [meals[j], meals[mi]];
  rerenderMealDay(current, di, ctx, j); // optimistic — indices regenerate from the array
  try {
    const r = await api(`/meal-plans/${current.id}/days`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    if (mealPlanErrorMessage(r)) throw new Error(mealPlanErrorMessage(r));
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
function wireMealRows(scope: ParentNode, current: CoachMealPlan, ctx: CoachMealPlannerContext): void {
  // "+ Log it" — write the planned meal into today's food journal as-is.
  scope.querySelectorAll<HTMLElement>("[data-mlog]").forEach((b) =>
    b.addEventListener("click", async () => {
      let x: CoachMealRecord; try { x = coachMealRecord(JSON.parse(b.dataset.mlog || "{}")); } catch { return; }
      const btn = buttonElement(b);
      if (btn) btn.disabled = true;
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
        b.textContent = "✓ Logged"; b.classList.add("meal-log-done");
        toast(`${x.name || "Meal"} logged`);
      } catch { if (btn) btn.disabled = false; toast("Couldn't log meal"); }
    })
  );

  // ⇄ Swap — toggle the inline hint panel under the row
  scope.querySelectorAll<HTMLElement>("[data-mswap]").forEach((b) =>
    b.addEventListener("click", () => {
      const row = htmlElement(b.closest(".meal-row"));
      const panel = htmlElement(row?.nextElementSibling);
      if (!row || !panel || !panel.classList.contains("meal-swap") || row.classList.contains("meal-busy")) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.querySelector<HTMLInputElement>(".meal-swap-hint")?.focus();
    })
  );
  scope.querySelectorAll<HTMLElement>(".meal-swap-cancel").forEach((b) =>
    b.addEventListener("click", () => { const panel = htmlElement(b.closest(".meal-swap")); if (panel) panel.hidden = true; })
  );
  scope.querySelectorAll<HTMLElement>(".hintchip").forEach((c) =>
    c.addEventListener("click", () => {
      const panel = htmlElement(c.closest(".meal-swap"));
      const input = panel?.querySelector<HTMLInputElement>(".meal-swap-hint");
      if (!panel || !input) return;
      const on = c.classList.contains("on");
      panel.querySelectorAll<HTMLElement>(".hintchip").forEach((x) => x.classList.remove("on"));
      c.classList.toggle("on", !on);
      input.value = on ? "" : c.dataset.hint || "";
    })
  );
  scope.querySelectorAll<HTMLInputElement>(".meal-swap-hint").forEach((i) =>
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); i.closest(".meal-swap")?.querySelector<HTMLElement>(".meal-swap-go")?.click(); }
    })
  );
  scope.querySelectorAll<HTMLElement>(".meal-swap-go").forEach((b) =>
    b.addEventListener("click", () => {
      const panel = htmlElement(b.closest(".meal-swap"));
      if (!panel) return;
      submitMealSwap(current, ctx, Number(panel.dataset.di), Number(panel.dataset.mi), panel);
    })
  );

  // ▲▼ — move a meal within its day, persist the whole days array
  scope.querySelectorAll<HTMLElement>(".meal-mv").forEach((b) =>
    b.addEventListener("click", () => {
      const row = htmlElement(b.closest(".meal-row"));
      if (!row || row.classList.contains("meal-busy")) return;
      moveMealRow(current, ctx, Number(row.dataset.di), Number(row.dataset.mi), Number(b.dataset.mv));
    })
  );

  // tap a meal row's body → detail bottom sheet (buttons and the swap panel keep their own taps)
  scope.querySelectorAll<HTMLElement>(".meal-row[data-di]").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (eventElement(e)?.closest("button, input, a, .meal-swap")) return;
      if (row.classList.contains("meal-busy")) return;
      openMealSheet(current, Number(row.dataset.di), Number(row.dataset.mi));
    })
  );
}

// ---------- meal detail bottom sheet (Plan tab · Meals) ----------
// Tapping a planner meal row opens a bottom sheet: hero food art, macros, and an
// agent-written recipe (cached on the plan by the server once fetched). A recipe in
// flight is detected by a .job-cap in the sheet's [data-recipe] (the job IS the lock).

function closeMealSheet(instant = false): void {
  const s = document.querySelector<HTMLElement>(".sheet");
  if (!s) return;
  document.body.classList.remove("sheet-open");
  if (instant || reducedMotion()) { s.remove(); return; }
  s.classList.remove("sheet-in"); // slide down + fade the backdrop, then remove
  setTimeout(() => s.remove(), 360);
}

function openMealSheet(current: CoachMealPlan, di: number, mi: number): void {
  closeMealSheet(true);
  const day = mealPlanDays(current)[di];
  const meal = day?.meals?.[mi];
  if (!meal) return;
  const dayLabel = String(day.day || `Day ${di + 1}`);
  const items = Array.isArray(meal.items) ? meal.items.join(", ") : (meal.items || "");
  const q = `${meal.name || meal.meal || ""} ${items}`.trim(); // EXACTLY the row's art query
  const figs = [["P", meal.protein_g], ["C", meal.carbs_g], ["F", meal.fat_g]]
    .filter(([l, v]) => v != null && v !== "" && (l === "P" || Number(v) > 0))
    .map(([l, v]) => CairnUi.sheetChipHtml({ label: `${l} ${v}g` })).join("");
  const kcal = meal.kcal
    ? CairnUi.sheetChipHtml({ className: "sheet-chip sheet-chip-kcal", value: meal.kcal, label: "cal" })
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
  s.querySelector(".sheet-x")?.addEventListener("click", () => closeMealSheet());
  wireRecipeCta(s, current, dayLabel, di, mi);
}

// Meal recipe CTA/result/loading render helpers live in /js/meal-recipe-client.js.
function recipeCtaHtml(): string {
  return CairnMealRecipe.ctaHtml();
}

function recipeHtml(r: unknown): string {
  return CairnMealRecipe.recipeHtml(r);
}

function recipeLoadingHtml(): string {
  return CairnMealRecipe.loadingHtml();
}

// POST /meal-plans/:id/recipe — runs an external CLI agent (15–120s) as a durable
// background job (runOp). A CACHED recipe comes back inline+instantly (runOp renders
// it with no job); a fresh one streams its caption into the open sheet and survives a
// reload mid-run. Closing the sheet mid-flight is fine — the result still stores into
// the in-memory plan (server-side) and the DOM is only touched if the sheet survives.
function wireRecipeCta(sheet: HTMLElement, current: CoachMealPlan, dayLabel: string, di: number, mi: number): void {
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
function recipeOpOpts(current: CoachMealPlan, dayLabel: string, di: number, mi: number, key: string | undefined): MealOpOptions {
  const wrapSel = `.sheet[data-key="${key}"] [data-recipe]`; // key is numeric (id:di:mi)
  return {
    path: `/meal-plans/${current.id}/recipe`,
    anchor: wrapSel,
    caption: "recipe",
    guard: () => !document.querySelector(wrapSel)?.isConnected, // sheet closed — keep the job alive
    isFail: (r: unknown) => {
      const row = coachMealRecord(r);
      return row.ok !== true || !row.recipe;
    },
    render: (r: unknown) => {
      const row = coachMealRecord(r);
      const plan = mealPlanRecord(row.plan);
      // store into the in-memory plan first so it survives rerenders & reopen
      if (plan.parsed) current.parsed = mealParsed(plan.parsed);
      else {
        const m = mealPlanDays(current)[di]?.meals?.[mi];
        if (m) m.recipe = row.recipe;
      }
      if (!row.cached) swrInvalidate(MEALS_KEY); // a freshly written recipe changed the plan
      const live = document.querySelector(wrapSel);
      if (live) {
        live.innerHTML = recipeHtml(row.recipe);
        live.classList.add("meal-settled"); // gentle sage settle flash
      }
    },
    onFail: () => {
      const wrap = document.querySelector(wrapSel);
      if (wrap) {
        const liveSheet = wrap.closest(".sheet");
        wrap.innerHTML = recipeCtaHtml();
        if (liveSheet instanceof HTMLElement) wireRecipeCta(liveSheet, current, dayLabel, di, mi);
      }
      toast("Coach couldn't write the recipe — try again");
    },
  };
}

// Reconnector: after a reload mid-recipe, find the open sheet by its data-key and
// re-mount the loading state so a recipe that finished while away settles in. The
// plan is read from the SWR cache; null when no matching open sheet (job stays alive).
function reconnectRecipe(job?: unknown): ClientAgentOpHandlers | null {
  const input = coachMealRecord(coachMealRecord(job).input);
  const planId = Number(input.id);
  const dayLabel = String(input.day ?? "");
  const mi = Number(input.meal_index);
  const cached = mealPlanRows(peekCached<CoachMealPlan[]>(MEALS_KEY)?.data || []);
  const current = cached.find((p) => Number(p.id) === planId);
  if (!current || !mealPlanDays(current).length) return null;
  const di = mealPlanDays(current).findIndex(
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
  const host = document.querySelector<HTMLElement>(o.anchor);
  if (host && !reducedMotion()) host.classList.add("is-thinking");
  const clear = () => { stop(); const h = document.querySelector<HTMLElement>(o.anchor); if (h) { h.classList.remove("is-thinking", "is-thinking--determinate"); h.style.removeProperty("--frac"); } };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

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
  loadDayFuel(token);
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
  if (currentPlan) { wireMealRows(view, currentPlan, ctx); loadMealProvenance(); }

  // shopping chips check off (persisted per plan, local-only)
  if (currentPlan) view.querySelectorAll<HTMLElement>("[data-shop]").forEach((c) =>
    c.addEventListener("click", () => {
      c.classList.toggle("chip-done");
      const done = [...view.querySelectorAll<HTMLElement>("[data-shop].chip-done")].map((el) => Number(el.dataset.shop));
      localStorage.setItem(`shop:${currentPlan.id}`, JSON.stringify(done));
    })
  );

  const keep = view.querySelector<HTMLElement>("[data-mkeep]");
  if (keep) keep.addEventListener("click", async () => {
    await api(`/mealplans/${keep.dataset.mkeep}/accept`, { method: "POST" });
    toast("Meal plan kept"); renderMeals();
  });
  const disc = view.querySelector<HTMLElement>("[data-mdiscard]");
  if (disc) disc.addEventListener("click", async () => {
    await api(`/mealplans/${disc.dataset.mdiscard}/discard`, { method: "POST" });
    toast("Discarded"); renderMeals();
  });

  const draftBtn = view.querySelector("#mealDraftBtn");
  if (draftBtn) draftBtn.addEventListener("click", () => draftWeeklyMeals());
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

// ---------- Today's fuel: review + quick-edit of what's logged today ----------
// A calm list of today's logged food with the running totals and, ONLY when a real
// target exists, a gentle "remaining" ("remaining", never "consumed"; never red).
// Each row taps open to correct a macro / rename / change the meal slot, or delete.
// Capture stays in Chat — this is review + correction, never a logging form.
// The renderer and MEAL_LABEL constant live in /js/day-fuel-client.js.

async function loadDayFuel(token: number): Promise<void> {
  const slot = view.querySelector("#dayFuelSlot");
  if (!slot) return;
  let d: unknown = null;
  const qs = state.logDate ? `?date=${encodeURIComponent(state.logDate)}` : "";
  try { d = await api("/nutrition/day" + qs); } catch { slot.innerHTML = ""; return; }
  if (token !== pollToken || !view.querySelector("#dayFuelSlot")) return;
  if (!d || typeof d !== "object") { slot.innerHTML = ""; return; }
  const day = d as import("../contracts/client.js").ClientDayIntake;
  state._dayFuel = day;
  slot.innerHTML = dayFuelHtml(day as unknown as Record<string, unknown>);
  runCountUps(slot);
  slot.querySelectorAll<HTMLElement>("[data-fooditem]").forEach((row) =>
    row.addEventListener("click", () => openFoodEdit(Number(row.dataset.fooditem), row))
  );
  const ask = slot.querySelector("#dayFuelAsk");
  if (ask) ask.addEventListener("click", () => gotoChatWith("How's my eating shaping up today, and does it fit my goal?"));
}

// Correct one logged food note — fix a macro, rename it, change the meal slot, or
// remove it. Reuses the shared detail-sheet (openDetailFrom/mountDetail) + armDelete
// + numOrNull from the session-edit flow, so the affordance feels native. The PUT
// stamps the note's enrichment terminal server-side, so the correction sticks.
function openFoodEdit(id: number, fromEl: Element): void {
  const d = state._dayFuel;
  const e = d && Array.isArray(d.entries) ? d.entries.find((x) => x.id === id) : null;
  if (!e) return;
  openDetailFrom(fromEl, () => {
    const el = mountDetail(`
      <h2 class="detail-title">Edit this meal</h2>
      <div class="detail-ctx lbl">correct what was logged · macros are rough — fix anything off</div>
      <div class="field"><label>Description</label>
        <input id="fedSummary" type="text" value="${escAttr(e.summary || "")}" maxlength="200"></div>
      <div class="field"><label>Meal</label>
        <select id="fedMeal">${["breakfast", "lunch", "dinner", "snack", "meal"].map((m) => `<option value="${m}" ${String(e.meal || "").toLowerCase() === m ? "selected" : ""}>${MEAL_LABEL[m]}</option>`).join("")}</select></div>
      <div class="fed-macros">
        <div class="field"><label>kcal</label><input id="fedKcal" type="number" inputmode="numeric" value="${e.kcal ?? ""}"></div>
        <div class="field"><label>protein (g)</label><input id="fedProtein" type="number" inputmode="numeric" value="${e.protein_g ?? ""}"></div>
        <div class="field"><label>carbs (g)</label><input id="fedCarbs" type="number" inputmode="numeric" value="${e.carbs_g ?? ""}"></div>
        <div class="field"><label>fat (g)</label><input id="fedFat" type="number" inputmode="numeric" value="${e.fat_g ?? ""}"></div>
      </div>
      <div class="detail-actions">
        <button class="pillbtn pill-accent" id="fedSave">Save</button>
        <button class="pillbtn" data-close>Close</button>
        <button class="pillbtn" id="fedDel">Delete</button>
      </div>`);
    wireDetailCommon();
    el.querySelector("#fedSave")?.addEventListener("click", async () => {
      const summary = el.querySelector<HTMLInputElement>("#fedSummary");
      const meal = el.querySelector<HTMLSelectElement>("#fedMeal");
      const kcal = el.querySelector<HTMLInputElement>("#fedKcal");
      const protein = el.querySelector<HTMLInputElement>("#fedProtein");
      const carbs = el.querySelector<HTMLInputElement>("#fedCarbs");
      const fat = el.querySelector<HTMLInputElement>("#fedFat");
      const body = {
        summary: summary?.value.trim() || "",
        meal: meal?.value || "meal",
        kcal: numOrNull(kcal?.value),
        protein_g: numOrNull(protein?.value),
        carbs_g: numOrNull(carbs?.value),
        fat_g: numOrNull(fat?.value),
      };
      try { await api(`/food-notes/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); toast("Updated"); }
      catch { toast("Couldn't save"); return; }
      swrInvalidate("progress:energy"); // intake changed — Energy Balance reads it
      closeDetail(true);
      rerenderFoodSurface();
    });
    const del = el.querySelector("#fedDel");
    if (del) del.addEventListener("click", () => armDelete(del, async () => {
      try { await api(`/food-notes/${id}`, { method: "DELETE" }); toast("Removed"); }
      catch { toast("Couldn't remove"); return; }
      swrInvalidate("progress:energy");
      closeDetail(true);
      rerenderFoodSurface();
    }));
  });
}

// Draft a fresh weekly meal plan from the journal view. Runs as a durable
// background job (runOp) so the draft survives a reload mid-run and streams its
// evolving "thinking" caption + determinate filament into #mealDraftStatus; when
// background ops are off, runOp renders the inline result immediately. On done we
// invalidate the SWR key and re-render so the fresh plan paints from truth.
function draftWeeklyMeals(): void {
  const draftBtn = view.querySelector("#mealDraftBtn");
  const status = view.querySelector("#mealDraftStatus");
  if (!status) return;
  if (draftBtn) btnBusy(draftBtn, "Drafting…", { ghost: true });
  // The status line carries the .job-cap caption slot; a running draft re-attaches
  // after a reload via its registered reconnector.
  status.innerHTML = CairnUi.jobCaptionHtml();
  runOp("meal_plan", { agent: "auto" }, mealPlanDraftOpOpts());
}

// Shared runOp options for a journal-view meal-plan draft — used by the trigger
// and the reload reconnector so render/fail behavior is identical.
function mealPlanDraftOpOpts(): MealOpOptions {
  return {
    path: "/coach/mealplan",
    anchor: "#mealDraftStatus",
    caption: "meal_plan",
    guard: () => !view.querySelector("#mealDraftStatus")?.isConnected,
    isFail: (r: unknown) => {
      const row = coachMealRecord(r);
      return row.ok !== true || !row.plan;
    },
    render: (r: unknown) => {
      rememberVerified(r);
      toast("Meal plan drafted");
      swrInvalidate(MEALS_KEY);
      renderMeals();
    },
    onFail: (err?: unknown) => {
      const s = view.querySelector("#mealDraftStatus");
      if (s) s.textContent = mealDraftFailLine(err);
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
function reconnectStatusHost(o: MealOpOptions, statusSel: string, btnSel: string | null, ghost: boolean): ClientAgentOpHandlers | null {
  const status = view.querySelector<HTMLElement>(statusSel);
  if (!status) return null; // host not mounted — a later render retries
  const btn = btnSel ? view.querySelector(btnSel) : null;
  if (btn) btnBusy(btn, "Drafting…", { ghost });
  status.innerHTML = CairnUi.jobCaptionHtml();
  let stop = () => {};
  const capEl = status.querySelector(".job-cap");
  if (capEl) stop = thinkingCaption(capEl, o.caption);
  if (!reducedMotion()) status.classList.add("is-thinking");
  const clear = () => { stop(); const s = view.querySelector<HTMLElement>(statusSel); if (s) { s.classList.remove("is-thinking", "is-thinking--determinate"); s.style.removeProperty("--frac"); } };
  return {
    guard: o.guard,
    onDone: (result) => { clear(); if (o.isFail(result)) o.onFail(result); else o.render(result); },
    onError: () => { clear(); o.onFail(null); },
    onCanceled: () => { clear(); o.onFail(null); },
  };
}

// The single registered reconnector for `meal_plan` jobs: prefer the journal host
// (#mealDraftStatus), else the Coach host (#mealstatus); null when neither is up.
function reconnectMealPlan(): ClientAgentOpHandlers | null {
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
function reconnectProposal(): ClientAgentOpHandlers | null {
  if (view.querySelector("#endDraftStatus")) {
    enduranceComposerLock(); // re-lock chips + the in-flight flag, not just the button
    return reconnectStatusHost(enduranceProposalOpOpts() as MealOpOptions, "#endDraftStatus", "#endDraftBtn", false);
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

// @ts-check
// Pure meal-plan render/model helpers for Plan -> Meals and Coach meal-plan history.

type MealRecord = Record<string, unknown>;

type MealPlannerContext = {
  weekOf: string;
  targetKcal: number;
  todayName: string;
};

type MealPlannerOptions = {
  checkedShopping?: unknown;
  verified?: unknown;
  now?: unknown;
};

type MealPlannerPaint = {
  html: string;
  context: MealPlannerContext | null;
};

(() => {
  const mealRows = CairnMealRows;
  const MEAL_HINT_CHIPS = mealRows.MEAL_HINT_CHIPS;
  const MEAL_PREFS_PLACEHOLDER = "e.g. fasted morning training, simple prep on busy days";
  const MEAL_PREF_CHIPS = ["Fasted AM training", "Train before lunch some days", "Simple prep, busy weekdays", "More fish, less red meat"];
  const KEPT_MEAL_PLAN_STATUSES = ["accepted", "applied", "kept"];
  const mealRecord: (value: unknown) => MealRecord = mealRows.record;
  const mealSlotFor = mealRows.mealSlotFor;
  const mealsCtxFor: (plan: unknown, now?: unknown) => MealPlannerContext = mealRows.mealsCtxFor;
  const mealRowHtml = mealRows.mealRowHtml;
  const mealDayHtml = mealRows.mealDayHtml;

  function currentMealPlan(plans: unknown): MealRecord | null {
    const rows = Array.isArray(plans) ? plans.map((plan) => mealRecord(plan)) : [];
    return rows.find((plan) => KEPT_MEAL_PLAN_STATUSES.includes(String(plan.status)) && plan.parsed) ||
      rows.find((plan) => plan.status === "draft" && plan.parsed) ||
      null;
  }

  function mealPlanCardHtml(plan: unknown, index: number): string {
    const p = mealRecord(plan);
    const parsed = mealRecord(p.parsed);
    let hero: string;
    let body: string;
    if (p.parsed) {
      hero = `<div class="mp-hero">
          <div class="mp-hero-head">
            <span class="lbl">${escHtml(p.agent)} · #${escHtml(p.id)}</span>
            ${statusBadge(p.status)}
          </div>
          <div class="mp-hero-nums">
            <div class="mp-hero-kcal">
              <span class="numeral numeral-xl">${escHtml(String(parsed.daily_kcal ?? "?"))}</span>
              <span class="lbl">kcal per day</span>
            </div>
            <div class="mp-hero-protein">
              <span class="numeral numeral-lg">${escHtml(String(parsed.daily_protein_g ?? "?"))}g</span>
              <span class="lbl">protein</span>
            </div>
          </div>
          ${parsed.summary ? `<div class="sess-line">${escHtml(parsed.summary)}</div>` : ""}
        </div>`;
      const dayDetail = Array.isArray(parsed.days) ? parsed.days.map((day) => {
        const d = mealRecord(day);
        const meals = (Array.isArray(d.meals) ? d.meals : []).map((m) => mealRowHtml(m)).join("");
        return `<div class="mp-day"><div class="mp-dayname">${escHtml(d.day || "")}</div>${meals || `<div class="sess-line" style="color:var(--muted)">No meals</div>`}</div>`;
      }).join("") : "";
      body = dayDetail + (parsed.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(parsed.notes)}</div>` : "");
    } else {
      hero = `<div class="mp-hero">
          <div class="mp-hero-head">
            <span class="lbl">${escHtml(p.agent)} · #${escHtml(p.id)}</span>
            ${statusBadge(p.status)}
          </div>
        </div>`;
      body = `<div class="sess-line" style="color:var(--warn)">Unparseable output</div>`;
    }
    const actions = p.status === "draft"
      ? `<div class="logrow" style="margin-top:10px"><button class="logbtn" style="width:auto;padding:0 14px;font-size:.85rem" data-accept="${escAttr(p.id)}">ACCEPT</button>
         <button class="ghostbtn" style="width:auto;padding:0 14px" data-discard="${escAttr(p.id)}">DISCARD</button></div>`
      : "";
    return `<div class="mp-card reveal${p.status === "superseded" ? " mp-card-faded" : ""}" style="${stagger(index)}">
      ${hero}${body}${actions}</div>`;
  }

  function mealPlanListHtml(plans: unknown): string {
    const rows = Array.isArray(plans) ? plans : [];
    if (!rows.length) return `<div class="empty">No meal plans yet. Draft one above and a week of meals built around your training lands here.</div>`;
    const drafts = rows.filter((plan) => mealRecord(plan).status === "draft");
    const settled = rows.filter((plan) => mealRecord(plan).status !== "draft");
    const shown = [...drafts, ...settled.slice(0, 1)];
    const earlier = settled.slice(1);
    return shown.map((plan, index) => mealPlanCardHtml(plan, index)).join("") +
      (earlier.length
        ? `<details class="hist-fold"><summary>Show earlier meal plans (${earlier.length})</summary>
           <div class="hist-fold-body">${earlier.map((plan, index) => mealPlanCardHtml(plan, index)).join("")}</div></details>`
      : "");
  }

  function mealPrefsHtml(prefs: unknown, index: number): string {
    const saved = String(prefs || "");
    return `<div class="mealprefs reveal" style="${stagger(index)}" id="mealPrefs">
      <button type="button" class="mealprefs-head" id="mealPrefsToggle" aria-expanded="false">
        <span class="lbl">Planning preferences<span class="mealprefs-caret">▾</span></span>
        <span class="mealprefs-preview${saved ? "" : " mealprefs-placeholder"}">${escHtml(saved || MEAL_PREFS_PLACEHOLDER)}</span>
      </button>
      <div class="mealprefs-body" hidden>
        <textarea id="mealPrefsText" rows="3" placeholder="${escAttr(MEAL_PREFS_PLACEHOLDER)}">${escHtml(saved)}</textarea>
        <div class="mealprefs-chips">${MEAL_PREF_CHIPS.map((chip) =>
          `<button type="button" class="chip prefchip" data-pref="${escAttr(chip)}">${escHtml(chip)}</button>`).join("")}</div>
      </div>
    </div>`;
  }

  function mealPlanEmptyHtml(mealPrefs: unknown): string {
    return `<div class="meals-empty reveal" style="${stagger(0)}">
        <div class="artile artile-xl meals-empty-art">${art("food", "meal plate")}</div>
        <div class="meals-empty-title">No meal plan yet</div>
        <div class="meals-empty-sub">Ask the coach to draft a week of meals built around your training and lean-safe targets.</div>
        <button id="mealDraftBtn" class="logbtn meals-cta">DRAFT WEEKLY MEAL PLAN</button>
        <div id="mealDraftStatus" class="meals-status"></div>
      </div>${mealPrefsHtml(mealPrefs, 1)}`;
  }

  function mealPlanHeroHtml(plan: unknown, verified?: unknown): string {
    const p = mealRecord(plan);
    const parsed = mealRecord(p.parsed);
    const ctx = mealsCtxFor(p);
    const isDraft = p.status === "draft";
    const actions = isDraft
      ? `<div class="meals-actions">
           <button class="pillbtn pill-accent" data-mkeep="${escAttr(p.id)}">Keep this plan</button>
           <button class="pillbtn" data-mdiscard="${escAttr(p.id)}">Discard</button>
         </div>`
      : "";
    return `<div class="mealhero reveal" style="${stagger(0)}">
        <div class="mp-hero-head">
          <span class="lbl">Week of ${escHtml(ctx.weekOf)} · ${escHtml(p.agent || "")}</span>
          ${statusBadge(p.status)}
        </div>
        <div class="mp-hero-nums">
          <div><span class="numeral numeral-xl" data-cu="${Number(parsed.daily_kcal) || 0}">0</span><span class="lbl" style="display:block;margin-top:3px">kcal per day</span></div>
          <div><span class="numeral numeral-lg" data-cu="${Number(parsed.daily_protein_g) || 0}">0</span><span class="lbl" style="display:block;margin-top:3px">g protein</span></div>
        </div>
        ${parsed.summary ? `<div class="sess-line">${escHtml(parsed.summary)}</div>` : ""}
        ${isDraft ? verifiedBadgeHtml(verified) : ""}
        <div id="mealProvenance" class="prov-slot"></div>
        ${actions}
      </div>`;
  }

  function checkedIndexSet(value: unknown): Set<number> {
    const rows = value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : [];
    return new Set(rows.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry)));
  }

  function mealShoppingHtml(shopping: unknown, checkedShopping: unknown, revealIndex: number): string {
    const rows = Array.isArray(shopping) ? shopping : [];
    if (!rows.length) return "";
    const checked = checkedIndexSet(checkedShopping);
    return `<div class="detail-section reveal" style="${stagger(revealIndex)}"><div class="lbl">Shopping</div>
          <div class="shop-chips">${rows.map((item, index) =>
            `<button class="chip shop-chip${checked.has(index) ? " chip-done" : ""}" data-shop="${index}">${escHtml(String(item))}</button>`).join("")}</div></div>`;
  }

  function mealPlannerBodyHtml(current: unknown, mealPrefs: unknown, options: MealPlannerOptions = {}): MealPlannerPaint {
    const p = mealRecord(current);
    if (!p.parsed) return { html: mealPlanEmptyHtml(mealPrefs), context: null };
    const parsed = mealRecord(p.parsed);
    const days = Array.isArray(parsed.days) ? parsed.days : [];
    const ctx = mealsCtxFor(p, options.now);
    const dayHtml = days.map((day, index) => mealDayHtml(day, index, ctx)).join("");
    const shopping = mealShoppingHtml(parsed.shopping, options.checkedShopping, days.length + 2);
    const notes = parsed.notes
      ? `<div class="sess-line reveal" style="color:var(--muted);${stagger(days.length + 3)}">${escHtml(parsed.notes)}</div>`
      : "";
    return {
      context: ctx,
      html: `${mealPlanHeroHtml(p, options.verified)}
      ${mealPrefsHtml(mealPrefs, 1)}
      ${dayHtml}
      ${shopping}
      ${notes}
      <div class="meals-redraft">
        <button id="mealDraftBtn" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Draft a new weekly plan</button>
        <div id="mealDraftStatus" class="meals-status"></div>
      </div>`,
    };
  }

  const CAIRN_MEAL_PLAN = {
    MEAL_HINT_CHIPS,
    MEAL_PREFS_PLACEHOLDER,
    MEAL_PREF_CHIPS,
    mealSlotFor,
    currentMealPlan,
    mealsCtxFor,
    mealRowHtml,
    mealPlanCardHtml,
    mealPlanListHtml,
    mealPrefsHtml,
    mealPlanEmptyHtml,
    mealPlanHeroHtml,
    mealShoppingHtml,
    mealPlannerBodyHtml,
    mealDayHtml,
  };

  Object.assign(globalThis, { CairnMealPlan: CAIRN_MEAL_PLAN, mealSlotFor, mealRowHtml, mealDayHtml });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnMealPlan: CAIRN_MEAL_PLAN, mealSlotFor, mealRowHtml, mealDayHtml });
  }
})();

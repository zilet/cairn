// @ts-check
// Meal-plan renderers: the week menu (/app/today/menu) and the past weeks kept in its
// history fold. Ideas on request, never what was eaten.

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
  upcoming?: unknown;
};

type MealPlannerPaint = {
  html: string;
  context: MealPlannerContext | null;
};

(() => {
  const mealRows = CairnMealRows;
  const MEAL_HINT_CHIPS = mealRows.MEAL_HINT_CHIPS;
  const MEAL_PREFS_PLACEHOLDER = "e.g. fasted morning training, simple prep on busy days";
  const MEAL_PREF_CHIPS = [
    "Fasted AM training",
    "Train before lunch some days",
    "Simple prep, busy weekdays",
    "More fish, less red meat",
  ];
  const KEPT_MEAL_PLAN_STATUSES = ["accepted", "applied", "kept"];
  const mealRecord: (value: unknown) => MealRecord = mealRows.record;
  const mealSlotFor = mealRows.mealSlotFor;
  const mealsCtxFor: (plan: unknown, now?: unknown) => MealPlannerContext = mealRows.mealsCtxFor;
  const mealRowHtml = mealRows.mealRowHtml;
  const mealDayHtml = mealRows.mealDayHtml;

  // Mirror the server's canonical-current adequacy rule so a legacy partial row
  // returned for history can never become the planner's fallback current week.
  // The authoritative write gate remains server-side; this is presentation defense.
  function mealPlanIsAdequate(plan: MealRecord): boolean {
    const parsed = mealRecord(plan.parsed);
    const days = Array.isArray(parsed.days) ? parsed.days.map((day) => mealRecord(day)) : [];
    const targetKcal = Number(parsed.daily_kcal);
    const targetProtein = Number(parsed.daily_protein_g);
    if (
      days.length < 5 ||
      days.length > 7 ||
      !Number.isFinite(targetKcal) ||
      targetKcal <= 0 ||
      !Number.isFinite(targetProtein) ||
      targetProtein <= 0
    )
      return false;
    const kcalTolerance = Math.max(100, Math.round(targetKcal * 0.1));
    const proteinTolerance = Math.max(10, Math.round(targetProtein * 0.1));
    return days.every((day) => {
      const meals = Array.isArray(day.meals) ? day.meals.map((meal) => mealRecord(meal)) : [];
      const kcal = Math.round(meals.reduce((sum, meal) => sum + (Number(meal.kcal) || 0), 0));
      const protein = Math.round(meals.reduce((sum, meal) => sum + (Number(meal.protein_g) || 0), 0));
      return Math.abs(kcal - targetKcal) <= kcalTolerance && Math.abs(protein - targetProtein) <= proteinTolerance;
    });
  }

  function currentMealPlan(plans: unknown): MealRecord | null {
    const rows = Array.isArray(plans) ? plans.map((plan) => mealRecord(plan)) : [];
    return (
      rows.find(
        (plan) => KEPT_MEAL_PLAN_STATUSES.includes(String(plan.status)) && plan.parsed && mealPlanIsAdequate(plan)
      ) ||
      rows.find((plan) => plan.status === "draft" && plan.parsed && mealPlanIsAdequate(plan)) ||
      null
    );
  }

  function constraintState(plan: unknown): MealRecord {
    const p = mealRecord(plan);
    const parsed = mealRecord(p.parsed);
    return mealRecord(p.constraint_state || parsed.constraint_state);
  }

  // A week whose saved allergy/dietary constraints changed under it is kept, but none
  // of its meals or shopping read as current until the team drafts a fresh one.
  function needsRefresh(plan: unknown): boolean {
    return constraintState(plan).status === "refresh_needed";
  }

  function mealPlanConstraintNoticeHtml(plan: unknown): string {
    const state = constraintState(plan);
    if (state.status !== "refresh_needed") return "";
    const conflicts = Array.isArray(state.conflicts) ? state.conflicts.map((entry) => mealRecord(entry)) : [];
    const detail = conflicts[0]?.detail ? ` ${String(conflicts[0].detail)}` : "";
    return `<div class="plan-upcoming reveal" role="status">
      <span class="lbl plan-upcoming-mast">MEALS NEED A REFRESH</span>
      <p class="sess-line mp-flush">Your saved allergy or dietary constraints changed.${escHtml(detail)} This week is kept in history, but Cairn will not treat its meals or shopping list as current.</p>
    </div>`;
  }

  function mealPlanUpdateIsRecent(autonomy: MealRecord, now?: unknown): boolean {
    const stamp = String(autonomy.applied_at || autonomy.effective_date || "");
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
    if (!match) return true;
    const reference = now instanceof Date ? now : new Date();
    const appliedDay = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const ageDays = (reference.getTime() - appliedDay.getTime()) / 86_400_000;
    return Number.isFinite(ageDays) && ageDays >= -1 && ageDays <= 3;
  }

  function appliedMealPlanUpdateHtml(plan: unknown, now?: unknown): string {
    const p = mealRecord(plan);
    const autonomy = mealRecord(p.autonomy);
    if (
      !KEPT_MEAL_PLAN_STATUSES.includes(String(p.status)) ||
      autonomy.status !== "applied" ||
      autonomy.id == null ||
      !mealPlanUpdateIsRecent(autonomy, now)
    )
      return "";
    const summary = String(autonomy.summary || "Your team updated this plan from the latest signals.");
    const rationale = String(
      autonomy.rationale ||
        autonomy.reason ||
        (Array.isArray(autonomy.reasons) ? autonomy.reasons.filter(Boolean).join(" ") : "")
    );
    return `<div class="sess-line mp-note">
      <span class="lbl">RECENTLY UPDATED</span> · ${escHtml(summary)}
      ${rationale ? `<details class="hist-fold mp-why"><summary>Why</summary><span>${escHtml(rationale)}</span></details>` : ""}
      ${autonomy.reversible === false ? "" : CairnDecisionUndo.buttonHtml({ id: autonomy.id, attr: "meal-decision-undo" })}
    </div>`;
  }

  function mealPlanCardHtml(plan: unknown, index: number): string {
    const p = mealRecord(plan);
    const parsed = mealRecord(p.parsed);
    const autonomy = scheduledMealPlan(p);
    const visibleStatus = autonomy ? "coming" : p.status === "draft" ? "review" : p.status;
    let hero: string;
    let body: string;
    if (p.parsed) {
      hero = `<div class="mp-hero">
          <div class="mp-hero-head">
            <span class="lbl">${escHtml(mealRows.planWeekLabel(p))}</span>
            ${mealRows.planBadge(visibleStatus)}
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
      const dayDetail = Array.isArray(parsed.days)
        ? parsed.days
            .map((day) => {
              const d = mealRecord(day);
              const meals = (Array.isArray(d.meals) ? d.meals : []).map((m) => mealRowHtml(m)).join("");
              return `<div class="mp-day"><div class="mp-dayname">${escHtml(d.day || "")}</div>${meals || `<div class="sess-line mp-muted">No meals</div>`}</div>`;
            })
            .join("")
        : "";
      body = dayDetail + (parsed.notes ? `<div class="sess-line mp-muted">${escHtml(parsed.notes)}</div>` : "");
    } else {
      hero = `<div class="mp-hero">
          <div class="mp-hero-head">
            <span class="lbl">${escHtml(mealRows.planWeekLabel(p))}</span>
            ${mealRows.planBadge(visibleStatus)}
          </div>
        </div>`;
      body = `<div class="sess-line mp-muted">This week couldn't be read.</div>`;
    }
    const actions =
      p.status === "draft" && !autonomy
        ? `<div class="sess-line mp-note">${mealRows.IDEAS_ASK}</div>
         <div class="meals-actions">
           <button class="pillbtn pill-accent" data-accept="${escAttr(p.id)}">Keep these ideas</button>
           <button class="pillbtn" data-discard="${escAttr(p.id)}">Discard</button>
         </div>`
        : autonomy
          ? `<div class="sess-line mp-note">Becomes current ${escHtml(mealBoundaryLabel(autonomy.effective_date))} · automatic and reversible</div>`
          : "";
    return `<div class="mp-card reveal${p.status === "superseded" ? " mp-card-faded" : ""}" style="${stagger(index)}">
      ${hero}${body}${actions}</div>`;
  }

  function mealPlanListHtml(plans: unknown): string {
    const rows = Array.isArray(plans) ? plans : [];
    if (!rows.length)
      return CairnUi.emptyStateHtml({ title: "No meal plans yet", body: "Weeks of ideas you ask for are kept here." });
    const drafts = rows.filter((plan) => mealRecord(plan).status === "draft");
    const settled = rows.filter((plan) => mealRecord(plan).status !== "draft");
    const shown = [...drafts, ...settled.slice(0, 1)];
    const earlier = settled.slice(1);
    return (
      shown.map((plan, index) => mealPlanCardHtml(plan, index)).join("") +
      (earlier.length
        ? `<details class="hist-fold"><summary>Show earlier meal plans (${earlier.length})</summary>
           <div class="hist-fold-body">${earlier.map((plan, index) => mealPlanCardHtml(plan, index)).join("")}</div></details>`
        : "")
    );
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
        <div class="mealprefs-chips">${MEAL_PREF_CHIPS.map(
          (chip) => `<button type="button" class="chip prefchip" data-pref="${escAttr(chip)}">${escHtml(chip)}</button>`
        ).join("")}</div>
      </div>
    </div>`;
  }

  function mealPlanEmptyHtml(mealPrefs: unknown): string {
    return `<div class="meals-empty reveal" style="${stagger(0)}">
        <div class="artile artile-xl meals-empty-art">${art("food", "meal plate")}</div>
        <div class="meals-empty-title">No menu this week yet</div>
        <div class="meals-empty-sub">The team can sketch a week of meals around your training and what you like to eat. Ideas to look over, never a rule.</div>
        <button id="mealDraftBtn" class="pillbtn pill-accent" type="button">Ask the team for a week of meals</button>
        <div id="mealDraftStatus" class="meals-status"></div>
      </div>${mealPrefsHtml(mealPrefs, 1)}`;
  }

  function mealPlanHeroHtml(plan: unknown, verified?: unknown, now?: unknown): string {
    const p = mealRecord(plan);
    const parsed = mealRecord(p.parsed);
    const ctx = mealsCtxFor(p);
    const isDraft = p.status === "draft";
    const autonomy = scheduledMealPlan(p);
    const needsRefresh = constraintState(p).status === "refresh_needed";
    const visibleStatus = autonomy ? "coming" : isDraft ? "review" : p.status;
    const actions =
      isDraft && !autonomy && needsRefresh
        ? `<div class="sess-line mp-note"><span class="lbl">REFRESH REQUIRED</span> · This draft cannot become current until it is rebuilt against your saved constraints.</div>
         <div class="meals-actions">
           <button class="pillbtn" data-mdiscard="${escAttr(p.id)}">Discard</button>
         </div>`
        : isDraft && !autonomy
          ? `<div class="sess-line mp-note">${mealRows.IDEAS_ASK}</div>
         <div class="meals-actions">
           <button class="pillbtn pill-accent" data-mkeep="${escAttr(p.id)}">Keep these ideas</button>
           <button class="pillbtn" data-mdiscard="${escAttr(p.id)}">Discard</button>
         </div>`
          : autonomy
            ? `<div class="sess-line mp-note">Becomes current ${escHtml(mealBoundaryLabel(autonomy.effective_date))} · automatically</div>`
            : appliedMealPlanUpdateHtml(p, now);
    const kept = "THIS WEEK'S IDEAS"; // a kept week is ideas, never a record of what was eaten
    const stateLabel = needsRefresh ? "NEEDS REFRESH" : autonomy ? "COMING NEXT" : isDraft ? "REVIEW" : kept;
    return `<div class="mealhero reveal" style="${stagger(0)}">
        <div class="mp-hero-head">
          <span class="lbl">${stateLabel} · ${escHtml(mealRows.planWeekLabel(p))}</span>
          ${mealRows.planBadge(visibleStatus)}
        </div>
        <div class="mp-hero-nums">
          <div><span class="numeral numeral-xl" data-cu="${Number(parsed.daily_kcal) || 0}">0</span><span class="lbl mp-hero-unit">kcal per day</span></div>
          <div><span class="numeral numeral-lg" data-cu="${Number(parsed.daily_protein_g) || 0}">0</span><span class="lbl mp-hero-unit">g protein</span></div>
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
          <div class="shop-chips">${rows
            .map(
              (item, index) =>
                `<button class="chip shop-chip${checked.has(index) ? " chip-done" : ""}" data-shop="${index}">${escHtml(String(item))}</button>`
            )
            .join("")}</div></div>`;
  }

  function mealPlannerBodyHtml(
    current: unknown,
    mealPrefs: unknown,
    options: MealPlannerOptions = {}
  ): MealPlannerPaint {
    const p = mealRecord(current);
    if (!p.parsed) return { html: mealPlanEmptyHtml(mealPrefs), context: null };
    const parsed = mealRecord(p.parsed);
    const needsRefresh = constraintState(p).status === "refresh_needed";
    const days = Array.isArray(parsed.days) ? parsed.days : [];
    const ctx = mealsCtxFor(p, options.now);
    const dayHtml = needsRefresh ? "" : days.map((day, index) => mealDayHtml(day, index, ctx)).join("");
    const shopping = needsRefresh ? "" : mealShoppingHtml(parsed.shopping, options.checkedShopping, days.length + 2);
    const notes =
      !needsRefresh && parsed.notes
        ? `<div class="sess-line reveal mp-muted" style="${stagger(days.length + 3)}">${escHtml(parsed.notes)}</div>`
        : "";
    return {
      context: ctx,
      html: `${mealPlanUpcomingHtml(options.upcoming, p)}
      ${mealPlanConstraintNoticeHtml(p)}
      ${mealPlanHeroHtml(p, options.verified, options.now)}
      ${mealPrefsHtml(mealPrefs, 1)}
      ${dayHtml}
      ${shopping}
      ${notes}
      <div class="meals-redraft">
        <button id="mealDraftBtn" class="ghostbtn meals-redraft-btn" type="button">Ask the team for a fresh week</button>
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
    mealPlanIsAdequate: (plan: unknown): boolean => !!mealRecord(plan).parsed && mealPlanIsAdequate(mealRecord(plan)),
    needsRefresh,
    mealsCtxFor,
    mealRowHtml,
    mealPlanCardHtml,
    mealPlanListHtml,
    mealPrefsHtml,
    mealPlanEmptyHtml,
    mealPlanHeroHtml,
    mealPlanUpcomingHtml,
    mealShoppingHtml,
    mealPlannerBodyHtml,
    mealDayHtml,
  };

  Object.assign(globalThis, { CairnMealPlan: CAIRN_MEAL_PLAN, mealSlotFor, mealRowHtml, mealDayHtml });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnMealPlan: CAIRN_MEAL_PLAN, mealSlotFor, mealRowHtml, mealDayHtml });
  }
})();

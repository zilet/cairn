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

  function mealPlanConstraintNoticeHtml(plan: unknown): string {
    const state = constraintState(plan);
    if (state.status !== "refresh_needed") return "";
    const conflicts = Array.isArray(state.conflicts) ? state.conflicts.map((entry) => mealRecord(entry)) : [];
    const detail = conflicts[0]?.detail ? ` ${String(conflicts[0].detail)}` : "";
    return `<div class="plan-upcoming reveal" role="status">
      <span class="lbl plan-upcoming-mast">MEALS NEED A REFRESH</span>
      <p class="sess-line" style="margin:0">Your saved allergy or dietary constraints changed.${escHtml(detail)} This week is kept in history, but Cairn will not treat its meals or shopping list as current.</p>
    </div>`;
  }

  function scheduledMealPlan(plan: unknown): MealRecord | null {
    const p = mealRecord(plan);
    const autonomy = mealRecord(p.autonomy);
    return p.status === "draft" && (autonomy.status === "announced" || autonomy.status === "pending") ? autonomy : null;
  }

  function mealBoundaryLabel(value: unknown): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!m) return "at the next food-day boundary";
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  function mealTargetValue(value: unknown): number | null {
    const target = Number(value);
    return Number.isFinite(target) && target > 0 ? Math.round(target) : null;
  }

  function mealTargetSummary(plan: unknown): string {
    const parsed = mealRecord(mealRecord(plan).parsed);
    const kcal = mealTargetValue(parsed.daily_kcal);
    const protein = mealTargetValue(parsed.daily_protein_g);
    return [kcal == null ? "" : `${kcal.toLocaleString()} kcal`, protein == null ? "" : `${protein} g protein`]
      .filter(Boolean)
      .join(" · ");
  }

  function mealTargetDifference(plan: unknown, current: unknown): string {
    const nextParsed = mealRecord(mealRecord(plan).parsed);
    const currentParsed = mealRecord(mealRecord(current).parsed);
    const nextKcal = mealTargetValue(nextParsed.daily_kcal);
    const currentKcal = mealTargetValue(currentParsed.daily_kcal);
    const nextProtein = mealTargetValue(nextParsed.daily_protein_g);
    const currentProtein = mealTargetValue(currentParsed.daily_protein_g);
    const differences: string[] = [];
    if (nextKcal != null && currentKcal != null && nextKcal !== currentKcal) {
      differences.push(
        `${Math.abs(nextKcal - currentKcal).toLocaleString()} kcal ${nextKcal > currentKcal ? "more" : "less"}`
      );
    }
    if (nextProtein != null && currentProtein != null) {
      if (nextProtein === currentProtein) differences.push(`protein stays at ${nextProtein} g`);
      else
        differences.push(
          `${Math.abs(nextProtein - currentProtein)} g protein ${nextProtein > currentProtein ? "more" : "less"}`
        );
    }
    return differences.join(" · ");
  }

  function mealPlanUpcomingHtml(plan: unknown, current?: unknown): string {
    const p = mealRecord(plan);
    const autonomy = scheduledMealPlan(p);
    if (!autonomy) return "";
    const target = mealTargetSummary(p);
    const difference = mealTargetDifference(p, current);
    const detail = String(
      autonomy.summary || mealRecord(p.parsed).summary || "Your next week is ready around the latest picture."
    );
    return `<div class="plan-upcoming reveal" style="${stagger(0)}">
      <span class="lbl plan-upcoming-mast">COMING NEXT</span>
      <p class="plan-upcoming-line"><span class="plan-upcoming-when">${escHtml(mealBoundaryLabel(autonomy.effective_date))}</span> — your meals refresh automatically.</p>
      ${target ? `<p class="sess-line" style="margin:0">${escHtml(target)}</p>` : ""}
      ${difference ? `<p class="sess-line" style="color:var(--muted);margin:0">${escHtml(difference)}</p>` : ""}
      <div class="logrow" style="margin-top:2px">
        <details class="hist-fold" style="margin:0;flex:1">
          <summary>Preview changes</summary>
          <p class="sess-line" style="color:var(--muted);margin:8px 0 0">${escHtml(detail)}</p>
        </details>
        ${autonomy.id == null ? "" : `<button type="button" class="linkbtn-quiet" data-meal-decision-hold="${escAttr(autonomy.id)}">Hold</button>`}
      </div>
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
    return `<div class="sess-line" style="color:var(--muted);margin-top:12px">
      <span class="lbl">RECENTLY UPDATED</span> · ${escHtml(summary)}
      ${rationale ? `<details class="hist-fold" style="display:inline-block;margin:0 6px"><summary>Why</summary><span>${escHtml(rationale)}</span></details>` : ""}
      ${autonomy.reversible === false ? "" : `<button type="button" class="linkbtn-quiet" data-meal-decision-undo="${escAttr(autonomy.id)}">Undo</button>`}
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
            <span class="lbl">${escHtml(p.agent)} · #${escHtml(p.id)}</span>
            ${statusBadge(visibleStatus)}
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
              return `<div class="mp-day"><div class="mp-dayname">${escHtml(d.day || "")}</div>${meals || `<div class="sess-line" style="color:var(--muted)">No meals</div>`}</div>`;
            })
            .join("")
        : "";
      body =
        dayDetail +
        (parsed.notes ? `<div class="sess-line" style="color:var(--muted)">${escHtml(parsed.notes)}</div>` : "");
    } else {
      hero = `<div class="mp-hero">
          <div class="mp-hero-head">
            <span class="lbl">${escHtml(p.agent)} · #${escHtml(p.id)}</span>
            ${statusBadge(visibleStatus)}
          </div>
        </div>`;
      body = `<div class="sess-line" style="color:var(--warn)">Unparseable output</div>`;
    }
    const actions =
      p.status === "draft" && !autonomy
        ? `<div class="sess-line" style="color:var(--muted);margin-top:10px"><span class="lbl">NEEDS YOUR DECISION</span> · Nothing changes until you choose.</div>
         <div class="logrow" style="margin-top:8px"><button class="logbtn" style="width:auto;padding:0 14px;font-size:.85rem" data-accept="${escAttr(p.id)}">USE THIS PLAN</button>
         <button class="ghostbtn" style="width:auto;padding:0 14px" data-discard="${escAttr(p.id)}">DISCARD</button></div>`
        : autonomy
          ? `<div class="sess-line" style="color:var(--muted);margin-top:10px">Becomes current ${escHtml(mealBoundaryLabel(autonomy.effective_date))} · automatic and reversible</div>`
          : "";
    return `<div class="mp-card reveal${p.status === "superseded" ? " mp-card-faded" : ""}" style="${stagger(index)}">
      ${hero}${body}${actions}</div>`;
  }

  function mealPlanListHtml(plans: unknown): string {
    const rows = Array.isArray(plans) ? plans : [];
    if (!rows.length)
      return `<div class="empty">No meal plans yet. Ask the team above and a week built around your training will land here.</div>`;
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
        <div class="meals-empty-title">No meal plan yet</div>
        <div class="meals-empty-sub">Your expert team can build the first week around your training, health context, preferences, and lean-safe targets.</div>
        <button id="mealDraftBtn" class="logbtn meals-cta">ASK TEAM TO PLAN THIS WEEK</button>
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
        ? `<div class="sess-line" style="color:var(--muted);margin-top:12px"><span class="lbl">REFRESH REQUIRED</span> · This draft cannot become current until it is rebuilt against your saved constraints.</div>
         <div class="meals-actions">
           <button class="pillbtn" data-mdiscard="${escAttr(p.id)}">Discard</button>
         </div>`
        : isDraft && !autonomy
          ? `<div class="sess-line" style="color:var(--muted);margin-top:12px"><span class="lbl">NEEDS YOUR DECISION</span> · Nothing changes until you choose.</div>
         <div class="meals-actions">
           <button class="pillbtn pill-accent" data-mkeep="${escAttr(p.id)}">Use this plan</button>
           <button class="pillbtn" data-mdiscard="${escAttr(p.id)}">Discard</button>
         </div>`
          : autonomy
            ? `<div class="sess-line" style="color:var(--muted);margin-top:12px">Becomes current ${escHtml(mealBoundaryLabel(autonomy.effective_date))} · automatically</div>`
            : appliedMealPlanUpdateHtml(p, now);
    const stateLabel = needsRefresh ? "NEEDS REFRESH" : autonomy ? "COMING NEXT" : isDraft ? "REVIEW" : "CURRENT PLAN";
    return `<div class="mealhero reveal" style="${stagger(0)}">
        <div class="mp-hero-head">
          <span class="lbl">${stateLabel} · Week of ${escHtml(ctx.weekOf)}${p.agent ? ` · ${escHtml(p.agent)}` : ""}</span>
          ${statusBadge(visibleStatus)}
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
        ? `<div class="sess-line reveal" style="color:var(--muted);${stagger(days.length + 3)}">${escHtml(parsed.notes)}</div>`
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
        <button id="mealDraftBtn" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Ask the team to refresh meals</button>
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

(() => {
// @ts-check
// Pure meal-plan render/model helpers for Plan -> Meals and Coach meal-plan history.
(() => {
    const MEAL_HINT_CHIPS = ["Fish", "Chicken", "Beef", "Veggie", "Lighter", "Bigger", "Quick to make"];
    const MEAL_PREFS_PLACEHOLDER = "e.g. fasted morning training, simple prep on busy days";
    const MEAL_PREF_CHIPS = ["Fasted AM training", "Train before lunch some days", "Simple prep, busy weekdays", "More fish, less red meat"];
    const KEPT_MEAL_PLAN_STATUSES = ["accepted", "applied", "kept"];
    function mealRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function mealItemsText(value) {
        return Array.isArray(value) ? value.join(", ") : String(value || "");
    }
    function mealSlotFor(name, index) {
        const normalized = String(name || "").toLowerCase();
        for (const slot of ["breakfast", "lunch", "dinner", "snack"]) {
            if (normalized.includes(slot))
                return slot;
        }
        return ["breakfast", "lunch", "dinner"][Number(index)] || "snack";
    }
    function todayNameFor(now) {
        const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        const candidate = now && typeof now === "object" && typeof now.getDay === "function"
            ? Number(now.getDay())
            : new Date().getDay();
        return dayNames[candidate] || dayNames[new Date().getDay()];
    }
    function currentMealPlan(plans) {
        const rows = Array.isArray(plans) ? plans.map((plan) => mealRecord(plan)) : [];
        return rows.find((plan) => KEPT_MEAL_PLAN_STATUSES.includes(String(plan.status)) && plan.parsed) ||
            rows.find((plan) => plan.status === "draft" && plan.parsed) ||
            null;
    }
    function mealsCtxFor(plan, now) {
        const p = mealRecord(plan);
        const parsed = mealRecord(p.parsed);
        return {
            weekOf: String(p.week_of || String(p.created_at || "").slice(0, 10)),
            targetKcal: Number(parsed.daily_kcal) || 0,
            todayName: todayNameFor(now),
        };
    }
    function mealRowHtml(meal, mealIndex, options) {
        const x = mealRecord(meal);
        const items = mealItemsText(x.items);
        const query = `${x.name || x.meal || ""} ${items}`.trim();
        const tile = artImg("food", query, "artile-md meal-art", art("food", query));
        const macros = [["P", x.protein_g], ["C", x.carbs_g], ["F", x.fat_g]]
            .filter(([label, value]) => value != null && value !== "" && (label === "P" || Number(value) > 0))
            .map(([label, value]) => `<span class="lbl">${label} ${escHtml(String(value))}</span>`).join("");
        const loggable = typeof mealIndex === "number";
        const planner = loggable && options && typeof options.di === "number";
        const logBtn = loggable ? `<button class="meal-log" data-mlog="${escAttr(JSON.stringify({
            name: x.name || x.meal || "",
            items,
            kcal: x.kcal ?? null,
            protein_g: x.protein_g ?? null,
            carbs_g: x.carbs_g ?? null,
            fat_g: x.fat_g ?? null,
            i: mealIndex,
        }))}">+ Log it</button>` : "";
        const count = Number(options?.count) || 0;
        const tools = planner
            ? `<div class="meal-rowtools">${logBtn}<button class="meal-swapbtn" data-mswap aria-label="Swap this meal">⇄ Swap</button><span class="meal-mvgrp"><button class="meal-mv" data-mv="-1" aria-label="Move up" ${mealIndex === 0 ? "disabled" : ""}>▲</button><button class="meal-mv" data-mv="1" aria-label="Move down" ${mealIndex >= count - 1 ? "disabled" : ""}>▼</button></span></div>`
            : logBtn;
        const row = `<div class="meal-row"${planner ? ` data-di="${options.di}" data-mi="${mealIndex}"` : ""}>
      ${tile}
      <div class="meal-main">
        <div class="meal-name">${escHtml(x.name || x.meal || "")}</div>
        ${items ? `<div class="meal-items">${escHtml(items)}</div>` : ""}
        ${tools}
      </div>
      <div class="meal-macros">
        ${x.kcal ? `<span class="numeral">${escHtml(String(x.kcal))}</span>` : ""}
        ${macros}
      </div>
    </div>`;
        if (!planner)
            return row;
        return row + `<div class="meal-swap" hidden data-di="${options.di}" data-mi="${mealIndex}">
      <input class="meal-swap-hint" type="text" maxlength="140" placeholder="Optional hint — fish, lighter, quick…">
      <div class="meal-swap-chips">${MEAL_HINT_CHIPS.map((hint) => `<button type="button" class="chip hintchip" data-hint="${escAttr(hint)}">${escHtml(hint)}</button>`).join("")}</div>
      <div class="meal-swap-actions">
        <button type="button" class="pillbtn pill-accent meal-swap-go">Swap it</button>
        <button type="button" class="pillbtn meal-swap-cancel">Cancel</button>
      </div>
    </div>`;
    }
    function mealPlanCardHtml(plan, index) {
        const p = mealRecord(plan);
        const parsed = mealRecord(p.parsed);
        let hero;
        let body;
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
        }
        else {
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
    function mealPlanListHtml(plans) {
        const rows = Array.isArray(plans) ? plans : [];
        if (!rows.length)
            return `<div class="empty">No meal plans yet. Draft one above and a week of meals built around your training lands here.</div>`;
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
    function mealPrefsHtml(prefs, index) {
        const saved = String(prefs || "");
        return `<div class="mealprefs reveal" style="${stagger(index)}" id="mealPrefs">
      <button type="button" class="mealprefs-head" id="mealPrefsToggle" aria-expanded="false">
        <span class="lbl">Planning preferences<span class="mealprefs-caret">▾</span></span>
        <span class="mealprefs-preview${saved ? "" : " mealprefs-placeholder"}">${escHtml(saved || MEAL_PREFS_PLACEHOLDER)}</span>
      </button>
      <div class="mealprefs-body" hidden>
        <textarea id="mealPrefsText" rows="3" placeholder="${escAttr(MEAL_PREFS_PLACEHOLDER)}">${escHtml(saved)}</textarea>
        <div class="mealprefs-chips">${MEAL_PREF_CHIPS.map((chip) => `<button type="button" class="chip prefchip" data-pref="${escAttr(chip)}">${escHtml(chip)}</button>`).join("")}</div>
      </div>
    </div>`;
    }
    function mealPlanEmptyHtml(mealPrefs) {
        return `<div class="meals-empty reveal" style="${stagger(0)}">
        <div class="artile artile-xl meals-empty-art">${art("food", "meal plate")}</div>
        <div class="meals-empty-title">No meal plan yet</div>
        <div class="meals-empty-sub">Ask the coach to draft a week of meals built around your training and lean-safe targets.</div>
        <button id="mealDraftBtn" class="logbtn meals-cta">DRAFT WEEKLY MEAL PLAN</button>
        <div id="mealDraftStatus" class="meals-status"></div>
      </div>${mealPrefsHtml(mealPrefs, 1)}`;
    }
    function mealPlanHeroHtml(plan, verified) {
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
    function checkedIndexSet(value) {
        const rows = value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : [];
        return new Set(rows.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry)));
    }
    function mealShoppingHtml(shopping, checkedShopping, revealIndex) {
        const rows = Array.isArray(shopping) ? shopping : [];
        if (!rows.length)
            return "";
        const checked = checkedIndexSet(checkedShopping);
        return `<div class="detail-section reveal" style="${stagger(revealIndex)}"><div class="lbl">Shopping</div>
          <div class="shop-chips">${rows.map((item, index) => `<button class="chip shop-chip${checked.has(index) ? " chip-done" : ""}" data-shop="${index}">${escHtml(String(item))}</button>`).join("")}</div></div>`;
    }
    function mealPlannerBodyHtml(current, mealPrefs, options = {}) {
        const p = mealRecord(current);
        if (!p.parsed)
            return { html: mealPlanEmptyHtml(mealPrefs), context: null };
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
    function mealDayHtml(day, dayIndex, context) {
        const d = mealRecord(day);
        const meals = Array.isArray(d.meals) ? d.meals : [];
        const kcal = meals.reduce((total, meal) => total + (Number(mealRecord(meal).kcal) || 0), 0);
        const protein = meals.reduce((total, meal) => total + (Number(mealRecord(meal).protein_g) || 0), 0);
        const todayPrefix = String(context.todayName || "").toLowerCase();
        const isToday = Boolean(todayPrefix) && String(d.day || "").toLowerCase().startsWith(todayPrefix);
        const totals = kcal || protein
            ? `<div class="mealday-total"><span class="numeral" data-cu="${kcal}">0</span><span class="lbl"> cal${protein ? ` · ${protein}g protein` : ""}</span></div>`
            : "";
        const targetKcal = Number(context.targetKcal) || 0;
        const bar = kcal && targetKcal
            ? `<div class="mealday-bar"><div class="mealday-bar-fill barfill" style="width:${Math.min(100, Math.round((kcal / targetKcal) * 100))}%"></div></div>`
            : "";
        return `<section class="mealday${isToday ? " mealday-today" : ""} reveal" style="${stagger(dayIndex + 2)}" data-mday="${dayIndex}">
      <div class="mealday-head">
        <div><div class="lbl">${isToday ? `<span class="mealday-now">Today</span> · ` : ""}${escHtml(context.weekOf)}</div><h2 class="mealday-name">${escHtml(d.day || `Day ${dayIndex + 1}`)}</h2></div>
        ${totals}
      </div>
      ${bar}
      <div class="mealday-card">${meals.map((meal, mealIndex) => mealRowHtml(meal, mealIndex, { di: dayIndex, count: meals.length })).join("") || `<div class="empty">No meals</div>`}</div>
      ${d.note ? `<div class="mealday-note">${escHtml(d.note)}</div>` : ""}
    </section>`;
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
})();

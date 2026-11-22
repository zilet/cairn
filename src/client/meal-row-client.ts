// @ts-check
// Meal row/day render primitives for Plan -> Meals.

type MealRowRenderRecord = Record<string, unknown>;

type MealRowRenderOptions = {
  di?: number;
  count?: number;
};

type MealRowDayContext = {
  weekOf?: unknown;
  targetKcal?: unknown;
  todayName?: unknown;
};

type MealRowPlannerContext = {
  weekOf: string;
  targetKcal: number;
  todayName: string;
};

(() => {
  const MEAL_HINT_CHIPS = ["Fish", "Chicken", "Beef", "Veggie", "Lighter", "Bigger", "Quick to make"];

  function mealRecord(value: unknown): MealRowRenderRecord {
    return value && typeof value === "object" ? value as MealRowRenderRecord : {};
  }

  function mealItemsText(value: unknown): string {
    return Array.isArray(value) ? value.join(", ") : String(value || "");
  }

  function mealSlotFor(name: unknown, index: unknown): string {
    const normalized = String(name || "").toLowerCase();
    for (const slot of ["breakfast", "lunch", "dinner", "snack"]) {
      if (normalized.includes(slot)) return slot;
    }
    return ["breakfast", "lunch", "dinner"][Number(index)] || "snack";
  }

  function todayNameFor(now?: unknown): string {
    const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const candidate = now && typeof now === "object" && typeof (now as Date).getDay === "function"
      ? Number((now as Date).getDay())
      : new Date().getDay();
    return dayNames[candidate] || dayNames[new Date().getDay()];
  }

  function mealsCtxFor(plan: unknown, now?: unknown): MealRowPlannerContext {
    const p = mealRecord(plan);
    const parsed = mealRecord(p.parsed);
    return {
      weekOf: String(p.week_of || String(p.created_at || "").slice(0, 10)),
      targetKcal: Number(parsed.daily_kcal) || 0,
      todayName: todayNameFor(now),
    };
  }

  function mealRowHtml(meal: unknown, mealIndex?: number, options?: MealRowRenderOptions): string {
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
    if (!planner) return row;
    return row + `<div class="meal-swap" hidden data-di="${options.di}" data-mi="${mealIndex}">
      <div class="meal-swap-fuel lbl" data-fuel-line hidden></div>
      <input class="meal-swap-hint" type="text" maxlength="140" placeholder="Optional hint — fish, lighter, quick…">
      <div class="meal-swap-chips">${MEAL_HINT_CHIPS.map((hint) =>
        `<button type="button" class="chip hintchip" data-hint="${escAttr(hint)}">${escHtml(hint)}</button>`).join("")}</div>
      <div class="meal-swap-actions">
        <button type="button" class="pillbtn pill-accent meal-swap-go">Swap it</button>
        <button type="button" class="pillbtn meal-swap-cancel">Cancel</button>
      </div>
    </div>`;
  }

  function mealDayHtml(day: unknown, dayIndex: number, context: MealRowDayContext): string {
    const d = mealRecord(day);
    const meals = Array.isArray(d.meals) ? d.meals : [];
    const kcal = meals.reduce((total, meal) => total + (Number(mealRecord(meal).kcal) || 0), 0);
    const protein = meals.reduce((total, meal) => total + (Number(mealRecord(meal).protein_g) || 0), 0);
    const todayPrefix = String(context.todayName || "").toLowerCase();
    const isToday = Boolean(todayPrefix) && String(d.day || "").toLowerCase().startsWith(todayPrefix);
    const totals = kcal || protein
      ? `<div class="mealday-total"><span class="numeral" data-cu="${kcal}">0</span><span class="lbl"> cal${protein ? ` · ${protein}g protein` : ""}</span></div>`
      : "";
    // A plan drafted with a per-day split carries the server's own number on each day that
    // moved (`target_kcal`, with what the day carries in `target_why`); the bar and a small
    // label follow it. The server leaves it off once the split's week has passed, so a plan
    // viewed from its second week reads flat. Every other day, and an older plan, uses daily_kcal.
    const ownKcal = Number(d.target_kcal);
    const hasOwn = Number.isFinite(ownKcal) && ownKcal > 0;
    const targetKcal = hasOwn ? ownKcal : Number(context.targetKcal) || 0;
    const ownWhy = hasOwn && typeof d.target_why === "string" ? d.target_why.trim() : "";
    const ownLabel = hasOwn
      ? `<div class="lbl mealday-own">This day's number: ${escHtml(Math.round(ownKcal).toLocaleString("en-US"))} kcal${ownWhy ? ` · ${escHtml(ownWhy)}` : ""}</div>`
      : "";
    // The bar's track can't overflow, but the ratio it renders can — capping the
    // width alone would make a 130%-of-target day look identical to on-target,
    // erasing the only thing this bar is meant to answer. A distinct over-target
    // fill (still terracotta, just deeper) keeps that signal without going
    // alarm-red; the real numbers still live in the adjacent kcal/protein total.
    const kcalRatio = kcal && targetKcal ? kcal / targetKcal : 0;
    const overTarget = kcalRatio > 1.05;
    const bar = kcal && targetKcal
      ? `<div class="mealday-bar"><div class="mealday-bar-fill barfill${overTarget ? " over-target" : ""}" style="width:${Math.min(100, Math.round(kcalRatio * 100))}%"></div></div>`
      : "";
    return `<section class="mealday${isToday ? " mealday-today" : ""} reveal" style="${stagger(dayIndex + 2)}" data-mday="${dayIndex}">
      <div class="mealday-head">
        <div><div class="lbl">${isToday ? `<span class="mealday-now">Today</span> · ` : ""}${escHtml(typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? weekOfText(d.date) : dayDateText(d.day, String(context.weekOf ?? "")))}</div><h2 class="mealday-name">${escHtml(d.day || `Day ${dayIndex + 1}`)}</h2></div>
        ${totals}
      </div>
      ${bar}
      ${ownLabel}
      <div class="mealday-card">${meals.map((meal, mealIndex) => mealRowHtml(meal, mealIndex, { di: dayIndex, count: meals.length })).join("") || `<div class="empty">No meals</div>`}</div>
      ${d.note ? `<div class="mealday-note">${escHtml(d.note)}</div>` : ""}
    </section>`;
  }

  // The meal-plan journal speaks to the athlete: a week's state in words, never the
  // producer (the agent CLI), a row id, or a raw status. Same tones as statusBadge.
  const PLAN_BADGE_WORDS: Record<string, [string, string]> = {
    coming: ["coming", "ok"],
    review: ["to look over", "draft"],
    draft: ["to look over", "draft"],
    accepted: ["kept", "ok"],
    applied: ["kept", "ok"],
    kept: ["kept", "ok"],
    discarded: ["set aside", "off"],
    superseded: ["earlier", "muted"],
  };

  function planBadge(status: unknown): string {
    const words = PLAN_BADGE_WORDS[String(status || "draft")];
    return words ? `<span class="mp-badge ${words[1]}">${escHtml(words[0])}</span>` : "";
  }

  // A week's start in words ("Sep 29"), never the raw ISO key the plan stores.
  function weekOfText(weekOf: string): string {
    const chart = (globalThis as { CairnUiChart?: { dateLabel?: (value: unknown) => string } }).CairnUiChart;
    return /^\d{4}-\d{2}-\d{2}$/.test(weekOf) && chart?.dateLabel ? chart.dateLabel(weekOf) || weekOf : weekOf;
  }

  // A plan day's own date: its weekday inside the calendar week holding `week_of` (the
  // draft date, any weekday), the same week the "Today" mark reads. A day not named by
  // a weekday ("Day 1") carries no date rather than another day's.
  const WEEKDAY_PREFIXES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  function dayDateText(dayName: unknown, weekOf: string): string {
    const index = WEEKDAY_PREFIXES.findIndex((prefix) => String(dayName || "").trim().toLowerCase().startsWith(prefix));
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(weekOf) ? new Date(`${weekOf}T00:00:00Z`) : null;
    if (index < 0 || !anchor || Number.isNaN(anchor.getTime())) return "";
    anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7) + index);
    return weekOfText(anchor.toISOString().slice(0, 10));
  }

  function planWeekLabel(plan: unknown): string {
    const weekOf = mealsCtxFor(plan).weekOf;
    return weekOf ? `Week of ${weekOfText(weekOf)}` : "A week of ideas";
  }

  // A draft is a week of IDEAS the athlete asked for: keeping it changes nothing they
  // ate, so the ask is to look it over, never a decision to "use a plan".
  const IDEAS_ASK = `<span class="lbl">IDEAS TO LOOK OVER</span> · Nothing changes unless you keep them.`;

  const CAIRN_MEAL_ROWS = {
    MEAL_HINT_CHIPS,
    record: mealRecord,
    itemsText: mealItemsText,
    mealSlotFor,
    todayNameFor,
    mealsCtxFor,
    mealRowHtml,
    mealDayHtml,
    planBadge,
    planWeekLabel,
    IDEAS_ASK,
  };

  Object.assign(globalThis, {
    CairnMealRows: CAIRN_MEAL_ROWS,
    mealSlotFor,
    mealRowHtml,
    mealDayHtml,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnMealRows: CAIRN_MEAL_ROWS,
      mealSlotFor,
      mealRowHtml,
      mealDayHtml,
    });
  }
})();

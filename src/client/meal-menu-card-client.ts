// @ts-check
// "This week's menu" on Today → Fuel (lazy "meals" bundle): today's planned meals from
// the current week — a kept week first, else the newest draft, which is labelled as
// ideas to look over — and one way into the whole week. A view only (pure HTML from the
// meal-plan list); meal-menu-card-controller.ts loads and wires it. The card never lists
// meals from a week whose saved constraints changed under it, and a meal's numbers are
// plain kcal, never a grade.

type MealMenuCardMeal = { slot: string; name: string; items: string; kcal: number | null; query: string };

type MealMenuCardModel =
  | { kind: "empty" }
  | {
      kind: "week";
      /** The athlete's word for the week's state: "review" (a draft), "coming" (scheduled), else kept. */
      status: "review" | "coming" | "kept";
      needsRefresh: boolean;
      dayName: string;
      meals: MealMenuCardMeal[];
    };

(() => {
  const SLOT_WORDS: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

  function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  // A plan day matches today the way the planner marks its "Today" (mealDayHtml): the
  // day's own label starts with today's short weekday name.
  function todayOf(days: unknown[], todayName: string): Record<string, unknown> | null {
    const prefix = String(todayName || "").toLowerCase();
    if (!prefix) return null;
    const hit = days.map(record).find((day) => String(day.day || "").trim().toLowerCase().startsWith(prefix));
    return hit || null;
  }

  function mealModel(meal: unknown, index: number): MealMenuCardMeal {
    const rows = CairnMealRows;
    const m = record(meal);
    const name = String(m.name || m.meal || "");
    const items = rows.itemsText(m.items);
    const kcal = Number(m.kcal);
    const slot = SLOT_WORDS[rows.mealSlotFor(name, index)] || "Meal";
    // A meal named only for its slot ("Breakfast") says it once: what is in it becomes the name.
    const bare = !name || name.trim().toLowerCase() === slot.toLowerCase();
    return {
      slot,
      name: bare && items ? items : name,
      items: bare && items ? "" : items,
      kcal: Number.isFinite(kcal) && kcal > 0 ? Math.round(kcal) : null,
      query: `${name} ${items}`.trim(),
    };
  }

  function menuCardModel(plans: unknown, now?: unknown): MealMenuCardModel {
    const current = CairnMealPlan.currentMealPlan(plans);
    if (!current) return { kind: "empty" };
    const parsed = record(current.parsed);
    const days = Array.isArray(parsed.days) ? parsed.days : [];
    const ctx = CairnMealRows.mealsCtxFor(current, now);
    const day = todayOf(days, ctx.todayName);
    const autonomy = record(current.autonomy);
    const scheduled = current.status === "draft" && (autonomy.status === "announced" || autonomy.status === "pending");
    const meals = day && Array.isArray(day.meals) ? day.meals : [];
    return {
      kind: "week",
      status: scheduled ? "coming" : current.status === "draft" ? "review" : "kept",
      needsRefresh: CairnMealPlan.needsRefresh(current),
      dayName: day ? String(day.day || "") : "",
      meals: meals.map(mealModel),
    };
  }

  function mealRowHtml(meal: MealMenuCardMeal): string {
    const tile = artImg("food", meal.query, "artile-sm mmenu-art", art("food", meal.query));
    return `<li class="mmenu-meal">
      <button type="button" class="mmenu-row" data-mmenu-open="today">
        ${tile}
        <span class="mmenu-main">
          <span class="lbl mmenu-slot">${escHtml(meal.slot)}</span>
          <span class="mmenu-name">${escHtml(meal.name)}</span>
          ${meal.items ? `<span class="mmenu-items">${escHtml(meal.items)}</span>` : ""}
        </span>
        ${meal.kcal != null ? `<span class="mmenu-kcal">${escHtml(meal.kcal.toLocaleString())}<span class="mmenu-unit"> kcal</span></span>` : ""}
      </button>
    </li>`;
  }

  // The status line under the title: a draft says it is ideas, a scheduled week when it
  // lands, a week that needs a refresh says why it lists nothing.
  function noteHtml(model: Extract<MealMenuCardModel, { kind: "week" }>): string {
    if (model.needsRefresh)
      return `<p class="mmenu-note">Your saved food constraints changed, so this week needs a fresh draft before its meals count.</p>`;
    if (model.status === "review") return `<p class="mmenu-note">Ideas to look over. Nothing changes unless you keep them.</p>`;
    if (model.status === "coming") return `<p class="mmenu-note">The next week of ideas, ready at the next food-day boundary.</p>`;
    return "";
  }

  // Collapsed by default; the choice is remembered per viewer, and the card renders
  // fine (closed) when storage is unavailable.
  const OPEN_KEY = "cairn.fuel.menuOpen";
  function menuOpen(): boolean {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  }
  function setMenuOpen(open: boolean): void {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // storage unavailable: the choice just doesn't persist
    }
  }

  // One quiet line under the title while the card is closed.
  function summaryText(model: Extract<MealMenuCardModel, { kind: "week" }>): string {
    if (model.needsRefresh) return "Needs a fresh draft";
    if (!model.meals.length) return "Nothing planned today";
    const total = model.meals.reduce((sum, m) => sum + (m.kcal || 0), 0);
    const count = `${model.meals.length} ${model.meals.length === 1 ? "meal" : "meals"}`;
    return `Today · ${count}${total > 0 ? ` · ~${total.toLocaleString("en-US")} kcal` : ""}`;
  }

  // Inside the fold's <summary> the head is phrasing content around its one heading
  // (a summary allows nothing else), so it is a span there and a div everywhere else.
  function headHtml(badge: string, tag: "div" | "span" = "div"): string {
    return `<${tag} class="mmenu-head">
      <h2 class="lbl mmenu-title" id="mmenuTitle">This week's menu</h2>
      ${badge}
    </${tag}>`;
  }

  // The draft status host rides every state of the card, so a week the team is still
  // drafting (started on the week menu, or before a reload) reattaches here and the card
  // repaints the moment it lands.
  const STATUS_HOST = `<div id="mealDraftStatus" class="meals-status mmenu-status" role="status"></div>`;

  function emptyHtml(): string {
    return `<section class="mmenu mmenu-empty" aria-labelledby="mmenuTitle">
      ${headHtml("")}
      <div class="mmenu-empty-body">
        <div class="artile artile-md mmenu-empty-art">${art("food", "meal plate")}</div>
        <div class="mmenu-empty-words">
          <p class="mmenu-empty-title">No menu this week yet</p>
          <p class="mmenu-empty-sub">The team can sketch a week of meals around your training and what you like to eat. Ideas to look over, never a rule.</p>
        </div>
      </div>
      <button id="mealDraftBtn" class="pillbtn pill-accent mmenu-draft" type="button" data-mmenu-draft>Ask the team for a week of meals</button>
      ${STATUS_HOST}
    </section>`;
  }

  function menuCardHtml(model: MealMenuCardModel): string {
    if (model.kind === "empty") return emptyHtml();
    const badge = model.status === "kept" ? "" : CairnMealRows.planBadge(model.status);
    const day = model.dayName
      ? `<p class="mmenu-day"><span class="mmenu-today">Today</span> · ${escHtml(model.dayName)}</p>`
      : "";
    const list = model.needsRefresh
      ? ""
      : model.meals.length
        ? `${day}<ul class="mmenu-list">${model.meals.map(mealRowHtml).join("")}</ul>`
        : `<p class="mmenu-quiet">Nothing on the menu for today. The rest of the week is a tap away.</p>`;
    return `<section class="mmenu mmenu-fold" aria-labelledby="mmenuTitle">
      <details class="mmenu-details" data-mmenu-details${menuOpen() ? " open" : ""}>
        <summary class="mmenu-summary">
          <span class="mmenu-summary-main">
            ${headHtml(badge, "span")}
            <span class="mmenu-peek">${escHtml(summaryText(model))}</span>
          </span>
        </summary>
        ${noteHtml(model)}
        ${list}
        <button class="linkbtn mmenu-week" type="button" data-mmenu-open="week">See the week <span aria-hidden="true">›</span></button>
      </details>
      ${STATUS_HOST}
    </section>`;
  }

  function skeletonHtml(): string {
    return `<section class="mmenu mmenu-skel" aria-hidden="true">${headHtml("")}${skelLines(2)}</section>`;
  }

  const CAIRN_MEAL_MENU_CARD = { model: menuCardModel, cardHtml: menuCardHtml, skeletonHtml, menuOpen, setMenuOpen };

  Object.assign(globalThis, { CairnMealMenuCard: CAIRN_MEAL_MENU_CARD });
})();

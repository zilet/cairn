// @ts-check
// Train › Intake, the ONE home for food (/app/train/intake; the old Fuel view's
// /app/today/fuel lands here). It opens on TODAY: the day so far (fuel-today-*: protein
// then energy as slim meters beside the day's number, carbs · fat · fiber as plain
// numbers), the meals logged today with the times the athlete stated, each correctable
// in place (fuel-meals-*: portions in words, the gram rows only behind an explicit
// Edit), ONE idea for the rest of the day (idea-card-*, "Start from this" fills the
// composer and never logs) and the food composer itself (fuel-log-*). Under it, the
// days before today (progress-intake-client.ts), then the group's deeper rows (Energy
// balance, This week's menu), which wireSeg lays into the foot's slot.
//
// A composition only, and the lazy fuel bundle's: the dispatcher and the Train segment
// deps reach it through lazy("fuel") / withLatestRender("fuel"). The frame paints
// synchronously and each component mounts into its own slot; logging or correcting a
// meal never leaves the screen — every slot that reads the day refreshes in place.

type IntakeWeeks = import("../contracts/client.js").ClientNutritionProgress;

let intakeTeardowns: Array<() => void> = [];
// The still-estimating entries the week read is following, so a repaint never watches one twice.
const intakeWatched = new Set<number>();

function intakeCurrent(token: number): boolean {
  return token === pollToken && state.tab === "progress" && state.progressSeg === "intake";
}

/**
 * The weeks: their own read, asked after today's card has painted (never part of its
 * first-paint wait), painted from a warm peek at once, then the network answer when it
 * changed. A failed read says so only while nothing is painted: weeks already on screen
 * stay when a later refresh fails.
 */
function loadIntakeWeeks(token: number): { refresh(): void } {
  const path = CairnFuelDeps.PROGRESS_PATH;
  const key = CairnFuelDeps.PROGRESS_KEY;
  const mount = (): Element | null => view.querySelector("#intakeProgress");
  let painted = false;
  const paint = (data: unknown): void => {
    const host = mount();
    if (!intakeCurrent(token) || !host || !data || typeof data !== "object") return;
    const weeks = data as IntakeWeeks;
    CairnProgressIntake.render(host, weeks);
    painted = true;
    watchIntakePending(token, weeks, paint);
  };
  const read = (peek: { fresh: boolean } | null): void => {
    cachedApi(path, {
      key,
      onUpgrade: (data, { changed }) => {
        if (peek && !peek.fresh) markRefreshing(false);
        if (changed || !peek) paint(data);
      },
    }).catch(() => {
      if (peek && !peek.fresh) markRefreshing(false);
      const host = mount();
      if (!painted && host && intakeCurrent(token)) host.innerHTML = CairnProgressIntake.unavailableHtml();
    });
  };
  const peek = peekCached<IntakeWeeks>(key);
  if (peek) {
    paint(peek.data);
    if (!peek.fresh) markRefreshing(true);
  } else {
    const host = mount();
    if (host) host.innerHTML = loadingState("Reading the days before today…");
  }
  read(peek);
  return {
    // A meal logged or corrected moves today and, once it settles, the days behind it.
    refresh: () => {
      swrInvalidate(key);
      read(peekCached<IntakeWeeks>(key));
    },
  };
}

// A food entry still being estimated holds the week read's numbers open; follow each
// one until it settles, then re-read once.
function watchIntakePending(token: number, weeks: IntakeWeeks, paint: (data: unknown) => void): void {
  for (const id of weeks.coverage?.pending_entry_ids || []) {
    if (intakeWatched.has(id)) continue;
    intakeWatched.add(id);
    let settled = false;
    const reread = (): void => {
      if (settled) return;
      settled = true;
      swrInvalidate(CairnFuelDeps.PROGRESS_KEY);
      if (!intakeCurrent(token)) return;
      api(CairnFuelDeps.PROGRESS_PATH)
        .then((fresh) => {
          if (!intakeCurrent(token)) return;
          swrSet(CairnFuelDeps.PROGRESS_KEY, fresh);
          paint(fresh);
        })
        .catch(() => {});
    };
    void pollEnrichment("/food-notes", id, {
      tab: "progress",
      token,
      onUpdate: (row) => {
        if (!enrichmentActive(row.enrichment_status)) reread();
      },
    }).then((row) => {
      intakeWatched.delete(id);
      if (row && !enrichmentActive(row.enrichment_status)) reread();
    });
  }
}

/** Today's slots: the day so far, the meals, one idea, the composer. */
function mountIntakeToday(token: number, today: string, refreshWeeks: () => void): void {
  for (const teardown of intakeTeardowns) teardown();
  intakeTeardowns = [];
  const slot = (id: string): Element | null => view.querySelector(`#${id}`);
  const deps = CairnFuelDeps;
  const todaySlot = slot("dayFuelSlot");
  const fuelToday = todaySlot ? CairnFuelTodayController.mount(todaySlot, deps.today(today, today)) : null;
  let ideas: ClientFuelRefreshHandle | null = null;
  const afterChange = (): void => {
    swrInvalidate("progress:energy");
    void fuelToday?.refresh();
    void ideas?.refresh();
    refreshWeeks();
  };
  const mealsSlot = slot("fuelMealsSlot");
  const meals = mealsSlot ? CairnFuelMealsController.mount(mealsSlot, deps.meals(today, today, token, afterChange)) : null;
  const logSlot = slot("fuelLogSlot");
  const onLogged = (): void => {
    void meals?.refresh();
    afterChange();
  };
  const log = logSlot ? CairnFuelLogController.mount(logSlot, deps.log(onLogged)) : null;
  const ideasSlot = slot("fuelIdeasSlot");
  ideas = ideasSlot ? CairnIdeaCardController.mount(ideasSlot, deps.ideas(today, (prefill) => log?.open(prefill))) : null;
  intakeTeardowns = [fuelToday, meals, ideas, log].filter((t): t is NonNullable<typeof t> => !!t);
}

function paintIntake(token: number, today: string): void {
  // Top to bottom as the day reads: today so far, what was eaten, an idea for later and
  // the place to write it; then the days before today; then the deeper rows.
  view.innerHTML =
    segBar("intake", PROGRESS_SEG) +
    `<div class="intake fuel">
      <div class="intake-today">
        <div id="dayFuelSlot" class="fuel-slot"></div>
        <div id="fuelMealsSlot" class="fuel-slot"></div>
        <div id="fuelIdeasSlot" class="fuel-slot"></div>
        <div id="fuelLogSlot" class="fuel-slot"></div>
      </div>
      <div id="intakeProgress" class="intake-weeks"></div>
      <div data-train-deeper-slot></div>
    </div>`;
  wireSeg(PROGRESS_HANDLERS);
  let weeks: { refresh(): void } | null = null;
  mountIntakeToday(token, today, () => weeks?.refresh());
  // The days before today ask for themselves once today's card is up.
  weeks = loadIntakeWeeks(token);
}

function renderIntake(): Promise<unknown> {
  headerTitle.textContent = "Intake"; // the Intake group's landing: the header names the tab, not the leaf
  state.progressSeg = "intake";
  const token = ++pollToken;
  const today = localISO();
  // Cold: the slots' reads are asked together (one fan-in) and the surface is written
  // once they answer, so nothing below jumps as each lands; warm, it paints at once.
  const primed = CairnFuelDeps.firstPaint(today);
  if (!primed) {
    paintIntake(token, today);
    return Promise.resolve();
  }
  view.innerHTML =
    segBar("intake", PROGRESS_SEG) +
    `<div class="intake fuel" aria-busy="true"><div class="fuel-slot">${CairnFuelToday.skeletonHtml()}</div></div>`;
  wireSeg(PROGRESS_HANDLERS);
  return primed.then(() => (intakeCurrent(token) ? paintIntake(token, today) : undefined));
}

Object.assign(globalThis, { renderIntake });

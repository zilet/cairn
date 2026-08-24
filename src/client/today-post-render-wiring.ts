// @ts-check
// Today post-render DOM wiring: quick capture, cardio/apply/date controls,
// and side loader dispatch after the Today HTML swap.

type TodayPostRenderState = {
  logDate: string;
  day: number | null;
  dayPicked?: boolean;
  dayPickedOn?: string | null;
  chatPrefill?: string | null;
  capturePrefill?: string | null;
};

type TodayPostRenderRead = {
  _provisional?: boolean;
  _cached?: boolean;
};

type TodayPostRenderWiringDeps = {
  root: HTMLElement;
  state: TodayPostRenderState;
  read: TodayPostRenderRead | null | undefined;
  isToday: boolean;
  showPlan: boolean;
  soft: boolean;
  conductorLeads: boolean;
  // When true, the rail is hydrated separately (progressive Today): skip both rail
  // loaders here so the first paint never waits on the agenda.
  deferRail?: boolean;
  agenda: Partial<ClientTodayAgenda> | null | undefined;
  agendaGeneric: ClientTodayAgendaCandidate[];
  updateHeaderCondense(): void;
  runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
  reducedMotion(): boolean;
  wireCardioSync(root: ParentNode, onSync: () => unknown): unknown;
  renderToday(opts?: Record<string, unknown>): unknown;
  applyDayProgression(button: Element | null | undefined, day: number | null | undefined): unknown;
  wireBrief(read: TodayPostRenderRead | null | undefined, options: { isToday: boolean }): unknown;
  upgradeBriefInPlace(date: string, isToday: boolean): unknown;
  loadTrainingProvenance(isToday: boolean): unknown;
  loadTableHint(): unknown;
  setupWeightChip(): unknown;
  loadFrequentFoods(): unknown;
  loadContextBanner(): unknown;
  loadHealthFocusBanner(): unknown;
  loadWearable(isToday: boolean): unknown;
  loadCheckin(): unknown;
  runAgendaRail(
    agenda: Partial<ClientTodayAgenda> | null | undefined,
    genericPending: ClientTodayAgendaCandidate[],
    deps: ClientTodayRailControllerDeps,
  ): void;
  runFallbackRail(isToday: boolean, deps: ClientTodayRailControllerDeps): void;
  todayRailDeps(): ClientTodayRailControllerDeps;
  activateTab(tab: string): unknown;
  withViewTransition(fn: () => unknown): Promise<unknown> | unknown;
  viewEnter(): void;
  localISO(): string;
  toast(message: string): void;
};

type TodayPostRenderWiringApi = {
  applyPendingCapture(deps: TodayPostRenderWiringDeps): boolean;
  wirePostRender(deps: TodayPostRenderWiringDeps): void;
};

(() => {
  function applyPendingCapture(deps: TodayPostRenderWiringDeps): boolean {
    const phrase = String(deps.state.capturePrefill || "").trim();
    if (!phrase) return false;
    deps.state.capturePrefill = null;
    deps.state.chatPrefill = phrase;
    deps.activateTab("chat");
    return true;
  }

  function wirePostRender(deps: TodayPostRenderWiringDeps): void {
    deps.updateHeaderCondense();
    deps.runCountUps(deps.root, { snap: deps.soft });

    if (applyPendingCapture(deps)) return;

    deps.root.querySelectorAll<HTMLElement>("[data-cardio-log]").forEach((button) => button.addEventListener("click", () => {
      const phrase = String(button.dataset.cardioLog || "").trim();
      if (!phrase) return;
      deps.state.chatPrefill = phrase;
      deps.activateTab("chat");
    }));

    deps.wireCardioSync(deps.root, () => deps.renderToday({ soft: true }));

    const applyButton = deps.root.querySelector<HTMLElement>("#rxApplyBtn");
    applyButton?.addEventListener("click", () => {
      const day = Number(applyButton.dataset.rxDay);
      deps.applyDayProgression(applyButton, Number.isFinite(day) ? day : deps.state.day);
    });

    deps.wireBrief(deps.read, { isToday: deps.isToday });
    // A provisional placeholder upgrades visibly (thinking → settle); a cached
    // paint reconciles SILENTLY against the network fetch (swaps only on a real
    // content change). Both await the in-flight promise inside upgradeBriefInPlace.
    if (deps.read?._provisional || deps.read?._cached) deps.upgradeBriefInPlace(deps.state.logDate, deps.isToday);
    if (deps.showPlan) deps.loadTrainingProvenance(deps.isToday);

    deps.loadTableHint();
    deps.setupWeightChip();
    // Frequents ("Usual around now") + the ambient "how are you feeling?" check-in
    // ride the capture row, quiet by default (they render nothing until their
    // loader finds something worth a tap). The check-in also feeds dayRead, so
    // it stays load-bearing even though it's easy to miss at a glance.
    deps.loadFrequentFoods();
    deps.loadCheckin();
    deps.loadContextBanner();
    if (!deps.conductorLeads) deps.loadHealthFocusBanner();
    deps.loadWearable(deps.isToday);
    if (!deps.deferRail) {
      if (deps.agenda) {
        deps.runAgendaRail(deps.agenda, deps.agendaGeneric, deps.todayRailDeps());
      } else {
        deps.runFallbackRail(deps.isToday, deps.todayRailDeps());
      }
    }
    deps.root.querySelector("#backToday")?.addEventListener("click", () => {
      deps.state.logDate = deps.localISO();
      deps.state.day = null;
      deps.state.dayPicked = false;
      deps.state.dayPickedOn = null;
      // The stale ?date= outlives the state fix otherwise, and restores the day we
      // just left on the next cold launch.
      if (typeof syncRouteFromState === "function") syncRouteFromState("replace");
      deps.renderToday();
    });

    deps.root.querySelectorAll<HTMLElement>(".daybtn").forEach((button) => button.addEventListener("click", () => {
      deps.state.day = Number(button.dataset.day);
      // Choosing which plan day to run TODAY is not "browsing another day". Leaving
      // dayPicked set on today's own date would freeze a resumed PWA past midnight.
      const measuredToday = deps.localISO();
      deps.state.dayPicked = deps.state.logDate !== measuredToday;
      deps.state.dayPickedOn = deps.state.dayPicked ? measuredToday : null;
      deps.renderToday();
    }));
  }

  const CAIRN_TODAY_POST_RENDER_WIRING: TodayPostRenderWiringApi = {
    applyPendingCapture,
    wirePostRender,
  };

  Object.assign(globalThis, { CairnTodayPostRenderWiring: CAIRN_TODAY_POST_RENDER_WIRING });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayPostRenderWiring: CAIRN_TODAY_POST_RENDER_WIRING });
  }
})();

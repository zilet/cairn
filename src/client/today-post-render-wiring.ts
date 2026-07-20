// @ts-check
// Today post-render DOM wiring: quick capture, cardio/apply/date controls,
// and side loader dispatch after the Today HTML swap.

type TodayPostRenderState = {
  logDate: string;
  day: number | null;
  dayPicked?: boolean;
  chatPrefill?: string | null;
  capturePrefill?: string | null;
};

type TodayPostRenderRead = {
  _provisional?: boolean;
  _cached?: boolean;
};

type TodayPostRenderCompass = {
  paceOffer?: { ask?: string | null } | null;
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
  todayCompass: TodayPostRenderCompass;
  updateHeaderCondense(): void;
  runCountUps(root?: ParentNode | null, options?: { snap?: boolean }): void;
  quickLog(): unknown;
  reducedMotion(): boolean;
  wireCardioSync(root: ParentNode, onSync: () => unknown): unknown;
  renderToday(opts?: Record<string, unknown>): unknown;
  applyDayProgression(button: Element | null | undefined, day: number | null | undefined): unknown;
  wireBrief(read: TodayPostRenderRead | null | undefined, options: { isToday: boolean }): unknown;
  upgradeBriefInPlace(date: string, isToday: boolean): unknown;
  loadTrainingProvenance(isToday: boolean): unknown;
  loadTableHint(): unknown;
  setupWeightChip(): unknown;
  setupVoiceCapture(): unknown;
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
    const input = deps.root.querySelector<HTMLInputElement>("#qlInput");
    if (!input) return false;
    deps.state.capturePrefill = null;
    input.value = phrase;
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
    input.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "center" });
    deps.toast("Review the activity, then press Enter to log it");
    return true;
  }

  function wirePostRender(deps: TodayPostRenderWiringDeps): void {
    deps.updateHeaderCondense();
    deps.runCountUps(deps.root, { snap: deps.soft });

    const quickLogButton = deps.root.querySelector("#qlBtn");
    const quickLogInput = deps.root.querySelector<HTMLInputElement>("#qlInput");
    quickLogButton?.addEventListener("click", () => deps.quickLog());
    quickLogInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") deps.quickLog();
    });
    applyPendingCapture(deps);

    deps.root.querySelectorAll<HTMLElement>("[data-cardio-log]").forEach((button) => button.addEventListener("click", () => {
      const input = deps.root.querySelector<HTMLInputElement>("#qlInput");
      if (!input) return;
      input.value = button.dataset.cardioLog || "";
      input.focus();
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {}
      input.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "center" });
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
    deps.setupVoiceCapture();
    // Frequents ("Usual around now") + the "how are you feeling?" check-in were
    // removed from Today — food variations weren't useful and Chat handles logging
    // and how-you-feel far more naturally (where the user actually does it).
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
    deps.root.querySelector("#goalLine")?.addEventListener("click", () => deps.activateTab("progress"));

    deps.root.querySelector("#paceOffer")?.addEventListener("click", () => {
      deps.state.chatPrefill = deps.todayCompass.paceOffer?.ask || "";
      deps.activateTab("chat");
    });

    deps.root.querySelector("#backToday")?.addEventListener("click", () => {
      deps.state.logDate = deps.localISO();
      deps.state.day = null;
      deps.state.dayPicked = false;
      deps.renderToday();
    });

    deps.root.querySelectorAll<HTMLElement>(".daybtn").forEach((button) => button.addEventListener("click", () => {
      deps.state.day = Number(button.dataset.day);
      deps.state.dayPicked = true;
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

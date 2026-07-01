// @ts-check
// Shared Today header/date-picker behavior for the legacy UI shell.

type UiHeaderState = {
  tab?: unknown;
  logDate?: string;
  day?: unknown;
  dayPicked?: boolean;
};

type UiHeaderDeps = {
  headerTitle: HTMLElement;
  state: UiHeaderState;
  escapeHtml(value: unknown): string;
  dateLabel(iso: string): string;
  localISO(date?: Date): string;
  syncRouteFromState(): unknown;
  renderToday(): unknown;
};

type UiHeaderClientApi = {
  setTodayHeaderTitle(deps: UiHeaderDeps): void;
  updateHeaderCondense(deps: { state: UiHeaderState }): void;
  installHeaderCondenseScroll(depsFor: () => { state: UiHeaderState }): void;
};

(() => {
  let scrollInstalled = false;

  function setTodayHeaderTitle(deps: UiHeaderDeps): void {
    deps.headerTitle.innerHTML =
      `${deps.escapeHtml(deps.dateLabel(deps.state.logDate || deps.localISO()))}<span class="hdr-chev" aria-hidden="true">▾</span>` +
      `<input type="date" class="hdr-datepick" aria-label="Choose a date to view or log a past workout">`;
    deps.headerTitle.classList.add("hdr-tappable");
    const inp = deps.headerTitle.querySelector<HTMLInputElement>(".hdr-datepick");
    if (!inp) return;
    inp.value = deps.state.logDate || deps.localISO();
    inp.max = deps.localISO();
    inp.addEventListener("click", () => { try { inp.showPicker?.(); } catch { /* unsupported → native focus */ } });
    inp.addEventListener("change", () => {
      if (!inp.value) return;
      deps.state.logDate = inp.value;
      deps.state.day = null;
      deps.state.dayPicked = false;
      deps.syncRouteFromState();
      deps.renderToday();
    });
  }

  function updateHeaderCondense(deps: { state: UiHeaderState }): void {
    const on = deps.state.tab === "today" && window.scrollY > 6;
    document.querySelector("header")?.classList.toggle("condensed", on);
  }

  function installHeaderCondenseScroll(depsFor: () => { state: UiHeaderState }): void {
    if (scrollInstalled) return;
    scrollInstalled = true;
    window.addEventListener("scroll", () => updateHeaderCondense(depsFor()), { passive: true });
  }

  const CAIRN_UI_HEADER: UiHeaderClientApi = {
    installHeaderCondenseScroll,
    setTodayHeaderTitle,
    updateHeaderCondense,
  };

  Object.assign(globalThis, { CairnUiHeader: CAIRN_UI_HEADER });

  if (typeof window !== "undefined") {
    window.CairnUiHeader = CAIRN_UI_HEADER;
  }
})();

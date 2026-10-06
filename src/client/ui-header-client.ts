// @ts-check
// Shared Today header behavior (the date eyebrow, the condensed band on scroll).

type UiHeaderState = {
  tab?: unknown;
  logDate?: string;
  day?: unknown;
  dayPicked?: boolean;
  dayPickedOn?: string | null;
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
  setEyebrowTitle(el: HTMLElement, text: string): void;
  shortDate(iso: string): string;
  updateHeaderCondense(deps: { state: UiHeaderState }): void;
  installHeaderCondenseScroll(depsFor: () => { state: UiHeaderState }): void;
};

(() => {
  let scrollInstalled = false;

  // Today is Home (v2 wave 7): Today only ever shows today, so its header is a plain
  // mono eyebrow that says so, "Today · Tue 29 Sep", never a date picker. The Brief's
  // voice line below stays the page's one focal point. Another day is its own
  // destination (the day view, day-record-client.ts), reached from a day in a week.
  // "Tue 29 Sep" — the one short date every Today-home header prints (Today, a day, Fuel).
  function shortDate(iso: string): string {
    return /^\d{4}-\d{2}-\d{2}/.test(String(iso || ""))
      ? `${CairnFmt.date(iso, { fmt: { weekday: "short" } })} ${Number(String(iso).slice(8, 10))} ${CairnFmt.date(iso, { fmt: { month: "short" } })}`
      : String(iso || "");
  }

  function headerDateText(deps: UiHeaderDeps): string {
    return `Today · ${shortDate(deps.localISO())}`;
  }

  // The Today home's sub-views (a day, Fuel) wear the same mono eyebrow as Today:
  // "Fuel · Tue 29 Sep", "Mon 28 Sep". Plain text, never a control.
  function setEyebrowTitle(el: HTMLElement, text: string): void {
    el.textContent = text;
    el.classList.remove("hdr-tappable");
    el.classList.add("hdr-eyebrow");
  }

  function setTodayHeaderTitle(deps: UiHeaderDeps): void {
    deps.headerTitle.innerHTML = `<span class="hdr-date">${deps.escapeHtml(headerDateText(deps))}</span>`;
    deps.headerTitle.classList.remove("hdr-tappable");
    deps.headerTitle.classList.add("hdr-eyebrow");
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
    setEyebrowTitle,
    shortDate,
    setTodayHeaderTitle,
    updateHeaderCondense,
  };

  Object.assign(globalThis, { CairnUiHeader: CAIRN_UI_HEADER });

  if (typeof window !== "undefined") {
    window.CairnUiHeader = CAIRN_UI_HEADER;
  }
})();

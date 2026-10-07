// @ts-check
// Opening a day from markup. EAGER, and deliberately tiny: any element carrying
// `data-open-day="YYYY-MM-DD"` (a week row, a calendar square, the day page's own
// stepper) opens that day's page through ONE delegated listener, so a surface in any
// bundle needs no reference to the day view. Where the page lives, which tab stays lit
// and where Back goes are the drill controller's (drill-controller.ts, the lazy
// "calendar" bundle), the only place that builds a day URL or activates the day view.
{
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function openDayFrom(el: HTMLElement): void {
    const date = String(el.dataset.openDay || "");
    if (!ISO.test(date)) return;
    void withBundle("calendar", () => CairnDrill.open("day", date, { mode: "page" }));
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const el = target?.closest<HTMLElement>("[data-open-day]");
      if (!el || el.hasAttribute("disabled")) return;
      event.preventDefault();
      openDayFrom(el);
    });
    // Keyboard: a non-button row carrying it takes Enter/Space.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target instanceof Element ? event.target : null;
      const el = target?.closest<HTMLElement>("[data-open-day]");
      if (!el || el.tagName === "BUTTON" || el.tagName === "A") return;
      event.preventDefault();
      openDayFrom(el);
    });
  }
}

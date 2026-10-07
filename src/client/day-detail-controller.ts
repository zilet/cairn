// @ts-check
// The day detail, the controller: `mount(host, deps)` opens one day into `host` from
// GET /api/plan/day-detail?date= — a warm paint from the SWR cache when there is one
// (no skeleton flash), else the skeleton, then the revalidated read, repainted only
// when it changed. Each movement's name opens its exercise detail (wireGuides). Used by
// Today's "What's ahead" strip for its inline day; the day view composes the same
// renderer with its record. Async paints check the mount is still current and the host
// still connected. Returns a teardown.
//
// LAZY ("calendar" bundle).
{
  type DayDetail = import("../contracts/day-detail.js").DayDetail;
  type DayDetailMountDeps = {
    date: string;
    peek(key: string): { data: unknown; fresh: boolean } | null;
    load(path: string, options: { key: string }): Promise<unknown>;
    /** The compact form under Today's strip. */
    inline?: boolean;
    /** Called after each paint with the read (null when the day could not be read). */
    painted?(detail: DayDetail | null): void;
  };

  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function keyOf(date: string): string {
    return `plan:day-detail:${date}`;
  }

  function pathOf(date: string): string {
    return `/plan/day-detail?date=${encodeURIComponent(date)}`;
  }

  function isDetail(value: unknown): value is DayDetail {
    return (
      !!value &&
      typeof value === "object" &&
      typeof (value as { date?: unknown }).date === "string" &&
      "status" in (value as object)
    );
  }

  function mountDayDetail(host: Element, deps: DayDetailMountDeps): () => void {
    let live = true;
    let last = "";
    const date = String(deps.date || "");
    const target = host as HTMLElement;
    const paint = (value: unknown): void => {
      if (!live || !host.isConnected) return;
      const detail = isDetail(value) ? value : null;
      const html = detail
        ? CairnDayDetailView.dayDetailHtml(detail, { inline: deps.inline === true })
        : CairnDayDetailView.errorHtml();
      if (html === last) return;
      last = html;
      target.innerHTML = html;
      target.removeAttribute("aria-busy");
      if (typeof wireGuides === "function") {
        try {
          wireGuides(host);
        } catch {}
      }
      deps.painted?.(detail);
    };
    if (!ISO.test(date)) {
      paint(null);
      return () => {
        live = false;
      };
    }
    const warm = deps.peek(keyOf(date));
    if (warm && isDetail(warm.data)) paint(warm.data);
    else {
      target.setAttribute("aria-busy", "true");
      target.innerHTML = CairnDayDetailView.skeletonHtml();
    }
    deps
      .load(pathOf(date), { key: keyOf(date) })
      .then((value) => paint(value))
      .catch(() => {
        // A failed read keeps a warm paint; a cold one says so in one calm line.
        if (!last) paint(null);
      });
    return () => {
      live = false;
    };
  }

  const CAIRN_DAY_DETAIL_CONTROLLER = { mount: mountDayDetail, keyOf, pathOf, isDetail };

  Object.assign(globalThis, { CairnDayDetailController: CAIRN_DAY_DETAIL_CONTROLLER });
}

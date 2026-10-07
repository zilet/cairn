// @ts-check
// Today's ONE glance into Horizon (docs/IA.md "Tab model"): a single line under the
// week strip — "26 days to Cambridge · Sharpen, wk 6 of 6 ›" — that opens Horizon's
// Week. The race estimate, the weight and lift goals, the trail and the dated road
// ahead live on Horizon in full; Today only glances at them. The line and its href are
// the server's (GET /api/today-path `frame.glance`, week-stage.ts weekFrameLine): this
// file never composes a countdown or a stage word. Pure string builder; escaped.

type TodayPathRead = import("../contracts/today-path.js").TodayPath;

(() => {
  /** The glance line; "" when the server has no frame to glance at. */
  function glanceHtml(path: TodayPathRead | null | undefined): string {
    const glance = path && typeof path === "object" ? path.frame?.glance : null;
    const line = String(glance?.line ?? "").trim();
    if (!line) return "";
    const href = String(glance?.href || "/app/horizon");
    return `<a class="tglance" href="${escAttr(href)}" data-tpath-goals><span class="tglance-t">${escHtml(line)}</span><span class="tglance-go" aria-hidden="true">›</span></a>`;
  }

  const CAIRN_TODAY_PATH = { glanceHtml };

  Object.assign(globalThis, { CairnTodayPath: CAIRN_TODAY_PATH });
})();

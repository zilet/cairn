// @ts-check
// Mounts Today's one Horizon glance line (CairnTodayPath.glanceHtml) into the slot the
// Brief owns. Reads GET /api/today-path through the SWR cache, so a warm Today paints
// the line at once and a revalidation repaints only when it moved. Optional: a cold
// miss or a failed read leaves the slot empty (it collapses). A plain tap opens
// Horizon (its Week, always) through `openHorizon`, the app's own tab switch; a
// modified click keeps the link's real href. Idempotent per host (CairnUiActions.mount).
{
  type TodayPathRead = import("../contracts/today-path.js").TodayPath;
  type TodayPathDeps = {
    date: string;
    peek(key: string): { data: TodayPathRead; fresh: boolean } | null;
    load(path: string, options: { key: string }): Promise<TodayPathRead>;
    /** Open Horizon; without it the link navigates by its href. */
    openHorizon?(): void;
  };

  function modifiedClick(event: Event): boolean {
    const e = event as MouseEvent;
    return !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (typeof e.button === "number" && e.button !== 0));
  }

  function pathKey(date: string): string {
    return `today:path:${date}`;
  }

  function pathPath(date: string): string {
    return `/today-path?date=${encodeURIComponent(date)}`;
  }

  function mountPath(host: Element, deps: TodayPathDeps): () => void {
    return CairnUiActions.mount(host, "today-path", ({ delegate }) => {
      delegate("click", {
        "tpath-goals": (_el, event) => {
          if (!deps.openHorizon || modifiedClick(event)) return;
          event.preventDefault();
          deps.openHorizon();
        },
      });
      let live = true;
      let painted = "";
      const paint = (read: TodayPathRead | null | undefined): void => {
        if (!live || !host.isConnected) return;
        const html = CairnTodayPath.glanceHtml(read);
        if (html === painted) return;
        painted = html;
        host.innerHTML = html;
      };
      const key = pathKey(deps.date);
      const warm = deps.peek(key);
      if (warm) paint(warm.data);
      deps
        .load(pathPath(deps.date), { key })
        .then(paint)
        .catch(() => {});
      return () => {
        live = false;
      };
    });
  }

  const CAIRN_TODAY_PATH_CONTROLLER = { key: pathKey, path: pathPath, mount: mountPath };

  Object.assign(globalThis, { CairnTodayPathController: CAIRN_TODAY_PATH_CONTROLLER });
}

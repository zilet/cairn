// @ts-check
// The Program look-ahead, the controller. `mount(host, deps)` fills the week section the
// Program landing painted (its `[data-pahead-body]` slot) from GET /api/plan/look-ahead:
// the SWR cache first (a warm open never flashes a skeleton), then a quiet revalidate
// that repaints only when the read changed. Each day row opens through the app's one
// delegated `data-open-day` opener, so this wires only the empty state's two doors (and
// the exercise names of an undated day opened in place).
// Idempotent per host through CairnUiActions.mount; returns the teardown.
{
  const KEY = "plan:look-ahead";
  const PATH = "/plan/look-ahead";

  function mountProgramWeek(host: Element, deps: ClientProgramWeekDeps): () => void {
    let generation = 0;
    let painted = false;
    const slot = (): HTMLElement | null => host.querySelector<HTMLElement>("[data-pahead-body]");
    const live = (gen: number): boolean => gen === generation && host.isConnected;
    const paint = (data: unknown): void => {
      const target = slot();
      if (!target) return;
      painted = true;
      target.innerHTML = CairnProgramWeek.bodyHtml(CairnProgramWeekModel.programWeekModel(data));
      // An undated day opened in place lists its movements; each name opens its exercise detail.
      if (typeof wireGuides === "function") {
        try {
          wireGuides(target);
        } catch {}
      }
    };

    const teardown = CairnUiActions.mount(host, "pahead", ({ delegate }) => {
      delegate("click", {
        "pahead-edit": () => deps.editPlan(),
        "pahead-ask": (el) => deps.ask(el?.dataset.paheadAsk || undefined),
      });
      return () => {
        generation += 1;
      };
    });

    const gen = ++generation;
    const peek = deps.peekCached(KEY);
    if (peek) paint(peek.data);
    else {
      const target = slot();
      if (target && !target.firstElementChild) target.innerHTML = CairnProgramWeek.skeletonHtml();
    }
    deps
      .cachedApi(PATH, {
        key: KEY,
        onUpgrade: (data, { changed }) => {
          if (live(gen) && (changed || !peek)) paint(data);
        },
      })
      .then((data) => {
        if (live(gen) && !painted) paint(data);
      })
      .catch(() => {
        // A failed read keeps a held paint; a cold one says so in one calm line.
        if (live(gen) && !painted) paint(null);
      });
    return teardown;
  }

  const CAIRN_PROGRAM_WEEK_CONTROLLER = { KEY, PATH, mount: mountProgramWeek };

  Object.assign(globalThis, { CairnProgramWeekController: CAIRN_PROGRAM_WEEK_CONTROLLER });
}

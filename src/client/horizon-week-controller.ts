// @ts-check
// Horizon's Week, the controller (docs/IA.md "Horizon landing"): `mount(slot, deps)` reads
// GET /api/week through the SWR cache — the last-known week paints at once, the
// revalidated read upgrades it in place only when the JSON changed — and paints the
// landing (horizon-week-client.ts). A column tap PEEKS the day: the fold under the shape
// opens and the drill controller (CairnDrill, the "calendar" bundle, which horizon
// depends on) mounts the day's compact view into it, adds ?peek= to history and ends it
// with "Open day ›" (the day's page, read under Horizon). Tapping the open column again,
// its Close, or Back folds it. A row (the day-by-day rows, still open) opens the day's
// page through `data-open-day` (day-open-client.ts → CairnDrill). "All of the season ›"
// hands over to the screen. Fetch + paint + delegate only; every word is the read's.
{
  type Deps = {
    peek(key: string): { data: unknown; fresh: boolean } | null;
    load(path: string, options: { key: string }): Promise<unknown>;
    reducedMotion?(): boolean;
    /** The Season view's real URL, for the "All of the season ›" link. */
    seasonHref?: string;
    /** Every read that paints (the frame and the weight goal ride to the other views). */
    onRead?(read: unknown): void;
    /** The read failed with nothing to show: the screen asks again on the next open. */
    onFail?(): void;
    /** "All of the season ›". */
    onSeason?(): void;
  };

  /** The week's read and its SWR key (under "plan:", so every plan write refreshes it). */
  const WEEK: readonly [string, string] = ["/week", "plan:week-read"];

  function modified(event: Event): boolean {
    const e = event as MouseEvent;
    return !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (typeof e.button === "number" && e.button !== 0));
  }

  function mountHorizonWeek(slot: Element, deps: Deps): () => void {
    let live = true;
    let lastRaw = "";
    let model: ClientWeekLanding | null = null;
    let selected: string | null = null;
    let detailTeardown: (() => void) | null = null;
    const host = slot as HTMLElement;
    const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);
    const drill = (): typeof CairnDrill | null => (typeof CairnDrill !== "undefined" ? CairnDrill : null);

    function markSelected(): void {
      host.querySelectorAll<HTMLElement>("[data-week-day]").forEach((btn) => {
        btn.setAttribute("aria-expanded", btn.getAttribute("data-week-day") === selected ? "true" : "false");
      });
    }

    function closeDay(focusBack = true): void {
      const was = selected;
      selected = null;
      detailTeardown?.();
      detailTeardown = null;
      const fold = q("[data-hwk-fold]");
      if (fold) {
        fold.classList.remove("is-open");
        fold.setAttribute("inert", "");
      }
      markSelected();
      if (focusBack && was) q<HTMLElement>(`[data-week-day="${was}"]`)?.focus();
    }

    function openDay(date: string): void {
      const fold = q("[data-hwk-fold]");
      const peekHost = q("[data-hwk-peek]");
      const d = drill();
      if (!fold || !peekHost || !d) return;
      selected = date;
      markSelected();
      detailTeardown?.();
      fold.classList.add("is-open");
      fold.removeAttribute("inert");
      fold.setAttribute("aria-label", q(`[data-week-day="${date}"]`)?.getAttribute("aria-label") || "The day opened");
      detailTeardown = d.open("day", date, {
        mode: "peek",
        from: "horizon",
        host: peekHost,
        peek: deps.peek,
        load: deps.load,
        onClose: () => closeDay(),
        onShow: (id) => openDay(id),
      });
    }

    /** Fold the open day: through the drill (its history entry goes too) when it holds it. */
    function foldDay(): void {
      const d = drill();
      if (d && d.owns(q("[data-hwk-peek]"))) {
        d.closePeek();
        return;
      }
      closeDay();
    }

    function paint(value: unknown, enter: boolean): void {
      if (!live || !host.isConnected) return;
      let raw = "";
      try {
        raw = JSON.stringify(value) ?? "";
      } catch {}
      const next = CairnWeekModel.landing(value);
      if (!next) {
        // A failed read never replaces a week already on screen.
        if (!model) {
          host.innerHTML = CairnHorizonWeek.errorHtml();
          deps.onFail?.();
        }
        return;
      }
      if (raw && raw === lastRaw) return;
      lastRaw = raw;
      model = next;
      deps.onRead?.(value);
      // A peek open across the repaint stays open; an address naming one (Back from the
      // day's page) opens it again.
      const keep = selected || drill()?.peeked() || null;
      detailTeardown?.();
      detailTeardown = null;
      selected = null;
      const calm = typeof deps.reducedMotion === "function" ? deps.reducedMotion() : false;
      host.innerHTML = CairnHorizonWeek.landingHtml(next, { enter: enter && !calm, seasonHref: deps.seasonHref });
      if (keep && next.days.some((d) => d.date === keep)) openDay(keep);
    }

    const teardown = CairnUiActions.mount(host, "hwk", ({ delegate }) => {
      delegate("click", {
        "week-day": (el) => {
          const date = el.getAttribute("data-week-day") || "";
          if (!date) return;
          if (selected === date) foldDay();
          else openDay(date);
        },
        "hwk-season": (el, event) => {
          if (modified(event)) return;
          event.preventDefault();
          deps.onSeason?.();
        },
      });
      return () => {
        live = false;
        detailTeardown?.();
        detailTeardown = null;
        const d = drill();
        const peekHost = q("[data-hwk-peek]");
        if (d && peekHost) d.release(peekHost);
      };
    });

    const warm = deps.peek(WEEK[1]);
    if (warm && CairnWeekModel.landing(warm.data)) paint(warm.data, false);
    else host.innerHTML = CairnHorizonWeek.skeletonHtml();
    Promise.resolve()
      .then(() => deps.load(WEEK[0], { key: WEEK[1] }))
      .then(
        (value) => paint(value, !warm),
        () => paint(null, false)
      );
    return teardown;
  }

  const CAIRN_HORIZON_WEEK_CONTROLLER = { mount: mountHorizonWeek, WEEK };

  Object.assign(globalThis, { CairnHorizonWeekController: CAIRN_HORIZON_WEEK_CONTROLLER });
}

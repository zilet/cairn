// @ts-check
// Today's "What's ahead" strip, the controller: `mount(slot, deps)` paints the strip
// from GET /api/plan/week (the SWR cache first, then the revalidated read), and opens a
// tapped day INLINE: the fold under the strip grows open (grid rows 0fr → 1fr) and the
// shared day detail mounts into it through withBundle("day") — the same view Horizon's
// week and Train's week ahead open. Tapping the open day again, or Close, folds it.
// "Open in Horizon" takes the day to its full view under Horizon. A repaint of the week
// rewrites only the days, the header line and today's line, so an open day stays open.
// The header's block clock and run plan arrive from the path read through `setHeader`.
// Delegated on the slot through CairnUiActions.mount (idempotent per slot); the SLOT
// node rides the Brief's in-place upgrade (carryBriefSlots), so its listeners and any
// paint still to land stay on screen. Returns the teardown.
//
// LAZY (today-ahead bundle). Reached from today-ahead-mount.ts through withBundle.
{
  type PlanWeek = import("../contracts/client-api.js").ClientPlanWeek;
  type TodayStripDeps = {
    /** Today's local date. */
    date: string;
    peek(key: string): { data: unknown; fresh: boolean } | null;
    load(path: string, options: { key: string }): Promise<unknown>;
    /** Open a day's full view under Horizon (today: Horizon's week). */
    openInHorizon(date: string): void;
  };

  type StripHeader = { block?: string; kmPlanned?: number | null; units?: string };

  const WEEK: readonly [string, string] = ["/plan/week", "plan:week"];
  /** The day open under each Today's strip, for this app session (a repaint remounts the strip). */
  const OPEN = new Map<string, string>();
  /** Every mounted strip, so a tap on one that is being replaced reaches its successor. */
  const LIVE = new Set<(date: string | null) => void>();
  /**
   * What each slot's header says beside the week's counts (the block clock, the week's
   * run plan), set by Today's ahead controller from the path read — it may land before
   * or after the week does, and survives the slot being carried across a Brief upgrade.
   */
  const HEADER = new WeakMap<Element, StripHeader>();
  /** Each mounted slot's own repaint of its header line. */
  const REPAINT = new WeakMap<Element, () => void>();

  /** The athlete's run units from the warm settings read; km until it is known. */
  function unitsOf(deps: Pick<TodayStripDeps, "peek">): string {
    const warm = deps.peek("settings")?.data as { settings?: { run_units?: unknown } } | null | undefined;
    const raw = String(warm?.settings?.run_units ?? "").toLowerCase();
    return raw === "mi" || raw === "mile" || raw === "miles" ? "mi" : "km";
  }

  /** Set the block clock / the week's run plan on a slot's strip (painted now or on its first paint). */
  function setHeader(slot: Element, header: StripHeader): void {
    HEADER.set(slot, { ...(HEADER.get(slot) || {}), ...header });
    REPAINT.get(slot)?.();
  }

  function mountTodayStrip(slot: Element, deps: TodayStripDeps): () => void {
    let live = true;
    let week: PlanWeek | null = null;
    let selected: string | null = null;
    let detailTeardown: (() => void) | null = null;
    let lastDays = "";
    let lastNow = "";
    let lastTally = "";
    let lastBlock = "";
    let first = true;
    const host = slot as HTMLElement;
    const q = <T extends Element = HTMLElement>(sel: string): T | null => slot.querySelector<T>(sel);
    const header = (): StripHeader => ({ ...(HEADER.get(slot) || {}), units: unitsOf(deps) });

    // The header line and the block clock, rewritten only on a change.
    function paintHeader(): void {
      if (!live || !slot.isConnected || !week || first) return;
      const head = header();
      const nextTally = CairnTodayStrip.tallyHtml(week, head);
      const tally = q("[data-tstrip-tally]");
      if (tally && nextTally !== lastTally) {
        tally.innerHTML = nextTally;
        lastTally = nextTally;
      }
      const nextBlock = String(head.block || "");
      const block = q("[data-tstrip-block]");
      if (block && nextBlock !== lastBlock) {
        block.textContent = nextBlock;
        lastBlock = nextBlock;
      }
    }
    REPAINT.set(slot, paintHeader);

    function paint(value: unknown): void {
      if (!live || !slot.isConnected) return;
      week = value && typeof value === "object" ? (value as PlanWeek) : null;
      const cells = CairnTodayStrip.cellsOf(week, deps.date);
      if (!cells) {
        closeDay(false);
        host.innerHTML = "";
        lastDays = "";
        lastNow = "";
        return;
      }
      if (selected && !cells.some((c) => c.date === selected)) closeDay(false);
      const days = q("[data-tstrip-days]");
      if (!days || first) {
        // This mount's first paint owns the whole strip (a carried or held node's old
        // markup is not ours — its listeners died with it).
        first = false;
        const head = header();
        host.innerHTML = CairnTodayStrip.stripHtml(week, deps.date, null, head);
        lastDays = CairnTodayStrip.daysHtml(cells, null);
        lastNow = CairnTodayStrip.nowHtml(week, cells);
        lastTally = CairnTodayStrip.tallyHtml(week, head);
        lastBlock = String(head.block || "");
        // A day opened before Today repainted stays open across the repaint.
        const keep = selected || OPEN.get(deps.date) || null;
        selected = null;
        if (keep && cells.some((c) => c.date === keep)) openDay(keep);
        return;
      }
      // An open day stays open: only the days, the header and today's line are rewritten, and only on a change.
      const nextDays = CairnTodayStrip.daysHtml(cells, selected);
      if (nextDays !== lastDays) {
        days.innerHTML = nextDays;
        lastDays = nextDays;
      }
      const nextNow = CairnTodayStrip.nowHtml(week, cells);
      const now = q("[data-tstrip-now]");
      if (now && nextNow !== lastNow) {
        now.innerHTML = nextNow;
        lastNow = nextNow;
      }
      paintHeader();
    }

    function markSelected(): void {
      slot.querySelectorAll<HTMLElement>("[data-tstrip-day]").forEach((btn) => {
        btn.setAttribute("aria-expanded", btn.getAttribute("data-tstrip-day") === selected ? "true" : "false");
      });
      // The pressed state is part of the days' markup; keep the change-check honest.
      const cells = CairnTodayStrip.cellsOf(week, deps.date);
      if (cells) lastDays = CairnTodayStrip.daysHtml(cells, selected);
    }

    function closeDay(focusBack = true): void {
      const was = selected;
      selected = null;
      OPEN.delete(deps.date);
      detailTeardown?.();
      detailTeardown = null;
      const fold = q("[data-tstrip-fold]");
      if (fold) {
        fold.classList.remove("is-open");
        fold.setAttribute("inert", "");
      }
      markSelected();
      if (focusBack && was) q<HTMLElement>(`[data-tstrip-day="${was}"]`)?.focus();
    }

    function openDay(date: string): void {
      const fold = q("[data-tstrip-fold]");
      const detail = q("[data-tstrip-detail]");
      if (!fold || !detail) return;
      selected = date;
      OPEN.set(deps.date, date);
      markSelected();
      detailTeardown?.();
      detailTeardown = null;
      detail.innerHTML = "";
      fold.classList.add("is-open");
      fold.removeAttribute("inert");
      const label = q(`[data-tstrip-day="${date}"]`)?.getAttribute("aria-label") || "The day opened";
      fold.setAttribute("aria-label", label);
      void withBundle("day", () => {
        if (!live || selected !== date || !detail.isConnected) return;
        if (typeof CairnDayDetailController !== "undefined") {
          detailTeardown = CairnDayDetailController.mount(detail, {
            date,
            peek: deps.peek,
            load: deps.load,
            inline: true,
          });
        }
      });
    }

    // Another strip of the same Today (a repaint mid-tap) follows what this one was told.
    const follow = (date: string | null): void => {
      if (!live || !slot.isConnected) {
        LIVE.delete(follow); // a strip Today has let go of stops listening
        return;
      }
      if (date === selected) return;
      if (date) openDay(date);
      else closeDay(false);
    };
    const tell = (date: string | null): void => {
      for (const other of LIVE) if (other !== follow) other(date);
    };
    LIVE.add(follow);

    const teardown = CairnUiActions.mount(slot, "tstrip", ({ delegate }) => {
      delegate("click", {
        "tstrip-day": (el) => {
          const date = el.getAttribute("data-tstrip-day") || "";
          if (!date) return;
          if (selected === date) closeDay();
          else openDay(date);
          tell(selected);
        },
        "tstrip-close": () => {
          closeDay();
          tell(null);
        },
        "tstrip-horizon": () => {
          if (selected) deps.openInHorizon(selected);
        },
      });
      return () => {
        live = false;
        LIVE.delete(follow);
        if (REPAINT.get(slot) === paintHeader) REPAINT.delete(slot);
        detailTeardown?.();
        detailTeardown = null;
      };
    });

    const warm = deps.peek(WEEK[1]);
    if (warm) paint(warm.data);
    deps
      .load(WEEK[0], { key: WEEK[1] })
      .then((value) => paint(value))
      .catch(() => {});
    return teardown;
  }

  const CAIRN_TODAY_STRIP_CONTROLLER = { mount: mountTodayStrip, setHeader };

  Object.assign(globalThis, { CairnTodayStripController: CAIRN_TODAY_STRIP_CONTROLLER });
}

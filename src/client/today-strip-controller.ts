// @ts-check
// Today's "What's ahead" strip, the controller: `mount(slot, deps)` paints the strip
// from GET /api/plan/week (the SWR cache first, then the revalidated read), and opens a
// tapped day as a PEEK: the fold under the strip grows open (grid rows 0fr → 1fr) and
// the drill controller (CairnDrill, the "calendar" bundle) mounts the day's compact view
// into it, adds ?peek=<date> to history (so the phone's Back closes it) and ends it with
// one "Open day ›" — the day's page, read under Today. Tapping the open day again, its
// Close, or Back folds it; a Today painted on an entry whose address names a peek opens
// that day again. A repaint of the week rewrites only the days, the header note and
// today's line, so an open day stays open.
// The header's note (a running recovery week) arrives through `setHeader`.
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
  };

  type StripHeader = { block?: string };

  const WEEK: readonly [string, string] = ["/plan/week", "plan:week"];
  /** Every mounted strip, so a tap on one that is being replaced reaches its successor. */
  const LIVE = new Set<(date: string | null) => void>();
  /**
   * What each slot's header notes (a running recovery week), set by Today's ahead
   * controller — it may land before or after the week does, and survives the slot being
   * carried across a Brief upgrade.
   */
  const HEADER = new WeakMap<Element, StripHeader>();
  /** Each mounted slot's own repaint of its header note. */
  const REPAINT = new WeakMap<Element, () => void>();

  /** The day the address names as peeked (?peek=), the drill's word; null before it loads. */
  function peekedDay(): string | null {
    return typeof CairnDrill !== "undefined" ? CairnDrill.peeked() : null;
  }

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
    let lastBlock = "";
    let first = true;
    const host = slot as HTMLElement;
    const q = <T extends Element = HTMLElement>(sel: string): T | null => slot.querySelector<T>(sel);
    const header = (): StripHeader => HEADER.get(slot) || {};

    // The header note, rewritten only on a change.
    function paintHeader(): void {
      if (!live || !slot.isConnected || !week || first) return;
      const nextBlock = String(header().block || "");
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
        host.setAttribute("data-none", ""); // nothing to show: release the reserved space
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
        host.removeAttribute("data-none");
        const head = header();
        host.innerHTML = CairnTodayStrip.stripHtml(week, deps.date, null, head);
        lastDays = CairnTodayStrip.daysHtml(cells, null);
        lastNow = CairnTodayStrip.nowHtml(week, cells);
        lastBlock = String(head.block || "");
        // A day opened before Today repainted stays open across the repaint, and an
        // entry whose address names a peek (Back from the day's page) opens it again.
        const keep = selected || peekedDay();
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
      markSelected();
      detailTeardown?.();
      detailTeardown = null;
      fold.classList.add("is-open");
      fold.removeAttribute("inert");
      const label = q(`[data-tstrip-day="${date}"]`)?.getAttribute("aria-label") || "The day opened";
      fold.setAttribute("aria-label", label);
      void withBundle("calendar", () => {
        if (!live || selected !== date || !detail.isConnected) return;
        // The drill owns the peek: the compact view, its one "Open day ›", the history entry.
        detailTeardown = CairnDrill.open("day", date, {
          mode: "peek",
          from: "today",
          host: detail,
          peek: deps.peek,
          load: deps.load,
          onClose: () => {
            closeDay();
            tell(null);
          },
          onShow: (id) => openDay(id),
        });
      });
    }

    /** Fold the open day: through the drill (its history entry goes too) when it holds it. */
    function foldDay(): void {
      const detail = q("[data-tstrip-detail]");
      if (typeof CairnDrill !== "undefined" && CairnDrill.owns(detail)) {
        CairnDrill.closePeek();
        return;
      }
      closeDay();
      tell(null);
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
          if (selected === date) {
            foldDay();
            return;
          }
          openDay(date);
          tell(selected);
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
      .catch(() => {
        if (live && !host.firstElementChild) host.setAttribute("data-none", "");
      });
    return teardown;
  }

  const CAIRN_TODAY_STRIP_CONTROLLER = { mount: mountTodayStrip, setHeader };

  Object.assign(globalThis, { CairnTodayStripController: CAIRN_TODAY_STRIP_CONTROLLER });
}

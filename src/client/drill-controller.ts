// @ts-check
// The drill-down grammar, ONE controller (docs/IA.md "Drill-down grammar"):
// CairnDrill.open(kind, id, { from, mode }) opens an object at one of three depths.
//
//   - inline: the object's compact view mounted into a host the caller owns; no URL
//     change (a disclosure inside a card).
//   - peek:   the compact view inline under a strip (or in a sheet when no host is
//     given), ending with ONE "Open full ›" link ("Open day ›"). It adds ?peek=<id> to
//     history, so the phone's Back closes it (startup's popstate asks `popped()` first).
//   - page:   the object's canonical, HOME-FREE page (/app/day/<date>). The tab bar
//     keeps the OPENER's tab lit (state.drillFrom), Back is history.back() falling back
//     to the opener tab's root, and the back link names the opener ("‹ Horizon").
//
// This is the only place that builds a day URL (through CairnRoutes, which owns the
// grammar) or activates the day view: test/drillGrammar.test.js holds every other
// client module to that. Markup anywhere opens a day page with `data-open-day`
// (day-open-client.ts, eager, routes here).
//
// LAZY ("calendar" bundle), after the day views it mounts.
{
  type DrillKind = "day";
  type DrillMode = "inline" | "peek" | "page";
  type DrillOpts = {
    /** The opener's home (its tab stays lit); defaults to the home on screen. */
    from?: ClientHomeName | null;
    mode?: DrillMode;
    /** Where an inline or peek view mounts. A peek with none opens in a sheet. */
    host?: Element | null;
    peek?(key: string): { data: unknown; fresh: boolean } | null;
    load?(path: string, options: { key: string }): Promise<unknown>;
    /** A peek's own Close control (default true for a hosted peek). */
    closable?: boolean;
    /** The peek was closed (its Close, or Back): fold the host. */
    onClose?(): void;
    /** History moved the peek to another id (Forward): show that one instead. */
    onShow?(id: string): void;
  };
  type ActivePeek = {
    kind: DrillKind;
    id: string;
    path: string;
    host: Element;
    from: ClientHomeName;
    /** A sheet peek (no host of the caller's): it closes itself when another peek opens. */
    sheet: boolean;
    teardown(): void;
    close?(): void;
    show?(id: string): void;
  };

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  /** The one deeper link a peek ends with, per kind. */
  const FULL_WORD: Readonly<Record<DrillKind, string>> = { day: "Open day ›" };
  const noop = (): void => {};

  /** The peek this page has open (one at a time). */
  let active: ActivePeek | null = null;

  /** "Horizon" — a home as its tab-bar button names it. */
  function homeLabel(home: unknown): string {
    return String(home || "today").replace(/^./, (c) => c.toUpperCase());
  }

  /** The home on screen now: the opener, when nothing names one. */
  function openerHome(): ClientHomeName {
    const routes = window.CairnRoutes;
    const tab = state.tab;
    const section = tab === "plan" ? state.planJump || state.planSeg : tab === "day" ? state.drillFrom : null;
    const home = routes && typeof routes.homeOf === "function" ? routes.homeOf(tab, section) : "today";
    return (home || "today") as ClientHomeName;
  }

  /** The object's canonical page URL (route-state.ts owns the grammar). */
  function hrefOf(kind: DrillKind, id: string): string {
    return kind === "day" ? window.CairnRoutes?.routeToUrl({ tab: "day", date: id }) || "" : "";
  }

  // ---- history (?peek=) ----

  function peekParam(): string | null {
    try {
      const v = new URLSearchParams(location.search).get("peek");
      return v && ISO.test(v) ? v : null;
    } catch {
      return null;
    }
  }

  function peekUrl(id: string | null): string {
    const params = new URLSearchParams(location.search);
    if (id) params.set("peek", id);
    else params.delete("peek");
    const q = params.toString();
    return `${location.pathname}${q ? `?${q}` : ""}${location.hash || ""}`;
  }

  function entryState(): Record<string, unknown> {
    const hs = history.state;
    return hs && typeof hs === "object" ? { ...(hs as Record<string, unknown>) } : {};
  }

  // ---- views ----

  function mountView(kind: DrillKind, id: string, host: Element, opts: DrillOpts): () => void {
    if (kind !== "day" || typeof CairnDayDetailController === "undefined") return noop;
    return CairnDayDetailController.mount(host, {
      date: id,
      peek: opts.peek || ((key) => peekCached(key)),
      load: opts.load || ((path, options) => cachedApi(path, options) as Promise<unknown>),
      inline: true,
    });
  }

  /** A peek's frame: the compact view, then its one "Open full ›" (and a quiet Close). */
  function peekFrameHtml(kind: DrillKind, id: string, closable: boolean): string {
    const close = closable
      ? `<button type="button" class="linkbtn-quiet drill-close" data-drill-close>Close</button>`
      : "";
    return `<div class="drill-peek-body" data-drill-body></div>
      <div class="drill-foot">
        <button type="button" class="linkbtn linkbtn-plain drill-full" data-drill-full="${escAttr(kind)}" data-drill-id="${escAttr(id)}">${escHtml(FULL_WORD[kind])}</button>${close}
      </div>`;
  }

  // ---- the three depths ----

  function openPage(kind: DrillKind, id: string, opts: DrillOpts): void {
    // A page replaces whatever peek was open (Back into that entry reopens it from the URL).
    const was = active;
    active = null;
    was?.teardown();
    // Today is Home: the day that is today opens Today itself.
    if (id === localISO()) {
      activateTab("today");
      return;
    }
    const stepping = state.tab === "day";
    if (!stepping) {
      state.drillFrom = opts.from || openerHome();
      state.drillBack = true;
    }
    state.dayDate = id;
    try {
      window.scrollTo(0, 0);
    } catch {}
    // Stepping between days on the page replaces history rather than stacking an entry
    // per day, so Back still returns to the opener.
    if (stepping) {
      syncRouteFromState("replace");
      void renderTab("day");
      return;
    }
    activateTab("day");
  }

  /**
   * One peek at a time: the open one lets go of its view (a sheet also closes). A hosted
   * peek's host is not told: its successor is usually the same surface repainted.
   */
  function giveWay(): void {
    const was = active;
    if (!was) return;
    active = null;
    was.teardown();
    if (was.sheet) was.close?.();
  }

  function openPeek(kind: DrillKind, id: string, opts: DrillOpts): () => void {
    let host: Element | null = opts.host || null;
    let sheet: HTMLElement | null = null;
    if (!host) {
      const overlay = (globalThis as { CairnDetailOverlay?: { mountDetail(html: string): HTMLElement } })
        .CairnDetailOverlay;
      if (!overlay) {
        openPage(kind, id, opts);
        return noop;
      }
      giveWay();
      sheet = overlay.mountDetail(`<div class="drill-sheet" data-drill-sheet></div>`);
      host = sheet.querySelector("[data-drill-sheet]") || sheet;
    } else if (active && active.host !== host) {
      giveWay();
    } else {
      active?.teardown();
    }
    const from = opts.from || openerHome();
    host.innerHTML = peekFrameHtml(kind, id, !sheet && opts.closable !== false);
    const body = host.querySelector("[data-drill-body]") || host;
    const unmount = mountView(kind, id, body, opts);
    const peek: ActivePeek = {
      kind,
      id,
      path: location.pathname,
      host,
      from,
      sheet: !!sheet,
      teardown: unmount,
      close: sheet ? () => (typeof closeDetail === "function" ? closeDetail(true) : undefined) : opts.onClose,
      show: sheet ? undefined : opts.onShow,
    };
    active = peek;
    host.querySelector("[data-drill-full]")?.addEventListener("click", () => openPage(kind, id, { from }));
    host.querySelector("[data-drill-close]")?.addEventListener("click", () => closePeek());
    if (sheet) {
      // The sheet's own close (its ×, its backdrop) also takes the peek's history entry.
      sheet.querySelector(".detail-x")?.addEventListener("click", () => closePeek());
      sheet.addEventListener("click", (event) => {
        if (event.target === sheet) closePeek();
      });
    }
    // One history entry per open peek: a new peek pushes, a peek moving to another
    // object replaces, and a peek the URL already names (a reload, a Back into it) adds none.
    const current = peekParam();
    if (current !== id) {
      const next = { ...entryState(), cairn: true, peek: id };
      if (current) history.replaceState(next, "", peekUrl(id));
      else history.pushState(next, "", peekUrl(id));
    }
    return () => {
      unmount();
      if (active === peek) active = null;
    };
  }

  /**
   * Open `kind` `id` at a depth. Returns a teardown for inline/peek mounts (a no-op for
   * a page). An id that is not one of the kind's (a malformed date) opens nothing.
   */
  function open(kind: DrillKind, id: unknown, opts: DrillOpts = {}): () => void {
    const key = String(id ?? "").slice(0, 10);
    if (kind !== "day" || !ISO.test(key)) return noop;
    const mode: DrillMode = opts.mode || "page";
    if (mode === "inline") return opts.host ? mountView(kind, key, opts.host, opts) : noop;
    if (mode === "peek") return openPeek(kind, key, opts);
    openPage(kind, key, opts);
    return noop;
  }

  /**
   * Close the open peek: through history when its entry is the one on top (so Back and
   * Close agree), else in place, dropping a cold ?peek= from the address.
   */
  function closePeek(): void {
    const a = active;
    if (!a) return;
    const hs = history.state as { peek?: unknown } | null;
    if (peekParam() === a.id && hs && hs.peek === a.id && history.length > 1) {
      history.back(); // popstate → popped() → closes it
      return;
    }
    active = null;
    a.teardown();
    a.close?.();
    if (peekParam()) history.replaceState(entryState(), "", peekUrl(null));
  }

  /**
   * startup.ts's popstate asks this first. True when the history move only closed or
   * moved the open peek (nothing to re-render); false for a real navigation.
   */
  function popped(): boolean {
    const a = active;
    if (!a) return false;
    if (!a.host.isConnected || location.pathname !== a.path) {
      active = null;
      a.teardown();
      return false;
    }
    const id = peekParam();
    if (id === a.id) return true;
    if (id) {
      if (a.show) a.show(id);
      else open(a.kind, id, { mode: "peek", from: a.from });
      return true;
    }
    active = null;
    a.teardown();
    a.close?.();
    return true;
  }

  /** Whether `host` holds the open peek. */
  function owns(host: Element | null | undefined): boolean {
    return !!active && !!host && active.host === host;
  }

  /** A host going away (its surface torn down) lets go of its peek, history untouched. */
  function release(host: Element): void {
    if (!active || active.host !== host) return;
    const was = active;
    active = null;
    was.teardown();
  }

  /** The page's back link: Back to the opener, or its tab's root on a cold deep link. */
  function back(): void {
    const home = state.drillFrom || "today";
    if (state.drillBack && typeof history !== "undefined" && history.length > 1) history.back();
    else activateTab(home);
  }

  /** "Horizon" — what the page's back link says: the opener's name. */
  function fromLabel(): string {
    return homeLabel(state.drillFrom || "today");
  }

  const CAIRN_DRILL = {
    open,
    closePeek,
    popped,
    release,
    owns,
    back,
    fromLabel,
    homeLabel,
    hrefOf,
    peeked: peekParam,
  };

  Object.assign(globalThis, { CairnDrill: CAIRN_DRILL });
}

// @ts-check
// Horizon's Week, the controller (docs/IA.md "Horizon landing"): `mount(slot, deps)` reads
// GET /api/week through the SWR cache — the last-known week paints at once, the
// revalidated read upgrades it in place only when the JSON changed — and paints the
// landing (horizon-week-client.ts). Beside it, as its own lane, it reads GET /api/team-week
// (SWR key "horizon:team-week") for the team's seats and link note: they fill their two
// slots when they land, a failed read simply leaves them out, and the landing never waits.
//
// A column tap PEEKS the day: the fold under the shape opens and the drill controller
// (CairnDrill, the "calendar" bundle, loaded by that tap) mounts the day's compact view
// into it, adds ?peek= to history and ends it with "Open day ›" (the day's page, read
// under Horizon). Tapping the open column again, its Close, or Back folds it. A row (the
// day-by-day rows) opens the day's page through `data-open-day` (day-open-client.ts →
// CairnDrill). "All of the season ›" / "+N more ›", "Behind you ›" and the changes link
// hand over to the screen. A starter opener or the link note's chip hands chat its
// sentence (state.chatPrefill, the same hand-off the health surfaces use) and switches to
// Ask — never sent for the athlete. Links to a thread's page carry `data-horizon-href`;
// the Horizon controller routes them. Fetch + paint + delegate only; every word is the read's.
{
  type Deps = {
    peek(key: string): { data: unknown; fresh: boolean } | null;
    load(path: string, options: { key: string }): Promise<unknown>;
    reducedMotion?(): boolean;
    /** The Season view's real URL, for "All of the season ›" / "+N more ›". */
    seasonHref?: string;
    /** Ask › Changes' real URL, for the team's "n changes, each undoable ›". */
    changesHref?: string;
    /** Every read that paints (the frame and the weight goal ride to the other views). */
    onRead?(read: unknown): void;
    /** The read failed with nothing to show: the screen asks again on the next open. */
    onFail?(): void;
    /** "All of the season ›". */
    onSeason?(): void;
    /** "Behind you ›" on the proof band's masthead. */
    onBehind?(): void;
    /** The team's changes link. */
    onChanges?(): void;
  };

  /** The week's read and its SWR key (under "plan:", so every plan write refreshes it). */
  const WEEK: readonly [string, string] = ["/week", "plan:week-read"];
  /**
   * The team's week (the read Today's weekly card draws), under "horizon:" so day writes refresh it.
   * `drain=0`: Horizon shows no insights, so it must not use up the day's backlog drain.
   */
  const TEAM: readonly [string, string] = ["/team-week?drain=0", "horizon:team-week"];

  function modified(event: Event): boolean {
    const e = event as MouseEvent;
    return !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (typeof e.button === "number" && e.button !== 0));
  }

  /** Hand chat a first sentence and open Ask; the athlete sends it, never this. */
  function prefillChat(raw: string | null): void {
    const prompt = String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!prompt) return;
    const g = globalThis as unknown as {
      state?: { chatPrefill?: string | null };
      activateTab?: (name: string) => unknown;
    };
    if (g.state) g.state.chatPrefill = prompt.slice(0, 600);
    if (typeof g.activateTab === "function") g.activateTab("chat");
  }

  function mountHorizonWeek(slot: Element, deps: Deps): () => void {
    let live = true;
    let lastRaw = "";
    let model: ClientWeekLanding | null = null;
    let team: ClientTeamSeats | null = null;
    let teamRaw = "";
    let selected: string | null = null;
    /** The trail mark whose words are open; kept across a repaint while that mark still exists. */
    let mark = 0;
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
      if (!fold || !peekHost) return;
      selected = date;
      markSelected();
      detailTeardown?.();
      fold.classList.add("is-open");
      fold.removeAttribute("inert");
      fold.setAttribute("aria-label", q(`[data-week-day="${date}"]`)?.getAttribute("aria-label") || "The day opened");
      // The drill is the lazy calendar bundle's: a tap that opens a day waits for it only
      // when neither the idle warm-up nor an earlier tap has fetched it.
      void withBundle("calendar", () => {
        if (!live || selected !== date || !peekHost.isConnected) return;
        detailTeardown = CairnDrill.open("day", date, {
          mode: "peek",
          from: "horizon",
          host: peekHost,
          peek: deps.peek,
          load: deps.load,
          onClose: () => closeDay(),
          onShow: (id) => openDay(id),
        });
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
      host.innerHTML = CairnHorizonWeek.landingHtml(next, {
        enter: enter && !calm,
        mark: mark < (next.journey?.marks.length ?? 0) ? mark : (mark = 0),
        seasonHref: deps.seasonHref,
        changesHref: deps.changesHref,
        team,
      });
      if (keep && next.days.some((d) => d.date === keep)) openDay(keep);
    }

    /** The team's read landed: fill its two slots in place (the landing is not repainted). */
    function paintTeam(value: unknown): void {
      if (!live || !host.isConnected || typeof CairnTeamSeats === "undefined") return;
      let raw = "";
      try {
        raw = JSON.stringify(value) ?? "";
      } catch {}
      if (raw && raw === teamRaw) return;
      const next = CairnTeamSeats.model(value);
      // A read that says nothing never clears seats already on screen.
      if (!next && team) return;
      teamRaw = raw;
      team = next;
      const linkSlot = q("[data-hwk-link-slot]");
      if (linkSlot) linkSlot.innerHTML = CairnHorizonWeek.linkNoteHtml(team);
      const teamSlot = q("[data-hwk-team-slot]");
      if (teamSlot) teamSlot.innerHTML = CairnHorizonWeek.teamHtml(team, deps.changesHref || "");
    }

    const teardown = CairnUiActions.mount(host, "hwk", ({ delegate }) => {
      delegate("click", {
        "week-day": (el) => {
          const date = el.getAttribute("data-week-day") || "";
          if (!date) return;
          if (selected === date) foldDay();
          else openDay(date);
        },
        "hjour-mark": (el) => {
          const i = Number(el.getAttribute("data-hjour-mark"));
          const marks = model?.journey?.marks ?? [];
          if (!Number.isInteger(i) || !marks[i] || typeof CairnJourneyTrail === "undefined") return;
          mark = i;
          host.querySelectorAll<HTMLElement>("button[data-hjour-mark]").forEach((b) => {
            b.setAttribute("aria-pressed", String(b.getAttribute("data-hjour-mark") === String(i)));
          });
          host.querySelectorAll<HTMLElement>("[data-hjour-node]").forEach((n) => {
            n.classList.toggle("is-on", n.getAttribute("data-hjour-node") === String(i));
          });
          const detail = q("[data-hjour-detail]");
          if (detail) detail.innerHTML = CairnJourneyTrail.detailHtml(marks[i]);
        },
        "hjour-ask": (el) => prefillChat(el.getAttribute("data-hjour-ask")),
        "hwk-ask": (el) => prefillChat(el.getAttribute("data-hwk-ask")),
        "hwk-season": (el, event) => {
          if (modified(event)) return;
          event.preventDefault();
          deps.onSeason?.();
        },
        "hwk-behind": () => deps.onBehind?.(),
        "hwk-changes": (el, event) => {
          if (modified(event) || !deps.onChanges) return;
          event.preventDefault();
          deps.onChanges();
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

    const warmTeam = deps.peek(TEAM[1]);
    if (warmTeam && typeof CairnTeamSeats !== "undefined") {
      team = CairnTeamSeats.model(warmTeam.data);
      try {
        teamRaw = JSON.stringify(warmTeam.data) ?? "";
      } catch {}
    }
    const warm = deps.peek(WEEK[1]);
    if (warm && CairnWeekModel.landing(warm.data)) paint(warm.data, false);
    else host.innerHTML = CairnHorizonWeek.skeletonHtml();
    Promise.resolve()
      .then(() => deps.load(WEEK[0], { key: WEEK[1] }))
      .then(
        (value) => paint(value, !warm),
        () => paint(null, false)
      );
    // The team lane fills on its own; a failed read leaves its sections out.
    Promise.resolve()
      .then(() => deps.load(TEAM[0], { key: TEAM[1] }))
      .then(paintTeam, () => {});
    return teardown;
  }

  const CAIRN_HORIZON_WEEK_CONTROLLER = { mount: mountHorizonWeek, WEEK, TEAM };

  Object.assign(globalThis, { CairnHorizonWeekController: CAIRN_HORIZON_WEEK_CONTROLLER });
}

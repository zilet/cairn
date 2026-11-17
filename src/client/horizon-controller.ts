// @ts-check
// The Horizon timeline, the controller (docs/IA.md "Horizon landing"). `mount(host, deps)`
// opens on WEEK — the designed landing (horizon-week-controller.ts over GET /api/week) —
// never on a view remembered from earlier in the session, so a cold /app/horizon and a tab
// tap land in the same place. The one exception is Back from a Horizon page this timeline
// opened (`returnNext`, called by the page's "‹ Horizon"): it returns to the segment the
// page was opened from, once.
//
// The segments are Week · To the race · Season · Behind you, and two of them show only
// when they hold something: "To the race" inside eight weeks of a race (the week read's
// countdown or the race build's own days to race) or while a race just run is said back
// (the race lane's `finished`) — otherwise the race is reached through its goal row and
// its mark, which link to the race page; a runner with no race keeps "Running", a lifting-
// only athlete has no race view at all. "Behind you" shows once GET /api/goal-reviews has
// a row (read after the landing, never ahead of it). The switch is a sliding-thumb bar.
//
// The race build is read at the landing (it frames the switch); the Season's reads wait
// until Season is first shown, and each lane fills its slot as its own reads land; a
// failed read is that lane's one calm sentence, never the whole screen. The week read's
// frame is To the race's hero, and its weight goal is the Season's one weight trend
// (CairnHorizonModel.withWeek), so the stage and the trend are said once, the same way, on
// every view. A tap on a row or a link follows the model's route through `deps.navigate`
// (the app's own router), or a server-named page through `deps.openHref`. Nothing here
// computes a week, a fit, a due date or a staleness; the reads own those.
{
  type Deps = ClientHorizonDeps;
  type Lane = ClientHorizonLane;

  /** "To the race" shows inside this many days of the race. */
  const RACE_SEGMENT_DAYS = 56;
  const CHANGES: ClientHorizonTarget = { tab: "plan", section: "coach" };

  function modified(event: Event): boolean {
    const e = event as MouseEvent;
    return !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (typeof e.button === "number" && e.button !== 0));
  }

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  /** A day count off a read; null when it says none (never a 0 read off a missing field). */
  function daysOf(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * What the last reads said, so the next open frames the switch right at once: how much
   * running Horizon holds (none / a runner with no race / a race), whether the race is near
   * enough for its segment, and whether anything is behind. They shape the switch only.
   */
  let runningSeen: "race" | "runs" | "none" | null = null;
  let raceNearSeen = false;
  let behindSeen = false;
  /** The segment a Horizon page was opened from, and the one Back arms for the next mount. */
  let leftFrom: ClientHorizonView | null = null;
  let returnTo: ClientHorizonView | null = null;

  function shellOptions(): {
    view: ClientHorizonView;
    race: boolean;
    raceShown: boolean;
    raceLabel: string;
    behind: boolean;
  } {
    return {
      view: returnTo || "week",
      race: runningSeen !== "none",
      raceShown: runningSeen === "runs" || (runningSeen === "race" && raceNearSeen),
      raceLabel: runningSeen === "runs" ? "Running" : "",
      behind: behindSeen,
    };
  }

  /** Back from a page this timeline opened: the next mount returns to the segment it left from. */
  function returnNext(): void {
    returnTo = leftFrom;
    leftFrom = null;
  }

  function mountHorizon(host: Element, deps: Deps): () => void {
    let live = true;
    const root = host as HTMLElement;
    const lanes = new Map<Lane["key"], Lane>();
    let seasonMarkup: string | null = null;
    /** The athlete's run units (settings.run_units), and the reads they are written over. */
    let units: "km" | "mi" = "km";
    /** The last week read (GET /api/week): its frame and weight goal ride to the other views. */
    let weekRead: unknown = null;
    /** The last race build read: its days to race frames the switch. */
    let raceBuild: unknown = null;
    let weekTeardown: (() => void) | null = null;
    let current: ClientHorizonView = "week";
    const first = returnTo || "week";
    returnTo = null;

    const calm = (): boolean => (typeof deps.reducedMotion === "function" ? deps.reducedMotion() : false);
    const read = (path: string): Promise<unknown> =>
      Promise.resolve()
        .then(() => deps.load(path))
        .catch(() => null);
    const seg = (view: ClientHorizonView): HTMLElement | null =>
      root.querySelector<HTMLElement>(`[data-horizon-seg="${view}"]`);
    const shown = (view: ClientHorizonView): boolean => {
      const btn = seg(view);
      return !!btn && !btn.hidden;
    };

    /** The thumb sits over the active segment among the shown ones; a bar too wide scrolls. */
    function syncSeg(): void {
      const bar = root.querySelector<HTMLElement>(".horizon-seg");
      if (!bar) return;
      const visible = Array.from(bar.querySelectorAll<HTMLElement>("[data-horizon-seg]")).filter((b) => !b.hidden);
      const index = Math.max(
        0,
        visible.findIndex((b) => b.getAttribute("data-horizon-seg") === current)
      );
      bar.style.setProperty("--segn", String(visible.length || 1));
      bar.style.setProperty("--segi", String(index));
      deps.fitSeg?.(bar);
    }

    /** Show or hide one segment; leaving the view it hides falls back to Week. */
    function showSeg(view: ClientHorizonView, on: boolean): void {
      const btn = seg(view);
      if (!btn || btn.hidden === !on) return;
      btn.hidden = !on;
      if (!on && current === view) setView("week");
      else syncSeg();
    }

    /** The Week landing reads GET /api/week the first time it is shown (on mount: it opens first). */
    function ensureWeek(): void {
      if (weekTeardown) return;
      const slot = root.querySelector<HTMLElement>("[data-horizon-weekview]");
      if (!slot) return;
      const peek = deps.peek || (() => null);
      const cached = deps.cached || ((path: string) => deps.load(path));
      weekTeardown = CairnHorizonWeekController.mount(slot, {
        peek,
        load: cached,
        reducedMotion: deps.reducedMotion,
        seasonHref: deps.hrefFor?.({ tab: "horizon", section: null }) || "",
        changesHref: deps.hrefFor?.(CHANGES) || "",
        onRead: (value) => {
          weekRead = value;
          for (const key of ["race", "goal"] as const) {
            const lane = lanes.get(key);
            if (lane) paint(lane, false);
          }
          syncRaceSeg();
        },
        // A failed read says so, and the next tap on Week asks again.
        onFail: () => {
          const was = weekTeardown;
          weekTeardown = null;
          was?.();
        },
        onSeason: () => setView("season"),
        onBehind: () => {
          if (shown("behind")) setView("behind");
        },
        onChanges: () => deps.navigate(CHANGES),
      });
    }

    function setView(view: ClientHorizonView): void {
      if (view !== "week" && !shown(view)) view = "week";
      current = view;
      if (view === "week") ensureWeek();
      if (view === "season") ensureSeason();
      root.setAttribute("data-horizon-view", view);
      for (const btn of Array.from(root.querySelectorAll<HTMLElement>("[data-horizon-seg]"))) {
        const on = btn.getAttribute("data-horizon-seg") === view;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", String(on));
      }
      for (const panel of Array.from(root.querySelectorAll<HTMLElement>("[data-horizon-panel]"))) {
        panel.hidden = panel.getAttribute("data-horizon-panel") !== view;
      }
      syncSeg();
    }

    /** Draw the season line into the goal line's held slot, or let the slot go. */
    function fillSeason(): void {
      if (seasonMarkup == null) return;
      const slot = root.querySelector<HTMLElement>("[data-horizon-season]");
      if (!slot) return;
      if (!seasonMarkup) {
        slot.remove();
        return;
      }
      slot.innerHTML = seasonMarkup;
      slot.classList.remove("is-pending");
      slot.removeAttribute("aria-busy");
    }
    // The run units ride with the race read; a failed settings read is km.
    const unitsRead = read("/settings").then((value) => {
      units = CairnFmt.set((value as { settings?: { run_units?: unknown } } | null)?.settings).distance;
    });

    function paint(lane: Lane, enter = true): void {
      if (!live || !root.isConnected) return;
      const slot = root.querySelector(`[data-horizon-lane="${lane.key}"]`);
      if (!slot) return;
      lanes.set(lane.key, lane);
      const view = CairnHorizonModel.withWeek(lane, weekRead);
      slot.innerHTML = CairnHorizon.laneHtml(view, { enter: enter && !calm(), hrefFor: deps.hrefFor });
      if (lane.key === "goal") fillSeason();
      if (lane.key === "race") settleRace(lane);
    }

    /** Inside eight weeks of the race, by the week read's countdown or the build's own days. */
    function raceNear(): boolean {
      const week = record(record(record(weekRead)?.frame)?.countdown);
      const build = record(record(raceBuild)?.race);
      return [daysOf(week?.days), daysOf(build?.days_to_race)].some(
        (d) => d != null && d >= 0 && d <= RACE_SEGMENT_DAYS
      );
    }

    /** "To the race" shows for a runner with no race, near a race, or while a race just run is said back. */
    function syncRaceSeg(): void {
      if (runningSeen == null || runningSeen === "none" || !lanes.has("race")) return;
      const finished = !!lanes.get("race")?.finished?.headline;
      raceNearSeen = raceNear() || finished;
      showSeg("race", runningSeen === "runs" || raceNearSeen);
    }

    /**
     * The race read decides how much running Horizon holds: no view at all for a
     * lifting-only athlete, "Running" for a runner with no race, the race build otherwise.
     */
    function settleRace(lane: Lane): void {
      if (lane.state === "unread") return;
      const running = lane.state === "absent" ? "none" : lane.title === "Running" ? "runs" : "race";
      runningSeen = running;
      const btn = seg("race");
      if (running === "none") {
        btn?.remove();
        root.querySelector<HTMLElement>('[data-horizon-panel="race"]')?.setAttribute("hidden", "");
        if (current === "race") setView("week");
        else syncSeg();
        return;
      }
      if (btn) btn.textContent = running === "runs" ? "Running" : "To the race";
      syncRaceSeg();
    }

    /** The finished goals "Behind you" drew, by review id. */
    const behindIds = new Set<string>();

    function targetFor(key: string): ClientHorizonTarget | null {
      const [laneKey, kind, index] = key.split(":");
      if (laneKey === "behind") return kind && behindIds.has(kind) ? CairnHorizonBehind.target(kind) : null;
      const lane = lanes.get(laneKey as Lane["key"]);
      const i = Number(index);
      if (!lane || !Number.isInteger(i)) return null;
      if (kind === "row") return lane.rows[i]?.target || null;
      if (kind === "link") return lane.links[i]?.target || null;
      return null;
    }

    /**
     * What is behind: finished goals, each said back once, in their own segment. Read after
     * the landing's own reads were asked (it decides only whether the segment shows); no
     * rows (or a failed read) hides the segment.
     */
    function loadBehind(): void {
      void read("/goal-reviews").then((list) => {
        if (!live || !root.isConnected || typeof CairnHorizonBehind === "undefined") return;
        const slot = root.querySelector<HTMLElement>("[data-horizon-behind]");
        if (!slot) return;
        behindIds.clear();
        for (const row of CairnHorizonBehind.rows(list)) behindIds.add(String(row.id));
        slot.innerHTML = CairnHorizonBehind.listHtml(list, { hrefFor: deps.hrefFor });
        behindSeen = behindIds.size > 0;
        // The proof band's "Behind you ›" shows only while the segment does (horizon/week.css).
        if (behindSeen) root.setAttribute("data-horizon-behind-shown", "");
        else root.removeAttribute("data-horizon-behind-shown");
        showSeg("behind", behindSeen);
      });
    }

    /** The race read stays eager: it decides whether the race view exists and what it is called. */
    function load(): void {
      void Promise.all([read("/race-build"), unitsRead]).then(([build]) => {
        raceBuild = build;
        paint(CairnHorizonModel.raceLane(build, units));
      });
      loadBehind();
    }

    /**
     * The Season's reads (goal line, labs, season chart) are asked the first time Season is
     * SHOWN: Week is the landing, so a hidden panel's reads would be a cold open's dead
     * weight. A failed read is that lane's calm sentence, and the next visit to the Season
     * does not ask again within this mount.
     */
    let seasonAsked = false;
    function ensureSeason(): void {
      if (seasonAsked) return;
      seasonAsked = true;
      const today = deps.today;
      const model = CairnHorizonModel;
      const timeline = read("/journey/timeline");
      // One row per draw (kind + date), server-side: a draw's upload and its split-out
      // panels are one row, never three (repo/lab-draws.ts).
      const draws = read("/health-docs/draws");
      const checkup = read("/health/next-checkup");
      void Promise.all([read("/journey"), timeline]).then(([journey, rows]) =>
        paint(model.goalLane(journey, rows, today))
      );
      void Promise.all([draws, checkup, timeline]).then(([drawRows, checkupRead, rows]) =>
        paint(CairnHorizonLabsModel.labsLane(drawRows, checkupRead, rows, today))
      );
      void Promise.all([read("/nutrition/goal-pace?days=180"), timeline, draws, checkup]).then(
        ([pace, rows, drawRows, checkupRead]) => {
          if (!live || !root.isConnected) return;
          // The chart speaks the athlete's weight unit: the one weight-trend read beside goal-pace names it.
          const weightUnit = (pace as { read?: { units?: unknown } } | null)?.read?.units === "kg" ? "kg" : "lb";
          seasonMarkup = CairnHorizon.seasonHtml(
            CairnHorizonLabsModel.season(pace, rows, drawRows, checkupRead, today),
            weightUnit
          );
          fillSeason();
        }
      );
    }

    return CairnUiActions.mount(root, "horizon", ({ delegate }) => {
      delegate("click", {
        "horizon-seg": (el) => {
          const picked = el.getAttribute("data-horizon-seg");
          setView(picked === "season" || picked === "race" || picked === "behind" ? picked : "week");
        },
        "horizon-go": (el, event) => {
          if (modified(event)) return;
          const target = targetFor(el.getAttribute("data-horizon-go") || "");
          if (!target) return;
          event.preventDefault();
          leftFrom = current;
          deps.navigate(target);
        },
        // A page the server named ("/app/horizon/race"): a real link, routed in place.
        "horizon-href": (el, event) => {
          if (modified(event) || !deps.openHref) return;
          const href = el.getAttribute("href") || el.getAttribute("data-horizon-href") || "";
          if (!/^\/app\//.test(href)) return;
          leftFrom = current;
          if (deps.openHref(href)) event.preventDefault();
          else leftFrom = null;
        },
      });
      // Week is the landing; Back from a page this timeline opened returns to its segment.
      setView(first);
      load();
      return () => {
        live = false;
        weekTeardown?.();
        weekTeardown = null;
      };
    });
  }

  const CAIRN_HORIZON_CONTROLLER = { mount: mountHorizon, shellOptions, returnNext, RACE_SEGMENT_DAYS };

  Object.assign(globalThis, { CairnHorizonController: CAIRN_HORIZON_CONTROLLER });
}

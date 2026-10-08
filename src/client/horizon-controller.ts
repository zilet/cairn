// @ts-check
// The Horizon timeline, the controller (docs/IA.md "Horizon landing"). `mount(host, deps)`
// opens on WEEK, always — the designed landing (horizon-week-controller.ts over
// GET /api/week) — never on a view remembered from earlier in the session, so a cold
// /app/horizon and a tab tap land in the same place. The race build is read at the landing
// (it frames the switch); the Season's reads wait until Season is first shown, and each
// lane fills its slot as its own reads land; a failed read is that lane's one calm
// sentence, never the whole screen. The week read's frame is To the race's hero, and its
// weight goal is the Season's one weight trend (CairnHorizonModel.withWeek), so the
// stage and the trend are said once, the same way, on every view. A tap on a row or a
// link follows the model's route through `deps.navigate` (the app's own router), so a
// lab row opens You's Health pages, which load their lazy bundle on arrival. Nothing
// here computes a week, a fit, a due date or a staleness; the reads own those.
{
  type Deps = ClientHorizonDeps;
  type Lane = ClientHorizonLane;

  function modified(event: Event): boolean {
    const e = event as MouseEvent;
    return !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (typeof e.button === "number" && e.button !== 0));
  }

  /**
   * What the last race read said about this athlete's running, so the next open frames
   * the race view right at once: none for a lifting-only athlete, "Running" for a runner
   * with no race. It shapes the switch only; the view opened is always Week.
   */
  let runningSeen: "race" | "runs" | "none" | null = null;

  function shellOptions(): { view: ClientHorizonView; race: boolean; raceLabel: string } {
    return { view: "week", race: runningSeen !== "none", raceLabel: runningSeen === "runs" ? "Running" : "" };
  }

  function mountHorizon(host: Element, deps: Deps): () => void {
    let live = true;
    const lanes = new Map<Lane["key"], Lane>();
    let seasonMarkup: string | null = null;
    /** The athlete's run units (settings.run_units), and the reads they are written over. */
    let units: "km" | "mi" = "km";
    /** The last week read (GET /api/week): its frame and weight goal ride to the other views. */
    let weekRead: unknown = null;
    let weekTeardown: (() => void) | null = null;

    const calm = (): boolean => (typeof deps.reducedMotion === "function" ? deps.reducedMotion() : false);
    const read = (path: string): Promise<unknown> =>
      Promise.resolve()
        .then(() => deps.load(path))
        .catch(() => null);

    /** The Week landing reads GET /api/week the first time it is shown (on mount: it opens first). */
    function ensureWeek(): void {
      if (weekTeardown) return;
      const slot = host.querySelector<HTMLElement>("[data-horizon-weekview]");
      if (!slot) return;
      const peek = deps.peek || (() => null);
      const cached = deps.cached || ((path: string) => deps.load(path));
      weekTeardown = CairnHorizonWeekController.mount(slot, {
        peek,
        load: cached,
        reducedMotion: deps.reducedMotion,
        seasonHref: deps.hrefFor?.({ tab: "horizon", section: null }) || "",
        onRead: (value) => {
          weekRead = value;
          for (const key of ["race", "goal"] as const) {
            const lane = lanes.get(key);
            if (lane) paint(lane, false);
          }
        },
        // A failed read says so, and the next tap on Week asks again.
        onFail: () => {
          const was = weekTeardown;
          weekTeardown = null;
          was?.();
        },
        onSeason: () => setView("season"),
      });
    }

    function setView(view: ClientHorizonView): void {
      if (view === "week") ensureWeek();
      if (view === "season") ensureSeason();
      host.setAttribute("data-horizon-view", view);
      for (const btn of Array.from(host.querySelectorAll<HTMLElement>("[data-horizon-seg]"))) {
        const on = btn.getAttribute("data-horizon-seg") === view;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-selected", String(on));
      }
      for (const panel of Array.from(host.querySelectorAll<HTMLElement>("[data-horizon-panel]"))) {
        panel.hidden = panel.getAttribute("data-horizon-panel") !== view;
      }
    }

    /** Draw the season line into the goal line's held slot, or let the slot go. */
    function fillSeason(): void {
      if (seasonMarkup == null) return;
      const slot = host.querySelector<HTMLElement>("[data-horizon-season]");
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
      if (!live || !host.isConnected) return;
      const slot = host.querySelector(`[data-horizon-lane="${lane.key}"]`);
      if (!slot) return;
      lanes.set(lane.key, lane);
      const shown = CairnHorizonModel.withWeek(lane, weekRead);
      slot.innerHTML = CairnHorizon.laneHtml(shown, { enter: enter && !calm(), hrefFor: deps.hrefFor });
      if (lane.key === "goal") fillSeason();
      if (lane.key === "race") settleRace(lane);
    }

    /**
     * The race read decides how much running Horizon holds: no view at all for a
     * lifting-only athlete, "Running" for a runner with no race, the race build otherwise.
     */
    function settleRace(lane: Lane): void {
      if (lane.state === "unread") return;
      const running = lane.state === "absent" ? "none" : lane.title === "Running" ? "runs" : "race";
      runningSeen = running;
      const seg = host.querySelector<HTMLElement>('[data-horizon-seg="race"]');
      if (running === "none") {
        seg?.remove();
        host.querySelector<HTMLElement>('[data-horizon-panel="race"]')?.setAttribute("hidden", "");
        if (host.getAttribute("data-horizon-view") === "race") setView("week");
        return;
      }
      if (seg) seg.textContent = running === "runs" ? "Running" : "To the race";
    }

    function targetFor(key: string): ClientHorizonTarget | null {
      const [laneKey, kind, index] = key.split(":");
      const lane = lanes.get(laneKey as Lane["key"]);
      const i = Number(index);
      if (!lane || !Number.isInteger(i)) return null;
      if (kind === "row") return lane.rows[i]?.target || null;
      if (kind === "link") return lane.links[i]?.target || null;
      return null;
    }

    /** The race read stays eager: it decides whether the race view exists and what it is called. */
    function load(): void {
      void Promise.all([read("/race-build"), unitsRead]).then(([build]) => {
        paint(CairnHorizonModel.raceLane(build, units));
      });
    }

    /**
     * The Season's reads (goal line, labs, season chart) are asked the first time Season is
     * SHOWN, like the week once was: Week is the landing, so a hidden panel's five reads
     * would be a cold open's dead weight. A failed read is that lane's calm sentence, and
     * the next visit to the Season does not ask again within this mount.
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
          if (!live || !host.isConnected) return;
          seasonMarkup = CairnHorizon.seasonHtml(CairnHorizonLabsModel.season(pace, rows, drawRows, checkupRead, today));
          fillSeason();
        }
      );
    }

    return CairnUiActions.mount(host, "horizon", ({ delegate }) => {
      delegate("click", {
        "horizon-seg": (el) => {
          const picked = el.getAttribute("data-horizon-seg");
          setView(picked === "season" || picked === "race" ? picked : "week");
        },
        "horizon-go": (el, event) => {
          if (modified(event)) return;
          const target = targetFor(el.getAttribute("data-horizon-go") || "");
          if (!target) return;
          event.preventDefault();
          deps.navigate(target);
        },
      });
      // Week is the landing, always; the shell was framed on it.
      setView("week");
      load();
      return () => {
        live = false;
        weekTeardown?.();
        weekTeardown = null;
      };
    });
  }

  const CAIRN_HORIZON_CONTROLLER = { mount: mountHorizon, shellOptions };

  Object.assign(globalThis, { CairnHorizonController: CAIRN_HORIZON_CONTROLLER });
}

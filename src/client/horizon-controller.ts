// @ts-check
// The Horizon timeline, the controller (docs/V2-PLAN.md wave 5). `mount(host, deps)`
// fills the shell's three lane slots. Each lane reads on its own and paints the moment
// its reads land, so a slow health read never holds the race lane back; a failed read
// is that lane's one calm sentence, never the whole screen. A tap on a row or a link
// follows the model's route through `deps.navigate` (the app's own router), so a lab
// row opens You's Health pages, which load their lazy bundle on arrival. Nothing here
// computes a week, a fit, a due date or a staleness; the reads own those.
{
  type Deps = ClientHorizonDeps;
  type Lane = ClientHorizonLane;

  function modified(event: Event): boolean {
    const e = event as MouseEvent;
    return !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (typeof e.button === "number" && e.button !== 0));
  }

  /**
   * The view the athlete last picked, for this app session. Unpicked, Horizon opens on
   * the race build, and steps to the season on its own when no race is set.
   */
  let chosenView: ClientHorizonView | null = null;
  /**
   * What the last race read said about this athlete's running, for this app session, so
   * the next open draws the right frame at once: no race view for a lifting-only athlete,
   * "Running" for a runner with no race. Unknown until the first read lands.
   */
  let runningSeen: "race" | "runs" | "none" | null = null;

  function shellOptions(): { view: ClientHorizonView; race: boolean; raceLabel: string } {
    const race = runningSeen !== "none";
    const fallback: ClientHorizonView = runningSeen === "none" ? "week" : "race";
    const view = chosenView && (chosenView !== "race" || race) ? chosenView : fallback;
    return { view, race, raceLabel: runningSeen === "runs" ? "Running" : "" };
  }

  function mountHorizon(host: Element, deps: Deps): () => void {
    let live = true;
    const lanes = new Map<Lane["key"], Lane>();
    let seasonMarkup: string | null = null;
    /** The athlete's run units (settings.run_units), and the reads they are written over. */
    let units: "km" | "mi" = "km";
    let weekAsked = false;

    /** The week view reads GET /api/plan/week the first time it is shown, never before. */
    function ensureWeek(): void {
      if (weekAsked) return;
      weekAsked = true;
      const held = host.querySelector<HTMLElement>("[data-horizon-weekview]");
      if (held && !held.firstElementChild) held.innerHTML = CairnHorizon.weekSkeletonHtml();
      void Promise.all([read("/plan/week"), unitsRead]).then(([planWeek]) => {
        if (!live || !host.isConnected) return;
        // A failed read says so, and the next tap on Week asks again.
        if (planWeek == null) weekAsked = false;
        const slot = host.querySelector<HTMLElement>("[data-horizon-weekview]");
        if (!slot) return;
        slot.innerHTML = CairnHorizon.weekHtml(CairnHorizonWeekModel.weekView(planWeek, deps.today, units), {
          enter: !calm(),
        });
      });
    }

    function setView(view: ClientHorizonView): void {
      if (view === "week") ensureWeek();
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
    const calm = (): boolean => (typeof deps.reducedMotion === "function" ? deps.reducedMotion() : false);
    const read = (path: string): Promise<unknown> =>
      Promise.resolve()
        .then(() => deps.load(path))
        .catch(() => null);
    // The run units ride with the race and week reads; a failed settings read is km.
    const unitsRead = read("/settings").then((value) => {
      units = CairnFmt.set((value as { settings?: { run_units?: unknown } } | null)?.settings).distance;
    });

    function paint(lane: Lane, enter = true): void {
      if (!live || !host.isConnected) return;
      const slot = host.querySelector(`[data-horizon-lane="${lane.key}"]`);
      if (!slot) return;
      lanes.set(lane.key, lane);
      slot.innerHTML = CairnHorizon.laneHtml(lane, { enter: enter && !calm(), hrefFor: deps.hrefFor });
      if (lane.key === "goal") fillSeason();
      if (lane.key === "race") settleRace(lane);
    }

    /**
     * The race read decides how much running Horizon holds: no view at all for a
     * lifting-only athlete (the week opens instead), "Running" for a runner with no race,
     * the race build otherwise. Remembered for the session, so the next open is framed right.
     */
    function settleRace(lane: Lane): void {
      if (lane.state === "unread") return;
      const running = lane.state === "absent" ? "none" : lane.title === "Running" ? "runs" : "race";
      runningSeen = running;
      const seg = host.querySelector<HTMLElement>('[data-horizon-seg="race"]');
      if (running === "none") {
        seg?.remove();
        host.querySelector<HTMLElement>('[data-horizon-panel="race"]')?.setAttribute("hidden", "");
        if (host.getAttribute("data-horizon-view") === "race") setView(chosenView === "season" ? "season" : "week");
        return;
      }
      if (seg) seg.textContent = running === "runs" ? "Running" : "To the race";
      // No race and nothing run to show: unpicked, Horizon steps to the season on its own.
      const empty = lane.state === "none" && !lane.this_week && !(lane.volume || []).length;
      if (empty && !chosenView) setView("season");
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

    function load(): void {
      const today = deps.today;
      const model = CairnHorizonModel;
      const timeline = read("/journey/timeline");
      const docs = read("/health-docs");
      const checkup = read("/health/next-checkup");
      void Promise.all([read("/race-build"), unitsRead]).then(([build]) => {
        paint(model.raceLane(build, units));
      });
      void Promise.all([read("/journey"), timeline]).then(([journey, rows]) =>
        paint(model.goalLane(journey, rows, today))
      );
      void Promise.all([docs, checkup, timeline]).then(([docRows, checkupRead, rows]) =>
        paint(model.labsLane(docRows, checkupRead, rows, today))
      );
      void Promise.all([read("/nutrition/goal-pace?days=180"), timeline, docs, checkup]).then(
        ([pace, rows, docRows, checkupRead]) => {
          if (!live || !host.isConnected) return;
          seasonMarkup = CairnHorizon.seasonHtml(model.season(pace, rows, docRows, checkupRead, today));
          fillSeason();
        }
      );
    }

    return CairnUiActions.mount(host, "horizon", ({ delegate }) => {
      delegate("click", {
        "horizon-seg": (el) => {
          const picked = el.getAttribute("data-horizon-seg");
          const view: ClientHorizonView = picked === "season" || picked === "week" ? picked : "race";
          chosenView = view;
          setView(view);
        },
        "horizon-go": (el, event) => {
          if (modified(event)) return;
          const target = targetFor(el.getAttribute("data-horizon-go") || "");
          if (!target) return;
          event.preventDefault();
          deps.navigate(target);
        },
      });
      // Open on the view the shell was framed with (the athlete's pick, when that view is
      // on this athlete's Horizon); a week view asks for its read here.
      const framed = host.getAttribute("data-horizon-view") as ClientHorizonView | null;
      const open = chosenView && host.querySelector(`[data-horizon-panel="${chosenView}"]`) ? chosenView : framed;
      if (open) setView(open);
      load();
      return () => {
        live = false;
      };
    });
  }

  /** Open the next Horizon paint on `view` (Today's strip opens today "in Horizon" on the week). */
  function pickView(view: ClientHorizonView): void {
    chosenView = view;
  }

  const CAIRN_HORIZON_CONTROLLER = { mount: mountHorizon, shellOptions, pickView };

  Object.assign(globalThis, { CairnHorizonController: CAIRN_HORIZON_CONTROLLER });
}

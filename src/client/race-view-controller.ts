// @ts-check
// The race view, the controller (docs/V2-PLAN.md wave 4). `mount(host, deps)` paints
// the race build into `host`: at once from `deps.initial` when the screen already
// holds GET /api/race-build, else a skeleton while `deps.load()` reads it. An
// unavailable build is the empty state with the server's own reason; a failed read
// is one calm sentence and "Try again". It never computes a week, a kind or a fit —
// raceBuild() owns those — and it never waits on an agent (the read is deterministic).
// Within three weeks of the race the day-by-day countdown leads (race-countdown-*): the
// view holds its slot and this fills it from GET /api/race-build/days, once per painted
// build; a countdown that cannot be read simply leaves the slot out — the rest of the
// page stands on its own.
{
  type Deps = ClientRaceViewDeps;

  function mountRaceView(host: Element, deps: Deps): () => void {
    let generation = 0;
    let painted = false;

    const live = (gen: number): boolean => gen === generation && host.isConnected;
    const calm = (): boolean => (typeof deps.reducedMotion === "function" ? deps.reducedMotion() : false);

    function countdownShown(value: unknown): boolean {
      return typeof CairnRaceCountdownModel !== "undefined" && typeof CairnRaceCountdown !== "undefined" && CairnRaceCountdownModel.shows(value);
    }

    function readDays(): Promise<unknown> {
      if (typeof deps.loadDays === "function") return deps.loadDays();
      if (typeof api === "function") return api("/race-build/days?through=race");
      return Promise.resolve(null);
    }

    /** Fill the countdown's slot; an unreadable or empty countdown takes the slot away and next week stays. */
    function loadCountdown(gen: number): void {
      const slot = host.querySelector("[data-race-countdown]");
      if (!slot) return;
      Promise.resolve()
        .then(() => readDays())
        .then((value) => {
          if (!live(gen) || !slot.isConnected) return;
          // Each day still to come offers "What if I move this?" (race-countdown-client.ts).
          const html = CairnRaceCountdown.countdownHtml(CairnRaceCountdownModel.countdownModel(value), { whatIf: true });
          if (html) {
            slot.innerHTML = html;
            // The countdown now says the weeks day by day; next week's own section stands down.
            host.querySelector("[data-race-nextweek]")?.remove();
          } else slot.remove();
        })
        .catch(() => {
          if (live(gen) && slot.isConnected) slot.remove();
        });
    }

    function paint(value: unknown): void {
      const model = CairnRaceViewModel.viewModel(value, { units: deps.units, agenda: deps.agenda ?? null });
      const countdown = !!model && countdownShown(value);
      if (!model) {
        const reason = value && typeof value === "object" ? (value as { reason?: unknown }).reason : null;
        host.innerHTML = CairnRaceView.emptyHtml(reason);
      } else {
        host.innerHTML = CairnRaceView.viewHtml(model, {
          enter: !painted && !calm(),
          sessionsHtml: deps.sessionsHtml,
          nextWeekHtml: deps.nextWeekHtml,
          units: deps.units,
          countdown,
        });
      }
      painted = true;
      if (countdown) loadCountdown(generation);
    }

    function isBuild(value: unknown): boolean {
      return !!value && typeof value === "object" && "available" in (value as object);
    }

    function load(): Promise<void> {
      const gen = ++generation;
      if (!painted) host.innerHTML = CairnRaceView.skeletonHtml();
      return Promise.resolve()
        .then(() => deps.load())
        .then((value) => {
          if (!live(gen)) return;
          if (isBuild(value)) paint(value);
          else host.innerHTML = CairnRaceView.errorHtml();
        })
        .catch(() => {
          if (live(gen)) host.innerHTML = CairnRaceView.errorHtml();
        });
    }

    return CairnUiActions.mount(host, "race-view", ({ delegate }) => {
      delegate("click", {
        // A sibling of the day's link, never inside it; the tap stays on the button.
        "race-whatif": (el, e) => {
          e.stopPropagation();
          if (typeof gotoChatWith === "function") gotoChatWith(el.getAttribute("data-race-whatif") || "");
        },
        "race-view-retry": () => {
          painted = false;
          void load();
        },
      });
      if (isBuild(deps.initial)) paint(deps.initial);
      else void load();
      return () => {
        generation++;
      };
    });
  }

  const CAIRN_RACE_VIEW_CONTROLLER = { mount: mountRaceView };

  Object.assign(globalThis, { CairnRaceViewController: CAIRN_RACE_VIEW_CONTROLLER });
}

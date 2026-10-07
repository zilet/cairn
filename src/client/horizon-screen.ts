// @ts-check
// The Horizon home: what is ahead.
//
//   /app/horizon       the timeline, opening on WEEK always (docs/IA.md "Horizon
//                      landing": the frame hero, the week's shape, still open, next up,
//                      goals — horizon-week-{client,controller}), then the race build and
//                      the season (the goal line and labs and scans)
//                      (horizon-model / -client / -controller), each lane tapping into
//                      its depth view.
//   /app/horizon/goal  the goal line in depth: All goals (every thread — race, weight,
//                      each strength objective, the priority marker — start → now →
//                      goal with its trend; Today's Path card links here), then the
//                      journey story and the road-ahead timeline, the cards Train's
//                      overview used to fold away.
//   /app/horizon/race  is the Plan view's race section (plan-endurance-client.ts),
//                      which wears "Race" and steps back here.
//
// Every lab and scan row opens You's Health pages through the app's router, so the
// lazy me-health bundle loads on arrival and never on the way to Horizon.

/** The "‹ Horizon" back link of a Horizon depth view (the goal line, the race). */
function horizonBackHtml(): string {
  return homeBackHtml("horizon", "Horizon");
}

/** Back always lands on the timeline, never on the last section Horizon showed. */
function wireHorizonBack(root: ParentNode): void {
  root.querySelector<HTMLElement>("[data-home-back]")?.addEventListener("click", () => {
    state.horizonSeg = null;
    activateTab("horizon");
  });
}

{
  type HorizonRoute = NonNullable<Parameters<typeof applyRouteState>[0]>;

  function horizonTargetRoute(target: ClientHorizonTarget): HorizonRoute {
    return {
      tab: target.tab,
      section: (target.section || null) as HorizonRoute["section"],
      healthSection: null,
      date: null,
      id: target.id || null,
      session: null,
      jump: null,
    };
  }

  function horizonNavigate(target: ClientHorizonTarget): void {
    if (target.tab === "horizon") {
      state.horizonSeg = (target.section === "goal" ? "goal" : null) as ClientHorizonSection | null;
      activateTab("horizon");
      return;
    }
    activateTab(applyRouteState(horizonTargetRoute(target)));
  }

  function horizonHref(target: ClientHorizonTarget): string | null {
    const routes = typeof routeApi === "function" ? routeApi() : null;
    return routes
      ? routes.routeToUrl({
          tab: target.tab,
          section: target.section as HorizonRoute["section"],
          id: target.id || null,
        })
      : null;
  }

  function renderHorizonTimeline(): void {
    headerTitle.textContent = "Horizon";
    const frame = CairnHorizonController.shellOptions();
    view.innerHTML = CairnHorizon.shellHtml(frame.view, { race: frame.race, raceLabel: frame.raceLabel });
    const host = view.querySelector("[data-horizon]");
    if (!host) return;
    CairnHorizonController.mount(host, {
      today: localISO(),
      load: (path: string) => api(path),
      // The Week landing paints its last-known read at once and revalidates (SWR).
      peek: (key: string) => (typeof peekCached === "function" ? peekCached(key) : null),
      cached: (path: string, options: { key: string }) =>
        typeof cachedApi === "function" ? (cachedApi(path, options) as Promise<unknown>) : api(path),
      navigate: horizonNavigate,
      hrefFor: horizonHref,
      reducedMotion: () => (typeof reducedMotion === "function" ? reducedMotion() : false),
    });
  }

  async function renderHorizonGoal(): Promise<void> {
    headerTitle.textContent = "Goal line";
    const token = ++pollToken;
    view.innerHTML =
      horizonBackHtml() +
      `<div id="horizonGoalBody" class="horizon-goal">${loadingState("Reading the goal line…")}</div>`;
    wireHorizonBack(view);
    // One /train-home?view=goal trip answers the four reads below (train-fan-in-client.ts).
    if (typeof CairnTrainFanIn !== "undefined") CairnTrainFanIn.prime("goal");
    const [journey, milestones, timeline, path] = await Promise.all([
      api("/journey").catch(() => null),
      api("/journey/milestones").catch(() => null),
      api("/journey/timeline").catch(() => null),
      api(`/today-path?date=${encodeURIComponent(localISO())}`).catch(() => null),
    ]);
    const body = view.querySelector<HTMLElement>("#horizonGoalBody");
    if (token !== pollToken || !body) return;
    const read = journey && typeof journey === "object" && !Array.isArray(journey) ? journey : null;
    const board =
      path && typeof path === "object" && !Array.isArray(path)
        ? CairnHorizon.goalsBoardHtml(path as import("../contracts/today-path.js").TodayPath)
        : "";
    const cards =
      board +
      (CairnProgressJourney?.journeyCardHtml?.(read, Array.isArray(milestones) ? milestones : [], { stagger }) || "") +
      (CairnJourneyTimeline?.timelineCardHtml?.(timeline, { stagger }) || "");
    body.innerHTML =
      cards ||
      CairnUi.emptyStateHtml({
        title: "No goal line yet",
        body: "A goal weight or a goal date in You → Profile draws one, and the road ahead fills in from your plan and your checkups.",
        className: "empty-state horizon-goal-empty",
      });
    CairnProgressJourney?.wire?.(body);
  }

  function renderHorizon(): unknown {
    return state.horizonSeg === "goal" ? renderHorizonGoal() : renderHorizonTimeline();
  }

  Object.assign(globalThis, { renderHorizon, horizonBackHtml, wireHorizonBack, horizonNavigate });
}

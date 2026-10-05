// @ts-check
// Train in one request. Each Train screen (the home, Program, Endurance — and Horizon's
// goal line, whose cards grew out of the Train home's journey reads) asks for its
// reads by their own paths, as it always has; this primes the request layer with ONE
// GET /train-home?view=… whose `responses` carry every one of those bodies, keyed by
// path (routes/screen-responses.ts). A read the fan-in came back without asks for
// itself; a fan-in that could not reach Cairn fails its reads without the wire, so each
// goes straight to its last-known paint (api-reach.ts). Any write clears every prime.
// Asked once per open: the same view's same reads asked again inside a few seconds (a
// repaint, the SWR refresh behind it) ride the first, like the Health fan-in.
type TrainFanInView = "overview" | "program" | "endurance" | "goal";

(() => {
  const REUSE_MS = 3000;
  let last: { key: string; at: number } | null = null;

  function pathsFor(view: TrainFanInView, date: string): string[] {
    const q = encodeURIComponent;
    if (view === "program") {
      return [
        "/coaching-focus", "/program-state", "/strength-journeys", "/strength-journey", "/performance",
        "/program/blocks/active", "/program/adjustments", "/test-week", "/muscle-trajectory", "/dexa-targeting",
        "/plan/look-ahead",
      ];
    }
    if (view === "goal") {
      // Horizon -> Goal line (horizon-screen.ts renderHorizonGoal): the journey story,
      // its milestones, the road ahead and the All-goals board's path read.
      return ["/journey", "/journey/milestones", "/journey/timeline", `/today-path?date=${q(date)}`];
    }
    if (view === "endurance") {
      return [
        "/stats", "/endurance-prs", "/endurance-goal", "/run-compliance", "/settings", "/run-plan", "/race-build",
        `/training-agenda?date=${q(date)}`, "/program-state", `/calibration/status?date=${q(date)}`,
      ];
    }
    return [];
  }

  // Prime `view`'s reads (or the caller's own list) from one /train-home request.
  function prime(view: TrainFanInView, paths?: readonly string[]): void {
    try {
      const date = localISO();
      const asked = paths && paths.length ? paths : pathsFor(view, date);
      const path = `/train-home?view=${view}&date=${encodeURIComponent(date)}`;
      const key = `${path} ${asked.join(",")} ${typeof apiWriteGeneration === "function" ? apiWriteGeneration() : 0}`;
      if (last && last.key === key && Date.now() - last.at < REUSE_MS) return;
      last = { key, at: Date.now() };
      apiPrime(asked, api(path as "/train-home").then((value) => (value as { responses?: unknown } | null)?.responses ?? null));
    } catch {
      /* every read simply asks for its own path */
    }
  }

  Object.assign(globalThis, { CairnTrainFanIn: { prime, pathsFor } });
})();

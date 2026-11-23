// @ts-check
// The timed-set stopwatch on a log row (split out of today-session-set-actions.ts): one
// running stopwatch per surface, kept as a clock anchor so a backgrounded tab still
// reads the right elapsed time when it wakes.
type TodaySessionStopwatchApi = {
  wire(row: HTMLElement, deps: ClientTodaySessionControllerDeps): { pause(): void; reset(): void } | null;
};
declare const CairnTodaySessionStopwatch: TodaySessionStopwatchApi;

{
  type TimedStopwatch = {
    pause(): void;
    reset(): void;
  };

  const activeTimedStopwatchBySurface = new WeakMap<HTMLElement, TimedStopwatch>();

  // Keep the source of truth as a clock anchor, rather than incrementing a
  // counter. Browsers throttle background timers, but Date.now() still gives the
  // right whole-second elapsed time when the row wakes up again.
  function wireTimedStopwatch(row: HTMLElement, deps: ClientTodaySessionControllerDeps): TimedStopwatch | null {
    if (row.dataset.mode !== "timed") return null;
    const duration = row.querySelector<HTMLInputElement>(".in-dur");
    const button = row.querySelector<HTMLButtonElement>(".timerbtn");
    if (!duration || !button) return null;
    const durationEl = duration;
    const timerButton = button;

    let elapsedMs = 0;
    let startedAt: number | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopwatch: TimedStopwatch;

    function clearTick(): void {
      if (interval != null) clearInterval(interval);
      interval = null;
    }

    function render(state: "idle" | "running" | "paused"): void {
      timerButton.dataset.stopwatchState = state;
      timerButton.textContent = state === "running" ? "Stop" : state === "paused" ? "Resume" : "Start";
      const exercise = decodeURIComponent(row.dataset.ex || "exercise");
      timerButton.ariaLabel =
        state === "running"
          ? `Stop ${exercise} stopwatch`
          : state === "paused"
            ? `Resume ${exercise} stopwatch`
            : `Start ${exercise} stopwatch`;
      timerButton.ariaPressed = state === "running" ? "true" : "false";
    }

    function elapsedNowMs(): number {
      return elapsedMs + (startedAt == null ? 0 : Math.max(0, Date.now() - startedAt));
    }

    function renderDuration(): void {
      const formatted = deps.fmtDur(Math.floor(elapsedNowMs() / 1000));
      if (durationEl.value === formatted) return;
      durationEl.value = formatted;
      durationEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function sync(): void {
      if (startedAt == null) return;
      renderDuration();
    }

    function rowDetached(): boolean {
      // The parent check keeps the small test DOM supported, while real detached
      // cards report false for both the row and its parent via isConnected.
      return row.isConnected === false && (!row.parentElement || row.parentElement.isConnected === false);
    }

    function pause(): void {
      if (startedAt == null) return;
      elapsedMs = elapsedNowMs();
      startedAt = null;
      renderDuration();
      clearTick();
      if (activeTimedStopwatchBySurface.get(deps.root) === stopwatch) activeTimedStopwatchBySurface.delete(deps.root);
      render("paused");
    }

    function takeActiveStopwatch(): void {
      const active = activeTimedStopwatchBySurface.get(deps.root);
      if (active && active !== stopwatch) active.pause();
      activeTimedStopwatchBySurface.set(deps.root, stopwatch);
      deps.stopRest();
    }

    function start(): void {
      // A new run deliberately ignores any prescribed / last-set prefill.
      elapsedMs = 0;
      startedAt = Date.now();
      takeActiveStopwatch();
      renderDuration();
      render("running");
      clearTick();
      interval = setInterval(() => {
        if (rowDetached()) {
          clearTick();
          return;
        }
        sync();
      }, 250);
    }

    function resume(): void {
      startedAt = Date.now();
      takeActiveStopwatch();
      render("running");
      clearTick();
      interval = setInterval(() => {
        if (rowDetached()) {
          clearTick();
          return;
        }
        sync();
      }, 250);
    }

    timerButton.addEventListener("click", () => {
      if (startedAt != null) pause();
      else if (elapsedMs > 0) resume();
      else start();
    });
    render("idle");

    stopwatch = {
      pause,
      reset() {
        clearTick();
        elapsedMs = 0;
        startedAt = null;
        if (activeTimedStopwatchBySurface.get(deps.root) === stopwatch) activeTimedStopwatchBySurface.delete(deps.root);
        render("idle");
      },
    };
    return stopwatch;
  }

  const CAIRN_TODAY_SESSION_STOPWATCH: TodaySessionStopwatchApi = { wire: wireTimedStopwatch };
  Object.assign(globalThis, { CairnTodaySessionStopwatch: CAIRN_TODAY_SESSION_STOPWATCH });
}

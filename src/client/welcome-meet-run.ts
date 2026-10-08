// @ts-check
// One run of the welcome's Meet stage, painted one thing at a time.
//
// The welcome job lands its pieces in order — the coach's reply, then the starting fuel,
// then (the slow part) the first week — and each rides the job's phase meta the moment
// it exists (ClientWelcomePhaseMeta). This module turns those snapshots into the
// conversation: a "Reading what you said" line, the coach's reply as its own bubble,
// the starting point for food as a small card, then "Putting together your first week"
// with a quiet line that keeps moving, and finally the week itself, day by day. Each
// piece is painted once, whichever way it arrives (a live phase, a reload's snapshot, a
// poll, or only the final result), so nothing repeats and nothing is skipped.
//
// It also owns the light job watch the Meet stage uses when the live stream goes quiet
// (a proxy that closes the stream during a restart) and after the person leaves to look
// around while the week is still composing.
(() => {
  type WelcomeRunDeps = {
    /** Append one bubble to the log (escaped markup), returning it. */
    append(html: string): HTMLElement | null;
    /** The week is being built: the composer gives way to "look around". */
    onWeekStarted(): void;
  };

  type WelcomeRunResult = {
    reply?: string;
    week?: unknown;
    week_state?: string;
    fuel?: unknown;
    fuel_state?: string;
  };

  type WelcomeRun = {
    begin(): void;
    phase(job: unknown): void;
    reveal(result: WelcomeRunResult): void;
    /** Remove every bubble this run painted (a retry starts clean). */
    drop(): void;
    stop(): void;
    /** The coach's reply is already on screen. */
    replied(): boolean;
  };

  // The house thinking captions (ui-feedback-client.ts) — eager, so present wherever the
  // welcome is; a missing one simply leaves the second line empty.
  function caption(el: Element | null, script: string): () => void {
    const fn = (globalThis as { thinkingCaption?: (el: Element | null, op?: unknown) => () => void }).thinkingCaption;
    return typeof fn === "function" ? fn(el, script) : () => {};
  }

  function createRun(deps: WelcomeRunDeps): WelcomeRun {
    let working: HTMLElement | null = null;
    let workingStep: WelcomeWorkingStep | null = null;
    let stopCaption: () => void = () => {};
    let replyShown = false;
    let fuelShown = false;
    let lastDetail = "";
    let dayKeys: string[] = [];
    const nodes: HTMLElement[] = [];

    const keep = (node: HTMLElement | null): HTMLElement | null => {
      if (node) {
        node.setAttribute("data-wel-run", "");
        nodes.push(node);
      }
      return node;
    };

    function clearWorking(): void {
      stopCaption();
      stopCaption = () => {};
      working?.remove();
      working = null;
      workingStep = null;
    }

    function work(step: WelcomeWorkingStep): void {
      if (workingStep === step && working?.isConnected) return;
      clearWorking();
      working = keep(deps.append(CairnWelcomeClient.workingHtml(step)));
      workingStep = step;
      stopCaption = caption(working?.querySelector(".wel-cap") || null, step === "week" ? "compose_week" : "onboard");
    }

    function showReply(text: string): void {
      if (replyShown || !text) return;
      replyShown = true;
      clearWorking();
      keep(deps.append(CairnWelcomeClient.coachBubbleHtml(text)));
    }

    function showFuel(fuel: { main: string; sub: string } | null): void {
      if (fuelShown) return;
      fuelShown = true;
      if (fuel) keep(deps.append(CairnWelcomeClient.fuelHtml(fuel)));
    }

    // The composer's own words, as the second line, the moment they change; the
    // rotating caption carries on from there.
    function showDetail(detail: string): void {
      if (!detail || detail === lastDetail) return;
      lastDetail = detail;
      const cap = working?.querySelector<HTMLElement>(".wel-cap");
      if (cap) cap.textContent = `${detail.charAt(0).toUpperCase()}${detail.slice(1)}…`;
    }

    // The week, day by day as the composer writes it: rows under "Putting together your
    // first week". Only new rows are added (each with its own stagger), so a phase that
    // repeats what is already there paints nothing; an order that changed starts over.
    function showDays(rows: WelcomeWeekRow[]): void {
      if (!rows.length || workingStep !== "week" || !working?.isConnected) return;
      let list = working.querySelector<HTMLElement>(".wel-week-live");
      if (!list) {
        working.insertAdjacentHTML(
          "beforeend",
          `<ul class="wel-week wel-week-live" aria-label="Your first week so far"></ul>`
        );
        list = working.querySelector<HTMLElement>(".wel-week-live");
        dayKeys = [];
      }
      if (!list) return;
      const keys = rows.map((row) => `${row.day}|${row.name}`);
      if (!dayKeys.every((key, i) => keys[i] === key)) {
        list.innerHTML = "";
        dayKeys = [];
      }
      for (let i = dayKeys.length; i < rows.length; i++) {
        list.insertAdjacentHTML("beforeend", CairnWelcomeClient.weekRowHtml(rows[i], i - dayKeys.length));
      }
      dayKeys = keys;
    }

    return {
      begin() {
        work("understand");
      },
      phase(job) {
        const p = CairnWelcomeModel.partial(job);
        if (p.reply) showReply(p.reply);
        if (p.fuelKnown) {
          showFuel(p.fuel);
          if (workingStep !== "week") {
            work("week");
            deps.onWeekStarted();
          }
          showDetail(p.detail);
          showDays(p.days);
        }
      },
      reveal(result) {
        clearWorking();
        // Whatever the live phases did not get to paint, in the same order.
        showReply(String(result.reply || ""));
        showFuel(CairnWelcomeModel.fuelLines(result.fuel, result.fuel_state));
        const week = CairnWelcomeModel.weekRows(result.week);
        keep(
          deps.append(
            CairnWelcomeClient.revealHtml({
              reply: "",
              week,
              weekNote: CairnWelcomeModel.weekNote(result.week_state, week.length > 0),
              fuel: null,
            })
          )
        );
      },
      drop() {
        clearWorking();
        for (const node of nodes.splice(0)) node.remove();
        replyShown = false;
        fuelShown = false;
        lastDetail = "";
        dayKeys = [];
      },
      stop() {
        stopCaption();
        stopCaption = () => {};
      },
      replied: () => replyShown,
    };
  }

  type JobRow = { status?: string; result?: unknown; error?: unknown; [key: string]: unknown };

  /**
   * Read one job every `everyMs` until it ends (or `stop()`), handing each row to `onRow`.
   * A failed read is skipped, never fatal: the next tick tries again.
   */
  function watchJob(id: string, everyMs: number, onRow: (job: JobRow) => void, maxMs = 20 * 60 * 1000): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    const started = Date.now();
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = (await api(`/agent-jobs/${encodeURIComponent(id)}`)) as { job?: JobRow } | null;
        if (stopped) return;
        const job = res?.job;
        if (job) {
          onRow(job);
          if (["done", "error", "canceled"].includes(String(job.status))) {
            stopped = true;
            return;
          }
        }
      } catch {}
      if (!stopped && Date.now() - started < maxMs) timer = setTimeout(() => void tick(), everyMs);
    };
    timer = setTimeout(() => void tick(), everyMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  /**
   * The person left to look around while the week composes. The job carries on on the
   * server; the app's first-week card (first-week-client.ts, eager) follows it from here —
   * Today shows the days as they arrive, and one calm notice says when it is ready —
   * including the compose job a busy host handed the week to.
   */
  function followAfterLeave(_id: string): void {
    firstWeek()?.track();
  }

  /** The week landed: drop the caches it makes stale and repaint Today/Train if showing. */
  function landed(): void {
    firstWeek()?.landed();
  }

  function firstWeek(): FirstWeekApi | undefined {
    return (globalThis as { CairnFirstWeek?: FirstWeekApi }).CairnFirstWeek;
  }

  Object.assign(globalThis, { CairnWelcomeRun: { create: createRun, watchJob, followAfterLeave, landed } });
})();

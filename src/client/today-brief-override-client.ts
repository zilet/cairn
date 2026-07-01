// @ts-check
// Today Brief override job wiring: chip busy state, run options, and reconnect.

type TodayBriefOverrideDayRead = import("../contracts/client.js").ClientDayRead & {
  _provisional?: boolean;
  override?: string | null;
};

type TodayBriefOverrideRunOptions = ClientAgentOpHandlers & {
  path: "/today-read/reshape";
  anchor: ".brief";
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => void;
  onFail: (error: unknown) => void;
};

(() => {
  function paintBriefReshaping(brief: Element, chip: HTMLElement | null, deps: ClientTodayBriefOverrideDeps): void {
    const chipLabel = chip ? (chip.textContent || "").trim() : "";
    brief.querySelectorAll<HTMLButtonElement>(".brief-steer-opt").forEach((button) => {
      button.classList.toggle("brief-steer-active", button === chip);
      if (button !== chip) button.disabled = true;
    });
    const resetBtn = brief.querySelector<HTMLButtonElement>("[data-steerreset]");
    if (resetBtn) resetBtn.disabled = true;
    if (chip) {
      chip.classList.add("brief-steer-busy");
      chip.innerHTML = `<span class="aspin aspin-xs"></span>${deps.escapeHtml(chipLabel)}`;
    }
    if (!deps.reducedMotion()) brief.classList.add("is-thinking");
    brief.setAttribute("aria-busy", "true");
    if (!brief.querySelector(".athinking-note")) {
      const note = document.createElement("div");
      note.className = "athinking-note chip-in";
      note.setAttribute("role", "status");
      note.textContent = "Reading the day again...";
      const anchor = brief.querySelector(".brief-steer") || brief;
      anchor.after ? anchor.after(note) : brief.appendChild(note);
    }
  }

  function dayReadOverrideOpOpts(
    args: { intent?: string; prevFocus?: unknown } = {},
    deps: ClientTodayBriefOverrideDeps,
  ): TodayBriefOverrideRunOptions {
    const intent = args.intent || "";
    return {
      path: "/today-read/reshape",
      anchor: ".brief",
      guard: () => !deps.root.querySelector(".brief")?.isConnected,
      isFail: (result: unknown) => {
        const row = result && typeof result === "object" ? result as { kind?: unknown } : null;
        return !row || !row.kind;
      },
      render: (result: unknown) => {
        const read = result as TodayBriefOverrideDayRead;
        if (deps.state.tab !== "today") {
          deps.state.brief = null;
          return;
        }
        deps.state.brief = { date: deps.state.logDate, override: intent || read.override || "", read };
        const morph = !deps.reducedMotion();
        if (morph) {
          deps.root.querySelector(".brief")?.classList.add("brief-morph");
          deps.state._briefMorph = true;
        }
        Promise.resolve(deps.withViewTransition(() => deps.renderToday())).finally(() => {
          deps.state._briefMorph = false;
          deps.root.querySelector(".brief")?.classList.remove("brief-morph");
        });
        if (/short on time/i.test(intent || "")) deps.askForSession({ minutes: 30, focus: read.focus || args.prevFocus || undefined });
      },
      onFail: (_err: unknown) => {
        deps.state.brief = null;
        const live = deps.root.querySelector(".brief");
        if (live) {
          live.classList.remove("is-thinking");
          live.removeAttribute("aria-busy");
          live.querySelector(".athinking-note")?.remove();
        }
        if (deps.state.tab === "today") deps.renderToday();
      },
    };
  }

  function reconnectDayReadOverride(job: unknown, deps: ClientTodayBriefOverrideDeps): ClientAgentOpHandlers | null {
    if (deps.state.tab !== "today") return null;
    const brief = deps.root.querySelector(".brief");
    if (!brief) return null;
    const row = job && typeof job === "object" ? job as { input?: { override?: unknown } } : {};
    const intent = row.input && typeof row.input.override === "string" ? row.input.override : "";
    const chip = Array.from(brief.querySelectorAll<HTMLElement>(".brief-steer-opt")).find((button) => button.dataset.override === intent) || null;
    deps.state.brief = null;
    paintBriefReshaping(brief, chip, deps);
    const options = dayReadOverrideOpOpts({ intent, prevFocus: null }, deps);
    const clearBusy = () => {
      const live = deps.root.querySelector(".brief");
      if (live) live.classList.remove("is-thinking", "is-thinking--determinate");
    };
    return {
      guard: options.guard,
      onDone: (result: unknown) => {
        clearBusy();
        if (options.isFail(result)) options.onFail(result);
        else options.render(result);
      },
      onError: () => {
        clearBusy();
        options.onFail(null);
      },
      onCanceled: () => {
        clearBusy();
        options.onFail(null);
      },
    };
  }

  const CAIRN_TODAY_BRIEF_OVERRIDE_CLIENT = {
    dayReadOverrideOpOpts,
    paintBriefReshaping,
    reconnectDayReadOverride,
  };

  Object.assign(globalThis, { CairnTodayBriefOverrideClient: CAIRN_TODAY_BRIEF_OVERRIDE_CLIENT });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayBriefOverrideClient: CAIRN_TODAY_BRIEF_OVERRIDE_CLIENT });
  }
})();

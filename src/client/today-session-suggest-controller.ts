// @ts-check
// Today session-suggestion execution wiring: request lifecycle, reconnect, and actions.

type TodaySuggestedSession = import("../contracts/client.js").ClientSessionSuggestion;
type TodaySuggestedItem = import("../contracts/client.js").ClientSessionSuggestionItem;

type TodaySessionSuggestState = {
  logDate?: string;
  suggestedSession?: TodaySuggestedSession | null;
};

type TodaySessionSuggestRunOptions = {
  path: "/session-suggest";
  anchor: "#sugSlot";
  caption: "session_suggest";
  guard: () => boolean;
  isFail: (result: unknown) => boolean;
  render: (result: unknown) => void;
  onFail: (result?: unknown) => void;
};

type TodaySessionSuggestReconnectHandlers = TodaySessionSuggestRunOptions & {
  onDone(result: unknown): void;
  onError(): void;
  onCanceled(): void;
};

type TodaySessionSuggestAskOptions = {
  minutes?: unknown;
  focus?: unknown;
  equipment?: unknown;
  constraints?: unknown;
};

type TodaySessionSuggestDeps = {
  root: ParentNode;
  state: TodaySessionSuggestState;
  runOp(kind: "session_suggest", body: Record<string, unknown>, options: TodaySessionSuggestRunOptions): Promise<unknown>;
  thinkingCaption(el: Element, op?: string | readonly string[]): () => void;
  runCountUps(scope?: ParentNode | null, options?: { snap?: boolean }): void;
  collapseEl(el: Element, done?: () => void): void;
  reducedMotion(): boolean;
  toast(message: string): void;
  revealPlanThen(after: () => unknown, opts?: { blank?: boolean }): unknown;
  appendOffPlanCard(name: unknown, mode: "timed" | "reps"): unknown;
};

(() => {
  let sessionSuggestInFlight = false;

  function suggestSlot(deps: TodaySessionSuggestDeps): Element | null {
    return deps.root.querySelector("#sugSlot");
  }

  function suggestedItemMode(item: Partial<TodaySuggestedItem>): "timed" | "reps" {
    return item.mode === "timed" || item.target_seconds != null ? "timed" : "reps";
  }

  function sessionSuggestOpOpts(deps: TodaySessionSuggestDeps): TodaySessionSuggestRunOptions {
    return {
      path: "/session-suggest",
      anchor: "#sugSlot",
      caption: "session_suggest",
      guard: () => {
        const gone = !suggestSlot(deps)?.isConnected;
        if (gone) sessionSuggestInFlight = false;
        return gone;
      },
      isFail: (result: unknown) => {
        const row = result && typeof result === "object" ? result as Record<string, unknown> : null;
        return !row || row.ok !== true || !row.session;
      },
      render: (result: unknown) => {
        const row = result as { session: TodaySuggestedSession; verified?: unknown };
        sessionSuggestInFlight = false;
        const slot = suggestSlot(deps);
        if (!slot) return;
        deps.state.suggestedSession = row.session;
        slot.innerHTML = CairnTodaySessionSuggest.cardHtml(row.session, row.verified);
        deps.runCountUps(slot);
        wireSuggestCard(slot, deps);
        slot.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "nearest" });
      },
      onFail: (result?: unknown) => {
        sessionSuggestInFlight = false;
        const slot = suggestSlot(deps);
        if (!slot) return;
        slot.innerHTML = CairnTodaySessionSuggest.failureHtml(result);
        wireSuggestCard(slot, deps);
      },
    };
  }

  function revealSessionComposer(deps: TodaySessionSuggestDeps): void {
    const slot = suggestSlot(deps);
    if (!slot || sessionSuggestInFlight) return;
    slot.innerHTML = CairnTodaySessionSuggest.composerHtml();
    const input = slot.querySelector<HTMLInputElement>(".sug-prompt");
    if (input && !deps.reducedMotion()) setTimeout(() => input.focus(), 60);
    const go = () => {
      const constraints = (input?.value || "").trim();
      void askForSession(constraints ? { constraints } : {}, deps);
    };
    slot.querySelector("[data-sugbuild]")?.addEventListener("click", go);
    slot.querySelector("[data-sugcancel]")?.addEventListener("click", () => {
      slot.innerHTML = "";
    });
    slot.querySelectorAll<HTMLElement>("[data-vibe]").forEach((button) => button.addEventListener("click", () => {
      if (!input) return;
      input.value = input.value.trim() ? `${input.value.trim()}, ${button.dataset.vibe}` : button.dataset.vibe || "";
      input.focus();
    }));
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        go();
      }
    });
  }

  async function askForSession(opts: TodaySessionSuggestAskOptions = {}, deps: TodaySessionSuggestDeps): Promise<void> {
    if (sessionSuggestInFlight) {
      deps.toast("Already drafting a session…");
      return;
    }
    const slot = suggestSlot(deps);
    if (!slot) return;
    sessionSuggestInFlight = true;
    slot.innerHTML = CairnTodaySessionSuggest.loadingHtml();
    const body: Record<string, unknown> = { date: deps.state.logDate };
    if (opts.minutes != null) body.minutes = opts.minutes;
    if (opts.focus) body.focus = opts.focus;
    if (opts.equipment) body.equipment = opts.equipment;
    if (opts.constraints) body.constraints = opts.constraints;

    await deps.runOp("session_suggest", body, sessionSuggestOpOpts(deps));
  }

  function wireSuggestCard(slot: Element, deps: TodaySessionSuggestDeps): void {
    slot.querySelectorAll<HTMLElement>("[data-sugaction]").forEach((button) =>
      button.addEventListener("click", () => {
        const action = button.dataset.sugaction;
        const card = slot.querySelector(".sug-card");
        if (action === "dismiss") {
          deps.state.suggestedSession = null;
          if (card) deps.collapseEl(card, () => {
            slot.innerHTML = "";
          });
          else slot.innerHTML = "";
          return;
        }
        if (action === "retry") {
          void askForSession({}, deps);
          return;
        }
        if (action !== "log") return;
        const session = deps.state.suggestedSession;
        if (!session || !Array.isArray(session.items)) return;
        const handoff = () => {
          deps.revealPlanThen(() => {
            for (const item of session.items) {
              if (!item || !item.exercise) continue;
              deps.appendOffPlanCard(item.exercise, suggestedItemMode(item));
            }
            deps.state.suggestedSession = null;
            const currentSlot = suggestSlot(deps);
            if (currentSlot) currentSlot.innerHTML = "";
            deps.toast("Added to today — log as you go");
          }, { blank: true });
        };
        if (card && deps.root.querySelector(".addex")) deps.collapseEl(card, handoff);
        else handoff();
      })
    );
  }

  function reconnectSessionSuggest(_job: unknown, deps: TodaySessionSuggestDeps): TodaySessionSuggestReconnectHandlers | null {
    const slot = suggestSlot(deps);
    if (!slot) return null;
    sessionSuggestInFlight = true;
    slot.innerHTML = CairnTodaySessionSuggest.loadingHtml();
    const options = sessionSuggestOpOpts(deps);
    let stop = () => {};
    const capEl = slot.querySelector(".job-cap");
    if (capEl) stop = deps.thinkingCaption(capEl, options.caption);
    if (!deps.reducedMotion()) slot.classList.add("is-thinking");
    const clear = () => {
      stop();
      const currentSlot = suggestSlot(deps);
      if (currentSlot instanceof HTMLElement) {
        currentSlot.classList.remove("is-thinking", "is-thinking--determinate");
        currentSlot.style.removeProperty("--frac");
      }
    };
    return {
      ...options,
      onDone: (result: unknown) => {
        clear();
        if (options.isFail(result)) options.onFail(result);
        else options.render(result);
      },
      onError: () => {
        clear();
        options.onFail(null);
      },
      onCanceled: () => {
        clear();
        options.onFail(null);
      },
    };
  }

  const CAIRN_TODAY_SESSION_SUGGEST_CONTROLLER = {
    askForSession,
    reconnectSessionSuggest,
    revealSessionComposer,
    sessionSuggestOpOpts,
    wireSuggestCard,
  };

  Object.assign(globalThis, { CairnTodaySessionSuggestController: CAIRN_TODAY_SESSION_SUGGEST_CONTROLLER });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionSuggestController = CAIRN_TODAY_SESSION_SUGGEST_CONTROLLER;
  }
})();

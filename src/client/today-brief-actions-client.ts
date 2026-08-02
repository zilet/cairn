// @ts-check
// Today Brief DOM actions: steer chips, redirects, reset, and small disclosures.

type TodayBriefActionsDayRead = import("../contracts/client.js").ClientDayRead & {
  _provisional?: boolean;
  override?: string | null;
};

(() => {
  let agentOfflineDismissed = false;

  function offlineDismissed(): boolean {
    return agentOfflineDismissed;
  }

  function wireAgentOffline(scope: ParentNode | null | undefined, deps: ClientTodayBriefActionsDeps): void {
    (scope || deps.root).querySelectorAll("[data-agentoffx]").forEach((button) =>
      button.addEventListener("click", () => {
        agentOfflineDismissed = true;
        const el = button.closest(".agent-offline");
        if (el) deps.collapseEl(el, () => el.remove());
        else button.remove();
      }));
  }

  function handleBriefRedirect(action: string | undefined, trigger: HTMLElement, deps: ClientTodayBriefActionsDeps): void {
    if (action === "ask-session") {
      deps.revealSessionComposer();
      return;
    }
    if (action === "view-week") {
      deps.activateTab("plan");
      return;
    }
    if (action === "view-program") {
      deps.state.progressSeg = "program";
      deps.activateTab("progress");
      return;
    }
    if (action === "start-session" || action === "reveal-plan") {
      // Logging lives in the isolated Session destination now, not inline on Today.
      void openSession(undefined, {
        source: "adaptive_plan",
        trigger,
        trainAnyway: action === "reveal-plan",
        replace: action === "reveal-plan",
        provenance: { entry: action === "reveal-plan" ? "train_anyway" : "brief_start" },
      });
      return;
    }
    if (action === "pull-plan") {
      const rawDay = (deps.state as typeof deps.state & { day?: unknown }).day;
      const dayNumber = rawDay == null ? null : Number(rawDay);
      void openSession(undefined, {
        source: "manual_plan",
        dayNumber: Number.isFinite(dayNumber) ? dayNumber : null,
        replace: true,
        trigger,
        provenance: { entry: "pull_plan" },
      });
    }
  }

  async function resetBriefRead(brief: Element, steerReset: HTMLElement, deps: ClientTodayBriefActionsDeps): Promise<void> {
    if (brief.classList.contains("is-thinking")) return;
    brief.querySelectorAll<HTMLButtonElement>(".brief-steer-opt").forEach((chip) => { chip.disabled = true; });
    if (steerReset instanceof HTMLButtonElement) steerReset.disabled = true;
    steerReset.innerHTML = `<span class="aspin aspin-xs"></span>back to today's read`;
    brief.classList.add("is-thinking");
    const note = document.createElement("div");
    note.className = "athinking-note chip-in";
    note.textContent = "Reading the day again...";
    (steerReset.closest(".brief-steer") || steerReset.parentElement)?.after(note);
    deps.state.brief = null;
    try {
      const qs = new URLSearchParams({ date: deps.state.logDate, agent: "auto", reset: "1" });
      const fresh = await deps.api("/today-read?" + qs.toString()) as TodayBriefActionsDayRead;
      deps.state.brief = {
        date: deps.state.logDate,
        override: fresh && fresh.override ? fresh.override : "",
        read: fresh && fresh.kind ? fresh : { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic" },
      };
    } catch {
      deps.state.brief = null;
    }
    if (deps.state.tab !== "today") return;
    const morph = !deps.reducedMotion();
    if (morph) {
      brief.classList.add("brief-morph");
      deps.state._briefMorph = true;
    }
    try {
      await deps.withViewTransition(() => deps.renderToday());
    } finally {
      deps.state._briefMorph = false;
      deps.root.querySelector(".brief")?.classList.remove("brief-morph");
    }
  }

  function wireBriefActions(
    read: TodayBriefActionsDayRead,
    _options: { isToday?: boolean },
    deps: ClientTodayBriefActionsDeps,
  ): void {
    const brief = deps.root.querySelector(".brief");
    if (!brief) return;
    wireAgentOffline(brief, deps);

    brief.querySelectorAll<HTMLElement>("[data-override]").forEach((button) =>
      button.addEventListener("click", () => {
        const intent = button.dataset.override || "";
        if (brief.classList.contains("is-thinking")) return;
        CairnTodayBriefOverrideClient.paintBriefReshaping(brief, button, deps);
        deps.state.brief = null;
        deps.runOp("day_read_override", { date: deps.state.logDate, override: intent, agent: "auto" },
          CairnTodayBriefOverrideClient.dayReadOverrideOpOpts({ intent, prevFocus: read.focus }, deps));
      })
    );

    // A recovery-menu tap is one tap: ask for exactly this option and put it on
    // today. The option's own minutes/detail become the request, so what lands is
    // the thing the athlete read, not a generic session. Rest stays the default —
    // nothing here fires unless it is tapped.
    brief.querySelectorAll<HTMLElement>("[data-recovery-opt]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-busy") === "true") return;
        const label = button.dataset.recoveryOpt || "";
        const detail = button.dataset.recoveryDetail || "";
        const minutes = Number(button.dataset.recoveryMin);
        button.setAttribute("aria-busy", "true");
        void Promise.resolve(
          deps.askForSession({
            focus: label,
            ...(Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}),
            // The detail is the coach's own caveat for this option ("nothing that
            // asks anything of the …"). Passing it verbatim is what keeps a guarded
            // menu guarded once it becomes a real session.
            ...(detail ? { constraints: detail } : {}),
            autoUse: true,
          })
        ).finally(() => button.removeAttribute("aria-busy"));
      })
    );

    brief.querySelectorAll<HTMLElement>("[data-redirect]").forEach((button) =>
      button.addEventListener("click", () => {
        handleBriefRedirect(button.dataset.redirect, button, deps);
      })
    );

    const steerReset = brief.querySelector<HTMLElement>("[data-steerreset]");
    if (steerReset) steerReset.addEventListener("click", () => {
      void resetBriefRead(brief, steerReset, deps);
    });

    const whyBtn = brief.querySelector<HTMLElement>("[data-briefwhy]");
    if (whyBtn && read.signals && Object.keys(read.signals).length) {
      whyBtn.hidden = false;
      whyBtn.addEventListener("click", () => {
        const open = brief.querySelector(".brief-why-panel");
        if (open) {
          open.remove();
          whyBtn.textContent = "tap to see why";
          return;
        }
        // Reading-grammar contributor rows (Amendment 2) when the primitive is
        // loaded and the read yields any; otherwise the calm prose summary — the
        // panel is never empty.
        const rows = CairnTodayBrief.signalsRows(read);
        const reads = (globalThis as { CairnUiReads?: { contributorRowsHtml(rows: unknown): string } }).CairnUiReads;
        const rowsHtml =
          rows.length && reads && typeof reads.contributorRowsHtml === "function"
            ? reads.contributorRowsHtml(rows)
            : "";
        const panel = document.createElement("div");
        panel.className = "brief-why-panel chip-in";
        if (rowsHtml) {
          panel.innerHTML = rowsHtml;
        } else {
          const prose = document.createElement("p");
          prose.className = "brief-signals";
          prose.textContent = CairnTodayBrief.signalsText(read);
          panel.appendChild(prose);
        }
        whyBtn.before(panel);
        whyBtn.textContent = "hide";
      });
    }
  }

  const CAIRN_TODAY_BRIEF_ACTIONS_CLIENT = {
    offlineDismissed,
    wireBriefActions,
  };

  Object.assign(globalThis, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });
  }
})();

// @ts-check
// Today Brief DOM actions: steer chips, redirects, reset, and small disclosures.

type TodayBriefActionsDayRead = import("../contracts/client.js").ClientDayRead & {
  _provisional?: boolean;
  override?: string | null;
};

(() => {
  let agentOfflineDismissed = false;
  // The date the server last refused a rest-trade on. Removing the button is not
  // enough on its own: the Brief repaints from the same read, `leaning` is still
  // true, and the offer comes straight back — so the refusal has to be state the
  // render can see. Per date, because tomorrow is a different question.
  let tradeRefusedDate = "";

  function offlineDismissed(): boolean {
    return agentOfflineDismissed;
  }

  function tradeRefusedOn(date: unknown): boolean {
    const iso = String(date ?? "");
    return !!iso && tradeRefusedDate === iso;
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
      // The forward line is about training, so it opens the Training segment's week —
      // never whichever Plan segment (Food, Meals) happened to be open last.
      deps.state.planJump = "edit";
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
      // When the launch card was folded into the Brief (one action, one button),
      // this start binds to the same reviewed preview the card would have.
      const fold = (deps.state as { briefSession?: { date?: unknown; preview?: unknown } | null }).briefSession;
      const folded = action === "start-session" && !!fold && fold.date === deps.state.logDate;
      void openSession(undefined, {
        source: "adaptive_plan",
        trigger,
        trainAnyway: action === "reveal-plan",
        replace: action === "reveal-plan",
        provenance: { entry: action === "reveal-plan" ? "train_anyway" : "brief_start" },
        ...(folded
          ? { preview: (fold!.preview ?? null) as import("../contracts/client-api.js").ClientDailySessionPreview | null }
          : {}),
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

  // "Train today, rest tomorrow" — the athlete taking the day and CLAIMING tomorrow
  // as the rest, in one tap. The server owns whether the trade is allowed (a
  // rest-grade morning, a symptom or anything clinical is a floor, never a trade)
  // and answers `{ok:false}` at HTTP 200 when it isn't; either way the button simply
  // goes away rather than arguing. A server with no such endpoint at all (404 →
  // thrown) lands in exactly the same place, so this degrades to today's behavior.
  async function tradeRestTomorrow(button: HTMLElement, deps: ClientTodayBriefActionsDeps): Promise<void> {
    if (button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    let result: { ok?: unknown; read?: unknown } | null = null;
    try {
      result = await deps.api("/today-read/trade-rest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: deps.state.logDate }),
      }) as { ok?: unknown; read?: unknown } | null;
    } catch {
      result = null;
    }
    button.removeAttribute("aria-busy");
    const read =
      result && result.ok === true && result.read && typeof result.read === "object"
        ? (result.read as TodayBriefActionsDayRead)
        : null;
    if (!read || !read.kind) {
      // Refused (ok:false at HTTP 200) or no such endpoint at all. Remember it for
      // this date so the next repaint does not re-offer a trade the server has
      // already said it cannot honour.
      tradeRefusedDate = String(deps.state.logDate ?? "");
      button.remove();
      return;
    }
    deps.state.brief = { date: deps.state.logDate, override: read.override || "", read };
    deps.toast("Tomorrow's held for rest");
    if (deps.state.tab !== "today") return;
    await deps.withViewTransition(() => deps.renderToday());
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

    brief.querySelectorAll<HTMLElement>("[data-tradetomorrow]").forEach((button) =>
      button.addEventListener("click", () => {
        void tradeRestTomorrow(button, deps);
      })
    );

    const steerReset = brief.querySelector<HTMLElement>("[data-steerreset]");
    if (steerReset) steerReset.addEventListener("click", () => {
      void resetBriefRead(brief, steerReset, deps);
    });

    // "tap to see why" discloses the read's signals AND its provenance — the
    // sync/read clock stamp (rendered hidden at the foot of the Brief) opens and
    // closes with it, so engineering residue never sits on the Brief's face.
    const whyBtn = brief.querySelector<HTMLElement>("[data-briefwhy]");
    const hasSignals = !!(read.signals && Object.keys(read.signals).length);
    const stampEl = () => brief.querySelector<HTMLElement>("[data-brief-stamp]");
    if (whyBtn && (hasSignals || stampEl())) {
      whyBtn.hidden = false;
      whyBtn.addEventListener("click", () => {
        const stamp = stampEl();
        const isOpen = whyBtn.getAttribute("aria-expanded") === "true";
        if (isOpen) {
          brief.querySelector(".brief-why-panel")?.remove();
          if (stamp) stamp.hidden = true;
          whyBtn.textContent = "tap to see why";
          whyBtn.setAttribute("aria-expanded", "false");
          return;
        }
        whyBtn.setAttribute("aria-expanded", "true");
        whyBtn.textContent = "hide";
        if (stamp) stamp.hidden = false;
        if (!hasSignals) return;
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
        (stamp || whyBtn).before(panel);
      });
    }
  }

  const CAIRN_TODAY_BRIEF_ACTIONS_CLIENT = {
    offlineDismissed,
    tradeRefusedOn,
    wireBriefActions,
  };

  Object.assign(globalThis, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });
  }
})();

// @ts-check
// Today Brief DOM actions: steer chips, redirects, reset, and small disclosures.

type TodayBriefActionsDayRead = import("../contracts/client.js").ClientDayRead & {
  _provisional?: boolean;
  override?: string | null;
};

(() => {
  // The date the server last refused a rest-trade on. Removing the button is not
  // enough on its own: the Brief repaints from the same read, `leaning` is still
  // true, and the offer comes straight back — so the refusal has to be state the
  // render can see. Per date, because tomorrow is a different question.
  let tradeRefusedDate = "";

  function tradeRefusedOn(date: unknown): boolean {
    const iso = String(date ?? "");
    return !!iso && tradeRefusedDate === iso;
  }

  // A one-tap menu row (recovery menu, run-before-legs) asks for a session and puts
  // it straight on today. The drafting is shown ON THE TAPPED ROW — a spinner and the
  // job's own rotating caption, the other rows held, the Brief's thinking filament —
  // because the suggestion slot it also paints sits far below the fold. The row lets
  // go when that slot stops loading (a failure card lands there and is scrolled to)
  // or when the accepted session repaints the Brief. A tap while one is working is a
  // no-op, never a second request.
  function oneTapSession(
    brief: Element,
    button: HTMLElement,
    request: { focus?: string; minutes?: number; constraints?: string },
    deps: ClientTodayBriefActionsDeps
  ): void {
    const rows = Array.from(brief.querySelectorAll<HTMLButtonElement>(".brief-recovery-opt"));
    if (rows.some((row) => row.classList.contains("is-working"))) return;
    rows.forEach((row) => { row.disabled = true; });
    button.classList.add("is-working");
    button.setAttribute("aria-busy", "true");
    const status = document.createElement("span");
    status.className = "brief-recovery-opt-status";
    status.setAttribute("role", "status");
    status.innerHTML = `<span class="aspin aspin-xs" aria-hidden="true"></span><span class="brief-recovery-opt-cap"></span>`;
    button.appendChild(status);
    const cap = status.querySelector(".brief-recovery-opt-cap");
    const stopCaption = typeof thinkingCaption === "function" ? thinkingCaption(cap, "session_suggest") : () => {};
    if (!deps.reducedMotion()) brief.classList.add("is-thinking");

    const slot = deps.root.querySelector("#sugSlot");
    let observer: MutationObserver | null = null;
    const release = () => {
      observer?.disconnect();
      stopCaption();
      if (!brief.isConnected) return;
      status.remove();
      button.classList.remove("is-working");
      button.removeAttribute("aria-busy");
      rows.forEach((row) => { row.disabled = false; });
      brief.classList.remove("is-thinking");
    };
    if (slot && typeof MutationObserver === "function") {
      observer = new MutationObserver(() => {
        if (!brief.isConnected || !slot.querySelector(".sug-loading")) release();
      });
      observer.observe(slot, { childList: true, subtree: true });
    }
    void Promise.resolve(deps.askForSession({ ...request, autoUse: true })).then(() => {
      // Nothing was queued (no slot, or a draft already in flight): let go at once.
      if (!slot || !slot.querySelector(".sug-loading")) release();
    }, release);
  }

  function handleBriefRedirect(action: string | undefined, trigger: HTMLElement, deps: ClientTodayBriefActionsDeps): void {
    if (action === "ask-session") {
      // A sheet over the Brief (type, watch it draft, read the result in one place);
      // the inline composer is the fallback when the sheet can't open.
      if (!window.CairnTodaySessionAskSheet?.open(() => deps.revealSessionComposer())) deps.revealSessionComposer();
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
    type TradeResult = { ok?: unknown; read?: unknown; train_anyway?: unknown };
    let result: TradeResult | null = null;
    try {
      result = await deps.api("/today-read/trade-rest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: deps.state.logDate }),
      }) as TradeResult | null;
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
    // The trade also answers "train today": go straight to the session, as Train anyway does.
    if (CairnTodayOpenSession.tradeOpensSession(result)) {
      void openSession(undefined, { source: "adaptive_plan", trigger: button, trainAnyway: true, replace: true, provenance: { entry: "train_anyway" } });
      return;
    }
    await deps.withViewTransition(() => deps.renderToday());
  }

  function wireBriefActions(
    read: TodayBriefActionsDayRead,
    _options: { isToday?: boolean },
    deps: ClientTodayBriefActionsDeps,
  ): void {
    const brief = deps.root.querySelector(".brief");
    if (!brief) return;
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
        const minutes = Number(button.dataset.recoveryMin);
        const detail = button.dataset.recoveryDetail || "";
        oneTapSession(brief, button, {
          focus: button.dataset.recoveryOpt || "",
          ...(Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}),
          // The detail is the coach's own caveat for this option ("nothing that
          // asks anything of the …"). Passing it verbatim is what keeps a guarded
          // menu guarded once it becomes a real session.
          ...(detail ? { constraints: detail } : {}),
        }, deps);
      })
    );

    // Run-before-leg-day: the same one tap as a recovery-menu row, asking for the
    // server's own focus + caveat so what lands is the option the athlete read.
    brief.querySelectorAll<HTMLElement>("[data-runleg]").forEach((button) =>
      button.addEventListener("click", () => {
        const focus = button.dataset.runlegFocus || "";
        const constraints = button.dataset.runlegConstraints || "";
        oneTapSession(brief, button, { ...(focus ? { focus } : {}), ...(constraints ? { constraints } : {}) }, deps);
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
    // The session's engine reasons (guardrails, the anchor line) live here too, never
    // on the lift card's face.
    const caveatsEl = () => brief.querySelector<HTMLElement>("[data-brief-caveats]");
    if (whyBtn && (hasSignals || stampEl() || caveatsEl())) {
      whyBtn.hidden = false;
      whyBtn.addEventListener("click", () => {
        const stamp = stampEl();
        const caveats = caveatsEl();
        const isOpen = whyBtn.getAttribute("aria-expanded") === "true";
        if (isOpen) {
          brief.querySelector(".brief-why-panel")?.remove();
          if (stamp) stamp.hidden = true;
          if (caveats) caveats.hidden = true;
          whyBtn.textContent = "tap to see why";
          whyBtn.setAttribute("aria-expanded", "false");
          return;
        }
        whyBtn.setAttribute("aria-expanded", "true");
        whyBtn.textContent = "hide";
        if (stamp) stamp.hidden = false;
        if (caveats) caveats.hidden = false;
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
    tradeRefusedOn,
    wireBriefActions,
  };

  Object.assign(globalThis, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });

  if (typeof window !== "undefined") {
    Object.assign(window, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });
  }
})();

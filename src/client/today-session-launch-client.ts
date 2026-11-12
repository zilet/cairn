// @ts-check
// Today's session launch card, and the plain facts it shares with the Brief when the
// Brief itself carries the start (today-brief-client.ts's `session` fold). Loaded
// ahead of today-screen.ts, which draws it (sessionLaunchCardHtml there).

type SessionLaunchOptions = {
  day: { name?: unknown; focus?: unknown; items?: Array<{ exercise?: unknown }> | null } | null | undefined;
  dailySession?: import("../contracts/client-api.js").ClientDailySessionComposition | null;
  preview?: DailySessionPreview | null;
  exDone: number;
  exTotal: number;
  isToday: boolean;
  hasLoggedSets: boolean;
  isRunDay: boolean;
  read: { est_minutes?: unknown } | null | undefined;
  strengthJourney?: import("../contracts/client-api.js").ClientStrengthJourney | null;
  // The server's open session: its `label` is the card's one action and its `action`
  // the one liveness fact (never a local set count).
  open?: import("../contracts/client-api.js").ClientOpenSession | null;
};

type SessionLaunchFacts = {
  name: string;
  focus: string;
  started: boolean;
  progress: string;
  minutes: number | null;
  why: string;
  guardrails: string;
  journey: string;
  count: number;
};

(() => {
  // The launch card's facts as PLAIN text, shared by the card below and by the Brief
  // when the Brief itself carries the start (today-brief-client.ts's `session` fold):
  // one session, one set of words, whichever surface prints them.
  function sessionLaunchFacts(opts: SessionLaunchOptions): SessionLaunchFacts {
    // The plan day's NAME leads ("Pull"); a composition's stored title is its focus
    // sentence. Only a session built off-plan (no plan day) keeps its own title.
    const planName = opts.day && opts.day.name ? String(opts.day.name) : "";
    const planLinked = !opts.dailySession || opts.dailySession.plan_day_id != null;
    const name =
      opts.open?.title ||
      (planLinked && planName) ||
      opts.dailySession?.title ||
      opts.preview?.title ||
      planName ||
      (opts.isRunDay ? "Today's run" : "Today's session");
    const focusText =
      opts.dailySession?.focus || opts.preview?.focus || (opts.day && opts.day.focus ? String(opts.day.focus) : "");
    // Say each fact once: the focus rides the title only when it adds something.
    const focus = CairnTodayBrief.distinctLine(focusText, name);
    const started = opts.open ? opts.open.action === "continue" : opts.exDone > 0 || opts.hasLoggedSets;
    const previewCount = !started && !opts.dailySession ? opts.preview?.item_count : null;
    const progress =
      previewCount != null
        ? `${previewCount} movement${previewCount === 1 ? "" : "s"}`
        : opts.exTotal
          ? started
            ? `${opts.exDone} of ${opts.exTotal} logged`
            : `${opts.exTotal} lift${opts.exTotal === 1 ? "" : "s"}`
          : "";
    const estimate =
      opts.dailySession?.est_minutes ??
      opts.preview?.est_minutes ??
      (opts.read && opts.read.est_minutes ? Number(opts.read.est_minutes) : null);
    const minutes = estimate ? Number(estimate) : null;
    const why = CairnTodayBrief.distinctLine(
      opts.dailySession?.why || opts.preview?.primary_rationale || "",
      name,
      focusText
    );
    const guardrails =
      !opts.dailySession && opts.preview?.constraints?.length ? opts.preview.constraints.slice(0, 2).join(" · ") : "";
    const objective = opts.strengthJourney?.available ? opts.strengthJourney.objective : null;
    const hasAnchor =
      !!objective?.exercise &&
      (opts.day?.items || []).some(
        (item) =>
          String(item.exercise || "")
            .trim()
            .toLowerCase() === String(objective.exercise).trim().toLowerCase()
      );
    const journey = hasAnchor
      ? objective?.status === "completed"
        ? "Anchor milestone rebuilt · consolidate it calmly today."
        : opts.strengthJourney?.phase === "protecting"
          ? "Anchor day · hold or ease; the relevant safety signal leads."
          : `Anchor day · ${String(objective?.exercise ?? "")}${Number(opts.strengthJourney?.gap_lb) > 0 ? ` · ${Number(opts.strengthJourney?.gap_lb).toFixed(1)} lb estimated 1RM gap` : ""}`
      : "";
    // How many lifts the session holds, for the NOW card's idle bars (one per lift).
    const count = previewCount != null ? Number(previewCount) || 0 : Number(opts.exTotal) || 0;
    return { name, focus, started, progress, minutes, why, guardrails, journey, count };
  }

  // The Today "lead entry": instead of the full set-by-set logging surface living
  // inline on Today (where the brain's background re-renders used to yank it), the
  // plan area shows one calm tap-card that opens the isolated Session destination.
  // Suggestion, never a gate — the Brief still leads above it. When the Brief already
  // carries the start for this same session, renderToday folds these facts into the
  // Brief instead and this card is not drawn (one action, one button).
  function sessionLaunchCardHtml(opts: SessionLaunchOptions, decisionLabel: string | null): string {
    const facts = sessionLaunchFacts(opts);
    const est = facts.minutes ? `~${facts.minutes} min` : "";
    const meta = [facts.progress, est].filter(Boolean).join("  ·  ");
    const cta = opts.open?.label || (facts.started ? "Continue" : "Start");
    const source =
      decisionLabel ||
      (opts.dailySession
        ? opts.dailySession.source === "adaptive_plan" || opts.dailySession.source === "manual_plan"
          ? `From plan${opts.day?.name ? ` · ${String(opts.day.name)}` : ""}`
          : "Built for today"
        : opts.isToday
          ? "TODAY'S SESSION"
          : "SESSION");
    return `<button class="sess-launch reveal" style="--i:2" type="button" id="sessLaunch">
        <div class="sess-launch-body">
          <div class="sess-launch-kicker lbl">${escHtml(source)}</div>
          <div class="sess-launch-title">${escHtml(facts.name)}${facts.focus ? `<span class="sess-launch-focus"> · ${escHtml(facts.focus)}</span>` : ""}</div>
          ${meta ? `<div class="sess-launch-meta">${escHtml(meta)}</div>` : ""}
          ${facts.why ? `<div class="sess-launch-why">${escHtml(facts.why)}</div>` : ""}
          ${facts.guardrails ? `<div class="sess-launch-why">${escHtml(facts.guardrails)}</div>` : ""}
          <span class="sess-launch-status" role="status" aria-live="polite"></span>
          ${facts.journey ? `<div class="sess-launch-journey">${escHtml(facts.journey)}</div>` : ""}
        </div>
        <span class="sess-launch-cta">${cta} <span class="sess-launch-arrow" aria-hidden="true">→</span></span>
      </button>`;
  }

  const CAIRN_TODAY_SESSION_LAUNCH: Window["CairnTodaySessionLaunch"] = {
    facts: sessionLaunchFacts,
    cardHtml: sessionLaunchCardHtml,
  };

  Object.assign(globalThis, { CairnTodaySessionLaunch: CAIRN_TODAY_SESSION_LAUNCH });
})();

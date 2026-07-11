// @ts-check
// Pure Today Brief rendering helpers for the vanilla PWA.

type ClientDayRead = import("../contracts/client.js").ClientDayRead;

type TodayBriefRead = Partial<ClientDayRead> & {
  _provisional?: unknown;
  // Set once loadBrief's fetch has definitively failed (not merely still in
  // flight) — lets the shimmer stop even though the fallback content stays
  // provisional (never persisted as the real read).
  _failed?: unknown;
  override?: unknown;
};

type TodayBriefMeta = {
  word: string;
  glyph: string;
  lead: string;
  kicker?: string;
};

type TodayBriefOverride = {
  intent: string;
  label: string;
};

type TodayBriefHtmlOptions = {
  showPlan?: boolean;
  // Whether the plan/logging surface below is rendering the finished-session
  // "Log more" done card. On a `done` read, when neither showPlan nor showDone
  // is true nothing below the Brief offers a way in — see the entry action below.
  showDone?: boolean;
  isToday?: boolean;
  activeOverride?: unknown;
  morph?: boolean;
  reducedMotion?: boolean;
  offlineDismissed?: boolean;
};

(() => {
  const BRIEF_KIND: Record<string, TodayBriefMeta> = {
    rest: { word: "Rest", glyph: "◐", lead: "A quiet day" },
    easy: { word: "Easy", glyph: "◑", lead: "Keep it light" },
    train: { word: "Train", glyph: "◆", lead: "Good to go" },
    done: { word: "Done", glyph: "✓", lead: "You're done for today", kicker: "Trained today" },
  };

  const BRIEF_OVERRIDES: TodayBriefOverride[] = [
    { intent: "rough night", label: "Rough night" },
    { intent: "short on time", label: "Short on time" },
    { intent: "give me an easy day", label: "Easy day instead" },
  ];

  function todayBriefKind(read: TodayBriefRead | null | undefined): string {
    const kind = String(read?.kind || "");
    return BRIEF_KIND[kind] ? kind : "train";
  }

  function todayBriefMeta(read: TodayBriefRead | null | undefined): TodayBriefMeta {
    return BRIEF_KIND[todayBriefKind(read)];
  }

  function todayBriefProvisionalRead(): ClientDayRead & { _provisional: boolean } {
    return {
      kind: "train",
      headline: "Today",
      why: "",
      focus: null,
      est_minutes: null,
      signals: {},
      source: "deterministic",
      _provisional: true,
    };
  }

  function todayBriefRedirect(action: unknown, label: unknown, primary?: boolean): string {
    return `<button class="brief-redirect${primary ? " brief-redirect-primary" : ""}" data-redirect="${escAttr(action)}">${escHtml(label)}</button>`;
  }

  function todayBriefVisibleOverrides(args: {
    kind?: unknown;
    estMinutes?: unknown;
    activeOverride?: unknown;
  }): TodayBriefOverride[] {
    const kind = String(args.kind || "");
    const activeOverride = String(args.activeOverride || "");
    const estMinutes = args.estMinutes == null ? null : Number(args.estMinutes);
    return BRIEF_OVERRIDES.filter((option) => {
      if (option.intent === activeOverride) return false;
      if (kind === "easy" && option.intent === "give me an easy day") return false;
      if (kind === "rest" && option.intent === "rough night") return false;
      if (estMinutes != null && estMinutes <= 30 && option.intent === "short on time") return false;
      return true;
    });
  }

  function todayBriefAgentOffline(status: unknown): boolean {
    return status === "unconfigured" || status === "all_failed";
  }

  function todayBriefAgentOfflineNoticeHtml(status: unknown, issue?: unknown, dismissed?: boolean): string {
    if (dismissed || !todayBriefAgentOffline(status)) return "";
    const line =
      status === "unconfigured"
        ? "Coaching is offline — connect an agent in Settings for the agentic read."
        : issue === "invalid_response"
          ? "Coaching agents didn't return a usable read just now — showing Cairn's reliable baseline."
          : issue === "unreachable"
            ? "Couldn't reach a coaching agent just now — showing Cairn's reliable baseline."
            : "The coaching layer couldn't complete this read just now — showing Cairn's reliable baseline.";
    return `<div class="agent-offline" role="note">
      <span class="agent-offline-dot" aria-hidden="true"></span>
      <span class="agent-offline-text">${escHtml(line)}</span>
      <button class="agent-offline-x" data-agentoffx aria-label="Dismiss">✕</button>
    </div>`;
  }

  function todayBriefHtml(read: TodayBriefRead | null | undefined, options: TodayBriefHtmlOptions = {}): string {
    const kind = todayBriefKind(read);
    const meta = todayBriefMeta(read);
    const focus = read?.focus ? escHtml(read.focus) : "";
    const estMinutes =
      read?.est_minutes != null && Number(read.est_minutes) > 0 ? Math.round(Number(read.est_minutes)) : null;
    const est = estMinutes != null ? `${estMinutes} min` : "";
    const headline = escHtml(read?.headline || meta.lead);
    const why = read?.why ? escHtml(read.why) : "";
    // The forward line rides on train days AND done days — after the work is in,
    // "Next: …" is the so-what that replaces the retired Start-session controls.
    const forward = read?.forward && (kind === "train" || kind === "done") ? escHtml(read.forward) : "";
    const arc = read?.arc && !forward ? escHtml(read.arc) : "";

    const actions: string[] = [];
    if (kind === "train") {
      actions.push(todayBriefRedirect("start-session", "Start session", true));
    } else if (kind === "done") {
      // A logged activity alone (no session row) can flip the read to "done"
      // with neither the finished-session card nor a revealed plan below —
      // stranding the athlete with no way to log training. Offer one quiet
      // way in only when nothing else already does.
      if (!options.showPlan && !options.showDone) {
        actions.push(todayBriefRedirect("start-session", "Log training", false));
      }
    } else if (!options.showPlan) {
      actions.push(todayBriefRedirect("reveal-plan", "Train anyway", false));
    }
    if (kind !== "done") actions.push(todayBriefRedirect("ask-session", "Ask for a session", false));

    const activeOverride = String(options.activeOverride || "");
    const steered = !!activeOverride;
    const overrides = todayBriefVisibleOverrides({ kind, estMinutes, activeOverride });
    let steer = "";
    if (options.isToday && kind !== "done" && (overrides.length || steered)) {
      const optBtns = overrides
        .map(
          (option) =>
            `<button class="brief-steer-opt" data-override="${escAttr(option.intent)}">${escHtml(option.label)}</button>`
        )
        .join(`<span class="brief-steer-dot" aria-hidden="true">·</span>`);
      const reset = steered ? `<button class="brief-steer-reset" data-steerreset>back to today's read</button>` : "";
      steer = `<div class="brief-steer">
        <span class="brief-steer-lead">${steered ? "Changed your mind?" : "Not quite right?"}</span>
        <span class="brief-steer-opts">${optBtns}</span>
        ${reset}
      </div>`;
    }

    const morph = options.morph ? " brief-morph" : "";
    const enter = options.morph ? "" : " reveal";
    const provisional = !!read?._provisional;
    // A terminal fetch failure still paints the provisional fallback content
    // (there's nothing truer to show) but must not shimmer forever — only a
    // genuinely in-flight placeholder does.
    const failed = !!read?._failed;
    const thinking = provisional && !failed && !options.reducedMotion ? " is-thinking" : "";
    const busy = provisional && !failed ? ` aria-busy="true"` : "";
    const offline = provisional
      ? ""
      : todayBriefAgentOfflineNoticeHtml(read?.agent_status, read?.agent_issue, options.offlineDismissed);
    return `<section class="brief brief-${kind}${morph}${enter}${thinking}" style="--i:0" aria-live="polite"${busy}>
      ${offline}
      <div class="brief-kicker lbl"><span class="brief-glyph" aria-hidden="true">${meta.glyph}</span> ${escHtml(meta.kicker ? meta.kicker.toUpperCase() : `${meta.word.toUpperCase()} DAY`)}${est ? ` · ${escHtml(est)}` : ""}</div>
      <h2 class="brief-headline">${headline}</h2>
      ${focus && kind === "train" ? `<div class="brief-focus">${focus}</div>` : ""}
      ${why ? `<p class="brief-why">${why}</p>` : ""}
      ${forward ? `<button class="brief-forward" data-redirect="view-week" title="See your week"><span class="brief-forward-arrow" aria-hidden="true">↗</span><span class="brief-forward-txt">${forward}</span></button>` : ""}
      ${arc ? `<button class="brief-forward brief-arc" data-redirect="view-program" title="See your plan's arc"><span class="brief-forward-arrow" aria-hidden="true">◷</span><span class="brief-forward-txt">${arc}</span></button>` : ""}
      <div id="briefProvenance" class="prov-slot"></div>
      ${actions.length ? `<div class="brief-launch">${actions.join("")}</div>` : ""}
      ${steer}
      <button class="brief-why-more" data-briefwhy hidden>tap to see why</button>
    </section>`;
  }

  // Does the freshly-fetched read differ from what's already painted in a way the
  // athlete would SEE? Compares only the visible fields (kind/headline/why/focus/
  // est_minutes) so an identical read reconciled behind a cached paint touches no
  // DOM and never animates a "swap" of unchanged content. Pure + trivially tested.
  function todayBriefMateriallyDiffers(
    a: TodayBriefRead | null | undefined,
    b: TodayBriefRead | null | undefined
  ): boolean {
    if (!a || !b) return true;
    const str = (value: unknown): string => (value == null ? "" : String(value).trim());
    if (str(a.kind) !== str(b.kind)) return true;
    if (str(a.headline) !== str(b.headline)) return true;
    if (str(a.why) !== str(b.why)) return true;
    if (str(a.focus) !== str(b.focus)) return true;
    const mins = (value: unknown): number | null => {
      const n = Number(value);
      return value == null || !Number.isFinite(n) ? null : Math.round(n);
    };
    if (mins(a.est_minutes) !== mins(b.est_minutes)) return true;
    return false;
  }

  function todayBriefSignalsText(read: TodayBriefRead | null | undefined): string {
    const signals = read?.signals && typeof read.signals === "object" ? (read.signals as Record<string, unknown>) : {};
    const bits: string[] = [];
    const days = Number(signals.consecutive_training_days);
    if (Number.isFinite(days) && days > 0) {
      bits.push(`${days} day${days === 1 ? "" : "s"} of training in a row`);
    }
    if (signals.low_sleep) bits.push("your sleep's been running short");
    else if (signals.avg_sleep_min != null && signals.has_recovery_data) bits.push("sleep's been about normal for you");
    if (signals.checkin) bits.push("you mentioned how you're feeling");
    if (!bits.length) return "Reading your recent training and recovery.";
    return `${bits.join("; ")}.`;
  }

  const CAIRN_TODAY_BRIEF = {
    BRIEF_KIND,
    BRIEF_OVERRIDES,
    kind: todayBriefKind,
    meta: todayBriefMeta,
    provisionalRead: todayBriefProvisionalRead,
    redirectHtml: todayBriefRedirect,
    visibleOverrides: todayBriefVisibleOverrides,
    agentOffline: todayBriefAgentOffline,
    agentOfflineNoticeHtml: todayBriefAgentOfflineNoticeHtml,
    briefHtml: todayBriefHtml,
    materiallyDiffers: todayBriefMateriallyDiffers,
    signalsText: todayBriefSignalsText,
  };

  Object.assign(globalThis, { CairnTodayBrief: CAIRN_TODAY_BRIEF });

  if (typeof window !== "undefined") {
    window.CairnTodayBrief = CAIRN_TODAY_BRIEF;
  }
})();

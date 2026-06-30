(() => {
// @ts-check
// Pure Today Brief and focus-bar rendering helpers for the vanilla PWA.
(() => {
    const BRIEF_KIND = {
        rest: { word: "Rest", glyph: "◐", lead: "A quiet day" },
        easy: { word: "Easy", glyph: "◑", lead: "Keep it light" },
        train: { word: "Train", glyph: "◆", lead: "Good to go" },
        done: { word: "Done", glyph: "✓", lead: "You're done for today", kicker: "Trained today" },
    };
    const BRIEF_OVERRIDES = [
        { intent: "rough night", label: "Rough night" },
        { intent: "short on time", label: "Short on time" },
        { intent: "give me an easy day", label: "Easy day instead" },
    ];
    function todayBriefKind(read) {
        const kind = String(read?.kind || "");
        return BRIEF_KIND[kind] ? kind : "train";
    }
    function todayBriefMeta(read) {
        return BRIEF_KIND[todayBriefKind(read)];
    }
    function todayBriefProvisionalRead() {
        return { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic", _provisional: true };
    }
    function todayBriefRedirect(action, label, primary) {
        return `<button class="brief-redirect${primary ? " brief-redirect-primary" : ""}" data-redirect="${escAttr(action)}">${escHtml(label)}</button>`;
    }
    function todayBriefVisibleOverrides(args) {
        const kind = String(args.kind || "");
        const activeOverride = String(args.activeOverride || "");
        const estMinutes = args.estMinutes == null ? null : Number(args.estMinutes);
        return BRIEF_OVERRIDES.filter((option) => {
            if (option.intent === activeOverride)
                return false;
            if (kind === "easy" && option.intent === "give me an easy day")
                return false;
            if (kind === "rest" && option.intent === "rough night")
                return false;
            if (estMinutes != null && estMinutes <= 30 && option.intent === "short on time")
                return false;
            return true;
        });
    }
    function todayBriefAgentOffline(status) {
        return status === "unconfigured" || status === "all_failed";
    }
    function todayBriefAgentOfflineNoticeHtml(status, dismissed) {
        if (dismissed || !todayBriefAgentOffline(status))
            return "";
        const line = status === "unconfigured"
            ? "Coaching is offline — connect an agent in Settings for the agentic read."
            : "Couldn't reach a coaching agent just now — showing the deterministic read.";
        return `<div class="agent-offline" role="note">
      <span class="agent-offline-dot" aria-hidden="true"></span>
      <span class="agent-offline-text">${escHtml(line)}</span>
      <button class="agent-offline-x" data-agentoffx aria-label="Dismiss">✕</button>
    </div>`;
    }
    function todayBriefHtml(read, options = {}) {
        const kind = todayBriefKind(read);
        const meta = todayBriefMeta(read);
        const focus = read?.focus ? escHtml(read.focus) : "";
        const estMinutes = read?.est_minutes != null && Number(read.est_minutes) > 0 ? Math.round(Number(read.est_minutes)) : null;
        const est = estMinutes != null ? `${estMinutes} min` : "";
        const headline = escHtml(read?.headline || meta.lead);
        const why = read?.why ? escHtml(read.why) : "";
        const forward = read?.forward && kind !== "done" ? escHtml(read.forward) : "";
        const arc = read?.arc && !forward ? escHtml(read.arc) : "";
        const actions = [];
        if (kind === "train") {
            actions.push(todayBriefRedirect("start-session", "Start session", true));
        }
        else if (kind !== "done" && !options.showPlan) {
            actions.push(todayBriefRedirect("reveal-plan", "Train anyway", false));
        }
        if (kind !== "done")
            actions.push(todayBriefRedirect("ask-session", "Ask for a session", false));
        const activeOverride = String(options.activeOverride || "");
        const steered = !!activeOverride;
        const overrides = todayBriefVisibleOverrides({ kind, estMinutes, activeOverride });
        let steer = "";
        if (options.isToday && kind !== "done" && (overrides.length || steered)) {
            const optBtns = overrides.map((option) => `<button class="brief-steer-opt" data-override="${escAttr(option.intent)}">${escHtml(option.label)}</button>`).join(`<span class="brief-steer-dot" aria-hidden="true">·</span>`);
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
        const thinking = provisional && !options.reducedMotion ? " is-thinking" : "";
        const busy = provisional ? ` aria-busy="true"` : "";
        const offline = provisional ? "" : todayBriefAgentOfflineNoticeHtml(read?.agent_status, options.offlineDismissed);
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
    function todayFocusBarHtml(read, day, options = {}) {
        const meta = todayBriefMeta(read);
        const line = read?.headline || read?.focus || meta.lead;
        const dayName = day?.name ? day.name : "Today's session";
        const exTotal = Number(options.exTotal) || 0;
        const exDone = Number(options.exDone) || 0;
        const prog = exTotal
            ? `<span class="focus-prog"><span class="focus-prog-done">${exDone}</span><span class="focus-prog-sep">/</span>${exTotal} done</span>`
            : "";
        return `<div class="focus-bar reveal" style="--i:0" aria-label="Workout focus">
      <div class="focus-bar-row">
        ${!options.isToday ? `<button class="focus-back" id="backToday" aria-label="Back to today">←</button>` : `<span class="focus-glyph" aria-hidden="true">${meta.glyph}</span>`}
        <div class="focus-id">
          <span class="focus-day">${escHtml(dayName)}</span>
          ${prog}
        </div>
        <button class="focus-exit" id="focusExit">Exit focus</button>
      </div>
      ${line ? `<div class="focus-read">${escHtml(line)}</div>` : ""}
    </div>`;
    }
    function todayBriefSignalsText(read) {
        const signals = read?.signals && typeof read.signals === "object" ? read.signals : {};
        const bits = [];
        const days = Number(signals.consecutive_training_days);
        if (Number.isFinite(days) && days > 0) {
            bits.push(`${days} day${days === 1 ? "" : "s"} of training in a row`);
        }
        if (signals.low_sleep)
            bits.push("your sleep's been running short");
        else if (signals.avg_sleep_min != null && signals.has_recovery_data)
            bits.push("sleep's been about normal for you");
        if (signals.checkin)
            bits.push("you mentioned how you're feeling");
        if (!bits.length)
            return "Reading your recent training and recovery.";
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
        focusBarHtml: todayFocusBarHtml,
        signalsText: todayBriefSignalsText,
    };
    Object.assign(globalThis, { CairnTodayBrief: CAIRN_TODAY_BRIEF });
    if (typeof window !== "undefined") {
        window.CairnTodayBrief = CAIRN_TODAY_BRIEF;
    }
})();
})();

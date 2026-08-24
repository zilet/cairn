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

// One reading-grammar contributor row behind the Brief's "why" (VISION.md
// Amendment 2): a plain-language state line led by a tone pip — sage `ok`,
// terracotta `watch` (the day's lever), neutral `quiet` (informational / thin
// data). Rendered by CairnUiReads.contributorRowsHtml.
type TodayBriefSignalRow = { label: string; state: string; tone: "ok" | "watch" | "quiet" };

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

  // Which surface the server's lead arbitration handed the position of prominence
  // to (`ClientTodayAttention`). "" when the payload carries no decision — an older
  // server, a cached response, or a non-live date — in which case the Brief keeps
  // the lead exactly as it always has.
  function todayBriefAttentionPrimary(read: TodayBriefRead | null | undefined): string {
    const attention = read?.attention;
    if (!attention || typeof attention !== "object") return "";
    const primary = String(attention.primary || "");
    return primary || "";
  }

  // The Brief yields the lead only when the server says another surface earns it.
  // It never disappears and loses nothing — it stays first on the page, carrying
  // every control it had; `brief-quiet` is purely the emphasis hook.
  function todayBriefYieldsLead(read: TodayBriefRead | null | undefined): boolean {
    const primary = todayBriefAttentionPrimary(read);
    return !!primary && primary !== "brief";
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

  function todayBriefPeriodizationHtml(read: TodayBriefRead | null | undefined): string {
    const context = read?.periodization_context;
    if (!context || typeof context !== "object") return "";
    const recovery = context.recovery_overlay;
    const block = context.program_block;
    const rows: string[] = [];
    if (recovery && typeof recovery === "object") {
      const day = Math.max(1, Math.min(7, Math.round(Number(recovery.day_index) || 1)));
      rows.push(
        `<button class="brief-clock-row" data-redirect="view-program" title="See the reduced recovery plan"><span class="brief-clock-mark" aria-hidden="true">↘</span><span>${escHtml(`Recovery week · Day ${day} of 7 · reduced volume`)}</span></button>`
      );
    }
    if (block && typeof block === "object") {
      const week = Math.max(1, Math.round(Number(block.week_index) || 1));
      const total = Math.max(week, Math.round(Number(block.total_weeks) || week));
      const goal = String(block.goal || "Training block")
        .trim()
        .slice(0, 200);
      rows.push(
        `<button class="brief-clock-row" data-redirect="view-program" title="Calendar program-block counter"><span class="brief-clock-mark" aria-hidden="true">◷</span><span>${escHtml(`${goal} · Week ${week} of ${total}`)}</span></button>`
      );
    }
    return rows.length ? `<div class="brief-clocks" aria-label="Program timing">${rows.join("")}</div>` : "";
  }

  // The specific, athlete-facing sentence behind a rest/easy read — rendered only
  // when it says something the `why` above it doesn't already say. A read with no
  // specific reason renders NOTHING: engineering prose about policies and
  // boundaries must never reach the athlete as if it were coaching.
  function todayBriefDecisiveReason(read: TodayBriefRead | null | undefined, kind: string): string {
    const decision = read?.decision;
    if (kind !== "rest" && kind !== "easy") return "";
    if (!decision || typeof decision !== "object") return "";
    const reason = String(decision.reason || "")
      .trim()
      .slice(0, 160);
    const normalized = (value: unknown): string =>
      String(value ?? "")
        .toLocaleLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[.!?]+$/g, "")
        .trim();
    return reason && normalized(reason) !== normalized(read?.why) ? reason : "";
  }

  // The guided recovery menu on a rest/easy day: a short optional line + a
  // handful of low-key rows. Each row is now a TAP — the owner asked for the menu
  // to be actionable ("tap on that gentle mobility and get that plan running
  // today"), so an option carries its own minutes/focus/detail and hands them to
  // the session-suggest lane. The invitation is unchanged: nothing is required,
  // resting is still a perfectly good answer beside every option, and the tap only
  // happens when the athlete makes it. Rendered only for rest/easy kinds; a
  // train/done read (or an absent/malformed payload) gets nothing. Every
  // interpolated string is escaped.
  function todayBriefRecoveryHtml(read: TodayBriefRead | null | undefined, kind: string): string {
    if (kind !== "rest" && kind !== "easy") return "";
    const recovery = read?.recovery as { line?: unknown; options?: unknown } | null | undefined;
    if (!recovery || typeof recovery !== "object") return "";
    const line = recovery.line == null ? "" : String(recovery.line).trim();
    const options = Array.isArray(recovery.options) ? recovery.options : [];
    const rows = options
      .map((opt) => {
        const o = (opt && typeof opt === "object" ? opt : {}) as {
          label?: unknown;
          detail?: unknown;
          minutes?: unknown;
        };
        const label = o.label == null ? "" : String(o.label).trim();
        const detail = o.detail == null ? "" : String(o.detail).trim();
        if (!label && !detail) return "";
        const minutesNum = o.minutes == null ? null : Number(o.minutes);
        const mins =
          minutesNum != null && Number.isFinite(minutesNum) && minutesNum > 0
            ? ` <span class="brief-recovery-opt-mins">· ${escHtml(String(Math.round(minutesNum)))} min</span>`
            : "";
        // minutes/detail ride on the element so the tap handler never has to
        // re-parse the rendered copy back into a request.
        const attrs = [
          `data-recovery-opt="${escAttr(label)}"`,
          minutesNum != null && Number.isFinite(minutesNum) && minutesNum > 0
            ? `data-recovery-min="${escAttr(String(Math.round(minutesNum)))}"`
            : "",
          detail ? `data-recovery-detail="${escAttr(detail)}"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<button type="button" class="brief-recovery-opt" ${attrs}>${label ? `<span class="brief-recovery-opt-label">${escHtml(label)}${mins}</span>` : ""}${detail ? `<span class="brief-recovery-opt-detail">${escHtml(detail)}</span>` : ""}</button>`;
      })
      .filter(Boolean)
      .join("");
    if (!rows && !line) return "";
    return `<div class="brief-recovery">${line ? `<p class="brief-recovery-line">${escHtml(line)}</p>` : ""}${rows ? `<div class="brief-recovery-list">${rows}</div>` : ""}</div>`;
  }

  // The week-wins reassurance, threaded from today-session-status-client.ts's done
  // card (doneWeekHtml) onto rest/easy Briefs — the reassurance that training has
  // actually been happening matters most on a day with no session card to carry it.
  // Reuses the SAME sentence/rules: absent on a zero-training week, no "0 of 7".
  function todayBriefWeekHtml(read: TodayBriefRead | null | undefined, kind: string): string {
    if (kind !== "rest" && kind !== "easy") return "";
    const week = read?.week;
    if (!week || typeof week !== "object") return "";
    const helper = (globalThis as any).CairnTodaySessionStatus?.weekHtml;
    if (typeof helper !== "function") return "";
    const html = helper({ week });
    return html ? String(html).replace('class="done-week"', 'class="done-week brief-week"') : "";
  }

  // The morning wake-up review (W4.7): one quiet passage ABOVE today's
  // suggestion — "since yesterday" plus one or two sentences, collapsed
  // entirely when the server sent nothing (silence is the calm default, not a
  // loading state). Only shown on today's own Brief: a routed past date is
  // already looking backward, and "since yesterday" on it would misdate whose
  // yesterday is being described.
  function todayBriefLookBackHtml(read: TodayBriefRead | null | undefined, isToday: boolean): string {
    if (!isToday) return "";
    const lookBack = read?.look_back;
    if (!lookBack || typeof lookBack !== "object") return "";
    const passages = Array.isArray(lookBack.passages) ? lookBack.passages.filter((p) => typeof p === "string" && p.trim()) : [];
    const win = typeof lookBack.win === "string" && lookBack.win.trim() ? lookBack.win.trim() : "";
    const sentences = [...passages, win].filter(Boolean);
    if (!sentences.length) return "";
    return `<div class="brief-lookback">
      <div class="brief-lookback-lbl lbl">Since yesterday</div>
      <p class="brief-lookback-txt">${sentences.map((sentence) => escHtml(sentence)).join(" ")}</p>
    </div>`;
  }

  function todayBriefUpdatedHtml(read: TodayBriefRead | null | undefined, kind: string, isToday = true): string {
    const raw = read?.computed_at || read?.decision?.computed_at;
    const stamp = raw ? new Date(String(raw)) : null;
    if (!stamp || !Number.isFinite(stamp.getTime())) return "";
    // A bare clock time only means "today" on today. Browsing back to an earlier
    // date, "Updated 6:12 AM" reads as this morning when it is a stamp from another
    // day entirely — so a past date says which day.
    const when = isToday
      ? stamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : stamp.toLocaleDateString([], { month: "short", day: "numeric" });
    const decisive = todayBriefDecisiveReason(read, kind);
    return `<div class="brief-updated">${escHtml(`Updated ${when}`)}${decisive ? ` <span aria-hidden="true">·</span> ${escHtml(decisive)}` : ""}</div>`;
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
    const recovery = todayBriefRecoveryHtml(read, kind);
    const weekWins = todayBriefWeekHtml(read, kind);
    // The forward line rides on train days AND done days — after the work is in,
    // "Next: …" is the so-what that replaces the retired Start-session controls.
    const forward = read?.forward && (kind === "train" || kind === "done") ? escHtml(read.forward) : "";
    const periodization = todayBriefPeriodizationHtml(read);
    const arc = read?.arc && !forward && !periodization ? escHtml(read.arc) : "";
    const updated = todayBriefUpdatedHtml(read, kind, options.isToday !== false);
    const lookBack = todayBriefLookBackHtml(read, options.isToday !== false);

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
    // The lead arbitration's only mark on the Brief: a de-emphasis hook and the
    // band it landed in. Appended LAST so every existing class-list assertion (and
    // every existing rule) is untouched, and omitted entirely when no decision came.
    const yields = todayBriefYieldsLead(read);
    const quiet = yields ? " brief-quiet" : "";
    const band = todayBriefAttentionPrimary(read) ? ` data-attention="${yields ? "supporting" : "lead"}"` : "";
    return `<section class="brief brief-${kind}${morph}${enter}${thinking}${quiet}" style="--i:0" aria-live="polite"${busy}${band}>
      ${offline}
      ${lookBack}
      <div class="brief-kicker lbl"><span class="brief-glyph" aria-hidden="true">${meta.glyph}</span> ${escHtml(meta.kicker ? meta.kicker.toUpperCase() : `${meta.word.toUpperCase()} DAY`)}${est ? ` · ${escHtml(est)}` : ""}</div>
      <h2 class="brief-headline">${headline}</h2>
      ${focus && kind === "train" ? `<div class="brief-focus">${focus}</div>` : ""}
      ${why ? `<p class="brief-why">${why}</p>` : ""}
      ${weekWins}
      ${recovery}
      ${forward ? `<button class="brief-forward" data-redirect="view-week" title="See your week"><span class="brief-forward-arrow" aria-hidden="true">↗</span><span class="brief-forward-txt">${forward}</span></button>` : ""}
      ${periodization}
      ${arc ? `<button class="brief-forward brief-arc" data-redirect="view-program" title="See your plan's arc"><span class="brief-forward-arrow" aria-hidden="true">◷</span><span class="brief-forward-txt">${arc}</span></button>` : ""}
      ${updated}
      <div id="briefProvenance" class="prov-slot"></div>
      ${actions.length ? `<div class="brief-launch">${actions.join("")}</div>` : ""}
      ${steer}
      <button class="brief-why-more" data-briefwhy hidden>tap to see why</button>
    </section>`;
  }

  // Does the freshly-fetched read differ from what's already painted in a way the
  // athlete would SEE? Structured provenance only participates through the
  // rendered clock/freshness helpers, so private signals and machine rule codes
  // never repaint an otherwise-identical Brief.
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
    if (todayBriefPeriodizationHtml(a) !== todayBriefPeriodizationHtml(b)) return true;
    if (todayBriefRecoveryHtml(a, todayBriefKind(a)) !== todayBriefRecoveryHtml(b, todayBriefKind(b))) return true;
    if (todayBriefWeekHtml(a, todayBriefKind(a)) !== todayBriefWeekHtml(b, todayBriefKind(b))) return true;
    // The freshness line's REASON is content and repaints; its clock is not. A
    // bare timestamp tick was rewriting the whole Brief (replaceWith + settle
    // animation) for a minute that changed nothing the athlete is reading —
    // exactly the churn this predicate exists to prevent. The stamp catches up on
    // the next real repaint.
    if (todayBriefDecisiveReason(a, todayBriefKind(a)) !== todayBriefDecisiveReason(b, todayBriefKind(b))) return true;
    // Yielding (or reclaiming) the lead changes the Brief's rendered weight, so it
    // is a material difference. The primary SURFACE alone is compared — the rest of
    // the decision is ordering the Brief itself never draws.
    if (todayBriefYieldsLead(a) !== todayBriefYieldsLead(b)) return true;
    const hasStamp = (read: TodayBriefRead): boolean => !!(read.computed_at || read.decision?.computed_at);
    if (hasStamp(a) !== hasStamp(b)) return true;
    return false;
  }

  function todayBriefSignalsText(read: TodayBriefRead | null | undefined): string {
    const signals = read?.signals && typeof read.signals === "object" ? (read.signals as Record<string, unknown>) : {};
    const fatigue =
      signals.fatigue && typeof signals.fatigue === "object" ? (signals.fatigue as Record<string, unknown>) : {};
    const sleepVsNormRaw = Number(fatigue.sleep_vs_norm);
    const sleepVsNorm = fatigue.sleep_vs_norm == null || !Number.isFinite(sleepVsNormRaw) ? null : sleepVsNormRaw;
    const sleepMateriallyBelowNorm = sleepVsNorm != null && sleepVsNorm < -25;
    const bits: string[] = [];
    const days = Number(signals.consecutive_training_days);
    if (Number.isFinite(days) && days > 0) {
      bits.push(`${days} day${days === 1 ? "" : "s"} of training in a row`);
    }
    if (signals.low_sleep || sleepMateriallyBelowNorm) bits.push("your sleep's been running short");
    else if (signals.avg_sleep_min != null && signals.has_recovery_data && sleepVsNorm != null) {
      bits.push("sleep's been about normal for you");
    }
    if (signals.checkin) bits.push("you mentioned how you're feeling");
    if (!bits.length) return "Reading your recent training and recovery.";
    return `${bits.join("; ")}.`;
  }

  // The "why" as reading-grammar contributor rows (Amendment 2): each signal the
  // deterministic read leaned on, mapped to a plain-language state line + tone.
  // Only what the payload actually carries — no invented data. At most one or two
  // rows read `watch` (the day's lever); everything else is `ok` or `quiet`. The
  // final `quiet` row is the "what's lacking" line — a calm gap fact plus the one
  // small move — surfaced only when the read is genuinely thin. Pure + null-safe;
  // an empty array lets the caller fall back to the prose summary.
  function todayBriefSignalsRows(read: TodayBriefRead | null | undefined): TodayBriefSignalRow[] {
    const signals = read?.signals && typeof read.signals === "object" ? (read.signals as Record<string, unknown>) : {};
    const fatigue =
      signals.fatigue && typeof signals.fatigue === "object" ? (signals.fatigue as Record<string, unknown>) : {};
    const rows: TodayBriefSignalRow[] = [];

    // Training load — the read's spine (consecutive genuinely-LOADING days). Runs
    // `watch` when the days are stacking up or a reset is anticipated; a rested
    // stretch reads calmly as `ok`.
    const days = Number(signals.consecutive_training_days);
    if (Number.isFinite(days)) {
      if (days <= 0) {
        rows.push({ label: "Training load", state: "fresh — nothing stacked up lately", tone: "ok" });
      } else {
        const run = `${days} loaded day${days === 1 ? "" : "s"} in a row`;
        const high = days >= 4 || !!fatigue.anticipate_deload;
        rows.push({ label: "Training load", state: high ? `running high, ${run}` : run, tone: high ? "watch" : "ok" });
      }
    }

    // Sleep — baseline-aware, matching signalsText: short of your usual reads
    // `watch`, settled reads `ok`, and thin evidence produces no claim at all.
    const sleepVsNormRaw = Number(fatigue.sleep_vs_norm);
    const sleepVsNorm = fatigue.sleep_vs_norm == null || !Number.isFinite(sleepVsNormRaw) ? null : sleepVsNormRaw;
    const sleepShort = signals.low_sleep || (sleepVsNorm != null && sleepVsNorm < -25);
    if (sleepShort) {
      rows.push({ label: "Sleep", state: "running short of your usual", tone: "watch" });
    } else if (signals.avg_sleep_min != null && signals.has_recovery_data && sleepVsNorm != null) {
      rows.push({ label: "Sleep", state: "settling in about normal for you", tone: "ok" });
    }

    // A morning check-in is a real signal the read leaned on — a calm `ok` input.
    if (signals.checkin) {
      rows.push({ label: "How you're feeling", state: "you checked in this morning", tone: "ok" });
    }

    // Active life context the brain is planning around — informational (`quiet`)
    // even when it reduces load, so the day's own signals stay the levers.
    const context =
      signals.context && typeof signals.context === "object" ? (signals.context as Record<string, unknown>) : null;
    const active = context && Array.isArray(context.active) ? context.active : [];
    const firstContext = active.find(
      (item) => item && typeof item === "object" && String((item as Record<string, unknown>).title ?? "").trim()
    ) as Record<string, unknown> | undefined;
    if (firstContext) {
      rows.push({
        label: "Life context",
        state: `planning around ${String(firstContext.title).trim()}`,
        tone: "quiet",
      });
    }

    // What's lacking, as calm information (Amendment 2): when neither a wearable nor
    // a check-in has fed today's read, name the gap and the one small move that
    // sharpens it — a fact about the situation, never a verdict. Only qualifies a
    // read that actually has something to say (never a bare provisional shell).
    //
    // "none synced yet" was true for exactly one kind of athlete. For a wearer who
    // puts the watch on for runs and the occasional night it read as a fault report
    // about a working setup. The server sends the line for the cadence it actually
    // measured (`recovery_cadence.absence_state`, a date-rotated variant from
    // wear-pattern-voice.ts) precisely so the phrasing is not re-invented here; the
    // literal below survives only as the floor for a payload that carries no
    // cadence at all.
    if (rows.length && !signals.has_recovery_data && !signals.checkin) {
      const cadence =
        signals.recovery_cadence && typeof signals.recovery_cadence === "object"
          ? (signals.recovery_cadence as Record<string, unknown>)
          : null;
      const spoken = typeof cadence?.absence_state === "string" ? cadence.absence_state.trim() : "";
      rows.push({
        label: "Recovery signals",
        state: spoken || "none synced yet — a morning check-in sharpens the read",
        tone: "quiet",
      });
    }

    return rows;
  }

  const CAIRN_TODAY_BRIEF = {
    BRIEF_KIND,
    BRIEF_OVERRIDES,
    kind: todayBriefKind,
    meta: todayBriefMeta,
    provisionalRead: todayBriefProvisionalRead,
    redirectHtml: todayBriefRedirect,
    visibleOverrides: todayBriefVisibleOverrides,
    attentionPrimary: todayBriefAttentionPrimary,
    yieldsLead: todayBriefYieldsLead,
    agentOffline: todayBriefAgentOffline,
    agentOfflineNoticeHtml: todayBriefAgentOfflineNoticeHtml,
    briefHtml: todayBriefHtml,
    materiallyDiffers: todayBriefMateriallyDiffers,
    signalsText: todayBriefSignalsText,
    signalsRows: todayBriefSignalsRows,
    periodizationHtml: todayBriefPeriodizationHtml,
    updatedHtml: todayBriefUpdatedHtml,
    decisiveReason: todayBriefDecisiveReason,
    recoveryHtml: todayBriefRecoveryHtml,
    lookBackHtml: todayBriefLookBackHtml,
  };

  Object.assign(globalThis, { CairnTodayBrief: CAIRN_TODAY_BRIEF });

  if (typeof window !== "undefined") {
    window.CairnTodayBrief = CAIRN_TODAY_BRIEF;
  }
})();

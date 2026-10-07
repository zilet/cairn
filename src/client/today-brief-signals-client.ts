// @ts-check
// The Brief's "why" disclosure content: the plain-words signals sentence (`signalsText`) and
// the labelled rows (`signalsRows`), split out of today-brief-client.ts and published on the
// same CairnTodayBrief. Reads the read's own `signals`; never a score. Loaded right after
// today-brief-client.ts, and reached only at call time (the Brief's actions client).
(() => {
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

  Object.assign(CairnTodayBrief, { signalsText: todayBriefSignalsText, signalsRows: todayBriefSignalsRows });
})();

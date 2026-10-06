// @ts-check
// THIS WEEK, the model: the week's runs as the log holds them — what was run first, the
// plan second, a run no intent took as an extra — the volume as one bar segment per run
// against the plan's tick, and the card's kicker, sentence and figure. Pure shaping
// over GET /api/race-build (`this_week.runs` / `headline` / `detail` / `closed`) with
// this week's agenda as an older payload's runs. Every sentence is the server's; the
// only arithmetic is units, a pace from a run's own time and distance, and a bar's
// fraction. Loaded after race-week-model (whose unit words it uses) and before
// race-view-model, which re-exports thisWeekModel.
{
  type RaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
  type Agenda = import("../contracts/client-api.js").ClientFlexibleTrainingAgenda;
  type Intent = import("../contracts/client-api.js").ClientFlexibleRunIntent;
  type Evidence = import("../contracts/client-api.js").ClientRunCompletionEvidence;
  type RunKind = import("../contracts/client-api.js").ClientFlexibleRunKind;
  /** One run before it is printed: the server's own read, or an older payload's agenda evidence. */
  type Wire = {
    date: string;
    km: number | null;
    pace_sec_per_km: number | null;
    title: string | null;
    intensity: string | null;
    intensity_word: string | null;
    kind: RunKind | null;
    extra: boolean;
    planned: { kind: RunKind; km: number | null } | null;
    adjustment: string | null;
    actual_line?: string | null;
    plan_line?: string | null;
  };

  const { stageWord, unitsOf, kmText, distNum, runWords } = CairnRaceWeekModel;
  const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const KIND_WORD: Record<RunKind, string> = { easy: "easy", quality: "quality", long: "long" };

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function dayKey(iso: unknown): string {
    const key = String(iso || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : "";
  }

  /** "Tue", from the date itself. */
  function weekdayShort(iso: unknown): string {
    const key = dayKey(iso);
    if (!key) return "";
    const d = new Date(`${key}T00:00:00Z`);
    return Number.isFinite(d.getTime()) ? WEEKDAY_SHORT[d.getUTCDay()] : "";
  }

  /** "5:34/km" (or "/mi"): a run's own pace. "" with none. */
  function paceText(secPerKm: unknown, units?: unknown): string {
    const n = num(secPerKm);
    if (n == null || n <= 0) return "";
    return `${CairnFmt.pace(n, units ?? "km")}${fmtRunUnitSuffix(units)}`;
  }

  function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  function kindOf(value: unknown): RunKind | null {
    return value === "easy" || value === "quality" || value === "long" ? value : null;
  }

  /**
   * The bar's tone for a run: the intent it closed (a long run is long whatever its
   * pace), else — an extra — the server's own grade of it.
   */
  function toneOf(run: Wire): RunKind {
    const kind = kindOf(run.kind);
    if (kind) return kind;
    return run.intensity === "quality" || run.intensity_word === "hard" ? "quality" : "easy";
  }

  /** "planned: long 10.7 km", in the run units; "" with no plan behind the run. */
  function plannedText(planned: Wire["planned"], units?: unknown): string {
    if (!planned) return "";
    const body = [KIND_WORD[planned.kind], kmText(planned.km, units)].filter(Boolean).join(" ");
    return body ? `planned: ${body}` : "";
  }

  /**
   * One run as the THIS WEEK card prints it: what was run, then what was planned. The
   * server's own lines (`actual_line`, `plan_line`, written in km) are said as written,
   * restated in the run units; an older payload's run is said from its figures.
   */
  function runModel(run: Wire, units?: unknown): ClientRaceWeekRun | null {
    const km = num(run.km);
    const date = dayKey(run.date);
    if (!date && (km == null || km <= 0)) return null;
    const kmWords = km != null && km > 0 ? kmText(km, units) : "";
    const pace = paceText(run.pace_sec_per_km, units);
    const effort = text(run.intensity_word);
    const extra = run.extra === true;
    const adjust = runWords(text(run.adjustment), units);
    const planText = extra ? "" : runWords(text(run.plan_line), units);
    return {
      date,
      when: weekdayShort(date),
      km: km != null && km > 0 ? km : null,
      km_text: kmWords,
      pace_text: pace,
      effort_word: effort,
      actual_text: runWords(text(run.actual_line), units) || [kmWords, pace, effort].filter(Boolean).join(" · "),
      title: text(run.title),
      tone: toneOf(run),
      extra,
      planned_text: extra ? "" : planText || plannedText(run.planned, units),
      // A server plan line already says the morning's call; an older payload's sits beside its plan.
      adjust_text: extra || planText ? "" : adjust,
    };
  }

  /** What the morning call did to a run, in the plan's words ("shortened to 8 km this morning"). */
  function agendaAdjustText(intent: Intent, asOf: string): string {
    const a = intent.adjustment;
    if (!a || a.changed !== true) return "";
    const when = dayKey(a.date) && dayKey(a.date) === asOf ? "this morning" : "that morning";
    if (a.dose === "rest") return `rested ${when}`;
    const km = kmText(a.target_distance_km);
    if (a.kind !== a.planned_kind) return `made ${KIND_WORD[a.kind] || "easy"}${km ? ` ${km}` : ""} ${when}`;
    if (a.dose === "short" || a.dose === "shortened") return km ? `shortened to ${km} ${when}` : `shortened ${when}`;
    return "";
  }

  /**
   * An agenda's evidence as a run. Its grade word is said only when the athlete's word
   * or the personal model gave it: a watch-graded run (an older server) carries none.
   */
  function evidenceRun(c: Evidence, extra: boolean): Wire {
    const duration = num(c.duration_min);
    const km = num(c.distance_km);
    const graded = c.intensity_basis === "stated_easy" || c.intensity_basis === "personal_model";
    return {
      date: c.date,
      km,
      pace_sec_per_km: num(c.pace_sec_per_km) ?? (duration && km ? (duration * 60) / km : null),
      title: c.title ?? null,
      intensity: graded ? c.intensity : null,
      intensity_word: graded ? (c.intensity_word ?? null) : null,
      kind: null,
      extra,
      planned: null,
      adjustment: null,
    };
  }

  /**
   * An older payload's runs: the agenda's completed intents, each the intent it closed
   * against the week's own plan for that slot (`planned_distance_km`, else the leg map's
   * day), then the agenda's extras.
   */
  function agendaRuns(build: RaceBuild | null | undefined, agenda: Agenda | null | undefined): Wire[] {
    const intents = agenda && agenda.available !== false && Array.isArray(agenda.intents) ? agenda.intents : [];
    const legMap = Array.isArray(build?.leg_map) ? build.leg_map : [];
    const asOf = dayKey(agenda?.as_of) || dayKey(build?.as_of);
    const done: Wire[] = intents
      .filter((intent) => intent.status === "completed" && intent.completion)
      .map((intent) => {
        const plannedKind = kindOf(intent.adjustment?.planned_kind) || intent.kind;
        const legs = legMap.filter((day) => day.run?.kind === plannedKind);
        const leg = legs.find((day) => day.day_number === intent.provisional_day_number) || legs[0] || null;
        const plannedKm = num(intent.planned_distance_km) ?? num(leg?.run?.km) ?? num(intent.target_distance_km);
        return {
          ...evidenceRun(intent.completion as Evidence, false),
          kind: intent.kind,
          planned: { kind: plannedKind, km: plannedKm },
          adjustment: agendaAdjustText(intent, asOf),
        };
      });
    const extras = Array.isArray(agenda?.extras) ? agenda.extras.map((c) => evidenceRun(c, true)) : [];
    return [...done, ...extras];
  }

  /**
   * This week's runs as the log holds them, oldest first: the server's own reads
   * (`this_week.runs`, extras among them) when it sends them, else the agenda's
   * completed intents and its extras. Every word and figure is the server's or the
   * log's; the client only restates units. [] before anything is run.
   */
  function weekRuns(build: RaceBuild | null | undefined, agenda?: Agenda | null, units?: unknown): ClientRaceWeekRun[] {
    const served = build?.this_week?.runs;
    const wire: Wire[] = Array.isArray(served)
      ? served.map((run) => ({
          ...run,
          extra: run.extra === true,
          planned: run.planned ? { kind: run.planned.kind, km: run.planned.km } : null,
        }))
      : agendaRuns(build, agenda);
    return wire
      .map((run) => runModel(run, units))
      .filter((run): run is ClientRaceWeekRun => !!run)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /**
   * "Sun 13.5 km long, easy" for the bar's label: what each segment stands for — the
   * tone it is drawn in (long / quality / easy, or extra for a run no intent took) and
   * then the run's effort word, so the cues the bar draws beyond colour are said too.
   */
  function runLabel(run: ClientRaceWeekRun): string {
    const kind = run.extra ? "extra" : KIND_WORD[run.tone];
    const head = [run.when, run.km_text, kind].filter(Boolean).join(" ");
    return run.effort_word && run.effort_word !== kind ? `${head}, ${run.effort_word}` : head;
  }

  /**
   * The week's volume as segments: one per run (its share of the bar, its tone), a
   * tick where the plan sits, and a bar scaled to whichever is bigger, so a week run
   * past its plan shows the overflow instead of a full bar that hides it.
   */
  function segmentsModel(
    runs: ClientRaceWeekRun[],
    done: number,
    target: number
  ): Pick<ClientRaceThisWeek, "segments" | "plan_frac" | "over"> {
    const scale = Math.max(done, target);
    const frac = (km: number): number => (scale > 0 ? Math.round(Math.min(1, km / scale) * 1000) / 1000 : 0);
    const counted = runs.filter((run) => run.km != null && run.km > 0);
    const sum = counted.reduce((total, run) => total + (run.km ?? 0), 0);
    let segments: ClientRaceWeekSegment[] = counted.map((run) => ({
      tone: run.tone,
      extra: run.extra,
      frac: frac(run.km ?? 0),
      label: runLabel(run),
    }));
    // No runs to split the log by (an older payload without the agenda): one plain run of it.
    if (!segments.length && done > 0) segments = [{ tone: "easy", extra: false, frac: frac(done), label: "" }];
    // The log is the truth for the total: a run the reads missed still fills its share.
    else if (done - sum > 0.05) segments.push({ tone: "easy", extra: true, frac: frac(done - sum), label: "" });
    return {
      segments,
      plan_frac: target > 0 && scale > 0 ? frac(target) : null,
      over: target > 0 && done > target + 0.05,
    };
  }

  /**
   * This week at a glance: its stage, what the log holds against the week's volume, the
   * long run and the week's one coaching sentence. The volume is the engine's
   * (`this_week.km`, the week as planned) and the logged figure the log's; nothing is
   * re-derived. The headline and detail are the server's (`this_week.headline` /
   * `detail`) when it writes them, else the stage word and the rung's focus. Works
   * without a race too (a runner with no race set): the stage and the focus are then
   * simply absent. Null with no running week. `agenda` (this week's) gives the runs
   * when the build does not carry them. `countdownShown`: the surface already prints the
   * weeks to race just above (the race page's head), so the kicker does not repeat it.
   */
  function thisWeekModel(
    build: RaceBuild | null | undefined,
    units?: unknown,
    opts: { agenda?: Agenda | null; countdownShown?: boolean } = {}
  ): ClientRaceThisWeek | null {
    const week = build?.this_week || null;
    const rung = (Array.isArray(build?.weeks) ? build.weeks : []).find((w) => w.current === true) || null;
    const target = Math.max(0, num(week?.km ?? rung?.km) ?? 0);
    if (!week && !rung) return null;
    if (target <= 0 && !rung) return null;
    const done = Math.max(0, num(week?.logged_km) ?? 0);
    const unit = unitsOf(units);
    const long = num(week?.long_km ?? rung?.long_km);
    const stage = rung ? stageWord(rung) : "";
    const out = rung ? Math.max(0, Math.round(num(rung.weeks_to_race) ?? 0)) : null;
    const closed = week?.closed === true;
    const runs = weekRuns(build, opts.agenda, unit);
    const headline = text(week?.headline);
    const detail = runWords(text(week?.detail) || (closed ? "" : String(rung?.focus || "").trim()), unit);
    return {
      stage_word: stage,
      done_km: done,
      target_km: target,
      // Nothing run yet says the week's volume alone, never a zero against it.
      done_text: done > 0 ? (target > 0 ? distNum(done, unit) : kmText(done, unit)) : "",
      target_text: target > 0 ? kmText(target, unit) : "",
      frac: target > 0 ? Math.round(Math.min(1, done / target) * 1000) / 1000 : null,
      banked: target > 0 && done >= target,
      long_text: long != null && long > 0 && rung?.kind !== "race" ? `Long run ${kmText(long, unit)}` : "",
      focus: String(rung?.focus || "").trim(),
      kicker: [
        "This week",
        stage,
        out == null || opts.countdownShown ? "" : out === 0 || rung?.kind === "race" ? "Race week" : `${out} wk out`,
      ]
        .filter(Boolean)
        .join(" · "),
      headline: runWords(headline, unit) || stage || "Your running week",
      detail: detail === headline ? "" : detail,
      closed,
      logged_text: done > 0 ? kmText(done, unit) : "",
      plan_text: target > 0 ? (done > 0 ? `plan ${distNum(target, unit)}` : `${kmText(target, unit)} planned`) : "",
      runs,
      ...segmentsModel(runs, done, target),
    };
  }

  /** Next week's planned volume ("32.1 km planned"), from the ladder's next rung; "". */
  function nextWeekText(build: RaceBuild | null | undefined, units?: unknown): string {
    const weeks = Array.isArray(build?.weeks) ? build.weeks : [];
    const here = weeks.findIndex((week) => week.current === true);
    const next = here >= 0 ? weeks[here + 1] : null;
    const km = num(next?.km);
    return km != null && km > 0 ? `${kmText(km, units)} planned` : "";
  }
  const CAIRN_RACE_WEEK_RUNS = { thisWeekModel, weekRuns, nextWeekText, paceText };

  Object.assign(globalThis, { CairnRaceWeekRuns: CAIRN_RACE_WEEK_RUNS });
}

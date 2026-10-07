// @ts-check
// The Horizon timeline, the model (docs/V2-PLAN.md wave 5, "Horizon"): three lanes on
// one line of time, each a pure shaping of reads the app already has.
//
//   - Race: GET /api/race-build through the race view's own model (race-view-model),
//     never a second engine. A glance: the build's serif line, the terrain, this week
//     in one row and the fit word, in the athlete's run units; the ladder and the rest
//     are the race page's. A runner with no race gets the running week, a lifting-only
//     athlete no lane at all.
//   - Goal line: GET /api/journey (the phase read) and the non-lab rows of
//     GET /api/journey/timeline (the goal date, phase window, block boundary, re-tests).
//   - Labs and scans, and the season line: horizon-labs-model.ts (it shapes with this
//     module's `parts`).
//   - The week read (GET /api/week) dresses two lanes (`withWeek`): its frame is the
//     race lane's hero, its weight goal the goal line's one weight trend.
//
// Decision Q5: no merged server endpoint, so nothing here derives a server-owned fact.
// Staleness is never judged (marker-validity.ts owns that), a due date is never turned
// into urgency, and no row carries a number that reads as a score.
{
  type RaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
  type JourneyRead = import("../contracts/client-api.js").ClientJourneyRead;
  type TimelineEntry = import("../contracts/client-api.js").ClientForwardTimelineEntry;
  type Lane = ClientHorizonLane;
  type Row = ClientHorizonRow;
  type Target = ClientHorizonTarget;

  /** Timeline kinds that belong to the labs lane; every other kind is the goal line's. */
  const LAB_TIMELINE_KINDS: ReadonlySet<string> = new Set(["recheck", "rescan"]);

  const GOAL_ROWS_CAP = 4;

  const TARGETS = {
    race: { tab: "plan", section: "endurance" },
    goal: { tab: "horizon", section: "goal" },
    profile: { tab: "me", section: "profile" },
    checkup: { tab: "stand", section: "checkup" },
    body: { tab: "stand", section: "body" },
    health: { tab: "stand", section: null },
  } as const satisfies Record<string, Target>;

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function num(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function dayKey(value: unknown): string {
    const key = String(value || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : "";
  }

  /** "Sep 14", with the year only when it is not this one. */
  function dateWord(iso: unknown, today: string): string {
    const key = dayKey(iso);
    if (!key) return "";
    return CairnFmt.date(key, { today: today || undefined });
  }

  function windowWord(win: { start?: unknown; end?: unknown } | null | undefined, today: string): string {
    const start = dateWord(win?.start, today);
    const end = dateWord(win?.end, today);
    return start && end ? `${start} – ${end}` : start || end;
  }

  function copyTarget(target: Target, id?: unknown): Target {
    const out: Target = { tab: target.tab, section: target.section };
    if (id != null && String(id) !== "") out.id = String(id);
    return out;
  }

  function lane(key: Lane["key"], title: string, fields: Partial<Lane>): Lane {
    return {
      key,
      title,
      state: "set",
      headline: "",
      when: "",
      lede: "",
      fit: null,
      fit_word: "",
      fit_line: "",
      rows: [],
      links: [],
      ...fields,
    };
  }

  // ---- Race -----------------------------------------------------------------------

  /**
   * A GLANCE (the race page holds the depth). A runner with no race gets the running week
   * and the closed weeks, never an empty ladder; a lifting-only athlete (`running:
   * "none"`) no lane at all (`state: "absent"`: Horizon drops the view).
   */
  function raceLane(value: unknown, units?: unknown): Lane {
    const links = [{ label: "The race build", target: copyTarget(TARGETS.race) }];
    const unit = CairnRaceWeekModel.unitsOf(units);
    if (!record(value) || !("available" in (value as object))) {
      const headline = "The race build couldn't be read just now.";
      return lane("race", "Race", { state: "unread", headline, links, units: unit });
    }
    const build = value as RaceBuild;
    const model = CairnRaceViewModel.viewModel(value, { units });
    if (!model) {
      if (build.running === "none") return lane("race", "Running", { state: "absent", units: unit });
      const reason = text(build.reason);
      const thisWeek = CairnRaceViewModel.thisWeekModel(build, units);
      const volume = CairnRaceWeekModel.volumeWeeks(build, units);
      const running = !!thisWeek || volume.length > 0;
      return lane("race", running ? "Running" : "Race", {
        state: "none",
        headline: "No race on the calendar",
        lede: reason || "Set a dated half marathon in You → Profile and the build reads from it here.",
        this_week: thisWeek,
        volume,
        units: unit,
        links: [
          { label: "Set a race", target: copyTarget(TARGETS.profile) },
          ...(running ? [{ label: "Your runs", target: copyTarget(TARGETS.race) }] : []),
        ],
      });
    }
    return lane("race", "Race", {
      headline: model.event,
      voice: CairnRaceViewModel.buildVoice(model.ladder, build.race),
      when: [model.countdown, model.race_day].filter(Boolean).join(" · "),
      lede: model.race_day ? `${model.event}, ${model.race_day}.` : "",
      fit: model.estimate.fit,
      fit_word: model.estimate.fit_word,
      fit_line: model.estimate.fit_line,
      terrain: model.terrain,
      this_week: model.this_week,
      units: unit,
      links,
    });
  }

  // ---- Goal line ------------------------------------------------------------------

  function timelineRows(value: unknown): TimelineEntry[] {
    return Array.isArray(value) ? (value as TimelineEntry[]).filter((entry) => !!record(entry)) : [];
  }

  /** A timeline entry still ahead of (or open on) today, in words. Undated rows are left to the depth view. */
  function entryAhead(entry: TimelineEntry, today: string): { when: string } | null {
    const date = dayKey(entry.when?.date);
    if (date) return !today || date >= today ? { when: dateWord(date, today) } : null;
    const win = entry.when?.window;
    const end = dayKey(win?.end);
    if (end) return !today || end >= today ? { when: windowWord(win, today) } : null;
    return null;
  }

  /** Bodyweight now and at the goal, then the server's own scale sentence: never a pace word derived here. */
  function weightLine(read: JourneyRead | null): string {
    const progress = read?.recomposition?.progress;
    const now = num(progress?.current_weight_lb);
    const goal = num(progress?.goal_weight_lb ?? read?.profile?.goal_weight_lb);
    if (now == null || goal == null) return "";
    const lb = (n: number) => CairnFmt.weight(n);
    const scale = text(read?.recomposition?.scale?.line);
    return `${lb(now)} now, ${lb(goal)} the goal.${scale ? ` ${scale}` : ""}`;
  }

  /**
   * The phase as ONE sentence for the Season's serif headline: "Leaning-out phase since
   * Sep 25, toward 154 lb." — never the depth view's mono fragments ("… · since … · …"),
   * which read as a path of slashes at headline size. With no active phase, the journey
   * card's own summary.
   */
  function phaseLine(read: JourneyRead | null): string {
    if (!read) return "";
    const phase = record(read.active_phase);
    if (phase && text(phase.kind)) {
      const kind = text(phase.kind).replace(/_/g, " ");
      const label = text(read.recomposition?.stage?.label) || kind.charAt(0).toUpperCase() + kind.slice(1);
      const since = dayKey(phase.start_date) ? CairnFmt.date(dayKey(phase.start_date)) : "";
      const goalLb = num(read.profile?.goal_weight_lb) ?? num(phase.target_weight_lb);
      const toward = goalLb != null ? CairnFmt.weight(goalLb) : "";
      return `${label}${since ? ` since ${since}` : ""}${toward ? `, toward ${toward}` : ""}.`;
    }
    const journey = typeof CairnProgressJourney !== "undefined" ? CairnProgressJourney : null;
    return text(journey?.phaseSummary?.(read, []) || "");
  }

  function goalLane(journey: unknown, timeline: unknown, today: string): Lane {
    const read = record(journey) as JourneyRead | null;
    const entries = timelineRows(timeline);
    const links = [{ label: "The goal line", target: copyTarget(TARGETS.goal) }];
    if (!read && !Array.isArray(timeline)) {
      return lane("goal", "Goal line", {
        state: "unread",
        headline: "The goal line couldn't be read just now.",
        links,
      });
    }
    const rows: Row[] = [];
    for (const entry of entries) {
      if (LAB_TIMELINE_KINDS.has(String(entry.kind))) continue;
      const ahead = entryAhead(entry, today);
      if (!ahead) continue;
      rows.push({
        side: "ahead",
        when: ahead.when,
        label: text(entry.label),
        detail: text(entry.detail),
        kind: text(entry.kind) || "milestone",
        target: null,
      });
      if (rows.length >= GOAL_ROWS_CAP) break;
    }
    const headline = phaseLine(read);
    const weight = weightLine(read);
    if (!headline && !weight && !rows.length) {
      return lane("goal", "Goal line", {
        state: "none",
        headline: "No goal line yet",
        lede: "A goal weight or a goal date in You → Profile draws one.",
        links: [{ label: "Set a goal", target: copyTarget(TARGETS.profile) }],
      });
    }
    return lane("goal", "Goal line", {
      headline: headline || "Your journey so far",
      lede: weight,
      rows,
      links,
    });
  }

  // ---- The week read, dressing two lanes ------------------------------------------

  /**
   * A lane as the week read (GET /api/week) dresses it: the race build wears the week's
   * frame as its hero (the one stage vocabulary, never the ladder's own count), and the
   * goal line carries the weight goal's row (the one weight trend) in place of its own
   * weight sentence. Any other lane, or no read, comes back as it was.
   */
  function withWeek(source: Lane, week: unknown): Lane {
    const read = record(week);
    if (!read || source.state !== "set") return source;
    if (source.key === "race") {
      const frame = record(read.frame) as Lane["frame"] | null;
      return frame && text(frame.headline) ? { ...source, frame } : source;
    }
    if (source.key === "goal" && typeof CairnWeekModel !== "undefined") {
      const goalRow = CairnWeekModel.weightGoal(read);
      return goalRow ? { ...source, goal_row: goalRow } : source;
    }
    return source;
  }

  /** The shaping parts the labs-and-season model (horizon-labs-model.ts) shares. */
  const parts = {
    record,
    text,
    num,
    dayKey,
    dateWord,
    copyTarget,
    lane,
    timelineRows,
    entryAhead,
    LAB_TIMELINE_KINDS,
  };

  const CAIRN_HORIZON_MODEL = {
    withWeek,
    TARGETS,
    raceLane,
    goalLane,
    weightLine,
    parts,
  };

  Object.assign(globalThis, { CairnHorizonModel: CAIRN_HORIZON_MODEL });
}

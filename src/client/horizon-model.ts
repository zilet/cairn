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
//   - Labs and scans: past draws and scans from GET /api/health-docs, what is ahead
//     from GET /api/health/next-checkup in the server's own words (the recheck rows of
//     the timeline stand in only when the checkup read is missing). Every row links
//     into You's Health pages (the lazy me-health bundle); nothing here renders them.
//
// Decision Q5: no merged server endpoint, so nothing here derives a server-owned fact.
// Staleness is never judged (marker-validity.ts owns that), a due date is never turned
// into urgency, and no row carries a number that reads as a score.
{
  type RaceBuild = import("../contracts/client-api.js").ClientRaceBuild;
  type JourneyRead = import("../contracts/client-api.js").ClientJourneyRead;
  type TimelineEntry = import("../contracts/client-api.js").ClientForwardTimelineEntry;
  type HealthDoc = import("../contracts/client-api.js").ClientHealthDocument;
  type Checkup = import("../contracts/client-api.js").ClientNextCheckup;
  type CheckupItem = import("../contracts/client-api.js").ClientCheckupItem;
  type Lane = ClientHorizonLane;
  type Row = ClientHorizonRow;
  type Target = ClientHorizonTarget;

  /** The document kinds that are a draw or a scan: the labs lane's "behind" rows. */
  const LAB_KINDS: Readonly<Record<string, string>> = {
    bloodwork: "Bloodwork",
    dexa: "DEXA scan",
    imaging: "Imaging",
    metabolic_test: "Metabolic test",
    ecg: "ECG",
  };
  /** Timeline kinds that belong to the labs lane; every other kind is the goal line's. */
  const LAB_TIMELINE_KINDS = new Set(["recheck", "rescan"]);

  const PAST_CAP = 3;
  const AHEAD_CAP = 3;
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

  function phaseLine(read: JourneyRead | null): string {
    if (!read) return "";
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

  // ---- Labs and scans -------------------------------------------------------------

  function docDate(doc: HealthDoc): string {
    return dayKey(doc.doc_date) || dayKey(doc.created_at);
  }

  function pastRows(docs: unknown, today: string): Row[] {
    const rows = (Array.isArray(docs) ? (docs as HealthDoc[]) : [])
      .filter((doc) => !!record(doc) && Object.hasOwn(LAB_KINDS, String(doc.kind || "")) && doc.id != null)
      .map((doc) => ({ doc, date: docDate(doc) }))
      .filter((entry) => entry.date && (!today || entry.date <= today))
      .sort((a, b) => (a.date === b.date ? Number(b.doc.id) - Number(a.doc.id) : a.date < b.date ? 1 : -1))
      .slice(0, PAST_CAP);
    // Newest three, laid out oldest first so the rail runs toward today.
    return rows.reverse().map(({ doc, date }) => ({
      side: "behind" as const,
      when: dateWord(date, today),
      label: LAB_KINDS[String(doc.kind)],
      detail: "",
      kind: String(doc.kind),
      target: { tab: "stand", section: "records", id: String(doc.id) },
    }));
  }

  function checkupRow(item: CheckupItem, today: string): Row | null {
    const label = text(item?.label);
    if (!label) return null;
    return {
      side: "ahead",
      when: text(item.when_text) || dateWord(item.next_due, today),
      label,
      detail: "",
      kind: text(item.kind) || "lab",
      target: copyTarget(item.kind === "dexa" ? TARGETS.body : TARGETS.checkup),
    };
  }

  function aheadRows(checkup: Checkup | null, timeline: unknown, today: string): Row[] {
    const rows: Row[] = [];
    const seen = new Set<string>();
    const push = (row: Row | null) => {
      if (!row || rows.length >= AHEAD_CAP) return;
      const key = row.label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    };
    if (checkup) {
      const items = [
        ...(Array.isArray(checkup.due_now) ? checkup.due_now : []),
        ...(Array.isArray(checkup.upcoming) ? checkup.upcoming : []),
      ];
      for (const item of items) push(checkupRow(item, today));
      return rows;
    }
    // No checkup read: the timeline's own recheck and re-scan rows say what is ahead.
    for (const entry of timelineRows(timeline)) {
      if (!LAB_TIMELINE_KINDS.has(String(entry.kind))) continue;
      const ahead = entryAhead(entry, today);
      if (!ahead) continue;
      push({
        side: "ahead",
        when: ahead.when,
        label: text(entry.label),
        detail: "",
        kind: String(entry.kind),
        target: copyTarget(entry.kind === "rescan" ? TARGETS.body : TARGETS.checkup),
      });
    }
    return rows;
  }

  function labsLane(docs: unknown, checkupValue: unknown, timeline: unknown, today: string): Lane {
    const checkup = record(checkupValue) as Checkup | null;
    if (!Array.isArray(docs) && !checkup) {
      return lane("labs", "Labs and scans", {
        state: "unread",
        headline: "Labs and scans couldn't be read just now.",
        links: [{ label: "Health", target: copyTarget(TARGETS.health) }],
      });
    }
    const behind = pastRows(docs, today);
    const ahead = aheadRows(checkup, timeline, today);
    const links = [{ label: "Next checkup", target: copyTarget(TARGETS.checkup) }];
    if (!behind.length && !ahead.length) {
      return lane("labs", "Labs and scans", {
        state: "none",
        headline: "No labs or scans yet",
        lede: "Add a lab panel or a scan in You → Health, and the next checkup lines up here.",
        links: [{ label: "Add labs or scan", target: copyTarget(TARGETS.health) }],
      });
    }
    const lede = checkup?.has_content ? text(checkup.lede) : "";
    return lane("labs", "Labs and scans", {
      headline: ahead.length ? "What's next" : "Your latest draws and scans",
      lede,
      rows: [...behind, ...ahead],
      links,
    });
  }

  // ---- Season ---------------------------------------------------------------------

  // The season on one line: goal-pace weigh-ins and goal, the timeline's projection window
  // (the fan) and race day, and dated marks. Null under two weigh-ins; the lanes still speak.
  function season(
    pace: unknown,
    timeline: unknown,
    docs: unknown,
    checkupValue: unknown,
    today: string
  ): ClientHorizonSeason | null {
    const read = record(pace);
    const points = (Array.isArray(read?.points) ? (read.points as unknown[]) : [])
      .map((p) => ({ date: dayKey(record(p)?.date), lb: num(record(p)?.weight_lb) }))
      .filter((p): p is { date: string; lb: number } => !!p.date && p.lb != null)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (points.length < 2) return null;
    const entry = (id: string) => timelineRows(timeline).find((e) => e.id === id);
    const win = entry("phase:projection")?.when?.window;
    const race = entry("goal:endurance-race");
    const marks: ClientHorizonSeasonMark[] = [];
    for (const doc of Array.isArray(docs) ? (docs as HealthDoc[]) : []) {
      const date = record(doc) && Object.hasOwn(LAB_KINDS, String(doc.kind || "")) ? docDate(doc) : "";
      if (date && date >= points[0].date && (!today || date <= today))
        marks.push({ date, label: LAB_KINDS[String(doc.kind)], kind: String(doc.kind), side: "behind" });
    }
    const checkup = record(checkupValue) as Checkup | null;
    // A recheck due now stands on today's line even once its date has passed (the labs
    // rail still lists it); an upcoming one stands at its own date.
    const due = (checkup?.due_now || []).map((item) => [item, true] as const);
    for (const [item, now] of [...due, ...(checkup?.upcoming || []).map((item) => [item, false] as const)]) {
      const date = now && today && dayKey(item?.next_due) < today ? today : dayKey(item?.next_due);
      if (date && (!today || date >= today))
        marks.push({ date, label: text(item.label), kind: text(item.kind) || "lab", side: "ahead" });
    }
    return {
      points,
      goal_lb: num(record(read?.goal)?.weight_lb),
      goal_date: dayKey(record(read?.goal)?.date) || dayKey(entry("goal:weight")?.when?.date) || null,
      fan: dayKey(win?.start) && dayKey(win?.end) ? { start: dayKey(win?.start), end: dayKey(win?.end) } : null,
      race: race && dayKey(race.when?.date) ? { date: dayKey(race.when?.date), label: text(race.label) } : null,
      marks,
      today,
    };
  }

  const CAIRN_HORIZON_MODEL = {
    season,
    LAB_KINDS,
    TARGETS,
    raceLane,
    goalLane,
    labsLane,
    weightLine,
  };

  Object.assign(globalThis, { CairnHorizonModel: CAIRN_HORIZON_MODEL });
}

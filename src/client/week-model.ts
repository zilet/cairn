// @ts-check
// The week, the model (docs/IA.md "Shared objects: Week"): GET /api/week (WeekRead,
// src/contracts/week-read.ts) shaped for Horizon's Week page — the frame for the hero,
// the seven columns of the week's shape, the day-by-day glances, what is still open, the
// next milestones and the goals. Replaces horizon-week-model (the old GET /plan/week
// shaping). It also shapes what the redesigned landing adds (docs/IA.md "Horizon landing"):
// the proof band ("Since you started", `proof`), the marks ahead as rows (`journey.marks`,
// ahead-strip-client.ts), the totals words for the shape's masthead and the frame's `sub`.
// Every new field is optional on the wire: an older read (or the cached first paint)
// leaves it empty and the view keeps today's rendering of that section.
//
// Pure: a DTO in, a view model out; never fetches, never touches the DOM or `state`.
// Every word is the server's, already in the athlete's units. A column's height is the
// server's relative dose (`load.height`), a drawing aid — the dose is said as its WORD,
// never a number. A day's status is the chip's own (`status`); nothing here compares
// dates to decide one.
//
// LAZY ("calendar" bundle).
{
  type WeekRead = import("../contracts/week-read.js").WeekRead;
  type DayChip = import("../contracts/week-read.js").DayChip;
  type WeekOpen = import("../contracts/week-read.js").WeekReadOpen;
  type WeekProof = import("../contracts/week-read.js").WeekReadProof;
  type WeekStanding = import("../contracts/week-read.js").WeekReadStandingRow;
  type JourneyMark = import("../contracts/week-read.js").WeekReadJourneyMark;

  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  /** "Still open" holds two lines at most (docs/IA.md "Horizon landing" 3). */
  const OPEN_MAX = 2;
  /** "Next up" holds three milestones at most. */
  const NEXT_MAX = 3;
  /** "Since you started" holds three measured changes at most. */
  const PROOF_MAX = 3;
  const PROOF_STONES: ReadonlySet<string> = new Set(["body", "strength", "endurance"]);
  const SERIES_KINDS: ReadonlySet<string> = new Set(["line", "steps", "columns"]);

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isoOf(value: unknown): string | null {
    const s = text(value);
    return ISO.test(s) ? s : null;
  }

  function list<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]).filter((v) => !!record(v)) : [];
  }

  /** A plan day's name short enough for a seventh of a phone, through the day view's own rule. */
  function tagOf(title: string): string {
    if (!title) return "";
    return typeof CairnDayDetailModel !== "undefined" ? CairnDayDetailModel.abbr(title) : title.slice(0, 5);
  }

  /** One column: the day's label, its bar's hues and height, and every word for its label. */
  function shapeDay(chip: DayChip, index: number): ClientWeekShapeDay {
    const date = isoOf(chip.date);
    const run = chip.run && !chip.run.rested && !chip.run.covered ? chip.run : null;
    const stones: Array<"strength" | "endurance"> = [];
    if (chip.lift) stones.push("strength");
    if (run) stones.push("endurance");
    const status = text(chip.status);
    const done = status === "done";
    const missed = status === "open";
    // A key session (the server's `hard`: a heavy-leg lift, a quality or long run) still
    // ahead this week is drawn hollow, so the week's big asks stand out before they land.
    const ahead = status === "upcoming" || (status === "today" && !(run && run.status === "completed" && !chip.lift));
    const load = record(chip.load);
    const height = Math.max(0, Math.min(1, Number(load?.height) || 0));
    const doseWord = text(load?.word);
    const words = text(chip.words) || (stones.length ? "" : "Rest");
    const when = text(chip.date_words) || `Day ${index + 1}`;
    const aria = [
      `${when}${chip.today ? ", today" : ""}: ${words}`,
      doseWord && text(load?.dose) !== "rest" ? `${doseWord} load` : "",
      done ? "done" : missed ? "still open" : "",
    ]
      .filter(Boolean)
      .join(". ");
    return {
      date,
      weekday: (text(chip.weekday) || "Day").slice(0, 3).toUpperCase(),
      num: date ? CairnFmt.date(date, { fmt: { day: "numeric" } }) : String(index + 1),
      // The tag names the lift; a run-only day names its run, in the run's own stone.
      tag: tagOf(text(chip.lift?.title)) || (run ? tagOf(text(run.label)) : ""),
      tag_stone: chip.lift ? "strength" : run ? "endurance" : "strength",
      today: chip.today === true,
      done,
      rest: !stones.length,
      key_open: chip.hard === true && ahead && stones.length > 0,
      missed,
      stones,
      height: stones.length ? height : Math.min(height, 0.08),
      dose_word: doseWord,
      aria,
    };
  }

  /** A dated chip as the day view's glance (the same words Program's week rows say). */
  function glanceOf(chip: DayChip, today: string, units: unknown): ClientDayGlance | null {
    const date = isoOf(chip.date);
    if (!date || typeof CairnDayDetailModel === "undefined") return null;
    const run = chip.run && !chip.run.rested ? chip.run : null;
    const km = Number(run?.km);
    return CairnDayDetailModel.glance({
      date,
      today,
      isToday: chip.today === true,
      lift: chip.lift ? { name: text(chip.lift.title), done: chip.status === "done", live: false } : null,
      run: run
        ? {
            label: text(run.label),
            kind: text(run.kind),
            km: Number.isFinite(km) && km > 0 ? km : null,
            done: run.status === "completed",
          }
        : null,
      units,
    });
  }

  function openRow(row: WeekOpen): ClientWeekOpenRow | null {
    const words = text(row.words);
    if (!words) return null;
    const kind = text(row.kind);
    return { kind, stone: kind === "lift" ? "strength" : "endurance", words, date: isoOf(row.date) };
  }

  /** An in-app link the server named ("/app/horizon/race"); anything else is no link at all. */
  function hrefOf(value: unknown): string | null {
    const s = text(value);
    return /^\/app\/[^\s"'<>\\]*$/.test(s) ? s : null;
  }

  /** One measured change since the start (the proof band); null without a label or an after. */
  function proofRow(row: WeekProof): ClientProofRow | null {
    const label = text(row.label);
    const after = text(row.after_text);
    if (!label || !after) return null;
    const stone = PROOF_STONES.has(text(row.stone)) ? (text(row.stone) as ClientProofRow["stone"]) : "body";
    const kind = SERIES_KINDS.has(text(row.series_kind)) ? (text(row.series_kind) as ClientProofRow["kind"]) : "line";
    const raw = Array.isArray(row.series) ? row.series.map(Number) : [];
    const series = raw.every((v) => Number.isFinite(v)) ? raw.map((v) => Math.max(0, Math.min(1, v))) : [];
    return {
      key: text(row.key) || "proof",
      stone,
      label,
      before: text(row.before_text),
      after,
      sinceWords: text(row.since_words),
      series: series.length >= 2 ? series : [],
      kind,
      href: hrefOf(row.href),
    };
  }

  /** A journey mark as the ahead strip and its rows read it: days out, a window's end, its stone. */
  function aheadMark(mark: JourneyMark): ClientAheadMark | null {
    const date = isoOf(mark.date);
    const label = text(mark.label);
    const days = Number(mark.days_away);
    if (!date || !label || !Number.isFinite(days)) return null;
    const end = isoOf(mark.end_date);
    // A window's length is geometry for the strip (how long a bar it draws), never a status.
    const span = end && end > date ? CairnFmt.daysBetween(end, date) : 0;
    const kind = text(mark.kind).replace(/[^a-z0-9_-]/gi, "") || "milestone";
    const look = CairnMilestoneRowModel.KINDS[kind];
    const from = Math.max(0, days);
    return {
      kind,
      stone: look ? look.stone : "endurance",
      label,
      short: text(mark.short),
      date,
      end_date: Number.isFinite(span) && span > 0 ? end : null,
      when: text(mark.date_words),
      days_words: text(mark.days_words),
      detail: text(mark.detail),
      days: from,
      end_days: Number.isFinite(span) && span > 0 ? from + span : null,
      href: hrefOf(mark.href),
    };
  }

  /** The shape's masthead words: "1 of 5 lifting days · 16.6 mi planned" (the server's two). */
  function totalsWords(value: unknown): string {
    const totals = record(value);
    return [text(totals?.lift_words), text(totals?.run_words)].filter(Boolean).join(" · ");
  }

  /** The journey trail as served, kept only when it has a dated mark to draw toward. */
  function journeyOf(value: unknown): WeekRead["journey"] {
    const j = record(value) as WeekRead["journey"];
    if (!j || !isoOf(j.start_date) || !isoOf(j.today)) return null;
    const marks = list<NonNullable<WeekRead["journey"]>["marks"][number]>(j.marks).filter((m) => isoOf(m.date));
    if (!marks.length) return null;
    // `walked` stays index for index (a tapped stone is named by its place); absent on an older read.
    return {
      ...j,
      marks,
      behind: list(j.behind),
      ...(j.walked !== undefined ? { walked: list(j.walked) } : {}),
      line: text(j.line),
    };
  }

  /**
   * The Week page's whole model; null when the read failed (not an object with days). A
   * read with no days is an empty week: `days` is empty and the view says so in one line.
   */
  function landing(value: unknown): ClientWeekLanding | null {
    const read = record(value) as WeekRead | null;
    if (!read || !Array.isArray(read.days)) return null;
    const chips = list<DayChip>(read.days);
    const today = isoOf(read.today) || "";
    const units = read.units?.distance === "mi" ? "mi" : "km";
    const frame = (record(read.frame) || {}) as unknown as WeekRead["frame"];
    const journey = journeyOf(read.journey);
    const ahead = (journey?.marks ?? []).map(aheadMark).filter((m): m is ClientAheadMark => !!m);
    return {
      frame,
      range: text(read.range_words),
      days: chips.map(shapeDay),
      summary: text(read.summary),
      layout_note: text(read.layout_note),
      glances: chips.map((chip) => glanceOf(chip, today, units)).filter((g): g is ClientDayGlance => !!g),
      open: list<WeekOpen>(read.still_open)
        .map(openRow)
        .filter((r): r is ClientWeekOpenRow => !!r)
        .slice(0, OPEN_MAX),
      next: list(read.next_milestones)
        .map((m) => CairnMilestoneRowModel.fromWeekRead(m))
        .filter((r): r is ClientMilestoneRow => !!r)
        .slice(0, NEXT_MAX),
      goals: list(read.goals)
        .map((g) => CairnGoalRowModel.fromWeekRead(g))
        .filter((r): r is ClientGoalRow => !!r),
      journey,
      this_week: read.this_week !== false,
      proof: list<WeekProof>(read.proof)
        .map(proofRow)
        .filter((r): r is ClientProofRow => !!r)
        .slice(0, PROOF_MAX),
      standing: list<WeekStanding>(read.standing),
      ahead,
      totals_words: totalsWords(read.totals),
      sub: text(frame.sub),
    };
  }

  /** The weight goal alone (the Season's goal line shows the one weight trend through it). */
  function weightGoal(value: unknown): ClientGoalRow | null {
    const read = record(value) as WeekRead | null;
    const goal = list(read?.goals).find((g) => (g as { key?: unknown }).key === "weight");
    return goal ? CairnGoalRowModel.fromWeekRead(goal) : null;
  }

  const CAIRN_WEEK_MODEL = { landing, shapeDay, weightGoal, hrefOf };

  Object.assign(globalThis, { CairnWeekModel: CAIRN_WEEK_MODEL });
}

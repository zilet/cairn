// @ts-check
// The milestone row, the model (docs/IA.md "Component architecture"): one dated thing
// on a line of time — a long run, peak week, the race, the goal date, a checkup, a lab
// draw or a scan — shaped for ONE row view (milestone-row-client.ts) that Horizon's
// Week ("Next up") and its Season (the goal line, labs and scans) both draw. Pure: a
// DTO in, a row out. The when is always the server's words or CairnFmt's; a row never
// carries a bare date, and nothing here decides what is due or late.
//
// LAZY ("calendar" bundle).
{
  type WeekMilestone = import("../contracts/week-read.js").WeekReadMilestone;

  /** Each kind's stone (its hue) and its mark: training and goal dates are dots, labs and scans diamonds. */
  const KINDS: Readonly<Record<string, { stone: ClientRowStone; mark: "dot" | "diamond" }>> = {
    long_run: { stone: "endurance", mark: "dot" },
    peak_week: { stone: "endurance", mark: "dot" },
    race: { stone: "endurance", mark: "dot" },
    checkpoint: { stone: "strength", mark: "dot" },
    retest: { stone: "strength", mark: "dot" },
    block: { stone: "strength", mark: "dot" },
    goal: { stone: "body", mark: "dot" },
    phase: { stone: "body", mark: "dot" },
    checkup: { stone: "heart", mark: "diamond" },
    recheck: { stone: "heart", mark: "diamond" },
    lab: { stone: "heart", mark: "diamond" },
    bloodwork: { stone: "heart", mark: "diamond" },
    metabolic_test: { stone: "heart", mark: "diamond" },
    ecg: { stone: "heart", mark: "diamond" },
    imaging: { stone: "heart", mark: "diamond" },
    dexa: { stone: "body", mark: "diamond" },
    rescan: { stone: "body", mark: "diamond" },
  };
  const FALLBACK = { stone: "endurance" as ClientRowStone, mark: "dot" as const };

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** The kind as a class-safe hook ("long_run"); "milestone" when it names nothing. */
  function kindOf(value: unknown): string {
    return text(value).replace(/[^a-z0-9_-]/gi, "") || "milestone";
  }

  function row(kind: string, side: "behind" | "ahead", when: string, label: string, detail: string): ClientMilestoneRow {
    const look = KINDS[kind] || FALLBACK;
    return { kind, stone: look.stone, mark: look.mark, side, when, label, detail };
  }

  /** A milestone of GET /api/week (next_milestones): the server's date words, always ahead. */
  function fromWeekRead(value: unknown): ClientMilestoneRow | null {
    const m = value && typeof value === "object" ? (value as WeekMilestone) : null;
    const label = text(m?.label);
    if (!m || !label) return null;
    return row(kindOf(m.kind), "ahead", text(m.date_words), label, text(m.detail));
  }

  /** A row a Horizon lane already shaped (the Season's goal line, labs and scans). */
  function fromLaneRow(value: ClientHorizonRow | null | undefined): ClientMilestoneRow | null {
    const label = text(value?.label);
    if (!value || !label) return null;
    return row(kindOf(value.kind), value.side === "behind" ? "behind" : "ahead", text(value.when), label, text(value.detail));
  }

  const CAIRN_MILESTONE_ROW_MODEL = { fromWeekRead, fromLaneRow, KINDS };

  Object.assign(globalThis, { CairnMilestoneRowModel: CAIRN_MILESTONE_ROW_MODEL });
}

// @ts-check
// The Horizon Season's labs-and-scans lane and its season line, the model (split out of
// horizon-model.ts, whose shaping `parts` it shares, read at call time).
//
//   - Labs and scans: past draws and scans from GET /api/health-docs/draws — ONE row per
//     draw, server-side (repo/lab-draws.ts: an upload and the panels split out of it are
//     one draw, never three rows) — what is ahead from GET /api/health/next-checkup in the
//     server's own words (the recheck rows of the timeline stand in only when the checkup
//     read is missing). Every row links into You's Health pages (the lazy me-health
//     bundle); nothing here renders them.
//   - The season line: goal-pace weigh-ins and goal, the timeline's projection window
//     (the fan) and race day, and the draws and rechecks as dated marks.
//
// Staleness is never judged (marker-validity.ts owns that), a due date is never turned
// into urgency, and no row carries a number that reads as a score.
{
  type TimelineEntry = import("../contracts/client-api.js").ClientForwardTimelineEntry;
  type LabDraw = import("../contracts/client-api.js").ClientLabDraw;
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

  const PAST_CAP = 3;
  const AHEAD_CAP = 3;

  // horizon-model's shaping parts, reached at call time (never at load).
  const P = () => CairnHorizonModel.parts;
  const record = (value: unknown) => P().record(value);
  const text = (value: unknown) => P().text(value);
  const num = (value: unknown) => P().num(value);
  const dayKey = (value: unknown) => P().dayKey(value);
  const dateWord = (iso: unknown, today: string) => P().dateWord(iso, today);
  const copyTarget = (target: Target, id?: unknown) => P().copyTarget(target, id);
  const lane = (key: Lane["key"], title: string, fields: Partial<Lane>) => P().lane(key, title, fields);
  const timelineRows = (value: unknown): TimelineEntry[] => P().timelineRows(value);
  const entryAhead = (entry: TimelineEntry, today: string) => P().entryAhead(entry, today);
  const isLabTimelineKind = (kind: unknown) => P().LAB_TIMELINE_KINDS.has(String(kind));
  const TARGET = (key: "checkup" | "body" | "health") => CairnHorizonModel.TARGETS[key];

  // ---- Labs and scans -------------------------------------------------------------

  /**
   * GET /api/health-docs/draws: one row per draw (kind + date), already deduped and
   * labelled server-side. Kept to the draw kinds, dated on or before today, and — as a
   * last guard — one row per (kind, date) even if a read ever repeats one.
   */
  function drawRows(draws: unknown, today: string): Array<{ draw: LabDraw; date: string }> {
    const seen = new Set<string>();
    const out: Array<{ draw: LabDraw; date: string }> = [];
    for (const draw of Array.isArray(draws) ? (draws as LabDraw[]) : []) {
      if (!record(draw) || !Object.hasOwn(LAB_KINDS, String(draw.kind || "")) || draw.doc_id == null) continue;
      const date = dayKey(draw.date);
      if (!date || (today && date > today)) continue;
      const key = `${draw.kind}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ draw, date });
    }
    return out;
  }

  function pastRows(draws: unknown, today: string): Row[] {
    const rows = drawRows(draws, today)
      .sort((a, b) => (a.date === b.date ? Number(b.draw.doc_id) - Number(a.draw.doc_id) : a.date < b.date ? 1 : -1))
      .slice(0, PAST_CAP);
    // Newest three, laid out oldest first so the rail runs toward today.
    return rows.reverse().map(({ draw, date }) => ({
      side: "behind" as const,
      when: text(draw.date_words) || dateWord(date, today),
      label: text(draw.label) || LAB_KINDS[String(draw.kind)],
      detail: "",
      kind: String(draw.kind),
      target: { tab: "stand", section: "records", id: String(draw.doc_id) },
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
      target: copyTarget(item.kind === "dexa" ? TARGET("body") : TARGET("checkup")),
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
      if (!isLabTimelineKind(entry.kind)) continue;
      const ahead = entryAhead(entry, today);
      if (!ahead) continue;
      push({
        side: "ahead",
        when: ahead.when,
        label: text(entry.label),
        detail: "",
        kind: String(entry.kind),
        target: copyTarget(entry.kind === "rescan" ? TARGET("body") : TARGET("checkup")),
      });
    }
    return rows;
  }

  function labsLane(draws: unknown, checkupValue: unknown, timeline: unknown, today: string): Lane {
    const checkup = record(checkupValue) as Checkup | null;
    if (!Array.isArray(draws) && !checkup) {
      return lane("labs", "Labs and scans", {
        state: "unread",
        headline: "Labs and scans couldn't be read just now.",
        links: [{ label: "Health", target: copyTarget(TARGET("health")) }],
      });
    }
    const behind = pastRows(draws, today);
    const ahead = aheadRows(checkup, timeline, today);
    const links = [{ label: "Next checkup", target: copyTarget(TARGET("checkup")) }];
    if (!behind.length && !ahead.length) {
      return lane("labs", "Labs and scans", {
        state: "none",
        headline: "No labs or scans yet",
        lede: "Add a lab panel or a scan in You → Health, and the next checkup lines up here.",
        links: [{ label: "Add labs or scan", target: copyTarget(TARGET("health")) }],
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
    draws: unknown,
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
    for (const { draw, date } of drawRows(draws, today)) {
      if (date >= points[0].date)
        marks.push({ date, label: text(draw.label) || LAB_KINDS[String(draw.kind)], kind: String(draw.kind), side: "behind" });
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

  const CAIRN_HORIZON_LABS_MODEL = { LAB_KINDS, labsLane, season, drawRows };

  Object.assign(globalThis, { CairnHorizonLabsModel: CAIRN_HORIZON_LABS_MODEL });
}

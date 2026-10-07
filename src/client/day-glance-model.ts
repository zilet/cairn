// @ts-check
// The day's GLANCE, the model half: one day as a chip or a row (`glance`, `glanceOfWeekDay`,
// `glanceOfLookAheadDay`, `abbr`), split out of day-detail-model.ts and published on the
// same CairnDayDetailModel, so a lift or a run reads in the same words wherever a week
// shows it. Pure; no DOM, no fetch. LAZY ("calendar" bundle), loaded right after the model.
{
  type GlanceWeekDay = import("../contracts/client-api.js").ClientPlanWeekDay;
  type GlanceLookAheadDay = import("../contracts/client-api.js").ClientPlanLookAheadDay;

  const { distText } = CairnDayDetailModel;

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- the glance: one day as a chip or a row ----

  type GlanceMark = "done" | "live" | "planned" | "open";
  /** What any week read says about one day, before it is framed. */
  type GlanceInput = {
    date: string;
    /** The read's local today (ISO); "" when the read says only `today` (the look-ahead). */
    today: string;
    isToday: boolean;
    lift: { name: string; done: boolean; live: boolean } | null;
    run: { label: string; kind: string; km: number | null; done: boolean } | null;
    units: unknown;
    /** Today adapted to another plan day ("Lower B"). */
    swappedFrom?: string;
  };

  const GLANCE_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const GLANCE_DOW_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const RUN_KIND_WORD: Readonly<Record<string, string>> = {
    easy: "Easy run",
    quality: "Quality run",
    long: "Long run",
  };
  const MARK_WORD: Readonly<Record<GlanceMark, string>> = {
    done: "done",
    live: "under way",
    planned: "planned",
    open: "left open",
  };
  const GLANCE_ISO = /^\d{4}-\d{2}-\d{2}$/;

  /** A plan day's name short enough for a seventh of a phone: "Pull", "LB" (Lower B), "FB". */
  function abbr(name: string): string {
    const words = text(name).split(" ").filter(Boolean);
    if (!words.length) return "";
    if (words.length === 1) return words[0].length <= 5 ? words[0] : words[0].slice(0, 3);
    return words
      .slice(0, 3)
      .map((w) => w[0].toUpperCase())
      .join("");
  }

  function dowOf(iso: string): number {
    const ms = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
    return Number.isFinite(ms) ? new Date(ms).getUTCDay() : -1;
  }

  /**
   * One day framed for a chip or a row. A run done or behind is named by its kind
   * ("Easy run"): the agenda's label can be a morning's read that no longer describes
   * it; a run ahead keeps the server's label, the words the day read says for it.
   */
  function glance(input: GlanceInput): ClientDayGlance {
    const date = input.date;
    const dow = dowOf(date);
    const past = !!input.today && date < input.today;
    let lift: ClientDayGlance["lift"] = null;
    if (input.lift && text(input.lift.name)) {
      const name = text(input.lift.name);
      const state: GlanceMark = input.lift.done
        ? "done"
        : input.isToday && input.lift.live
          ? "live"
          : past
            ? "open"
            : "planned";
      lift = { name, abbr: abbr(name), state, words: name };
    }
    let run: ClientDayGlance["run"] = null;
    if (input.run) {
      const settled = input.run.done || past;
      const kind = /^(easy|quality|long)$/.test(input.run.kind) ? input.run.kind : "easy";
      const label = (settled ? RUN_KIND_WORD[input.run.kind] : "") || text(input.run.label) || "Run";
      const dist = distText(input.run.km, input.units);
      run = {
        label,
        kind,
        dist,
        state: input.run.done ? "done" : past ? "open" : "planned",
        words: dist ? `${label} · ${dist}` : label,
      };
    }
    const rest = !lift && !run;
    const done = !rest && (!lift || lift.state === "done") && (!run || run.state === "done");
    const parts: string[] = [];
    if (lift) parts.push(`${lift.name}, ${MARK_WORD[lift.state]}`);
    if (run) parts.push(`${run.words}, ${MARK_WORD[run.state]}`);
    const num = String(Number(date.slice(8, 10)));
    return {
      date,
      dow,
      weekday: GLANCE_DOW[dow] || "",
      num,
      today: input.isToday,
      past,
      lift,
      run,
      rest,
      done,
      swappedFrom: input.isToday ? text(input.swappedFrom) : "",
      aria: `${GLANCE_DOW_NAME[dow] || ""} ${num}${input.isToday ? ", today" : ""}: ${parts.length ? parts.join("; ") : "rest"}`,
    };
  }

  /** A day of GET /api/plan/week (Today's strip, Horizon's week) as its glance. */
  function glanceOfWeekDay(day: GlanceWeekDay | null | undefined, today: string, units: unknown): ClientDayGlance | null {
    const date = day && GLANCE_ISO.test(String(day.date || "")) ? String(day.date) : "";
    if (!day || !date) return null;
    const isToday = date === today;
    const plan = day.plan_day && day.plan_day.role === "strength" ? day.plan_day : null;
    const name = text(day.session?.title) || text(plan?.name);
    const km = Number(day.run?.km);
    return glance({
      date,
      today,
      isToday,
      lift:
        name && (day.session || plan)
          ? {
              name,
              done: day.session?.finished === true || (day.status === "done" && !!day.session),
              live: !!day.session,
            }
          : null,
      run:
        day.run && !day.run.rested
          ? {
              label: text(day.run.label),
              kind: text(day.run.kind),
              km: Number.isFinite(km) && km > 0 ? km : null,
              done: day.run.status === "completed",
            }
          : null,
      units,
      swappedFrom: isToday ? text(day.plan_day?.swapped_from?.name) : "",
    });
  }

  /** A day of GET /api/plan/look-ahead (Program's week) as its glance. */
  function glanceOfLookAheadDay(day: GlanceLookAheadDay | null | undefined, units: unknown): ClientDayGlance | null {
    const date = day && GLANCE_ISO.test(String(day.date || "")) ? String(day.date) : "";
    if (!day || !date) return null;
    const km = Number(day.run?.km);
    return glance({
      date,
      today: "",
      isToday: day.today === true,
      lift:
        day.lift && text(day.lift.title) ? { name: text(day.lift.title), done: day.lift.done === true, live: false } : null,
      run: day.run
        ? {
            label: text(day.run.label),
            kind: text(day.run.kind),
            km: day.run.km != null && Number.isFinite(km) && km > 0 ? km : null,
            done: day.run.done === true,
          }
        : null,
      units,
    });
  }

  Object.assign(CairnDayDetailModel, { glance, glanceOfWeekDay, glanceOfLookAheadDay, abbr });
}

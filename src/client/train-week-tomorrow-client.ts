// @ts-check
// Today's evening look-ahead: once today's training is in — or on a rest day from 17:00 —
// one calm line under the Brief's state line names tomorrow ("Tomorrow: Lower · Easy run ·
// 6 km") and opens its day page through the app's one `data-open-day` opener. A glance at
// the week, never a plan of its own: its words come from the week Today's strip reads
// (GET /api/plan/week, SWR "plan:week"; on a Sunday, Monday comes off Program's held
// look-ahead), so it costs no read. "" while today still has work open, or when nothing
// is known about tomorrow.
//
// EAGER (today bundle; tiny): the Brief paints it from the held week (`heldHtml`), and
// Today's strip (today-strip-controller.ts) rewrites it when the week lands (`html`).
{
  type Week = import("../contracts/client-api.js").ClientPlanWeek;
  type Ahead = import("../contracts/client-api.js").ClientPlanLookAhead;

  /** A rest day's look-ahead waits for the evening; a finished day says it at once. */
  const REST_FROM_HOUR = 17;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function word(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function held<T>(key: string): T | null {
    try {
      return typeof peekCached === "function" ? ((peekCached<T>(key)?.data ?? null) as T | null) : null;
    } catch {
      return null;
    }
  }

  function tomorrowHtml(weekValue: unknown, now: Date = new Date(), aheadValue?: unknown): string {
    const week = weekValue && typeof weekValue === "object" ? (weekValue as Week) : null;
    const days = Array.isArray(week?.days) ? week!.days : [];
    const today = word(week?.as_of);
    // A held week from another day says nothing about tomorrow: only the device's today counts.
    const pad = (n: number): string => String(n).padStart(2, "0");
    if (today !== `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`) return "";
    const cell = ISO.test(today) ? days.find((day) => day?.date === today) : null;
    if (!cell) return "";
    // Today's state off the same cells the strip draws: a lift is in once its session is
    // finished, a run once it is completed; a day holding neither is a rest day.
    const lift = !!cell.session || cell.plan_day?.role === "strength";
    const liftDone = cell.session?.finished === true || (cell.status === "done" && !!cell.session);
    const run = !!cell.run && !cell.run.rested;
    const runDone = cell.run?.status === "completed";
    const rest = !lift && !run;
    const done = !rest && (!lift || liftDone) && (!run || runDone);
    if (!done && !(rest && now.getHours() >= REST_FROM_HOUR)) return "";
    const next = new Date(`${today}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const date = next.toISOString().slice(0, 10);
    const units = week?.run_units === "mi" ? "mi" : "km";
    const runWords = (label: unknown, km: unknown): string =>
      [word(label) || "Run", Number(km) > 0 && typeof CairnFmt !== "undefined" ? CairnFmt.distance(Number(km), units) : ""]
        .filter(Boolean)
        .join(" · ");
    const parts: string[] = [];
    const tomorrow = days.find((day) => day?.date === date);
    if (tomorrow) {
      if (tomorrow.plan_day?.role === "strength") parts.push(word(tomorrow.plan_day.name));
      if (tomorrow.run && !tomorrow.run.rested) parts.push(runWords(tomorrow.run.label, tomorrow.run.km));
    } else {
      // Tomorrow is next week's Monday: Program's look-ahead holds it when it was read.
      const ahead = (aheadValue === undefined ? held<Ahead>("plan:look-ahead") : aheadValue) as Ahead | null;
      const weeks = ahead?.mode === "calendar" && Array.isArray(ahead.weeks) ? ahead.weeks : [];
      const day = weeks.flatMap((w) => (Array.isArray(w?.days) ? w.days : [])).find((d) => d?.date === date);
      if (!day) return "";
      if (day.lift) parts.push(word(day.lift.title));
      if (day.run) parts.push(runWords(day.run.label, day.run.km));
    }
    const words = parts.filter(Boolean).join(" · ") || "a rest day";
    return `<button class="brief-forward brief-tomorrow" type="button" data-open-day="${escAttr(date)}"><span class="brief-forward-arrow" aria-hidden="true">↗</span><span class="brief-forward-txt">Tomorrow: ${escHtml(words)}</span></button>`;
  }

  /** The line over the week Today's strip last read, when one is held. */
  function heldHtml(now: Date = new Date()): string {
    return tomorrowHtml(held<Week>("plan:week"), now);
  }

  const CAIRN_TRAIN_WEEK_TOMORROW = { html: tomorrowHtml, heldHtml, REST_FROM_HOUR };

  Object.assign(globalThis, { CairnTrainWeekTomorrow: CAIRN_TRAIN_WEEK_TOMORROW });
}

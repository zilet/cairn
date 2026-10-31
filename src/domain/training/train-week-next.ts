// The date Train's landing ("This week", src/client/train-week-client.ts twkNextOf) opens
// up as its next session: the first day from `today` on that still holds work — a lift
// not yet finished or a run not yet completed — off the week's cells, then the
// look-ahead's days the week does not carry (next week). The /train-home?view=week
// fan-in uses it to carry that day's /plan/day-detail in the same request, so the
// card's movements never wait on a second round.
//
// It mirrors the client's reading of a day (day-glance-model.ts glanceOfWeekDay /
// glanceOfLookAheadDay → glance's `rest` / `done`) and decides nothing new. If the two
// ever disagree, the client simply asks for its own date: one extra request, never a
// wrong card.
import type { PlanLookAhead } from "./plan-look-ahead.js";
import type { PlanWeek } from "./plan-week.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

type DayWork = { lift: { done: boolean } | null; run: { done: boolean } | null };

/** Work still open on the day: neither a rest day nor one whose lift and run are both in. */
function stillOpen(day: DayWork): boolean {
  if (!day.lift && !day.run) return false;
  return !(day.lift ? day.lift.done : true) || !(day.run ? day.run.done : true);
}

export function trainWeekNextDate(week: PlanWeek | null, ahead: PlanLookAhead | null, today: string): string | null {
  const candidates: { date: string; work: DayWork }[] = [];
  const seen = new Set<string>();
  for (const day of Array.isArray(week?.days) ? week.days : []) {
    const date = String(day?.date || "");
    if (!ISO.test(date) || date < today) continue;
    seen.add(date);
    const plan = day.plan_day && day.plan_day.role === "strength" ? day.plan_day : null;
    const name = text(day.session?.title) || text(plan?.name);
    candidates.push({
      date,
      work: {
        lift:
          name && (day.session || plan)
            ? { done: day.session?.finished === true || (day.status === "done" && !!day.session) }
            : null,
        run: day.run && !day.run.rested ? { done: day.run.status === "completed" } : null,
      },
    });
  }
  const aheadDays =
    ahead?.mode === "calendar" && Array.isArray(ahead.weeks)
      ? ahead.weeks.flatMap((w) => (Array.isArray(w?.days) ? w.days : []))
      : [];
  for (const day of aheadDays) {
    const date = String(day?.date || "");
    if (!ISO.test(date) || date < today || seen.has(date)) continue;
    candidates.push({
      date,
      work: {
        lift: day.lift && text(day.lift.title) ? { done: day.lift.done === true } : null,
        run: day.run ? { done: day.run.done === true } : null,
      },
    });
  }
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return candidates.find((c) => stillOpen(c.work))?.date ?? null;
}

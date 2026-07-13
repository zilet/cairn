// @ts-check
// Progress Calendar month-grid presentation helpers.

type CalendarCell = {
  date?: unknown;
  level?: unknown;
  sets?: unknown;
  tonnage?: unknown;
  activity?: unknown;
};

function calDaysAgoIso(todayIso: string, daysAgo: number): string {
  const [year, month, day] = todayIso.split("-").map(Number);
  const d = new Date(year, month - 1, day - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Same "has data" definition the day cells below already use (sets logged or
// an activity note) — a rolling 7-day window, not the Monday-anchored
// week_done used elsewhere, since this reads as calendar continuity.
function calTrainedDaysInLast7(byDate: Map<string, CalendarCell>, todayIso: string): number {
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const cell = byDate.get(calDaysAgoIso(todayIso, i));
    if (cell && (cell.sets || cell.activity)) count++;
  }
  return count;
}

// Honest continuity, not a streak: a factual count, never rendered at zero —
// an empty week reads as guilt, not information.
function calConsistencyLineHtml(trainedDays7: number): string {
  if (!(trainedDays7 > 0)) return "";
  return `<p class="cal-consistency">Trained ${trainedDays7} of the last 7 days.</p>`;
}

function calMonthHtml(ym: string, byDate: Map<string, CalendarCell>, todayIso: string, idx: number): string {
  const [year, month] = ym.split("-").map(Number);
  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysIn = new Date(year, month, 0).getDate();
  const monthName = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const dows = ["S", "M", "T", "W", "T", "F", "S"];
  let cellsHtml = "";
  for (let i = 0; i < firstDow; i++) cellsHtml += `<span class="cal-day cal-pad"></span>`;
  for (let day = 1; day <= daysIn; day++) {
    const iso = `${ym}-${String(day).padStart(2, "0")}`;
    const cell = byDate.get(iso);
    const future = iso > todayIso;
    const level = !future && cell ? cell.level || 0 : null;
    const hasData = !future && cell && (cell.sets || cell.activity);
    const isToday = iso === todayIso;
    const title =
      cell && !future
        ? `${iso} · ${Number(cell.sets) || 0} sets · ${(Number(cell.tonnage) || 0).toLocaleString()} lb${cell.activity ? " · activity" : ""}`
        : iso;
    cellsHtml += `<span class="cal-day${level != null ? ` cl${level}` : " cal-out"}${isToday ? " cal-today" : ""}${hasData ? " cal-has" : ""}"${hasData ? ` data-goto="${iso}"` : ""} title="${escAttr(title)}">${day}</span>`;
  }
  // Only the newest (first-rendered) month grid carries the consistency line —
  // it reads as one line above the calendar, not per month.
  const consistency = idx === 1 ? calConsistencyLineHtml(calTrainedDaysInLast7(byDate, todayIso)) : "";
  return `${consistency}<div class="cal-month reveal" style="${stagger(idx)}">
      <div class="cal-name">${escHtml(monthName)}</div>
      <div class="cal-dows">${dows.map((label) => `<span class="lbl">${label}</span>`).join("")}</div>
      <div class="cal-grid">${cellsHtml}</div>
    </div>`;
}

const CAIRN_PROGRESS_CALENDAR = {
  calMonthHtml,
  calConsistencyLineHtml,
  calTrainedDaysInLast7,
};

Object.assign(globalThis, {
  CairnProgressCalendar: CAIRN_PROGRESS_CALENDAR,
  calMonthHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressCalendar: CAIRN_PROGRESS_CALENDAR,
    calMonthHtml,
  });
}

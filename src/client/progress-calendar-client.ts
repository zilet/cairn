// @ts-check
// Progress Calendar month-grid presentation helpers.

type CalendarCell = {
  date?: unknown;
  level?: unknown;
  sets?: unknown;
  tonnage?: unknown;
  activity?: unknown;
};

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
  return `<div class="cal-month reveal" style="${stagger(idx)}">
      <div class="cal-name">${escHtml(monthName)}</div>
      <div class="cal-dows">${dows.map((label) => `<span class="lbl">${label}</span>`).join("")}</div>
      <div class="cal-grid">${cellsHtml}</div>
    </div>`;
}

const CAIRN_PROGRESS_CALENDAR = {
  calMonthHtml,
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

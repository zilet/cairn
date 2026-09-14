// @ts-check
// Pure Today week-ahead rail rendering helpers.

type TodayWeekAheadDay = import("../contracts/client.js").ClientWeekAheadDay;
type TodayWeekAheadDayKind = import("../contracts/client.js").ClientWeekAheadDayKind;
type TodayWeekAheadResponse = import("../contracts/client.js").ClientWeekAheadResponse;

(() => {
  const TODAY_WEEK_AHEAD_GLYPH: Record<TodayWeekAheadDayKind, string> = {
    lift: "◆",
    run: "➜",
    mixed: "✦",
    rest: "○",
  };

  function todayWeekAheadRecord(value: unknown): Partial<TodayWeekAheadResponse> & Record<string, unknown> {
    return value && typeof value === "object" ? value as Partial<TodayWeekAheadResponse> & Record<string, unknown> : {};
  }

  function todayWeekAheadKind(value: unknown): TodayWeekAheadDayKind {
    const kind = typeof value === "string" ? value : "";
    return Object.hasOwn(TODAY_WEEK_AHEAD_GLYPH, kind) ? kind as TodayWeekAheadDayKind : "lift";
  }

  function todayWeekAheadDays(value: unknown): TodayWeekAheadDay[] {
    const read = todayWeekAheadRecord(value);
    return read.ok === true && Array.isArray(read.days) ? read.days as TodayWeekAheadDay[] : [];
  }

  function todayWeekAheadRowHtml(value: unknown): string {
    const day = todayWeekAheadRecord(value);
    const kind = todayWeekAheadKind(day.kind);
    const label = day.label == null ? "" : String(day.label);
    return `<div class="wa-row wa-${escAttr(kind)}">
        <span class="wa-glyph" aria-hidden="true">${TODAY_WEEK_AHEAD_GLYPH[kind]}</span>
        ${day.day ? `<span class="wa-day lbl">${escHtml(day.day)}</span>` : ""}
        <span class="wa-label">${escHtml(label)}</span>
        ${day.note ? `<span class="wa-note">${escHtml(day.note)}</span>` : ""}
      </div>`;
  }

  function todayWeekAheadSummary(value: unknown): string {
    const read = todayWeekAheadRecord(value);
    return read.ok === true && typeof read.summary === "string" ? read.summary : "";
  }

  // Context, not a countdown: one quiet line naming the dated race, with the
  // race date tucked into a title/secondary span rather than spoken aloud.
  function todayWeekAheadRaceHtml(value: unknown): string {
    const read = todayWeekAheadRecord(value);
    const race = read.ok === true ? (read as { race?: unknown }).race : null;
    if (!race || typeof race !== "object") return "";
    const text = typeof (race as { text?: unknown }).text === "string" ? (race as { text: string }).text : "";
    if (!text) return "";
    const date = typeof (race as { date?: unknown }).date === "string" ? (race as { date: string }).date : "";
    return `<div class="weekahead-race"${date ? ` title="${escAttr(date)}"` : ""}><span>${escHtml(text)}</span></div>`;
  }

  function todayWeekAheadCardHtml(value: unknown): string {
    const days = todayWeekAheadDays(value);
    const raceHtml = todayWeekAheadRaceHtml(value);
    if (!days.length && !raceHtml) return "";
    const rows = days.map(todayWeekAheadRowHtml).join("");
    const summary = todayWeekAheadSummary(value);
    return `<div class="weekahead reveal" style="--i:0">
      <div class="weekahead-h"><span class="lbl">The week ahead</span></div>
      ${raceHtml}
      ${rows ? `<div class="weekahead-days">${rows}</div>` : ""}
      ${summary ? `<div class="weekahead-sum">${escHtml(summary)}</div>` : ""}
    </div>`;
  }

  const CAIRN_TODAY_WEEK_AHEAD = {
    WEEK_AHEAD_GLYPH: TODAY_WEEK_AHEAD_GLYPH,
    kind: todayWeekAheadKind,
    days: todayWeekAheadDays,
    rowHtml: todayWeekAheadRowHtml,
    cardHtml: todayWeekAheadCardHtml,
  };

  Object.assign(globalThis, { CairnTodayWeekAhead: CAIRN_TODAY_WEEK_AHEAD });

  if (typeof window !== "undefined") {
    window.CairnTodayWeekAhead = CAIRN_TODAY_WEEK_AHEAD;
  }
})();

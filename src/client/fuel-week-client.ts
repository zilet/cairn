// @ts-check
// The week's fuel, the strip under Train › Intake's energy meter (repo/fuel-week.ts over
// GET /api/nutrition/day `fuel_week`, shaped by CairnFuelTodayModel). Seven columns, one
// per day of the Monday-to-Sunday week the day's number belongs to: a bar drawn from ONE
// quiet average line, up for a day given more, down for a day given less, to one scale
// (never a number on the bar); days already lived solid, days ahead an outline; today
// ringed in dawn; the day's work as one small word beneath (Long, Lift, Rest). A logged
// amount on a complete lived day is a small neutral tick across its column — a fact
// beside the number, never a verdict: no red or green, no over or under, no percentage.
// One line of the server's words above says what the strip is; a tap on a column says
// that day's number and its sentence in place (the controller patches the detail and the
// pressed state, so focus stays on the column). Pure renderers; every string escaped.
{
  type Week = ClientFuelWeekModel;
  type Day = ClientFuelWeekDayModel;

  /** The selected day, else today, else the first day: always one of the seven. */
  function pick(week: Week, selected?: string | null): Day {
    return week.days.find((d) => d.date === selected) || week.days.find((d) => d.date === week.today) || week.days[0];
  }

  function barHtml(day: Day): string {
    const h = Math.abs(day.bar);
    // A day at the average is a short mark on the line, so its column is never empty.
    const side = h < 0.005 ? "is-flat" : day.bar > 0 ? "is-up" : "is-down";
    const tick = day.tick == null ? "" : `<i class="fuel-week-tick" style="--t:${day.tick.toFixed(3)}"></i>`;
    return `<span class="fuel-week-plot" aria-hidden="true"><i class="fuel-week-bar ${side}" style="--h:${h.toFixed(3)}"></i>${tick}</span>`;
  }

  function dayHtml(day: Day, selected: Day): string {
    const cls = ["fuel-week-day", `is-${day.when}`].join(" ");
    return `<button type="button" class="${cls}" data-fuel-week-day="${escAttr(day.date)}" aria-pressed="${day.date === selected.date}" aria-label="${escAttr(day.label)}">${barHtml(day)}<span class="fuel-week-dow" aria-hidden="true">${escHtml(day.weekday)}</span><span class="fuel-week-tag" aria-hidden="true">${escHtml(day.tag)}</span></button>`;
  }

  /** The selected day's number and its sentence; what was logged on a complete lived day. */
  function detailHtml(week: Week, selected?: string | null): string {
    const day = pick(week, selected);
    const when = day.when === "today" ? "Today" : day.name;
    const logged = day.logged ? `<p class="fuel-week-logged">${escHtml(day.logged)}</p>` : "";
    return `<p class="fuel-week-pick"><span class="fuel-week-pick-k">${escHtml(when)}</span> <b class="numeral">${escHtml(day.kcal.toLocaleString("en-US"))}</b> <span class="fuel-week-unit">kcal</span></p><p class="fuel-week-say">${escHtml(day.words)}</p>${logged}`;
  }

  /** The whole strip. `enter` marks the one short entrance (a cold first paint only). */
  function weekHtml(week: Week, opts: { selected?: string | null; enter?: boolean } = {}): string {
    const selected = pick(week, opts.selected);
    const days = week.days.map((d) => dayHtml(d, selected)).join("");
    const sum = week.sumWords ? `<span class="sr-only">${escHtml(week.sumWords)}</span>` : "";
    const lead = week.words ? `<p class="fuel-week-words">${escHtml(week.words)}${sum ? ` ${sum}` : ""}</p>` : "";
    return `<div class="fuel-week${opts.enter ? " is-entering" : ""}" data-fuel-week>
      ${lead}
      <div class="fuel-week-strip" role="group" aria-label="This week's numbers, day by day"><i class="fuel-week-avg" aria-hidden="true"></i>${days}</div>
      <div class="fuel-week-detail" data-fuel-week-detail aria-live="polite">${detailHtml(week, selected.date)}</div>
    </div>`;
  }

  const CAIRN_FUEL_WEEK = { weekHtml, detailHtml };

  Object.assign(globalThis, { CairnFuelWeek: CAIRN_FUEL_WEEK });
}

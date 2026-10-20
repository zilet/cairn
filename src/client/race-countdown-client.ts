// @ts-check
// The race countdown, the view: today to race day, a row a day under each week's own
// heading (its stage word and focus, how the lifting fits). A row names the date and how
// many days out, then what the day holds — the run (distance and pace band, a quality
// session's parts on one line), the lift (with "legs lighter" when the race build trims
// the legs), travel, and a quiet "Adapted" line when the coach changed the day. Each row
// opens its day page (`data-open-day`, day-open-client.ts), where the change's Undo
// lives; on the race view a day to come also offers "What if I move this?" beside it. Race day is its own row: the event, the distance, the target and the race-pace
// band. Pure strings over the model; every caller string goes through escHtml/escAttr.
{
  type Model = ClientRaceCountdownModel;
  type Row = ClientRaceCountdownRow;

  function runHtml(row: Row): string {
    const run = row.run;
    if (!run) return "";
    const fig = run.figure ? ` <span class="race-cd-fig numeral">${escHtml(run.figure)}</span>` : "";
    const done = run.done ? ` <span class="race-cd-mark is-done">done</span>` : "";
    const parts = run.structure ? `<p class="race-cd-parts">${escHtml(run.structure)}</p>` : "";
    return `<p class="race-cd-line race-cd-run is-${escAttr(run.kind)}"><span class="race-cd-what">${escHtml(run.title)}</span>${fig}${done}</p>${parts}`;
  }

  function liftHtml(row: Row): string {
    const lift = row.lift;
    if (!lift) return "";
    const marks = lift.marks
      .map((mark) => `<span class="race-cd-mark${mark === "done" ? " is-done" : " is-lighter"}">${escHtml(mark)}</span>`)
      .join(" ");
    return `<p class="race-cd-line race-cd-lift${lift.heavy ? " is-heavy" : ""}"><span class="race-cd-what">${escHtml(lift.name)}</span>${marks ? ` ${marks}` : ""}</p>`;
  }

  function adaptedHtml(row: { adapted: string[] }): string {
    if (!row.adapted.length) return "";
    return row.adapted
      .map(
        (title) =>
          `<p class="race-cd-line race-cd-adapted"><span class="race-cd-mark is-adapted">Adapted</span> ${escHtml(title)}</p>`
      )
      .join("");
  }

  function raceBodyHtml(model: Model): string {
    const race = model.race;
    const facts = [race.distance, race.target ? `Target ${race.target}` : "", race.pace ? `Race pace ${race.pace}` : ""]
      .filter(Boolean)
      .map((fact) => `<span class="race-cd-fact">${escHtml(fact)}</span>`)
      .join("");
    return `<p class="race-cd-line race-cd-race-name"><span class="race-cd-what">${escHtml(race.event || "Race day")}</span></p>
      ${facts ? `<p class="race-cd-facts numeral">${facts}</p>` : ""}`;
  }

  type Opts = { whatIf?: boolean };

  /**
   * "What if I move this?" on a day still to come that holds a run or a lift: it opens Ask
   * with the question started (`data-race-whatif`, the race view's controller). Race,
   * rest and done days hold none.
   */
  function whatIfHtml(row: Row): string {
    if (row.race || row.rest || row.done) return "";
    const what = row.run?.title || row.lift?.name || "";
    if (!what || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return "";
    const day = CairnFmt.date(row.date, { fmt: { weekday: "long" }, utc: true });
    return `<button class="linkbtn-quiet race-cd-whatif" type="button" data-race-whatif="${escAttr(`What if I move ${day} ${what} to …?`)}" aria-label="${escAttr(`What if I move ${day} ${what}?`)}">What if I move this?</button>`;
  }

  function rowHtml(row: Row, model: Model, opts: Opts = {}): string {
    const cls = ["race-cd-day"];
    if (row.today) cls.push("is-today");
    if (row.race) cls.push("is-race");
    if (row.done) cls.push("is-done");
    if (row.rest) cls.push("is-rest");
    if (row.adapted.length) cls.push("is-adapted");
    const body = row.race
      ? `${raceBodyHtml(model)}${adaptedHtml(row)}`
      : `${runHtml(row)}${liftHtml(row)}${row.rest ? `<p class="race-cd-line race-cd-rest">Rest</p>` : ""}${adaptedHtml(row)}`;
    const travel = row.travel ? `<p class="race-cd-line race-cd-travel">${escHtml(row.travel)}</p>` : "";
    const label = [row.when, row.out].filter(Boolean).join(", ");
    // The name is "Open <day>" followed by the row's own words (aria-labelledby), so an
    // aria-label never replaces what the row says. The link target is the row's own
    // block; the what-if button is its SIBLING, never a control inside a link.
    const lid = `raceCdRow-${escAttr(row.date)}`;
    return `<li class="${cls.join(" ")}" data-race-cd-day="${escAttr(row.date)}"${row.today ? ` aria-current="date"` : ""}>
      <div class="race-cd-open" data-open-day="${escAttr(row.date)}" role="link" tabindex="0" aria-labelledby="${lid}-o ${lid}-b">
        <span class="sr-only" id="${lid}-o">${escHtml(`Open ${label}.`)}</span>
        <div class="race-cd-when"><span class="race-cd-date">${escHtml(row.when)}</span><span class="race-cd-out">${escHtml(row.out)}</span></div>
        <div class="race-cd-body" id="${lid}-b">${body}${travel}</div>
      </div>${opts.whatIf ? whatIfHtml(row) : ""}
    </li>`;
  }

  function weekHtml(week: ClientRaceCountdownWeek, index: number, model: Model, opts: Opts): string {
    const id = `raceCdWeek-${index}`;
    return `<section class="race-cd-week" aria-labelledby="${id}">
      <header class="race-cd-week-head">
        <h3 class="race-cd-week-title" id="${id}">${escHtml(week.title)}</h3>
        ${week.focus ? `<p class="race-cd-week-focus">${escHtml(week.focus)}</p>` : ""}
        ${week.lifting ? `<p class="race-cd-week-lift">${escHtml(week.lifting)}</p>` : ""}${adaptedHtml(week)}
      </header>
      <ol class="race-cd-days">${week.rows.map((row) => rowHtml(row, model, opts)).join("")}</ol>
    </section>`;
  }

  /** The whole countdown; "" with no model (the slot then stays empty). `whatIf`: each day to come offers it. */
  function countdownHtml(model: Model | null, opts: Opts = {}): string {
    if (!model || !model.weeks.length) return "";
    return `<section class="race-section race-countdown" aria-label="Day by day to the race">
      <span class="lbl">Day by day</span>
      ${model.weeks.map((week, i) => weekHtml(week, i, model, opts)).join("")}
    </section>`;
  }

  /** The slot before its read lands: the shape of a few rows, nothing said. */
  function skeletonHtml(): string {
    const rows = Array.from({ length: 3 }, () => `<div class="hshimmer race-cd-skel-row"></div>`).join("");
    return `<div class="race-countdown race-cd-skel" aria-busy="true" aria-label="Day by day to the race">${rows}</div>`;
  }

  const CAIRN_RACE_COUNTDOWN = { countdownHtml, skeletonHtml, rowHtml };

  Object.assign(globalThis, { CairnRaceCountdown: CAIRN_RACE_COUNTDOWN });
}

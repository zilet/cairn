// @ts-check
// Today · so far, the card Train › Intake opens on (docs/V2-PLAN.md wave 2,
// "fuel-today"). The view: protein then energy as slim meters with the logged amount
// beside the day's number, carbs · fat · fiber (and saturated fat) as guide rows when the
// read carries the day's guides, else as plain numbers, each with its unit and never a
// score; the day's state in words ("in progress" — never "low"); the athlete's own
// observed intake band in the server's words when there is one; and, today only, the
// quiet big-day and carb-range lines. Pure renderers over CairnFuelTodayModel.
{
  type Model = ClientFuelTodayModel;

  // ---------- the big-day fuel line ----------
  // When the server's read (repo/fuel-demand.ts) says today carries the week's bigger
  // work, the card says ONE quiet sentence about shape. BIG DAYS ONLY, and only the day
  // read itself (the model drops a read dated another day). The day's NUMBER and why it
  // moved is a separate sentence, the server's (`dayNumberHtml`). Rotates per date.
  const DEMAND_LONG_RUN = [
    "Today carries the long run, so carbs earn their place around it.",
    "The long run is today's big piece; carb-forward around it tends to sit well.",
    "Long run today, a good day for carbs to lead.",
    "Today's long run is the work that asks for fuel; carbs around it.",
  ];
  const DEMAND_QUALITY_RUN = [
    "There's quality running in today; carbs around it tend to make it feel better.",
    "Today's fast work asks a little more of fuel; carb-forward around it.",
    "Quality run today, a good day for carbs to lead.",
    "Hard running lands today; carbs around it is the natural shape.",
  ];
  const DEMAND_HEAVY_LOWER = [
    "Heavy lower work today; carbs around it are the easy win.",
    "Today leans heavy through the legs; carb-forward around the session.",
    "Legs carry today's load, a good day for carbs to lead.",
    "Today's the heavier leg day; carbs around it.",
  ];
  const DEMAND_DOUBLE = [
    "Lifting and running both land today; carbs around them.",
    "Today's a double; carb-forward around both pieces.",
    "Two sessions share today, a good day for carbs to lead.",
    "Strength and a run in one day; carbs around the work.",
  ];
  const DEMAND_GENERIC = [
    "Today carries more work than an ordinary day, a good day for carbs to lead.",
    "Bigger day than usual; carb-forward around the work.",
    "There's real work in today; carbs around it.",
    "Today asks a bit more of fuel; carbs toward the work.",
  ];

  function demandVariants(drivers: string[]): string[] {
    const has = (needle: string) => drivers.some((driver) => driver.includes(needle));
    if (has("long run")) return DEMAND_LONG_RUN;
    if (has("quality run")) return DEMAND_QUALITY_RUN;
    if (has("heavy lower")) return DEMAND_HEAVY_LOWER;
    if (has("same day")) return DEMAND_DOUBLE;
    return DEMAND_GENERIC;
  }

  function demandHtml(m: Model): string {
    const demand = m.demand;
    if (!demand || demand.demand !== "big") return "";
    const date = String(demand.date || m.date);
    if (date !== m.date) return "";
    const drivers = Array.isArray(demand.drivers) ? demand.drivers.map(String) : [];
    const line = pickDayVariant(demandVariants(drivers), date, "dayfuel-demand");
    return `<p class="fuel-today-line fuel-today-demand">${escHtml(line)}</p>`;
  }

  // The day's carb guide on a day with nothing logged yet: the guide and its basis in one
  // calm line, never set against a log there is not.
  function carbsHtml(m: Model): string {
    const carbs = m.guides?.rows.find((row) => row.key === "carbs");
    return carbs?.text ? `<p class="fuel-today-line fuel-today-carbs">Carbs ${escHtml([carbs.text, carbs.note].filter(Boolean).join(" · "))}</p>` : "";
  }

  // ---------- the numbers ----------
  function grouped(n: number): string {
    return n.toLocaleString("en-US");
  }

  function numeralHtml(value: number, countUp: boolean): string {
    const cu = countUp ? ` data-cu="${value}"` : "";
    return `<b class="numeral"${cu}>${escHtml(grouped(value))}</b>`;
  }

  // Not estimated yet — never a zero standing in for it.
  const UNKNOWN_HTML = `<span class="fuel-today-value is-unknown"><span aria-hidden="true">—</span><span class="sr-only">not estimated yet</span></span>`;

  // One slim meter: the logged amount beside the day's number, the bar a picture of the
  // two in the fuel stone's own hue. Never a score (no percentage is printed) and never a
  // tone: a short bar is a day in progress. The text is the meter's equivalent; the bar
  // itself is hidden from assistive tech. No number to set it against draws no bar.
  function meterHtml(label: string, value: number | null, of: number | null, unit: string, countUp: boolean): string {
    if (value == null) {
      return `<div class="fuel-today-m"><dt class="fuel-today-k">${escHtml(label)}</dt><dd class="fuel-today-v">${UNKNOWN_HTML}</dd></div>`;
    }
    const share = of ? Math.max(0, Math.min(1, value / of)) : 0;
    const bar = of ? `<dd class="fuel-today-bar" aria-hidden="true"><span class="fuel-today-fill" style="--p:${share.toFixed(3)}"></span></dd>` : "";
    const ofHtml = of ? ` <span class="fuel-today-of">/ ${escHtml(grouped(of))}</span>` : "";
    const spoken = of ? `${grouped(value)} ${unit} logged of the day's ${grouped(of)} ${unit}` : `${grouped(value)} ${unit} logged`;
    return `<div class="fuel-today-m">
        <dt class="fuel-today-k">${escHtml(label)}</dt>
        ${bar}
        <dd class="fuel-today-v"><span class="fuel-today-value" aria-hidden="true">${numeralHtml(value, countUp)}${ofHtml} <span class="fuel-today-unit">${escHtml(unit)}</span></span><span class="sr-only">${escHtml(spoken)}</span></dd>
      </div>`;
  }

  // ---------- the day's food guides ----------
  // Under the meters, carbs · fat · fiber (and saturated fat when its eaten side is known
  // or a lab finding leads it) one row each: the eaten grams, then the guide in words
  // ("63 g · around 230–250 g today"), a thin neutral track (the guide a band, the eaten
  // amount a mark; hidden from assistive tech, the text is its equivalent), and one quiet
  // note: what is left to place while the day is eaten, then where the guide comes from.
  // No percentage, no tone, no "low". An older read with no guides keeps the bare numbers.
  // The weekly lines (omega-3) sit below as quiet sentences.
  function guideRowHtml(row: ClientFuelGuideRow, countUp: boolean): string {
    const value =
      row.eaten == null
        ? UNKNOWN_HTML
        : `<span class="fuel-today-value">${numeralHtml(row.eaten, countUp)} <span class="fuel-today-unit">g</span></span>`;
    const text = row.text ? `<span class="fuel-today-dot" aria-hidden="true"> · </span>${escHtml(row.text)}` : "";
    const t = row.track;
    const mark = t?.mark == null ? "" : `<i class="fuel-guide-mark" style="--m:${t.mark.toFixed(3)}"></i>`;
    const track = t
      ? `<dd class="fuel-guide-track" aria-hidden="true"><i class="fuel-guide-band" style="--lo:${t.lo.toFixed(3)};--hi:${t.hi.toFixed(3)}"></i>${mark}</dd>`
      : "";
    const note = row.note ? `<dd class="fuel-guide-note">${escHtml(row.note)}</dd>` : "";
    const why = row.why ? `<dd>${whyHtml("Why", [row.why])}</dd>` : "";
    return `<div class="fuel-guide" data-guide="${escAttr(row.key)}"><dt class="fuel-today-k">${escHtml(row.label)}</dt><dd class="fuel-guide-v">${value}${text}</dd>${track}${note}${why}</div>`;
  }

  // "Why": a native disclosure under a number. What the number is made of (in the
  // athlete's own weight), what the nutrient does for the goal in force, and the published
  // basis by name. The server finished every word (repo/fuel-guide-why.ts).
  type Why = { label?: string; from?: string; made_of: string; effect: string; source: string };
  function whyHtml(summary: string, items: Why[]): string {
    const body = items
      .map((w) => {
        const label = w.label ? `<p class="fuel-why-k">${escHtml(w.label)}</p>` : "";
        const source = w.source ? `<p class="fuel-why-src">${escHtml(w.source)}</p>` : "";
        const from = w.from ? `<p class="fuel-why-from">${escHtml(w.from)}</p>` : "";
        return `${label}${from}<p>${escHtml(w.made_of)}</p><p>${escHtml(w.effect)}</p>${source}`;
      })
      .join("");
    return `<details class="fuel-why"><summary>${escHtml(summary)}</summary><div class="fuel-why-body">${body}</div></details>`;
  }

  // What is left of the day's number, said roundly: the dinner budget. Never a shortfall
  // and never a verdict; past the number it says so in the same plain way.
  const ABOUT_AT_KCAL = 50;
  function leftHtml(m: Model): string {
    const left = m.energy.left;
    if (left == null) return "";
    const words =
      left > ABOUT_AT_KCAL
        ? `About ${grouped(left)} kcal left for today.`
        : left >= -ABOUT_AT_KCAL
          ? "About at today's number."
          : `About ${grouped(-left)} kcal past today's number.`;
    return `<p class="fuel-today-left">${escHtml(words)}</p>`;
  }

  // The day's number and why it differs from the weekly average, in the server's words.
  function dayNumberHtml(m: Model): string {
    return m.energy.dayWords ? `<p class="fuel-today-line fuel-today-daynum">${escHtml(m.energy.dayWords)}</p>` : "";
  }

  function explainHtml(m: Model): string {
    const items = m.guides?.explain || [];
    return items.length ? whyHtml("Why these two numbers", items) : "";
  }

  // The last two weeks: where the complete days landed against each day's own guides, and
  // the one lever with its reason. Information, never a tally of misses; absent when the
  // complete days are too few to read.
  function patternHtml(m: Model): string {
    const p = m.guides?.pattern;
    if (!p) return "";
    const said = (x: { words: string; why: string } | null | undefined) =>
      x ? `<p class="fuel-pattern-lever">${escHtml(x.words)}</p><p class="fuel-pattern-why">${escHtml(x.why)}</p>` : "";
    const lines = p.lines.map((l) => `<li>${escHtml(l.words)}</li>`).join("");
    const caveat = p.caveat ? `<p class="fuel-pattern-caveat">${escHtml(p.caveat)}</p>` : "";
    return `<div class="fuel-pattern"><h3 class="lbl fuel-pattern-title">${escHtml(p.title)}</h3>${said(p.lever)}${said(p.also)}<ul class="fuel-pattern-lines">${lines}</ul>${caveat}</div>`;
  }

  function guidesHtml(m: Model, countUp = false): string {
    const g = m.guides;
    if (!g) return "";
    const rows = g.rows.length ? `<dl class="fuel-guides">${g.rows.map((row) => guideRowHtml(row, countUp)).join("")}</dl>` : "";
    return rows + g.weekly.map((line) => `<p class="fuel-today-line fuel-guide-week">${escHtml(line)}</p>`).join("");
  }

  function stateHtml(m: Model): string {
    if (m.state === "in progress") return `<span class="fuel-today-state">In progress</span>`;
    return "";
  }

  function headHtml(m: Model): string {
    return `<div class="fuel-today-head"><h2 class="lbl fuel-today-title" id="fuelTodayTitle">Today · so far</h2>${stateHtml(m)}</div>`;
  }

  const EMPTY_LINE = "Nothing logged yet today. Log a meal and it lands here, with the numbers worked out for you.";

  /**
   * The whole card. Protein then energy as slim meters (logged / the day's number),
   * carbs · fat · fiber as guide rows. A day with nothing on it draws no meter at
   * all — absent, never low. `countUp` marks the numerals for the cold-paint count-up.
   */
  function todayHtml(m: Model, opts: { countUp?: boolean } = {}): string {
    const countUp = !!opts.countUp;
    if (!m.count) {
      return `<section class="fuel-today reveal" style="--i:0" aria-labelledby="fuelTodayTitle">
        ${headHtml(m)}
        <p class="fuel-today-empty">${escHtml(EMPTY_LINE)}</p>
        ${leftHtml(m)}${dayNumberHtml(m)}${demandHtml(m)}${carbsHtml(m)}${patternHtml(m)}
      </section>`;
    }
    const pending =
      m.pending > 0
        ? `<p class="fuel-today-line fuel-today-pending" role="status">${m.pending === 1 ? "One meal is" : `${m.pending} meals are`} still being estimated; the numbers fill in when ${m.pending === 1 ? "it settles" : "they settle"}.</p>`
        : "";
    const toGo =
      m.protein.toGo != null
        ? `<p class="fuel-today-togo"><span class="numeral">${m.protein.toGo}</span> g protein to go</p>`
        : m.protein.aboutThere
          ? `<p class="fuel-today-togo">About there</p>`
          : "";
    const band = m.bandWords ? `<p class="fuel-today-line fuel-today-band">${escHtml(m.bandWords)}</p>` : "";
    // The carbs are said once, in their row: no separate carb sentence beside it.
    return `<section class="fuel-today reveal" style="--i:0" aria-labelledby="fuelTodayTitle">
      ${headHtml(m)}
      <dl class="fuel-today-meters">
        ${meterHtml("Protein", m.protein.value, m.protein.anchor, "g", countUp)}
        ${meterHtml("Energy", m.energy.value, m.energy.of, "kcal", countUp)}
      </dl>
      ${leftHtml(m)}${toGo}${dayNumberHtml(m)}${explainHtml(m)}${guidesHtml(m, countUp)}
      ${pending}${band}${demandHtml(m)}${patternHtml(m)}
    </section>`;
  }

  /** Cold start: the house shimmer in the card's shape, saying nothing. */
  function skeletonHtml(): string {
    return `<div class="skel-card fuel-today-skel" aria-hidden="true">
      <div class="hshimmer hshimmer-sm"></div><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div>
    </div>`;
  }

  function errorHtml(): string {
    return `<section class="fuel-today" role="status" aria-live="polite">
      <p class="fuel-today-empty">Today's food couldn't be read just now.</p>
      <button class="linkbtn linkbtn-quiet fuel-today-retry" type="button" data-fuel-today-retry>Try again</button>
    </section>`;
  }

  const CAIRN_FUEL_TODAY = {
    todayHtml,
    demandHtml,
    carbsHtml,
    guidesHtml,
    patternHtml,
    skeletonHtml,
    errorHtml,
  };

  Object.assign(globalThis, { CairnFuelToday: CAIRN_FUEL_TODAY });
}

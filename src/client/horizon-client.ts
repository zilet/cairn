// @ts-check
// The Horizon timeline, the view (docs/V2-PLAN.md wave 5): three views on one line of
// time — this week (day by day), the race build (a glance: its serif line, the terrain,
// this week in one row, the fit word; the race page holds the depth), and the season
// (the goal line, and labs and scans). Pure strings: the model carries every word, and
// each lane has its own loading shape. A lane's rows run behind → a "Today" mark →
// ahead, the same rail the road-ahead card draws. Each link carries a real href (so a
// long-press or a new tab works) and `data-horizon-go`, the key the controller resolves
// to a route. Distance per week (km or mi, the athlete's pick) and fit words only; no
// score.
{
  type Lane = ClientHorizonLane;
  type Row = ClientHorizonRow;

  const KEYS: ReadonlyArray<Lane["key"]> = ["race", "goal", "labs"];
  const TITLES: Readonly<Record<Lane["key"], string>> = { race: "Race", goal: "Goal line", labs: "Labs and scans" };

  type HrefFor = (target: ClientHorizonTarget) => string | null;

  function linkAttrs(key: string, target: ClientHorizonTarget | null, hrefFor?: HrefFor): string {
    if (!target) return "";
    const href = hrefFor?.(target) || "";
    return `${href ? ` href="${escAttr(href)}"` : ` href="#"`} data-horizon-go="${escAttr(key)}"`;
  }

  function rowHtml(lane: Lane, row: Row, index: number, hrefFor?: HrefFor): string {
    const cls = ["horizon-row", `is-${row.side}`, `is-kind-${row.kind.replace(/[^a-z0-9_-]/gi, "")}`].join(" ");
    const inner = `<span class="horizon-row-dot" aria-hidden="true"></span>
      <span class="horizon-row-main">
        ${row.when ? `<span class="horizon-row-when">${escHtml(row.when)}</span>` : ""}
        <span class="horizon-row-label">${escHtml(row.label)}</span>
        ${row.detail ? `<span class="horizon-row-detail">${escHtml(row.detail)}</span>` : ""}
      </span>`;
    if (!row.target) return `<li class="${cls}"><div class="horizon-row-body">${inner}</div></li>`;
    return `<li class="${cls}"><a class="horizon-row-body horizon-row-link"${linkAttrs(`${lane.key}:row:${index}`, row.target, hrefFor)}>${inner}<span class="horizon-row-arw" aria-hidden="true">›</span></a></li>`;
  }

  /** The rail: behind rows, the "Today" mark, then ahead rows. "" with no rows. */
  function railHtml(lane: Lane, hrefFor?: HrefFor): string {
    if (!lane.rows.length) return "";
    const behind = lane.rows.map((row, i) => ({ row, i })).filter(({ row }) => row.side === "behind");
    const ahead = lane.rows.map((row, i) => ({ row, i })).filter(({ row }) => row.side === "ahead");
    const now = `<li class="horizon-now"><span class="horizon-row-dot horizon-now-dot" aria-hidden="true"></span><span class="horizon-now-label">Today</span></li>`;
    // The "Today" mark divides behind from ahead; with nothing behind it would only
    // repeat the lane's own start, so it stands only between the two.
    const items = [
      ...behind.map(({ row, i }) => rowHtml(lane, row, i, hrefFor)),
      behind.length ? now : "",
      ...ahead.map(({ row, i }) => rowHtml(lane, row, i, hrefFor)),
    ].join("");
    return `<ol class="horizon-rail" aria-label="${escAttr(`${lane.title}, behind and ahead`)}">${items}</ol>`;
  }

  function fitHtml(lane: Lane): string {
    if (!lane.fit_word && !lane.fit_line) return "";
    const word = lane.fit
      ? `<span class="race-estimate-word is-${escAttr(lane.fit)}">${escHtml(lane.fit_word)}</span>`
      : "";
    const line = lane.fit_line ? `<span class="horizon-lane-fit-line">${escHtml(lane.fit_line)}</span>` : "";
    // Under the build it is a footnote: the finish estimate, named, after the weeks.
    const lead = lane.voice ? `<span class="lbl horizon-lane-fit-lbl">Finish estimate</span>` : "";
    return `<p class="horizon-lane-fit">${lead}${word}${line}</p>`;
  }

  function linksHtml(lane: Lane, hrefFor?: HrefFor): string {
    if (!lane.links.length) return "";
    const links = lane.links
      .map(
        (link, i) =>
          `<a class="linkbtn linkbtn-sm horizon-lane-link"${linkAttrs(`${lane.key}:link:${i}`, link.target, hrefFor)}>${escHtml(link.label)} ›</a>`
      )
      .join("");
    return `<div class="horizon-lane-links">${links}</div>`;
  }

  /** The race build as terrain, in its chart card with its key; "" when there is no ridge to draw. */
  function terrainHtml(lane: Lane): string {
    if (typeof CairnHorizonChart === "undefined" || !lane.terrain) return "";
    const chart = CairnHorizonChart.terrainSvg(lane.terrain);
    return chart
      ? `<figure class="horizon-chart-card is-terrain">${chart}${CairnHorizonChart.terrainKeyHtml(lane.terrain)}</figure>`
      : "";
  }

  /**
   * This week in one row: the stage, what the log holds of the week's volume on a quiet
   * bar, the long run, and the week's one coaching sentence. Taps through to the race
   * page, where the week is laid out in depth.
   */
  function thisWeekHtml(lane: Lane, hrefFor?: HrefFor): string {
    const week = lane.this_week;
    if (!week || (!week.done_text && !week.target_text && !week.focus)) return "";
    const kicker = ["This week", week.stage_word].filter(Boolean).join(" · ");
    const figure = typeof CairnRaceView !== "undefined" ? CairnRaceView.volumeFigureHtml(week, "horizon-tw") : "";
    const bar =
      week.frac != null
        ? `<span class="horizon-tw-track" aria-hidden="true"><span class="horizon-tw-fill${week.banked ? " is-banked" : ""}" style="--frac:${week.frac}"></span></span>`
        : "";
    const long = week.long_text ? `<span class="horizon-tw-long">${escHtml(week.long_text)}</span>` : "";
    const focus = week.focus ? `<span class="horizon-tw-focus">${escHtml(week.focus)}</span>` : "";
    const link = lane.links.findIndex((l) => l.target.tab === "plan");
    const inner = `<span class="lbl horizon-tw-kicker">${escHtml(kicker)}</span>
      <span class="horizon-tw-row">${figure}${long}</span>${bar}${focus}`;
    return link >= 0
      ? `<a class="horizon-tw is-link"${linkAttrs(`${lane.key}:link:${link}`, lane.links[link].target, hrefFor)}>${inner}</a>`
      : `<div class="horizon-tw">${inner}</div>`;
  }

  /** A runner's closed weeks as small columns: the rhythm, with no race to build to. */
  function volumeHtml(lane: Lane): string {
    const weeks = lane.volume || [];
    if (!weeks.length) return "";
    const cols = weeks
      .map(
        (w) => `<li class="horizon-vol-week${w.frac > 0 ? "" : " is-empty"}" style="--frac:${w.frac}">
          <span class="horizon-vol-bar" aria-hidden="true"></span>
          <span class="horizon-vol-km">${escHtml(w.km_text)}</span>
          <span class="horizon-vol-date">${escHtml(w.date_word)}</span>
        </li>`
      )
      .join("");
    return `<div class="horizon-vol"><span class="lbl">The last ${weeks.length} weeks</span><ol class="horizon-vol-weeks" aria-label="Running per week, the last ${weeks.length} weeks">${cols}</ol></div>`;
  }

  /** The km / mi switch: the athlete's run units, saved to settings from any surface. */
  function unitsHtml(units: "km" | "mi"): string {
    const btn = (value: "km" | "mi") =>
      `<button type="button" class="end-unit-btn${units === value ? " on" : ""}" data-horizon-units="${value}" aria-pressed="${units === value}">${value}</button>`;
    return `<div class="end-units horizon-units" role="group" aria-label="Distance and pace units">${btn("km")}${btn("mi")}</div>`;
  }

  /**
   * The goal line's chart slot: space held at the chart's own shape so the season line
   * lands without moving anything. The controller fills it (or drops it) once the
   * weigh-ins are read.
   */
  function seasonSlotHtml(lane: Lane): string {
    if (lane.key !== "goal" || lane.state !== "set") return "";
    return `<figure class="horizon-chart-card is-season is-pending" data-horizon-season aria-busy="true"><div class="hshimmer horizon-chart-skel"></div><div class="horizon-chart-key-skel"></div></figure>`;
  }

  /** The season line for the goal line's slot; "" when there is no line to draw. */
  function seasonHtml(season: ClientHorizonSeason | null): string {
    if (!season || typeof CairnHorizonChart === "undefined") return "";
    const chart = CairnHorizonChart.seasonSvg(season);
    if (!chart) return "";
    // The key names only what the chart drew: the window only beside a goal line, and
    // each diamond hue only when a mark of it is on the lane.
    const body = season.marks.filter((m) => CairnHorizonChart.BODY_MARK_KINDS.has(m.kind)).length;
    const keys = [
      `<span class="horizon-key is-weight">Weight</span>`,
      season.goal_lb != null ? `<span class="horizon-key is-goal">Goal</span>` : "",
      season.goal_lb != null && season.fan ? `<span class="horizon-key is-fan">Likely window</span>` : "",
      season.marks.length > body ? `<span class="horizon-key is-mark">Labs</span>` : "",
      body ? `<span class="horizon-key is-mark is-body">Body scans</span>` : "",
      season.race ? `<span class="horizon-key is-mark is-race">Race day</span>` : "",
    ].join("");
    return `${chart}<figcaption class="horizon-chart-key">${keys}</figcaption>`;
  }

  /** One lane, painted. `enter` gives it the shared settle-in entrance once. */
  function laneHtml(lane: Lane, opts: { enter?: boolean; hrefFor?: HrefFor } = {}): string {
    if (lane.state === "absent") return "";
    const id = `horizonLane-${lane.key}`;
    const cls = ["horizon-lane-card", `is-${lane.key}`, `is-${lane.state}`, opts.enter ? "settle-in is-entering" : ""]
      .filter(Boolean)
      .join(" ");
    const status = lane.state === "unread" ? ` role="status" aria-live="polite"` : "";
    if (lane.key === "race" && lane.state !== "unread") {
      // The race lane is a glance: the voice (or, with no race, a calm headline), the
      // terrain, this week, the estimate as a footnote, and the way into the depth.
      const title = lane.voice
        ? `<h2 class="horizon-lane-title is-voice" id="${id}">${escHtml(lane.voice)}</h2>`
        : `<h2 class="horizon-lane-title" id="${id}">${escHtml(lane.headline)}</h2>`;
      return `<section class="${cls}${lane.voice ? " is-build" : ""}" aria-labelledby="${id}">
        <header class="horizon-lane-head">
          <div class="horizon-lane-kickrow">
            <span class="lbl horizon-lane-kicker">${escHtml(lane.title)}</span>
            ${unitsHtml(lane.units === "mi" ? "mi" : "km")}
          </div>
          ${title}
          ${lane.lede ? `<p class="horizon-lane-lede">${escHtml(lane.lede)}</p>` : ""}
        </header>
        ${terrainHtml(lane)}
        ${thisWeekHtml(lane, opts.hrefFor)}
        ${volumeHtml(lane)}
        ${fitHtml(lane)}
        ${linksHtml(lane, opts.hrefFor)}
      </section>`;
    }
    // Goal line and labs: a headline, a rail, links (the race build takes the branch above).
    return `<section class="${cls}" aria-labelledby="${id}">
      <header class="horizon-lane-head">
        <span class="lbl horizon-lane-kicker">${escHtml(lane.title)}</span>
        <h2 class="horizon-lane-title" id="${id}"${status}>${escHtml(lane.headline)}</h2>
        ${lane.when ? `<p class="horizon-lane-when numeral">${escHtml(lane.when)}</p>` : ""}
      </header>
      ${fitHtml(lane)}
      ${lane.lede ? `<p class="horizon-lane-lede">${escHtml(lane.lede)}</p>` : ""}
      ${seasonSlotHtml(lane)}
      ${railHtml(lane, opts.hrefFor)}
      ${linksHtml(lane, opts.hrefFor)}
    </section>`;
  }

  /** A lane before its reads land: its name, and the shape of what comes, nothing said. */
  function laneSkeletonHtml(key: Lane["key"]): string {
    return `<section class="horizon-lane-card is-${key} is-loading" aria-busy="true" aria-label="${escAttr(TITLES[key])}">
      <span class="lbl horizon-lane-kicker">${escHtml(TITLES[key])}</span>
      <div class="hshimmer hshimmer-lg horizon-skel-title"></div>
      <div class="hshimmer horizon-skel-line"></div>
      <div class="hshimmer horizon-skel-line is-short"></div>
    </section>`;
  }

  function pillHtml(pill: ClientHorizonWeekPill): string {
    const tick = pill.state === "done" ? `<span class="horizon-pill-tick" aria-label="done">✓</span>` : "";
    const live = pill.state === "live" ? `<span class="horizon-pill-live" aria-hidden="true"></span>` : "";
    return `<span class="horizon-pill is-${pill.stone} is-${pill.state}">${live}${escHtml(pill.text)}${tick}</span>`;
  }

  /** This week, day by day: the server's week line, then a row a day, today washed. */
  function weekHtml(week: ClientHorizonWeek | null, opts: { enter?: boolean } = {}): string {
    if (!week) {
      return `<p class="horizon-week-empty" role="status">This week couldn't be read just now.</p>`;
    }
    if (!week.days.length) {
      return `<p class="horizon-week-empty">Nothing planned this week yet. A lifting plan in Train or run days in chat fill it in.</p>`;
    }
    const rows = week.days
      .map((day) => {
        // Today's lift is the server's one line, verbatim with its caveat (the Brief's
        // and the plan strip's own words), leading the day as a lift pill would.
        const line = day.line && typeof CairnUiReads !== "undefined" ? CairnUiReads.strengthLineHtml(day.line) : "";
        const pills = day.pills.length ? `<div class="horizon-pills">${day.pills.map(pillHtml).join("")}</div>` : "";
        // Today adapted to another plan day: said once, quietly, under the day.
        const swap = day.swappedFrom
          ? `<span class="horizon-day-swap">${escHtml(`In place of ${day.swappedFrom}`)}</span>`
          : "";
        const body =
          pills || line
            ? line || swap
              ? `<div class="horizon-day-body">${line}${pills}${swap}</div>`
              : pills
            : `<span class="horizon-rest">Rest</span>`;
        // Every dated day opens (v2 wave 7): today opens Today, another day its record
        // or its preview, through the day view's one delegated opener.
        const open = day.date
          ? ` data-open-day="${escAttr(day.date)}" role="link" tabindex="0"`
          : "";
        const state = day.today ? ", today" : day.done ? ", done" : day.rest ? ", rest" : "";
        const cls = `horizon-day${day.today ? " is-today" : ""}${day.date ? " is-open" : ""}${day.rest ? " is-rest" : ""}${day.done ? " is-done" : ""}`;
        const check = day.done ? `<span class="horizon-day-check" aria-hidden="true">✓</span>` : "";
        return `<li class="${cls}"${day.today ? ` aria-current="date"` : ""}${open}>
          <span class="horizon-day-when">${escHtml(day.weekday)}<b>${escHtml(day.day)}${check}</b></span>${body}${day.date ? `<span class="horizon-day-go"><span aria-hidden="true">›</span><span class="sr-only">${escHtml(state)}, open the day</span></span>` : ""}</li>`;
      })
      .join("");
    // The server's week line, its first sentence as the serif voice and the rest under it.
    const cut = week.line.search(/\.\s+/);
    const voice = cut > 0 ? week.line.slice(0, cut + 1) : week.line;
    const rest = cut > 0 ? week.line.slice(cut + 1).trim() : "";
    return `<div class="horizon-weekview${opts.enter ? " settle-in is-entering" : ""}">
      ${voice ? `<h2 class="horizon-lane-title is-voice horizon-week-voice">${escHtml(voice)}</h2>` : ""}
      ${rest ? `<p class="horizon-lane-lede horizon-week-line">${escHtml(rest)}</p>` : ""}
      <ol class="horizon-days" aria-label="This week, day by day">${rows}</ol>
    </div>`;
  }

  function weekSkeletonHtml(): string {
    const rows = Array.from({ length: 7 }, () => `<div class="hshimmer horizon-skel-day"></div>`).join("");
    return `<div class="horizon-weekview is-pending" aria-busy="true" aria-label="This week">
      <div class="hshimmer horizon-skel-line"></div>${rows}</div>`;
  }

  /** The three views over one line of time: this week, the race build, and the season. */
  const SEGMENTS: ReadonlyArray<readonly [ClientHorizonView, string]> = [
    ["week", "Week"],
    ["race", "To the race"],
    ["season", "Season"],
  ];
  /** Which view each lane sits in. The week view holds no lane: it is its own read. */
  const PANEL: Readonly<Record<Lane["key"], ClientHorizonView>> = { race: "race", goal: "season", labs: "season" };

  function segHtml(active: ClientHorizonView, segments: ReadonlyArray<readonly [ClientHorizonView, string]>): string {
    const buttons = segments
      .map(
        ([key, label]) =>
          `<button type="button" class="segbtn${key === active ? " active" : ""}" role="tab" id="horizonTab-${key}" aria-controls="horizonPanel-${key}" aria-selected="${key === active}" data-horizon-seg="${key}">${escHtml(label)}</button>`
      )
      .join("");
    return `<div class="seg horizon-seg" role="tablist" aria-label="Horizon views">${buttons}</div>`;
  }

  /**
   * The timeline's frame: the view switch, then one tab panel per view holding its lane
   * slots, in the timeline's order.
   */
  function shellHtml(active: ClientHorizonView = "race", opts: { race?: boolean; raceLabel?: string } = {}): string {
    // A lifting-only athlete has no race view at all; a runner with no race reads it as "Running".
    const segments = SEGMENTS.filter(([view]) => view !== "race" || opts.race !== false).map(
      ([view, label]) => [view, view === "race" && opts.raceLabel ? opts.raceLabel : label] as const
    );
    if (!segments.some(([view]) => view === active)) active = segments[0][0];
    const panels = segments
      .map(([view]) => {
        const hidden = view === active ? "" : " hidden";
        if (view === "week") {
          // The week is read the first time it is SHOWN, so a hidden week panel holds no
          // skeleton: a busy shimmer nobody can see would read as a load that never ends.
          // The controller puts the skeleton in when the view opens.
          return `<div class="horizon-panel" role="tabpanel" id="horizonPanel-week" aria-labelledby="horizonTab-week" data-horizon-panel="week"${hidden}><div data-horizon-weekview>${hidden ? "" : weekSkeletonHtml()}</div></div>`;
        }
        const lanes = KEYS.filter((key) => PANEL[key] === view)
          .map((key) => `<li class="horizon-lane" data-horizon-lane="${key}">${laneSkeletonHtml(key)}</li>`)
          .join("");
        return `<div class="horizon-panel" role="tabpanel" id="horizonPanel-${view}" aria-labelledby="horizonTab-${view}" data-horizon-panel="${view}"${hidden}><ol class="horizon-lanes" aria-label="What's ahead">${lanes}</ol></div>`;
      })
      .join("");
    return `<div class="horizon" data-horizon data-horizon-view="${active}">
      ${segHtml(active, segments)}
      ${panels}
    </div>`;
  }

  // ---- All goals (the goal line's depth view, /app/horizon/goal) ----
  //
  // Every thread laid out in full: the race estimate, the bodyweight, each strength
  // objective, the priority marker — start, now and goal on a track, with its one-line
  // trend ("+4.2 lb/wk", "Recheck opens Nov 16"), most movement first. Moved here from
  // Today (it echoed the Brief's Path card); the Path card's "All goals" link lands on
  // it. Pure strings over GET /api/today-path's `board` (src/repo/today-path.ts).
  // Measures, never grades: no score, no percent printed.
  type GoalsPath = import("../contracts/today-path.js").TodayPath;
  type GoalsRow = import("../contracts/today-path.js").TodayPathBoardRow;

  function goalTrackHtml(row: GoalsRow): string {
    if (row.progress == null) return "";
    const w = Math.round(Math.max(0, Math.min(1, row.progress)) * 1000) / 10;
    const label = [
      row.start_text ? `from ${row.start_text}` : "",
      `now ${row.now_text}`,
      row.goal_text ? `goal ${row.goal_text}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `<div class="thd-track" role="img" aria-label="${escAttr(`${row.label}: ${label}`)}"><span class="thd-fill${row.reached ? " is-reached" : ""}" style="--w:${w}%"></span><span class="thd-start" aria-hidden="true"></span><span class="thd-goal" aria-hidden="true"></span></div>`;
  }

  function goalRowHtml(row: GoalsRow): string {
    const span =
      row.key === "marker"
        ? `<span class="thd-dir is-${escAttr(row.direction || "steady")}">${escHtml(row.now_text)}</span>`
        : `<span>${row.start_text ? `${escHtml(row.start_text)} → ` : ""}<b class="num">${escHtml(row.now_text)}</b>${row.goal_text ? ` · goal ${escHtml(row.goal_text)}` : ""}</span>`;
    return `<div class="thd-row thd-${escAttr(row.key)}" data-thd-row="${escAttr(row.id)}">
      <div class="thd-top"><b>${escHtml(row.label)}</b>${span}</div>
      ${goalTrackHtml(row)}
      ${row.note ? `<small>${escHtml(row.note)}</small>` : ""}
    </div>`;
  }

  /** All goals: one row per thread; "" with no thread to show. */
  function goalsBoardHtml(path: GoalsPath | null | undefined): string {
    const rows = path && Array.isArray(path.board) ? path.board : [];
    if (!rows.length) return "";
    return `<section class="thd horizon-goals" aria-label="All goals">
      <div class="thd-mast"><span class="lbl">All goals</span></div>
      <div class="thd-rows">${rows.map(goalRowHtml).join("")}</div>
    </section>`;
  }

  const CAIRN_HORIZON = {
    KEYS,
    PANEL,
    laneHtml,
    laneSkeletonHtml,
    seasonHtml,
    weekHtml,
    weekSkeletonHtml,
    shellHtml,
    goalsBoardHtml,
  };

  Object.assign(globalThis, { CairnHorizon: CAIRN_HORIZON });
}

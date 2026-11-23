// @ts-check
// Horizon's Week, the view (docs/IA.md "Horizon landing"): the designed landing, always
// Horizon's first view. It answers three questions in the order they are asked — where do
// I stand, what is this week for, what is coming — top to bottom:
//
// With a road to draw, 5 moves up to sit directly under the hero.
//
//   1. the hero (CairnFrameLine): the week's purpose (or, near a race, its countdown) as
//      the serif line, the other said once under it (`frame.sub`; `frame.line` on an
//      older read), the block ribbon;
//   2. since you started (CairnProofBand): what has measurably changed, a small picture
//      each; "Behind you ›" switches to that segment when it exists;
//   3. where you stand (CairnGoalRow): each goal as a thread with its direction, every row
//      a link to its depth; under them the team's link note when one exists;
//      then "The whole picture" (CairnStanding): one calm row per area (strength, endurance,
//      mobility, body, blood, pressure, recovery), a direction word and a sentence, its lines
//      folded under it; omitted with no `standing`;
//   4. this week's shape (CairnWeekStrip "shape"): seven columns sized by planned dose, the
//      totals in words on the masthead, a fold a tapped column peeks into, and folded, the
//      days as rows that open each day's page;
//   5. your road (CairnJourneyTrail): the trail from where this stretch began, through
//      today, up to the furthest dated mark, with every mark as a row folded under it —
//      the next milestones as rows on an older read, the starter with nothing dated;
//   6. your team this week (CairnTeamSeats): up to three seats, filled when the team read
//      lands (its own slot, so the landing never waits on it).
//
// Composes the shared components' strings; says nothing itself beyond section names and
// empty/error lines. Every word escaped; no unit or date logic here.
{
  const PEEK_ID = "hwkPeek";

  type LandingOpts = {
    enter?: boolean;
    selected?: string | null;
    /** The trail mark whose words are open (default: the next one). */
    mark?: number;
    /** …or the walked stone whose words are open. */
    stone?: number | null;
    seasonHref?: string;
    changesHref?: string;
    team?: ClientTeamSeats | null;
  };

  function sectionHtml(key: string, title: string, body: string, aside = ""): string {
    if (!body) return "";
    return `<section class="hwk-sec is-${key}" aria-labelledby="hwkH-${key}">
      <div class="hwk-mast"><h3 class="lbl hwk-k" id="hwkH-${key}">${escHtml(title)}</h3>${aside}</div>
      ${body}
    </section>`;
  }

  /** The days as rows (the day view's row variant: Program's words), folded under the shape. */
  function rowsHtml(glances: ReadonlyArray<ClientDayGlance>): string {
    if (!glances.length || typeof CairnDayGlanceView === "undefined") return "";
    return `<details class="hwk-days"><summary class="linkbtn-quiet hwk-days-sum">Day by day</summary>
      <ol class="pahead-days hwk-days-list" aria-label="This week, day by day">${glances.map((g) => CairnDayGlanceView.rowHtml(g)).join("")}</ol>
    </details>`;
  }

  function shapeHtml(model: ClientWeekLanding, selected: string | null): string {
    const shape = CairnWeekStrip.shapeHtml(model.days, { selected, controls: PEEK_ID });
    if (!shape)
      return `<p class="hwk-empty">Nothing planned this week yet. A lifting plan in Train or run days in chat fill it in.</p>`;
    const open = !!selected;
    // The server folds the week's count sentence into the hero's `sub` only when the PURPOSE
    // leads; when the countdown leads, `sub` is the purpose and the summary is still said here.
    const summary = model.summary && !(model.sub && model.frame.lead !== "countdown") ? `<p class="hwk-summary">${escHtml(model.summary)}</p>` : "";
    return `${shape}
      <div class="hwk-fold${open ? " is-open" : ""}" id="${PEEK_ID}" data-hwk-fold${open ? "" : " inert"} role="region" aria-label="The day opened"><div class="hwk-fold-in" data-hwk-peek></div></div>
      ${summary}
      ${model.layout_note ? `<p class="hwk-note">${escHtml(model.layout_note)}</p>` : ""}
      ${rowsHtml(model.glances)}`;
  }

  /** True when the landing draws the trail (a journey with a dated mark, and the view loaded). */
  function hasRoad(model: ClientWeekLanding): boolean {
    return !!model.journey?.marks?.length && typeof CairnJourneyTrail !== "undefined";
  }

  /** Every mark as a row, folded under the trail; a single mark is already said by the trail itself. */
  function marksFoldHtml(model: ClientWeekLanding, seasonHref: string): string {
    if (typeof CairnAheadStrip === "undefined") return "";
    const season = `<a class="linkbtn linkbtn-plain hwk-season" href="${escAttr(seasonHref || "#")}" data-hwk-season>All of the season ›</a>`;
    if (model.ahead.length < 2) return season;
    const rows = CairnAheadStrip.rowsHtml(model.ahead, { seasonHref });
    if (!rows) return season;
    return `<details class="hjour-all"><summary class="linkbtn-quiet hjour-all-sum">Every mark ahead</summary>${rows}</details>${model.ahead.length > CairnAheadStrip.ROWS_MAX ? "" : season}`;
  }

  /**
   * Your road: the trail over the journey's marks, every mark a row folded under it; with
   * no journey, the next milestones as rows (an older shape) and the way to the season;
   * with nothing dated at all (this week), the starter that hands chat a first sentence.
   */
  function aheadHtml(model: ClientWeekLanding, opts: LandingOpts): string {
    const seasonHref = opts.seasonHref || "";
    if (hasRoad(model)) {
      const road = CairnJourneyTrail.trailHtml(model.journey, {
        enter: !!opts.enter,
        selected: opts.mark,
        stone: opts.stone,
        below: marksFoldHtml(model, seasonHref),
      });
      if (road) return road;
    }
    const list = CairnMilestoneRow.listHtml(model.next, { label: "Ahead, beyond this week" });
    if (list)
      return `${list}<a class="linkbtn linkbtn-plain hwk-season" href="${escAttr(seasonHref || "#")}" data-hwk-season>All of the season ›</a>`;
    if (!model.this_week || typeof CairnJourneyTrail === "undefined") return "";
    return CairnJourneyTrail.starterHtml({ hasGoals: model.goals.length > 0 });
  }

  /** The proof band, with "Behind you ›" on its masthead (shown only while that segment exists). */
  function proofHtml(model: ClientWeekLanding, enter: boolean): string {
    if (typeof CairnProofBand === "undefined") return "";
    const aside = `<button type="button" class="linkbtn-quiet hwk-aside-link hwk-behind-go" data-hwk-behind>Behind you ›</button>`;
    return sectionHtml("proof", "Since you started", CairnProofBand.listHtml(model.proof, { enter }), aside);
  }

  /** The team's seats as a section; "" with none (the slot then collapses). */
  function teamHtml(team: ClientTeamSeats | null | undefined, changesHref = ""): string {
    if (!team || typeof CairnTeamSeats === "undefined") return "";
    return sectionHtml(
      "team",
      "Your team this week",
      CairnTeamSeats.seatsHtml(team),
      CairnTeamSeats.changesHtml(team, changesHref)
    );
  }

  /** "The whole picture": the standing rows under the goals; "" with none (no section). */
  function standingHtml(model: ClientWeekLanding): string {
    if (!model.standing?.length || typeof CairnStanding === "undefined") return "";
    return sectionHtml("standing", "The whole picture", CairnStanding.listHtml(model.standing));
  }

  /** The team's link note for its slot under the goals; "" with none. */
  function linkNoteHtml(team: ClientTeamSeats | null | undefined): string {
    return team && typeof CairnTeamSeats !== "undefined" ? CairnTeamSeats.linkHtml(team) : "";
  }

  /** The hero's kicker: the week's range, and the stage and block words when `sub` stands in for the line. */
  function kickerOf(model: ClientWeekLanding): string {
    const extra = model.sub ? [model.frame.stage?.word, model.frame.block?.words, model.frame.push?.words] : [];
    return ["This week", model.range, ...extra].filter((s) => !!String(s ?? "").trim()).join(" · ");
  }

  /** The landing; `enter` gives it the shared settle-in once, `selected` keeps an open peek open. */
  function landingHtml(model: ClientWeekLanding, opts: LandingOpts = {}): string {
    const hero =
      CairnFrameLine.heroHtml(model.frame, { kicker: kickerOf(model), id: "hwkTitle", sub: true }) ||
      `<header class="frameline"><span class="lbl frameline-k">This week</span><h2 class="frameline-h" id="hwkTitle">${escHtml(model.range || "This week")}</h2></header>`;
    const totals = model.totals_words ? `<span class="hwk-aside num">${escHtml(model.totals_words)}</span>` : "";
    // The road leads when there is one to draw: it is the first picture under the week's
    // purpose. With no journey, what is ahead (rows, or the starter) keeps its place last.
    const road = hasRoad(model);
    const ahead = sectionHtml("ahead", road ? "Your road" : "Ahead", aheadHtml(model, opts));
    return `<div class="hwk${opts.enter ? " settle-in is-entering" : ""}">
      ${hero}
      ${road ? ahead : ""}
      ${proofHtml(model, !!opts.enter)}
      ${sectionHtml("goals", "Where you stand", CairnGoalRow.listHtml(model.goals, { label: "Where you stand" }))}
      <div class="hwk-link-slot" data-hwk-link-slot>${linkNoteHtml(opts.team)}</div>
      ${standingHtml(model)}
      ${sectionHtml("shape", "This week's shape", shapeHtml(model, opts.selected || null), totals)}
      ${road ? "" : ahead}
      <div class="hwk-team-slot" data-hwk-team-slot>${teamHtml(opts.team, opts.changesHref)}</div>
    </div>`;
  }

  /** Before the read lands: the landing's own shape, nothing said. */
  function skeletonHtml(): string {
    const cols = Array.from({ length: 7 }, () => `<div class="hshimmer hwk-skel-col"></div>`).join("");
    return `<div class="hwk is-pending" aria-busy="true" aria-label="This week">
      <div class="hshimmer hwk-skel-k"></div>
      <div class="hshimmer hshimmer-lg hwk-skel-title"></div>
      <div class="hshimmer hwk-skel-line"></div>
      <div class="hwk-skel-shape">${cols}</div>
      <div class="hshimmer hwk-skel-line"></div>
    </div>`;
  }

  function errorHtml(): string {
    return `<p class="hwk-empty" role="status">This week couldn't be read just now.</p>`;
  }

  const CAIRN_HORIZON_WEEK = { landingHtml, teamHtml, linkNoteHtml, skeletonHtml, errorHtml, PEEK_ID };

  Object.assign(globalThis, { CairnHorizonWeek: CAIRN_HORIZON_WEEK });
}

// @ts-check
// Horizon's Week, the view (docs/IA.md "Horizon landing"): the designed landing, always
// Horizon's first view. Top to bottom:
//
//   1. the frame hero (CairnFrameLine): "26 days to Cambridge Half" over "Sharpen · block
//      week 6 of 6 · push through Nov 15", the block ribbon under it;
//   2. your road (CairnJourneyTrail): the trail from where this stretch began, through
//      today, up to the furthest dated goal — what is behind, what is next, the summit;
//      with nothing dated ahead, the starter that hands chat a first sentence;
//   3. this week's shape (CairnWeekStrip "shape"): seven columns sized by planned dose,
//      a fold under them a tapped column peeks into, the week's ONE sentence (Horizon
//      owns it) and, folded, the days as rows that open each day's page;
//   4. still open: at most two lines, each opening its day;
//   5. next up: the next milestones beyond this week (CairnMilestoneRow, the Season's
//      own row) and "All of the season ›";
//   6. goals, compact (CairnGoalRow): the race estimate with its time, the weight on its
//      one trend, the anchor lift — each with its meter in words.
//
// Composes the shared components' strings; says nothing itself beyond section names and
// empty/error lines. Every word escaped; no unit or date logic here.
{
  const PEEK_ID = "hwkPeek";

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
    return `${shape}
      <div class="hwk-fold${open ? " is-open" : ""}" id="${PEEK_ID}" data-hwk-fold${open ? "" : " inert"} role="region" aria-label="The day opened"><div class="hwk-fold-in" data-hwk-peek></div></div>
      ${model.summary ? `<p class="hwk-summary">${escHtml(model.summary)}</p>` : ""}
      ${model.layout_note ? `<p class="hwk-note">${escHtml(model.layout_note)}</p>` : ""}
      ${rowsHtml(model.glances)}`;
  }

  function openHtml(rows: ReadonlyArray<ClientWeekOpenRow>): string {
    if (!rows.length) return "";
    const items = rows
      .map((row) => {
        const inner = `<span class="hwk-open-dot stone-${row.stone}" aria-hidden="true"></span><span class="hwk-open-t">${escHtml(row.words)}</span>`;
        return row.date
          ? `<li><button type="button" class="hwk-open-row" data-open-day="${escAttr(row.date)}">${inner}<span class="hwk-open-go" aria-hidden="true">›</span></button></li>`
          : `<li><span class="hwk-open-row">${inner}</span></li>`;
      })
      .join("");
    return `<ul class="hwk-open">${items}</ul>`;
  }

  function nextHtml(model: ClientWeekLanding, seasonHref: string): string {
    const list = CairnMilestoneRow.listHtml(model.next, { label: "Next up, beyond this week" });
    if (!list) return "";
    return `${list}<a class="linkbtn linkbtn-plain hwk-season" href="${escAttr(seasonHref || "#")}" data-hwk-season>All of the season ›</a>`;
  }

  /** Your road: the trail, else (this week, nothing dated ahead) the starter. */
  function roadHtml(model: ClientWeekLanding, opts: { enter?: boolean; mark?: number }): string {
    if (typeof CairnJourneyTrail === "undefined") return "";
    if (model.journey) return CairnJourneyTrail.trailHtml(model.journey, { enter: opts.enter, selected: opts.mark });
    return model.this_week ? CairnJourneyTrail.starterHtml({ hasGoals: model.goals.length > 0 }) : "";
  }

  /** The landing; `enter` gives it the shared settle-in once, `selected` keeps an open peek open. */
  function landingHtml(
    model: ClientWeekLanding,
    opts: { enter?: boolean; selected?: string | null; seasonHref?: string; mark?: number } = {}
  ): string {
    const hero =
      CairnFrameLine.heroHtml(model.frame, {
        kicker: model.range ? `This week · ${model.range}` : "This week",
        id: "hwkTitle",
      }) ||
      `<header class="frameline"><span class="lbl frameline-k">This week</span><h2 class="frameline-h" id="hwkTitle">${escHtml(model.range || "This week")}</h2></header>`;
    return `<div class="hwk${opts.enter ? " settle-in is-entering" : ""}">
      ${hero}
      ${sectionHtml("road", "Your road", roadHtml(model, opts))}
      ${sectionHtml("shape", "This week's shape", shapeHtml(model, opts.selected || null))}
      ${sectionHtml("open", "Still open", openHtml(model.open))}
      ${sectionHtml("next", "Next up", nextHtml(model, opts.seasonHref || ""))}
      ${sectionHtml("goals", "Goals", CairnGoalRow.listHtml(model.goals, { label: "Goals" }))}
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

  const CAIRN_HORIZON_WEEK = { landingHtml, skeletonHtml, errorHtml, PEEK_ID };

  Object.assign(globalThis, { CairnHorizonWeek: CAIRN_HORIZON_WEEK });
}

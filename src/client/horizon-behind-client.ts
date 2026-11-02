// @ts-check
// "Behind you" (src/contracts/goal-reviews.ts): every finished goal — a race run, a
// strength objective completed, a goal weight reached — said back once and kept. Two
// pure-string pieces:
//
//   listHtml(read)    the quiet section at the bottom of Horizon › Season: newest first,
//                     one row each (date, title, the measure, its one sentence), each a
//                     real link to its look back. "" when nothing is behind yet.
//   detailHtml(read)  the look back itself (/app/horizon/behind?id=<id>): the hero, the
//                     plain facts, the build's weeks drawn to scale (race week stacked
//                     with the race), the story, what it taught, and what carried
//                     forward, with the one Undo when the carried levers are still live.
//
// The server writes every word; this only lays them out. A measure said back, never a
// verdict: no grade, no score, no comparison against the target, and nothing notifies.
{
  type Row = import("../contracts/goal-reviews.js").GoalReviewRow;
  type Detail = import("../contracts/goal-reviews.js").GoalReviewDetail;
  type Week = import("../contracts/goal-reviews.js").GoalReviewChartWeek;
  type Build = import("../contracts/goal-reviews.js").GoalReviewBuildChart;
  type HrefFor = (target: ClientHorizonTarget) => string | null;

  /** What a review row still waiting for its look back says on the page. */
  const SOON = "Looked back on soon.";

  function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  function num(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** The route a row opens: Horizon's depth view for one review. */
  function target(id: unknown): ClientHorizonTarget {
    return { tab: "horizon", section: "behind", id: String(id) };
  }

  /** The list read's rows, cleaned and newest first (the server's order, held). */
  function rows(read: unknown): Row[] {
    const list = Array.isArray(read) ? read : record(read)?.reviews;
    if (!Array.isArray(list)) return [];
    return list
      .map((value) => record(value))
      .filter((row): row is Record<string, unknown> => !!row && row.id != null && !!text(row.title))
      .map((row) => row as unknown as Row)
      .sort((a, b) => text(b.achieved_on).localeCompare(text(a.achieved_on)) || Number(b.id) - Number(a.id));
  }

  /** One row: date, title, the measure, its sentence (none while pending). */
  function rowHtml(row: Row, hrefFor?: HrefFor): string {
    const href = hrefFor?.(target(row.id)) || "#";
    const result = text(row.result_line);
    const line = text(row.line);
    return `<li class="hbehind-item"><a class="hbehind-row" href="${escAttr(href)}" data-horizon-go="behind:${escAttr(row.id)}">
      <span class="lbl hbehind-date">${escHtml(row.date_text || row.achieved_on)}</span>
      <span class="hbehind-title">${escHtml(row.title)}</span>
      ${result ? `<span class="hbehind-result">${escHtml(result)}</span>` : ""}
      ${line ? `<span class="hbehind-line${row.status === "ready" ? "" : " is-waiting"}">${escHtml(line)}</span>` : ""}
    </a></li>`;
  }

  /** The Season's "Behind you" section; "" when no goal is behind yet. */
  function listHtml(read: unknown, opts: { hrefFor?: HrefFor } = {}): string {
    const list = rows(read);
    if (!list.length) return "";
    return `<section class="hbehind" aria-labelledby="horizonBehindTitle">
      <h2 class="lbl hbehind-kicker" id="horizonBehindTitle">Behind you</h2>
      <ol class="hbehind-rows">${list.map((row) => rowHtml(row, opts.hrefFor)).join("")}</ol>
    </section>`;
  }

  // ---- the look back ----

  function fraction(value: number, max: number): number {
    if (!(max > 0)) return 0;
    return Math.round(Math.max(0, Math.min(1, value / max)) * 1000) / 1000;
  }

  /**
   * The build, one column per week drawn to the tallest stacked week: the training on
   * the bottom, the race stacked above it on race week, a set-aside week quieter. Each
   * column's words are its accessible text. "" with no week to draw.
   */
  function buildHtml(build: Build | null | undefined): string {
    if (!build || !Array.isArray(build.weeks) || !build.weeks.length) return "";
    const weeks: Week[] = build.weeks;
    const tallest = Math.max(num(build.max_value), ...weeks.map((w) => num(w.value) + num(w.race_value)));
    if (!(tallest > 0)) return "";
    const cols = weeks
      .map((w) => {
        const value = num(w.value);
        const race = w.race_week ? num(w.race_value) : 0;
        const cls = ["hbuild-week", w.race_week ? "is-race" : "", w.set_aside ? "is-set-aside" : "", value + race > 0 ? "" : "is-empty"]
          .filter(Boolean)
          .join(" ");
        const raceBar = race > 0 ? `<span class="hbuild-race" style="--frac:${fraction(race, tallest)}"></span>` : "";
        return `<li class="${cls}">
          <span class="hbuild-stack" aria-hidden="true">${raceBar}<span class="hbuild-bar" style="--frac:${fraction(value, tallest)}"></span></span>
          <span class="sr-only">${escHtml(`${text(w.label)}: ${text(w.words)}`)}</span>
          <span class="hbuild-label" aria-hidden="true">${escHtml(w.label)}</span>
        </li>`;
      })
      .join("");
    const units = build.units === "mi" ? "mi" : "km";
    const raced = weeks.some((w) => w.race_week && num(w.race_value) > 0);
    const asideShown = weeks.some((w) => w.set_aside);
    const keys = [
      `<span class="hbuild-key is-train">Training, ${units} a week</span>`,
      raced ? `<span class="hbuild-key is-race">The race</span>` : "",
      asideShown ? `<span class="hbuild-key is-set-aside">A week set aside</span>` : "",
    ].join("");
    return `<section class="hb-section hbuild" aria-labelledby="hbBuildTitle">
      <h3 class="lbl hb-section-k" id="hbBuildTitle">The build</h3>
      <figure class="hbuild-card">
        <ol class="hbuild-weeks${weeks.length > 6 ? " is-dense" : ""}" style="--n:${weeks.length}" aria-label="${escAttr(`Distance each week of the build, ${units}`)}">${cols}</ol>
        <figcaption class="hbuild-keys">${keys}</figcaption>
      </figure>
    </section>`;
  }

  function proseHtml(id: string, title: string, body: unknown): string {
    const words = text(body);
    if (!words) return "";
    return `<section class="hb-section" aria-labelledby="${id}">
      <h3 class="lbl hb-section-k" id="${id}">${escHtml(title)}</h3>
      <p class="hb-prose">${escHtml(words)}</p>
    </section>`;
  }

  /** What carried forward: the words, each adopted lever's reason, and the one Undo. */
  function carriedHtml(detail: Detail): string {
    const carried = record(detail.carried);
    const words = text(carried?.text) || text(detail.review?.carry_forward);
    const levers = (carried && Array.isArray(carried.levers) ? (carried.levers as unknown[]) : [])
      .map((lever) => record(lever))
      .filter((lever): lever is Record<string, unknown> => !!lever && !!text(lever.because));
    if (!words && !levers.length) return "";
    const list = levers.length
      ? `<ul class="hb-levers">${levers
          .map(
            (lever) =>
              `<li class="hb-lever${lever.status === "active" ? "" : ` is-${escAttr(text(lever.status) || "past")}`}">${escHtml(lever.because)}</li>`
          )
          .join("")}</ul>`
      : "";
    const id = carried?.decision_id;
    const undo =
      carried?.undoable === true && id != null && typeof CairnDecisionUndo !== "undefined"
        ? `<div class="hb-undo">${CairnDecisionUndo.buttonHtml({ id, label: "Undo", className: "linkbtn-quiet hb-undo-btn" })}</div>`
        : "";
    return `<section class="hb-section hb-carried" aria-labelledby="hbCarriedTitle">
      <h3 class="lbl hb-section-k" id="hbCarriedTitle">Carried forward</h3>
      ${words ? `<p class="hb-prose">${escHtml(words)}</p>` : ""}
      ${list}
      ${undo}
    </section>`;
  }

  /** The look back; "" when the read is not a review. */
  function detailHtml(read: unknown): string {
    const raw = record(read);
    if (!raw || raw.id == null || !text(raw.title)) return "";
    const detail = raw as unknown as Detail;
    const review = record(detail.review) ? (detail.review as NonNullable<Detail["review"]>) : null;
    const facts = (Array.isArray(detail.fact_lines) ? detail.fact_lines : []).map(text).filter(Boolean);
    const result = text(detail.result_line);
    const headline = review ? text(review.headline) : "";
    const hero = `<header class="hb-hero">
      <span class="lbl hb-date">${escHtml(detail.date_text || detail.achieved_on)}</span>
      <h2 class="hb-title" id="hbTitle">${escHtml(detail.title)}</h2>
      ${result ? `<p class="hb-result">${escHtml(result)}</p>` : ""}
      ${headline ? `<p class="hb-headline">${escHtml(headline)}</p>` : ""}
    </header>`;
    const factList = facts.length
      ? `<ul class="hb-facts">${facts.map((f) => `<li>${escHtml(f)}</li>`).join("")}</ul>`
      : "";
    if (!review) {
      // Before the look back: the measure and the facts, and when it comes.
      const soon = detail.status === "waiting" && text(detail.line) ? text(detail.line) : SOON;
      return `<article class="hb" aria-labelledby="hbTitle">${hero}${factList}<p class="hb-soon">${escHtml(soon)}</p></article>`;
    }
    return `<article class="hb" aria-labelledby="hbTitle">
      ${hero}
      ${factList}
      ${buildHtml(detail.build)}
      ${review.story ? `<p class="hb-prose hb-story">${escHtml(review.story)}</p>` : ""}
      ${proseHtml("hbLessonsTitle", "What it taught", review.lessons)}
      ${carriedHtml(detail)}
    </article>`;
  }

  const CAIRN_HORIZON_BEHIND = { SOON, target, rows, listHtml, detailHtml };

  Object.assign(globalThis, { CairnHorizonBehind: CAIRN_HORIZON_BEHIND });
}

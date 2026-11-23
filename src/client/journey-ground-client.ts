// @ts-check
// Your road, the ground covered (docs/IA.md "Horizon landing" 6): what the athlete has
// actually done on this stretch (GET /api/week `journey.walked`: a race run, a lift's new
// best, the longest run, a weight waypoint crossed, a lab marker a newer draw moved the
// right way, a block finished, the first full week, a measured body change —
// journey-ground.ts), the card under the axis that opens a mark's or a stone's words, and
// "Behind you": the stones' own sentences, so the list and the trail never disagree, and
// under them what has moved since the road began (`behind`, with how long it has been
// walked, `walked_words`), so distance covered is never hidden by dated events. With no
// stones, the moved lines are the list. The trail (journey-trail-client.ts) places the
// stones; this module owns what they say.
//
// Pure strings; every server word escaped, only an in-app page links. No score, no percent.
//
// LAZY ("horizon" bundle).
{
  type Journey = import("../contracts/week-read.js").WeekReadJourney;
  type Stone = import("../contracts/week-read.js").WeekReadJourneyStone;

  const HUES = new Set(["strength", "endurance", "body", "heart"]);
  /** A stone's card title, by what it was. */
  const STONE_TITLE: Readonly<Record<string, string>> = {
    race_done: "Race run",
    best: "A new best",
    longest_run: "Longest run",
    weight: "Weight waypoint",
    health: "Lab draw",
    block: "Block finished",
    full_week: "A full week",
    waist: "Waist",
    body_fat: "Body fat",
  };
  /** A "Behind you" item's stone on an older read, by what moved. */
  const BEHIND_STONE: Readonly<Record<string, string>> = {
    race: "endurance",
    race_done: "endurance",
    weight: "body",
    strength: "strength",
  };

  function dayNumber(iso: unknown): number {
    const ms = Date.parse(`${String(iso ?? "").slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(ms) ? ms / 864e5 : Number.NaN;
  }

  /** A walked stone's hue: its own stone class, else endurance. */
  function hueOf(stone: Stone): string {
    return HUES.has(stone.stone) ? stone.stone : "endurance";
  }

  /**
   * The walked stones as served, index for index (a tap names a stone by its place in
   * `journey.walked`); one not dated on this stretch, or without words, is null. [] on an
   * older read.
   */
  function walkedOf(journey: Journey, start: number, today: number): Array<Stone | null> {
    return (Array.isArray(journey.walked) ? journey.walked : []).map((s) => {
      const d = dayNumber(s?.date);
      return Number.isFinite(d) && d >= start && d <= today && s.words ? s : null;
    });
  }

  /** The card under the axis: a dot in the hue, the name, when, and why; a link when it has an in-app page. */
  function cardHtml(hue: string, name: string, when: string, why: string | null | undefined, href: unknown): string {
    const body = `<span class="hjour-d-dot stone-${hue}" aria-hidden="true"></span>
      <span class="hjour-d-body">
        <b class="hjour-d-name">${escHtml(name)}</b>
        <span class="hjour-d-when">${escHtml(when)}</span>
        ${why ? `<span class="hjour-d-why">${escHtml(why)}</span>` : ""}
      </span>`;
    // The Horizon controller routes the link.
    const to = typeof href === "string" && href.startsWith("/") && !href.startsWith("//") ? href : "";
    return to
      ? `<a class="hjour-d-link" href="${escAttr(to)}" data-horizon-href>${body}<span class="hjour-d-go" aria-hidden="true">›</span></a>`
      : `<span class="hjour-d-link">${body}</span>`;
  }

  /** A walked stone's own words in the card: what it was, when, and its sentence. */
  function stoneDetailHtml(stone: Stone | null | undefined): string {
    if (!stone) return "";
    return cardHtml(hueOf(stone), STONE_TITLE[stone.kind] || stone.short, stone.date_words, stone.words, stone.href);
  }

  function rowHtml(hue: string, words: string): string {
    return `<li class="hjour-b stone-${hue}"><span class="hjour-b-mark" aria-hidden="true"></span><span>${escHtml(words)}</span></li>`;
  }

  /**
   * What is behind: the walked stones' sentences, newest first, then what has moved since
   * the road began as a short summary under them (how long it has been walked, and the
   * moved lines; a race's own line gives way to its stone). With no stones, the moved lines
   * are the list, under how long the road has been walked. "" with nothing true to say.
   */
  function behindHtml(journey: Journey, stones: Stone[]): string {
    const raced = stones.some((s) => s.kind === "race_done");
    const moved = (journey.behind ?? []).filter((b) => b?.words && !(raced && b.key === "race_done"));
    const span = typeof journey.walked_words === "string" ? journey.walked_words.trim() : "";
    if (!stones.length && !moved.length && !span) return "";
    const head = `<span class="lbl hjour-behind-k">Behind you</span>`;
    const spanHtml = span ? `<p class="hjour-sum-k">${escHtml(span)}</p>` : "";
    if (!stones.length) {
      const rows = moved.map((b) => rowHtml(BEHIND_STONE[b.key] || "endurance", b.words)).join("");
      return `<div class="hjour-behind">${head}${spanHtml}${rows ? `<ul class="hjour-bs">${rows}</ul>` : ""}</div>`;
    }
    const rows = [...stones]
      .reverse()
      .map((s) => rowHtml(hueOf(s), s.words))
      .join("");
    const lines = moved
      .map((b) => `<li class="hjour-s stone-${BEHIND_STONE[b.key] || "endurance"}">${escHtml(b.words)}</li>`)
      .join("");
    const sum =
      span || lines
        ? `<div class="hjour-sum">${spanHtml || `<p class="hjour-sum-k">So far</p>`}${lines ? `<ul class="hjour-sum-l">${lines}</ul>` : ""}</div>`
        : "";
    return `<div class="hjour-behind">${head}<ul class="hjour-bs">${rows}</ul>${sum}</div>`;
  }

  const CAIRN_JOURNEY_GROUND = { walkedOf, hueOf, cardHtml, stoneDetailHtml, behindHtml };

  Object.assign(globalThis, { CairnJourneyGround: CAIRN_JOURNEY_GROUND });
}

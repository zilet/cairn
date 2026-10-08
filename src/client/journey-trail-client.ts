// @ts-check
// The journey trail, the view (docs/IA.md "Horizon landing" 2): the road from where this
// stretch began, through today, up to the furthest dated goal — drawn to scale in time.
// The walked part is solid dawn over a soft ground wash and draws in once; the road
// ahead is dotted; today breathes; each dated mark sits on the trail in its stone's hue,
// a peak week as a lit stretch of trail, and the summit (the furthest goal) as a small
// cairn. Above it, the server's one line of where the athlete stands; under it, the
// month ticks, the opened mark's own words (the next one by default — tap any labelled
// mark to read it) and what has already moved toward a goal ("Behind you").
//
// With no dated mark ahead, the starter: a short trail into open ground and a few
// one-tap openers that hand chat a sentence to start from (never sent for the athlete).
//
// Pure strings over GET /api/week `journey` (week-read.ts journeyOf). Every server word
// is escaped; positions are percentages of the plot, hues come from stone classes in
// src/styles/horizon/journey.css. No score, no percent printed.
//
// LAZY ("calendar" bundle).
{
  type Journey = import("../contracts/week-read.js").WeekReadJourney;
  type Mark = import("../contracts/week-read.js").WeekReadJourneyMark;

  // The plot, in percent of its box: the trail runs X0→X1 and climbs from Y_LOW to Y_HIGH,
  // leaving room above and below for labels.
  const X0 = 3;
  const X1 = 95;
  const Y_LOW = 76;
  const Y_HIGH = 34;
  /** Two labels on one side closer than this (percent of width) would collide. */
  const LABEL_GAP = 21;
  /** Today never sits flush on the start: the walked part always reads. */
  const NOW_MIN_X = 11;

  const STONE: Readonly<Record<string, string>> = {
    race: "endurance",
    peak_week: "endurance",
    long_run: "endurance",
    goal: "body",
    checkpoint: "strength",
    checkup: "heart",
  };

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function dayNumber(iso: string): number {
    const ms = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(ms) ? ms / 864e5 : Number.NaN;
  }

  function r1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  /** The trail's height at x: a steady climb with a gentle meander, flattening at the top. */
  function trailY(x: number): number {
    const t = Math.max(0, Math.min(1, (x - X0) / (X1 - X0)));
    const climb = 1 - (1 - t) ** 1.5;
    return Y_LOW - (Y_LOW - Y_HIGH) * climb + 4.5 * Math.sin(t * Math.PI * 2.4 + 0.3) * (1 - t * 0.6);
  }

  function pathD(from: number, to: number): string {
    const steps = Math.max(2, Math.round((to - from) / 1.5));
    const pts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const x = from + ((to - from) * i) / steps;
      pts.push(`${i ? "L" : "M"}${r1(x)} ${r1(trailY(x))}`);
    }
    return pts.join(" ");
  }

  type Placed = { mark: Mark; index: number; x: number; y: number };

  /** Which marks get a label, and on which side: summit and next first, then race, goal, the rest. */
  function placeLabels(placed: Placed[], xNow: number, xFrom: number | null): Map<number, "above" | "below"> {
    const rank = (p: Placed): number =>
      p.mark.summit
        ? 0
        : p.index === 0
          ? 1
          : p.mark.kind === "race"
            ? 2
            : p.mark.kind === "goal"
              ? 3
              : p.mark.kind === "peak_week"
                ? 4
                : 5;
    const taken: Record<"above" | "below", number[]> = { above: [], below: xFrom == null ? [xNow] : [xNow, xFrom] };
    const out = new Map<number, "above" | "below">();
    for (const p of [...placed].sort((a, b) => rank(a) - rank(b) || a.x - b.x)) {
      const fits = (side: "above" | "below") => taken[side].every((x) => Math.abs(x - p.x) >= LABEL_GAP);
      const side: "above" | "below" | null = fits("above") ? "above" : fits("below") ? "below" : null;
      if (!side) continue;
      taken[side].push(p.x);
      out.set(p.index, side);
    }
    return out;
  }

  /** "left" near the start, "right" near the summit, else centred on its mark. */
  function alignOf(x: number): string {
    return x < 14 ? "is-l" : x > 84 ? "is-r" : "is-c";
  }

  function cairnGlyph(): string {
    return `<svg class="hjour-cairn" viewBox="0 0 20 22" aria-hidden="true"><ellipse cx="10" cy="18.5" rx="8" ry="3.3"/><ellipse cx="10.6" cy="12.6" rx="5.8" ry="2.9"/><ellipse cx="9.8" cy="7.4" rx="4" ry="2.4"/><ellipse cx="10.4" cy="3.2" rx="2.4" ry="1.8"/></svg>`;
  }

  /** The month ticks along the ground, every month (every other on a long road). */
  function axisHtml(start: number, end: number, xOf: (d: number) => number): string {
    const s = new Date(start * 864e5);
    const months = (end - start) / 30.4;
    const step = months > 8 ? 2 : 1;
    const ticks: string[] = [];
    let y = s.getUTCFullYear();
    let m = s.getUTCMonth() + 1;
    for (let guard = 0; guard < 24; guard++) {
      if (m > 11) {
        m -= 12;
        y += 1;
      }
      const d = Date.UTC(y, m, 1) / 864e5;
      if (d > end) break;
      const x = xOf(d);
      if (x > X0 + 6 && x < X1 - 3) ticks.push(`<span class="hjour-tick" style="--x:${r1(x)}%">${MONTHS[m]}</span>`);
      m += step;
    }
    return `<div class="hjour-axis" aria-hidden="true">${ticks.join("")}</div>`;
  }

  /** The opened mark's own words: what it is, when, and why it matters. */
  function detailHtml(mark: Mark | null | undefined): string {
    if (!mark) return "";
    const stone = STONE[mark.kind] || "endurance";
    const when = [mark.date_words, mark.days_words].filter(Boolean).join(" · ");
    return `<span class="hjour-d-dot stone-${stone}" aria-hidden="true"></span>
      <span class="hjour-d-body">
        <b class="hjour-d-name">${escHtml(mark.label)}</b>
        <span class="hjour-d-when">${escHtml(when)}</span>
        ${mark.detail ? `<span class="hjour-d-why">${escHtml(mark.detail)}</span>` : ""}
      </span>`;
  }

  function behindHtml(journey: Journey): string {
    if (!journey.behind?.length) return "";
    const items = journey.behind
      .map(
        (b) =>
          `<li class="hjour-b"><svg class="hjour-b-mark" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.4 5 8.8 9.6 3.4"/></svg><span>${escHtml(b.words)}</span></li>`
      )
      .join("");
    return `<div class="hjour-behind"><span class="lbl hjour-behind-k">Behind you</span><ul class="hjour-bs">${items}</ul></div>`;
  }

  /**
   * The trail; "" with nothing ahead to draw. `selected` is the mark index whose words
   * are open (default: the next mark); `enter` draws the walked part in once.
   */
  function trailHtml(journey: Journey | null | undefined, opts: { selected?: number; enter?: boolean } = {}): string {
    const marks = journey?.marks ?? [];
    if (!journey || !marks.length) return "";
    const start = dayNumber(journey.start_date);
    const today = dayNumber(journey.today);
    const end = Math.max(...marks.map((m) => dayNumber(m.end_date || m.date)));
    if (!Number.isFinite(start) || !Number.isFinite(today) || !(end > start)) return "";
    // To scale in time; when today sits at the very start the walked part still reads.
    const lin = (d: number) => X0 + ((d - start) / (end - start)) * (X1 - X0);
    const rawNow = lin(today);
    const xNow = Math.max(NOW_MIN_X, Math.min(X1 - 4, rawNow));
    const xOf = (d: number) =>
      d <= today
        ? X0 + ((d - start) / Math.max(1, today - start)) * (xNow - X0)
        : xNow + ((d - today) / Math.max(1, end - today)) * (X1 - xNow);
    const yNow = trailY(xNow);
    const placed: Placed[] = marks.map((mark, index) => {
      // The summit stands where the road ends: a window's last day, else its own date.
      const x = xOf(dayNumber(mark.summit ? mark.end_date || mark.date : mark.date));
      return { mark, index, x, y: trailY(x) };
    });
    // The start's date sits under the start only when today is far enough along not to crowd it.
    const showFrom = xNow - X0 >= 22;
    const sides = placeLabels(placed, xNow, showFrom ? X0 : null);
    const selected = Math.max(0, Math.min(marks.length - 1, opts.selected ?? 0));

    const bands = marks
      .filter((m) => m.end_date && m.kind === "peak_week")
      .map((m) => {
        const a = xOf(dayNumber(m.date));
        const b = Math.max(a + 1.5, xOf(dayNumber(m.end_date as string)));
        return `<path class="hjour-band stone-${STONE[m.kind]}" d="${pathD(a, b)}"/>`;
      })
      .join("");
    // The ground wash lies under the whole trail, lit under the walked part and fading
    // out just past today, so the road ahead reads as open ground.
    const ground = `${pathD(X0, X1)} L${X1} 100 L${X0} 100 Z`;
    const nowAt = (xNow - X0) / (X1 - X0);
    const stops = [
      [0, "hjour-g1"],
      [Math.max(0, nowAt * 0.35), "hjour-g0"],
      [nowAt, "hjour-g0"],
      [Math.min(1, nowAt + 0.14), "hjour-g1"],
    ]
      .map(([o, c]) => `<stop offset="${r1(Number(o) * 100)}%" class="${c}"/>`)
      .join("");
    const svg = `<svg class="hjour-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="hjourGround" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs>
      <path class="hjour-ground" d="${ground}" fill="url(#hjourGround)"/>
      <path class="hjour-ahead" d="${pathD(xNow, X1)}"/>
      ${bands}
      <path class="hjour-walked" d="${pathD(X0, xNow)}"/>
    </svg>`;

    const nodes = placed
      .map((p) => {
        const stone = STONE[p.mark.kind] || "endurance";
        return p.mark.summit
          ? `<span class="hjour-node is-summit stone-${stone}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--i:${p.index}" aria-hidden="true">${cairnGlyph()}</span>`
          : `<span class="hjour-node is-${escAttr(p.mark.kind)} stone-${stone}${p.index === selected ? " is-on" : ""}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--i:${p.index}" data-hjour-node="${p.index}" aria-hidden="true"></span>`;
      })
      .join("");
    const labels = placed
      .filter((p) => sides.has(p.index))
      .map((p) => {
        const side = sides.get(p.index) === "above" ? "is-above" : "is-below";
        const aria = `${p.mark.label}, ${p.mark.date_words}, ${p.mark.days_words}`;
        return `<button type="button" class="hjour-lbl ${side} ${alignOf(p.x)}${p.mark.summit ? " is-summit" : ""}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--i:${p.index}" data-hjour-mark="${p.index}" aria-pressed="${p.index === selected}" aria-controls="hjourDetail" aria-label="${escAttr(aria)}"><small>${escHtml(p.mark.days_words)}</small><b>${escHtml(p.mark.short)}</b></button>`;
      })
      .join("");
    const summit = marks.find((m) => m.summit) ?? marks[marks.length - 1];
    const aria = `Your road from ${journey.start_words} through today to ${summit.label}, ${summit.date_words}`;
    return `<div class="hjour${opts.enter ? " is-drawing" : ""}" data-hjour>
      ${journey.line ? `<p class="hjour-line">${escHtml(journey.line)}</p>` : ""}
      <div class="hjour-plot" role="img" aria-label="${escAttr(aria)}">
        ${svg}
        <span class="hjour-node is-start" style="--x:${X0}%;--y:${r1(trailY(X0))}%" aria-hidden="true"></span>
        ${nodes}
        <span class="hjour-pulse" style="--x:${r1(xNow)}%;--y:${r1(yNow)}%" aria-hidden="true"></span>
        <span class="hjour-now" style="--x:${r1(xNow)}%;--y:${r1(yNow)}%" aria-hidden="true"></span>
        <span class="hjour-today ${alignOf(xNow)}" style="--x:${r1(xNow)}%;--y:${r1(yNow)}%" aria-hidden="true">Today</span>
        ${showFrom ? `<span class="hjour-from" style="--x:${X0}%;--y:${r1(trailY(X0))}%" aria-hidden="true">${escHtml(journey.start_words)}</span>` : ""}
        ${labels}
      </div>
      ${axisHtml(start, end, xOf)}
      <div class="hjour-detail" id="hjourDetail" role="status" aria-live="polite" data-hjour-detail>${detailHtml(marks[selected])}</div>
      ${behindHtml(journey)}
    </div>`;
  }

  /** The openers a starter hands chat: a label and the sentence chat opens with. */
  const STARTER_ASKS: ReadonlyArray<readonly [string, string]> = [
    ["A race", "I'm training for a race. Help me set it up: ask me what you need to know."],
    ["A weight goal", "I'd like to set a weight goal. Help me pick a realistic target and a date."],
    ["A stronger lift", "I'd like to set a strength goal for one of my main lifts. Where should I start?"],
    ["Not sure yet", "I'm new to Cairn. Help me get set up: what should I tell you first?"],
  ];
  const DATED_ASKS: ReadonlyArray<readonly [string, string]> = [
    ["Date my goal", "I'd like to give my goal a target date. Help me pick a realistic one."],
    ["A race", "I'm training for a race. Help me set it up: ask me what you need to know."],
  ];

  /**
   * Nothing dated ahead yet: a short trail into open ground and a few openers. With goals
   * already set, the ask is to give one a date; with none, to name one, or just start.
   */
  function starterHtml(opts: { hasGoals?: boolean } = {}): string {
    const asks = (opts.hasGoals ? DATED_ASKS : STARTER_ASKS)
      .map(
        ([label, prompt]) =>
          `<button type="button" class="hjour-ask" data-hjour-ask="${escAttr(prompt)}">${escHtml(label)}</button>`
      )
      .join("");
    const title = opts.hasGoals ? "Give a goal a date" : "Your road starts here";
    const body = opts.hasGoals
      ? "A date turns a goal into a road: the milestones on the way, and how far along you are."
      : "Name something ahead of you (a race, a weight, a lift) and Cairn draws the road to it, with the milestones on the way. Tap one and chat opens with a first sentence you can change.";
    const art = `<svg class="hjour-start-art" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path class="hjour-ahead" d="M8 24 C 30 22, 42 14, 60 15 S 86 9, 97 6"/></svg>`;
    return `<div class="hjour is-starter" data-hjour>
      <div class="hjour-start-plot" aria-hidden="true">${art}<span class="hjour-start-cairn">${cairnGlyph()}</span><span class="hjour-now is-static"></span></div>
      <h4 class="hjour-start-h">${escHtml(title)}</h4>
      <p class="hjour-start-p">${escHtml(body)}</p>
      <div class="hjour-asks">${asks}</div>
      ${opts.hasGoals ? "" : `<p class="hjour-hint">Or simply log today: a workout, a meal, a weigh-in. The trail starts from what you log.</p>`}
    </div>`;
  }

  const CAIRN_JOURNEY_TRAIL = { trailHtml, detailHtml, starterHtml, trailY };

  Object.assign(globalThis, { CairnJourneyTrail: CAIRN_JOURNEY_TRAIL });
}

// @ts-check
// The journey trail, the view (docs/IA.md "Horizon landing" 2): the road from where this
// stretch began, through today, up to the furthest dated goal — drawn to scale in time.
// The walked part is solid dawn over a soft ground wash and draws in once; the road
// ahead is dotted; today breathes; each dated mark sits on the trail in its stone's hue,
// a peak week as a lit stretch of trail, and the summit (the furthest goal) as a small
// cairn. Above it, the server's one line of where the athlete stands; under it, the
// month ticks, the opened mark's own words (the next one by default — tap any labelled
// mark, or its dot, to read it; the opened mark links to its own page) and what has
// already moved toward a goal ("Behind you"), each a stone set in its area's hue.
//
// What the athlete has actually done on this stretch (`walked`) sits ON the walked part as
// small set stones, filled in their area's hue (the marks ahead are hollow), each tappable
// like a mark ahead; what they say, the card and "Behind you" are journey-ground-client.ts.
//
// What makes the road read as ground covered: a small step on the walked part for every
// week since the start (fewer when the weeks would crowd), a far ridge behind the trail,
// and first light behind the summit. Height is the trail's own shape, not a measure: the
// only things the plot encodes are time (left to right) and which side of today a day is.
//
// With no dated mark ahead, the starter: a short trail into open ground and a few
// one-tap openers that hand chat a sentence to start from (never sent for the athlete).
//
// Pure strings over GET /api/week `journey` (week-read.ts journeyOf). Every server word
// is escaped; positions are percentages of the plot, hues come from stone classes in
// src/styles/horizon/journey.css. Which labels fit, the month ticks and the week steps
// are measured against the plot's width in pixels (journey-layout-client.ts; a phone's
// when the width is not known). No score, no percent printed.
//
// LAZY ("horizon" bundle).
{
  type Journey = import("../contracts/week-read.js").WeekReadJourney;
  type Mark = import("../contracts/week-read.js").WeekReadJourneyMark;
  type Stone = import("../contracts/week-read.js").WeekReadJourneyStone;

  // The plot, in percent of its box: the trail runs X0→X1 and climbs from Y_LOW to Y_HIGH,
  // leaving room above and below for labels.
  const X0 = 3;
  const X1 = 95;
  const Y_LOW = 76;
  const Y_HIGH = 34;
  /** Today never sits flush on the start: the walked part always reads. */
  const NOW_MIN_X = 11;
  /** With stones to carry, the walked part takes this much more room per stone… */
  const NOW_PER_STONE = 4;
  /** …up to here. */
  const NOW_STONES_MAX_X = 30;
  /**
   * However long the road walked, the road ahead keeps this much room for its labels: the
   * summit's alone, or the summit's and the next mark's. A long walked part is drawn to a
   * shorter scale than the road ahead, never the other way round.
   */
  const AHEAD_ROOM_ONE = 18;
  const AHEAD_ROOM_MANY = 34;
  /** A week step this close to a stone gives way to it. */
  const STEP_STONE_GAP = 2;
  /** A stone never sits on today's dot. */
  const STONE_NOW_GAP = 2.6;

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
  type PlacedStone = { stone: Stone; index: number; x: number; y: number; hue: string };

  /** A mark's label rank: summit and next first, then race, goal, the rest. */
  function markRank(p: Placed): number {
    return p.mark.summit
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
  }

  function cairnGlyph(): string {
    return `<svg class="hjour-cairn" viewBox="0 0 20 22" aria-hidden="true"><ellipse cx="10" cy="18.5" rx="8" ry="3.3"/><ellipse cx="10.6" cy="12.6" rx="5.8" ry="2.9"/><ellipse cx="9.8" cy="7.4" rx="4" ry="2.4"/><ellipse cx="10.4" cy="3.2" rx="2.4" ry="1.8"/></svg>`;
  }

  /** The month ticks along the ground: every month that has room (journey-layout-client.ts ticksOf). */
  function axisHtml(start: number, end: number, xOf: (d: number) => number, width?: number | null): string {
    const ticks = CairnJourneyLayout.ticksOf(start, end, xOf, width)
      .map((t) => `<span class="hjour-tick" style="--x:${r1(t.x)}%">${MONTHS[t.month]}</span>`)
      .join("");
    return `<div class="hjour-axis" aria-hidden="true">${ticks}</div>`;
  }

  /** The far ridge behind the trail: a low line of hills rising toward the summit (decoration only). */
  function ridgeD(): string {
    // The ridge's rise (an exponent, named so it never reads as a unit factor to the format contract).
    const rise = 1.6;
    const pts: string[] = [];
    for (let x = 0; x <= 100; x += 2.5) {
      const t = x / 100;
      const y = 62 - 30 * t ** rise + 5 * Math.sin(t * Math.PI * 3.3 + 1.1) + 2.5 * Math.sin(t * Math.PI * 7.1);
      pts.push(`${x ? "L" : "M"}${r1(x)} ${r1(y)}`);
    }
    return `${pts.join(" ")} L100 100 L0 100 Z`;
  }

  /** One small step on the walked part per week since the start (fewer when they would crowd); none under today or a stone. */
  function stepsHtml(
    start: number,
    today: number,
    xOf: (d: number) => number,
    opts: { enter: boolean; stones: number[]; width?: number | null }
  ): string {
    const { enter, stones } = opts;
    const weeks = Math.floor((today - start) / 7);
    if (weeks < 1) return "";
    const every = CairnJourneyLayout.stepEvery(weeks, xOf(today) - X0, opts.width);
    const out: string[] = [];
    for (let w = every; w <= weeks; w += every) {
      const d = start + w * 7;
      if (today - d < 3) break;
      const x = xOf(d);
      if (stones.some((s) => Math.abs(s - x) < STEP_STONE_GAP)) continue;
      out.push(
        `<span class="hjour-step" style="--x:${r1(x)}%;--y:${r1(trailY(x))}%${enter ? `;--i:${out.length}` : ""}" aria-hidden="true"></span>`
      );
    }
    return out.join("");
  }

  /** The opened mark's own words: what it is, when, and why it matters. */
  function detailHtml(mark: Mark | null | undefined): string {
    if (!mark) return "";
    const when = [mark.date_words, mark.days_words].filter(Boolean).join(" · ");
    return CairnJourneyGround.cardHtml(STONE[mark.kind] || "endurance", mark.label, when, mark.detail, mark.href);
  }

  /**
   * The trail; "" with nothing ahead to draw. `selected` is the mark index whose words
   * are open (default: the next mark), `stone` a walked stone's instead; `enter` draws the
   * walked part in once.
   */
  function trailHtml(
    journey: Journey | null | undefined,
    opts: { selected?: number; stone?: number | null; enter?: boolean; below?: string; width?: number | null } = {}
  ): string {
    const marks = journey?.marks ?? [];
    if (!journey || !marks.length) return "";
    const start = dayNumber(journey.start_date);
    const today = dayNumber(journey.today);
    const end = Math.max(...marks.map((m) => dayNumber(m.end_date || m.date)));
    if (!Number.isFinite(start) || !Number.isFinite(today) || !(end > start)) return "";
    const said = CairnJourneyGround;
    const lay = CairnJourneyLayout;
    const walked = said.walkedOf(journey, start, today);
    const count = walked.filter(Boolean).length;
    // To scale in time; when today sits at the very start the walked part still reads, and
    // with stones to carry it takes the room they need.
    const lin = (d: number) => X0 + ((d - start) / (end - start)) * (X1 - X0);
    const rawNow = lin(today);
    const perStone = Math.max(NOW_PER_STONE, lay.stoneGap(opts.width) + 0.5);
    const nowMin = count ? Math.min(NOW_STONES_MAX_X, NOW_MIN_X + perStone * count) : NOW_MIN_X;
    const xNow = Math.max(nowMin, Math.min(X1 - (marks.length > 1 ? AHEAD_ROOM_MANY : AHEAD_ROOM_ONE), rawNow));
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
    // The walked stones, newest first: an older one too close to a newer one gives way.
    const stones: PlacedStone[] = [];
    for (let i = walked.length - 1; i >= 0; i--) {
      const stone = walked[i];
      if (!stone) continue;
      const x = Math.max(X0 + 2, Math.min(xNow - STONE_NOW_GAP, xOf(dayNumber(stone.date))));
      if (stones.some((s) => Math.abs(s.x - x) < lay.stoneGap(opts.width))) continue;
      stones.push({ stone, index: i, x, y: trailY(x), hue: said.hueOf(stone) });
    }
    // The start's date sits under the start only when today is far enough along not to crowd it.
    const showFrom = xNow - X0 >= 22;
    // "Today" and the start's date hold their room under the trail first.
    const below = [lay.boxOf(xNow, lay.labelPx("Today", "") - 8, opts.width)];
    if (showFrom) below.push(lay.boxOf(X0, lay.labelPx(journey.start_words, "") - 8, opts.width));
    const taken = { above: [] as ReturnType<typeof lay.boxOf>[], below };
    const sides = lay.placeLabels(
      [...placed]
        .sort((a, b) => markRank(a) - markRank(b) || a.x - b.x)
        .map((p) => ({ index: p.index, x: p.x, px: lay.labelPx(p.mark.days_words, p.mark.short, p.mark.summit) })),
      taken,
      opts.width
    );
    // Then the walked stones, newest first, wherever the marks ahead left room.
    const stoneSides = lay.placeLabels(
      stones.map((p) => ({ index: p.index, x: p.x, px: lay.labelPx(p.stone.date_words, p.stone.short) })),
      taken,
      opts.width
    );
    const stoneOn = opts.stone != null && walked[opts.stone] ? opts.stone : null;
    const selected = stoneOn != null ? -1 : Math.max(0, Math.min(marks.length - 1, opts.selected ?? 0));

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
      <path class="hjour-ridge" d="${ridgeD()}"/>
      <path class="hjour-ground" d="${ground}" fill="url(#hjourGround)"/>
      <path class="hjour-ahead" d="${pathD(xNow, X1)}"/>
      ${bands}
      <path class="hjour-walked" d="${pathD(X0, xNow)}"/>
    </svg>`;

    const nodes = placed
      .map((p) => {
        const stone = STONE[p.mark.kind] || "endurance";
        return p.mark.summit
          ? `<span class="hjour-node is-summit stone-${stone}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--i:${p.index}" data-hjour-mark="${p.index}" aria-hidden="true">${cairnGlyph()}</span>`
          : `<span class="hjour-node is-${escAttr(p.mark.kind)} stone-${stone}${p.index === selected ? " is-on" : ""}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--i:${p.index}" data-hjour-node="${p.index}" data-hjour-mark="${p.index}" aria-hidden="true"></span>`;
      })
      .join("");
    const labels = placed
      .filter((p) => sides.has(p.index))
      .map((p) => {
        const side = sides.get(p.index) === "above" ? "is-above" : "is-below";
        const aria = `${p.mark.label}, ${p.mark.date_words}, ${p.mark.days_words}`;
        return `<button type="button" class="hjour-lbl ${side} ${lay.alignOf(p.x)}${p.mark.summit ? " is-summit" : ""}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--i:${p.index}" data-hjour-mark="${p.index}" aria-pressed="${p.index === selected}" aria-controls="hjourDetail" aria-label="${escAttr(aria)}"><small>${escHtml(p.mark.days_words)}</small><b>${escHtml(p.mark.short)}</b></button>`;
      })
      .join("");
    // Each stone settles once the walked line has reached it, oldest first.
    const settle = (x: number) => `${(0.3 + ((x - X0) / (X1 - X0)) * 1.2).toFixed(2)}s`;
    const stoneNodes = stones
      .map(
        (p) =>
          `<span class="hjour-stone stone-${p.hue}${p.index === stoneOn ? " is-on" : ""}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--d:${settle(p.x)}" data-hjour-node="s${p.index}" data-hjour-mark="s${p.index}" aria-hidden="true"></span>`
      )
      .join("");
    const stoneLabels = stones
      .filter((p) => stoneSides.has(p.index))
      .map((p) => {
        const side = stoneSides.get(p.index) === "above" ? "is-above" : "is-below";
        return `<button type="button" class="hjour-lbl is-walked ${side} ${lay.alignOf(p.x)}" style="--x:${r1(p.x)}%;--y:${r1(p.y)}%;--d:${settle(p.x)}" data-hjour-mark="s${p.index}" aria-pressed="${p.index === stoneOn}" aria-controls="hjourDetail" aria-label="${escAttr(p.stone.words)}"><small>${escHtml(p.stone.date_words)}</small><b>${escHtml(p.stone.short)}</b></button>`;
      })
      .join("");
    const summit = marks.find((m) => m.summit) ?? marks[marks.length - 1];
    const summitAt = placed.find((p) => p.mark === summit) ?? placed[placed.length - 1];
    const aria = `Your road from ${journey.start_words} through today to ${summit.label}, ${summit.date_words}`;
    return `<div class="hjour${opts.enter ? " is-drawing" : ""}" data-hjour>
      ${journey.line ? `<p class="hjour-line">${escHtml(journey.line)}</p>` : ""}
      <div class="hjour-plot" role="img" aria-label="${escAttr(aria)}">
        ${svg}
        <span class="hjour-dawn" style="--x:${r1(summitAt.x)}%;--y:${r1(summitAt.y)}%" aria-hidden="true"></span>
        ${stepsHtml(start, today, xOf, { enter: !!opts.enter, stones: stones.map((p) => p.x), width: opts.width })}
        <span class="hjour-node is-start" style="--x:${X0}%;--y:${r1(trailY(X0))}%" aria-hidden="true"></span>
        ${nodes}
        ${stoneNodes}
        <span class="hjour-pulse" style="--x:${r1(xNow)}%;--y:${r1(yNow)}%" aria-hidden="true"></span>
        <span class="hjour-now" style="--x:${r1(xNow)}%;--y:${r1(yNow)}%" aria-hidden="true"></span>
        <span class="hjour-today ${lay.alignOf(xNow)}" style="--x:${r1(xNow)}%;--y:${r1(yNow)}%" aria-hidden="true">Today</span>
        ${showFrom ? `<span class="hjour-from" style="--x:${X0}%;--y:${r1(trailY(X0))}%" aria-hidden="true">${escHtml(journey.start_words)}</span>` : ""}
        ${labels}
        ${stoneLabels}
      </div>
      ${axisHtml(start, end, xOf, opts.width)}
      <div class="hjour-detail" id="hjourDetail" role="status" aria-live="polite" data-hjour-detail>${stoneOn != null ? said.stoneDetailHtml(walked[stoneOn]) : detailHtml(marks[selected])}</div>
      ${said.behindHtml(
        journey,
        walked.filter((s): s is Stone => !!s)
      )}
      ${opts.below || ""}
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

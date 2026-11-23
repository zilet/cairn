// @ts-check
// Your road, the room on the plot (docs/DESIGN.md "Your road"): where today sits, which
// labels fit and on which side, which week steps and month ticks are drawn. Pure geometry
// over percentages of the plot, measured against its width in pixels — the width the
// controller read off the page, else a 360 px phone's (the narrowest the page is laid out
// for), so the first paint never assumes room a phone does not have.
//
// A label is two lines (a mono "when" over the mark's short word) and is as wide as its
// longer line; two labels on one side may not overlap, nor sit on "Today" or the start's
// date. The label is the tap target (a button at least 44 px tall, docs/DESIGN.md), so a
// label that does not fit is left off rather than squeezed.
//
// LAZY ("horizon" bundle); journey-trail-client.ts draws with it.
{
  type Side = "above" | "below";
  type Box = { lo: number; hi: number };

  /** The plot's width on a 360 px phone, less its two 16 px gutters. */
  const PLOT_PX_PHONE = 328;
  /** One uppercase Martian Mono character at --text-2xs (.62rem), with its tracking. */
  const MONO_PX = 7.8;
  /** One Young Serif character at --text-md (.88rem); the summit's at --text-lead. */
  const WORD_PX = 8.4;
  const SUMMIT_PX = 10;
  /** A label's side padding (--space-3 twice). */
  const LABEL_PAD_PX = 12;
  /** The least room between two labels on one side. */
  const LABEL_MARGIN_PX = 4;
  /** How far an edge-aligned label reaches past its mark (the CSS translate). */
  const EDGE_PX = 10;
  /** The least room between two month ticks. */
  const TICK_GAP_PX = 40;
  /** The least room between two week steps. */
  const STEP_GAP_PX = 9;

  function plotPx(width?: number | null): number {
    return Number(width) > 120 ? Number(width) : PLOT_PX_PHONE;
  }

  /** "left" near the start, "right" near the summit, else centred on its mark. */
  function alignOf(x: number): string {
    return x < 14 ? "is-l" : x > 84 ? "is-r" : "is-c";
  }

  /** A label's width in pixels, from its two lines. */
  function labelPx(small: string, word: string, summit = false): number {
    const top = String(small ?? "").length * MONO_PX;
    const main = String(word ?? "").length * (summit ? SUMMIT_PX : WORD_PX);
    return Math.ceil(Math.max(top, main) + LABEL_PAD_PX);
  }

  /** The stretch of the plot (percent) a label of `px` at `x` covers, by its alignment. */
  function boxOf(x: number, px: number, width?: number | null): Box {
    const w = (px / plotPx(width)) * 100;
    const edge = (EDGE_PX / plotPx(width)) * 100;
    const align = alignOf(x);
    if (align === "is-l") return { lo: x - edge, hi: x - edge + w };
    if (align === "is-r") return { lo: x + edge - w, hi: x + edge };
    return { lo: x - w / 2, hi: x + w / 2 };
  }

  /**
   * Which spots get a label, and on which side, in `order` (each takes the first side with
   * room): a label fits a side when its box clears every box already there by a margin.
   * `taken` carries the room already spoken for ("Today", the start's date, the marks
   * ahead), so the walked stones' labels fill only what is left.
   */
  function placeLabels(
    order: ReadonlyArray<{ index: number; x: number; px: number }>,
    taken: Record<Side, Box[]>,
    width?: number | null
  ): Map<number, Side> {
    const margin = (LABEL_MARGIN_PX / plotPx(width)) * 100;
    const out = new Map<number, Side>();
    for (const p of order) {
      const box = boxOf(p.x, p.px, width);
      const fits = (side: Side) => taken[side].every((b) => box.hi + margin <= b.lo || box.lo - margin >= b.hi);
      const side: Side | null = fits("above") ? "above" : fits("below") ? "below" : null;
      if (!side) continue;
      taken[side].push(box);
      out.set(p.index, side);
    }
    return out;
  }

  /** The month ticks to draw: each first of a month on the plot, never closer than TICK_GAP_PX to the last. */
  function ticksOf(
    start: number,
    end: number,
    xOf: (d: number) => number,
    width?: number | null
  ): Array<{ x: number; month: number }> {
    const gap = (TICK_GAP_PX / plotPx(width)) * 100;
    const s = new Date(start * 864e5);
    const out: Array<{ x: number; month: number }> = [];
    let y = s.getUTCFullYear();
    let m = s.getUTCMonth() + 1;
    for (let guard = 0; guard < 26; guard++) {
      if (m > 11) {
        m -= 12;
        y += 1;
      }
      const d = Date.UTC(y, m, 1) / 864e5;
      if (d > end) break;
      const x = xOf(d);
      const last = out[out.length - 1];
      if (x > 9 && x < 92 && (!last || x - last.x >= gap)) out.push({ x, month: m });
      m += 1;
    }
    return out;
  }

  /**
   * Every how many weeks a step is drawn on a walked part `walkedPct` wide holding `weeks`
   * weeks: every week while the steps stay STEP_GAP_PX apart, else every second, third….
   */
  function stepEvery(weeks: number, walkedPct: number, width?: number | null): number {
    if (!(weeks > 0) || !(walkedPct > 0)) return 1;
    const perWeekPx = ((walkedPct / 100) * plotPx(width)) / weeks;
    return Math.max(1, Math.ceil(STEP_GAP_PX / Math.max(perWeekPx, 0.01)));
  }

  /** How close two stones may sit (percent) before the older gives way: two stones (11 px) keep a hair of ground between them. */
  function stoneGap(width?: number | null): number {
    return Math.max(3.2, (14 / plotPx(width)) * 100);
  }

  const CAIRN_JOURNEY_LAYOUT = { alignOf, labelPx, boxOf, placeLabels, ticksOf, stepEvery, stoneGap, plotPx };

  Object.assign(globalThis, { CairnJourneyLayout: CAIRN_JOURNEY_LAYOUT });
}

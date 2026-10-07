// @ts-check
// The frame line, the view (docs/IA.md "Horizon landing" 1): the week's frame as ONE
// hero — the server's headline ("26 days to Cambridge Half") over its one line
// ("Sharpen · block week 6 of 6 · push through Nov 15"), both printed VERBATIM from
// GET /api/week's `frame` (week-stage.ts weekFrameLine, the single source of stage
// words). Horizon's Week leads with it and To the race wears it as its hero, so the two
// can never say the stage two ways.
//
// Under it, a small block ribbon: one step per week of the block, the weeks behind
// filled, this week ringed in dawn, and race day named at its end — drawn from the
// frame's own block count, labelled in the server's words. No number is printed.
//
// LAZY ("calendar" bundle).
{
  type Frame = import("../contracts/week-read.js").WeekReadFrame;

  /** The most steps the ribbon draws (a longer block would crowd a phone). */
  const MAX_STEPS = 12;

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cap(s: string): string {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /** The block as steps, this week ringed; "" with no block to draw. */
  function ribbonHtml(frame: Frame | null | undefined): string {
    const block = frame?.block;
    const of = Number(block?.of);
    const week = Number(block?.week);
    if (!block || !Number.isInteger(of) || !Number.isInteger(week) || of < 2 || of > MAX_STEPS || week < 1 || week > of)
      return "";
    const steps = Array.from({ length: of }, (_, i) => {
      const state = i + 1 < week ? "is-done" : i + 1 === week ? "is-now" : "is-ahead";
      return `<span class="frameline-step ${state}"></span>`;
    }).join("");
    const race = frame?.countdown ? text(frame.countdown.race_date_words) : "";
    const end = race ? `<span class="frameline-end">${escHtml(`Race · ${race}`)}</span>` : "";
    return `<div class="frameline-ribbon"><span class="frameline-steps" role="img" aria-label="${escAttr(cap(text(block.words)))}">${steps}</span>${end}</div>`;
  }

  /**
   * The hero: an optional mono kicker, the serif headline, the one line, the ribbon.
   * "" when the frame has no headline (the caller keeps its own header then).
   */
  function heroHtml(
    frame: Frame | null | undefined,
    opts: { kicker?: string; id?: string; ribbon?: boolean } = {}
  ): string {
    const headline = text(frame?.headline);
    if (!frame || !headline) return "";
    const line = text(frame.line);
    const id = opts.id ? ` id="${escAttr(opts.id)}"` : "";
    const stage = frame.stage?.key ? ` is-${escAttr(frame.stage.key)}` : "";
    return `<header class="frameline${stage}">
      ${opts.kicker ? `<span class="lbl frameline-k">${escHtml(opts.kicker)}</span>` : ""}
      <h2 class="frameline-h"${id}>${escHtml(headline)}</h2>
      ${line ? `<p class="frameline-l">${escHtml(line)}</p>` : ""}
      ${opts.ribbon === false ? "" : ribbonHtml(frame)}
    </header>`;
  }

  const CAIRN_FRAME_LINE = { heroHtml, ribbonHtml };

  Object.assign(globalThis, { CairnFrameLine: CAIRN_FRAME_LINE });
}

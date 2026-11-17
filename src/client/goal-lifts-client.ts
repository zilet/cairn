// @ts-check
// The strength goal row's lift stack (docs/IA.md "Horizon landing", "Where you stand"): when
// the athlete holds several lift goals the server sends ONE strength row carrying `lifts`,
// and this draws them under its header, one line each: the lift's name over its direction
// word, a thin version of the goal row's track (start mark, a ring four weeks back, the now
// dot, the goal mark; a lift behind its start fills leftwards), and its now on the right.
// No start/goal captions (too dense): each line carries one hidden sentence instead, so the
// row's link reads every lift aloud (the drawn spans are hidden from assistive tech).
//
// Deterministic strings over CairnGoalRowModel's lift rows; every word escaped, positions
// are data-only custom properties, no colour written here (the hue is the row's stone class).
//
// LAZY ("horizon" bundle).
{
  const n = (v: number): string => escAttr(String(v));

  /** A line's spoken sentence: the lift, its now, its goal and where it is heading, in words. */
  function liftSaid(lift: ClientGoalLift): string {
    const parts = [lift.now, lift.goal ? `goal ${lift.goal}` : "", lift.direction_words.toLowerCase()];
    return `${lift.label}, ${parts.filter(Boolean).join(", ")}`;
  }

  /** The thin thread: rail, fill toward now, start and goal ticks, the ring a month back, the now dot. */
  function threadHtml(lift: ClientGoalLift): string {
    const g = lift.geometry;
    if (!g) return `<span class="goallift-thread is-empty" aria-hidden="true"></span>`;
    const ring = g.ago == null ? "" : `<span class="goalrow-ring" style="--x:${n(g.ago)}"></span>`;
    return `<span class="goallift-thread" aria-hidden="true">
        <span class="goalrow-rail"></span>
        <span class="goalrow-tfill is-from-${g.origin}" style="--l:${n(g.fill_left)};--w:${n(g.fill_width)}"></span>
        <span class="goalrow-tick is-start" style="--x:${n(g.start)}"></span>
        <span class="goalrow-tick is-goal" style="--x:${n(g.goal)}"></span>
        ${ring}<span class="goalrow-now" style="--x:${n(g.now)}"></span>
      </span>`;
  }

  function liftHtml(lift: ClientGoalLift): string {
    const dir = lift.direction_words
      ? `<small class="goallift-dir${lift.direction ? ` is-${escAttr(lift.direction)}` : ""}">${escHtml(lift.direction_words)}</small>`
      : "";
    return `<li class="goallift" data-goal-lift="${escAttr(lift.id)}">
      <span class="sr-only">${escHtml(liftSaid(lift))}. </span>
      <span class="goallift-name" aria-hidden="true"><span class="goallift-label">${escHtml(lift.label)}</span>${dir}</span>
      ${threadHtml(lift)}
      <span class="goallift-num num" aria-hidden="true">${escHtml(lift.now)}</span>
    </li>`;
  }

  /** The stack under the strength row's header; "" with no lifts. */
  function stackHtml(row: ClientGoalRow): string {
    const lifts = row.lifts || [];
    if (!lifts.length) return "";
    return `<ul class="goallift-list">${lifts.map(liftHtml).join("")}</ul>`;
  }

  const CAIRN_GOAL_LIFTS = { stackHtml, liftSaid };

  Object.assign(globalThis, { CairnGoalLifts: CAIRN_GOAL_LIFTS });
}

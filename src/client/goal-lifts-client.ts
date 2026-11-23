// @ts-check
// The strength goal row's lift stack (docs/IA.md "Horizon landing", "Where you stand"): when
// the athlete holds several lift goals the server sends ONE strength row carrying `lifts`,
// and this draws them under its header, one line each: the lift's name over its direction
// word, a thin version of the goal row's track (start mark, a ring four weeks back, the now
// dot, the goal mark; a lift behind its start fills leftwards), and its now on the right.
// No start/goal captions (too dense): each line carries one hidden sentence instead, so the
// row's link reads every lift aloud (the drawn spans are hidden from assistive tech).
// A lift may carry one quiet line under it: the measure of its move ("4 lb up since Oct 25"),
// the goal it carries through a plan swap ("Carries your Pendlay Row goal since Nov 13") and
// what is next ("Next session: 3 × 5–8 at 145 lb").
//
// Deterministic strings over CairnGoalRowModel's lift rows; every word escaped, positions
// are data-only custom properties, no colour written here (the hue is the row's stone class).
//
// LAZY ("horizon" bundle).
{
  const n = (v: number): string => escAttr(String(v));

  /** A line's spoken sentence: the lift, its now, its goal and where it is heading, in words. */
  function liftSaid(lift: ClientGoalLift): string {
    const dir = lift.direction_words ? `${lift.direction_words.charAt(0).toLowerCase()}${lift.direction_words.slice(1)}` : "";
    // A read that already names the goal in its direction words is not told twice.
    const goalSaid = lift.goal && !(lift.direction_words || "").includes(lift.goal) ? `goal ${lift.goal}` : "";
    const parts = [lift.now, goalSaid, dir, lift.direction_words ? lift.move_words : ""];
    return `${lift.label}, ${parts.filter(Boolean).join(", ")}${lift.note ? `. ${lift.note}` : ""}`;
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
        ${g.mark == null ? "" : `<span class="goalrow-mark" style="--x:${n(g.mark)}"></span>`}${ring}<span class="goalrow-now" style="--x:${n(g.now)}"></span>
      </span>`;
  }

  function liftHtml(lift: ClientGoalLift): string {
    const dir = lift.direction_words
      ? `<small class="goallift-dir${lift.direction ? ` is-${escAttr(lift.direction)}` : ""}">${escHtml(lift.direction_words)}</small>`
      : "";
    // The quiet line under the thread, full width: the measure of the move, then the note.
    const under = [lift.direction_words ? lift.move_words : "", lift.note].filter(Boolean).join(" · ");
    return `<li class="goallift" data-goal-lift="${escAttr(lift.id)}">
      <span class="sr-only">${escHtml(liftSaid(lift))}. </span>
      <span class="goallift-name" aria-hidden="true"><span class="goallift-label">${escHtml(lift.label)}</span>${dir}</span>
      ${threadHtml(lift)}
      <span class="goallift-num num" aria-hidden="true">${escHtml(lift.now)}</span>
      ${under ? `<small class="goallift-note" aria-hidden="true">${escHtml(under)}</small>` : ""}
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

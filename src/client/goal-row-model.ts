// @ts-check
// The goal row, the model (docs/IA.md "Horizon landing", "Where you stand"): one goal,
// compact — the race estimate WITH its time, the weight on its one trend, the anchor
// lift — shaped for ONE row view (goal-row-client.ts) that Horizon's Week and its Season
// both draw. Pure: a GET /api/week `goals[]` entry in, a row out. The numbers are the
// server's own text in the athlete's units.
//
// Two pictures, by what the read carries:
//   - the TRACK (`goal.track`): one axis 0..1 with the start, about four weeks ago, now
//     and the goal on it, and the move said in words ("Moving toward · 43 s faster in four
//     weeks"). `trackGeometry` turns it into percentages for the view; the start need not
//     sit at 0, and a thread now behind its start draws its fill leftwards from the start.
//   - the METER (`goal.progress`, an older read): start → goal filled to now, its place
//     said in a word ("Past halfway", the race's fit word). Never a percent, never a grade.
//
// LAZY ("horizon" bundle).
{
  type WeekGoal = import("../contracts/week-read.js").WeekReadGoal;

  const STONE: Readonly<Record<string, ClientRowStone>> = { race: "endurance", weight: "body", strength: "strength" };
  /** The race's fit, the race view's own three words (race-view-model.ts). */
  const FIT_WORD: Readonly<Record<string, string>> = {
    fits: "Fits",
    stretch: "Stretch",
    beyond_horizon: "Beyond horizon",
  };
  const DIRECTIONS: ReadonlySet<string> = new Set(["toward", "holding", "back", "reached"]);
  /** A ring this close to the start (on a 0..1 axis) says nothing the start mark does not. */
  const SAME = 0.004;

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function fraction(value: unknown): number | null {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  }

  /** How much of the way is behind, in words: a place on the road, never a score. */
  function progressWord(fill: number | null): string {
    if (fill == null) return "";
    if (fill >= 1) return "Reached";
    if (fill >= 0.75) return "Most of the way";
    if (fill >= 0.5) return "Past halfway";
    if (fill >= 0.25) return "On the way";
    return "Early on";
  }

  /** The served track, each position held to the axis; null when any of start, now, goal is missing. */
  function trackOf(value: unknown): ClientGoalTrack | null {
    const t = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    if (!t) return null;
    const start = fraction(t.start);
    const now = fraction(t.now);
    const goal = fraction(t.goal);
    if (start == null || now == null || goal == null) return null;
    const ago = fraction(t.ago);
    return { start, now, goal, ago: ago == null || Math.abs(ago - start) < SAME ? null : ago };
  }

  const pct = (v: number): number => Math.round(v * 1000) / 10;

  /**
   * The track as percentages of its width, for the view: each mark's place, and the fill
   * between start and now with the side it grows from (the start's), so it grows TOWARD
   * now — leftwards when now has fallen behind the start.
   */
  function trackGeometry(track: ClientGoalTrack): ClientGoalTrackGeometry {
    const lo = Math.min(track.start, track.now);
    const hi = Math.max(track.start, track.now);
    return {
      start: pct(track.start),
      now: pct(track.now),
      goal: pct(track.goal),
      ago: track.ago == null ? null : pct(track.ago),
      fill_left: pct(lo),
      fill_width: pct(hi - lo),
      origin: track.now < track.start ? "right" : "left",
    };
  }

  /** An in-app link the server named; anything else is no link. */
  function hrefOf(value: unknown): string | null {
    const s = text(value);
    return /^\/app\/[^\s"'<>\\]*$/.test(s) ? s : null;
  }

  /** One lift of the strength row as its mini thread; null without a label or a now. */
  function liftOf(value: unknown): ClientGoalLift | null {
    const l = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    const label = text(l?.label);
    const now = text(l?.now_text);
    if (!l || !label || !now) return null;
    const direction = DIRECTIONS.has(text(l.direction)) ? text(l.direction) : "";
    const track = trackOf(l.track);
    return {
      id: text(l.id) || label,
      label,
      now,
      goal: text(l.goal_text),
      track,
      geometry: track ? trackGeometry(track) : null,
      direction,
      direction_words: text(l.direction_words),
      move_words: text(l.move_words),
    };
  }

  /** A goal of GET /api/week as its row; null without a label or a now. */
  function fromWeekRead(value: unknown): ClientGoalRow | null {
    const g = value && typeof value === "object" ? (value as WeekGoal) : null;
    const label = text(g?.label);
    const now = text(g?.now_text);
    if (!g || !label || !now) return null;
    const fill = fraction(g.progress);
    const fit = g.key === "race" ? text(g.fit) : "";
    const directionWords = text(g.direction_words);
    const direction = DIRECTIONS.has(text(g.direction)) ? text(g.direction) : "";
    // The direction leads when the read says it; the fit word (and the meter's place word)
    // only stand in for an older read that has none.
    const word = directionWords || (fit && FIT_WORD[fit]) || progressWord(fill);
    const tone = directionWords ? direction : fit && FIT_WORD[fit] ? fit : fill != null && fill >= 1 ? "reached" : "";
    const lifts = Array.isArray(g.lifts) ? g.lifts.map(liftOf).filter((l): l is ClientGoalLift => l != null) : [];
    return {
      key: text(g.key) || "goal",
      stone: STONE[text(g.key)] || "body",
      label,
      now,
      goal: text(g.goal_text),
      line: text(g.line),
      fill,
      word,
      tone,
      track: trackOf(g.track),
      start_text: text(g.start_text),
      goal_words: text(g.goal_words) || text(g.goal_text),
      ago_words: text(g.track?.ago_words),
      direction,
      direction_words: directionWords,
      move_words: text(g.move_words),
      href: hrefOf(g.href),
      lifts,
    };
  }

  const CAIRN_GOAL_ROW_MODEL = { fromWeekRead, progressWord, trackGeometry };

  Object.assign(globalThis, { CairnGoalRowModel: CAIRN_GOAL_ROW_MODEL });
}

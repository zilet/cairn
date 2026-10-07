// @ts-check
// The goal row, the model (docs/IA.md "Horizon landing" 5): one goal, compact — the race
// estimate WITH its time, the weight on its one trend, the anchor lift — shaped for ONE
// row view (goal-row-client.ts) that Horizon's Week and its Season both draw. Pure: a
// GET /api/week `goals[]` entry in, a row out. The numbers are the server's own text in
// the athlete's units; the meter's fill is the server's `progress` (start → goal), and
// it is said in WORDS — never a percent, never a grade. The race speaks its fit word.
//
// LAZY ("calendar" bundle).
{
  type WeekGoal = import("../contracts/week-read.js").WeekReadGoal;

  const STONE: Readonly<Record<string, ClientRowStone>> = { race: "endurance", weight: "body", strength: "strength" };
  /** The race's fit, the race view's own three words (race-view-model.ts). */
  const FIT_WORD: Readonly<Record<string, string>> = {
    fits: "Fits",
    stretch: "Stretch",
    beyond_horizon: "Beyond horizon",
  };

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

  /** A goal of GET /api/week as its row; null without a label or a now. */
  function fromWeekRead(value: unknown): ClientGoalRow | null {
    const g = value && typeof value === "object" ? (value as WeekGoal) : null;
    const label = text(g?.label);
    const now = text(g?.now_text);
    if (!g || !label || !now) return null;
    const fill = fraction(g.progress);
    const fit = g.key === "race" ? text(g.fit) : "";
    const word = (fit && FIT_WORD[fit]) || progressWord(fill);
    const tone = fit && FIT_WORD[fit] ? fit : fill != null && fill >= 1 ? "reached" : "";
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
    };
  }

  const CAIRN_GOAL_ROW_MODEL = { fromWeekRead, progressWord };

  Object.assign(globalThis, { CairnGoalRowModel: CAIRN_GOAL_ROW_MODEL });
}

// @ts-check
// The goal row, the view (docs/IA.md "Horizon landing" 5): the row Today's Path card drew
// for a thread (a stone-hue dot, the name with ONE muted line, the real number in its
// unit), lifted here so Horizon's Week and its Season draw a goal the same way — plus a
// calm meter: the start → goal track filled to where the goal stands, the goal's own
// mark at its end, and the place said in a word ("Past halfway", the race's "Fits").
// Never a percent, never a grade; a goal with no track draws no meter.
//
// Deterministic strings over CairnGoalRowModel's rows: every word escaped, the fill a
// data-only custom property, no colour written here (the hue is the `stone-<key>` class).
//
// LAZY ("calendar" bundle).
{
  /** The meter: a filled track with the goal's mark, its place said in the label and a word. */
  function meterHtml(row: ClientGoalRow): string {
    if (row.fill == null) return "";
    const w = Math.round(row.fill * 1000) / 1000;
    const said = [`${row.label}: ${row.now} now`, row.goal ? `goal ${row.goal}` : "", row.word.toLowerCase()]
      .filter(Boolean)
      .join(", ");
    const goal = row.goal ? `<span class="goalrow-goal">${escHtml(`goal ${row.goal}`)}</span>` : "";
    return `<div class="goalrow-meter">
      <span class="goalrow-track" role="img" aria-label="${escAttr(said)}"><span class="goalrow-fill" style="--w:${escAttr(String(w))}"></span><span class="goalrow-end" aria-hidden="true"></span></span>
      <span class="goalrow-meta" aria-hidden="true"><span class="goalrow-word${row.tone ? ` is-${escAttr(row.tone)}` : ""}">${escHtml(row.word)}</span>${goal}</span>
    </div>`;
  }

  /** One goal: dot, name over its one line, the number; the meter under them when it has a track. */
  function rowHtml(row: ClientGoalRow): string {
    // With no meter the goal and the word ride the muted line instead.
    const tail = row.fill == null ? [row.word, row.goal ? `goal ${row.goal}` : ""].filter(Boolean).join(" · ") : "";
    const line = [row.line, tail].filter(Boolean).join(" · ");
    return `<li class="goalrow is-${escAttr(row.key)} stone-${escAttr(row.stone)}" data-goal-row="${escAttr(row.key)}">
      <span class="goalrow-dot" aria-hidden="true"></span>
      <div class="goalrow-name">${escHtml(row.label)}${line ? `<small>${escHtml(line)}</small>` : ""}</div>
      <span class="goalrow-num num">${escHtml(row.now)}</span>
      ${meterHtml(row)}
    </li>`;
  }

  /** The goals as one list; "" with none. */
  function listHtml(rows: ReadonlyArray<ClientGoalRow | null | undefined>, opts: { label?: string } = {}): string {
    const list = rows.filter((r): r is ClientGoalRow => !!r);
    if (!list.length) return "";
    return `<ul class="goalrow-list" aria-label="${escAttr(opts.label || "Goals")}">${list.map(rowHtml).join("")}</ul>`;
  }

  const CAIRN_GOAL_ROW = { rowHtml, listHtml };

  Object.assign(globalThis, { CairnGoalRow: CAIRN_GOAL_ROW });
}

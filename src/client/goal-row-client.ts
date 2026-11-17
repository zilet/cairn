// @ts-check
// The goal row, the view (docs/IA.md "Horizon landing", "Where you stand"): the row
// Today's Path card drew for a thread (a stone-hue dot, the name over ONE words line, the
// real number in its unit), drawn the same on Horizon's Week and its Season.
//
// With a track (`row.track`, the current read) the row draws the thread: a rail, a fill
// between the start and now (growing from the start's side toward now, leftwards when now
// has fallen behind the start), a tick at the start and at the goal, a hollow ring where it
// stood about four weeks ago, a solid dot at now, and the two ends in words under it
// ("183 lb · Jun 6", "148 lb · Feb 14"). The words line is the direction in the stone's
// deep hue and the plain measure of the move ("Moving toward · 43 s faster in four
// weeks"). Without one (an older read) it keeps the calm meter and its place word. Never a
// percent, never a grade. A row with a page (`row.href`) is a real link with a chevron,
// carrying `data-horizon-href` for the Horizon controller to route.
//
// Deterministic strings over CairnGoalRowModel's rows: every word escaped, positions are
// data-only custom properties, no colour written here (the hue is the `stone-<key>` class).
//
// LAZY ("horizon" bundle).
{
  const n = (v: number): string => escAttr(String(v));

  /** The older meter: a filled track with the goal's mark, its place said in the label and a word. */
  function meterHtml(row: ClientGoalRow): string {
    if (row.fill == null) return "";
    const w = Math.round(row.fill * 1000) / 1000;
    const said = [`${row.label}: ${row.now} now`, row.goal ? `goal ${row.goal}` : "", row.word.toLowerCase()]
      .filter(Boolean)
      .join(", ");
    const goal = row.goal ? `<span class="goalrow-goal">${escHtml(`goal ${row.goal}`)}</span>` : "";
    return `<div class="goalrow-meter">
      <span class="goalrow-track" role="img" aria-label="${escAttr(said)}"><span class="goalrow-fill" style="--w:${n(w)}"></span><span class="goalrow-end" aria-hidden="true"></span></span>
      <span class="goalrow-meta" aria-hidden="true"><span class="goalrow-word${row.tone ? ` is-${escAttr(row.tone)}` : ""}">${escHtml(row.word)}</span>${goal}</span>
    </div>`;
  }

  /** The track's accessible name: start, about four weeks ago, now, goal and direction, in words. */
  function trackSaid(row: ClientGoalRow): string {
    const start = row.start_text ? `started at ${row.start_text}` : "";
    const goal = row.goal_words ? `goal ${row.goal_words}` : "";
    const since = row.track?.ago != null && row.ago_words ? ` compared with ${row.ago_words}` : "";
    const dir = row.direction_words ? `${row.direction_words.toLowerCase()}${since}` : row.word.toLowerCase();
    const move = row.direction_words && row.move_words ? `, ${row.move_words}` : "";
    const parts = [start, `now ${row.now}`, goal, dir ? `${dir}${move}` : ""].filter(Boolean);
    return `${row.label}: ${parts.join("; ")}`;
  }

  /** The drawn thread: rail, fill toward now, start and goal ticks, the ring a month back, the now dot. */
  function trackHtml(row: ClientGoalRow): string {
    if (!row.track) return "";
    const g = CairnGoalRowModel.trackGeometry(row.track);
    const ring = g.ago == null ? "" : `<span class="goalrow-ring" style="--x:${n(g.ago)}"></span>`;
    const ends =
      row.start_text || row.goal_words
        ? `<span class="goalrow-ends" aria-hidden="true"><span>${escHtml(row.start_text)}</span><span>${escHtml(row.goal_words)}</span></span>`
        : "";
    return `<span class="goalrow-thread" role="img" aria-label="${escAttr(trackSaid(row))}">
        <span class="goalrow-rail"></span>
        <span class="goalrow-tfill is-from-${g.origin}" style="--l:${n(g.fill_left)};--w:${n(g.fill_width)}"></span>
        <span class="goalrow-tick is-start" style="--x:${n(g.start)}"></span>
        <span class="goalrow-tick is-goal" style="--x:${n(g.goal)}"></span>
        ${ring}<span class="goalrow-now" style="--x:${n(g.now)}"></span>
      </span>${ends}`;
  }

  /** The row's one words line: the direction in the stone's deep hue and its measure; else the older line. */
  function wordsHtml(row: ClientGoalRow): string {
    if (row.direction_words) {
      const dir = `<b class="goalrow-dir${row.direction ? ` is-${escAttr(row.direction)}` : ""}">${escHtml(row.direction_words)}</b>`;
      return `<small class="goalrow-words">${dir}${row.move_words ? ` · ${escHtml(row.move_words)}` : ""}</small>`;
    }
    // With no meter and no track the goal and the word ride the muted line instead.
    const bare = row.fill == null && !row.track;
    const tail =
      bare || row.track ? [row.word, bare && row.goal ? `goal ${row.goal}` : ""].filter(Boolean).join(" · ") : "";
    const line = [row.line, tail].filter(Boolean).join(" · ");
    return line ? `<small>${escHtml(line)}</small>` : "";
  }

  /** One goal: dot, name over its words, the number; the track (or the older meter) under them. */
  function rowHtml(row: ClientGoalRow): string {
    const chev = row.href ? `<span class="goalrow-chev" aria-hidden="true">›</span>` : "";
    const inner = `<span class="goalrow-dot" aria-hidden="true"></span>
      <div class="goalrow-name">${escHtml(row.label)}${wordsHtml(row)}</div>
      <span class="goalrow-num num">${escHtml(row.now)}${chev}</span>
      ${row.track ? trackHtml(row) : meterHtml(row)}`;
    const body = row.href
      ? `<a class="goalrow-body goalrow-link" href="${escAttr(row.href)}" data-horizon-href>${inner}</a>`
      : `<div class="goalrow-body">${inner}</div>`;
    const cls = ["goalrow", `is-${escAttr(row.key)}`, `stone-${escAttr(row.stone)}`, row.track ? "has-track" : ""]
      .filter(Boolean)
      .join(" ");
    return `<li class="${cls}" data-goal-row="${escAttr(row.key)}">${body}</li>`;
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

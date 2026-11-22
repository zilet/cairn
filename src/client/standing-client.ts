// @ts-check
// "The whole picture", the view (docs/IA.md "Horizon landing"): one calm row per area a coach
// looks at, under the goal rows. Collapsed, a row is a stone mark, its label, the direction
// word (and its window) and the server's one sentence. A row with lines is a native
// <details>: opened, each line says its label, its now and its direction, then one quiet
// line of the move and its note. An invite is one quiet line under the row. No bar, meter,
// percent or good/bad colour: direction is a word, and the hue is the stone's (identity,
// never state).
//
// Deterministic strings over CairnStandingModel's rows: every word escaped, no colour or
// position written here. A row's spoken sentence leads for assistive tech (the drawn text is
// hidden); a row that links keeps its label as the link instead.
//
// LAZY ("horizon" bundle).
{
  function lineHtml(line: ClientStandingLine): string {
    const dir = line.direction_words
      ? ` <small class="standing-dir${line.direction ? ` is-${escAttr(line.direction)}` : ""}">${escHtml(line.direction_words)}</small>`
      : "";
    const now = line.now ? ` <span class="num">${escHtml(line.now)}</span>` : "";
    const tail = line.tail ? `<small class="standing-tail">${escHtml(line.tail)}</small>` : "";
    return `<li class="standing-line" data-standing-line="${escAttr(line.id)}"><span class="standing-lname">${escHtml(line.label)}</span>${now}${dir}${tail}</li>`;
  }

  /** The row's collapsed line: label (a link with a page), direction and window, then its sentence. */
  function headHtml(row: ClientStandingRow): string {
    const label = row.href
      ? `<a class="standing-label" href="${escAttr(row.href)}" data-horizon-href>${escHtml(row.label)}</a>`
      : `<span class="standing-label">${escHtml(row.label)}</span>`;
    const dir = row.direction_words
      ? ` <b class="standing-dir${row.direction ? ` is-${escAttr(row.direction)}` : ""}">${escHtml(row.direction_words)}</b>${row.since_words ? ` <span class="standing-since">${escHtml(row.since_words)}</span>` : ""}`
      : "";
    const main = `<span class="standing-main"${row.href ? "" : ` aria-hidden="true"`}>${label}${dir}<small class="standing-words">${escHtml(row.words)}</small></span>`;
    const said = row.href ? "" : `<span class="sr-only">${escHtml(row.said)} </span>`;
    return `<span class="goalrow-dot" aria-hidden="true"></span>${said}${main}`;
  }

  function rowHtml(row: ClientStandingRow): string {
    const head = row.lines.length
      ? `<details class="standing-body"><summary class="standing-head">${headHtml(row)}</summary><ul class="standing-lines">${row.lines.map(lineHtml).join("")}</ul></details>`
      : `<div class="standing-body"><div class="standing-head">${headHtml(row)}</div></div>`;
    const invite = row.invite ? `<p class="standing-invite">${escHtml(row.invite)}</p>` : "";
    return `<li class="standing stone-${escAttr(row.stone)}" data-standing="${escAttr(row.key)}">${head}${invite}</li>`;
  }

  /** The rows as one list from the week read's `standing`; "" with none (no section at all). */
  function listHtml(standing: unknown, opts: { label?: string } = {}): string {
    const rows = CairnStandingModel.rows(standing);
    if (!rows.length) return "";
    return `<ul class="standing-list" aria-label="${escAttr(opts.label || "The whole picture")}">${rows.map(rowHtml).join("")}</ul>`;
  }

  const CAIRN_STANDING = { listHtml, rowHtml };

  Object.assign(globalThis, { CairnStanding: CAIRN_STANDING });
}

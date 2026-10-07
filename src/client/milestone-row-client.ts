// @ts-check
// The milestone row, the view (docs/IA.md "Component architecture"): ONE row for a dated
// thing on a line of time, drawn the same on Horizon's Week ("Next up") and its Season
// (the goal line, labs and scans). A mono when, a mark in its stone's deep hue (a dot for
// a training or goal date, a diamond for a lab or a scan, filled behind today and open
// ahead, as the season chart draws them), the label and one muted detail; a chevron when
// it goes somewhere. A list may carry ONE "Today" mark between behind and ahead.
//
// Deterministic strings over CairnMilestoneRowModel's rows: every word escaped, no unit
// or date logic, no colour written here (the hue is the `stone-<key>` class).
//
// LAZY ("calendar" bundle).
{
  type Go = ClientMilestoneGo;

  /** The delegated action's attribute name, held to a safe shape. */
  function goAttrs(go: Go | null | undefined): string {
    if (!go) return "";
    const action = /^[a-z][a-z0-9-]*$/.test(go.action) ? go.action : "";
    return ` href="${escAttr(go.href || "#")}"${action ? ` data-${action}="${escAttr(go.key)}"` : ""}`;
  }

  /** One row; `go` makes it a real link (long-press, a new tab) carrying its action key. */
  function rowHtml(row: ClientMilestoneRow, opts: { go?: Go | null } = {}): string {
    const cls = [
      "msrow",
      `is-${row.side}`,
      `stone-${row.stone}`,
      `is-mark-${row.mark}`,
      `is-kind-${row.kind.replace(/[^a-z0-9_-]/gi, "")}`,
    ].join(" ");
    const main = `<span class="msrow-mark" aria-hidden="true"></span>
      <span class="msrow-main">
        ${row.when ? `<span class="msrow-when">${escHtml(row.when)}</span>` : ""}
        <span class="msrow-label">${escHtml(row.label)}</span>
        ${row.detail ? `<span class="msrow-detail">${escHtml(row.detail)}</span>` : ""}
      </span>`;
    if (!opts.go) return `<li class="${cls}"><div class="msrow-body">${main}</div></li>`;
    return `<li class="${cls}"><a class="msrow-body msrow-link"${goAttrs(opts.go)}>${main}<span class="msrow-arw" aria-hidden="true">›</span></a></li>`;
  }

  /**
   * A list of rows, behind first. With `now`, ONE "Today" mark stands between behind and
   * ahead — only when something is behind it (alone it would repeat the list's start).
   * "" with no rows.
   */
  function listHtml(
    rows: ReadonlyArray<ClientMilestoneRow | null | undefined>,
    opts: { label: string; now?: boolean; go?: (row: ClientMilestoneRow, index: number) => Go | null } = { label: "" }
  ): string {
    const list = rows.map((row, i) => ({ row, i })).filter((e): e is { row: ClientMilestoneRow; i: number } => !!e.row);
    if (!list.length) return "";
    const item = ({ row, i }: { row: ClientMilestoneRow; i: number }) => rowHtml(row, { go: opts.go?.(row, i) || null });
    const behind = list.filter((e) => e.row.side === "behind");
    const ahead = list.filter((e) => e.row.side !== "behind");
    const now =
      opts.now && behind.length
        ? `<li class="msrow-now"><span class="msrow-mark is-now" aria-hidden="true"></span><span class="msrow-now-label">Today</span></li>`
        : "";
    const label = opts.label ? ` aria-label="${escAttr(opts.label)}"` : "";
    return `<ol class="msrow-list"${label}>${behind.map(item).join("")}${now}${ahead.map(item).join("")}</ol>`;
  }

  const CAIRN_MILESTONE_ROW = { rowHtml, listHtml };

  Object.assign(globalThis, { CairnMilestoneRow: CAIRN_MILESTONE_ROW });
}

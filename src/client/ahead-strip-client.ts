// @ts-check
// The marks ahead as rows (docs/IA.md "Horizon landing" 5), folded under the journey trail
// on Horizon's Week: every mark is a milestone row (CairnMilestoneRow, the Season's own
// row), a real link with a chevron when the mark has a page, plain when not. Five show;
// more than five adds "+N more ›", which opens the Season. Nothing is dropped silently.
//
// Deterministic strings over CairnWeekModel's ahead marks: every word escaped, no colour
// written here (the hue is the `stone-<key>` class).
//
// LAZY ("horizon" bundle).
{
  /** Rows shown before "+N more ›". */
  const ROWS_MAX = 5;

  /** Every mark as a milestone row (five shown, then "+N more ›" to the Season). */
  function rowsHtml(marks: ReadonlyArray<ClientAheadMark>, opts: { seasonHref?: string } = {}): string {
    if (!marks.length || typeof CairnMilestoneRow === "undefined") return "";
    const shown = marks.slice(0, ROWS_MAX);
    const rows = shown.map(
      (m): ClientMilestoneRow => ({
        kind: m.kind,
        stone: m.stone,
        mark: CairnMilestoneRowModel.KINDS[m.kind]?.mark || "dot",
        side: "ahead",
        when: m.when,
        label: m.label,
        detail: m.detail,
      })
    );
    const list = CairnMilestoneRow.listHtml(rows, {
      label: "Ahead",
      go: (_row, i) => {
        const href = shown[i]?.href;
        return href ? { href, action: "horizon-href", key: href } : null;
      },
    });
    const more = marks.length - shown.length;
    const link =
      more > 0
        ? `<a class="linkbtn linkbtn-plain hwk-season" href="${escAttr(opts.seasonHref || "#")}" data-hwk-season>${escHtml(`+${more} more ›`)}</a>`
        : "";
    return `${list}${link}`;
  }

  const CAIRN_AHEAD_STRIP = { rowsHtml, ROWS_MAX };

  Object.assign(globalThis, { CairnAheadStrip: CAIRN_AHEAD_STRIP });
}

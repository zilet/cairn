// A check-in is saved INCREMENTALLY — the athlete may write the same date's row
// several times as the morning's fields fill in (live data: one date saved five
// times). A "how many check-ins" or "how many days read low" count must count
// DAYS, never rows, or one athlete's habit of saving in stages inflates their
// sample size and can flip a minority into a manufactured majority. This is the one
// collapse every check-in reader uses (felt-signals, energy-deficiency).
//
// One value per date PER COLUMN — the latest non-null write for that column. The
// rows must arrive ordered `id DESC` within each date (callers order `date …, id
// DESC`), so the first non-null value seen per date/column during a single pass IS
// the latest one.
export type CheckinDay<C extends string> = { date: string } & Partial<Record<C, unknown>>;

export function collapseByDateLatestNonNull<C extends string>(
  rows: ReadonlyArray<Record<string, unknown>>,
  cols: readonly C[]
): Array<CheckinDay<C>> {
  const byDate = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const date = String(row.date ?? "").slice(0, 10);
    if (!date) continue;
    let entry = byDate.get(date);
    if (!entry) {
      entry = { date };
      byDate.set(date, entry);
    }
    for (const col of cols) {
      if (entry[col] == null && row[col] != null) entry[col] = row[col];
    }
  }
  return [...byDate.values()] as Array<CheckinDay<C>>;
}

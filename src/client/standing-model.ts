// @ts-check
// "The whole picture", the model (docs/IA.md "Horizon landing"): GET /api/week `standing[]`
// in, render rows out. Pure: no units, no dates, no DOM; the server already wrote every word
// in the athlete's units. A row with no label or sentence is dropped; a missing or empty
// `standing` is no rows, and the view then draws no section. Direction stays a word
// (better / holding / worse only decide a hook), never a score.
//
// LAZY ("horizon" bundle).
{
  type StandingRow = import("../contracts/week-read.js").WeekReadStandingRow;
  type StandingLine = import("../contracts/week-read.js").WeekReadStandingLine;

  const DIRECTIONS: ReadonlySet<string> = new Set(["better", "holding", "worse"]);
  const STONES: ReadonlySet<string> = new Set(["strength", "endurance", "recovery", "fuel", "body", "heart"]);

  function text(value: unknown): string {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function dirOf(value: unknown): ClientStandingRow["direction"] {
    return DIRECTIONS.has(String(value)) ? (value as ClientStandingRow["direction"]) : null;
  }

  function lineOf(line: StandingLine | null | undefined, index: number): ClientStandingLine | null {
    const label = text(line?.label);
    if (!label) return null;
    return {
      id: text(line?.id) || `line-${index}`,
      label,
      now: text(line?.now_text),
      direction: dirOf(line?.direction),
      direction_words: text(line?.direction_words),
      tail: [text(line?.move_words), text(line?.note)].filter(Boolean).join(" · "),
    };
  }

  /** The row's one spoken sentence: label, direction (and its window), then the server's sentence. */
  function said(row: Pick<ClientStandingRow, "label" | "direction_words" | "since_words" | "words">): string {
    const dir = [row.direction_words.toLowerCase(), row.since_words].filter(Boolean).join(" ");
    return `${[row.label, dir].filter(Boolean).join(", ")}. ${row.words}`;
  }

  function rowOf(row: StandingRow | null | undefined): ClientStandingRow | null {
    const label = text(row?.label);
    const words = text(row?.words);
    if (!row || !label || !words) return null;
    const dir = text(row.direction_words);
    const href = text(row.href);
    const base = {
      key: text(row.key) || label.toLowerCase(),
      stone: (STONES.has(String(row.stone)) ? row.stone : "body") as ClientRowStone,
      label,
      direction: dir ? dirOf(row.direction) : null,
      direction_words: dir,
      words,
      since_words: dir ? text(row.since_words) : "",
      invite: text(row.invite),
      href: href.startsWith("/") ? href : null,
      lines: (Array.isArray(row.lines) ? row.lines : []).map(lineOf).filter((l): l is ClientStandingLine => !!l),
    };
    return { ...base, said: said(base) };
  }

  /** Render rows from the week read's `standing`; [] when absent. */
  function rows(standing: unknown): ClientStandingRow[] {
    return (Array.isArray(standing) ? standing : []).map(rowOf).filter((r): r is ClientStandingRow => !!r);
  }

  const CAIRN_STANDING_MODEL = { rows, said };

  Object.assign(globalThis, { CairnStandingModel: CAIRN_STANDING_MODEL });
}

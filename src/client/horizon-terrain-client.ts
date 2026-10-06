// @ts-check
// The race build as terrain (docs/DESIGN.md "Charts: instruments drawn to scale"), and
// the drawing kit Horizon's two charts share (day arithmetic, mono dates, a tidy axis).
// One column per calendar week (weekly volume is a per-week figure; a curve would invent
// days that never ran): the log's weeks in ink, the ladder's in a lighter endurance tone
// with a deep cap, this week's logged part filled in and labelled in the race page's
// words. One axis in the athlete's run units; the engine's kilometres are only
// converted. Pure strings from shaped data; caller words go through escHtml, colors are
// CSS variables. horizon-chart-client re-exports it.
{
  type Terrain = ClientHorizonTerrain;

  const DAY = 86400000;
  const fx = (n: number): string => (Math.round(n * 10) / 10).toString();

  function dayNum(iso: string): number {
    const t = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
    return Number.isFinite(t) ? Math.round(t / DAY) : Number.NaN;
  }

  function isoOf(n: number): string {
    return new Date(n * DAY).toISOString().slice(0, 10);
  }

  /** "SEP 21": the mono axis date. */
  const monoDate = (iso: string): string => CairnFmt.date(String(iso).slice(0, 10), { fmt: { month: "short", day: "numeric" }, utc: true }).toUpperCase();

  function kmWord(km: number): string {
    return String(Math.round(km * 10) / 10);
  }

  /** Round a maximum up to a tidy axis top, and the step between gridlines. */
  function axisTop(max: number): { top: number; step: number } {
    // Miles run about 0.6 of the kilometres, so a small week steps by 5: three or four
    // hairlines whichever the unit, never one lonely line across the whole chart.
    const step = max > 60 ? 20 : max > 24 ? 10 : 5;
    // A little headroom, so the peak and its label never sit on the top line.
    return { top: Math.max(step * 2, Math.ceil((max * 1.06) / step) * step), step };
  }

  // ---- terrain ----------------------------------------------------------------

  /** A per-chart id suffix, so two terrains on one page never share a clip path. */
  let clipSeq = 0;

  /** The terrain's frame (viewBox units): exported so the loading shape holds the same box. */
  const TERRAIN = { W: 340, H: 178 } as const;

  /** Rough mono label width at 6.8px, so a stage name only prints where it fits. */
  const monoWidth = (text: string): number => text.length * 4.3 + 6;
  /** The ribbon's own short words: a band is often one week wide. */
  const RIBBON_WORD: Readonly<Record<string, string>> = { "Down week": "Down" };
  /**
   * A one-week band at 390px is ~22 units wide, too narrow for PEAK or TAPER: the band
   * still says its stage in the plan's own shorthand, and past that in its initial, so
   * the turning points the ribbon is for are never blank tiles.
   */
  const RIBBON_SHORT: Readonly<Record<string, string>> = {
    Logged: "LOG",
    Base: "BSE",
    Build: "BLD",
    Sharpen: "SHP",
    Peak: "PK",
    "Down week": "DN",
    Taper: "TPR",
    Race: "R",
  };
  /** The longest of a stage's words that fits a band, or "" when not even its initial does. */
  function ribbonWord(label: string, width: number): string {
    const full = (RIBBON_WORD[label] || label).toUpperCase();
    const short = (RIBBON_SHORT[label] || "").toUpperCase();
    for (const word of [full, short, full.charAt(0)]) if (word && monoWidth(word) <= width) return word;
    return "";
  }

  /** Rough width of a 10.5px semibold label, so a number is kept inside the plot. */
  const numWidth = (text: string): number => text.length * 5.7;

  /**
   * This week's words, the race page's THIS WEEK wording in the athlete's units: "18 of
   * 32 km" once the log holds running, "32 km planned" before it. The figures go through
   * the race model's own kmText / distNum, so the chart and the card never disagree.
   */
  function thisWeekWords(targetKm: number, doneKm: number, units: "km" | "mi"): string {
    const kmText = (k: number): string => CairnFmt.distance(k, units);
    const distNum = (k: number): string => CairnFmt.distance(k, units, true);
    if (doneKm > 0 && targetKm > 0) return `${distNum(doneKm)} of ${kmText(targetKm)}`;
    if (doneKm > 0) return `${kmText(doneKm)} run`;
    return targetKm > 0 ? `${kmText(targetKm)} planned` : "";
  }

  /**
   * The terrain as numbers (the view-model the SVG draws, and what the tests read): one
   * column per calendar week, standing in its own week's slot. Weekly volume is a
   * discrete per-week quantity, so nothing is interpolated between weeks: a column's top
   * IS its week's figure, and nothing is drawn above the largest week or below zero.
   *
   *   - a logged week: the log's closed week, one ink column;
   *   - a ladder week: the plan's figure, a lighter endurance column with a deep cap;
   *   - this week: the planned column, its logged part filled from the ground up in the
   *     logged ink (the log outranks the plan: a week run past it stands taller);
   *   - a ladder week's long run: a dash across its column at the long run's height.
   *
   * Figures are in the athlete's run units; `km` on the weeks stays the engine's.
   */
  function terrainLayout(terrain: Terrain, opts: { selected?: string | null } = {}): ClientHorizonTerrainLayout | null {
    const weeks = (terrain?.weeks || []).filter((w) => Number.isFinite(dayNum(w.week_start)));
    const ahead = weeks.filter((w) => !w.logged);
    if (ahead.length < 2) return null;
    const L = 26;
    const R = 334;
    const base = 138;
    const ceil = 40;
    const first = dayNum(weeks[0].week_start);
    const lastStart = dayNum(weeks[weeks.length - 1].week_start);
    const raceDay = Number.isFinite(dayNum(terrain.race_date)) ? dayNum(terrain.race_date) : lastStart + 6;
    // The chart ends the day after the race: when race day falls inside the last week,
    // that week's unused days past it are not drawn as empty ground.
    const end = raceDay >= lastStart && raceDay < lastStart + 7 ? raceDay + 1 : Math.max(raceDay + 1, lastStart + 7);
    const X = (n: number): number => L + ((n - first) / (end - first)) * (R - L);
    const units: "km" | "mi" = terrain.units === "mi" ? "mi" : "km";
    const conv = (k: unknown): number => Math.max(0, CairnFmt.toUnit(k, units));
    // The axis holds every figure a column stands to: the weeks, and this week's log
    // when it has already run past the plan.
    const values = weeks.map((w) => Math.max(conv(w.km), w.current ? conv(w.logged_km) : 0));
    const max = Math.max(0, ...values);
    const { top, step } = axisTop(max);
    const Y = (v: number): number => base - (v / top) * (base - ceil);
    // A column is narrower than its slot (the leftover is air between weeks), and never
    // wider than 22: bars are thin marks.
    const fullSlot = X(first + 7) - X(first);
    const colW = Math.min(22, fullSlot * 0.74);
    const columns: ClientHorizonTerrainColumn[] = weeks.map((w) => {
      const a = X(dayNum(w.week_start));
      const b = X(Math.min(end, dayNum(w.week_start) + 7));
      const width = Math.max(2, Math.min(colW, (b - a) * 0.74));
      const value = conv(w.km);
      const done = !w.logged && w.current ? conv(w.logged_km) : 0;
      const long = w.logged ? 0 : conv(w.long_km);
      return {
        week_start: w.week_start,
        logged: !!w.logged,
        current: !w.logged && !!w.current,
        stage: w.logged ? "Logged" : String(w.stage || ""),
        slot_x: a,
        slot_w: b - a,
        x: (a + b) / 2 - width / 2,
        width,
        value,
        top: Y(value),
        done: done > 0 ? done : null,
        done_top: done > 0 ? Y(done) : null,
        long: long > 0 ? long : null,
        long_y: long > 0 ? Y(long) : null,
      };
    });
    // Selective labels: this week in the race page's own words, and the peak.
    const plan = columns.filter((c) => !c.logged);
    const peak = plan.reduce((best, c) => (c.value > best.value ? c : best), plan[0]);
    const current = plan.find((c) => c.current) || null;
    const labels: ClientHorizonTerrainLabel[] = [];
    const place = (c: ClientHorizonTerrainColumn, text: string, kind: "week" | "peak"): ClientHorizonTerrainLabel => {
      const half = numWidth(text) / 2;
      const mid = c.x + c.width / 2;
      // A word wider than its column clears every column it spans, never sits on a
      // neighbour: centred over its column, or leaning to whichever side keeps it lowest
      // (closest to its own column).
      const best = [mid, c.x + c.width - half, c.x + half]
        .map((raw) => Math.min(R - half, Math.max(L + half, raw)))
        .map((x) => {
          const spanned = columns.filter((o) => o.x < x + half + 2 && o.x + o.width > x - half - 2);
          return { x, y: Math.min(...[c, ...spanned].map((o) => Math.min(o.top, o.done_top ?? o.top))) - 7 };
        })
        .reduce((keep, next) => (next.y > keep.y + 0.5 ? next : keep));
      return { kind, text, x: best.x, y: best.y, week_start: c.week_start };
    };
    if (current) {
      const w = weeks.find((wk) => wk.week_start === current.week_start && !wk.logged);
      const text = thisWeekWords(Number(w?.km) || 0, Number(w?.logged_km) || 0, units);
      if (text) labels.push(place(current, text, "week"));
    }
    if (peak && peak !== current) {
      let label = place(peak, `peak ${kmWord(peak.value)}`, "peak");
      const other = labels[0];
      // A peak word that would sit on this week's words steps above them, or yields.
      if (other && Math.abs(other.x - label.x) < (numWidth(other.text) + numWidth(label.text)) / 2 + 4) {
        if (Math.abs(other.y - label.y) < 12) label = { ...label, y: Math.min(label.y, other.y) - 12 };
      }
      if (label.y >= 24) labels.push(label);
    }
    const selected =
      (opts.selected ? plan.find((c) => c.week_start === opts.selected) : null) ||
      (opts.selected === "" ? null : current);
    return {
      units,
      L,
      R,
      base,
      ceil,
      top,
      step,
      max,
      grid: Array.from({ length: Math.floor(top / step) }, (_, i) => ({ value: (i + 1) * step, y: Y((i + 1) * step) })),
      columns,
      labels,
      selected: selected ? selected.week_start : null,
      race_x: X(Math.min(end, raceDay + 1)),
      race_day: isoOf(raceDay),
      end_x: X(end),
    };
  }

  /** A column with a rounded data-end (radius r) and a square foot on the ground. */
  function columnPath(x: number, w: number, yTop: number, yBase: number, r: number): string {
    const rr = Math.max(0, Math.min(r, w / 2, yBase - yTop));
    if (rr <= 0) return `M${fx(x)},${fx(yBase)}V${fx(yTop)}H${fx(x + w)}V${fx(yBase)}Z`;
    return `M${fx(x)},${fx(yBase)}V${fx(yTop + rr)}A${fx(rr)},${fx(rr)} 0 0 1 ${fx(x + rr)},${fx(yTop)}H${fx(x + w - rr)}A${fx(rr)},${fx(rr)} 0 0 1 ${fx(x + w)},${fx(yTop + rr)}V${fx(yBase)}Z`;
  }

  /** The plan's deep cap: the column's rounded top edge alone, inset so its stroke ends at the figure. */
  function capPath(x: number, w: number, yTop: number, yBase: number, r: number): string {
    const rr = Math.max(0, Math.min(r, w / 2, yBase - yTop));
    if (rr <= 1) return `M${fx(x + 1)},${fx(yTop + 1)}H${fx(x + w - 1)}`;
    const a = fx(rr - 1);
    return `M${fx(x + 1)},${fx(yTop + rr)}A${a},${a} 0 0 1 ${fx(x + rr)},${fx(yTop + 1)}H${fx(x + w - rr)}A${a},${a} 0 0 1 ${fx(x + w - 1)},${fx(yTop + rr)}`;
  }

  /**
   * The race build as terrain (docs/DESIGN.md "Charts"): terrainLayout's columns, the
   * long-run dashes, the stage ribbon under the ground (the current band deeper, each
   * named where it fits), and race day as the endurance marker. Labels are selective
   * (this week and the peak); every week speaks through its hit target's title and the
   * aria label, and the race page's ladder is the table view.
   */
  function terrainSvg(terrain: Terrain, opts: { selected?: string | null } = {}): string {
    const layout = terrainLayout(terrain, opts);
    if (!layout) return "";
    const { W, H } = TERRAIN;
    const { L, R, base, ceil, columns, units } = layout;
    const mi = units === "mi";
    const ribbonTop = base + 7;
    const ribbonH = 15;
    const weeks = (terrain.weeks || []).filter((w) => Number.isFinite(dayNum(w.week_start)));
    const ahead = weeks.filter((w) => !w.logged);
    const conv = (k: unknown): number => Math.max(0, CairnFmt.toUnit(k, units));
    let g = "";
    // Recessive grid: solid hairlines, the axis numbers in mono beside them.
    for (const line of layout.grid) {
      g += `<line class="hz-grid" x1="${L}" x2="${R}" y1="${fx(line.y)}" y2="${fx(line.y)}"/><text class="hz-axis" x="${L - 5}" y="${fx(line.y + 3)}" text-anchor="end">${line.value}</text>`;
    }
    g += `<text class="hz-axis" x="${L}" y="12">${mi ? "MI" : "KM"} PER WEEK</text>`;
    // The wash stands on the week the chart points at (this week unless another is picked).
    const picked = columns.find((c) => c.week_start === layout.selected && !c.logged);
    if (picked) {
      g += `<rect class="hz-wash" x="${fx(picked.slot_x)}" y="${ceil - 10}" width="${fx(picked.slot_w)}" height="${fx(base - ceil + 10)}" rx="6"/>`;
    }
    // The columns: logged weeks in ink, the ladder in the plan's lighter tone with its
    // deep cap, this week's logged part filled from the ground.
    for (const c of columns) {
      if (!(c.value > 0) && c.done == null) continue;
      if (c.logged) {
        g += `<path class="hz-col is-logged" d="${columnPath(c.x, c.width, c.top, base, 4)}"/>`;
        continue;
      }
      if (c.value > 0) g += `<path class="hz-col" d="${columnPath(c.x, c.width, c.top, base, 4)}"/>`;
      if (c.done != null && c.done_top != null) {
        // Run past the plan: the log stands taller, rounded; short of it: a flat fill.
        const over = c.done_top <= c.top;
        g += `<path class="hz-col is-logged is-done" d="${columnPath(c.x, c.width, c.done_top, base, over ? 4 : 0)}"/>`;
      }
      if (c.value > 0) g += `<path class="hz-cap" d="${capPath(c.x, c.width, c.top, base, 4)}"/>`;
    }
    g += `<line class="hz-base" x1="${L}" x2="${R}" y1="${base}" y2="${base}"/>`;
    // Long-run ticks: a dash across the column at the long run, ringed in the surface so
    // it reads over the fill.
    for (const c of columns) {
      if (c.long_y == null) continue;
      const a = c.x - 2;
      const b = c.x + c.width + 2;
      g += `<line class="hz-long-ring" x1="${fx(a)}" x2="${fx(b)}" y1="${fx(c.long_y)}" y2="${fx(c.long_y)}"/><line class="hz-long" x1="${fx(a)}" x2="${fx(b)}" y1="${fx(c.long_y)}" y2="${fx(c.long_y)}"/>`;
    }
    // The stage ribbon: consecutive weeks of one stage as one band.
    const bands: Array<{ label: string; a: number; b: number; current: boolean; logged: boolean }> = [];
    columns.forEach((c, i) => {
      const a = c.slot_x;
      // Race week's band stops at the race line: nothing of the build lies past race day.
      const b = i === columns.length - 1 ? Math.min(layout.end_x, layout.race_x) : c.slot_x + c.slot_w;
      const last = bands[bands.length - 1];
      if (last && last.label === c.stage) {
        last.b = b;
        last.current ||= c.current;
      } else bands.push({ label: c.stage, a, b, current: c.current, logged: c.logged });
    });
    for (const band of bands) {
      if (!band.label) continue;
      // A 2px surface gap between neighbouring bands, never a stroke around them.
      const a = band.a + 1;
      const width = Math.max(1, band.b - band.a - 2);
      const cls = ["hz-stage", band.logged ? "is-logged" : "", band.current ? "is-current" : ""]
        .filter(Boolean)
        .join(" ");
      g += `<rect class="${cls}" x="${fx(a)}" y="${ribbonTop}" width="${fx(width)}" height="${ribbonH}" rx="4"/>`;
      const word = ribbonWord(band.label, width);
      if (word) {
        const tone = band.current ? " is-current" : band.logged ? " is-logged" : "";
        g += `<text class="hz-stage-word${tone}" x="${fx(a + width / 2)}" y="${fx(ribbonTop + 10)}" text-anchor="middle">${escHtml(word)}</text>`;
      }
    }
    for (const label of layout.labels) {
      g += `<text class="hz-num${label.kind === "peak" ? " is-peak" : " is-week"}" x="${fx(label.x)}" y="${fx(label.y)}" text-anchor="middle">${escHtml(label.text)}</text>`;
    }
    const rx = layout.race_x;
    g += `<line class="hz-race" x1="${fx(rx)}" x2="${fx(rx)}" y1="18" y2="${fx(ribbonTop + ribbonH)}"/><text class="hz-race-word" x="${fx(rx)}" y="12" text-anchor="end">${escHtml(terrain.race_label)}</text>`;
    // Mono dates under the ribbon: the first Monday, one between, race day last.
    const dateY = ribbonTop + ribbonH + 13;
    const ticks = new Set<number>([0, Math.round((columns.length - 1) / 2)]);
    for (const i of ticks) {
      const x = columns[i].slot_x;
      // The race date is written leftward from the race line; a tick needs room for both.
      if (rx - x < 80) continue;
      g += `<text class="hz-axis" x="${fx(x)}" y="${fx(dateY)}">${escHtml(monoDate(columns[i].week_start))}</text>`;
    }
    g += `<text class="hz-axis" x="${fx(rx)}" y="${fx(dateY)}" text-anchor="end">${escHtml(monoDate(terrain.race_date || layout.race_day))}</text>`;
    // Hit targets: every week answers a hover with its own numbers.
    const weekWords = (w: ClientHorizonTerrainWeek): string => {
      const long = conv(w.long_km);
      const done = Number(w.logged_km) || 0;
      return [
        `${monoDate(w.week_start)}`,
        w.logged ? "logged" : String(w.stage || ""),
        w.current && !w.logged && done > 0
          ? thisWeekWords(Number(w.km) || 0, done, units)
          : `${kmWord(conv(w.km))} ${units}`,
        long > 0 ? `long run ${kmWord(long)} ${units}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    };
    columns.forEach((c, i) => {
      g += `<rect class="hz-hit" x="${fx(c.slot_x)}" y="${ceil - 10}" width="${fx(Math.max(1, c.slot_w))}" height="${fx(ribbonTop + ribbonH - ceil + 10)}"><title>${escHtml(weekWords(weeks[i]))}</title></rect>`;
    });
    const logged = weeks.filter((w) => w.logged);
    const label = [
      logged.length
        ? `Logged: ${logged.map((w) => `${monoDate(w.week_start)} ${kmWord(conv(w.km))} ${units}`).join(", ")}`
        : "",
      `${mi ? "Miles" : "Kilometres"} per week to race day: ${ahead.map(weekWords).join("; ")}`,
    ]
      .filter(Boolean)
      .join(". ");
    return `<svg class="hz-chart hz-terrain" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(label)}">${g}</svg>`;
  }

  /** The terrain's key: only what it drew (planned weeks, logged running, long runs); the axis names the unit. */
  function terrainKeyHtml(terrain: Terrain | null | undefined): string {
    const weeks = terrain?.weeks || [];
    const ahead = weeks.filter((w) => !w.logged);
    if (ahead.length < 2) return "";
    const logged = weeks.some((w) => w.logged) || ahead.some((w) => w.current && Number(w.logged_km) > 0);
    const keys = [
      `<span class="horizon-key is-planned">Planned</span>`,
      logged ? `<span class="horizon-key is-logged">Logged</span>` : "",
      ahead.some((w) => Number(w.long_km) > 0) ? `<span class="horizon-key is-long">Long run</span>` : "",
    ].join("");
    return `<figcaption class="horizon-chart-key">${keys}</figcaption>`;
  }

  const CAIRN_HORIZON_TERRAIN = {
    TERRAIN,
    terrainLayout,
    terrainSvg,
    terrainKeyHtml,
    fx,
    dayNum,
    isoOf,
    monoDate,
    kmWord,
  };

  Object.assign(globalThis, { CairnHorizonTerrain: CAIRN_HORIZON_TERRAIN });
}

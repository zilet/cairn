// @ts-check
// The Horizon instruments (docs/DESIGN.md "Charts: instruments drawn to scale"): two SVG
// charts drawn to scale. The race build's terrain lives in horizon-terrain-client (with
// the drawing kit both share) and is re-exported here; this module draws the season.
//
//   - seasonSvg: the season's weight line. The weigh-ins since the window opened, the
//     goal as a dashed body-colored line, the server's projection window as a fan from
//     the latest weigh-in to the goal, and a lane of dated diamonds under it: draws and
//     scans behind (filled), rechecks ahead (open), race day (endurance). The latest
//     weigh-in says "now" only when it is today's; an older one wears its own date, and
//     past FAN_ANCHOR_DAYS the fan no longer leaves it (the window lies on the goal line
//     alone), so a stale weight is never drawn as the current one.
//
// Pure strings from shaped data; nothing here judges a pace or a fit. Every caller
// word that reaches the SVG goes through escHtml. Axis labels are mono and small, the
// annotations take a stone's deep color, and the colors are CSS variables, so the
// charts follow the theme without a repaint.
{
  type Season = ClientHorizonSeason;

  const { TERRAIN, terrainSvg, terrainKeyHtml, fx, dayNum, isoOf, monoDate, kmWord } = CairnHorizonTerrain;
  /** How old the latest weigh-in may be and still anchor the projection fan. */
  const FAN_ANCHOR_DAYS = 3;
  /** How far past the season's own end (today, goal, window, race) a mark may widen it. */
  const MARK_REACH_DAYS = 30;
  /** Mark kinds drawn in the body hue (a scan of the body), not the labs' heart. */
  const BODY_MARK_KINDS: ReadonlySet<string> = new Set(["dexa", "rescan"]);

  const monoMonth = (iso: string): string => CairnFmt.date(iso.slice(0, 10), { fmt: { month: "short" }, utc: true }).toUpperCase();

  // ---- season -----------------------------------------------------------------

  function seasonSvg(season: Season): string {
    const points = (season?.points || []).filter((p) => Number.isFinite(dayNum(p.date)) && Number.isFinite(p.lb));
    if (points.length < 2) return "";
    const W = 340;
    const L = 28;
    const R = 332;
    const top = 22;
    const bottom = 132;
    const lane = 152;
    const today = dayNum(season.today);
    const first = dayNum(points[0].date);
    // The span is the season's own: the weigh-ins, today, the goal, the window and race
    // day. A mark may widen it by MARK_REACH_DAYS at most; one further out (a recheck
    // months away) is pinned at the right edge, so it never squeezes the weight line.
    const edges = [today, dayNum(points[points.length - 1].date)];
    if (season.goal_date) edges.push(dayNum(season.goal_date));
    if (season.fan) edges.push(dayNum(season.fan.end));
    if (season.race) edges.push(dayNum(season.race.date));
    const core = Math.max(...edges.filter(Number.isFinite));
    const reach = season.marks
      .map((m) => dayNum(m.date))
      .filter((n) => Number.isFinite(n) && n <= core + MARK_REACH_DAYS);
    const x0 = first;
    const x1 = Math.max(core, ...reach) + 4;
    const X = (n: number): number => L + ((n - x0) / Math.max(1, x1 - x0)) * (R - L);
    const lbs = points.map((p) => p.lb);
    if (season.goal_lb != null) lbs.push(season.goal_lb);
    const lo = Math.floor(Math.min(...lbs) - 1.5);
    const hi = Math.ceil(Math.max(...lbs) + 1.5);
    const Y = (lb: number): number => top + ((hi - lb) / Math.max(1, hi - lo)) * (bottom - top);

    let g = "";
    // Month rules, labelled in mono; a long season labels every other month.
    const months: string[] = [];
    const start = new Date(isoOf(x0));
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, 12));
    while (dayNum(cursor.toISOString()) <= x1) {
      months.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    const monthEvery = months.length > 6 ? 2 : 1;
    months.forEach((m, i) => {
      const x = X(dayNum(m));
      g += `<line class="hz-rule" x1="${fx(x)}" x2="${fx(x)}" y1="${top - 6}" y2="${lane + 8}"/>`;
      if (i % monthEvery === 0 && R - x > 18)
        g += `<text class="hz-axis" x="${fx(x + 3)}" y="${lane + 22}">${escHtml(monoMonth(m))}</text>`;
    });
    // Three weight ticks across the span.
    const span = hi - lo;
    const tick = span > 24 ? 10 : 5;
    for (let w = Math.ceil(lo / tick) * tick; w <= hi; w += tick) {
      if (Y(w) < top - 2 || Y(w) > bottom + 2) continue;
      g += `<text class="hz-axis" x="${L - 5}" y="${fx(Y(w) + 3)}" text-anchor="end">${w}</text>`;
    }
    const last = points[points.length - 1];
    const nx = X(dayNum(last.date));
    const ny = Y(last.lb);
    const age = Number.isFinite(today) ? today - dayNum(last.date) : Number.POSITIVE_INFINITY;
    // A weigh-in dated a day ahead of the device's today (a timezone edge) is still today's.
    const isToday = age <= 0;
    if (season.goal_lb != null) {
      const gy = Y(season.goal_lb);
      const goalWord = [kmWord(season.goal_lb), season.goal_date ? CairnUiChart.dateLabel(season.goal_date) : ""]
        .filter(Boolean)
        .join(" · ");
      g += `<line class="hz-goal" x1="${L}" x2="${R}" y1="${fx(gy)}" y2="${fx(gy)}"/><text class="hz-goal-word" x="${R}" y="${fx(gy + 13)}" text-anchor="end">${escHtml(goalWord)}</text>`;
      if (season.fan) {
        const fa = X(dayNum(season.fan.start));
        const fb = X(dayNum(season.fan.end));
        const fm = (fa + fb) / 2;
        g +=
          age <= FAN_ANCHOR_DAYS
            ? `<path class="hz-fan" d="M${fx(nx)},${fx(ny)} L${fx(fa)},${fx(gy)} L${fx(fb)},${fx(gy)}Z"/><line class="hz-fan-line" x1="${fx(nx)}" y1="${fx(ny)}" x2="${fx(fm)}" y2="${fx(gy)}"/>`
            : `<rect class="hz-fan is-window" x="${fx(fa)}" y="${fx(gy - 4)}" width="${fx(Math.max(2, fb - fa))}" height="8" rx="4"/>`;
      }
    }
    const line = points.map((p, i) => `${i ? "L" : "M"}${fx(X(dayNum(p.date)))},${fx(Y(p.lb))}`).join("");
    g += `<path class="hz-weight" d="${line}"/>`;
    const firstP = points[0];
    g += `<text class="hz-num" x="${fx(X(dayNum(firstP.date)) + 4)}" y="${fx(Y(firstP.lb) - 7)}">${escHtml(kmWord(firstP.lb))}</text>`;
    const todayWord = `${kmWord(last.lb)} ${isToday ? "now" : `· ${monoDate(last.date)}`}`;
    // The label sits above and to the right of the latest dot, where the fan leaves room;
    // near the right edge it steps to the left, under the line.
    const roomRight = R - nx > 64;
    const dot = isToday ? "hz-today" : "hz-today is-past";
    g += `<circle class="${dot}" cx="${fx(nx)}" cy="${fx(ny)}" r="4.5"/><text class="${isToday ? "hz-today-word" : "hz-today-word is-past"}" x="${fx(roomRight ? nx + 8 : nx - 8)}" y="${fx(roomRight ? ny - 9 : ny + 16)}" text-anchor="${roomRight ? "start" : "end"}">${escHtml(todayWord)}</text>`;
    // The lane of diamonds: labs and scans behind (filled), ahead (open), race day.
    g += `<line class="hz-lane" x1="${L}" x2="${R}" y1="${lane}" y2="${lane}"/>`;
    const diamond = (x: number, cls: string): string =>
      `<rect class="${cls}" x="${fx(x - 3.6)}" y="${fx(lane - 3.6)}" width="7.2" height="7.2" transform="rotate(45 ${fx(x)} ${lane})"/>`;
    for (const m of season.marks) {
      const n = dayNum(m.date);
      if (!Number.isFinite(n) || n < x0) continue;
      const beyond = n > x1;
      const body = BODY_MARK_KINDS.has(m.kind) ? " is-body" : "";
      g += diamond(
        beyond ? R : X(n),
        `hz-mark is-${m.side} is-kind-${m.kind.replace(/[^a-z0-9_-]/gi, "")}${body}${beyond ? " is-beyond" : ""}`
      );
    }
    if (season.race) g += diamond(X(dayNum(season.race.date)), "hz-mark is-race");
    if (Number.isFinite(today) && today >= x0 && today <= x1) {
      const tx = X(today);
      g += `<line class="hz-now" x1="${fx(tx)}" x2="${fx(tx)}" y1="${lane - 9}" y2="${lane + 9}"/>`;
    }
    const aria = [
      `Weight from ${kmWord(firstP.lb)} to ${kmWord(last.lb)} lb${isToday ? " today" : ` on ${monoDate(last.date)}`}`,
      season.goal_lb != null ? `goal ${kmWord(season.goal_lb)} lb` : "",
      season.marks.length ? `${season.marks.length} labs and scans on the line` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return `<svg class="hz-chart hz-season" viewBox="0 0 ${W} 180" role="img" aria-label="${escAttr(aria)}">${g}</svg>`;
  }

  const CAIRN_HORIZON_CHART = { BODY_MARK_KINDS, FAN_ANCHOR_DAYS, TERRAIN, terrainSvg, terrainKeyHtml, seasonSvg };

  Object.assign(globalThis, { CairnHorizonChart: CAIRN_HORIZON_CHART });
}

// @ts-check
// Body & recovery on Today (docs/DESIGN.md "Today"): the recovery gauges with the
// actual reading, its unit and the athlete's own band edges in words, the bodyweight
// sparkline with its goal line.
// The days of the week are the "What's ahead" strip's alone (today-strip-client.ts) —
// Today has ONE week view. Pure string builders over GET /api/recovery/baseline and the
// path's weigh-ins; every server string is escaped and no colour is written here.
// Lives in the lazy today-ahead bundle.

type TodayWeekBaseline = import("../contracts/client.js").ClientRecoveryBaselineRead;
type TodayWeekBand = import("../contracts/client.js").ClientRecoveryBaselineDimension;

(() => {
  const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function dowOf(iso: string): number {
    const ms = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
    return Number.isFinite(ms) ? new Date(ms).getUTCDay() : -1;
  }

  function addDays(iso: string, days: number): string {
    const ms = Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
    return Number.isFinite(ms) ? new Date(ms + days * 864e5).toISOString().slice(0, 10) : iso;
  }

  // ---------- recovery gauges ----------

  function sleepText(min: number): string {
    const m = Math.max(0, Math.round(min));
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}`;
  }

  function valueText(band: TodayWeekBand, value: number): string {
    if (band.key === "sleep") return sleepText(value);
    return `${Math.round(value)} ${band.key === "hrv" ? "ms" : "bpm"}`;
  }

  function bandEdges(band: TodayWeekBand): string {
    if (band.key === "sleep") return `usual ${sleepText(band.p25)}–${sleepText(band.p75)}`;
    return `usual ${Math.round(band.p25)}–${Math.round(band.p75)}`;
  }

  // Which night a reading belongs to, in words. Rows are dated by the WAKE day, so the
  // read day's own row is last night and anything older is named by its night ("Wed
  // night") — an older night is never presented as last night.
  function nightWord(band: TodayWeekBand, today: string): string {
    const date = String(band.last_reading_date || "");
    if (!date) return "";
    if (date === today) return "last night";
    return `${DOW_SHORT[dowOf(addDays(date, -1))] || ""} night`;
  }

  function gaugeHtml(band: TodayWeekBand, today: string): string {
    const pct = (n: number) => `${Math.round(Math.max(0, Math.min(1, n)) * 1000) / 10}%`;
    const current = band.current != null && Number.isFinite(Number(band.current)) ? Number(band.current) : null;
    const left = Math.min(band.range_start, band.range_end);
    const width = Math.abs(band.range_end - band.range_start);
    const night = current != null ? nightWord(band, today) : "";
    const sub = [current == null ? "no recent night" : night === "last night" ? "" : night, bandEdges(band)]
      .filter(Boolean)
      .join(" · ");
    const pin =
      current != null && band.position != null
        ? `<span class="tgauge-pin${band.hot ? " is-hot" : ""}" style="left:${pct(band.position)}"></span>`
        : "";
    const aria = `${band.label}: ${current != null ? `${valueText(band, current)}${night ? `, ${night}` : ""}` : "no recent reading"}; ${bandEdges(band)}. ${band.phrase || ""}`;
    return `<div class="tgauge" role="img" aria-label="${escAttr(aria)}">
      <span class="tgauge-l">${escHtml(band.label)}</span>
      <span class="tgauge-bar" aria-hidden="true"><span class="tgauge-band" style="left:${pct(left)};width:${pct(width)}"></span>${pin}</span>
      <span class="tgauge-v num">${current != null ? escHtml(valueText(band, current)) : "—"}</span>
      <small class="tgauge-sub">${escHtml(sub)}</small>
    </div>`;
  }

  /** Resting HR, HRV and sleep, in that order; "" when no band has enough readings. */
  function gaugesHtml(baseline: TodayWeekBaseline | null | undefined, today: string): string {
    const dims = Array.isArray(baseline?.dimensions) ? baseline!.dimensions : [];
    const order = ["rhr", "hrv", "sleep"];
    const rows = order
      .map((key) => dims.find((d) => d && d.key === key))
      .filter((d): d is TodayWeekBand => !!d && Number.isFinite(Number(d.p25)) && Number.isFinite(Number(d.p75)))
      .map((d) => gaugeHtml(d, today))
      .join("");
    return rows ? `<div class="tgauges">${rows}</div>` : "";
  }

  // ---------- the bodyweight sparkline ----------

  /** The last weigh-ins as a tiny line with the goal as a dotted line; "" with under two points. */
  function sparkSvg(
    points: Array<{ date: string; weight_lb: number }> | null | undefined,
    goal: number | null | undefined
  ): string {
    const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(Number(p.weight_lb)));
    if (pts.length < 2) return "";
    const W = 64;
    const H = 22;
    const values = pts.map((p) => Number(p.weight_lb));
    const g = goal != null && Number.isFinite(Number(goal)) ? Number(goal) : null;
    const all = g != null ? [...values, g] : values;
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = Math.max(max - min, 0.5);
    const y = (v: number) => Math.round((2 + (H - 4) * (1 - (v - min) / span)) * 10) / 10;
    const x = (i: number) => Math.round((2 + ((W - 6) * i) / (values.length - 1)) * 10) / 10;
    const line = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    const goalLine = g != null ? `<line class="tspark-goal" x1="0" x2="${W}" y1="${y(g)}" y2="${y(g)}"/>` : "";
    const last = values.length - 1;
    return `<svg class="tspark" viewBox="0 0 ${W} ${H}" aria-hidden="true">${goalLine}<polyline class="tspark-line" points="${line}"/><circle class="tspark-dot" cx="${x(last)}" cy="${y(values[last])}" r="2"/></svg>`;
  }

  // (The week's stage words are the server's: Today's Horizon glance line, frame.glance.)
  const CAIRN_TODAY_WEEK = { gaugesHtml, sparkSvg, nightWord };

  Object.assign(globalThis, { CairnTodayWeek: CAIRN_TODAY_WEEK });
})();

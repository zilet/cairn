// @ts-check
// The Path card under Today's Brief (docs/DESIGN.md "Today"): a trail drawn to scale
// in time from the start of the recent window through today to the furthest goal, the
// walked part drawn in once, a breathing "now" dot, three threads (race, weight, the
// anchor lift) each with its real number and a one-line trend, then the week's ONE
// lever, and a quiet "All goals" link to Horizon's goal line, where every thread (each
// strength objective, the priority marker) is laid out in full. Pure string builders over GET /api/today-path (src/repo/today-path.ts); every
// server string is escaped, and no colour or duration is written here — the marks take
// their hue from classes in src/styles/today/path.css.

type TodayPathRead = import("../contracts/today-path.js").TodayPath;
type TodayPathMark = import("../contracts/today-path.js").TodayPathMilestone;

type TodayPathTrailPoint = { x: number; y: number };

(() => {
  // The trail's frame (viewBox units): left and right ends, and the band it wanders in.
  const W = 320;
  const H = 82;
  const X0 = 14;
  const X1 = 306;
  // Marks that sit ON the trail; the rest of the road lives in Coming up.
  const TRAIL_KINDS = new Set(["peak_week", "race", "goal"]);

  function dayNumber(iso: string): number {
    const ms = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return Number.isFinite(ms) ? ms / 864e5 : Number.NaN;
  }

  /** "Sep 4" — a chart's mono date; never a bare ISO date. */
  const shortDate = (iso: unknown): string => CairnFmt.date(String(iso ?? "").slice(0, 10), { year: false });

  /** Finish time in h:mm:ss (or m:ss under an hour), as the race build prints it. */
  function clock(sec: unknown): string {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
      : `${m}:${String(r).padStart(2, "0")}`;
  }

  function signed(n: number, digits = 1): string {
    const f = 10 ** digits;
    const r = Math.round(n * f) / f;
    return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}`;
  }

  // The trail's height at x: a calm meander that climbs gently toward the goals.
  function trailY(x: number): number {
    const t = (x - X0) / (X1 - X0);
    return 48 - 9 * Math.sin(t * Math.PI * 1.7 + 0.35) - t * 12;
  }

  function trailPoints(from: number, to: number): TodayPathTrailPoint[] {
    const out: TodayPathTrailPoint[] = [];
    const steps = Math.max(2, Math.round((to - from) / 4));
    for (let i = 0; i <= steps; i++) {
      const x = from + ((to - from) * i) / steps;
      out.push({ x: Math.round(x * 10) / 10, y: Math.round(trailY(x) * 10) / 10 });
    }
    return out;
  }

  function pathD(points: TodayPathTrailPoint[]): string {
    return points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
  }

  function pathLength(points: TodayPathTrailPoint[]): number {
    let len = 0;
    for (let i = 1; i < points.length; i++)
      len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return Math.ceil(len);
  }

  function markClass(kind: string): string {
    return kind === "race" ? "is-race" : kind === "goal" ? "is-goal" : "is-peak";
  }

  function markWord(mark: TodayPathMark, path: TodayPathRead): string {
    if (mark.kind === "race")
      return path.race?.distance_label === "Half marathon" ? "Half" : path.race?.distance_label || "Race";
    if (mark.kind === "goal") return path.weight?.goal_lb != null ? `${path.weight.goal_lb} lb` : "Goal";
    const km = /(\d+)\s*km/.exec(mark.label)?.[1];
    return km ? `${km} km` : "Peak";
  }

  /** The trail SVG: to scale in time from `trail_start` to the furthest trail mark. "" with no marks. */
  function trailSvg(path: TodayPathRead): string {
    const marks = (path.milestones || []).filter((m) => TRAIL_KINDS.has(m.kind));
    if (!marks.length) return "";
    const start = dayNumber(path.trail_start);
    const today = dayNumber(path.as_of);
    const end = Math.max(...marks.map((m) => dayNumber(m.date)));
    if (!Number.isFinite(start) || !Number.isFinite(today) || !(end > start)) return "";
    const xOf = (iso: string) => X0 + ((dayNumber(iso) - start) / (end - start)) * (X1 - X0);
    const xNow = Math.max(X0 + 6, Math.min(X1 - 6, xOf(path.as_of)));
    const walked = trailPoints(X0, xNow);
    const len = pathLength(walked);
    const now = { x: xNow, y: trailY(xNow) };
    // Labels alternate above and below the trail, and one too close to its neighbour
    // on the same side is left to Coming up rather than drawn over it.
    const lastX: Record<"above" | "below", number> = { above: -99, below: xNow };
    const labels: string[] = [
      `<text class="tpath-t" x="${X0 - 8}" y="${H - 6}">${escHtml(shortDate(path.trail_start))}</text>`,
      `<text class="tpath-t tpath-t-now" x="${Math.round(xNow - 12)}" y="${Math.round(now.y + 18)}">Today</text>`,
    ];
    const nodes: string[] = [];
    marks
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((mark, i) => {
        const x = Math.round(xOf(mark.date) * 10) / 10;
        const y = Math.round(trailY(x) * 10) / 10;
        nodes.push(
          `<circle class="tpath-node ${markClass(mark.kind)}" cx="${x}" cy="${y}" r="${mark.kind === "race" ? 5 : 4}"/>`
        );
        const side: "above" | "below" = i % 2 === 0 ? "above" : "below";
        if (x - lastX[side] < 40) return;
        lastX[side] = x;
        const anchorX = Math.round(Math.min(x, W - 30) - 14);
        if (side === "above") {
          labels.push(
            `<text class="tpath-t" x="${anchorX}" y="${Math.round(y - 20)}">${escHtml(shortDate(mark.date))}</text>`
          );
          labels.push(
            `<text class="tpath-t tpath-t-big" x="${anchorX}" y="${Math.round(y - 9)}">${escHtml(markWord(mark, path))}</text>`
          );
        } else {
          labels.push(
            `<text class="tpath-t" x="${anchorX}" y="${Math.round(y + 15)}">${escHtml(shortDate(mark.date))}</text>`
          );
          labels.push(
            `<text class="tpath-t tpath-t-big" x="${anchorX}" y="${Math.round(y + 27)}">${escHtml(markWord(mark, path))}</text>`
          );
        }
      });
    const aria = `Trail from ${shortDate(path.trail_start)} through today to ${marks.map((m) => `${m.label} on ${shortDate(m.date)}`).join(", ")}`;
    return `<svg class="tpath-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(aria)}">
      <path class="tpath-trail" d="${pathD(trailPoints(X0, X1))}"/>
      <path class="tpath-walked" style="--len:${len}" d="${pathD(walked)}"/>
      <circle class="tpath-node is-start" cx="${X0}" cy="${trailY(X0).toFixed(1)}" r="3.5"/>
      ${nodes.join("")}
      <circle class="tpath-pulse" cx="${now.x.toFixed(1)}" cy="${now.y.toFixed(1)}" r="5"/>
      <circle class="tpath-now" cx="${now.x.toFixed(1)}" cy="${now.y.toFixed(1)}" r="5"/>
      ${labels.join("")}
    </svg>`;
  }

  function threadHtml(stone: string, name: string, line: string, value: string): string {
    return `<div class="tpath-thread"><span class="tpath-dot stone-${stone}" aria-hidden="true"></span><div class="tpath-thread-name">${escHtml(name)}${
      line ? `<small>${escHtml(line)}</small>` : ""
    }</div><span class="tpath-num num">${escHtml(value)}</span></div>`;
  }

  function raceThread(path: TodayPathRead): string {
    const race = path.race;
    if (!race) return "";
    const bits: string[] = [];
    if (race.trend_delta_sec != null && race.since && Math.abs(race.trend_delta_sec) >= 30) {
      const min = Math.max(1, Math.round(Math.abs(race.trend_delta_sec) / 60));
      bits.push(`${min} min ${race.trend_delta_sec < 0 ? "faster" : "slower"} than ${shortDate(race.since)}`);
    } else if (race.trend_delta_sec != null) bits.push("holding steady");
    if (race.target_raw) bits.push(`target ${race.target_raw}`);
    return threadHtml("endurance", race.distance_label, bits.join(" · "), clock(race.estimate_sec));
  }

  function weightThread(path: TodayPathRead): string {
    const w = path.weight;
    if (!w) return "";
    const bits: string[] = [];
    if (w.trend_lb_wk != null) bits.push(`${signed(w.trend_lb_wk, 2)} lb/wk`);
    if (w.goal_lb != null && w.goal_date && w.needed_lb_wk != null && w.mode !== "maintain") {
      bits.push(`${w.goal_lb} by ${shortDate(w.goal_date)} needs ${signed(w.needed_lb_wk, 2)}`);
    } else if (w.goal_lb != null && w.mode !== "maintain") bits.push(`goal ${w.goal_lb} lb`);
    return threadHtml("body", "Weight", bits.join(" · "), `${w.current_lb} lb`);
  }

  function anchorThread(path: TodayPathRead): string {
    const a = path.anchor;
    if (!a) return "";
    const bits: string[] = [];
    if (a.lb_per_week != null) bits.push(`${signed(a.lb_per_week)} lb/wk`);
    const weeks = a.projection_weeks;
    bits.push(
      weeks && weeks[0] > 0
        ? `${a.target_est_1rm} target in ${weeks[0] === weeks[1] ? weeks[0] : `${weeks[0]}–${weeks[1]}`} wks`
        : `${a.target_est_1rm} target`
    );
    return threadHtml("strength", `${a.exercise}, est. 1RM`, bits.join(" · "), `${a.est_1rm} lb`);
  }

  function kicker(path: TodayPathRead): string {
    const race = path.race;
    if (race && race.days_to_race >= 0) {
      const name = race.event || race.distance_label;
      const days = race.days_to_race;
      return `Your path · ${days === 0 ? "race day" : `${days} day${days === 1 ? "" : "s"} to ${name}`}`;
    }
    return "Your path";
  }

  /** Where "All goals" lands: Horizon's goal line, as a real URL (long-press, new tab). */
  function goalsHref(): string {
    try {
      const routes = typeof routeApi === "function" ? routeApi() : null;
      return routes?.routeToUrl({ tab: "horizon", section: "goal" }) || "/app/horizon/goal";
    } catch {
      return "/app/horizon/goal";
    }
  }

  /** The whole card; "" when the path has no thread to show. */
  function cardHtml(path: TodayPathRead | null | undefined): string {
    if (!path || typeof path !== "object") return "";
    const threads = [raceThread(path), weightThread(path), anchorThread(path)].filter(Boolean);
    if (!threads.length) return "";
    const lever = path.lever?.text
      ? `<div class="tpath-lever"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path class="tpath-lever-mark" d="M7 1 L9 7 L7 13 L5 7Z"/></svg><span><b>This week's lever:</b> ${escHtml(path.lever.text)}</span></div>`
      : "";
    return `<section class="tpath" aria-label="Your path">
      <span class="lbl tpath-k">${escHtml(kicker(path))}</span>
      ${trailSvg(path)}
      <div class="tpath-threads">${threads.join("")}</div>
      ${lever}
      <a class="linkbtn-quiet tpath-all" href="${escAttr(goalsHref())}" data-tpath-goals>All goals</a>
    </section>`;
  }

  const CAIRN_TODAY_PATH = { cardHtml, trailSvg, shortDate, clock, signed, goalsHref };

  Object.assign(globalThis, { CairnTodayPath: CAIRN_TODAY_PATH });
})();

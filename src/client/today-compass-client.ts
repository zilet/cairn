// @ts-check
// Pure Today weekly compass helpers.

type TodayCompassStats = {
  week_planned?: unknown;
  week_done?: unknown;
  goal_mode?: unknown;
  pace_status?: unknown;
  trend_lb_wk?: unknown;
  needed_lb_wk?: unknown;
  goal_weight_lb?: unknown;
  goal_date?: unknown;
  week_cardio?: unknown;
  /** The ONE weight-trend read (weight-trend.ts): rate, ask and verdict in the athlete's unit. */
  weight_trend?: import("../contracts/week-read.js").WeightTrendRead | null;
  endurance?: {
    week_km?: unknown;
    week_moving_min?: unknown;
    total_moving_min?: unknown;
    by_sport?: Record<string, unknown> | null;
  } | null;
};

type TodayCompassDeps = {
  escapeHtml(value: unknown): string;
  escapeAttr(value: unknown): string;
  formatKm(value: unknown): string;
};

type TodayCompassOptions = {
  currentWeight?: unknown;
  isToday?: unknown;
  isEndurance?: unknown;
  isHybrid?: unknown;
  /** false when the weigh-in chip already rides the week row (Today): one weight, said once. */
  weightTile?: boolean;
};

type TodayCompassBuild = {
  planned: number;
  done: number;
  weekKm: number;
  cellsHtml: string;
  weekRecap: string;
};

(() => {
  function finiteNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function todayCompassStats(value: unknown): TodayCompassStats {
    return value && typeof value === "object" ? value as TodayCompassStats : {};
  }

  /** A signed rate already rounded once by the server ("−0.9", "+0.3"). */
  function fmtPace(value: unknown): string {
    const n = finiteNumber(value) ?? 0;
    return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
  }

  function statDots(planned: number, done: number): string {
    return planned
      ? `<div class="stat-dots">${Array.from({ length: planned }, (_unused, i) => `<span class="stat-dot${i < done ? " on" : ""}"></span>`).join("")}</div>`
      : "";
  }

  // The pace tile prints the ONE weight-trend read (stats.weight_trend): its rate, its
  // ask and its verdict, already in the athlete's unit — never a re-judged slope.
  function paceTileHtml(statsValue: unknown, deps: TodayCompassDeps): string {
    const wt = todayCompassStats(statsValue).weight_trend;
    if (!wt || wt.rate_value == null) {
      return `<div class="stat stat-pace"><div class="stat-n numeral stat-dim">—</div><div class="stat-l lbl">pace · log weigh-ins</div></div>`;
    }
    const unit = `${wt.units === "kg" ? "kg" : "lb"}/wk`;
    const rate = fmtPace(wt.rate_value);
    if (!wt.needed_words && !wt.verdict_words) {
      return `<div class="stat stat-pace"><div class="stat-n numeral">${deps.escapeHtml(rate)}</div><div class="stat-l lbl">${unit} · set a goal</div></div>`;
    }
    const sub = [wt.verdict_words, wt.needed_words ? `need ${wt.needed_words}` : ""].filter(Boolean).join(" · ");
    const tone = wt.verdict === "behind" ? "behind" : wt.verdict === "steady" ? "holding" : "on";
    return `<div class="stat stat-pace pace-${tone}" title="${deps.escapeAttr(wt.line || "")}">
        <div class="stat-n numeral">${deps.escapeHtml(rate)}</div>
        <div class="stat-sub">${deps.escapeHtml(sub)}</div>
        <div class="stat-l lbl">${unit}</div>
      </div>`;
  }

  function build(statsValue: unknown, deps: TodayCompassDeps, options: TodayCompassOptions = {}): TodayCompassBuild {
    const stats = todayCompassStats(statsValue);
    const planned = finiteNumber(stats.week_planned) ?? 0;
    const done = finiteNumber(stats.week_done) ?? 0;
    const end = stats.endurance && typeof stats.endurance === "object" ? stats.endurance : {};
    const weekKm = finiteNumber(end.week_km) ?? 0;
    const bySport = end.by_sport && typeof end.by_sport === "object" ? end.by_sport : {};
    const sports = Object.values(bySport)
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
      .sort((a, b) => {
        if (a.sport === "run") return -1;
        if (b.sport === "run") return 1;
        return (finiteNumber(b.moving_min) ?? 0) - (finiteNumber(a.moving_min) ?? 0);
      });
    if (!sports.length && (weekKm > 0 || (finiteNumber(end.week_moving_min) ?? 0) > 0)) {
      sports.push({ sport: "run", label: "Running", distance_km: weekKm, moving_min: end.week_moving_min });
    }
    const distanceSports = sports.filter((row) => (finiteNumber(row.distance_km) ?? 0) > 0);
    const leadSport = distanceSports[0] ?? sports[0] ?? null;
    const leadDistance = finiteNumber(leadSport?.distance_km) ?? 0;
    const leadMinutes = finiteNumber(leadSport?.moving_min) ?? 0;
    // Distances in the athlete's run units; the engine's km never print raw.
    const dUnit = CairnFmt.units().distance;
    const dist = (km: unknown): string => CairnFmt.distance(finiteNumber(km) ?? 0, dUnit);
    const leadValue = leadDistance ? Math.round(CairnFmt.toUnit(leadDistance, dUnit) * 10) / 10 : leadMinutes;
    const leadLabel = String(leadSport?.sport || "endurance");
    const modalityLine = distanceSports
      .map((row) => `${String(row.sport || "other")} ${dist(row.distance_km)}`)
      .join(" · ");
    const dots = statDots(planned, done);
    const paceTile = paceTileHtml(stats, deps);
    const mileageTile = `<div class="stat" title="Endurance volume by sport this week">
        <div class="stat-n numeral"><span data-cu="${leadValue}">0</span><span class="stat-frac">${leadDistance ? dUnit : "min"}</span></div>
        ${modalityLine ? `<div class="stat-sub">${deps.escapeHtml(modalityLine)}</div>` : ""}
        <div class="stat-l lbl">${deps.escapeHtml(leadLabel)} this week${leadMinutes ? ` · ${Math.round(leadMinutes)} min` : ""}</div>
      </div>`;
    const adherenceTile = `<div class="stat" title="Training sessions logged this week vs your plan">
        <div class="stat-n numeral"><span data-cu="${done}">0</span><span class="stat-frac">/${planned || "—"}</span></div>
        ${dots}
        <div class="stat-l lbl">this week</div>
      </div>`;
    const wUnit = CairnFmt.units().weight;
    const wtTile = `<button class="stat stat-wt" id="wtChip" title="Log bodyweight">
        <div class="stat-n numeral" data-wtval>${options.currentWeight != null ? CairnFmt.weight(options.currentWeight, wUnit, true) : "—"}<span class="stat-plus">+</span></div>
        <div class="stat-l lbl">${stats.goal_weight_lb != null ? `${wUnit} → ${CairnFmt.weight(stats.goal_weight_lb, wUnit, true)}` : `weight · ${wUnit}`}</div>
      </button>`;
    const weight = options.weightTile === false ? "" : wtTile;
    const cellsHtml = options.isEndurance ? `${mileageTile}${paceTile}${weight}`
      : options.isHybrid ? `${adherenceTile}${mileageTile}${weight}`
      : `${adherenceTile}${paceTile}${weight}`;
    const liftBit = done ? `${done} lift${done === 1 ? "" : "s"}` : "";
    const cardioBits = [];
    if (stats.week_cardio) cardioBits.push(`${stats.week_cardio} cardio`);
    if (distanceSports.length) {
      cardioBits.push(
        distanceSports
          .map((row) => `${String(row.sport || "other")} ${dist(row.distance_km)}`)
          .join(" · ")
      );
    } else if (weekKm) cardioBits.push(`run ${dist(weekKm)}`);
    const cardioBit = cardioBits.join(" · ");
    const weekRecap = (options.isEndurance ? [cardioBit, liftBit] : [liftBit, cardioBit]).filter(Boolean).join(" · ");
    return {
      planned,
      done,
      weekKm,
      cellsHtml,
      weekRecap,
    };
  }

  const CAIRN_TODAY_COMPASS = {
    fmtPace,
    paceTileHtml,
    build,
  };

  Object.assign(globalThis, { CairnTodayCompass: CAIRN_TODAY_COMPASS });

  if (typeof window !== "undefined") {
    window.CairnTodayCompass = CAIRN_TODAY_COMPASS;
  }
})();

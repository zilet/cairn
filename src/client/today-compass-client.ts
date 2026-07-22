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
};

type TodayCompassBuild = {
  planned: number;
  done: number;
  weekKm: number;
  cellsHtml: string;
  weekRecap: string;
};

(() => {
  const PACE_WORDS: Record<string, Record<string, string>> = {
    lose: { on: "on pace", behind: "behind", fast: "too fast" },
    gain: { on: "building", behind: "not building yet", fast: "building fast" },
    maintain: { holding: "holding steady", drifting_up: "drifting up", drifting_down: "easing down" },
  };

  function finiteNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function todayCompassStats(value: unknown): TodayCompassStats {
    return value && typeof value === "object" ? value as TodayCompassStats : {};
  }

  function fmtPace(value: unknown): string {
    const n = finiteNumber(value) ?? 0;
    return (n > 0 ? "+" : "") + (Math.round(n * 10) / 10);
  }

  function paceWord(statsValue: unknown): string {
    const stats = todayCompassStats(statsValue);
    const mode = String(stats.goal_mode || "lose");
    const status = String(stats.pace_status || "");
    return (PACE_WORDS[mode] || PACE_WORDS.lose)[status] || "";
  }

  function statDots(planned: number, done: number): string {
    return planned
      ? `<div class="stat-dots">${Array.from({ length: planned }, (_unused, i) => `<span class="stat-dot${i < done ? " on" : ""}"></span>`).join("")}</div>`
      : "";
  }

  function paceTileHtml(statsValue: unknown, deps: TodayCompassDeps): string {
    const stats = todayCompassStats(statsValue);
    const mode = String(stats.goal_mode || "lose");
    const word = paceWord(stats);
    if (stats.trend_lb_wk == null) {
      return `<div class="stat stat-pace"><div class="stat-n numeral stat-dim">—</div><div class="stat-l lbl">pace · log weigh-ins</div></div>`;
    }
    if (stats.needed_lb_wk == null) {
      return `<div class="stat stat-pace"><div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div><div class="stat-l lbl">lb/wk · set a goal</div></div>`;
    }
    const sub = mode === "maintain"
      ? word
      : `${word}${stats.needed_lb_wk ? ` · need ${fmtPace(stats.needed_lb_wk)}` : ""}`;
    const title = mode === "maintain"
      ? `Weight trend ${fmtPace(stats.trend_lb_wk)} lb/wk — ${word || "holding steady"}`
      : `Trend ${fmtPace(stats.trend_lb_wk)} lb/wk over recent weigh-ins${stats.goal_weight_lb != null ? ` · need ${fmtPace(stats.needed_lb_wk)} ${mode === "gain" ? "to build toward" : "to reach"} ${stats.goal_weight_lb} lb${stats.goal_date ? ` by ${stats.goal_date}` : ""}` : ""}`;
    return `<div class="stat stat-pace pace-${stats.pace_status || "on"}" title="${deps.escapeAttr(title)}">
        <div class="stat-n numeral">${fmtPace(stats.trend_lb_wk)}</div>
        <div class="stat-sub">${deps.escapeHtml(sub)}</div>
        <div class="stat-l lbl">lb / week</div>
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
    const leadValue = leadDistance || leadMinutes;
    const leadLabel = String(leadSport?.sport || "endurance");
    const modalityLine = distanceSports
      .map((row) => `${String(row.sport || "other")} ${deps.formatKm(finiteNumber(row.distance_km) ?? 0)} km`)
      .join(" · ");
    const dots = statDots(planned, done);
    const paceTile = paceTileHtml(stats, deps);
    const mileageTile = `<div class="stat" title="Endurance volume by sport this week">
        <div class="stat-n numeral"><span data-cu="${leadValue}">0</span><span class="stat-frac">${leadDistance ? "km" : "min"}</span></div>
        ${modalityLine ? `<div class="stat-sub">${deps.escapeHtml(modalityLine)}</div>` : ""}
        <div class="stat-l lbl">${deps.escapeHtml(leadLabel)} this week${leadMinutes ? ` · ${Math.round(leadMinutes)} min` : ""}</div>
      </div>`;
    const adherenceTile = `<div class="stat" title="Training sessions logged this week vs your plan">
        <div class="stat-n numeral"><span data-cu="${done}">0</span><span class="stat-frac">/${planned || "—"}</span></div>
        ${dots}
        <div class="stat-l lbl">this week</div>
      </div>`;
    const wtTile = `<button class="stat stat-wt" id="wtChip" title="Log bodyweight">
        <div class="stat-n numeral" data-wtval>${options.currentWeight != null ? options.currentWeight : "—"}<span class="stat-plus">+</span></div>
        <div class="stat-l lbl">${stats.goal_weight_lb != null ? `lb → ${deps.escapeHtml(String(stats.goal_weight_lb))}` : "weight · lb"}</div>
      </button>`;
    const cellsHtml = options.isEndurance ? `${mileageTile}${paceTile}${wtTile}`
      : options.isHybrid ? `${adherenceTile}${mileageTile}${wtTile}`
      : `${adherenceTile}${paceTile}${wtTile}`;
    const liftBit = done ? `${done} lift${done === 1 ? "" : "s"}` : "";
    const cardioBits = [];
    if (stats.week_cardio) cardioBits.push(`${stats.week_cardio} cardio`);
    if (distanceSports.length) {
      cardioBits.push(
        distanceSports
          .map((row) => `${String(row.sport || "other")} ${deps.formatKm(finiteNumber(row.distance_km) ?? 0)} km`)
          .join(" · ")
      );
    } else if (weekKm) cardioBits.push(`run ${deps.formatKm(weekKm)} km`);
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
    paceWord,
    paceTileHtml,
    build,
  };

  Object.assign(globalThis, { CairnTodayCompass: CAIRN_TODAY_COMPASS });

  if (typeof window !== "undefined") {
    window.CairnTodayCompass = CAIRN_TODAY_COMPASS;
  }
})();

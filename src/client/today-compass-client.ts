// @ts-check
// Pure Today weekly compass and pace-offer helpers.

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

type TodayPaceOffer = {
  status: string;
  line: string;
  ask: string;
};

type TodayCompassBuild = {
  planned: number;
  done: number;
  weekKm: number;
  cellsHtml: string;
  paceOfferHtml: string;
  paceOffer: TodayPaceOffer | null;
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

  function paceOffer(statsValue: unknown, currentWeight: unknown): TodayPaceOffer | null {
    const stats = todayCompassStats(statsValue);
    const mode = String(stats.goal_mode || "lose");
    const status = String(stats.pace_status || "");
    if (mode === "maintain") return null;
    if (mode === "gain") {
      const offers: Record<string, Omit<TodayPaceOffer, "status">> = {
        behind: {
          line: "Not building yet — want to look at fueling together?",
          ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but I'm aiming for a lean gain of about ${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk. Should we add some calories to build lean mass?`,
        },
        fast: {
          line: "Building a little fast — want to ease the surplus?",
          ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk, faster than my lean-gain pace (~${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk). Should we trim calories so it stays muscle, not fat?`,
        },
      };
      return offers[status] ? { status, ...offers[status] } : null;
    }
    const curW = finiteNumber(currentWeight);
    const maxSafe = curW != null ? Math.round(curW * 0.01 * 10) / 10 : null;
    const offers: Record<string, Omit<TodayPaceOffer, "status">> = {
      fast: {
        line: "Trending a bit fast — want to look at your pace together?",
        ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but the lean-safe ceiling for me is about -${maxSafe} lb/wk (needed pace ${fmtPace(stats.needed_lb_wk ?? 0)}). Should we add calories or adjust the plan to protect lean mass?`,
      },
      behind: {
        line: "A little behind your goal pace — want to look together?",
        ask: `My weight trend is ${fmtPace(stats.trend_lb_wk ?? 0)} lb/wk but I need ${fmtPace(stats.needed_lb_wk ?? 0)} lb/wk to hit ${stats.goal_weight_lb} lb by ${stats.goal_date}. What should we tighten — meals, cardio, or the timeline?`,
      },
    };
    return offers[status] ? { status, ...offers[status] } : null;
  }

  function paceOfferHtml(offer: TodayPaceOffer | null, deps: TodayCompassDeps): string {
    return offer
      ? `<button class="pace-offer pace-offer-${offer.status}" id="paceOffer">${deps.escapeHtml(offer.line)} · <span class="pace-offer-cta">ask the coach →</span></button>`
      : "";
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
    const offer = options.isToday ? paceOffer(stats, options.currentWeight) : null;
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
      paceOfferHtml: paceOfferHtml(offer, deps),
      paceOffer: offer,
      weekRecap,
    };
  }

  const CAIRN_TODAY_COMPASS = {
    fmtPace,
    paceWord,
    paceTileHtml,
    paceOffer,
    paceOfferHtml,
    build,
  };

  Object.assign(globalThis, { CairnTodayCompass: CAIRN_TODAY_COMPASS });

  if (typeof window !== "undefined") {
    window.CairnTodayCompass = CAIRN_TODAY_COMPASS;
  }
})();

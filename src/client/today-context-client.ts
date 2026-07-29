// @ts-check
// Pure Today context, goal-line, and health-focus rail helpers.

type TodayContextEvent = {
  kind?: unknown;
  title?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  resolved_at?: unknown;
  archived?: unknown;
  meta_json?: unknown;
};

type TodayGoalStats = {
  goal_mode?: unknown;
  goal_weight_lb?: unknown;
  goal_date?: unknown;
};

type TodayHealthFocusBanner = {
  synthesis?: { one_change?: unknown; headline?: unknown } | null;
  focus?: {
    lead?: {
      group?: unknown;
      why?: unknown;
      moves?: { nutrition?: unknown; training?: unknown; watch?: unknown } | null;
    } | null;
  } | null;
};

(() => {
  const TODAY_CONTEXT_ICONS: Record<string, string> = { trip: "✈", injury: "🤕", life_event: "◆", family_event: "◆" };
  const TODAY_CONTEXT_NEAR_DAYS = 21;

  // An open injury banners every morning it is open, so one literal prints verbatim
  // for weeks. Rotated by calendar day; add a phrasing here, never a literal above.
  const INJURY_BANNER_NUDGES: readonly string[] = [
    "go easy",
    "keep it comfortable",
    "nothing forced today",
    "stay well within range",
    "let it set the pace",
  ];

  function todayContextRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function todayContextDateISO(value?: unknown): string {
    if (typeof value === "string" && value) return value;
    return typeof localISO === "function" ? localISO() : new Date().toISOString().slice(0, 10);
  }

  function todayContextMeta(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
      try { return todayContextRecord(JSON.parse(value)); } catch { return {}; }
    }
    return todayContextRecord(value);
  }

  function daysUntil(startISO: unknown, todayISO?: string): number | null {
    if (!startISO) return null;
    const start = new Date(String(startISO) + "T00:00:00");
    const today = new Date(todayContextDateISO(todayISO) + "T00:00:00");
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(today.getTime())) return null;
    return Math.round((start.getTime() - today.getTime()) / 86400000);
  }

  function eventCountdown(days: unknown): string {
    if (days == null) return "";
    const n = Number(days);
    if (!Number.isFinite(n)) return "";
    if (n <= 0) return "today";
    if (n === 1) return "tomorrow";
    if (n <= 14) return `in ${n} days`;
    return `in ${Math.round(n / 7)} weeks`;
  }

  function contextResolved(ev: Record<string, unknown>, todayISO?: string): boolean {
    const resolved = typeof ev.resolved_at === "string" ? ev.resolved_at.slice(0, 10) : "";
    return !!resolved && resolved <= todayContextDateISO(todayISO);
  }

  function isNearTermContext(value: unknown, todayISO?: string): boolean {
    const ev = todayContextRecord(value);
    if (ev.archived) return false;
    // An injury has no natural end date, so it used to banner every single day
    // until the athlete DELETED it. Closing it is the way out — honor that here.
    if (contextResolved(ev, todayISO)) return false;
    if (ev.kind === "injury") return true;
    const today = todayContextDateISO(todayISO);
    const start = typeof ev.start_date === "string" ? ev.start_date : "";
    const end = typeof ev.end_date === "string" ? ev.end_date : "";
    if (start && start <= today && (!end || end >= today)) return true;
    if (start && start > today) return (daysUntil(start, today) ?? Infinity) <= TODAY_CONTEXT_NEAR_DAYS;
    return false;
  }

  function contextBannerLine(value: unknown, todayISO?: string): string {
    const ev = todayContextRecord(value) as TodayContextEvent;
    const meta = todayContextMeta(ev.meta_json);
    const kind = String(ev.kind || "");
    const icon = TODAY_CONTEXT_ICONS[kind] || "◆";
    const title = ev.title || ev.kind || "";
    if (kind === "injury") {
      const area = meta.area;
      const areaText = area && !String(title).toLowerCase().includes(String(area).toLowerCase()) ? ` (${escHtml(area)})` : "";
      const nudge = pickDayVariant(INJURY_BANNER_NUDGES, todayContextDateISO(todayISO), `injury-banner:${title}`);
      return `${icon} ${escHtml(title)}${areaText} — ${escHtml(nudge)}`;
    }
    const today = todayContextDateISO(todayISO);
    let when = "";
    const start = typeof ev.start_date === "string" ? ev.start_date : "";
    const end = typeof ev.end_date === "string" ? ev.end_date : "";
    if (start && start > today) when = ` · ${eventCountdown(daysUntil(start, today))}`;
    else if (start && (!end || end >= today)) when = " · now";
    const where = kind === "trip" && meta.location ? ` to ${escHtml(meta.location)}` : "";
    return `${icon} ${escHtml(title)}${where}${escHtml(when)}`;
  }

  function contextBannerHtml(events: unknown, todayISO?: string): string {
    const rows = Array.isArray(events) ? events : [];
    const lines = rows
      .filter((event) => isNearTermContext(event, todayISO))
      .slice(0, 3)
      .map((event) => contextBannerLine(event, todayISO));
    return lines.length ? `<div class="ctxbanner">${lines.join('<span class="ctxbanner-sep">·</span>')}</div>` : "";
  }

  function goalLineHtml(statsValue: unknown, currentWeight: unknown, isToday: unknown, todayISO?: string): string {
    const stats = todayContextRecord(statsValue) as TodayGoalStats;
    if (!isToday || !Object.keys(stats).length) return "";
    if ((stats.goal_mode || "lose") === "maintain") return "";
    const goalWeight = stats.goal_weight_lb != null ? Number(stats.goal_weight_lb) : null;
    const goalDate = typeof stats.goal_date === "string" ? stats.goal_date : "";
    if (goalWeight == null || !goalDate) return "";
    const days = daysUntil(goalDate, todayISO);
    if (days == null || days < 0) return "";
    const when = days <= 7 ? "this week" : days <= 112 ? `~${Math.round(days / 7)} wk` : `~${Math.round(days / 30)} mo`;
    const from = currentWeight != null && Number(currentWeight) !== goalWeight
      ? ` <span class="goalline-from">from ${escHtml(String(currentWeight))}</span>`
      : "";
    const verb = (stats.goal_mode || "lose") === "gain" ? "Building toward" : "Toward";
    return `<button class="goalline reveal" id="goalLine" style="--i:0" type="button">
      <span class="goalline-ico" aria-hidden="true">◎</span>
      <span class="goalline-txt">${verb} <b>${goalWeight} lb</b>${from} · ${escHtml(when)}</span>
      <span class="goalline-go" aria-hidden="true">→</span>
    </button>`;
  }

  function healthFocusLine(value: unknown): string {
    const data = todayContextRecord(value) as TodayHealthFocusBanner;
    const synthesis = data.synthesis;
    const lead = data.focus && data.focus.lead;
    if (synthesis && (synthesis.one_change || synthesis.headline)) return String(synthesis.one_change || synthesis.headline);
    if (!lead) return "";
    const moves = lead.moves && (lead.moves.nutrition || lead.moves.training || lead.moves.watch);
    return moves ? `${String(lead.group || "")}: ${String(moves)}` : String(lead.why || lead.group || "");
  }

  function healthFocusBannerHtml(value: unknown): string {
    const line = healthFocusLine(value);
    if (!line) return "";
    return `<button class="ctxbanner ctxbanner-health" id="ctxHealthGo">
      <span class="ctxbanner-health-line">✦ ${escHtml(line)}</span>
      <span class="ctxbanner-go" aria-hidden="true">→</span>
    </button>`;
  }

  const CAIRN_TODAY_CONTEXT = {
    CONTEXT_ICONS: TODAY_CONTEXT_ICONS,
    CONTEXT_NEAR_DAYS: TODAY_CONTEXT_NEAR_DAYS,
    daysUntil,
    eventCountdown,
    isNearTermContext,
    contextBannerLine,
    contextBannerHtml,
    goalLineHtml,
    healthFocusLine,
    healthFocusBannerHtml,
  };

  Object.assign(globalThis, { CairnTodayContext: CAIRN_TODAY_CONTEXT });

  if (typeof window !== "undefined") {
    window.CairnTodayContext = CAIRN_TODAY_CONTEXT;
  }
})();

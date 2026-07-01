// @ts-check
// Progress -> Endurance route controller: data fan-out, stale guards, and DOM paint.

type ProgressEnduranceRecord = Record<string, unknown>;
type ProgressEnduranceStat = readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }];
type ProgressEnduranceGoalRow = import("../contracts/client-api.js").ClientEnduranceGoal;
type ProgressEndurancePRRows = import("../contracts/client-api.js").ClientEndurancePRs;
type ProgressEnduranceCompliance = import("../contracts/client-api.js").ClientRunCompliance;
type ProgressEnduranceSportBests = import("../contracts/client-api.js").ClientSportBests;
type ProgressEnduranceRunPlan = import("../contracts/client-api.js").ClientWeeklyRunPlan;

type ProgressEnduranceControllerDeps = {
  view: HTMLElement;
  headerTitle: HTMLElement;
  state: Pick<ClientAppState, "tab" | "progressSeg">;
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  nextToken(): number;
  isCurrent(token: number): boolean;
  segmentHtml(active: ClientProgressSection): string;
  wireSegments(): void;
  loading(message: string): string;
  empty(image: string, message: string): string;
  hero(title: string, stats: ProgressEnduranceStat[]): string;
  art(kind: string, label: string): string;
  runCountUps(root: ParentNode): void;
  renderSelf(): unknown;
};

function progressEnduranceRecord(value: unknown): ProgressEnduranceRecord {
  return value && typeof value === "object" ? (value as ProgressEnduranceRecord) : {};
}

function progressEnduranceNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasProgressEnduranceRecord(value: unknown): value is ProgressEnduranceRecord {
  return !!value && typeof value === "object";
}

async function renderProgressEndurance(deps: ProgressEnduranceControllerDeps): Promise<void> {
  deps.headerTitle.textContent = "Progress";
  deps.state.progressSeg = "endurance";
  const token = deps.nextToken();
  deps.view.innerHTML = deps.segmentHtml("endurance") + `<div id="endBody">${deps.loading("Reading your week...")}</div>`;
  deps.wireSegments();

  let stats: unknown = null;
  let prs: ProgressEndurancePRRows | null = null;
  let goal: ProgressEnduranceGoalRow | null = null;
  let compliance: ProgressEnduranceCompliance | null = null;
  let settings: unknown = null;
  let runPlan: ProgressEnduranceRunPlan | null = null;
  try {
    const results = await Promise.all([
      deps.api("/stats"),
      deps.api("/endurance-prs").catch(() => null),
      deps.api("/endurance-goal").catch(() => null),
      deps.api("/run-compliance").catch(() => null),
      deps.api("/settings").then((row) => (row && (row as { settings?: unknown }).settings) || null).catch(() => null),
      deps.api("/run-plan").catch(() => null),
    ]);
    stats = results[0];
    prs = results[1] as ProgressEndurancePRRows | null;
    goal = results[2] as ProgressEnduranceGoalRow | null;
    compliance = results[3] as ProgressEnduranceCompliance | null;
    settings = results[4];
    runPlan = results[5] as ProgressEnduranceRunPlan | null;
  } catch {
    stats = null;
  }
  if (!deps.isCurrent(token) || !deps.view.querySelector("#endBody")) return;
  const statsRow = progressEnduranceRecord(stats);
  paintProgressEnduranceBody(statsRow.endurance || null, prs, goal, compliance, settings, runPlan, deps);
}

function paintProgressEnduranceBody(
  end: unknown,
  prs: ProgressEndurancePRRows | null,
  goal: ProgressEnduranceGoalRow | null,
  compliance: ProgressEnduranceCompliance | null,
  settings: unknown,
  runPlan: ProgressEnduranceRunPlan | null,
  deps: ProgressEnduranceControllerDeps,
): void {
  const body = deps.view.querySelector<HTMLElement>("#endBody");
  if (!body) return;
  const endRow = progressEnduranceRecord(end);
  const goalHtml = enduranceGoalCard(goal);
  const complianceHtml = runComplianceLine(compliance);
  const runPlanHtml = weeklyRunPlanCard(runPlan);
  const syncHtml = (typeof cardioSyncLine === "function") ? cardioSyncLine(progressEnduranceRecord(settings), {}) : "";
  const hasWeek = hasProgressEnduranceRecord(end) && (
    progressEnduranceNumber(endRow.week_km) > 0 ||
    progressEnduranceNumber(endRow.week_moving_min) > 0 ||
    endRow.longest_km != null ||
    endRow.longest_min != null
  );
  const hasPRs = !!prs && (
    prs.sports.length > 0 ||
    prs.longest_km != null ||
    prs.longest_min != null ||
    prs.best_pace.length > 0
  );
  if (!hasWeek && !hasPRs) {
    body.innerHTML = deps.hero("Endurance", []) + goalHtml + complianceHtml + runPlanHtml + syncHtml +
      deps.empty(deps.art("activity", "run"),
        goalHtml
          ? "No runs logged yet - log one on Today (a phrase like \"ran 8 km easy\" is plenty) and your weekly runs build toward this."
          : "No runs or rides logged yet - log one on Today (a phrase like \"ran 8 km easy\" is plenty) and your mileage, zones, and pace will read here.");
    if (syncHtml && typeof wireCardioSync === "function") wireCardioSync(body, () => deps.renderSelf());
    return;
  }

  const heroStats: ProgressEnduranceStat[] = [];
  if (hasProgressEnduranceRecord(end)) {
    heroStats.push(["km · this week", endRow.week_km || 0]);
    if (endRow.week_moving_min != null) heroStats.push(["moving min · wk", Math.round(progressEnduranceNumber(endRow.week_moving_min))]);
    if (endRow.longest_km != null) heroStats.push(["longest · km", endRow.longest_km, { text: true }]);
    else if (endRow.longest_min != null) heroStats.push(["longest · min", Math.round(progressEnduranceNumber(endRow.longest_min)), { text: true }]);
  }

  const coachLineHtml = enduranceCoachLine(runPlan);
  const leadHtml = deps.hero("Endurance", heroStats) + coachLineHtml + goalHtml + complianceHtml + runPlanHtml;
  const hasLead = !!(runPlanHtml || goalHtml || coachLineHtml);
  let deep = "";

  if (hasProgressEnduranceRecord(end) && (endRow.longest_km != null || endRow.longest_min != null)) {
    const lbits: string[] = [];
    if (endRow.longest_km != null) lbits.push(`${fmtKm(endRow.longest_km)} km`);
    if (endRow.longest_min != null) lbits.push(`${Math.round(progressEnduranceNumber(endRow.longest_min))} min`);
    const tlabel = endRow.longest_type ? `${escHtml(endRow.longest_type)} · ` : "";
    deep += `<div class="end-line reveal" style="${stagger(1)}"><span class="lbl">Longest this week</span><span class="end-line-v">${tlabel}${lbits.join(" · ")}</span></div>`;
  }

  const paceTrend = progressEnduranceRecord(endRow.pace_trend);
  const word = paceTrendWord(hasProgressEnduranceRecord(end) ? paceTrend : null);
  if (word) {
    deep += `<div class="end-pace reveal" style="${stagger(2)}">
        <span class="lbl">Pace</span>
        <span class="end-pace-read">${escHtml(word.charAt(0).toUpperCase() + word.slice(1))}.</span>
        ${paceTrend.this_min_per_km != null ? `<span class="end-pace-num numeral">${fmtPaceKm(paceTrend.this_min_per_km)}<span class="end-pace-unit">/km</span></span>` : ""}
      </div>`;
  }

  deep += zoneBarHtml(hasProgressEnduranceRecord(end) ? endRow.time_in_zone : null);

  if (hasPRs) {
    let groups: ProgressEnduranceSportBests[] = (Array.isArray(prs.sports) ? prs.sports : [])
      .map((group) => ({ ...group }))
      .filter((group) => enduranceBestRows(group).length);
    if (!groups.length) {
      groups = [{
        sport: prs.primary_sport || "run",
        label: "",
        count: 0,
        paced: true,
        longest_km: prs.longest_km,
        longest_min: prs.longest_min,
        best_pace: prs.best_pace,
        best_speed_kmh: null,
      }].filter((group) => enduranceBestRows(group).length);
    }
    if (groups.length) {
      if (groups.length === 1) groups[0] = { ...groups[0], label: "" };
      const lead = groups[0];
      const others = groups.slice(1);
      const otherHtml = others.length
        ? `<details class="end-pr-more">
            <summary>Cross-training bests</summary>
            <div class="end-pr-more-body">${others.map((group, index) => enduranceSportCardHtml(group, 5 + index)).join("")}</div>
          </details>`
        : "";
      deep += `<div class="end-prs">
          <div class="lbl end-prs-head reveal" style="${stagger(3)}">Personal bests</div>
          ${enduranceSportCardHtml(lead, 4)}
          ${otherHtml}
        </div>`;
    }
  }

  deep += syncHtml;

  const html = hasLead && deep.trim()
    ? leadHtml +
      `<details class="full-read reveal" style="${stagger(3)}">
        <summary>The full read</summary>
        <div class="full-read-body">${deep}</div>
      </details>`
    : leadHtml + deep;

  body.innerHTML = html;
  deps.runCountUps(body);
  if (syncHtml && typeof wireCardioSync === "function") wireCardioSync(body, () => deps.renderSelf());
}

const CAIRN_PROGRESS_ENDURANCE_CONTROLLER = {
  render: renderProgressEndurance,
  paint: paintProgressEnduranceBody,
};

Object.assign(globalThis, { CairnProgressEnduranceController: CAIRN_PROGRESS_ENDURANCE_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnProgressEnduranceController = CAIRN_PROGRESS_ENDURANCE_CONTROLLER;
}

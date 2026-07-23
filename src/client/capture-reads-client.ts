// @ts-check
// Quiet Today reads controller for Capture.

function captureReadDateApi(): CaptureReadDateApi {
  return (globalThis as unknown as { CairnCaptureReadDate: CaptureReadDateApi }).CairnCaptureReadDate;
}

function captureReadCardsApi(): CaptureReadCardsApi {
  return (globalThis as unknown as { CairnCaptureReadCards: CaptureReadCardsApi }).CairnCaptureReadCards;
}

function captureReadJobsApi(): CaptureReadJobsApi {
  return (globalThis as unknown as { CairnCaptureReadJobs: CaptureReadJobsApi }).CairnCaptureReadJobs;
}

function captureReadsWeekRangeLabel(iso: unknown): string {
  return captureReadDateApi().weekRangeLabel(iso);
}

type CaptureWeekWinPr = { exercise?: unknown; label?: unknown };
type CaptureWeekWinVolume = { muscle?: unknown; label?: unknown };
type CaptureWeekWinPace = { status?: unknown; label?: unknown } | null;
type CaptureWeekWins = {
  prs?: CaptureWeekWinPr[] | null;
  trained_days_7?: unknown;
  week_sets?: unknown;
  volume_filled?: CaptureWeekWinVolume[] | null;
  pace?: CaptureWeekWinPace;
};

// Word-wise title case for a raw canonical muscle-group key ("rear delts" ->
// "Rear Delts"). No display-name helper exists client-side for these keys yet.
function captureTitleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function captureWeekWinsJoin(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Factual, adherence-neutral wins in priority order: PRs, then volume filled,
// then goal pace. Each category collapses into one quiet line; a missing or
// empty category is simply skipped (never an empty-state placeholder).
function captureWeekWinsItems(
  payload: CaptureWeekWins | null | undefined,
  escapeHtml: (value: unknown) => string,
): string[] {
  if (!payload) return [];
  const items: string[] = [];

  const prs = Array.isArray(payload.prs) ? payload.prs : [];
  const prNames = prs
    .map((pr) => String((pr && (pr.exercise ?? pr.label)) || "").trim())
    .filter(Boolean);
  if (prNames.length) {
    const shown = prNames.slice(0, 3).map((name) => escapeHtml(name));
    const extra = prNames.length - shown.length;
    // The win leads as a plain sentence — "New best(s) on …" — with the lift names
    // as its content, rather than a count-first stat.
    const lead = prNames.length === 1 ? "New best on" : "New bests on";
    const names = extra > 0 ? `${shown.join(", ")}, and ${extra} more` : captureWeekWinsJoin(shown);
    items.push(`${lead} ${names}`);
  }

  const filled = Array.isArray(payload.volume_filled) ? payload.volume_filled : [];
  const muscleNames = filled
    .map((v) => String((v && (v.muscle ?? v.label)) || "").trim())
    .filter(Boolean)
    .map((name) => escapeHtml(captureTitleCase(name)));
  if (muscleNames.length) {
    const verb = muscleNames.length > 1 ? "their" : "its";
    items.push(`${captureWeekWinsJoin(muscleNames)} hit ${verb} productive volume`);
  }

  const pace = payload.pace;
  const paceLabel = pace && pace.status === "on" ? String(pace.label || "").trim() : "";
  if (paceLabel) items.push(escapeHtml(paceLabel));

  return items.slice(0, 3);
}

function captureWeekWinsHtml(items: string[]): string {
  if (!items.length) return "";
  const rows = items.map((item) => `<li class="weekly-wins-item">${item}</li>`).join("");
  return `<div class="weekly-wins">
      <span class="weekly-wins-lbl lbl">This week's wins</span>
      <ul class="weekly-wins-list">${rows}</ul>
    </div>`;
}

// Best-effort, null-safe: an absent/failed /week-wins fetch leaves the weekly
// card exactly as the agent wrote it — no error, no placeholder. Re-checks
// the card after the await in case the slot re-rendered (or the athlete left
// Today) while the fetch was in flight.
async function captureRenderWeekWins(wSlot: HTMLElement, deps: CaptureReadsDeps): Promise<void> {
  if (!wSlot.querySelector(".weekly-card")) return;
  let payload: CaptureWeekWins | null = null;
  try {
    payload = (await deps.api("/week-wins")) as CaptureWeekWins;
  } catch {
    payload = null;
  }
  if (deps.state.tab !== "today" || !wSlot.isConnected) return;
  const card = wSlot.querySelector<HTMLElement>(".weekly-card");
  if (!card) return;
  const html = captureWeekWinsHtml(captureWeekWinsItems(payload, deps.escapeHtml));
  if (!html) return;
  // Keep the wins in the HERO: land them above the depth fold when it's present,
  // otherwise just before the foot. Either way they sit with the read + one change.
  const anchor = card.querySelector(".weekly-depth") || card.querySelector(".weekly-foot");
  if (anchor) anchor.insertAdjacentHTML("beforebegin", html);
  else card.insertAdjacentHTML("beforeend", html);
}

function createCaptureReadsController(deps: CaptureReadsDeps): CaptureReadsController {
  const slot = (selector: string) => deps.root.querySelector<HTMLElement>(selector);
  const cardDeps: CaptureReadCardDeps = {
    api: deps.api,
    toast: deps.toast,
    collapseEl: deps.collapseEl,
    escapeHtml: deps.escapeHtml,
    weekRangeLabel: captureReadsWeekRangeLabel,
    // Deferred to call time (after `jobs` is initialized below) so the stale
    // re-read tap regenerates through the existing weekly-read op.
    rereadWeekly: () => jobs.forceGenerateWeekly(),
  };
  const cards = captureReadCardsApi();
  const renderInsightInSlot = (target: HTMLElement, insight: CaptureInsight) =>
    cards.renderInsightInSlot(target, insight, cardDeps);
  const renderWeeklyInSlot = (target: HTMLElement, insight: CaptureInsight) =>
    cards.renderWeeklyInSlot(target, insight, cardDeps);
  const renderWeeklyWithTeam = (target: HTMLElement, insight: CaptureInsight, team: CaptureTeamWeek | null) =>
    cards.renderWeeklyInSlot(target, insight, cardDeps, team);
  const renderTeamWeekInSlot = (target: HTMLElement, team: CaptureTeamWeek | null) =>
    cards.renderTeamWeekInSlot(target, team, cardDeps);
  const jobs = captureReadJobsApi().createController({
    state: deps.state,
    runOp: deps.runOp,
    storage: deps.storage,
    slot,
    renderInsightInSlot,
    renderWeeklyInSlot,
  });

  // One fetch of GET /api/insights, split into two calm surfaces under the Brief:
  // the WEEKLY READ ("how the week went + the one change") and the one-at-a-time
  // CONNECTION insight. Empty means nothing renders; producers stay backgrounded.
  async function loadTodayReads(): Promise<void> {
    const wSlot = slot("#weeklySlot");
    const iSlot = slot("#insightSlot");
    if (!wSlot && !iSlot) return;
    let list: CaptureInsight[] = [];
    // The team's-week digest sits under the weekly card; fetch it alongside the
    // insights (best-effort — a failed fetch just drops the team sections). Only
    // ask for it when the weekly slot is on screen.
    let team: CaptureTeamWeek | null = null;
    try {
      const [insights, teamWeek] = await Promise.all([
        deps.api("/insights") as Promise<CaptureInsight[]>,
        wSlot ? (deps.api("/team-week") as Promise<CaptureTeamWeek>).catch(() => null) : Promise.resolve(null),
      ]);
      list = insights;
      team = teamWeek;
    } catch {
      list = [];
    }
    if (deps.state.tab !== "today") return;
    const arr = Array.isArray(list) ? list : [];
    if (wSlot && wSlot.isConnected) {
      const weekly = arr.find((i) => i && i.kind === "weekly_read");
      if (weekly) {
        renderWeeklyWithTeam(wSlot, weekly, team);
        void captureRenderWeekWins(wSlot, deps);
      } else if (cards.teamWeekHasContent(team)) {
        // No agentic weekly read yet — the deterministic team body stands alone
        // (graceful degradation), and we still nudge a weekly read to generate.
        renderTeamWeekInSlot(wSlot, team);
        jobs.maybeGenerateWeekly();
      } else {
        wSlot.innerHTML = "";
        jobs.maybeGenerateWeekly();
      }
    }
    if (iSlot && iSlot.isConnected) {
      const conn = arr.find((i) => i && i.kind !== "weekly_read");
      if (conn) renderInsightInSlot(iSlot, conn);
      else {
        iSlot.innerHTML = "";
        jobs.maybeGenerateInsight();
      }
    }
  }

  return {
    weekRangeLabel: captureReadsWeekRangeLabel,
    loadTodayReads,
    reconnectInsight: jobs.reconnectInsight,
  };
}

const CAIRN_CAPTURE_READS = {
  createController: createCaptureReadsController,
  weekRangeLabel: captureReadsWeekRangeLabel,
  weekWinsItems: captureWeekWinsItems,
  weekWinsHtml: captureWeekWinsHtml,
};

Object.assign(globalThis, {
  CairnCaptureReads: CAIRN_CAPTURE_READS,
  weekRangeLabel: captureReadsWeekRangeLabel,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnCaptureReads: CAIRN_CAPTURE_READS,
    weekRangeLabel: captureReadsWeekRangeLabel,
  });
}

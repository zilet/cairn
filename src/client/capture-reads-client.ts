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
    const names = shown.join(", ") + (extra > 0 ? `, +${extra} more` : "");
    const label = prNames.length === 1 ? "1 new best" : `${prNames.length} new bests`;
    items.push(`${label} — ${names}`);
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
  const foot = card.querySelector(".weekly-foot");
  if (foot) foot.insertAdjacentHTML("beforebegin", html);
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
  };
  const cards = captureReadCardsApi();
  const renderInsightInSlot = (target: HTMLElement, insight: CaptureInsight) =>
    cards.renderInsightInSlot(target, insight, cardDeps);
  const renderWeeklyInSlot = (target: HTMLElement, insight: CaptureInsight) =>
    cards.renderWeeklyInSlot(target, insight, cardDeps);
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
    try {
      list = await deps.api("/insights") as CaptureInsight[];
    } catch {
      list = [];
    }
    if (deps.state.tab !== "today") return;
    const arr = Array.isArray(list) ? list : [];
    if (wSlot && wSlot.isConnected) {
      const weekly = arr.find((i) => i && i.kind === "weekly_read");
      if (weekly) {
        renderWeeklyInSlot(wSlot, weekly);
        void captureRenderWeekWins(wSlot, deps);
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

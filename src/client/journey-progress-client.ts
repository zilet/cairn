// @ts-check
// Progress journey arc: current phase, recomposition strategy, and a possible
// next phase. Coach is an optional conversation, never an approval gate.

type JourneyProgressRead = import("../contracts/client-api.js").ClientJourneyRead;
type JourneyProgressMilestone = import("../contracts/client-api.js").ClientJourneyMilestone;
type JourneyProgressTransition = import("../contracts/client-api.js").ClientJourneyTransitionSuggestion;

type JourneyProgressDeps = {
  stagger?(index?: number | null): string;
};

function jpRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jpRows<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function jpNumber(value: unknown): number | null {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function jpText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function jpPhaseLabel(kind: unknown): string {
  const s = jpText(kind || "journey").replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Journey";
}

function jpDate(iso: unknown): string {
  if (typeof fmtShortDate === "function") return fmtShortDate(iso);
  return jpText(iso);
}

function jpPounds(value: unknown): string {
  const n = jpNumber(value);
  return n == null ? "" : `${Math.round(n * 10) / 10} lb`;
}

function jpBodyFat(value: unknown): string {
  const n = jpNumber(value);
  return n == null ? "" : `${Math.round(n * 10) / 10}% BF`;
}

function jpMilestones(read: JourneyProgressRead | null | undefined, milestones: unknown): JourneyProgressMilestone[] {
  const direct = jpRows<JourneyProgressMilestone>(milestones);
  const embedded = jpRows<JourneyProgressMilestone>(read?.milestones);
  const seen = new Set<string>();
  const out: JourneyProgressMilestone[] = [];
  for (const m of [...direct, ...embedded]) {
    const id = jpText(m?.id || m?.label);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  return out.sort((a, b) => (jpNumber(b.priority) || 0) - (jpNumber(a.priority) || 0)).slice(0, 4);
}

function jpHasRead(read: JourneyProgressRead | null | undefined, milestones?: unknown): boolean {
  if (!read) return jpRows(milestones).length > 0;
  return !!(
    read.active_phase ||
    read.recomposition ||
    read.transition_suggestion ||
    jpRows(read.proposed_phases).length ||
    jpRows(read.milestones).length ||
    jpRows(milestones).length
  );
}

function jpArcSteps(read: JourneyProgressRead | null | undefined, transition: JourneyProgressTransition | null): string[] {
  const phase = jpRecord(read?.active_phase);
  const active = jpPhaseLabel(phase.kind || transition?.kind || read?.profile?.goal_mode || "journey");
  const target = jpPounds(phase.target_weight_lb || read?.profile?.goal_weight_lb) || jpBodyFat(phase.target_bodyfat_pct || read?.profile?.goal_bodyfat_pct);
  const next = transition ? `Possible ${jpPhaseLabel(transition.kind)}` : "Steady";
  return ["Started", active, target || "Target", next];
}

function jpPhaseLine(read: JourneyProgressRead | null | undefined): string {
  const strategy = read?.recomposition;
  const phase = jpRecord(read?.active_phase);
  if (phase.kind) {
    const bits = [jpText(strategy?.stage?.label) || jpPhaseLabel(phase.kind)];
    const started = jpDate(phase.start_date);
    const target = jpPounds(phase.target_weight_lb) || jpBodyFat(phase.target_bodyfat_pct);
    if (started) bits.push(`since ${started}`);
    if (target) bits.push(`toward ${target}`);
    return bits.join(" / ");
  }
  const suggestion = read?.transition_suggestion;
  if (strategy?.stage?.label) return jpText(strategy.stage.label);
  if (suggestion) return `${jpPhaseLabel(suggestion.kind)} is a possible next phase`;
  const mode = read?.profile?.goal_mode ? jpPhaseLabel(read.profile.goal_mode) : "";
  return mode ? `${mode} goal arc` : "Journey arc";
}

function jpDiscussQuestion(suggestion: JourneyProgressTransition): string {
  const kind = jpPhaseLabel(suggestion.kind).toLowerCase();
  const reason = jpText(suggestion.reason);
  return `Discuss a possible Cairn journey phase: ${kind}. ${reason} This is a read-only possibility, not a scheduled change or approval gate; explain how it fits my data and adjust the plan if our conversation changes the best path.`;
}

function jpSuggestionHtml(suggestion: JourneyProgressTransition | null | undefined): string {
  if (!suggestion) return "";
  const target = jpPounds(suggestion.target_weight_lb) || jpBodyFat(suggestion.target_bodyfat_pct);
  return `<div class="jprog-suggestion">
    <div>
      <div class="lbl">Possible next phase</div>
      <div class="jprog-sug-title">${escHtml(jpPhaseLabel(suggestion.kind))}</div>
      <div class="jprog-sug-reason">${escHtml(suggestion.reason)}</div>
      ${target ? `<div class="jprog-sug-meta">Target holds around ${escHtml(target)}</div>` : ""}
    </div>
    <button class="linkbtn linkbtn-quiet linkbtn-sm jprog-review" type="button" data-jpreview="${escAttr(jpDiscussQuestion(suggestion))}">Discuss with coach &rarr;</button>
  </div>`;
}

function jpStrategyHtml(read: JourneyProgressRead | null | undefined): string {
  const strategy = read?.recomposition;
  if (!strategy) return "";
  const progress = strategy.progress;
  const rate = progress?.target_rate;
  const timeline = progress?.timeline;
  const progressBits = [
    progress?.lost_lb != null ? `${jpPounds(progress.lost_lb)} down` : "",
    progress?.remaining_lb != null ? `${jpPounds(progress.remaining_lb)} remaining` : "",
  ].filter(Boolean);
  const rateLine = rate
    ? `Current phase range: ${jpNumber(rate.low)?.toFixed(1)}–${jpNumber(rate.high)?.toFixed(1)} lb per week.`
    : "";
  const timelineLine = timeline
    ? `Likely path: about ${timeline.earliest_weeks}–${timeline.latest_weeks} weeks${timeline.includes_stabilization ? ", including room to stabilize" : ""}.`
    : "";
  const muscleLabel = jpPhaseLabel(strategy.muscle?.state || "unknown");
  const fuelLabel = jpPhaseLabel(strategy.fuel?.state || "unknown");
  const actionLabel = jpText(strategy.action?.label)
    || (strategy.action?.status === "recommended" || strategy.action?.kind === "protect_fuel"
      ? "Next protective adjustment"
      : "What Cairn is doing");
  return `<div class="jprog-strategy">
    <div class="jprog-sug-reason">${escHtml(strategy.line)}</div>
    ${progressBits.length ? `<div class="jprog-sug-meta">${escHtml(progressBits.join(" · "))}</div>` : ""}
    ${rateLine ? `<div class="jprog-sug-meta">${escHtml(rateLine)}</div>` : ""}
    ${timelineLine ? `<div class="jprog-sug-meta">${escHtml(timelineLine)}</div>` : ""}
    <div class="jprog-suggestion">
      <div><div class="lbl">What the scale says</div><div class="jprog-sug-reason">${escHtml(strategy.scale?.line || "The trend is still settling.")}</div></div>
      <div><div class="lbl">Muscle / fuel</div><div class="jprog-sug-reason">${escHtml(`${muscleLabel} · ${fuelLabel}`)}</div></div>
    </div>
    <div class="jprog-moment">
      <div class="jprog-moment-mark" aria-hidden="true"></div>
      <div><div class="lbl">${escHtml(actionLabel)}</div><div class="jprog-moment-detail">${escHtml(strategy.action?.line || "Holding the current plan while the signal settles.")}</div>${strategy.reassurance ? `<div class="jprog-moment-date">${escHtml(strategy.reassurance)}</div>` : ""}</div>
    </div>
  </div>`;
}

function jpMilestoneHtml(milestone: JourneyProgressMilestone | null | undefined): string {
  if (!milestone) return "";
  const when = milestone.achieved_date ? jpDate(milestone.achieved_date) : "";
  return `<div class="jprog-moment">
    <div class="jprog-moment-mark" aria-hidden="true"></div>
    <div>
      <div class="lbl">Latest milestone</div>
      <div class="jprog-moment-title">${escHtml(milestone.label)}</div>
      ${milestone.detail ? `<div class="jprog-moment-detail">${escHtml(milestone.detail)}</div>` : ""}
      ${when ? `<div class="jprog-moment-date">${escHtml(when)}</div>` : ""}
    </div>
  </div>`;
}

function jpArcHtml(steps: string[]): string {
  return `<div class="jprog-arc" aria-label="Journey phase arc">
    ${steps.map((step, i) => `
      <div class="jprog-step${i === 1 ? " active" : ""}${i < 1 ? " done" : ""}">
        <span class="jprog-dot" aria-hidden="true"></span>
        <span class="jprog-step-label">${escHtml(step)}</span>
      </div>`).join("")}
  </div>`;
}

function journeyProgressCardHtml(
  read: JourneyProgressRead | null | undefined,
  milestones: unknown,
  deps: JourneyProgressDeps = {},
): string {
  if (!jpHasRead(read, milestones)) return "";
  const milestoneRows = jpMilestones(read, milestones);
  const suggestion = read?.transition_suggestion || null;
  const steps = jpArcSteps(read, suggestion);
  const phaseLine = jpPhaseLine(read);
  const latest = milestoneRows[0] || null;
  const fallback = latest || suggestion ? "" : `<div class="jprog-quiet">Keep logging bodyweight and measurements; the next phase read will appear when there is enough signal.</div>`;
  const style = typeof deps.stagger === "function" ? deps.stagger(2) : (typeof stagger === "function" ? stagger(2) : "");
  return `<section class="well-accent well-accent-sage jprog-card reveal" style="${style}">
    <div class="jprog-head">
      <div>
        <div class="lbl">Journey</div>
        <h3 class="jprog-title">${escHtml(phaseLine)}</h3>
      </div>
      <span class="jprog-chip">${escHtml(latest ? "earned" : suggestion ? "possible next" : "current")}</span>
    </div>
    ${jpArcHtml(steps)}
    ${jpStrategyHtml(read)}
    ${jpMilestoneHtml(latest)}
    ${jpSuggestionHtml(suggestion)}
    ${fallback}
  </section>`;
}

// A one-line plain-language phase read for a compact fold summary: the same lead
// string the card's header shows (phase name + pace/status, e.g. "Mid-cut / since
// Jul 1 / toward 180 lb"), or "" when there is no journey read yet. No score.
function journeyPhaseSummary(
  read: JourneyProgressRead | null | undefined,
  milestones?: unknown,
): string {
  if (!jpHasRead(read, milestones)) return "";
  return jpPhaseLine(read);
}

function wireJourneyProgress(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-jpreview]").forEach((button) => {
    button.addEventListener("click", () => {
      const question = button.getAttribute("data-jpreview") || "";
      const g = globalThis as unknown as {
        CairnHealthClient?: { askCoach?: (q: unknown) => void };
        state?: { chatPrefill?: string | null };
        activateTab?: (name: string) => unknown;
      };
      if (g.CairnHealthClient?.askCoach) {
        g.CairnHealthClient.askCoach(question);
        return;
      }
      if (g.state) g.state.chatPrefill = question.slice(0, 600);
      if (typeof g.activateTab === "function") g.activateTab("chat");
    });
  });
}

const CAIRN_PROGRESS_JOURNEY = {
  hasRead: jpHasRead,
  journeyCardHtml: journeyProgressCardHtml,
  phaseSummary: journeyPhaseSummary,
  wire: wireJourneyProgress,
};

Object.assign(globalThis, { CairnProgressJourney: CAIRN_PROGRESS_JOURNEY });
if (typeof window !== "undefined") Object.assign(window, { CairnProgressJourney: CAIRN_PROGRESS_JOURNEY });

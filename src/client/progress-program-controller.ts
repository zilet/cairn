// @ts-check
// Progress -> Program route controller: SWR fan-out, conductor state, DOM paint, and actions.

type ProgressProgramRecord = Record<string, unknown>;
type ProgressProgramStat = readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }];
type ProgressProgramState = import("../contracts/client-api.js").ClientProgramState;
type ProgressStrengthJourney = import("../contracts/client-api.js").ClientStrengthJourney;
type ProgressAnchorSuggestion = import("../contracts/client-api.js").ClientAnchorObjectiveSuggestion;

function isProgressProgramRecord(value: unknown): value is ProgressProgramRecord {
  return !!value && typeof value === "object";
}

function progressProgramRecord(value: unknown): ProgressProgramRecord {
  return isProgressProgramRecord(value) ? value : {};
}

// The quiet invitation into the anchor-lift journey, shown only when nothing is
// chosen yet. A suggestion, never a gate: one tap starts it (the existing create
// path), a second tap dismisses it for a long while.
function strengthSuggestionCardHtml(suggestion: ProgressAnchorSuggestion): string {
  const gap = Number(suggestion.gap_lb);
  const gapText = Number.isFinite(gap) && gap > 0 ? `${gap.toFixed(1)} lb to go` : "within reach";
  const target = Number(suggestion.target_est_1rm);
  const targetAttr = Number.isFinite(target) ? String(target) : "";
  return `<section class="sjourney-card sjourney-suggest reveal" aria-label="Anchor-lift suggestion">
    <div class="sjourney-head"><span class="lbl">Anchor lift · a suggestion</span><span>${escHtml(gapText)}</span></div>
    <h2>${escHtml(suggestion.title)}</h2>
    <div class="sjourney-suggest-detail">${escHtml(suggestion.detail)}</div>
    <div class="sjourney-suggest-basis lbl">${escHtml(suggestion.basis)}</div>
    <div class="sjourney-suggest-actions">
      <button class="draftbtn" type="button" data-sjug-start
        data-sjug-exercise="${escAttr(suggestion.exercise)}"
        data-sjug-kind="${escAttr(suggestion.target_kind)}"
        data-sjug-target="${escAttr(targetAttr)}">Make this my anchor</button>
      <button class="ghostbtn sjourney-suggest-dismiss" type="button" data-sjug-dismiss>Not now</button>
    </div>
  </section>`;
}

function strengthJourneyCardHtml(value: unknown): string {
  const journey = value && typeof value === "object" ? (value as Partial<ProgressStrengthJourney>) : null;
  const objective = journey?.objective;
  if (!journey?.available || !objective?.exercise || !Number.isFinite(Number(objective.target_est_1rm))) {
    return journey?.suggestion ? strengthSuggestionCardHtml(journey.suggestion) : "";
  }
  const current = journey.current?.est_1rm;
  const currentDate = journey.current?.date ? String(journey.current.date) : null;
  const currentText = Number.isFinite(Number(current))
    ? `${Number(current).toFixed(1)} lb estimated 1RM${currentDate ? ` · ${currentDate}` : ""}`
    : "Estimated 1RM not established yet";
  const targetText = `${Number(objective.target_est_1rm).toFixed(1)} lb estimated 1RM target`;
  const gap = journey.gap_lb;
  const completed = objective.status === "completed";
  const gapText = completed
    ? "milestone complete"
    : Number.isFinite(Number(gap)) && Number(gap) > 0
      ? `${Number(gap).toFixed(1)} lb to rebuild`
      : "at the target";
  const phase = String(journey.phase || "establishing").replace(/_/g, " ");
  const trend = journey.trend;
  const trendText =
    trend?.direction === "rising" && Number.isFinite(Number(trend.est_1rm_lb_per_week))
      ? `${trend.direction} · about ${Number(trend.est_1rm_lb_per_week).toFixed(1)} lb/week from ${Number(trend.exposures) || 0} exact-lift exposures`
      : trend?.direction
        ? `${trend.direction} · ${Number(trend.exposures) || 0} exact-lift exposures`
        : `${Number(trend?.exposures) || 0} exact-lift exposures logged`;
  const projection = journey.projection
    ? `<div class="sjourney-range"><span class="lbl">Planning range</span><strong>${Number(journey.projection.earliest_weeks)}–${Number(journey.projection.latest_weeks)} weeks</strong><span>${escHtml(journey.projection.caveat)}</span></div>`
    : "";
  const checkpoint = completed
    ? `<div class="sjourney-next"><span class="lbl">Checkpoint</span><strong>Target rebuilt${objective.achieved_date ? ` · ${escHtml(objective.achieved_date)}` : ""}</strong><span>Keep it steady and consolidate this milestone before choosing another goal.</span></div>`
    : journey.phase === "protecting"
      ? `<div class="sjourney-next"><span class="lbl">Checkpoint</span><strong>Hold or ease the anchor</strong><span>${escHtml(journey.projection_withheld_reason || "Relevant pain, injury, or a load constraint takes priority today.")}</span></div>`
      : journey.next_prescription
        ? `<div class="sjourney-next"><span class="lbl">Checkpoint</span><strong>${escHtml(journey.next_prescription.delta_text)}</strong><span>${escHtml(journey.next_prescription.why)}</span></div>`
        : `<div class="sjourney-next"><span class="lbl">Checkpoint</span><strong>Establish the next clean anchor exposure</strong><span>${escHtml(journey.projection_withheld_reason || "Log another exact-lift exposure before Cairn projects the path.")}</span></div>`;
  const support = Array.isArray(journey.planned_support) ? journey.planned_support.slice(0, 3) : [];
  const supportHtml = support.length
    ? `<div class="sjourney-support"><span class="lbl">Strength around it · planned</span>${support.map((item) => `<span><b>${escHtml(item.role)}</b> · ${escHtml(item.exercise)} · ${escHtml(item.why)}</span>`).join("")}</div>`
    : "";
  return `<section class="sjourney-card reveal" aria-label="Strength comeback journey">
    <div class="sjourney-head"><span class="lbl">Anchor lift · ${escHtml(phase)}</span><span>${escHtml(gapText)}</span></div>
    <h2>${escHtml(objective.exercise)}</h2>
    <div class="sjourney-route"><span>${escHtml(currentText)}</span><i aria-hidden="true">→</i><span>${escHtml(targetText)}</span></div>
    <div class="sjourney-trend">${escHtml(trendText)}</div>
    ${checkpoint}${supportHtml}${projection}
  </section>`;
}

async function loadStrengthJourney(deps: ClientProgressProgramControllerDeps): Promise<void> {
  let result: unknown = null;
  try {
    result = await deps.api("/strength-journey");
  } catch {
    result = null;
  }
  const slot = deps.view.querySelector("#progStrengthJourneySlot");
  if (!slot) return;
  slot.innerHTML = strengthJourneyCardHtml(result);
  wireStrengthSuggestion(slot, deps);
}

// One tap starts the suggested anchor (the existing create path); "Not now"
// quiets it for a long while. Both re-render in place from the fresh read.
function wireStrengthSuggestion(slot: Element, deps: ClientProgressProgramControllerDeps): void {
  const startBtn = slot.querySelector<HTMLElement>("[data-sjug-start]");
  if (startBtn)
    startBtn.addEventListener("click", () => {
      void (async () => {
        const restore = deps.busy(startBtn, "Setting your anchor…");
        const targetRaw = startBtn.getAttribute("data-sjug-target") || "";
        const body: Record<string, unknown> = {
          exercise: startBtn.getAttribute("data-sjug-exercise") || "",
          target_kind: startBtn.getAttribute("data-sjug-kind") || "",
        };
        if (targetRaw) body.target_est_1rm = Number(targetRaw);
        let ok = false;
        try {
          const res = (await deps.api("/strength-journey", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })) as { objective?: unknown; error?: string } | null;
          ok = !!res && !!res.objective;
        } catch {
          ok = false;
        }
        if (ok) {
          deps.toast("Anchor set — your comeback journey starts here");
          deps.invalidate("progress:program");
          await loadStrengthJourney(deps);
          return;
        }
        restore();
        deps.toast("Couldn't set that anchor — try again in a bit.");
      })();
    });

  const dismissBtn = slot.querySelector<HTMLElement>("[data-sjug-dismiss]");
  if (dismissBtn)
    dismissBtn.addEventListener("click", () => {
      void (async () => {
        try {
          await deps.api("/strength-journey/suggestion/dismiss", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
        } catch {
          /* best-effort — hide it regardless */
        }
        slot.innerHTML = "";
        deps.toast("Set aside — you can choose an anchor anytime");
      })();
    });
}

// The conductor lead for Progress -> Program. Cached as rendered HTML so the
// Program body can collapse the deep read only when a usable focus card exists.
var _progFocusCard: string | undefined;
const PROGRESS_FOCUS_STATE = {
  cardHtml: () => (typeof _progFocusCard === "string" ? _progFocusCard : ""),
  hasFocusCard: () => !!_progFocusCard,
};

Object.assign(globalThis, { CairnProgressFocus: PROGRESS_FOCUS_STATE });

if (typeof window !== "undefined") {
  window.CairnProgressFocus = PROGRESS_FOCUS_STATE;
}

// The recovery-week override asks the same expert-team workflow to reshape next
// week; in Lead mode it announces and lands at the boundary, while explicit
// review posture keeps the legacy proposal boundary.
// instruction rides the same durable /program/evolve job as "Evolve my plan").
const RECOVERY_WEEK_INSTRUCTION =
  "Reshape next week into a RECOVERY (deload) week: cut working-set volume roughly in half, " +
  "keep every movement pattern, keep efforts easy and crisp (3-4 reps in reserve), no new " +
  "exercises and no load PRs — an earned reset after sustained loading, so the athlete comes back stronger.";

// Optional athlete-initiated fresh read. Background evolution uses this same
// shared service; the button is an override, not a periodic replan chore.
async function triggerProgramEvolve(
  btn: Element,
  deps: ClientProgressProgramControllerDeps,
  opts: { instruction?: string; busy?: string; anchor?: string; caption?: string[]; toast?: string } = {}
): Promise<void> {
  const anchor = opts.anchor || ".prog-evolve-foot";
  const foot = btn.closest(anchor) || btn.parentElement;
  const restore = deps.busy(btn, opts.busy || "Drafting your plan…");
  let cap = foot && foot.querySelector(".prog-evolve-cap");
  if (foot && !cap) {
    cap = document.createElement("div");
    cap.className = "prog-evolve-cap job-cap lbl";
    foot.appendChild(cap);
  }
  const cleanup = () => {
    restore();
    cap?.remove();
  };
  await deps.runOp("evolve_program", opts.instruction ? { instruction: opts.instruction } : {}, {
    path: "/program/evolve",
    anchor,
    caption: opts.caption || [
      "reading how your lifts are trending",
      "spotting what's stalled",
      "drafting how your plan should evolve",
      "checking it against your constraints",
    ],
    guard: () => !document.querySelector(anchor)?.isConnected,
    render: (result: unknown) => {
      cleanup();
      const row = progressProgramRecord(result);
      const autonomy = progressProgramRecord(row.autonomy);
      deps.toast(
        autonomy.pending || autonomy.announced
          ? "Set — your team will land it at the natural boundary"
          : autonomy.tier === "quiet_apply"
            ? "Updated — your plan follows the latest read"
            : opts.toast || "Ready for your review"
      );
      deps.invalidate("progress:program");
      deps.invalidate("plan:coach");
      deps.invalidate("plan:proposals");
      if (deps.state.tab === "progress") deps.renderSelf();
    },
    onFail: () => {
      cleanup();
      deps.toast("Couldn't draft right now — try again in a bit.");
    },
  });
}

// The conductor's stalled-lift lead may carry a one-tap variation swap. Applied
// DETERMINISTICALLY via /program/swap/apply (no agent turn) — the plan follows
// immediately for future sessions; an accepted Today snapshot stays immutable.
// Double-taps are guarded while the request is in flight.
async function applyCoachingFocusSwap(btn: Element, deps: ClientProgressProgramControllerDeps): Promise<void> {
  const el = btn instanceof HTMLElement ? btn : null;
  if (el?.dataset.busy === "1") return;
  if (el) el.dataset.busy = "1";
  const from = btn.getAttribute("data-swap-from") || "";
  const to = btn.getAttribute("data-swap-to") || "";
  const restore = deps.busy(btn, "Rotating it in…");
  let result: { ok?: boolean; error?: string; message?: string } | null = null;
  try {
    result = (await deps.api("/program/swap/apply", {
      method: "POST",
      // Content-Type is MANDATORY here — api() does not auto-set it (a past bug).
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    })) as { ok?: boolean; error?: string; message?: string } | null;
  } catch {
    result = null;
  }
  if (result?.ok) {
    deps.toast("Weekly plan updated — today’s accepted session stays the same.");
    deps.invalidate("progress:program");
    deps.invalidate("plan:coach");
    deps.invalidate("plan:proposals");
    if (deps.state.tab === "progress") deps.renderSelf();
    return;
  }
  deps.toast(result?.error || "Couldn't rotate that in right now.");
  restore();
  if (el) el.dataset.busy = "";
}

async function renderProgressProgram(deps: ClientProgressProgramControllerDeps): Promise<unknown> {
  deps.headerTitle.textContent = "Program";
  deps.state.progressSeg = "program";
  const token = deps.nextToken();
  const peek = deps.peekCached<ProgressProgramState>("progress:program");
  if (!peek) deps.view.innerHTML = deps.skeletonHtml("program", 3);

  // Fetch the conductor in parallel. It never blocks the warm Program paint; if the
  // card presence changes, repaint from the cached program-state payload.
  deps
    .api("/coaching-focus")
    .then((focus) => {
      // blockLine:false — this screen already owns block truth via the pblock
      // card's "Current block · week N of M"; stating the week twice is noise.
      const card =
        typeof coachingFocusCardHtml === "function"
          ? coachingFocusCardHtml(focus as ClientCoachingFocus | null | undefined, { blockLine: false, actions: true })
          : "";
      const prev = _progFocusCard;
      _progFocusCard = card;
      if (card === prev) return;
      if (!card && (prev === undefined || prev === "")) return;
      if (deps.isCurrent(token) && deps.state.tab === "progress" && deps.state.progressSeg === "program") {
        const cached = deps.peekCached<ProgressProgramState>("progress:program");
        if (cached) paintProgressProgramBody(cached.data, deps);
      }
    })
    .catch(() => {});

  return deps.paintSWR({
    key: "progress:program",
    path: "/program-state",
    peek,
    token,
    tab: "progress",
    render: (data: ProgressProgramState) => paintProgressProgramBody(data, deps),
  });
}

function paintProgressProgramBody(data: ProgressProgramState, deps: ClientProgressProgramControllerDeps): void {
  const head = deps.segmentHtml("program");
  const lifts = data.lifts;
  const volume = data.volume;
  const meso = data.mesocycle || null;
  const endurance = data.endurance || null;
  const hybrid = data.hybrid || null;
  const headline = data.headline || "";
  const adaptations = data.adaptations_due;

  if (!lifts.length && !volume.length && !meso && !endurance && !hybrid) {
    deps.view.innerHTML =
      head +
      deps.hero("Program", []) +
      `<div id="progStrengthJourneySlot" class="sjourney-slot"></div>` +
      deps.empty(
        deps.art("exercise", "barbell squat"),
        "Not enough data yet — log a few sessions and your program intelligence will read here."
      );
    deps.wireSegments();
    void loadStrengthJourney(deps);
    return;
  }

  const sorted = sortLifts(lifts);
  const nStalled = sorted.filter((lift) => lift.status === "plateaued" || lift.status === "regressing").length;
  const nGood = sorted.filter((lift) => lift.status === "progressing").length;
  const heroStats: ProgressProgramStat[] = [];
  if (lifts.length) heroStats.push(["lifts tracked", lifts.length]);
  if (nGood) heroStats.push(["climbing", nGood]);
  if (nStalled) heroStats.push(["stalled", nStalled]);

  const conductor = CairnProgressFocus.cardHtml();
  const hasConductor = !!conductor;
  const headlineHtml = headline
    ? `<div class="prog-headline reveal" style="${stagger(1)}">${escHtml(headline)}</div>`
    : "";

  const testSlot = `<div id="progTestSlot" class="ptest-slot reveal" style="${stagger(1)}"></div>`;
  const strengthJourneySlot = `<div id="progStrengthJourneySlot" class="sjourney-slot" style="${stagger(1)}"></div>`;
  const perfSlot = `<div id="progPerfSlot" class="pperf-slot reveal" style="${stagger(2)}"></div>`;
  const blockSlot = `<div id="progBlockSlot" class="pblock-slot reveal" style="${stagger(2)}"></div>`;
  const adjustSlot = `<div id="progAdjustSlot" class="padj-slot reveal" style="${stagger(3)}"></div>`;
  const muscleSlot = `<div id="progMuscleSlot" class="pmus-slot reveal" style="${stagger(3)}"></div>`;
  const dexaSlot = `<div id="progDexaSlot" class="pdexa-slot reveal" style="${stagger(3)}"></div>`;
  const adaptHtml = adaptations.length ? adaptationsHtml(adaptations, 4) : "";

  const liftsHtml = curatedLiftsHtml(lifts, 5);

  const volumeHtml = volume.length
    ? `<div class="pvol-head lbl reveal" style="${stagger(2)}">Weekly volume by muscle</div>` +
      volumeBlockHtml(volume, 3)
    : "";
  const mesoHtml = meso ? mesoBlockHtml(meso, 4) : "";
  const endHtml = endurance ? enduranceBlockHtml(endurance, 5) : "";
  const hybridHtml = hybrid ? hybridLoadCardHtml(hybrid, 5) : "";

  const evolveFoot = `<div class="prog-evolve-foot reveal" style="${stagger(7)}">
    <button class="draftbtn prog-evolve-btn" id="progEvolveBtn" type="button">Ask team for a fresh program read</button>
    <span class="prog-evolve-note lbl">Optional override — your team already monitors and adapts the program in the background</span>
    <button id="progTidyBtn" class="ghostbtn" style="width:100%;text-align:center;padding:9px;margin-top:11px" type="button">Tidy exercise names</button>
    <span class="prog-evolve-note lbl">Different logs name the same lift differently — Cairn merges duplicates so each one tracks as one line. Runs automatically as you log.</span>
    <div id="progMergeSuggestSlot" class="exmerge-list"></div>
  </div>`;

  let html = "";
  if (hasConductor) {
    html =
      head +
      deps.hero("Program", heroStats) +
      conductor +
      strengthJourneySlot +
      liftsHtml +
      `<details class="full-read reveal" style="${stagger(6)}">
        <summary>The full read</summary>
        <div class="full-read-body">${
          headlineHtml +
          testSlot +
          perfSlot +
          blockSlot +
          adjustSlot +
          muscleSlot +
          dexaSlot +
          adaptHtml +
          volumeHtml +
          mesoHtml +
          endHtml +
          hybridHtml
        }</div>
      </details>` +
      evolveFoot;
  } else {
    html =
      head +
      deps.hero("Program", heroStats) +
      headlineHtml +
      strengthJourneySlot +
      testSlot +
      perfSlot +
      blockSlot +
      adjustSlot +
      muscleSlot +
      dexaSlot +
      adaptHtml +
      liftsHtml +
      volumeHtml +
      mesoHtml +
      endHtml +
      hybridHtml +
      evolveFoot;
  }

  deps.view.innerHTML = html;
  deps.wireSegments();
  deps.runCountUps(deps.view);
  // Every lift row (full, compact, or long-tail variant) carries data-guide;
  // wireGuides opens the exercise detail on tap.
  wireGuides(deps.view);

  void loadStrengthJourney(deps);

  const evolveBtn = deps.view.querySelector("#progEvolveBtn");
  if (evolveBtn)
    evolveBtn.addEventListener("click", () => {
      void triggerProgramEvolve(evolveBtn, deps);
    });

  // The conductor's recovery lead: one tap drafts next week as a recovery week
  // (a reviewable proposal — the button acts, the surrounding lead row still
  // navigates; focusRouteTarget ignores [data-cfocus-act] clicks).
  const recoveryBtn = deps.view.querySelector('[data-cfocus-act="recovery-week"]');
  if (recoveryBtn)
    recoveryBtn.addEventListener("click", () => {
      void triggerProgramEvolve(recoveryBtn, deps, {
        instruction: RECOVERY_WEEK_INSTRUCTION,
        busy: "Drafting your recovery week…",
        anchor: ".cfocus-lead",
        caption: [
          "reading the load you've accumulated",
          "halving the working volume, keeping the patterns",
          "drafting your recovery week",
          "checking it against your constraints",
        ],
        toast: "Recovery week ready for your review",
      });
    });

  // The conductor's stalled-lift lead: one tap rotates a variation into the plan
  // (deterministic apply; the surrounding lead row still navigates).
  deps.view.querySelectorAll<HTMLElement>('[data-cfocus-act="swap"]').forEach((swapBtn) => {
    swapBtn.addEventListener("click", () => {
      void applyCoachingFocusSwap(swapBtn, deps);
    });
  });

  const tidyBtn = deps.view.querySelector("#progTidyBtn");
  if (tidyBtn)
    tidyBtn.addEventListener("click", () => {
      void tidyExerciseNames(tidyBtn, deps);
    });

  loadPerformance();
  loadProgramBlock();
  loadProgramAdjustments();
  loadTestWeek();
  loadMuscleTrajectory();
  loadDexaTargeting("progDexaSlot");
}

// A merge the agent found plausible but wasn't confident/structurally-related
// enough to auto-apply (see shouldAutoApplyMerge server-side) — surfaced instead
// as a one-tap suggestion.
type ExerciseMergeSuggestion = { from: string; into: string; why: string; confidence: string };

function mergeSuggestionCardHtml(pair: ExerciseMergeSuggestion, idx: number): string {
  const why = String(pair.why || "").trim();
  return `<div class="exmerge-card" data-exmerge-card="${idx}">
    <div class="exmerge-text">Merge <b>${escHtml(pair.from)}</b> into <b>${escHtml(pair.into)}</b></div>
    ${why ? `<div class="exmerge-why">${escHtml(why)}</div>` : ""}
    <div class="exmerge-actions">
      <button class="ghostbtn" type="button" data-exmerge-accept="${idx}">Accept</button>
      <button class="ghostbtn" type="button" data-exmerge-skip="${idx}">Skip</button>
    </div>
  </div>`;
}

function mergeSuggestionsInnerHtml(pairs: ExerciseMergeSuggestion[]): string {
  return (
    `<div class="exmerge-head lbl">Cairn's not sure — take a look</div>` +
    pairs.map((p, i) => mergeSuggestionCardHtml(p, i)).join("")
  );
}

// One tap confirms a suggested merge via the existing deterministic /exercises/merge
// endpoint (no agent turn). A per-card busy state guards the double-tap; a failed
// merge surfaces the server's message and leaves the card in place, unlike a
// success which removes it and refreshes the program read.
async function acceptMergeSuggestion(
  acceptBtn: HTMLElement,
  pairs: ExerciseMergeSuggestion[],
  deps: ClientProgressProgramControllerDeps
): Promise<void> {
  const idx = Number(acceptBtn.getAttribute("data-exmerge-accept"));
  const pair = pairs[idx];
  const card = acceptBtn.closest(".exmerge-card");
  if (!pair || !card) return;
  const restore = deps.busy(acceptBtn, "merging…");
  let result: { ok?: boolean; error?: string } | null = null;
  try {
    result = (await deps.api("/exercises/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: pair.from, into: pair.into }),
    })) as { ok?: boolean; error?: string } | null;
  } catch {
    result = null;
  }
  if (result?.ok) {
    deps.toast(`Merged ${pair.from} into ${pair.into}`);
    deps.invalidate("progress:program");
    card.remove();
    if (deps.state.tab === "progress") deps.renderSelf();
    return;
  }
  restore();
  deps.toast(result?.error || "Couldn't merge that — try again.");
}

// Skip just drops the card for THIS run — deliberately no server-side memory, so
// the same suggestion can resurface on the next Tidy.
function wireMergeSuggestions(
  slot: Element,
  pairs: ExerciseMergeSuggestion[],
  deps: ClientProgressProgramControllerDeps
): void {
  slot.querySelectorAll<HTMLElement>("[data-exmerge-skip]").forEach((skipBtn) => {
    skipBtn.addEventListener("click", () => {
      skipBtn.closest(".exmerge-card")?.remove();
    });
  });
  slot.querySelectorAll<HTMLElement>("[data-exmerge-accept]").forEach((acceptBtn) => {
    acceptBtn.addEventListener("click", () => {
      void acceptMergeSuggestion(acceptBtn, pairs, deps);
    });
  });
}

// "Tidy exercise names" merges duplicate movements so each lift tracks as one line.
async function tidyExerciseNames(btn: Element, deps: ClientProgressProgramControllerDeps): Promise<void> {
  const restore = deps.busy(btn, "tidying…");
  let result: unknown = null;
  try {
    result = await deps.api("/exercises/reconcile-names", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    result = null;
  }
  restore();
  const row = progressProgramRecord(result);
  if (!isProgressProgramRecord(result) || row.ok === false) {
    deps.toast("Couldn't tidy names — try again.");
    return;
  }
  const n = Number(row.aligned ?? row.applied) || 0;
  // A later wave folds duplicate movements into one tracked line (and can correct
  // the muscle group in the process); read the additive fields defensively so this
  // branch works standalone.
  const merged = Array.isArray(row.merged) ? row.merged.length : 0;
  const groupsFixed = Number(row.groups_fixed) || 0;
  let msg =
    n && merged
      ? `Tidied ${n} name${n === 1 ? "" : "s"} · merged ${merged} duplicate${merged === 1 ? "" : "s"}`
      : n
        ? `Tidied ${n} exercise name${n === 1 ? "" : "s"}`
        : merged
          ? `Merged ${merged} duplicate${merged === 1 ? "" : "s"}`
          : "";
  if (groupsFixed) {
    const groupBit = `${msg ? "fixed" : "Fixed"} ${groupsFixed} muscle group${groupsFixed === 1 ? "" : "s"}`;
    msg = msg ? `${msg} · ${groupBit}` : groupBit;
  }
  if (!msg) msg = "Names already tidy";
  deps.toast(msg);

  // Lower-confidence merge candidates the agent found (structurally related but
  // not auto-applied) get a one-tap review card. Rendered into the dedicated slot
  // right after the Tidy button; a subsequent full repaint below (when a
  // deterministic change also happened this run) will replace it like any other
  // slot, same as the rest of this screen's async cards.
  const suggested = Array.isArray(row.suggested) ? (row.suggested as ExerciseMergeSuggestion[]) : [];
  const suggestSlot = deps.view.querySelector("#progMergeSuggestSlot");
  if (suggestSlot) {
    suggestSlot.innerHTML = suggested.length ? mergeSuggestionsInnerHtml(suggested) : "";
    if (suggested.length) wireMergeSuggestions(suggestSlot, suggested, deps);
  }

  if (n || merged || groupsFixed) {
    deps.invalidate("progress:program");
    deps.renderSelf();
  }
}

const CAIRN_PROGRESS_PROGRAM_CONTROLLER = {
  focus: PROGRESS_FOCUS_STATE,
  render: renderProgressProgram,
  paint: paintProgressProgramBody,
  triggerProgramEvolve,
  tidyExerciseNames,
  strengthJourneyCardHtml,
};

Object.assign(globalThis, { CairnProgressProgramController: CAIRN_PROGRESS_PROGRAM_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnProgressProgramController = CAIRN_PROGRESS_PROGRAM_CONTROLLER;
}

// @ts-check
// Progress -> Program route controller: SWR fan-out, conductor state, DOM paint, and actions.

type ProgressProgramRecord = Record<string, unknown>;
type ProgressProgramStat = readonly [unknown, unknown] | readonly [unknown, unknown, { text?: boolean; k?: boolean }];
type ProgressProgramState = import("../contracts/client-api.js").ClientProgramState;

function isProgressProgramRecord(value: unknown): value is ProgressProgramRecord {
  return !!value && typeof value === "object";
}

function progressProgramRecord(value: unknown): ProgressProgramRecord {
  return isProgressProgramRecord(value) ? value : {};
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

// The one-tap recovery-week draft: the conductor's recovery lead carries a real
// action — reshape next week as an earned deload for REVIEW (propose→apply; the
// instruction rides the same durable /program/evolve job as "Evolve my plan").
const RECOVERY_WEEK_INSTRUCTION =
  "Reshape next week into a RECOVERY (deload) week: cut working-set volume roughly in half, " +
  "keep every movement pattern, keep efforts easy and crisp (3-4 reps in reserve), no new " +
  "exercises and no load PRs — an earned reset after sustained loading, so the athlete comes back stronger.";

// "Evolve my plan" button - POSTs to /api/program/evolve through durable runOp.
// The draft lands in Plan proposals for review; nothing auto-applies. `opts`
// focuses the same flow (the recovery-week draft passes its instruction +
// its own anchor/copy); default is the open-ended evolution.
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
    render: () => {
      cleanup();
      deps.toast(opts.toast || "Drafted — review it in your Plan");
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
// immediately. Double-taps are guarded while the request is in flight.
async function applyCoachingFocusSwap(btn: Element, deps: ClientProgressProgramControllerDeps): Promise<void> {
  const el = btn instanceof HTMLElement ? btn : null;
  if (el?.dataset.busy === "1") return;
  if (el) el.dataset.busy = "1";
  const from = btn.getAttribute("data-swap-from") || "";
  const to = btn.getAttribute("data-swap-to") || "";
  const restore = deps.busy(btn, "Rotating it in…");
  let result: { ok?: boolean; error?: string } | null = null;
  try {
    result = (await deps.api("/program/swap/apply", {
      method: "POST",
      // Content-Type is MANDATORY here — api() does not auto-set it (a past bug).
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    })) as { ok?: boolean; error?: string } | null;
  } catch {
    result = null;
  }
  if (result?.ok) {
    deps.toast("Rotated in — your plan follows you");
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
      deps.empty(
        deps.art("exercise", "barbell squat"),
        "Not enough data yet — log a few sessions and your program intelligence will read here."
      );
    deps.wireSegments();
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
  const perfSlot = `<div id="progPerfSlot" class="pperf-slot reveal" style="${stagger(2)}"></div>`;
  const blockSlot = `<div id="progBlockSlot" class="pblock-slot reveal" style="${stagger(2)}"></div>`;
  const adjustSlot = `<div id="progAdjustSlot" class="padj-slot reveal" style="${stagger(3)}"></div>`;
  const muscleSlot = `<div id="progMuscleSlot" class="pmus-slot reveal" style="${stagger(3)}"></div>`;
  const dexaSlot = `<div id="progDexaSlot" class="pdexa-slot reveal" style="${stagger(3)}"></div>`;
  const adaptHtml = adaptations.length ? adaptationsHtml(adaptations, 4) : "";

  let liftsHtml = "";
  if (sorted.length) {
    liftsHtml += `<div class="prow-section-head lbl reveal" style="${stagger(5)}">Lifts</div>`;
    liftsHtml += sorted.map((lift, i) => liftRowHtml(lift, 6 + i)).join("");
  }

  const volumeHtml = volume.length
    ? `<div class="pvol-head lbl reveal" style="${stagger(2)}">Weekly volume by muscle</div>` +
      volumeBlockHtml(volume, 3)
    : "";
  const mesoHtml = meso ? mesoBlockHtml(meso, 4) : "";
  const endHtml = endurance ? enduranceBlockHtml(endurance, 5) : "";
  const hybridHtml = hybrid ? hybridLoadCardHtml(hybrid, 5) : "";

  const evolveFoot = `<div class="prog-evolve-foot reveal" style="${stagger(7)}">
    <button class="draftbtn prog-evolve-btn" id="progEvolveBtn" type="button">Evolve my plan</button>
    <span class="prog-evolve-note lbl">asks the coach to draft an updated plan — you review before anything changes</span>
    <button id="progTidyBtn" class="ghostbtn" style="width:100%;text-align:center;padding:9px;margin-top:11px" type="button">Tidy exercise names</button>
    <span class="prog-evolve-note lbl">Different logs name the same lift differently — Cairn merges duplicates so each one tracks as one line. Runs automatically as you log.</span>
  </div>`;

  let html = "";
  if (hasConductor) {
    html =
      head +
      deps.hero("Program", heroStats) +
      conductor +
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
        toast: "Recovery week drafted — review it in your Plan",
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
  deps.toast(n ? `Tidied ${n} exercise name${n === 1 ? "" : "s"}` : "Names already tidy");
  if (n) {
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
};

Object.assign(globalThis, { CairnProgressProgramController: CAIRN_PROGRESS_PROGRAM_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnProgressProgramController = CAIRN_PROGRESS_PROGRAM_CONTROLLER;
}

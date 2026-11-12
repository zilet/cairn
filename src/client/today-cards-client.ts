// @ts-check
// Exercise card renderers for the Today screen (lifts only; runs live in Endurance).

type TodayExerciseCardOptions = {
  day?: unknown;
  exModes?: Record<string, unknown> | null | undefined;
  // exercise name → its server-derived input profile (GET /exercises `input`).
  exInputs?: Record<string, unknown> | null | undefined;
};

type TodayCardInputProfile = "loaded" | "bodyweight" | "mobility";
type TodayCardInput = { profile: TodayCardInputProfile; per_side: boolean };

type TodayExerciseItem = Record<string, unknown>;
type TodayLoggedSet = Record<string, unknown>;
type TodayPrescription = Partial<ClientPrescription> | null | undefined;

function todayRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function todayString(value: unknown): string {
  return value == null ? "" : String(value);
}

function todayFinite(value: unknown): number | null {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function todayCardsExTimed(
  item: TodayExerciseItem,
  logged: unknown,
  exModes?: Record<string, unknown> | null
): boolean {
  if (item.mode === "timed" || item.target_seconds != null) return true;
  const exercise = todayString(item.exercise);
  if (exercise && exModes?.[exercise] === "timed") return true;
  return (Array.isArray(logged) ? logged : []).some((set) => todayRecord(set).duration_sec != null);
}

// What this card's log row asks for (server: src/repo/exercise-input.ts). The
// composition item's own `input` wins (read live with the composition), then the
// exercise list's; with neither, the card keeps the full loaded row it always had.
function todayCardsInput(item: TodayExerciseItem, options: TodayExerciseCardOptions): TodayCardInput {
  const pick = (value: unknown): TodayCardInput | null => {
    const record = todayRecord(value);
    const profile = record.profile;
    if (profile !== "loaded" && profile !== "bodyweight" && profile !== "mobility") return null;
    return { profile, per_side: record.per_side === true };
  };
  return (
    pick(item.input) ??
    pick(options.exInputs?.[todayString(item.exercise)]) ?? { profile: "loaded", per_side: false }
  );
}

// Reveal a card's tucked-away load well (the "+ Add load" affordance on a bodyweight
// or mobility row). Idempotent. A late prefill never fills a hidden well
// (today-add-exercise-controller fillInput), so nothing logs a load unseen.
function todayCardsRevealLoad(scope: Element | null | undefined, opts: { focus?: boolean } = {}): void {
  if (!scope) return;
  const card = scope.closest?.(".ex") ?? scope;
  const weight = card.querySelector<HTMLInputElement>(".logrow .in-w");
  if (weight) weight.hidden = false;
  card.querySelector<HTMLElement>('.logcaps [data-cap="w"]')?.removeAttribute("hidden");
  card.querySelector<HTMLElement>("[data-addload]")?.remove();
  if (opts.focus) weight?.focus();
}

/**
 * A card inserted from a (possibly empty) peek may render a bodyweight or mobility row with its
 * load well tucked away before /last-set says the last set carried a load: open the well first,
 * so the load is filled where the athlete can see it. A dirty or already-open well is left alone.
 */
function todayCardsRevealLoadForLastSet(scope: Element | null | undefined, lastSet: Record<string, unknown>): void {
  const well = scope?.querySelector<HTMLInputElement>(".in-w");
  if (!well?.hidden || well.dataset.dirty === "1") return;
  const load = Number(lastSet.weight);
  if (lastSet.weight == null || lastSet.weight === "" || !Number.isFinite(load) || load === 0) return;
  todayCardsRevealLoad(scope);
}

function todayCardsSetChip(set: unknown, index?: number): string {
  return CairnTodaySessionStatus.setChipHtml(set as Record<string, unknown>, index);
}

const TODAY_START_LIGHT_CUE = /\bstart\s+(?:light|easy|conservative)/i;
// Spaced dashes only, so a hyphenated movement ("Push-up") is never a clause break.
const TODAY_NOTE_CLAUSE_SPLIT = /\s+[—–-]\s+/;
const TODAY_SESSION_LEVEL_REASON =
  /you already lifted this|fueling can catch up|fueling catches up|the log is what moved this load|the work you logged earned this step|weekly split|days you actually train/i;
const TODAY_WEEKDAY = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

// A card keeps only a cue unique to that movement. The week's split, a fueling
// sentence that is true of the whole session, and the decision summary belong
// above the cards once — matching src/domain/training/exercise-notes.ts.
function todayCardsReasonIsItemSpecific(reason: string, summary: string): boolean {
  if (!reason) return false;
  if (summary && reason === summary) return false;
  if (reason.length > 220) return false;
  const days = reason.match(TODAY_WEEKDAY) ?? [];
  if (new Set(days.map((day) => day.toLowerCase())).size >= 2) return false;
  if (TODAY_SESSION_LEVEL_REASON.test(reason)) return false;
  return true;
}

function todayCardsItemCue(item: TodayExerciseItem, note: string): string {
  const reason = todayString(item.brain_change_reason).replace(/\s+/g, " ").trim();
  const summary = todayString(item.brain_change_summary).replace(/\s+/g, " ").trim();
  if (todayCardsReasonIsItemSpecific(reason, summary)) return reason;
  const cleaned = note.replace(/\s+/g, " ").trim();
  if (todayCardsReasonIsItemSpecific(cleaned, summary)) return cleaned;
  return "";
}

// A stored "start light, find your working weight" instruction was true the day it
// was written and is a contradiction once the card prints a real number. Drop it
// rather than print both; the rows themselves are repaired separately and render
// must never depend on that having happened. The cue usually hangs off a fact worth
// keeping ("Rotated in for Bench Press — start light, …"), so cut at the clause, not
// the sentence: only what carries the cue goes.
function todayCardsReach(item: TodayExerciseItem, rx: TodayPrescription): Record<string, unknown> | null {
  const own = todayRecord(item.reach);
  if (todayString(own.note).trim() || todayFinite(own.weight) != null || todayFinite(own.reps) != null || own.amrap === true) {
    return own;
  }
  const cardKey = todayString(item.cardKey);
  const exercise = todayString(item.exercise);
  const keyed = !!cardKey && cardKey !== exercise;
  // A split card (same name, own key) is not the weekly-plan lift. `rx.top_set`
  // describes the first card, never a sibling, so do not inherit it.
  if (keyed) return null;
  const top = todayRecord(todayRecord(rx).top_set);
  if (todayFinite(top.weight) != null || todayFinite(top.reps) != null || todayString(top.note).trim()) return top;
  return null;
}

function todayCardsReachLine(item: TodayExerciseItem, rx: TodayPrescription): string {
  const reach = todayCardsReach(item, rx);
  if (!reach) return "";
  // A top set folded into its own block's card is that lift's first set, not a
  // separate exercise — it reads as the card's top set.
  const label = (todayFinite(item.top_sets) ?? 0) > 0 ? "Top set" : "Reach";
  const note = todayString(reach.note).trim();
  const weight = todayFinite(reach.weight);
  const reps = todayFinite(reach.reps);
  const low = todayFinite(item.rep_low);
  const high = todayFinite(item.rep_high);
  let dose = "";
  if (weight != null && Number(item.sets) === 1 && low != null && high != null && low !== high) {
    dose = `${fmtWeight(weight)} × ${low}–${high}`;
  } else if (weight != null && reps != null) {
    dose = `${fmtWeight(weight)} × ${reps}`;
  } else if (weight != null) {
    dose = String(fmtWeight(weight));
  } else if (reps != null) {
    dose = `× ${reps}`;
  }
  return `<div class="ex-note">${escHtml(label)}${dose ? ` · ${escHtml(dose)}` : ""}${note ? ` — ${escHtml(note)}` : ""}</div>`;
}

function todayCardsCleanNote(note: unknown, hasDose: boolean): string {
  const text = todayString(note).trim();
  if (!text || !hasDose) return text;
  const kept: string[] = [];
  for (const sentence of text.match(/[^.;!?]+[.;!?]*/g) || [text]) {
    if (!TODAY_START_LIGHT_CUE.test(sentence)) {
      kept.push(sentence.trim());
      continue;
    }
    const lead = sentence
      .split(TODAY_NOTE_CLAUSE_SPLIT)
      .filter((clause) => clause.trim() && !TODAY_START_LIGHT_CUE.test(clause))
      .join(" — ")
      .trim();
    // A surviving lead lost its terminator with the clause that carried it.
    if (lead) kept.push(/[.;!?]$/.test(lead) ? lead : `${lead}.`);
  }
  return kept
    .join(" ")
    .replace(/^[\s,;·—–-]+/, "")
    .trim();
}

// "Pair · <partner>" for two, "Group · <n> exercises" for more. The names a card is
// paired with come from the session renderer, which only lists partners that are on
// screen — an empty list is a plain card. The aria-label says the same in a sentence,
// since nothing here may lean on a hover title.
function todayCardsPairChipHtml(partners: unknown): string {
  const names = Array.isArray(partners) ? partners.map(todayString).filter(Boolean) : [];
  if (!names.length) return "";
  const two = names.length === 1;
  const label = two ? `Pair · ${names[0]}` : `Group · ${names.length + 1} exercises`;
  const sentence = two
    ? `Paired with ${names[0]}: alternate sets.`
    : `In a group with ${names.join(", ")}: rotate sets.`;
  return `<span class="ex-pair-chip" aria-label="${escAttr(sentence)}">${escHtml(label)}</span>`;
}

function exerciseCardHtml(
  item: TodayExerciseItem,
  loggedSets: TodayLoggedSet[],
  prefill: Record<string, unknown>,
  revealIdx: unknown,
  rx: TodayPrescription,
  options: TodayExerciseCardOptions = {},
  lastSet?: unknown
): string {
  const exercise = todayString(item.exercise);
  // A durable one-day composition is prescribed for this session even when it is
  // intentionally NOT part of the weekly plan. Keep its sets/reps/load visible;
  // only truly ad-hoc cards retain the legacy "off-plan" treatment.
  const offPlan = !item.fromPlan && !item.fromSession;
  const timed = todayCardsExTimed(item, loggedSets, options.exModes);
  const input = todayCardsInput(item, options);
  const perSide = input.per_side ? " / side" : "";
  const range = offPlan ? "" : item.rep_low === item.rep_high ? `${item.rep_low}` : `${item.rep_low}–${item.rep_high}`;
  // A folded top set is on its own line; the header is the block's dose.
  const topSets = Math.max(0, todayFinite(item.top_sets) ?? 0);
  const blockSets = topSets && Number(item.sets) > topSets ? Number(item.sets) - topSets : item.sets;
  const targetText = timed
    ? `${item.sets ?? "?"} × ${item.target_seconds != null ? fmtDur(item.target_seconds) : "time"}${perSide}`
    : `${blockSets} × ${range}${perSide}`;
  // `reground` says the STORED target sits behind what the athlete is already
  // lifting (server: progression.ts `planBehind`), so that number is stale rather
  // than authoritative — printing it would lead the card with the one load nobody
  // uses. Step it aside and let the rx line carry the grounded number instead;
  // still exactly one dose, just the true one. Loaded work only: the server emits
  // `reground` on the reps branch alone.
  const regrounding = rx?.reground === true;
  // A loaded carry/hold carries its load in the header too ("2 × 0:40 @ 55"); an
  // unloaded hold is time alone.
  const showTargetLoad = timed
    ? item.target_weight != null && Number(item.target_weight) !== 0
    : item.target_weight != null && !regrounding;
  const target = offPlan
    ? `<span class="ex-sets ex-offplan">off-plan</span>`
    : `<span class="ex-sets">${targetText}${showTargetLoad ? ` @ <span class="ex-target numeral">${fmtWeight(item.target_weight)}</span>` : ""}</span>`;
  // `loggedSets` is what THIS card claimed, so `done` is this card's progress. On a
  // peak day the same lift renders twice under one name; `cardKey` is the identity
  // that separates them, and it is only present when there is something to
  // separate — one card per exercise keeps the name and the markup it always had.
  const cardKey = todayString(item.cardKey) || exercise;
  const keyed = cardKey !== exercise;
  const exKeyAttr = keyed ? ` data-exkey="${encodeURIComponent(cardKey)}"` : "";
  const done = loggedSets.length;
  // Skipping is name-keyed on the server — there is no per-card skip — so the
  // affordance goes away as soon as ANY set exists for the lift, not just this
  // card's. Otherwise the back-off card would still offer a skip the server can
  // only refuse.
  const exerciseLogged = todayFinite(item.exerciseLogged) ?? done;
  const goal = offPlan ? 0 : Number(item.sets) || 0;
  const complete = !!goal && done >= goal;
  // A superset partner (server-seated antagonist pair, or the plan's own grouping) names
  // who it is paired with beside the set count. The session renderer passes `pairPartners`
  // only when the partner is actually on the screen, so a lone member shows no chip.
  const pairChip = todayCardsPairChipHtml(item.pairPartners);
  const progress = `<span class="ex-prog${complete ? " done" : ""}" data-prog>${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span></span>`;
  const reveal = revealIdx != null ? Number(revealIdx) : null;
  // Timed rows take an optional load before the time (a carry, a weighted hold);
  // blank = unloaded. prefillFor already opens it at the plan's load, else the last logged one.
  const timedLoad = prefill.weight != null && Number(prefill.weight) !== 0 ? prefill.weight : "";
  // A bodyweight or mobility row does not ask for a load: the well stays in the row
  // (hidden, blank, so a set logs unloaded) behind a quiet "+ Add load". A real load
  // already in play — a prefilled last load, a planned load, an assist — opens it.
  const loadInPlay = (value: unknown) => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) !== 0;
  const showLoad =
    input.profile === "loaded" || loadInPlay(prefill.weight) || (!offPlan && loadInPlay(item.target_weight));
  // Reps in reserve is a strength read; a stretch or drill has none.
  const showRir = input.profile !== "mobility";
  const loadHidden = showLoad ? "" : " hidden";
  // A hidden well is always blank: a prefilled 0 there would log a 0 lb set instead of
  // an unloaded (null) one, and the athlete never saw it.
  const repsLoad = showLoad ? (prefill.weight ?? "") : "";
  // Only a tucked-away cap needs a handle for revealLoad; a loaded row keeps its markup.
  const loadCap = showLoad ? "" : ' data-cap="w" hidden';
  const inputAttr = ` data-input="${input.profile}"${input.per_side ? ' data-per-side="1"' : ""}`;
  const addLoad = showLoad
    ? ""
    : `<button type="button" class="ex-addload" data-addload aria-label="${escAttr(`Add a load to ${exercise}`)}">+ Add load</button>`;
  const logrow = timed
    ? `<div class="logcaps logcaps-timed" aria-hidden="true"><span${loadCap}>Weight</span><span>Time</span><i></i><i></i></div>
      <div class="logrow logrow-timed" data-ex="${encodeURIComponent(exercise)}"${exKeyAttr} data-day="${escAttr(options.day ?? "")}" data-mode="timed"${inputAttr}>
        <input type="number" inputmode="decimal" placeholder="WT" class="in-w" aria-label="${escAttr(`${exercise} weight (optional)`)}" value="${escAttr(timedLoad ?? "")}"${loadHidden}>
        <input type="text" inputmode="numeric" autocomplete="off" placeholder="TIME · 1:30" class="in-dur" aria-label="${escAttr(`${exercise} duration${perSide ? ", each side" : ""}`)}" value="${prefill.duration_sec != null ? fmtDur(prefill.duration_sec) : ""}">
        <button type="button" class="timerbtn" data-stopwatch-state="idle" aria-label="${escAttr(`Start ${exercise} stopwatch`)}" aria-pressed="false">Start</button>
        <button class="logbtn" aria-label="${escAttr(`Log a set of ${exercise}`)}">Log</button>
      </div>${addLoad}`
    : `<div class="logcaps" aria-hidden="true"><span${loadCap}>Weight</span><span>Reps</span>${showRir ? "<span>RIR</span>" : ""}<i></i></div>
      <div class="logrow" data-ex="${encodeURIComponent(exercise)}"${exKeyAttr} data-day="${escAttr(options.day ?? "")}"${inputAttr}>
        <input type="number" inputmode="decimal" placeholder="WT" class="in-w" aria-label="Weight" value="${escAttr(repsLoad)}"${loadHidden}>
        <input type="number" inputmode="numeric" placeholder="REPS" class="in-r" aria-label="${perSide ? "Reps, each side" : "Reps"}" value="${prefill.reps ?? ""}">
        ${showRir ? `<input type="number" inputmode="decimal" placeholder="RIR" class="in-rir" title="Reps in reserve — how many more you could have done" aria-label="RIR (reps in reserve)" value="${prefill.rir ?? ""}">` : ""}
        <button class="logbtn" aria-label="${escAttr(`Log a set of ${exercise}`)}">Log</button>
      </div>${addLoad}`;
  const skipButton =
    !offPlan && !exerciseLogged
      ? `<button class="ex-skip" data-skip="${encodeURIComponent(exercise)}" title="Not today" aria-label="Skip ${escAttr(exercise)} today">✕</button>`
      : "";
  const removeButton =
    offPlan && !done
      ? `<button class="ex-skip ex-remove" data-remove-card title="Remove" aria-label="Remove ${escAttr(exercise)}">✕</button>`
      : "";
  // The quiet "Last time: …" target line, only before anything's logged today for
  // this exercise — mirrors loadLastSets' own not-yet-logged scoping (today-plan-
  // session-data-client.ts). wireLastSetLine (today-session-set-model.ts) upgrades
  // it live to "That beats last time" once the athlete's typed set out-scores it.
  const lastSetLine = !done
    ? CairnTodayPlanSurface.lastSetLineHtml(lastSet, {
        escapeHtml: escHtml,
        lastSetLineText: (ls) =>
          CairnTodaySessionSetModel.lastSetLineText(ls, { fmtDur }, { perSide: input.per_side }),
      })
    : "";
  // There is deliberately NO per-card pain widget. An exercise card asks the athlete
  // to train, not to fill in a symptom form between sets; anything they want to say
  // about how it felt goes in the session note, and the extraction lane reads it.
  // ONE authoritative dose per card. When the header already carries today's load
  // (or timed dose) — the composition target, already eased for this session — the
  // standing progression verdict becomes explanation only. It follows the header
  // exactly, so a re-grounding verdict (no header load, see above) keeps its full
  // line and leads with the grounded number. Anything the server grounded (that
  // header, the rx suggestion, or a real last set) also retires a fossilized
  // "start light" note.
  const headlineDose = !offPlan && (timed ? item.target_seconds != null : showTargetLoad);
  const rxSuggested = todayRecord(todayRecord(rx).suggested);
  const lastSetRecord = todayRecord(lastSet);
  const groundedDose =
    headlineDose ||
    todayFinite(rxSuggested.weight) != null ||
    todayFinite(rxSuggested.seconds) != null ||
    todayFinite(lastSetRecord.weight) != null ||
    todayFinite(lastSetRecord.duration_sec) != null;
  const note = todayCardsCleanNote(item.note, groundedDose);
  const reachLine = todayCardsReachLine(item, rx);
  const reachNote = todayString(todayRecord(item.reach).note || todayRecord(todayRecord(rx).top_set).note).trim();
  const splitReachCard = item.fromSession === true && Number(item.sets) === 1 && keyed;
  const noteIsReach = !!(reachLine && note && ((reachNote && note === reachNote) || splitReachCard));
  const cue = todayCardsItemCue(item, note);
  // The heavier look and a standing "hold"/"deload"/"vary" verdict cannot share a
  // card: the athlete would be told to reach and to stay put in one breath. The top
  // set is today's instruction, so the standing verdict steps aside on that card.
  const rxAction = todayString(todayRecord(rx).action);
  const rxSilenced = !!reachLine && !!rx && rxAction !== "overload";
  // Decision-level narration and Undo live once above the cards. A card keeps
  // only a cue unique to this movement (swap, straps, start light).
  // Only the renderer's own two position tokens ever reach the class list.
  const pairTokens = todayString(item.pairClasses).split(/\s+/).filter((t) => t === "ex-group-head" || t === "ex-group-tail");
  const pairClass = pairChip ? ` ex-in-group${pairTokens.map((t) => ` ${t}`).join("")}` : "";
  const pairGroupAttr = pairChip && todayFinite(item.pairGroup) != null ? ` data-group="${escAttr(todayFinite(item.pairGroup))}"` : "";
  return `<div class="ex${complete ? " ex-complete" : ""}${pairClass}${reveal != null ? " reveal" : ""}" data-card="${escAttr(exercise)}"${pairGroupAttr}${exKeyAttr} data-mode="${timed ? "timed" : "reps"}"${inputAttr}${headlineDose ? ` data-dose="headline"` : ""}${rxSilenced ? ` data-rx="off"` : ""}${reveal != null ? ` style="${stagger(reveal)}"` : ""}>
      <div class="ex-top">
        <div class="ex-top-main">
          <button class="ex-name" data-guide="${encodeURIComponent(exercise)}">${escHtml(exercise)}&nbsp;<span class="guide-i">ⓘ</span></button>
          ${target}
        </div>
        ${skipButton}${removeButton}
      </div>
      <div class="ex-meta">${progress}${pairChip}</div>
      ${!noteIsReach && cue ? `<div class="ex-note">${escHtml(cue)}</div>` : ""}
      ${item.constraint_note ? `<div class="ex-flag">${escHtml(item.constraint_note)}</div>` : ""}
      ${item.journey_line ? `<div class="ex-journey" data-journey-role="${escAttr(item.journey_role || "support")}">${escHtml(item.journey_line)}</div>` : ""}
      ${!complete && !rxSilenced ? CairnTodayTraining.exRxLineHtml(rx, { supporting: headlineDose }) : ""}
      ${reachLine}
      <div class="logged" data-logged>${loggedSets.map(todayCardsSetChip).join("")}</div>
      ${lastSetLine}
      ${logrow}
    </div>`;
}

const CAIRN_TODAY_CARDS = {
  exTimed: todayCardsExTimed,
  exerciseCardHtml,
  pairChipHtml: todayCardsPairChipHtml,
  revealLoad: todayCardsRevealLoad,
  revealLoadForLastSet: todayCardsRevealLoadForLastSet,
};

Object.assign(globalThis, { CairnTodayCards: CAIRN_TODAY_CARDS });

// "+ Add load" on a bodyweight / mobility card opens the tucked-away load well. One
// delegated listener covers every card however it was rendered (the plan, a session
// composition, an off-plan add). The well was always in the row, blank, so a set
// logs unloaded; this only shows it, so a weighted stretch still logs as typed.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-addload]") : null;
    if (target) todayCardsRevealLoad(target, { focus: true });
  });
}

if (typeof window !== "undefined") {
  window.CairnTodayCards = CAIRN_TODAY_CARDS;
}

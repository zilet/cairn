// @ts-check
// Exercise and cardio card renderers for the Today screen.

type TodayExerciseCardOptions = {
  day?: unknown;
  exModes?: Record<string, unknown> | null | undefined;
};

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

function todayCardsSetChip(set: unknown, index?: number): string {
  return CairnTodaySessionStatus.setChipHtml(set as Record<string, unknown>, index);
}

const TODAY_START_LIGHT_CUE = /\bstart\s+(?:light|easy|conservative)/i;
// Spaced dashes only, so a hyphenated movement ("Push-up") is never a clause break.
const TODAY_NOTE_CLAUSE_SPLIT = /\s+[—–-]\s+/;

// A stored "start light, find your working weight" instruction was true the day it
// was written and is a contradiction once the card prints a real number. Drop it
// rather than print both; the rows themselves are repaired separately and render
// must never depend on that having happened. The cue usually hangs off a fact worth
// keeping ("Rotated in for Bench Press — start light, …"), so cut at the clause, not
// the sentence: only what carries the cue goes.
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
  const range = offPlan ? "" : item.rep_low === item.rep_high ? `${item.rep_low}` : `${item.rep_low}–${item.rep_high}`;
  const targetText = timed
    ? `${item.sets ?? "?"} × ${item.target_seconds != null ? fmtDur(item.target_seconds) : "time"}`
    : `${item.sets} × ${range}`;
  // `reground` says the STORED target sits behind what the athlete is already
  // lifting (server: progression.ts `planBehind`), so that number is stale rather
  // than authoritative — printing it would lead the card with the one load nobody
  // uses. Step it aside and let the rx line carry the grounded number instead;
  // still exactly one dose, just the true one. Loaded work only: the server emits
  // `reground` on the reps branch alone.
  const regrounding = rx?.reground === true;
  const showTargetLoad = !timed && item.target_weight != null && !regrounding;
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
  const progress = `<span class="ex-prog${complete ? " done" : ""}" data-prog>${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span></span>`;
  const tile = artImg("exercise", exercise, "artile-sm ex-art", art("exercise", exercise, item.muscle_group));
  const reveal = revealIdx != null ? Number(revealIdx) : null;
  const logrow = timed
    ? `<div class="logrow" data-ex="${encodeURIComponent(exercise)}"${exKeyAttr} data-day="${escAttr(options.day ?? "")}" data-mode="timed">
        <input type="text" inputmode="numeric" autocomplete="off" placeholder="TIME · 1:30" class="in-dur" aria-label="${escAttr(`${exercise} duration`)}" value="${prefill.duration_sec != null ? fmtDur(prefill.duration_sec) : ""}">
        <button type="button" class="timerbtn" data-stopwatch-state="idle" aria-label="${escAttr(`Start ${exercise} stopwatch`)}" aria-pressed="false">Start</button>
        <button class="logbtn">+</button>
      </div>`
    : `<div class="logrow" data-ex="${encodeURIComponent(exercise)}"${exKeyAttr} data-day="${escAttr(options.day ?? "")}">
        <input type="number" inputmode="decimal" placeholder="WT" class="in-w" aria-label="Weight" value="${prefill.weight ?? ""}">
        <input type="number" inputmode="numeric" placeholder="REPS" class="in-r" aria-label="Reps" value="${prefill.reps ?? ""}">
        <input type="number" inputmode="decimal" placeholder="RIR" class="in-rir" title="Reps in reserve — how many more you could have done" aria-label="RIR (reps in reserve)" value="${prefill.rir ?? ""}">
        <button class="logbtn">+</button>
      </div>`;
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
        lastSetLineText: (ls) => CairnTodaySessionSetModel.lastSetLineText(ls, { fmtDur }),
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
  // A changed card carries only its OWN reason. `brain_change_summary` narrates the
  // whole decision and is copied onto every changed exercise, so repeating it here
  // printed the same paragraph once per card; the plan surface says it once above them.
  return `<div class="ex${complete ? " ex-complete" : ""}${reveal != null ? " reveal" : ""}" data-card="${escAttr(exercise)}"${exKeyAttr} data-mode="${timed ? "timed" : "reps"}"${headlineDose ? ` data-dose="headline"` : ""}${reveal != null ? ` style="${stagger(reveal)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <button class="ex-name" data-guide="${encodeURIComponent(exercise)}">${escHtml(exercise)} <span class="guide-i">ⓘ</span></button>
        ${target}
        ${skipButton}${removeButton}
      </div>
      <div class="ex-meta">${progress}</div>
      ${item.brain_decision_id ? `<div class="ex-flag">${escHtml(item.brain_change_reason || note || "Your team adjusted this exercise.")}${item.brain_change_reversible ? ` <button class="linkbtn-quiet" type="button" data-decision-undo="${escAttr(item.brain_decision_id)}">Undo</button>` : ""}</div>` : note ? `<div class="ex-note">${escHtml(note)}</div>` : ""}
      ${item.constraint_note ? `<div class="ex-flag">${escHtml(item.constraint_note)}</div>` : ""}
      ${item.journey_line ? `<div class="ex-journey" data-journey-role="${escAttr(item.journey_role || "support")}">${escHtml(item.journey_line)}</div>` : ""}
      ${!complete ? CairnTodayTraining.exRxLineHtml(rx, { supporting: headlineDose }) : ""}
      <div class="logged" data-logged>${loggedSets.map(todayCardsSetChip).join("")}</div>
      ${lastSetLine}
      ${logrow}
    </div>`;
}

function cardioDoneCardHtml(item: TodayExerciseItem, effort: Record<string, unknown>, revealIdx: unknown): string {
  const label = cardioLabel(item);
  const tile = artImg(
    "activity",
    cardioArtPhrase(item),
    "artile-sm ex-art",
    art("activity", effort.type || cardioArtPhrase(item))
  );
  const dist = todayFinite(effort.distance_km);
  const duration = todayFinite(effort.duration_min);
  const headBits: string[] = [];
  if (dist != null && dist > 0) headBits.push(`${fmtKm(dist)} km`);
  else if (duration != null && duration > 0) headBits.push(`${Math.round(duration)} min`);
  const headline = `${label}${headBits.length ? ` — ${headBits.join(" · ")}` : ""}`;
  const chips: string[] = [];
  const zoneWord = CairnTodayTraining.cardioDominantZone(effort.zones);
  if (zoneWord) chips.push(zoneWord);
  if (effort.pace) chips.push(`${String(effort.pace)}/km`);
  const avgHr = todayFinite(effort.avg_hr);
  if (avgHr != null) chips.push(`${Math.round(avgHr)} avg hr`);
  if (duration != null && duration > 0 && headBits[0] && !headBits[0].includes("min"))
    chips.push(`${Math.round(duration)} min`);
  const reveal = revealIdx != null ? Number(revealIdx) : null;
  const chipHtml = chips.map((chip) => `<span class="done-chip">${escHtml(chip)}</span>`).join("");
  return `<div class="ex ex-cardio ex-cardio-done${reveal != null ? " reveal" : ""}" data-cardio-card${reveal != null ? ` style="${stagger(reveal)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <span class="ex-name ex-name-static cardio-done-head">
          <span class="cardio-done-mark" aria-hidden="true">✓</span>${escHtml(headline)}
        </span>
        ${effort.source === "garmin" ? `<span class="garmin-tag">✦ synced from Garmin</span>` : ""}
      </div>
      ${chipHtml ? `<div class="cardio-done-chips">${chipHtml}</div>` : ""}
    </div>`;
}

function cardioPlanCardHtml(
  item: TodayExerciseItem,
  revealIdx: unknown,
  done: Record<string, unknown> | null | undefined,
  syncLine: string
): string {
  if (done) return cardioDoneCardHtml(item, done, revealIdx);
  const label = cardioLabel(item);
  const tile = artImg("activity", cardioArtPhrase(item), "artile-sm ex-art", art("activity", cardioArtPhrase(item)));
  const prescription = cardioPrescription(item);
  const description = cardioDescription(item);
  const verb = CairnTodayTraining.cardioVerb(label);
  const reveal = revealIdx != null ? Number(revealIdx) : null;
  const logPhrase = CairnTodayTraining.cardioLogPhrase({ ...item, label });
  return `<div class="ex ex-cardio${reveal != null ? " reveal" : ""}" data-cardio-card${reveal != null ? ` style="${stagger(reveal)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <span class="ex-name ex-name-static"><span class="cardio-name-txt">${escHtml(label)}</span> <span class="cardio-tag lbl">cardio</span></span>
        ${prescription ? `<span class="ex-sets ex-cardio-pres">${escHtml(prescription)}</span>` : ""}
        <button class="ex-skip" data-skip="${encodeURIComponent(label)}" title="Not today" aria-label="Skip ${escAttr(label)} today">✕</button>
      </div>
      ${description ? `<div class="ex-note">${escHtml(description)}</div>` : ""}
      <div class="cardio-logrow">
        <button class="ghostbtn cardio-log-btn" data-cardio-log="${escAttr(logPhrase)}">Review &amp; log this ${escHtml(verb)} →</button>
      </div>
      ${syncLine || ""}
    </div>`;
}

function todayCardsCardioEffortMatches(
  item: TodayExerciseItem,
  effort: Record<string, unknown> | null | undefined
): boolean {
  if (!effort) return false;
  const want = CairnTodayTraining.cardioVerb(item.exercise || item.note || cardioLabel(item));
  const got = CairnTodayTraining.cardioVerb(effort.type || effort.name || "");
  if (want === "effort" || got === "effort") return true;
  return want === got;
}

const CAIRN_TODAY_CARDS = {
  exTimed: todayCardsExTimed,
  exerciseCardHtml,
  cardioPlanCardHtml,
  cardioDoneCardHtml,
  cardioEffortMatches: todayCardsCardioEffortMatches,
};

Object.assign(globalThis, { CairnTodayCards: CAIRN_TODAY_CARDS });

if (typeof window !== "undefined") {
  window.CairnTodayCards = CAIRN_TODAY_CARDS;
}

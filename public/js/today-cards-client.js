(() => {
// @ts-check
// Exercise and cardio card renderers for the Today screen.
function todayRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function todayString(value) {
    return value == null ? "" : String(value);
}
function todayFinite(value) {
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}
function todayCardsExTimed(item, logged, exModes) {
    if (item.mode === "timed" || item.target_seconds != null)
        return true;
    const exercise = todayString(item.exercise);
    if (exercise && exModes?.[exercise] === "timed")
        return true;
    return (Array.isArray(logged) ? logged : []).some((set) => todayRecord(set).duration_sec != null);
}
function todayCardsSetChip(set, index) {
    return CairnTodaySessionStatus.setChipHtml(set, index);
}
function exerciseCardHtml(item, loggedSets, prefill, revealIdx, rx, options = {}) {
    const exercise = todayString(item.exercise);
    const offPlan = !item.fromPlan;
    const timed = todayCardsExTimed(item, loggedSets, options.exModes);
    const range = offPlan ? "" : (item.rep_low === item.rep_high ? `${item.rep_low}` : `${item.rep_low}–${item.rep_high}`);
    const targetText = timed
        ? `${item.sets ?? "?"} × ${item.target_seconds != null ? fmtDur(item.target_seconds) : "time"}`
        : `${item.sets} × ${range}`;
    const target = offPlan
        ? `<span class="ex-sets ex-offplan">off-plan</span>`
        : `<span class="ex-sets">${targetText}${!timed && item.target_weight != null ? ` @ <span class="ex-target numeral">${fmtWeight(item.target_weight)}</span>` : ""}</span>`;
    const done = loggedSets.length;
    const goal = offPlan ? 0 : (Number(item.sets) || 0);
    const complete = !!goal && done >= goal;
    const progress = `<span class="ex-prog${complete ? " done" : ""}" data-prog>${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span></span>`;
    const tile = artImg("exercise", exercise, "artile-sm ex-art", art("exercise", exercise, item.muscle_group));
    const reveal = revealIdx != null ? Number(revealIdx) : null;
    const logrow = timed
        ? `<div class="logrow" data-ex="${encodeURIComponent(exercise)}" data-day="${escAttr(options.day ?? "")}" data-mode="timed">
        <input type="text" inputmode="numeric" autocomplete="off" placeholder="TIME · 1:30" class="in-dur" value="${prefill.duration_sec != null ? fmtDur(prefill.duration_sec) : ""}">
        <button class="logbtn">+</button>
      </div>`
        : `<div class="logrow" data-ex="${encodeURIComponent(exercise)}" data-day="${escAttr(options.day ?? "")}">
        <input type="number" inputmode="decimal" placeholder="WT" class="in-w" aria-label="Weight" value="${prefill.weight ?? ""}">
        <input type="number" inputmode="numeric" placeholder="REPS" class="in-r" aria-label="Reps" value="${prefill.reps ?? ""}">
        <input type="number" inputmode="decimal" placeholder="RIR" title="Reps in reserve — how many more you could have done" aria-label="RIR (reps in reserve)" value="${prefill.rir ?? ""}">
        <button class="logbtn">+</button>
      </div>`;
    const skipButton = (!offPlan && !done)
        ? `<button class="ex-skip" data-skip="${encodeURIComponent(exercise)}" title="Not today" aria-label="Skip ${escAttr(exercise)} today">✕</button>`
        : "";
    const removeButton = (offPlan && !done)
        ? `<button class="ex-skip ex-remove" data-remove-card title="Remove" aria-label="Remove ${escAttr(exercise)}">✕</button>`
        : "";
    return `<div class="ex${complete ? " ex-complete" : ""}${reveal != null ? " reveal" : ""}" data-card="${escAttr(exercise)}" data-mode="${timed ? "timed" : "reps"}"${reveal != null ? ` style="${stagger(reveal)}"` : ""}>
      <div class="ex-top">
        ${tile}
        <button class="ex-name" data-guide="${encodeURIComponent(exercise)}">${escHtml(exercise)} <span class="guide-i">ⓘ</span></button>
        ${target}
        ${skipButton}${removeButton}
      </div>
      <div class="ex-meta">${progress}</div>
      ${item.note ? `<div class="ex-note">${escHtml(item.note)}</div>` : ""}
      ${item.constraint_note ? `<div class="ex-flag">${escHtml(item.constraint_note)}</div>` : ""}
      ${!complete ? CairnTodayTraining.exRxLineHtml(rx) : ""}
      <div class="logged" data-logged>${loggedSets.map(todayCardsSetChip).join("")}</div>
      ${logrow}
    </div>`;
}
function cardioDoneCardHtml(item, effort, revealIdx) {
    const label = cardioLabel(item);
    const tile = artImg("activity", cardioArtPhrase(item), "artile-sm ex-art", art("activity", effort.type || cardioArtPhrase(item)));
    const dist = todayFinite(effort.distance_km);
    const duration = todayFinite(effort.duration_min);
    const headBits = [];
    if (dist != null && dist > 0)
        headBits.push(`${fmtKm(dist)} km`);
    else if (duration != null && duration > 0)
        headBits.push(`${Math.round(duration)} min`);
    const headline = `${label}${headBits.length ? ` — ${headBits.join(" · ")}` : ""}`;
    const chips = [];
    const zoneWord = CairnTodayTraining.cardioDominantZone(effort.zones);
    if (zoneWord)
        chips.push(zoneWord);
    if (effort.pace)
        chips.push(`${String(effort.pace)}/km`);
    const avgHr = todayFinite(effort.avg_hr);
    if (avgHr != null)
        chips.push(`${Math.round(avgHr)} avg hr`);
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
function cardioPlanCardHtml(item, revealIdx, done, syncLine) {
    if (done)
        return cardioDoneCardHtml(item, done, revealIdx);
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
        <button class="ghostbtn cardio-log-btn" data-cardio-log="${escAttr(logPhrase)}">Log this ${escHtml(verb)} →</button>
      </div>
      ${syncLine || ""}
    </div>`;
}
function todayCardsCardioEffortMatches(item, effort) {
    if (!effort)
        return false;
    const want = CairnTodayTraining.cardioVerb(item.note || cardioLabel(item));
    const got = CairnTodayTraining.cardioVerb(effort.type || effort.name || "");
    if (want === "effort" || got === "effort")
        return true;
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
})();

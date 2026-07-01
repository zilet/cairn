(() => {
// @ts-check
// Plan editor render/model helpers.
(() => {
    function blankStrength() {
        return { kind: "strength", exercise: "", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, note: "", warmup_sets: null, target_distance_km: null, target_duration_min: null, target_zone: null, interval_note: "" };
    }
    function blankCardio() {
        return { kind: "cardio", exercise: "", sets: 1, rep_low: null, rep_high: null, target_weight: null, note: "", warmup_sets: null, target_distance_km: null, target_duration_min: null, target_zone: null, interval_note: "" };
    }
    function dayModelFromPlan(day) {
        return {
            day_number: day.day_number,
            name: day.name,
            focus: day.focus || "",
            items: (Array.isArray(day.items) ? day.items : []).map((item) => ({
                kind: isCardioItem(item) ? "cardio" : "strength",
                exercise: item.exercise,
                sets: item.sets,
                rep_low: item.rep_low,
                rep_high: item.rep_high,
                target_weight: item.target_weight,
                note: item.note ?? "",
                warmup_sets: item.warmup_sets ?? null,
                muscle_group: item.muscle_group ?? null,
                target_seconds: item.target_seconds ?? null,
                mode: item.mode ?? null,
                target_distance_km: item.target_distance_km ?? null,
                target_duration_min: item.target_duration_min ?? null,
                target_zone: item.target_zone ?? null,
                interval_note: cardioIntervalNote(item.interval),
            })),
        };
    }
    function calendarFooterHtml(plan, host, icsUrl) {
        return Array.isArray(plan) && plan.length
            ? `<div id="planCal" style="margin-top:16px;text-align:center;font-size:.82rem;color:var(--muted)">
         <a href="webcal://${escAttr(host)}${escAttr(icsUrl)}" style="color:var(--muted);text-decoration:none">📅 Subscribe to this plan in your calendar</a>
         <a href="${escAttr(icsUrl)}" target="_blank" rel="noopener" style="color:var(--muted);opacity:.7;margin-left:8px">(.ics)</a>
       </div>`
            : "";
    }
    function progDayHtml(day, dayIndex) {
        const items = Array.isArray(day.items) ? day.items : [];
        const strip = items.map((item) => {
            if (isCardioItem(item)) {
                const tile = artImg("activity", cardioArtPhrase(item), "artile-md strip-tile", art("activity", cardioArtPhrase(item)));
                return tile ? `<div>${tile}</div>` : "";
            }
            const exercise = String(item.exercise || "");
            const tile = artImg("exercise", exercise, "artile-md strip-tile", art("exercise", exercise, item.muscle_group));
            return tile ? `<div data-guide="${encodeURIComponent(exercise)}" style="cursor:pointer">${tile}</div>` : "";
        }).join("");
        const rows = items.map((item) => {
            if (isCardioItem(item)) {
                const tile = artImg("activity", cardioArtPhrase(item), "artile-sm", art("activity", cardioArtPhrase(item)));
                const prescription = cardioPrescription(item);
                const description = cardioDescription(item);
                return `<div class="prog-row prog-row-cardio">
            ${tile}
            <div class="prog-row-main">
              <span class="prog-row-name prog-row-name-static">${escHtml(cardioLabel(item))}</span>
              <div class="prog-row-hint"><span class="cardio-tag lbl">cardio</span>${description ? ` ${escHtml(description)}` : ""}</div>
            </div>
            <div class="prog-row-nums"><span class="numeral prog-row-cardio-pres">${escHtml(prescription || "—")}</span></div>
          </div>`;
            }
            const exercise = String(item.exercise || "");
            const tile = artImg("exercise", exercise, "artile-sm", art("exercise", exercise, item.muscle_group));
            const timed = item.mode === "timed" || item.target_seconds != null;
            const range = timed
                ? (item.target_seconds != null ? fmtDur(item.target_seconds) : "time")
                : (item.rep_low === item.rep_high ? `${item.rep_low ?? ""}` : `${item.rep_low ?? "?"}–${item.rep_high ?? "?"}`);
            const hints = [
                item.warmup_sets ? `${item.warmup_sets} warmup` : null,
                item.note ? escHtml(item.note) : null,
            ].filter(Boolean).join(" · ");
            return `<div class="prog-row">
          ${tile}
          <div class="prog-row-main">
            <button class="prog-row-name" data-guide="${encodeURIComponent(exercise)}">${escHtml(exercise)}</button>
            ${hints ? `<div class="prog-row-hint">${hints}</div>` : ""}
          </div>
          <div class="prog-row-nums">
            <span class="numeral">${item.sets ?? "?"} × ${range}</span>
            ${!timed && item.target_weight != null ? `<span class="numeral prog-row-wt">${fmtWeight(item.target_weight)}</span>` : ""}
          </div>
        </div>`;
        }).join("");
        return `<div class="prog-day reveal" style="${stagger(dayIndex)}" data-pd="${dayIndex}">
        <div class="prog-head">
          <div class="prog-head-main">
            <div class="lbl">Day ${escHtml(day.day_number)}</div>
            <div class="prog-name">${escHtml(day.name || `Day ${day.day_number}`)}</div>
            ${day.focus ? `<div class="prog-focus">${escHtml(day.focus)}</div>` : ""}
          </div>
          <button class="ghostbtn prog-edit" data-editday="${dayIndex}">Edit day</button>
        </div>
        ${strip ? `<div class="prog-strip">${strip}</div>` : ""}
        <div class="prog-list">${rows || `<div class="empty">No exercises yet — tap Edit day.</div>`}</div>
      </div>`;
    }
    function pitemHtml(item, dayIndex, itemIndex, lastIndex) {
        const cardio = isCardioItem(item);
        const ord = `<div class="pi-ord">
        <button class="ordbtn" data-upitem="${dayIndex}:${itemIndex}" ${itemIndex === 0 ? "disabled" : ""}>↑</button>
        <button class="ordbtn" data-downitem="${dayIndex}:${itemIndex}" ${itemIndex === lastIndex ? "disabled" : ""}>↓</button>
      </div>`;
        const kindToggle = `<div class="pi-kind" role="group" aria-label="Item type">
        <button type="button" class="pi-kindbtn${cardio ? "" : " active"}" data-pikind="${dayIndex}:${itemIndex}:strength">Lift</button>
        <button type="button" class="pi-kindbtn${cardio ? " active" : ""}" data-pikind="${dayIndex}:${itemIndex}:cardio">Cardio</button>
      </div>`;
        if (cardio) {
            return `<div class="pitem pitem-cardio" data-d="${dayIndex}" data-i="${itemIndex}" data-kind="cardio">
          <div class="pi-row1">
            <input class="pi-ex" value="${escAttr(item.note || "")}" placeholder="e.g. Long run, Tempo, Easy ride">
            ${ord}
          </div>
          ${kindToggle}
          <div class="pi-nums pi-nums-cardio">
            <input class="pi-km" type="number" inputmode="decimal" step="0.1" value="${item.target_distance_km ?? ""}" placeholder="km">
            <input class="pi-min" type="number" inputmode="numeric" value="${item.target_duration_min ?? ""}" placeholder="min">
            <input class="pi-zone" type="text" value="${escAttr(item.target_zone || "")}" placeholder="zone (Z2)">
            <button class="delbtn" data-delitem="${dayIndex}:${itemIndex}">✕</button>
          </div>
          <input class="pi-ivl" value="${escAttr(item.interval_note || "")}" placeholder="Interval note (optional, e.g. 6×400m @ Z4)">
        </div>`;
        }
        return `<div class="pitem" data-d="${dayIndex}" data-i="${itemIndex}" data-kind="strength">
        <div class="pi-row1">
          <input class="pi-ex" value="${escAttr(item.exercise)}" placeholder="Exercise">
          ${ord}
        </div>
        ${kindToggle}
        <div class="pi-nums">
          <input class="pi-sets" type="number" inputmode="numeric" value="${item.sets ?? ""}" placeholder="sets">
          <input class="pi-lo" type="number" inputmode="numeric" value="${item.rep_low ?? ""}" placeholder="lo">
          <input class="pi-hi" type="number" inputmode="numeric" value="${item.rep_high ?? ""}" placeholder="hi">
          <input class="pi-tw" type="number" inputmode="decimal" value="${item.target_weight ?? ""}" placeholder="wt">
          <input class="pi-wu" type="number" inputmode="numeric" value="${item.warmup_sets ?? ""}" placeholder="WU">
          <button class="delbtn" data-delitem="${dayIndex}:${itemIndex}">✕</button>
        </div>
        <input class="pi-note" value="${escAttr(item.note || "")}" placeholder="Note (optional)">
      </div>`;
    }
    function pdayHtml(day, dayIndex) {
        const items = Array.isArray(day.items) ? day.items : [];
        return `<div class="pday" data-d="${dayIndex}">
        <div class="pday-head">
          <input class="pday-name" value="${escAttr(day.name)}" placeholder="Day name">
          <button class="ghostbtn pday-done" data-doneday="${dayIndex}">Done</button>
          <button class="delbtn" data-delday="${dayIndex}">✕</button>
        </div>
        <input class="pday-focus" value="${escAttr(day.focus)}" placeholder="Focus (optional)">
        ${items.map((item, itemIndex) => pitemHtml(item, dayIndex, itemIndex, items.length - 1)).join("")}
        <div class="pday-add">
          <button class="ghostbtn" data-additem="${dayIndex}">+ exercise</button>
          <button class="ghostbtn" data-addcardio="${dayIndex}">+ cardio</button>
        </div>
      </div>`;
    }
    const CAIRN_PLAN_EDITOR = {
        blankStrength,
        blankCardio,
        dayModelFromPlan,
        calendarFooterHtml,
        progDayHtml,
        pitemHtml,
        pdayHtml,
    };
    Object.assign(globalThis, { CairnPlanEditor: CAIRN_PLAN_EDITOR });
    if (typeof window !== "undefined") {
        window.CairnPlanEditor = CAIRN_PLAN_EDITOR;
    }
})();
})();

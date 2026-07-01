// @ts-check
// Progress History card and edit-sheet render helpers.

function progressHistorySetFigure(set: ProgressHistorySet): string {
  return set.duration_sec != null ? fmtDur(set.duration_sec) : `${fmtWeight(set.weight)}×${set.reps}`;
}

function progressHistorySessionCardHtml(session: unknown, index: number): string {
  const model = CairnProgressHistoryModel.sessionCardModel(session);
  const { row, weekday, tonnage, setCount } = model;
  const lines = model.groups.map(({ exercise, sets, bestIndex }) => {
    const figures = sets.map((set, setIndex) => {
      const figure = progressHistorySetFigure(set);
      return `<span class="hist-set${setIndex === bestIndex && sets.length > 1 ? " hist-best" : ""}">${escHtml(figure)}</span>`;
    }).join(`<span class="hist-sep">·</span>`);
    return `<div class="hist-line"><span class="hist-ex">${escHtml(exercise)}</span><span class="hist-sets">${figures}</span></div>`;
  }).join("");
  const chips = [
    tonnage ? `${fmtK(Math.round(tonnage))} lb` : null,
    row.duration_min ? `${row.duration_min} min` : null,
    `${setCount} set${setCount === 1 ? "" : "s"}`,
  ].filter(Boolean).map((text) => `<span class="hist-chip">${escHtml(text)}</span>`).join("");
  return `<div class="sess hist hist-tap reveal" data-sessid="${escAttr(row.id)}" role="button" tabindex="0" style="${stagger(index)}" aria-label="Edit ${escAttr(weekday)} session">
      <div class="hist-head">
        <div>
          <div class="hist-kicker lbl">${escHtml(fmtShortDate(row.date))}${(row.title || row.day_name) ? ` · ${escHtml(row.title || row.day_name)}` : ""}</div>
          <div class="hist-day">${escHtml(weekday)}<span class="hist-edit" aria-hidden="true">edit</span></div>
        </div>
        <div class="hist-chips">${chips}</div>
      </div>
      ${lines || `<div class="hist-line"><span class="hist-ex" style="color:var(--muted)">No sets</span></div>`}
      ${row.notes ? `<div class="hist-notes">“${escHtml(row.notes)}”</div>` : ""}
    </div>`;
}

function progressHistoryEditSetHtml(set: ProgressHistorySet): string {
  const timed = set.duration_sec != null || set.mode === "timed";
  const fields = timed
    ? `<input class="edset-dur" inputmode="numeric" value="${set.duration_sec != null ? fmtDur(set.duration_sec) : ""}" placeholder="1:30" aria-label="duration">`
    : `<input class="edset-w" type="number" inputmode="decimal" value="${set.weight ?? ""}" placeholder="wt" aria-label="weight">
       <input class="edset-r" type="number" inputmode="numeric" value="${set.reps ?? ""}" placeholder="reps" aria-label="reps">
       <input class="edset-rir" type="number" inputmode="numeric" value="${set.rir ?? ""}" placeholder="rir" aria-label="rir">`;
  return `<div class="edset" data-setid="${set.id}" data-kind="${timed ? "timed" : "reps"}">
      ${fields}
      <button class="edset-del" data-eddel="${set.id}" title="Delete set" aria-label="Delete set">×</button>
    </div>`;
}

function progressHistoryEditGroupHtml(group: ProgressHistoryEditGroup): string {
  const setRows = group.sets.map((set) => progressHistoryEditSetHtml(set)).join("");
  return `<div class="ed-exgroup"><div class="ed-exname">${escHtml(group.exercise)}</div>${setRows}</div>`;
}

function progressHistorySessionEditHtml(session: HistorySession): string {
  const groups = CairnProgressHistoryModel.editGroups(session).map(progressHistoryEditGroupHtml).join("");
  return `
      <h2 class="detail-title">${escHtml(session.title || session.day_name || "Session")}</h2>
      <div class="detail-ctx lbl">${escHtml(fmtShortDate(session.date))} · edit logged sets</div>
      <div class="ed-sets">${groups || `<div class="detail-body" style="color:var(--muted)">No sets logged.</div>`}</div>
      <div class="detail-section"><div class="lbl">Session notes</div>
        <textarea id="edNotes" class="ed-notes" rows="2" placeholder="How did it go?">${escHtml(session.notes || "")}</textarea></div>
      <div class="detail-actions">
        <button class="pillbtn pill-accent" id="edSave">Save changes</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`;
}

const CAIRN_PROGRESS_HISTORY_RENDER = {
  setFigure: progressHistorySetFigure,
  sessionCardHtml: progressHistorySessionCardHtml,
  editSetHtml: progressHistoryEditSetHtml,
  editGroupHtml: progressHistoryEditGroupHtml,
  sessionEditHtml: progressHistorySessionEditHtml,
};

Object.assign(globalThis, {
  CairnProgressHistoryRender: CAIRN_PROGRESS_HISTORY_RENDER,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressHistoryRender: CAIRN_PROGRESS_HISTORY_RENDER,
  });
}

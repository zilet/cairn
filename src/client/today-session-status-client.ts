// @ts-check
// Pure Today session status rendering helpers for the vanilla PWA.

type ClientLoggedSet = import("../contracts/client-api.js").ClientLoggedSet;
type ClientPlanDay = import("../contracts/client-api.js").ClientPlanDay;
type ClientTrainingSession = import("../contracts/client-api.js").ClientTrainingSession;

type LoggedSetLike = Partial<ClientLoggedSet> | null | undefined;
type SessionLike = Partial<ClientTrainingSession> | null | undefined;
type DayLike = Partial<ClientPlanDay> | null | undefined;
type FeelKind = "soreness" | "performance";
type DoneExerciseSummary = {
  name: string;
  sets: number;
  tonnage: number;
  timedSec: number;
  bestLoad: number;
  bestLoadLabel: string;
  bestDuration: number;
};

(() => {
  const TODAY_FEEL_FACES = ["·", "◦", "○", "◍", "●"] as const;

  function todaySetChipHtml(set: LoggedSetLike, index?: number): string {
    const row = set && typeof set === "object" ? set : {};
    const number = row.set_number ?? (index != null ? index + 1 : null);
    const id = row.id != null ? String(row.id) : "";
    const figure = row.duration_sec != null
      ? fmtDur(row.duration_sec)
      : `${fmtWeight(row.weight)} <span>×</span> ${escHtml(row.reps ?? "")}${row.rir != null ? ` <span>@${escHtml(row.rir)}</span>` : ""}`;
    return `<span class="chip" data-set="${escAttr(id)}">${number != null ? `<span class="chip-n">#${escHtml(number)}</span> ` : ""}${figure}<button class="xbtn chip-x" data-del="${escAttr(id)}" title="delete">×</button></span>`;
  }

  // Tonnage = sum weight×reps over loaded sets. Timed, bodyweight, and assisted
  // sets stay out of the load total, matching the historical Today/History rule.
  function todaySetsTonnage(sets: unknown): number {
    return (Array.isArray(sets) ? sets : []).reduce((total, row) => {
      const set = row && typeof row === "object" ? row as Partial<ClientLoggedSet> : {};
      const weight = Number(set.weight);
      const reps = Number(set.reps);
      return total + (weight > 0 && reps ? weight * reps : 0);
    }, 0);
  }

  function doneExerciseSummaries(sets: LoggedSetLike[]): DoneExerciseSummary[] {
    const byName = new Map<string, DoneExerciseSummary>();
    for (const raw of sets) {
      const set = raw && typeof raw === "object" ? raw : {};
      const name = String(set.exercise || "Work").trim() || "Work";
      let row = byName.get(name);
      if (!row) {
        row = { name, sets: 0, tonnage: 0, timedSec: 0, bestLoad: 0, bestLoadLabel: "", bestDuration: 0 };
        byName.set(name, row);
      }
      row.sets++;
      const weight = Number(set.weight);
      const reps = Number(set.reps);
      if (weight > 0 && reps > 0) {
        const load = weight * reps;
        row.tonnage += load;
        if (load > row.bestLoad) {
          row.bestLoad = load;
          row.bestLoadLabel = `${fmtWeight(weight)} x ${reps}`;
        }
      }
      const duration = Number(set.duration_sec);
      if (duration > 0) {
        row.timedSec += duration;
        if (duration > row.bestDuration) row.bestDuration = duration;
      }
    }
    return [...byName.values()].sort((a, b) =>
      (b.tonnage || b.timedSec || b.sets) - (a.tonnage || a.timedSec || a.sets)
    );
  }

  function doneAnalysisHtml(sets: LoggedSetLike[]): string {
    const rows = doneExerciseSummaries(sets);
    if (!rows.length) return "";
    const totalTonnage = rows.reduce((sum, row) => sum + row.tonnage, 0);
    const totalTimed = rows.reduce((sum, row) => sum + row.timedSec, 0);
    const metric = totalTonnage > 0 ? "tonnage" : totalTimed > 0 ? "time" : "sets";
    const scoreFor = (row: DoneExerciseSummary): number =>
      metric === "tonnage" ? row.tonnage : metric === "time" ? row.timedSec : row.sets;
    const totalScore = rows.reduce((sum, row) => sum + scoreFor(row), 0) || 1;
    const leader = rows[0];
    const insight = totalTonnage > 0
      ? `Top loaded work: ${leader.name} · ${Math.round(leader.tonnage).toLocaleString()} lb`
      : leader.bestDuration > 0
        ? `Longest hold: ${leader.name} · ${fmtDur(leader.bestDuration)}`
        : `${rows.length} movement${rows.length === 1 ? "" : "s"} covered`;
    const bars = rows.slice(0, 4).map((row) => {
      const pct = Math.max(8, Math.round((scoreFor(row) / totalScore) * 100));
      const meta = row.tonnage > 0
        ? `${row.sets} set${row.sets === 1 ? "" : "s"} · ${Math.round(row.tonnage).toLocaleString()} lb`
        : row.timedSec > 0
          ? `${row.sets} set${row.sets === 1 ? "" : "s"} · ${fmtDur(row.timedSec)}`
          : `${row.sets} set${row.sets === 1 ? "" : "s"}`;
      const best = row.bestLoadLabel || (row.bestDuration > 0 ? fmtDur(row.bestDuration) : "");
      return `<div class="done-bar-row">
        <div class="done-bar-label"><span>${escHtml(row.name)}</span><em>${escHtml(best)}</em></div>
        <div class="done-bar-track" aria-hidden="true"><span style="width:${pct}%"></span></div>
        <div class="done-bar-meta">${escHtml(meta)}</div>
      </div>`;
    }).join("");
    return `<div class="done-analysis" aria-label="Workout analysis">
      <div class="done-analysis-head"><span class="lbl">ANALYSIS</span><strong>${escHtml(insight)}</strong></div>
      <div class="done-bars">${bars}</div>
    </div>`;
  }

  function todaySessionDoneCardHtml(session: SessionLike, day: DayLike, options: { isToday?: boolean } = {}): string {
    const row = session && typeof session === "object" ? session : {};
    const sets = Array.isArray(row.sets) ? row.sets : [];
    const setCount = sets.length;
    const tonnage = todaySetsTonnage(sets);
    const exerciseCount = doneExerciseSummaries(sets).length;
    const name = row.title || day?.name || row.day_name || "Session";
    const chips = [
      `${setCount} set${setCount === 1 ? "" : "s"}`,
      exerciseCount ? `${exerciseCount} movement${exerciseCount === 1 ? "" : "s"}` : null,
      tonnage ? `${Math.round(tonnage).toLocaleString()} lb` : null,
      row.duration_min ? `${row.duration_min} min` : null,
    ].filter(Boolean).map((text) => `<span class="done-chip">${escHtml(text)}</span>`).join("");
    return `<div class="sessiondone reveal" style="--i:2">
      <div class="done-mark" aria-hidden="true">✓</div>
      <div class="done-kicker lbl">${options.isToday ? "Today · complete" : "Complete"}</div>
      <h2 class="done-title">${escHtml(name)}</h2>
      <div class="done-chips">${chips}</div>
      ${doneAnalysisHtml(sets)}
      ${row.notes ? `<div class="done-notes">“${escHtml(row.notes)}”</div>` : ""}
      <div id="feedbackSlot" class="feedback-slot done-feedback"></div>
      <div class="done-actions">
        <button class="ghostbtn done-reopen" id="reopenBtn">Log more</button>
        <button class="ghostbtn done-history" id="toHistoryBtn">In your history →</button>
      </div>
    </div>`;
  }

  function todaySessionHasFeedback(session: SessionLike): boolean {
    const row = session && typeof session === "object" ? session : {};
    return row.soreness != null || row.performance != null ||
      (row.joint_pain != null && String(row.joint_pain).trim() !== "");
  }

  function todayFeedbackOpenHtml(): string {
    return `<button class="checkin-open" id="feedbackOpen" type="button">
      <span class="checkin-open-dot" aria-hidden="true"></span>
      how did that feel?
    </button>`;
  }

  function todayFeedbackScaleHtml(kind: FeelKind, label: string): string {
    const dots = TODAY_FEEL_FACES.map((glyph, index) =>
      `<button class="feel-dot" data-feel="${escAttr(kind)}" data-val="${index + 1}" aria-label="${escAttr(`${label} ${index + 1}`)}">${glyph}</button>`
    ).join("");
    return `<div class="feel-row"><span class="feel-lbl lbl">${escHtml(label)}</span><div class="feel-dots">${dots}</div></div>`;
  }

  function todayFeedbackFormHtml(session: SessionLike): string {
    const row = session && typeof session === "object" ? session : {};
    return `<div class="checkin-form feedback-form chip-in">
      ${todayFeedbackScaleHtml("soreness", "soreness")}
      ${todayFeedbackScaleHtml("performance", "performance")}
      <input id="feedbackJoint" class="feedback-joint" type="text" autocomplete="off"
        placeholder="any joint or area? (e.g. left knee)" value="${escAttr(row.joint_pain || "")}">
      <button class="checkin-dismiss" id="feedbackDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
  }

  function todayFeedbackDoneHtml(session: SessionLike): string {
    const row = session && typeof session === "object" ? session : {};
    const parts = [];
    if (row.soreness != null) parts.push(`soreness ${Number(row.soreness)}/5`);
    if (row.performance != null) parts.push(`performance ${Number(row.performance)}/5`);
    if (row.joint_pain && String(row.joint_pain).trim()) parts.push(escHtml(String(row.joint_pain).trim()));
    if (!parts.length) return "";
    return `<div class="checkin-done feedback-done chip-in">
      <span class="checkin-done-mark" aria-hidden="true">✓</span> ${parts.join(" · ")}
      <button class="linkbtn linkbtn-plain linkbtn-sm feedback-edit" id="feedbackEdit" type="button">edit</button>
    </div>`;
  }

  function todaySkipNameHtml(name: unknown): string {
    const label = String(name ?? "");
    return `<button class="skip-name" data-unskip="${encodeURIComponent(label)}" title="Restore ${escAttr(label)}">${escHtml(label)}<span class="skip-undo">↺</span></button>`;
  }

  function todaySkipLineHtml(names: unknown): string {
    const rows = Array.isArray(names) ? names : [];
    return `<div class="skipline${rows.length ? "" : " skipline-empty"}" id="skipLine" aria-live="polite">
      <span class="lbl">Skipped</span>
      <span class="skipline-names">${rows.map(todaySkipNameHtml).join("")}</span>
    </div>`;
  }

  const CAIRN_TODAY_SESSION_STATUS = {
    FEEL_FACES: TODAY_FEEL_FACES,
    setChipHtml: todaySetChipHtml,
    setsTonnage: todaySetsTonnage,
    sessionDoneCardHtml: todaySessionDoneCardHtml,
    hasFeedback: todaySessionHasFeedback,
    feedbackOpenHtml: todayFeedbackOpenHtml,
    feedbackScaleHtml: todayFeedbackScaleHtml,
    feedbackFormHtml: todayFeedbackFormHtml,
    feedbackDoneHtml: todayFeedbackDoneHtml,
    skipNameHtml: todaySkipNameHtml,
    skipLineHtml: todaySkipLineHtml,
  };

  Object.assign(globalThis, {
    CairnTodaySessionStatus: CAIRN_TODAY_SESSION_STATUS,
    setsTonnage: todaySetsTonnage,
  });

  if (typeof window !== "undefined") {
    Object.assign(window, {
      CairnTodaySessionStatus: CAIRN_TODAY_SESSION_STATUS,
      setsTonnage: todaySetsTonnage,
    });
  }
})();

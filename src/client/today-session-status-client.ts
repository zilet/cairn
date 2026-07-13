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
// Motivational "highlights" payload (GET /api/sessions/:id/highlights). Every field
// is optional/loose — the card must render exactly as before when the fetch fails or
// a field is missing. See scheduleDoneCardHydration below for the in-place upgrade.
type DoneHighlightPr = { exercise?: unknown; kind?: unknown; label?: unknown };
type DoneHighlightComparison = {
  exercise?: unknown;
  prev_date?: unknown;
  prev_label?: unknown;
  delta_label?: unknown;
  direction?: "up" | "down" | "even" | null | unknown;
};
type DoneHighlights =
  | {
      prs?: DoneHighlightPr[] | null;
      comparisons?: DoneHighlightComparison[] | null;
      week?: { prs?: unknown; trained_days_7?: unknown } | null;
    }
  | null
  | undefined;
// Runtime app globals this surface reaches for lazily (all absent under the vm test
// harness, so every access is guarded). Tap-through and the highlights fetch degrade
// to a calm no-op when they're missing.
type DoneRuntimeGlobals = typeof globalThis & {
  api?: (path: string, opts?: unknown) => Promise<unknown>;
  activateTab?: (tab: string) => void;
  state?: Record<string, unknown>;
  __cairnDoneExDelegated?: boolean;
};

(() => {
  const TODAY_FEEL_FACES = ["·", "◦", "○", "◍", "●"] as const;
  // Monotonic render nonce: each done-card render stamps data-done-seq so a late
  // highlights fetch never upgrades a card a newer render already replaced.
  let doneRenderSeq = 0;

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

  const DONE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

  // "2026-07-06" -> "Jul 6" (human, never a raw ISO). "" when unparseable → caller
  // drops the "vs …" clause.
  function doneShortDate(value: unknown): string {
    const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return "";
    const month = DONE_MONTHS[Number(match[2]) - 1];
    const day = Number(match[3]);
    return month && day ? `${month} ${day}` : "";
  }

  function doneNameKey(name: unknown): string {
    return String(name ?? "").trim().toLowerCase();
  }

  function donePrList(highlights: DoneHighlights): DoneHighlightPr[] {
    const list = highlights && Array.isArray(highlights.prs) ? highlights.prs : [];
    return list.filter((pr): pr is DoneHighlightPr => !!pr && typeof pr === "object");
  }

  function doneComparisonIndex(highlights: DoneHighlights): Map<string, DoneHighlightComparison> {
    const map = new Map<string, DoneHighlightComparison>();
    const list = highlights && Array.isArray(highlights.comparisons) ? highlights.comparisons : [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const key = doneNameKey(raw.exercise);
      if (key && !map.has(key)) map.set(key, raw);
    }
    return map;
  }

  // Whether tap-through to the Progress 1RM trend is reachable from this scope.
  // Absent under the test harness / a partial boot → names render as calm text.
  function doneCanNavigate(): boolean {
    return typeof (globalThis as DoneRuntimeGlobals).activateTab === "function";
  }

  // The exercise name as a tap-through into Progress → 1RM (via a delegated click
  // listener), or plain text when navigation isn't wired.
  function doneExNameHtml(name: unknown): string {
    const label = String(name ?? "");
    if (doneCanNavigate()) {
      return `<button type="button" class="done-analysis-exlink" data-done-ex="${escAttr(label)}"><span>${escHtml(label)}</span></button>`;
    }
    return `<span>${escHtml(label)}</span>`;
  }

  // Quiet per-row "vs last" delta. Only rendered when a comparisons array is present
  // (a real payload) — so a failed/absent fetch shows no deltas at all, never a
  // misleading "first time logged". Up reads as calm progress (sage); down is neutral
  // gray, never alarming.
  function doneRowDeltaHtml(name: string, highlights: DoneHighlights, comparisons: Map<string, DoneHighlightComparison>): string {
    if (!highlights || !Array.isArray(highlights.comparisons)) return "";
    const comp = comparisons.get(doneNameKey(name));
    if (!comp) return `<span class="done-analysis-delta done-delta-new">first time logged</span>`;
    if (comp.direction === "even") return `<span class="done-analysis-delta done-delta-even">matched last</span>`;
    const delta = String(comp.delta_label ?? "").trim();
    const text = delta ? `${delta} vs last` : "vs last time";
    const cls = comp.direction === "up" ? "done-delta-up" : comp.direction === "down" ? "done-delta-down" : "done-delta-flat";
    return `<span class="done-analysis-delta ${cls}">${escHtml(text)}</span>`;
  }

  // Today's calm "what did I move most" line — the fallback when there are no PRs and
  // nothing improved to lead with.
  function doneFallbackInsight(rows: DoneExerciseSummary[]): string {
    const totalTonnage = rows.reduce((sum, row) => sum + row.tonnage, 0);
    const leader = rows[0];
    if (totalTonnage > 0) return `Top loaded work: ${leader.name} · ${Math.round(leader.tonnage).toLocaleString()} lb`;
    if (leader.bestDuration > 0) return `Longest hold: ${leader.name} · ${fmtDur(leader.bestDuration)}`;
    return `${rows.length} movement${rows.length === 1 ? "" : "s"} covered`;
  }

  // The first IMPROVING comparison, scanning rows in ranked (top-loaded) order, so the
  // forward-looking headline leads with something that actually went up.
  function doneLeadComparison(rows: DoneExerciseSummary[], highlights: DoneHighlights): DoneHighlightComparison | null {
    if (!highlights || !Array.isArray(highlights.comparisons)) return null;
    const index = doneComparisonIndex(highlights);
    for (const row of rows) {
      const comp = index.get(doneNameKey(row.name));
      if (comp && comp.direction === "up" && String(comp.delta_label ?? "").trim()) return comp;
    }
    return null;
  }

  // The lead line: PRs first, then a forward-looking "since last" line, then today's
  // calm loaded-work fallback. Everything server-supplied runs through escHtml.
  function doneAnalysisHeadHtml(rows: DoneExerciseSummary[], highlights: DoneHighlights): string {
    const prs = donePrList(highlights);
    if (prs.length) {
      const lead = prs[0];
      const ex = String(lead.exercise ?? "").trim();
      // The win leads as the plain subject (the lift); the raw figure supports it,
      // muted, never leading. The server label reads "225 lb × 3 — new best" /
      // "1:30 hold — new best" — the NEW BEST eyebrow already says as much, so drop
      // the redundant suffix and keep only the bare stat.
      const stat = String(lead.label ?? "").replace(/\s*[—-]\s*new best\s*$/i, "").trim();
      const more = prs.length - 1;
      const subject = ex ? escHtml(ex) : "New best";
      const statHtml = stat ? ` <span class="done-head-stat">${escHtml(stat)}</span>` : "";
      const tail = more > 0 ? ` <span class="done-pr-more">+${more} more best</span>` : "";
      return `<span class="lbl done-head-lbl done-head-pr">NEW BEST</span><strong><span class="done-pr-spark" aria-hidden="true">✦</span> ${subject}${statHtml}${tail}</strong>`;
    }
    const comp = doneLeadComparison(rows, highlights);
    if (comp) {
      const ex = String(comp.exercise ?? "").trim();
      const delta = String(comp.delta_label ?? "").trim();
      const when = doneShortDate(comp.prev_date);
      const vs = when ? ` <span class="done-head-vs">vs ${escHtml(when)}</span>` : "";
      return `<span class="lbl done-head-lbl">MOMENTUM</span><strong>${escHtml(ex)} ${escHtml(delta)}${vs}</strong>`;
    }
    return `<span class="lbl">ANALYSIS</span><strong>${escHtml(doneFallbackInsight(rows))}</strong>`;
  }

  // A calm week-context footnote (motivational, never a score). Omitted when absent.
  function doneWeekHtml(highlights: DoneHighlights): string {
    const week = highlights && highlights.week && typeof highlights.week === "object" ? highlights.week : null;
    if (!week) return "";
    const days = Number(week.trained_days_7);
    const prs = Number(week.prs);
    const hasDays = Number.isFinite(days) && days > 0;
    const hasPrs = Number.isFinite(prs) && prs > 0;
    // A plain sentence the reader takes in at a glance — the consistency win leads,
    // the bests join it. When there's no day count to lead with, the bests stand on
    // their own; nothing to say → nothing rendered.
    let sentence = "";
    if (hasDays) {
      sentence = `Trained ${days} of the last 7 days`;
      if (hasPrs) sentence += `, with ${prs} new best${prs === 1 ? "" : "s"}`;
    } else if (hasPrs) {
      sentence = `${prs} new best${prs === 1 ? "" : "s"} this week`;
    }
    if (!sentence) return "";
    return `<div class="done-week">${escHtml(sentence)}</div>`;
  }

  function doneAnalysisHtml(sets: LoggedSetLike[], highlights: DoneHighlights, idAttr: string): string {
    const rows = doneExerciseSummaries(sets);
    if (!rows.length) return "";
    const comparisons = doneComparisonIndex(highlights);
    // Ranked rows only — no per-exercise bars. A bar's width encoded a share of
    // session tonnage/time/sets, which is inherently apples-to-oranges across
    // exercises (a leg press always dwarfs a curl) and duplicated the meta text.
    const list = rows.slice(0, 4).map((row) => {
      const meta = row.tonnage > 0
        ? `${row.sets} set${row.sets === 1 ? "" : "s"} · ${Math.round(row.tonnage).toLocaleString()} lb`
        : row.timedSec > 0
          ? `${row.sets} set${row.sets === 1 ? "" : "s"} · ${fmtDur(row.timedSec)}`
          : `${row.sets} set${row.sets === 1 ? "" : "s"}`;
      const best = row.bestLoadLabel || (row.bestDuration > 0 ? fmtDur(row.bestDuration) : "");
      const delta = doneRowDeltaHtml(row.name, highlights, comparisons);
      return `<div class="done-analysis-row">
        <div class="done-analysis-name">${doneExNameHtml(row.name)}${best ? `<em>${escHtml(best)}</em>` : ""}</div>
        <div class="done-analysis-meta"><span class="done-analysis-vol">${escHtml(meta)}</span>${delta}</div>
      </div>`;
    }).join("");
    return `<div class="done-analysis" id="doneAnalysis-${idAttr}" aria-label="Workout analysis">
      <div class="done-analysis-head">${doneAnalysisHeadHtml(rows, highlights)}</div>
      ${doneWeekHtml(highlights)}
      <div class="done-analysis-list">${list}</div>
    </div>`;
  }

  // The highlights-dependent chip spans: PR chip first (terracotta), tonnage LAST (it
  // keeps trend value but is no longer the headline). Re-rendered in place on upgrade.
  function doneChipSpans(durationMin: unknown, sets: LoggedSetLike[], highlights: DoneHighlights): string {
    const setCount = sets.length;
    const tonnage = todaySetsTonnage(sets);
    const exerciseCount = doneExerciseSummaries(sets).length;
    const prCount = donePrList(highlights).length;
    const chips: Array<{ text: string; cls?: string }> = [];
    if (prCount) chips.push({ text: `${prCount} PR${prCount === 1 ? "" : "s"}`, cls: "done-chip-pr chip-in" });
    chips.push({ text: `${setCount} set${setCount === 1 ? "" : "s"}` });
    if (exerciseCount) chips.push({ text: `${exerciseCount} movement${exerciseCount === 1 ? "" : "s"}` });
    if (durationMin) chips.push({ text: `${String(durationMin)} min` });
    if (tonnage) chips.push({ text: `${Math.round(tonnage).toLocaleString()} lb` });
    return chips.map((chip) => `<span class="done-chip${chip.cls ? ` ${chip.cls}` : ""}">${escHtml(chip.text)}</span>`).join("");
  }

  // The finished-session card leads with MOTIVATION (PRs / forward motion), not raw
  // totals. It paints the calm known-good card synchronously; when `highlights` is
  // absent it schedules an SWR-style in-place upgrade (GET /api/sessions/:id/highlights)
  // that lifts the PR line, the "N PRs" chip and the per-row deltas in once fetched.
  // Passing `highlights` directly (tests / an already-warm caller) skips the fetch.
  function todaySessionDoneCardHtml(
    session: SessionLike,
    day: DayLike,
    options: { isToday?: boolean } = {},
    highlights: DoneHighlights = null,
  ): string {
    const row = session && typeof session === "object" ? session : {};
    const sets = Array.isArray(row.sets) ? row.sets : [];
    const name = row.title || day?.name || row.day_name || "Session";
    const sid = row.id != null ? String(row.id) : "";
    const idAttr = escAttr(sid);
    const seq = ++doneRenderSeq;
    if (!highlights) scheduleDoneCardHydration(row.duration_min, sets, sid, seq);
    return `<div class="sessiondone reveal" style="--i:2" id="doneCard-${idAttr}" data-done-seq="${seq}">
      <div class="done-mark" aria-hidden="true">✓</div>
      <div class="done-kicker lbl">${options.isToday ? "Today · complete" : "Complete"}</div>
      <h2 class="done-title">${escHtml(name)}</h2>
      <div class="done-chips" id="doneChips-${idAttr}">${doneChipSpans(row.duration_min, sets, highlights)}</div>
      ${doneAnalysisHtml(sets, highlights, idAttr)}
      ${row.notes ? `<div class="done-notes">“${escHtml(row.notes)}”</div>` : ""}
      <div id="feedbackSlot" class="feedback-slot done-feedback"></div>
      <div class="done-actions">
        <button class="ghostbtn done-reopen" id="reopenBtn">Log more</button>
        <button class="ghostbtn done-history" id="toHistoryBtn">In your history →</button>
      </div>
    </div>`;
  }

  // Tap an exercise name → Progress → 1RM trend for that lift. renderProgress()
  // reads state.progressEx / state.progressSeg (see progress-screen.ts). Guarded so a
  // partial boot or the test harness is a calm no-op.
  function navigateToProgressExercise(name: string | null): void {
    const g = globalThis as DoneRuntimeGlobals;
    const activate = g.activateTab;
    const st = g.state;
    if (!name || typeof activate !== "function" || !st || typeof st !== "object") return;
    st.progressEx = name;
    st.progressSeg = "trend";
    try {
      activate("progress");
    } catch {}
  }

  // One idempotent delegated click listener covers every done-card exercise link,
  // including ones swapped in by a later highlights upgrade — no per-card rewiring.
  function wireDoneExerciseDelegation(): void {
    const g = globalThis as DoneRuntimeGlobals;
    const doc = g.document;
    if (!doc || typeof doc.addEventListener !== "function" || g.__cairnDoneExDelegated) return;
    g.__cairnDoneExDelegated = true;
    doc.addEventListener("click", (event: Event) => {
      const target = event.target as Element | null;
      const link = target && typeof target.closest === "function" ? target.closest("[data-done-ex]") : null;
      if (link) navigateToProgressExercise(link.getAttribute("data-done-ex"));
    });
  }

  // After the card lands in the DOM, fetch highlights once and upgrade the chips +
  // analysis in place. Fully guarded + null-safe: no id / no fetch / no document →
  // the calm card simply stays as painted.
  function scheduleDoneCardHydration(durationMin: unknown, sets: LoggedSetLike[], sid: string, seq: number): void {
    const g = globalThis as DoneRuntimeGlobals;
    if (!sid || !g.document || typeof g.api !== "function") return;
    const kick = () => { void hydrateDoneCard(durationMin, sets, sid, seq, 0); };
    if (typeof g.requestAnimationFrame === "function") g.requestAnimationFrame(kick);
    else if (typeof g.setTimeout === "function") g.setTimeout(kick, 0);
  }

  async function hydrateDoneCard(durationMin: unknown, sets: LoggedSetLike[], sid: string, seq: number, attempt: number): Promise<void> {
    const g = globalThis as DoneRuntimeGlobals;
    const doc = g.document;
    const fetchApi = g.api;
    if (!doc || typeof fetchApi !== "function") return;
    const card = doc.getElementById(`doneCard-${sid}`);
    if (!card) {
      // The innerHTML write may lag this frame; retry once shortly, then give up.
      if (attempt < 2 && typeof g.setTimeout === "function") {
        g.setTimeout(() => { void hydrateDoneCard(durationMin, sets, sid, seq, attempt + 1); }, 60);
      }
      return;
    }
    if (card.getAttribute("data-done-seq") !== String(seq)) return; // a newer render owns this card
    let highlights: DoneHighlights = null;
    try {
      highlights = (await fetchApi(`/sessions/${encodeURIComponent(sid)}/highlights`)) as DoneHighlights;
    } catch {
      highlights = null;
    }
    if (!highlights || typeof highlights !== "object") return;
    const live = doc.getElementById(`doneCard-${sid}`);
    if (!live || !live.isConnected || live.getAttribute("data-done-seq") !== String(seq)) return;
    const chipHost = doc.getElementById(`doneChips-${sid}`);
    if (chipHost) chipHost.innerHTML = doneChipSpans(durationMin, sets, highlights);
    const analysis = doc.getElementById(`doneAnalysis-${sid}`);
    if (analysis) analysis.outerHTML = doneAnalysisHtml(sets, highlights, escAttr(sid));
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

  wireDoneExerciseDelegation();

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

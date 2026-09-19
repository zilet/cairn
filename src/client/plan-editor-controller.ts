// @ts-check
// Plan editor DOM orchestration: route paint, edit state, and save-bar persistence.

type PlanEditorControllerApiDay = import("../contracts/client.js").ClientPlanDay;
type PlanEditorControllerItem = {
  kind?: "strength" | "cardio";
  exercise?: unknown;
  sets?: unknown;
  rep_low?: unknown;
  rep_high?: unknown;
  target_weight?: unknown;
  note?: unknown;
  warmup_sets?: unknown;
  muscle_group?: unknown;
  target_seconds?: unknown;
  mode?: unknown;
  target_distance_km?: unknown;
  target_duration_min?: unknown;
  target_zone?: unknown;
  interval?: unknown;
  interval_note?: unknown;
};

type PlanEditorControllerDay = {
  day_number?: unknown;
  name?: unknown;
  focus?: unknown;
  day_type?: unknown;
  purpose?: unknown;
  out_of_order?: unknown;
  items?: PlanEditorControllerItem[];
};

type PlanEditorControllerModelDay = {
  day_number: unknown;
  name: unknown;
  focus: unknown;
  day_type: unknown;
  purpose?: unknown;
  out_of_order?: unknown;
  items: PlanEditorControllerItem[];
};

type PlanEditorProgAnnotation = {
  weekday?: string | null;
  status?: string | null;
  label?: string | null;
};

type PlanEditorControllerHelpers = {
  blankStrength(): PlanEditorControllerItem;
  blankCardio(): PlanEditorControllerItem;
  dayModelFromPlan(day: PlanEditorControllerDay | PlanEditorControllerApiDay): PlanEditorControllerModelDay;
  calendarFooterHtml(plan: unknown, host: unknown, icsUrl: unknown): string;
  progDayHtml(day: PlanEditorControllerDay, dayIndex: number, ann?: PlanEditorProgAnnotation): string;
  pitemHtml(item: PlanEditorControllerItem, dayIndex: number, itemIndex: number, lastIndex: number): string;
  pdayHtml(day: PlanEditorControllerDay, dayIndex: number): string;
};

type PlanEditorControllerForm = {
  dayNumber(day: PlanEditorControllerModelDay): number;
  datasetNumber(el: HTMLElement, key: string): number;
  datasetPair(value: string | undefined): [number, number];
  syncModel(model: PlanEditorControllerModelDay[], root: ParentNode): void;
  serializeDays(model: PlanEditorControllerModelDay[]): Array<Record<string, unknown>>;
};

declare function wireGuides(scope?: ParentNode | null): void;

(() => {
function planHelpers(): PlanEditorControllerHelpers {
  return CairnPlanEditor as unknown as PlanEditorControllerHelpers;
}

function planForm(): PlanEditorControllerForm {
  return CairnPlanEditorForm as unknown as PlanEditorControllerForm;
}

function planEditorRoot(): HTMLElement | null {
  return $("#planedit");
}

// The recovery-week banner — a reshaped week announces itself instead of arriving
// silently. Three states from /plan/recovery-status: review-only DRAFT, an UPCOMING
// lead-mode week that lands automatically, or the APPLIED lighter week (heads-up +
// the coach's own summary of what changed + when building resumes). Painted
// asynchronously into its slot; a null status leaves the plan untouched.
function planRecoveryBannerHtml(rs: import("../contracts/client.js").ClientRecoveryWeekStatus): string {
  if (!rs || (rs.state !== "drafted" && rs.state !== "upcoming" && rs.state !== "applied")) return "";
  if (rs.state === "drafted") {
    return `<div class="plan-recovery-banner reveal">
      <span class="lbl plan-recovery-mast">YOUR RECOVERY WEEK</span>
      <p class="plan-recovery-line">Drafted and waiting — nothing changes until you review and apply it.</p>
      ${rs.summary ? `<p class="plan-recovery-summary">${escHtml(rs.summary)}</p>` : ""}
      <button class="draftbtn plan-recovery-review" id="planRecoveryReview" type="button">Review and apply it →</button>
    </div>`;
  }
  if (rs.state === "upcoming") {
    const when = upcomingWhenLabel(rs.effective_date);
    return `<div class="plan-recovery-banner reveal">
      <span class="lbl plan-recovery-mast">YOUR RECOVERY WEEK</span>
      <p class="plan-recovery-line">Set for ${escHtml(when || rs.effective_date)} — it lands automatically at the week boundary, with no Apply step.</p>
      ${rs.summary ? `<p class="plan-recovery-summary">${escHtml(rs.summary)}</p>` : ""}
      <p class="plan-recovery-until">Hold it before then or Undo after it lands; your word always wins.</p>
    </div>`;
  }
  const until = fmtDate(rs.until);
  return `<div class="plan-recovery-banner plan-recovery-on reveal">
    <span class="lbl plan-recovery-mast">RECOVERY WEEK</span>
    <p class="plan-recovery-line">Heads up — this week is deliberately lighter: about half the working volume, same movements, crisp easy efforts. Don't chase PRs; this is where the adaptation lands.</p>
    ${rs.summary ? `<p class="plan-recovery-summary">${escHtml(rs.summary)}</p>` : ""}
    ${until ? `<p class="plan-recovery-until">Back to building around ${escHtml(until)}.</p>` : ""}
  </div>`;
}

// A local date-label helper (rs.until is a plain YYYY-MM-DD local day).
function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

// "lands Monday" for something inside the week, else "Mon, Jul 21" further out —
// a plain YYYY-MM-DD local day (the decision's effective_date).
function upcomingWhenLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (days >= 0 && days <= 6) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// The calm forward look: queued training/recovery changes the brain will land
// soon, one quiet line each. Pull-never-push — a heads-up that a reshaped week is
// coming, never a retrospective "what your team did" feed. Capped at 2.
function planUpcomingRowsHtml(items: import("../contracts/client.js").ClientPlanUpcomingItem[]): string {
  return items
    .map((it) => {
      const summary = String(it?.summary ?? "").trim();
      if (!summary) return "";
      const when = upcomingWhenLabel(String(it?.effective_date ?? ""));
      const explanation = String(it?.explanation ?? "").trim();
      return `<div class="plan-upcoming-item">
        <p class="plan-upcoming-line">${when ? `<span class="plan-upcoming-when">${escHtml(when)}</span> — ` : ""}${escHtml(summary)}</p>
        ${explanation ? `<p class="plan-upcoming-why">${escHtml(explanation)}</p>` : ""}
      </div>`;
    })
    .join("");
}

// Items a section actually renders (non-empty summary) — the same filter
// planUpcomingRowsHtml applies, kept in sync so the collapsed strip's counts
// always match what's behind the disclosure.
function planUpcomingCount(items: import("../contracts/client.js").ClientPlanUpcomingItem[]): number {
  return items.filter((it) => String(it?.summary ?? "").trim()).length;
}

function planUpcomingNoteHtml(note: import("../contracts/client.js").ClientPlanUpcomingNote): string {
  const comingItems = note && Array.isArray(note.items) ? note.items.slice(0, 2) : [];
  // What already landed, and why — the half that used to vanish the moment a change
  // took effect, leaving a reshaped week with nothing to explain it.
  const landedItems = note && Array.isArray(note.landed) ? note.landed.slice(0, 2) : [];
  // Still waiting on the athlete — shown first, because it is the only one of the
  // three that is an open question rather than a report.
  const awaitingItems = note && Array.isArray(note.awaiting) ? note.awaiting.slice(0, 2) : [];
  const rows = planUpcomingRowsHtml(comingItems);
  const landedRows = planUpcomingRowsHtml(landedItems);
  const awaitingRows = planUpcomingRowsHtml(awaitingItems);
  if (!rows.trim() && !landedRows.trim() && !awaitingRows.trim()) return "";
  // Collapsed by default: a single footnote-weight strip naming only the sections
  // that have items, so "Waiting on you" stays discoverable without reprinting the
  // full rationale paragraphs every time the plan opens. One tap expands to the
  // full content below; the plan itself never has to scroll past this to be seen.
  const strip = [
    awaitingRows.trim() ? `Waiting on you (${planUpcomingCount(awaitingItems)})` : "",
    rows.trim() ? `Coming up (${planUpcomingCount(comingItems)})` : "",
    landedRows.trim() ? `Where this came from (${planUpcomingCount(landedItems)})` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<details class="plan-upcoming reveal">
    <summary><span class="lbl plan-upcoming-strip">${escHtml(strip)}</span></summary>
    <div class="plan-upcoming-body">
      ${awaitingRows.trim() ? `<span class="lbl plan-upcoming-mast">Waiting on you</span>${awaitingRows}` : ""}
      ${rows.trim() ? `<span class="lbl plan-upcoming-mast">Coming up</span>${rows}` : ""}
      ${landedRows.trim() ? `<span class="lbl plan-upcoming-mast">Where this came from</span>${landedRows}` : ""}
    </div>
  </details>`;
}

// Shared by the Plan edit segment and the endurance segment (both under the
// "plan" tab) — paints into whichever slot the caller owns.
function loadPlanUpcomingNote(token: number, slotSel = "#planUpcomingSlot"): void {
  void api("/plan/upcoming")
    .then((note) => {
      if (token !== pollToken || state.tab !== "plan") return;
      const slot = $(slotSel);
      if (!slot) return;
      slot.innerHTML = planUpcomingNoteHtml(note as import("../contracts/client.js").ClientPlanUpcomingNote);
    })
    .catch(() => {});
}

/** Connected week strip for Strength + Endurance. Returns annotations for gallery chips. */
function loadPlanWeekStrip(
  token: number,
  slotSel = "#planWeekSlot",
  onWeek?: (week: import("../contracts/client.js").ClientPlanWeek) => void
): void {
  void api("/plan/week")
    .then((week) => {
      if (token !== pollToken || state.tab !== "plan") return;
      const slot = view.querySelector(slotSel) || $(slotSel);
      if (slot && typeof CairnPlanWeek !== "undefined") {
        slot.innerHTML = CairnPlanWeek.stripHtml(week);
      }
      if (onWeek && week && typeof week === "object") {
        onWeek(week as import("../contracts/client.js").ClientPlanWeek);
      }
    })
    .catch(() => {});
}

// ---------- redraw my week ----------
// A training-STRUCTURE request ("build my week around my six anchors", "drop to three
// days", "move heavy legs to Thursday") used to have exactly one door: knowing the magic
// words in chat. This is the same hand-off in plain sight, on the tab the week lives on —
// and it writes the SAME standing flag, so asking here and asking in chat can never build
// the week twice. Pull-never-push: collapsed to a footnote strip at rest, it waits to be
// tapped and never announces itself.
type PlanRedrawStatus = import("../contracts/client.js").ClientPlanRedrawStatus;
type PlanRedrawStanding = import("../contracts/client.js").ClientPlanRedrawStanding;
type PlanRedrawReceipt = import("../contracts/client.js").ClientPlanRedrawReceipt;

const PLAN_REDRAW_POLL_MS = 4_000;
// ~10 minutes of asking, then it stops; the next render reads the state again, so a build
// that outlives the poll is never lost — only the live ticking is.
const PLAN_REDRAW_POLL_LIMIT = 150;
// Fallback only, for the first paint before the status read resolves: the real bound is
// `max_chars` on that read, so the server stays the one place the number lives.
const PLAN_REDRAW_FALLBACK_MAX_CHARS = 1000;

// The one sentence of guidance, in the posture the server will actually take: under lead
// the built week ANNOUNCES and lands with a one-tap Undo; only review_everything waits.
function planRedrawGuidance(posture: string): string {
  const tail = posture === "asks"
    ? "and waits for you to confirm"
    : "and it lands at the next natural boundary with Undo";
  return `Tell the coach how the week should change — which days, what it's built around, what to drop. It drafts the whole week ${tail}.`;
}

function planRedrawComposerHtml(
  posture: string,
  error: string,
  draft: string,
  open: boolean,
  maxChars: number
): string {
  const max = maxChars > 0 ? maxChars : PLAN_REDRAW_FALLBACK_MAX_CHARS;
  return `<details class="plan-redraw reveal"${open ? " open" : ""}>
    <summary><span class="lbl plan-upcoming-strip">Redraw my week</span></summary>
    <div class="plan-redraw-body">
      <p class="plan-redraw-line">${escHtml(planRedrawGuidance(posture))}</p>
      <textarea id="planRedrawText" class="form-textarea plan-redraw-text" rows="2" maxlength="${max}" placeholder="e.g. move heavy legs to Thursday, or build the week around my six anchors">${escHtml(draft)}</textarea>
      ${error ? `<p class="plan-redraw-error">${escHtml(error)}</p>` : ""}
      <button class="logbtn plan-redraw-go" type="button" id="planRedrawGo" data-posture="${escAttr(posture)}" data-max="${max}">Redraw</button>
    </div>
  </details>`;
}

// In flight: the coach's own athlete-facing sentence (posture + landing day, already
// written server-side), which quotes the ask itself — so the athlete's words are echoed
// back only when that sentence did not already carry them, never twice.
function planRedrawInFlightHtml(request: string, explanation: string): string {
  const echo = request && !explanation.includes(request);
  return `<div class="plan-redraw-live reveal">
    <span class="lbl plan-redraw-mast">Redrawing your week…</span>
    ${echo ? `<p class="plan-redraw-ask">“${escHtml(request)}”</p>` : ""}
    ${explanation ? `<p class="plan-redraw-why">${escHtml(explanation)}</p>` : ""}
  </div>`;
}

// The one row worth a surface: something in flight outranks a failure to report, and a
// request already built into a change belongs in "Coming up", not here.
function planRedrawEntry(status: PlanRedrawStatus | null): PlanRedrawStanding | null {
  const rows = status && Array.isArray(status.standing) ? status.standing : [];
  return rows.find((row) => !!row?.build) || rows.find((row) => row?.outcome === "failed") || null;
}

// `posture` and `max_chars` are the read's CURRENT top-level ones, never a row's: a row's
// posture was stamped when its build was enqueued, so an athlete who has since changed
// lead_mode would be promised the old one by the box they are about to type into.
//
// A FAILED build renders the composer and nothing else, opened. The failure is not ours to
// report: settleStructureBuild sets review_required, so the flag's own paragraph is already
// standing in "Waiting on you" — which this very tab paints, in the slot directly above
// this one. A sentence here would be the same failure stacked twice on one screen. The
// ledger keeps the account; this slot keeps the door.
function planRedrawHtml(status: PlanRedrawStatus | null): string {
  const posture = String(status?.posture ?? "lands");
  const maxChars = Number(status?.max_chars) || PLAN_REDRAW_FALLBACK_MAX_CHARS;
  const entry = planRedrawEntry(status);
  if (entry?.build) return planRedrawInFlightHtml(String(entry.request ?? ""), String(entry.explanation ?? ""));
  if (entry?.outcome === "failed") return planRedrawComposerHtml(posture, "", "", true, maxChars);
  return planRedrawComposerHtml(posture, "", "", false, maxChars);
}

function paintPlanRedraw(token: number, html: string): void {
  if (token !== pollToken || state.tab !== "plan") return;
  const slot = $("#planRedrawSlot");
  if (!slot) return;
  slot.innerHTML = html;
  const btn = slot.querySelector<HTMLButtonElement>("#planRedrawGo");
  btn?.addEventListener("click", () => { void submitPlanRedraw(token, slot, btn); });
}

async function submitPlanRedraw(token: number, slot: Element, btn: HTMLButtonElement): Promise<void> {
  if (btn.disabled) return;
  const box = slot.querySelector<HTMLTextAreaElement>("#planRedrawText");
  const request = String(box?.value ?? "").trim();
  const posture = btn.dataset.posture || "lands";
  const maxChars = Number(btn.dataset.max) || PLAN_REDRAW_FALLBACK_MAX_CHARS;
  if (!request) {
    paintPlanRedraw(token, planRedrawComposerHtml(posture, "Say what should change.", "", true, maxChars));
    return;
  }
  btn.disabled = true;
  btn.textContent = "Redrawing…";
  const receipt = (await api("/plan/redraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  }).catch(() => null)) as PlanRedrawReceipt | null;
  if (token !== pollToken || state.tab !== "plan") return;
  // ok:false at 200 is the designed signal, not an HTTP error — the server's own
  // sentence IS the answer, spoken inline rather than thrown at a toast.
  if (!receipt || receipt.ok === false) {
    const said = String(receipt?.error ?? "").trim();
    paintPlanRedraw(token, planRedrawComposerHtml(posture, said || "Couldn't hand that to your coach right now — try again in a bit.", request, true, maxChars));
    return;
  }
  // Re-asking for something already BUILT comes back pointing at that change, with no
  // live build behind it. Painting "Redrawing your week…" over that would be four
  // seconds of a sentence that was never true — so read the state once and paint what
  // is actually there, and surface the built change where it lives.
  if (receipt.built_decision && !receipt.build) {
    loadPlanUpcomingNote(token);
    swrInvalidate("plan");
    loadPlanRedraw(token);
    return;
  }
  paintPlanRedraw(token, planRedrawInFlightHtml(request, String(receipt.decision?.action?.user_explanation ?? "")));
  pollPlanRedraw(token, 0);
}

// The build has landed (or there is nothing left in flight): the change now speaks for
// itself in "Coming up". Never rebuild the editor out from under an open day edit or a
// dirty savebar — the same guard the /plan revalidate keeps; the slots still refresh.
function planRedrawSettled(token: number): void {
  loadPlanUpcomingNote(token);
  swrInvalidate("plan");
  if (view.querySelector(".pday") || document.querySelector(".savebar.show")) {
    loadPlanRedraw(token);
    return;
  }
  void renderPlanEditor();
}

function pollPlanRedraw(token: number, tries: number): void {
  if (typeof setTimeout !== "function" || tries >= PLAN_REDRAW_POLL_LIMIT) return;
  setTimeout(() => {
    if (token !== pollToken || state.tab !== "plan" || !$("#planRedrawSlot")) return;
    void api("/plan/redraw")
      .then((data) => {
        if (token !== pollToken || state.tab !== "plan") return;
        const status = data as PlanRedrawStatus;
        const entry = planRedrawEntry(status);
        if (entry?.build) {
          paintPlanRedraw(token, planRedrawInFlightHtml(String(entry.request ?? ""), String(entry.explanation ?? "")));
          pollPlanRedraw(token, tries + 1);
          return;
        }
        if (entry?.outcome === "failed") {
          paintPlanRedraw(token, planRedrawHtml(status));
          return;
        }
        planRedrawSettled(token);
      })
      .catch(() => pollPlanRedraw(token, tries + 1));
  }, PLAN_REDRAW_POLL_MS);
}

// Read once on render, so a reload never loses an in-flight redraw and a failed one is
// still visible the next time the tab opens.
function loadPlanRedraw(token: number): void {
  void api("/plan/redraw")
    .then((data) => {
      if (token !== pollToken || state.tab !== "plan") return;
      const status = data as PlanRedrawStatus;
      paintPlanRedraw(token, planRedrawHtml(status));
      if (planRedrawEntry(status)?.build) pollPlanRedraw(token, 0);
    })
    .catch(() => {});
}

// Autocomplete for the plan editor's free-text exercise field — a <datalist> fed
// from the exercise catalog. Free text still works (a genuinely new exercise is
// legitimate); this just makes an existing one easy to find without retyping.
function loadExerciseNameOptions(token: number): void {
  void cachedApi("/exercises", {
    key: "exercises:names",
    onUpgrade: (data, { changed }) => {
      if (!changed || token !== pollToken || state.tab !== "plan") return;
      paintExerciseNameOptions(data);
    },
  })
    .then((data) => {
      if (token !== pollToken || state.tab !== "plan") return;
      paintExerciseNameOptions(data);
    })
    .catch(() => {});
}

function paintExerciseNameOptions(rows: unknown): void {
  const list = $("#exerciseNames");
  if (!list) return;
  const names = (Array.isArray(rows) ? rows : [])
    .map((row) => (row && typeof row === "object" ? String((row as { name?: unknown }).name || "") : ""))
    .filter(Boolean);
  list.innerHTML = names.map((name) => `<option value="${escAttr(name)}">`).join("");
}

function loadPlanRecoveryBanner(token: number): void {
  void api("/plan/recovery-status")
    .then((rs) => {
      if (token !== pollToken || state.tab !== "plan") return;
      const slot = $("#planRecoverySlot");
      if (!slot) return;
      slot.innerHTML = planRecoveryBannerHtml(rs as import("../contracts/client.js").ClientRecoveryWeekStatus);
      $("#planRecoveryReview")?.addEventListener("click", () => {
        state.planJump = "coach";
        activateTab("plan");
      });
    })
    .catch(() => {});
}

function planEditorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// ---------- the blank page's way out ----------
// Every other producer refines a week that already EXISTS and quietly no-ops
// without one — the progression engine, the run engine, the weekly evolution. So
// until now the one athlete with nothing to protect was the one athlete with no
// way forward but hand-building seven days. This is the entry that asks the team
// to shape a first week instead.
//
// Pull-never-push: it waits here to be tapped, it never notifies, and what it
// makes is a DRAFT that travels the ordinary review path — no new review UI, and
// nothing lands without the athlete seeing it. Every string below is a static
// literal; no server text reaches this markup.
function composeWeekEntryHtml(hasDays: boolean): string {
  const opening = hasDays ? "Your plan days are still empty." : "No days in your plan yet.";
  return `<p class="plan-empty-line">${opening} Your team can shape a first week around your goal, whatever you've already logged, and any running you do.</p>
      <input id="planComposeNote" class="form-input plan-empty-note" type="text" maxlength="240" autocomplete="off" placeholder="Anything your coach should know? (optional) — e.g. I can only train 3 days…">
      <button class="draftbtn plan-empty-compose" type="button" id="planComposeWeek">Shape my first week →</button>
      <div id="planComposeCap" class="plan-empty-cap job-cap lbl"></div>`;
}

// The durable background job behind that tap — the same enqueue → job card →
// reconnect shape /program/evolve uses, so a reload mid-compose loses nothing.
async function composeFirstWeek(btn: HTMLButtonElement): Promise<void> {
  if (btn.disabled) return;
  const anchor = ".plan-empty";
  const label = btn.textContent || "Shape my first week →";
  // Scoped to the button's own container rather than a global id lookup: the note
  // sits alongside the button in the same composeWeekEntryHtml output, and only one
  // instance of that markup is ever painted at a time (draw() takes either the
  // no-days branch or the blank-shells branch, never both) — but scoping here still
  // costs nothing and stays correct even if that ever changes.
  const noteEl = btn.parentElement?.querySelector<HTMLInputElement>("#planComposeNote");
  const instruction = noteEl?.value.trim() || undefined;
  btn.disabled = true;
  btn.textContent = "Shaping your week…";
  const restore = (): void => {
    const live = document.querySelector<HTMLButtonElement>("#planComposeWeek");
    if (!live) return;
    live.disabled = false;
    live.textContent = label;
  };
  await runOp("compose_week", { instruction }, {
    path: "/program/compose-week",
    anchor,
    caption: "compose_week",
    guard: () => !document.querySelector(anchor)?.isConnected,
    render: (result: unknown) => {
      restore();
      const autonomy = planEditorRecord(planEditorRecord(result).autonomy);
      swrInvalidate("plan");
      swrInvalidate("plan:proposals");
      // The three honest endings, matching what the autonomy layer actually did.
      // A whole week is structural, so `lead` announces it rather than applying it
      // quietly — the copy says so instead of promising a review step that posture
      // does not have.
      if (autonomy.pending || autonomy.announced) {
        toast("Set — your team will land your first week at the natural boundary");
        renderPlanEditor();
        return;
      }
      if (autonomy.tier === "quiet_apply") {
        toast("Your first week is in");
        renderPlanEditor();
        return;
      }
      // Review posture: the draft is waiting in the Coach segment, so go where it
      // is — the same jump the recovery-week banner's review link makes.
      toast("Your first week is drafted — have a look");
      state.planJump = "coach";
      activateTab("plan");
    },
    // ok:false at 200 is the designed signal, not an HTTP error. When it carries
    // the server's own sentence (a week already exists → evolve it instead) that
    // sentence IS the answer, so it is spoken verbatim rather than replaced by a
    // generic failure. toast writes textContent, so it needs no escaping.
    onFail: (error: unknown) => {
      restore();
      const said = planEditorRecord(error).error;
      toast(typeof said === "string" && said.trim() ? said : "Couldn't shape a week right now — try again in a bit.");
    },
  });
}

function wireComposeWeek(root: ParentNode): void {
  const btn = root.querySelector<HTMLButtonElement>("#planComposeWeek");
  btn?.addEventListener("click", () => { void composeFirstWeek(btn); });
}

async function renderPlanEditor(): Promise<void> {
  const helpers = planHelpers();
  const form = planForm();
  headerTitle.textContent = "Plan";
  state.planSeg = "edit";
  const token = ++pollToken;
  const peek = peekCached<PlanEditorControllerApiDay[]>("plan");
  if (!peek) view.innerHTML = segSkeleton("edit", planSeg(), 3);
  const revalidate = cachedApi("/plan", {
    key: "plan",
    onUpgrade: (_data, { changed }) => {
      if (peek && !peek.fresh) markRefreshing(false);
      if (!changed || !peek) return;
      if (state.tab !== "plan" || token !== pollToken || !view.querySelector("#planedit")) return;
      if (view.querySelector(".pday") || document.querySelector(".savebar.show")) return;
      renderPlanEditor();
    },
  });
  const plan = peek ? peek.data : await revalidate.catch(() => []);
  if (token !== pollToken || state.tab !== "plan") return;
  if (peek && !peek.fresh) markRefreshing(true);

  const icsUrl = withToken("/api/plan.ics");
  const calFooter = helpers.calendarFooterHtml(plan, location.host, icsUrl);
  view.innerHTML = segBar("edit", planSeg()) + `<div id="planWeekSlot" class="card-stack-item"></div><div id="planRecoverySlot"></div><div id="planUpcomingSlot"></div><div id="planRedrawSlot"></div><div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>${calFooter}
    <datalist id="exerciseNames"></datalist>`;
  wireSeg(PLAN_HANDLERS);
  loadPlanRecoveryBanner(token);
  loadPlanUpcomingNote(token);
  loadExerciseNameOptions(token);

  const model: PlanEditorControllerModelDay[] = (Array.isArray(plan) ? plan : []).map((day) => helpers.dayModelFromPlan(day));
  const editing = new Set<number>();
  let planBar: ClientSaveBar | null = null;
  let weekAnn = new Map<number, PlanEditorProgAnnotation>();
  loadPlanWeekStrip(token, "#planWeekSlot", (week) => {
    if (typeof CairnPlanWeek === "undefined") return;
    weekAnn = CairnPlanWeek.annotationsByDayNumber(week);
    // Re-draw gallery cards with weekday/status once the week lands — skip if editing.
    if (view.querySelector(".pday") || document.querySelector(".savebar.show")) return;
    draw();
  });

  function markDirty(): void {
    planBar?.markDirty();
  }

  function sync(): void {
    form.syncModel(model, view);
  }

  // Is there a week here at all? The SAME predicate the server uses to decide a
  // blank slate (composeWeek's guard, and the scheduler's "no plan to evolve yet"
  // no-op): a plan day CARRYING items, not a day row existing. So a leftover empty
  // shell day still reads as a blank page here, exactly as it does on the server —
  // and the athlete is never offered a compose the server would refuse, or refused
  // one it would run.
  function planIsBlank(): boolean {
    return !model.some((day) => (Array.isArray(day.items) ? day.items : []).length > 0);
  }

  function draw(): void {
    const root = planEditorRoot();
    if (!root) return;
    const blank = planIsBlank();
    // Empty plan: still offer the always-available "just start" entry alongside
    // "+ Add day" — mirrors the Train tab's start entry (dayPicked=false →
    // openSession on today) so an empty plan is never a dead end.
    if (!model.length) {
      root.innerHTML = `<div class="plan-empty reveal">
        ${composeWeekEntryHtml(false)}
        <p class="plan-empty-line plan-empty-alt">Or build the days yourself below — or just start training and log as you go.</p>
        <button class="draftbtn plan-empty-start" type="button" id="planEmptyStart">Start training anyway →</button>
      </div>`;
      wireComposeWeek(root);
      root.querySelector("#planEmptyStart")?.addEventListener("click", () => {
        state.dayPicked = false;
        state.dayPickedOn = null;
        if (typeof openSession === "function") void openSession(localISO(), {
          source: "athlete_override",
          replace: true,
          trigger: root.querySelector<HTMLElement>("#planEmptyStart"),
          provenance: { entry: "empty_plan" },
        });
      });
      return;
    }
    // Days exist but none carries work yet — still a blank page by the server's own
    // reading, so the same quiet entry sits above the shells the athlete can fill in.
    root.innerHTML =
      (blank ? `<div class="plan-empty reveal">${composeWeekEntryHtml(true)}</div>` : "") +
      model.map((day, dayIndex) => {
        if (editing.has(dayIndex)) return helpers.pdayHtml(day, dayIndex);
        const ann = weekAnn.get(form.dayNumber(day));
        return helpers.progDayHtml(day, dayIndex, ann);
      }).join("");
    if (blank) wireComposeWeek(root);
    wireGuides(root);

    view.querySelectorAll<HTMLElement>("[data-editday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      editing.add(form.datasetNumber(button, "editday"));
      draw();
    }));
    // "Train this day": jump into the isolated Session logging surface with THIS
    // plan day preselected, logged against today. Reuses the shared openSession()
    // + the state.day/dayPicked mechanism the Session surface already honors —
    // no parallel routing. sync() first so any in-progress edits aren't lost.
    view.querySelectorAll<HTMLElement>("[data-trainday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const day = model[form.datasetNumber(button, "trainday")];
      if (!day) return;
      state.day = form.dayNumber(day);
      state.dayPicked = true;
      // The day is trained TODAY, so the pick is anchored to the calendar's own day:
      // it goes stale at midnight instead of pinning the app to this date forever.
      state.dayPickedOn = localISO();
      if (typeof openSession === "function") void openSession(localISO(), {
        source: "manual_plan",
        dayNumber: state.day,
        replace: true,
        trigger: button,
        provenance: { entry: "plan_day_train" },
      });
    }));
    // Quiet "Order for effect" — compounds → accessories → finishers → cardio.
    view.querySelectorAll<HTMLElement>("[data-orderday]").forEach((button) => button.addEventListener("click", () => {
      void (async () => {
        sync();
        const day = model[form.datasetNumber(button, "orderday")];
        if (!day) return;
        const dayNumber = form.dayNumber(day);
        button.setAttribute("disabled", "true");
        try {
          const result = await api(`/plan/${dayNumber}/order-for-effect`, { method: "POST" });
          if (result && typeof result === "object" && "error" in result && (result as { error?: unknown }).error) {
            toast(String((result as { error: unknown }).error) || "Couldn't reorder that day.");
            return;
          }
          state.plan = [];
          swrInvalidate("plan");
          void renderPlanEditor();
        } catch {
          toast("Couldn't reorder that day — try again in a bit.");
        } finally {
          button.removeAttribute("disabled");
        }
      })();
    }));
    view.querySelectorAll<HTMLElement>("[data-doneday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      editing.delete(form.datasetNumber(button, "doneday"));
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-delday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const deleted = form.datasetNumber(button, "delday");
      model.splice(deleted, 1);
      const keep = [...editing].filter((index) => index !== deleted).map((index) => (index > deleted ? index - 1 : index));
      editing.clear();
      keep.forEach((index) => editing.add(index));
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-delitem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayIndex, itemIndex] = form.datasetPair(button.dataset.delitem);
      const day = model[dayIndex];
      if (day && itemIndex >= 0) {
        day.items.splice(itemIndex, 1);
        markDirty();
        draw();
      }
    }));
    view.querySelectorAll<HTMLElement>("[data-additem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const day = model[form.datasetNumber(button, "additem")];
      if (!day) return;
      day.items.push(helpers.blankStrength());
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-addcardio]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const day = model[form.datasetNumber(button, "addcardio")];
      if (!day) return;
      day.items.push(helpers.blankCardio());
      markDirty();
      draw();
    }));
    // Mark / unmark the week's rest day. Toggling ON clears the day's items, because a
    // rest day carries none and the server refuses one that does — so the athlete sees
    // the day empty at the moment they say it, rather than a save error afterwards.
    view.querySelectorAll<HTMLElement>("[data-restday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const day = model[form.datasetNumber(button, "restday")];
      if (!day) return;
      const nowRest = String(day.day_type ?? "training") !== "rest";
      day.day_type = nowRest ? "rest" : "training";
      if (nowRest) day.items = [];
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-pikind]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayRaw, itemRaw, kindRaw] = String(button.dataset.pikind || "").split(":");
      const dayIndex = Number(dayRaw);
      const itemIndex = Number(itemRaw);
      const kind = kindRaw === "cardio" ? "cardio" : "strength";
      const item = model[dayIndex]?.items[itemIndex];
      if (!item || item.kind === kind) return;
      const label = item.kind === "cardio" ? (item.note || "") : (item.exercise || "");
      const next = kind === "cardio" ? helpers.blankCardio() : helpers.blankStrength();
      if (kind === "cardio") next.note = label;
      else next.exercise = label;
      model[dayIndex].items[itemIndex] = next;
      markDirty();
      draw();
    }));
    view.querySelectorAll<HTMLElement>("[data-upitem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayIndex, itemIndex] = form.datasetPair(button.dataset.upitem);
      const items = model[dayIndex]?.items;
      if (items && itemIndex > 0) {
        [items[itemIndex - 1], items[itemIndex]] = [items[itemIndex], items[itemIndex - 1]];
        markDirty();
        draw();
      }
    }));
    view.querySelectorAll<HTMLElement>("[data-downitem]").forEach((button) => button.addEventListener("click", () => {
      sync();
      const [dayIndex, itemIndex] = form.datasetPair(button.dataset.downitem);
      const items = model[dayIndex]?.items;
      if (items && itemIndex >= 0 && itemIndex < items.length - 1) {
        [items[itemIndex + 1], items[itemIndex]] = [items[itemIndex], items[itemIndex + 1]];
        markDirty();
        draw();
      }
    }));
  }

  $("#addDay")?.addEventListener("click", () => {
    sync();
    const next = model.reduce((max, day) => Math.max(max, form.dayNumber(day)), 0) + 1;
    model.push({ day_number: next, name: `Day ${next}`, focus: "", day_type: "training", purpose: "", out_of_order: false, items: [] });
    editing.add(model.length - 1);
    markDirty();
    draw();
  });

  const persistPlan = async (): Promise<boolean> => {
    sync();
    const days = form.serializeDays(model);
    const status = $("#planstatus");
    if (!days.length) {
      if (status) status.textContent = "Add at least one day before saving.";
      return false;
    }
    const response = await api("/plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
    if (response && "error" in response && response.error) {
      if (status) status.textContent = "Couldn't save your plan — try again.";
      return false;
    }
    state.plan = [];
    swrInvalidate("plan");
    renderPlanEditor();
    return true;
  };

  const planEdit = planEditorRoot();
  if (!planEdit) return;
  planBar = mountSaveBar({
    sentinel: planEdit,
    fields: planEdit,
    onSave: persistPlan,
    onDiscard: () => renderPlanEditor(),
  });

  // A blank plan already has the compose-week entry — asking to REDRAW a week that does
  // not exist yet would be two doors to the same empty room.
  if (!planIsBlank()) loadPlanRedraw(token);

  draw();
}

const CAIRN_PLAN_EDITOR_CONTROLLER = {
  render: renderPlanEditor,
  serializeDays: (model: PlanEditorControllerModelDay[]) => planForm().serializeDays(model),
  planRecoveryBannerHtml,
};

Object.assign(globalThis, {
  CairnPlanEditorController: CAIRN_PLAN_EDITOR_CONTROLLER,
  renderPlanEditor,
  loadPlanUpcomingNote,
  loadPlanWeekStrip,
});

if (typeof window !== "undefined") {
  window.CairnPlanEditorController = CAIRN_PLAN_EDITOR_CONTROLLER;
  window.renderPlanEditor = renderPlanEditor;
  window.loadPlanUpcomingNote = loadPlanUpcomingNote;
  window.loadPlanWeekStrip = loadPlanWeekStrip;
}
})();

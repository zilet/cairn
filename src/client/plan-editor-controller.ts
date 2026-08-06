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
  items?: PlanEditorControllerItem[];
};

type PlanEditorControllerModelDay = {
  day_number: unknown;
  name: unknown;
  focus: unknown;
  items: PlanEditorControllerItem[];
};

type PlanEditorControllerHelpers = {
  blankStrength(): PlanEditorControllerItem;
  blankCardio(): PlanEditorControllerItem;
  dayModelFromPlan(day: PlanEditorControllerDay | PlanEditorControllerApiDay): PlanEditorControllerModelDay;
  calendarFooterHtml(plan: unknown, host: unknown, icsUrl: unknown): string;
  progDayHtml(day: PlanEditorControllerDay, dayIndex: number): string;
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
  view.innerHTML = segBar("edit", planSeg()) + `<div id="planRecoverySlot"></div><div id="planUpcomingSlot"></div><div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>${calFooter}`;
  wireSeg(PLAN_HANDLERS);
  loadPlanRecoveryBanner(token);
  loadPlanUpcomingNote(token);

  const model: PlanEditorControllerModelDay[] = (Array.isArray(plan) ? plan : []).map((day) => helpers.dayModelFromPlan(day));
  const editing = new Set<number>();
  let planBar: ClientSaveBar | null = null;

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
      model.map((day, dayIndex) => editing.has(dayIndex) ? helpers.pdayHtml(day, dayIndex) : helpers.progDayHtml(day, dayIndex)).join("");
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
      if (typeof openSession === "function") void openSession(localISO(), {
        source: "manual_plan",
        dayNumber: state.day,
        replace: true,
        trigger: button,
        provenance: { entry: "plan_day_train" },
      });
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
    model.push({ day_number: next, name: `Day ${next}`, focus: "", items: [] });
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
});

if (typeof window !== "undefined") {
  window.CairnPlanEditorController = CAIRN_PLAN_EDITOR_CONTROLLER;
  window.renderPlanEditor = renderPlanEditor;
  window.loadPlanUpcomingNote = loadPlanUpcomingNote;
}
})();

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
// silently. Two states from /plan/recovery-status: a DRAFT waiting ("review and
// apply it", one tap to Drafts) or the APPLIED lighter week in flight (heads-up +
// the coach's own summary of what changed + when building resumes). Painted
// asynchronously into its slot; a null status leaves the plan untouched.
function planRecoveryBannerHtml(rs: import("../contracts/client.js").ClientRecoveryWeekStatus): string {
  if (!rs || (rs.state !== "drafted" && rs.state !== "applied")) return "";
  if (rs.state === "drafted") {
    return `<div class="plan-recovery-banner reveal">
      <span class="lbl plan-recovery-mast">YOUR RECOVERY WEEK</span>
      <p class="plan-recovery-line">Drafted and waiting — nothing changes until you review and apply it.</p>
      ${rs.summary ? `<p class="plan-recovery-summary">${escHtml(rs.summary)}</p>` : ""}
      <button class="draftbtn plan-recovery-review" id="planRecoveryReview" type="button">Review and apply it →</button>
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
  view.innerHTML = segBar("edit", planSeg()) + `<div id="planRecoverySlot"></div><div id="planedit"></div>
    <button id="addDay" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">+ Add day</button>
    <div id="planstatus" style="margin-top:8px;color:var(--muted);font-size:.82rem"></div>${calFooter}`;
  wireSeg(PLAN_HANDLERS);
  loadPlanRecoveryBanner(token);

  const model: PlanEditorControllerModelDay[] = (Array.isArray(plan) ? plan : []).map((day) => helpers.dayModelFromPlan(day));
  const editing = new Set<number>();
  let planBar: ClientSaveBar | null = null;

  function markDirty(): void {
    planBar?.markDirty();
  }

  function sync(): void {
    form.syncModel(model, view);
  }

  function draw(): void {
    const root = planEditorRoot();
    if (!root) return;
    root.innerHTML = model.map((day, dayIndex) => editing.has(dayIndex) ? helpers.pdayHtml(day, dayIndex) : helpers.progDayHtml(day, dayIndex)).join("");
    wireGuides(root);

    view.querySelectorAll<HTMLElement>("[data-editday]").forEach((button) => button.addEventListener("click", () => {
      sync();
      editing.add(form.datasetNumber(button, "editday"));
      draw();
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
});

if (typeof window !== "undefined") {
  window.CairnPlanEditorController = CAIRN_PLAN_EDITOR_CONTROLLER;
  window.renderPlanEditor = renderPlanEditor;
}
})();

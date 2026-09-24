// @ts-check
// Plan editor render/model helpers. The plan holds lift days only: every run lives
// in Plan -> Endurance, so nothing here draws, adds or edits a run or a rest day.

type PlanEditorApiDay = import("../contracts/client.js").ClientPlanDay;
type PlanEditorItem = {
  kind?: "strength";
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
};

type PlanEditorDay = {
  day_number?: unknown;
  name?: unknown;
  focus?: unknown;
  day_type?: unknown;
  purpose?: unknown;
  out_of_order?: unknown;
  items?: PlanEditorItem[];
};

type ProgDayAnnotation = {
  weekday?: string | null;
  status?: string | null;
  /** A whole chip the week strip already composed (e.g. "Sat · Easy run 6.3 km"). */
  label?: string | null;
};

(() => {
function blankStrength(): PlanEditorItem {
  return { kind: "strength", exercise: "", sets: 3, rep_low: 8, rep_high: 10, target_weight: null, note: "", warmup_sets: null };
}

// Where the editor points for runs. One quiet line, never a form: the athlete edits
// runs in Endurance, where the run plan, the week's go-ahead and the projections live.
function runsElsewhereHtml(): string {
  return `<p class="plan-runs-note prog-purpose">${escHtml("Lift days only here — your runs live in Endurance.")} <button class="linkbtn linkbtn-plain linkbtn-sm" type="button" data-plan-runs>Open Endurance →</button></p>`;
}

function dayModelFromPlan(
  day: PlanEditorDay | PlanEditorApiDay
): Required<Pick<PlanEditorDay, "day_number" | "name" | "focus" | "day_type" | "items">> & {
  purpose: string;
  out_of_order: boolean;
} {
  return {
    day_number: day.day_number,
    name: day.name,
    focus: day.focus || "",
    // Every plan day is a lift day; a rest day is simply a weekday with no lift and
    // no run on it (the calendar), never a row the editor carries.
    day_type: "training",
    purpose: typeof (day as { purpose?: unknown }).purpose === "string" ? String((day as { purpose: string }).purpose) : "",
    out_of_order: (day as { out_of_order?: unknown }).out_of_order === true,
    // A cardio item an older payload still carries is dropped, never edited here.
    items: strengthPlanItems((Array.isArray(day.items) ? day.items : []) as PlanEditorItem[]).map((item) => ({
      kind: "strength" as const,
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
    })),
  };
}

// A plan row's load with its unit: "125 lb", "30 lb assist". Negative = assisted.
function fmtWeightLb(weight: unknown): string {
  const n = Number(weight);
  if (!Number.isFinite(n)) return fmtWeight(weight);
  return n < 0 ? `${-n} lb assist` : `${n} lb`;
}

function progDayStatusLabel(ann: ProgDayAnnotation | undefined): string {
  // No week annotation yet (first paint, or an unscheduled week): the caller's
  // "Day N" fallback names the seam, so say nothing here.
  if (!ann) return "";
  if (ann.label) return String(ann.label);
  const weekday = ann.weekday ? String(ann.weekday) : "";
  const status = String(ann.status || "");
  if (status === "done") return weekday ? `Done · ${weekday}` : "Done";
  if (status === "today") return weekday ? `Today · ${weekday}` : "Today";
  if (status === "upcoming") return weekday ? `${weekday} · Up next` : "Up next";
  if (status === "rest") return weekday ? `${weekday} · Rest` : "Rest";
  if (status === "open") return weekday || "";
  return weekday;
}

function calendarFooterHtml(plan: unknown, host: unknown, icsUrl: unknown): string {
  return Array.isArray(plan) && plan.length
    ? `<div id="planCal" style="margin-top:16px;text-align:center;font-size:.82rem;color:var(--muted)">
         <a href="webcal://${escAttr(host)}${escAttr(icsUrl)}" style="color:var(--muted);text-decoration:none">📅 Subscribe to this plan in your calendar</a>
         <a href="${escAttr(icsUrl)}" target="_blank" rel="noopener" style="color:var(--muted);opacity:.7;margin-left:8px">(.ics)</a>
       </div>`
    : "";
}

// `sharedPurpose`: a purpose line the gallery already says ONCE above the cards (every
// card repeating "laying down the block's foundation" read as noise), so the card drops it.
function progDayHtml(
  day: PlanEditorDay,
  dayIndex: number,
  ann?: ProgDayAnnotation,
  opts: { sharedPurpose?: string | null } = {}
): string {
  const items = strengthPlanItems(Array.isArray(day.items) ? day.items : []);
  const statusLabel = progDayStatusLabel(ann);
  const ownPurpose = typeof day.purpose === "string" ? day.purpose.trim() : "";
  const purpose = opts.sharedPurpose && ownPurpose === opts.sharedPurpose ? "" : ownPurpose;
  // A day already trained this week offers no "Train" — Edit stays.
  const trainedThisWeek = ann?.status === "done";
  const outOfOrder = day.out_of_order === true && items.length > 1;
  const strip = items.map((item) => {
    const exercise = String(item.exercise || "");
    const tile = artImg("exercise", exercise, "artile-md strip-tile", art("exercise", exercise, item.muscle_group));
    return tile ? `<div data-guide="${encodeURIComponent(exercise)}" style="cursor:pointer">${tile}</div>` : "";
  }).join("");
  const rows = items.map((item) => {
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
            ${item.target_weight != null && (!timed || Number(item.target_weight) !== 0) ? `<span class="numeral prog-row-wt">${escHtml(fmtWeightLb(item.target_weight))}</span>` : ""}
          </div>
        </div>`;
  }).join("");
  return `<div class="prog-day reveal" style="${stagger(dayIndex)}" data-pd="${dayIndex}">
        <div class="prog-head">
          <div class="prog-head-main">
            <div class="lbl">${statusLabel ? escHtml(statusLabel) : `Day ${escHtml(day.day_number)}`}</div>
            <div class="prog-name">${escHtml(day.name || `Day ${day.day_number}`)}</div>
            ${day.focus ? `<div class="prog-focus">${escHtml(day.focus)}</div>` : ""}
            ${purpose ? `<div class="prog-purpose">${escHtml(purpose)}</div>` : ""}
          </div>
          <div class="prog-head-actions">
            ${!items.length || trainedThisWeek ? "" : `<button class="ghostbtn prog-train" data-trainday="${dayIndex}">Train</button>`}
            ${outOfOrder ? `<button class="linkbtn prog-order" type="button" data-orderday="${dayIndex}">Order for effect</button>` : ""}
            <button class="ghostbtn prog-edit" data-editday="${dayIndex}">Edit day</button>
          </div>
        </div>
        ${strip ? `<div class="prog-strip">${strip}</div>` : ""}
        <div class="prog-list">${rows || `<div class="empty">No exercises yet — tap Edit day.</div>`}</div>
      </div>`;
}

function pitemHtml(item: PlanEditorItem, dayIndex: number, itemIndex: number, lastIndex: number): string {
  const ord = `<div class="pi-ord">
        <button class="ordbtn" data-upitem="${dayIndex}:${itemIndex}" ${itemIndex === 0 ? "disabled" : ""}>↑</button>
        <button class="ordbtn" data-downitem="${dayIndex}:${itemIndex}" ${itemIndex === lastIndex ? "disabled" : ""}>↓</button>
      </div>`;
  return `<div class="pitem" data-d="${dayIndex}" data-i="${itemIndex}" data-kind="strength">
        <div class="pi-row1">
          <input class="pi-ex" value="${escAttr(item.exercise)}" placeholder="Exercise" list="exerciseNames">
          ${ord}
        </div>
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

function pdayHtml(day: PlanEditorDay, dayIndex: number): string {
  const items = strengthPlanItems(Array.isArray(day.items) ? day.items : []);
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
        </div>
      </div>`;
}

const CAIRN_PLAN_EDITOR = {
  blankStrength,
  runsElsewhereHtml,
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

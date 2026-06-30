// @ts-check
// ==== 02-ui.js ====
type UiRecord = Record<string, unknown>;
type UiSegment = readonly [string, string];
type ToastOptions = { action?: string; onAction?: () => void };
type BusyButton = HTMLButtonElement & { _busyRestore?: (() => void) | null };
type UiWiredElement = Element & { _wired?: boolean };
type DetailOverlay = HTMLDivElement & {
  _failed?: boolean;
  _onKey?: (event: KeyboardEvent) => void;
  _onResize?: () => void;
  _term?: { dispose?: () => void };
  _ws?: WebSocket;
};
type ExerciseSetRow = UiRecord & {
  date?: string;
  duration_sec?: number | string | null;
  weight?: number | string | null;
  reps?: number | string | null;
  rir?: number | string | null;
  pr?: boolean;
};
type ExerciseProgressPoint = UiRecord & { best1rm?: number | string | null };
type ExercisePlanAppearance = UiRecord & { day_number?: number | string; day_name?: string };
type UiExerciseExplanationPayload = { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
type ExerciseDetailRow = UiRecord & {
  found?: boolean;
  name?: string;
  muscle_group?: string;
  mode?: string;
  unit?: string;
  recent?: ExerciseSetRow[];
  progress?: { points?: ExerciseProgressPoint[] };
  appears?: ExercisePlanAppearance[];
  constraint_note?: string;
  cues?: string;
};
type UiFoodIngredientRow = UiRecord & {
  item?: string;
  amount?: string;
};
type UiFoodParsedNote = UiRecord & {
  summary?: string;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
  notes?: string;
};
type UiFoodNoteRow = UiRecord & {
  id?: string | number;
  raw?: string;
  raw_text?: string;
  raw_output?: string;
  created_at?: string;
};
type PollEnrichmentOptions<T extends UiRecord = UiRecord> = {
  tab?: ClientTabName | string;
  token?: number;
  onUpdate?: (row: T) => void;
  tries?: number;
  interval?: number;
};
type XtermConstructor = new (options: UiRecord) => {
  open(el: Element): void;
  write(text: string | Uint8Array): void;
  dispose(): void;
  onData?(handler: (data: string) => void): void;
  onResize?(handler: (size: { cols: number; rows: number }) => void): void;
  focus?(): void;
  loadAddon?(addon: unknown): void;
  cols?: number;
  rows?: number;
};
type XtermFitAddonConstructor = new () => { fit(): void };

function uiRecord(value: unknown): UiRecord {
  return value && typeof value === "object" ? value as UiRecord : {};
}

function uiRows<T extends UiRecord = UiRecord>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row): row is T => !!row && typeof row === "object") : [];
}

function uiString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function uiNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- header date control (Today) ----------
// On the Today tab the big header title IS the date control — change the date to
// review OR log a past workout. A REAL full-size (transparent) date input overlays
// the title, so a genuine tap opens the native picker on every browser (the old
// showPicker()-over-a-1px-hidden-input failed silently where showPicker throws).
// Other tabs set headerTitle via textContent, which removes this input automatically.
function setTodayHeaderTitle() {
  headerTitle.innerHTML =
    `${escHtml(dateLabel(state.logDate))}<span class="hdr-chev" aria-hidden="true">▾</span>` +
    `<input type="date" class="hdr-datepick" aria-label="Choose a date to view or log a past workout">`;
  headerTitle.classList.add("hdr-tappable");
  const inp = headerTitle.querySelector<HTMLInputElement>(".hdr-datepick");
  if (!inp) return;
  inp.value = state.logDate || localISO();
  inp.max = localISO();
  // Desktop: a click on a date input only focuses it (the calendar indicator is
  // hidden by appearance:none) — showPicker opens the calendar. Mobile taps open
  // the native picker on their own. Either way the change handler reloads Today.
  inp.addEventListener("click", () => { try { inp.showPicker?.(); } catch { /* unsupported → native focus */ } });
  inp.addEventListener("change", () => {
    if (!inp.value) return;
    state.logDate = inp.value;
    state.day = null;
    state.dayPicked = false;
    if (typeof syncRouteFromState === "function") syncRouteFromState();
    renderToday();
  });
}
// On Today the header pins to the top so the date control is always reachable.
// At rest it's the full editorial header; once the page scrolls past a few px it
// condenses into a slim blurred band (CSS scoped to body[data-tab="today"]).
function updateHeaderCondense() {
  const on = state.tab === "today" && window.scrollY > 6;
  document.querySelector("header")?.classList.toggle("condensed", on);
}
window.addEventListener("scroll", updateHeaderCondense, { passive: true });

// toast(msg) — fire-and-forget pill. toast(msg, {action, onAction}) — actionable
// variant (e.g. UNDO) that lingers longer and accepts one tap.
let _toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: unknown, opts: ToastOptions = {}): void {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  if (_toastTimer) clearTimeout(_toastTimer);
  if (opts.action) {
    t.textContent = "";
    const span = document.createElement("span");
    span.textContent = String(msg);
    const btn = document.createElement("button");
    btn.className = "toast-act";
    btn.textContent = opts.action;
    btn.addEventListener("click", () => {
      if (_toastTimer) clearTimeout(_toastTimer);
      t.classList.remove("show", "toast-actionable");
      opts.onAction && opts.onAction();
    });
    t.append(span, btn);
    t.classList.add("toast-actionable");
  } else {
    t.textContent = String(msg);
    t.classList.remove("toast-actionable");
  }
  t.classList.add("show");
  _toastTimer = setTimeout(() => t.classList.remove("show", "toast-actionable"), opts.action ? 5000 : 1400);
}

// ---------- one destructive-confirm pattern: the two-tap armed × ----------
// Every delete in the app uses THIS: first tap arms the × into a "remove?" chip,
// a second tap (within ~3s, or until blur) confirms; otherwise it disarms. One
// idiom across Memory / Life / Family / Health docs / session-set edits — never a
// blocking dialog, never an immediate destructive click. `onConfirm` runs on the
// confirming tap; it owns the actual delete + any toast/UI update.
function armDelete(btn: Element | null | undefined, onConfirm: () => unknown, { label = "remove?" }: { label?: string } = {}): void {
  if (!btn) return;
  const target = btn as HTMLElement;
  if (target.dataset.armed) { onConfirm(); return; }
  if (!target.dataset.restGlyph) target.dataset.restGlyph = target.textContent || "×";
  target.dataset.armed = "1";
  target.classList.add("armed");
  target.textContent = label;
  const reset = () => {
    delete target.dataset.armed;
    target.classList.remove("armed");
    target.textContent = target.dataset.restGlyph || "×";
    clearTimeout(t);
  };
  const t = setTimeout(reset, 3000);
  target.addEventListener("blur", reset, { once: true });
}

// ---------- exercise detail (full-screen overlay, Morsel-style) ----------

// Wire every [data-guide] in scope + make the card's art tile tappable; both
// open the exercise detail with a shared-element zoom from the tile.
function wireGuides(scope?: ParentNode | null): void {
  (scope || view).querySelectorAll<HTMLElement>("[data-guide]").forEach((b) => {
    const btn = b as HTMLElement & UiWiredElement;
    if (btn._wired) return; btn._wired = true;
    const name = decodeURIComponent(String(b.dataset.guide || ""));
    const tileOf = () => b.closest(".ex, .prog-row")?.querySelector(".artile") || null;
    b.addEventListener("click", () => openExerciseModal(name, tileOf()));
    const tile = tileOf() as (HTMLElement & UiWiredElement) | null;
    if (tile && !tile._wired) {
      tile._wired = true;
      tile.style.cursor = "pointer";
      tile.addEventListener("click", () => openExerciseModal(name, tile));
    }
  });
}

function exerciseExplanation(d: ExerciseDetailRow | null | undefined): UiExerciseExplanationPayload {
  return CairnExerciseDetail.explanation(d);
}

function exerciseExplanationHtml(d: ExerciseDetailRow | null | undefined, explanation?: UiExerciseExplanationPayload | null): string {
  return CairnExerciseDetail.explanationHtml(d, explanation);
}

const exerciseExplainMisses = new Set<string>();

function validExerciseExplanationPayload(r: unknown): r is { explanation?: UiExerciseExplanationPayload | null; stale?: boolean } {
  return CairnExerciseDetail.validExplanationPayload(r as { ok?: unknown; explanation?: { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown } | null | undefined } | null | undefined);
}

function replaceExerciseExplanation(el: ParentNode, d: ExerciseDetailRow, explanation: UiExerciseExplanationPayload | null | undefined): void {
  const current = el.querySelector<HTMLElement>("[data-exercise-explain]");
  if (!current || current.dataset.exercise !== String(d?.name || "")) return;
  const wrap = document.createElement("template");
  wrap.innerHTML = exerciseExplanationHtml(d, explanation).trim();
  const next = wrap.content.firstElementChild;
  if (next) current.replaceWith(next);
}

async function hydrateExerciseExplanation(el: ParentNode, d: ExerciseDetailRow): Promise<void> {
  const key = String(d?.name || "");
  if (!key || exerciseExplainMisses.has(key)) return;
  try {
    const cached = await api("/exercise/" + encodeURIComponent(key) + "/explanation");
    if (validExerciseExplanationPayload(cached)) {
      replaceExerciseExplanation(el, d, cached.explanation);
      if (!cached.stale) return;
    }
  } catch {
    return;
  }
  try {
    const generated = await api("/exercise/" + encodeURIComponent(key) + "/explanation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "auto" }),
    });
    if (validExerciseExplanationPayload(generated)) {
      replaceExerciseExplanation(el, d, generated.explanation);
    } else {
      exerciseExplainMisses.add(key);
    }
  } catch {
    exerciseExplainMisses.add(key);
  }
}

async function openExerciseModal(nameInput: unknown, fromTile?: Element | null): Promise<void> {
  const name = String(nameInput || "");
  const d = uiRecord(await api("/exercise/" + encodeURIComponent(name))) as ExerciseDetailRow;
  const svg = art("exercise", name, d?.muscle_group);
  if (!d || !d.found) {
    openDetailFrom(fromTile, () => {
      mountDetail(`
        <div class="detail-art"><div class="detail-art-zoom">${artImg("exercise", name, "artile-xl", svg)}</div></div>
        <h2 class="detail-title">${escHtml(name)}</h2>
        <div class="empty">No data for this exercise yet.</div>
        <div class="detail-actions"><button class="pillbtn" data-close>Close</button></div>`);
      wireDetailCommon();
    });
    return;
  }

  const recent = uiRows<ExerciseSetRow>(d.recent);
  const timed = d.mode === "timed" || recent.some((r) => r.duration_sec != null);
  const pts = uiRows<ExerciseProgressPoint>(d.progress?.points);
  const latest = pts.slice(-1)[0];
  const hasPR = recent.some((r) => r.pr);

  // hero figure: est-1RM for reps work, best duration for timed
  let heroVal = 0, heroLbl = "", heroTxt = "";
  let sparkVals: unknown[] = [];
  if (timed) {
    const durs = recent.filter((r) => r.duration_sec != null).map((r) => uiNumber(r.duration_sec));
    const best = durs.length ? Math.max(...durs) : 0;
    heroVal = best; heroLbl = "best duration";
    heroTxt = fmtDur(best);
    sparkVals = durs.slice().reverse(); // recent[] is newest-first
  } else if (latest) {
    heroVal = uiNumber(latest.best1rm); heroLbl = `est 1RM · ${escHtml(d.unit || "lb")} · epley`;
    sparkVals = pts.map((p) => p.best1rm);
  }
  const appears = uiRows<ExercisePlanAppearance>(d.appears).map((a) => `D${a.day_number} ${escHtml(a.day_name)}`).join(" · ");
  const recentLines = recent.map((r) => {
    const fig = r.duration_sec != null ? fmtDur(r.duration_sec) : `${fmtWeight(r.weight)}×${r.reps}${r.rir != null ? ` @${r.rir}` : ""}`;
    return `<div class="detail-setline"><span>${escHtml(r.date || "")}</span><span class="numeral">${fig}${r.pr ? ` <span class="prbadge">PR</span>` : ""}</span></div>`;
  }).join("");

  openDetailFrom(fromTile, () => {
    const el = mountDetail(`
      <div class="detail-art"><div class="detail-art-zoom">${artImg("exercise", d.name || name, "artile-xl", svg)}</div></div>
      <h2 class="detail-title">${escHtml(d.name || name)}</h2>
      <div class="detail-ctx lbl">${escHtml(d.muscle_group || "exercise")}${hasPR ? ` <span class="prbadge">PR</span>` : ""}</div>
      ${heroVal ? `<div class="detail-kcal"><span class="numeral detail-num" ${timed ? "" : `data-cu="${heroVal}"`}>${timed ? heroTxt : "0"}</span><span class="detail-unit lbl">${heroLbl}</span></div>` : ""}
      ${sparkVals.length > 1 ? `<div class="detail-spark">${sparklineSvg(sparkVals)}</div>` : ""}
      ${d.constraint_note ? `<div class="ex-flag">${escHtml(d.constraint_note)}</div>` : ""}
      ${exerciseExplanationHtml(d)}
      ${d.cues ? `<div class="detail-section"><div class="lbl">Form cues</div><div class="detail-body">${escHtml(d.cues)}</div></div>` : ""}
      ${appears ? `<div class="detail-section"><div class="lbl">In your plan</div><div class="detail-body">${appears}</div></div>` : ""}
      <div class="detail-section"><div class="lbl">Recent sets</div>
        ${recentLines || `<div class="detail-body" style="color:var(--muted)">None logged yet.</div>`}</div>
      <div class="detail-section detail-manage">
        <div class="lbl">This exercise</div>
        <div class="manage-row">
          <button class="pillbtn pill-sm" id="exType">Make ${timed ? "reps-based" : "timed (hold)"}</button>
          <button class="pillbtn pill-sm pill-warn" id="exDelete">Delete</button>
        </div>
      </div>
      <div class="detail-actions">
        <button class="pillbtn" id="askForm">Ask coach</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`);
    runCountUps(el);
    wireDetailCommon();
    hydrateExerciseExplanation(el, d);
    const ask = el.querySelector("#askForm");
    if (ask) ask.addEventListener("click", () => {
      closeDetail(true);
      gotoChatWith(`How should I perform ${name} with good form? Flag anything for my injury constraints.`);
    });
    // Change an exercise's type (reps ⇄ timed) — upsert-by-name updates the mode.
    const typeBtn = el.querySelector<HTMLButtonElement>("#exType");
    if (typeBtn) typeBtn.addEventListener("click", async () => {
      typeBtn.disabled = true;
      const next = timed ? "reps" : "timed";
      try {
        await postExerciseMode(String(d.name || name), next);
        if (state.exModes) state.exModes[String(d.name || name)] = next;
        toast(`${d.name || name} is now ${next === "timed" ? "timed (hold)" : "reps-based"}`);
        closeDetail(true);
        if (state.tab === "today") renderToday();
      } catch { typeBtn.disabled = false; toast("Couldn't change type — try again"); }
    });
    // Delete an exercise — refuses (with a reason) if it has logged sets or is in a plan.
    const delBtn = el.querySelector<HTMLButtonElement>("#exDelete");
    if (delBtn) delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      let r: UiRecord;
      try { r = uiRecord(await api("/exercises/" + encodeURIComponent(String(d.name || name)), { method: "DELETE" })); }
      catch { delBtn.disabled = false; toast("Couldn't delete — try again"); return; }
      if (r && r.ok) {
        toast(`Deleted ${d.name || name}`);
        closeDetail(true);
        if (state.tab === "today") renderToday();
      } else {
        delBtn.disabled = false;
        toast(r && r.error ? `Can't delete ${d.name || name}. ${r.error}` : "Couldn't delete");
      }
    });
  });
}

// shared detail wiring: zoomable art + close pills + parallax drift on scroll
function wireDetailCommon() {
  const el = document.querySelector(".detail");
  if (!el) return;
  wireArtZoom(el.querySelector(".detail-art"));
  el.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeDetail()));
  const scroller = el.querySelector<HTMLElement>(".detail-scroll");
  const artEl = el.querySelector<HTMLElement>(".detail-art");
  if (scroller && artEl && !reducedMotion()) {
    scroller.addEventListener("scroll", () => {
      artEl.style.translate = `0 ${Math.min(40, scroller.scrollTop * 0.35)}px`;
      artEl.style.opacity = String(Math.max(0.25, 1 - scroller.scrollTop / 420));
    }, { passive: true });
  }
}

// ---------- food-note detail (tap a note → full-screen) ----------
async function openFoodDetail(note: unknown, fromTile?: Element | null): Promise<void> {
  const n = uiRecord(note) as UiFoodNoteRow;
  const pj = CairnFoodNote.parsedNote(n) as UiFoodParsedNote | null;
  const text = n.raw || n.raw_text || n.raw_output || "";
  const title = (pj && pj.summary) || CairnFoodNote.foodTitleFromIngredients(pj) || text || "Food note";
  const kcal = foodNum(pj?.kcal) || 0;
  const macros = pj ? [["Protein", pj.protein_g], ["Carbs", pj.carbs_g], ["Fat", pj.fat_g], ["Fiber", pj.fiber_g]]
    .filter(([, v]) => v != null && v !== "" && !Number.isNaN(Number(v))) : [];
  const maxG = Math.max(1, ...macros.map(([, v]) => Number(v)));
  const ingredients = CairnFoodNote.foodIngredients(pj) as UiFoodIngredientRow[];
  const items = ingredients.length ? ingredients.map((ing) => CairnFoodNote.ingredientLabel(ing)).join(", ") : CairnFoodNote.foodItemsText(pj);
  const time = uiString(n.created_at).slice(11, 16);

  // share of the day's lean-safe target, when we know both numbers
  if (kcal && !state._goal) { try { state._goal = await api("/goal"); } catch { state._goal = null; } }
  const target = uiNumber(uiRecord(state._goal?.recommended).target_intake_kcal);
  const ctxBits: string[] = [];
  if (kcal && target) ctxBits.push(`${Math.round((kcal / target) * 100)}% of the day`);
  if (time) ctxBits.push(time);

  const q = String(text || title || "Food note");
  const svg = art("food", q);
  const photoSrc = artEnabled && q ? withToken(`/api/art?kind=food&q=${encodeURIComponent(String(q).trim().slice(0, 120))}`) : "";

  openDetailFrom(fromTile, () => {
    const el = mountDetail(`
      <div class="detail-art"><div class="detail-art-zoom">${artImg("food", q, "artile-xl", svg)}</div></div>
      <h2 class="detail-title">${escHtml(title)}</h2>
      ${items ? `<div class="detail-items">${escHtml(items)}</div>` : ""}
      ${kcal ? `<div class="detail-kcal"><span class="numeral detail-num" data-cu="${kcal}">0</span><span class="detail-unit lbl">cal</span></div>` : ""}
      ${ctxBits.length ? `<div class="detail-ctx lbl">${escHtml(ctxBits.join(" · "))}</div>` : ""}
      ${macros.length ? `<div class="detail-macros">${macros.map(([l, v]) => `
        <div class="macrobar">
          <div class="macrobar-top"><span class="lbl">${l}</span><span class="macrobar-val">${escHtml(formatFoodNum(v))}g</span></div>
          <div class="macrobar-track"><div class="macrobar-fill barfill" style="width:${Math.max(3, Math.round((Number(v) / maxG) * 100))}%"></div></div>
        </div>`).join("")}</div>` : ""}
      ${ingredients.length ? `<div class="detail-section"><div class="lbl">Ingredients</div><div class="ing-breakdown">${ingredients.map((ing) => `
        <div class="ing-row">
          <div class="ing-main">
            <span>${escHtml(ing.item)}</span>
            ${ing.amount ? `<small>${escHtml(ing.amount)}</small>` : ""}
          </div>
          <div class="ing-nutri">${escHtml(CairnFoodNote.foodMacroText(ing, { kcal: true, short: true }) || "estimated")}</div>
        </div>`).join("")}</div></div>` : ""}
      ${text && text !== title ? `<div class="detail-section"><div class="lbl">As logged</div><div class="detail-body">“${escHtml(text)}”</div></div>` : ""}
      ${pj?.notes ? `<div class="detail-section"><div class="detail-body" style="color:var(--muted)">${escHtml(pj.notes)}</div></div>` : ""}
      <div class="detail-actions">
        <button class="pillbtn pill-warn" data-remove>Remove</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`, photoSrc);
    runCountUps(el);
    wireDetailCommon();
    const rm = el.querySelector("[data-remove]");
    if (rm) rm.addEventListener("click", async () => {
      try {
        const r = uiRecord(await api(`/food-notes/${n.id}`, { method: "DELETE" }));
        if (r && r.error) throw new Error(String(r.error));
        toast("Removed");
        closeDetail(true);
        document.querySelector(`.fnent[data-noteid="${n.id}"]`)?.remove();
      } catch { toast("Couldn't remove"); }
    });
  });
}
function gotoChatWith(text: string): void {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  const t = document.querySelector('.tab[data-tab="chat"]');
  if (t) t.classList.add("active");
  state.tab = "chat";
  document.body.dataset.tab = "chat"; // keep the header's Today-scoped styling off
  if (typeof syncRouteFromState === "function") syncRouteFromState();
  Promise.resolve(renderChat()).then(() => {
    const i = $<HTMLTextAreaElement>("#chatInput");
    if (i) { i.value = text; autosizeChatInput(i); i.focus(); }
  });
}

// segmented sub-nav: items = [[key,label]]; handlers = {key: renderFn}
// Emits a sliding ink thumb (.seg-thumb) behind the active button; sub-view swaps
// go through a view transition so the thumb glides between renders. Wrapped in a
// sticky .segwrap band so the sub-nav stays pinned to the top while you scroll a
// long sub-view — one tap back to another section, never lost from focus.
function segBar(active: unknown, items: ReadonlyArray<UiSegment>): string {
  return CairnUi.segmentedNavHtml({ active, items });
}
function wireSeg(handlers: Record<string, () => unknown>) {
  view.querySelectorAll<HTMLElement>(".segbtn").forEach((b, _i) =>
    b.addEventListener("click", () => {
      const f = handlers[String(b.dataset.seg || "")]; if (!f) return;
      // slide the thumb immediately, then swap the sub-view inside a transition
      const seg = b.closest(".seg");
      if (seg) {
        const idx = [...seg.querySelectorAll<HTMLElement>(".segbtn")].indexOf(b);
        (seg as HTMLElement).style.setProperty("--segi", String(idx));
      }
      withViewTransition(() => Promise.resolve(f()).then(viewEnter));
      if (typeof syncRouteFromState === "function") syncRouteFromState();
    })
  );
  view.querySelectorAll(".seg").forEach(fitSeg);
}

// Pill / segment bars stay on ONE line and SCROLL when they don't fit, rather than
// clipping the last pill (e.g. "Calendar" on a narrow phone). Measure with
// content-width pills (the .seg-scroll layout); if that overflows, keep scroll mode
// — the sliding ink thumb assumes equal-width segments, so it yields to the solid
// active-pill background — and center the active pill. Otherwise drop back to the
// equal-width thumb. Adapts per-bar and per-viewport; no fixed breakpoint.
function fitSeg(seg: Element | null | undefined): void {
  if (!seg) return;
  const el = seg as HTMLElement;
  el.classList.add("seg-scroll");
  const overflow = el.scrollWidth > el.clientWidth + 1;
  seg.classList.toggle("seg-scroll", overflow);
  if (overflow) {
    const active = el.querySelector<HTMLElement>(".segbtn.active");
    if (active) el.scrollLeft = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
  }
}
let _segFitRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(_segFitRaf);
  _segFitRaf = requestAnimationFrame(() => view.querySelectorAll(".seg").forEach(fitSeg));
});
const PROGRESS_SEG: readonly UiSegment[] = [["sessions", "History"], ["trend", "1RM"], ["volume", "Volume"], ["endurance", "Endurance"], ["weight", "Weight"], ["calendar", "Calendar"], ["program", "Program"], ["energy", "Energy"]];
const PROGRESS_HANDLERS: Record<string, () => unknown> = { trend: () => renderProgress(), volume: () => renderVolume(), endurance: () => renderEndurance(), weight: () => renderWeight(), calendar: () => renderCalendar(), sessions: () => renderHistory(), program: () => renderProgram(), energy: () => renderEnergy() };
// The Plan sub-nav is dynamic: a runner/hybrid (or anyone with an endurance goal)
// gets a dedicated ENDURANCE tab — the home for the periodized ramp, this week's
// prescribed runs, and shaping the running plan. A pure strength athlete with no
// running goal never sees it (calm, no empty surface).
function planSeg(): readonly UiSegment[] {
  const routedToEndurance = state.planSeg === "endurance" || state.planJump === "endurance";
  return showEnduranceTab() || routedToEndurance
    ? [["edit", "Training"], ["endurance", "Endurance"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]]
    : [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]];
}
const PLAN_HANDLERS: Record<string, () => unknown> = { edit: () => renderPlanEditor(), endurance: () => renderPlanEndurance(), food: () => renderFoodJournal(), meals: () => renderMeals(), coach: () => renderCoach() };

// CairnArt (public/art.js) returns trusted static SVG strings — never user text — so its
// output is inserted raw. Guarded so a missing/stale art.js can't crash a render.
const art = (fn: string, ...a: unknown[]): string => {
  try {
    const cairnArt = (window as unknown as { CairnArt?: Record<string, ((...args: unknown[]) => string) | undefined> }).CairnArt;
    return cairnArt?.[fn]?.(...a) || "";
  } catch { return ""; }
};
// staggered entrance delay for `.reveal` cards; index capped so long lists don't crawl in
const stagger = (i?: number | null): string => `--i:${Math.min(i ?? 0, 12)}`;

// ---------- motion utilities ----------
const reducedMotion = (): boolean => "matchMedia" in window && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Subtle fade+rise re-triggered whenever #view's content is swapped wholesale
// (tab switches + segmented sub-view swaps). No-op under reduced motion.
function viewEnter(): void {
  if (reducedMotion()) return;
  view.classList.remove("view-in");
  void view.offsetWidth; // force reflow so the animation restarts
  view.classList.add("view-in");
}

// Soft fade for the skeleton→content swap: replace the busy skeleton with real
// content inside a view transition so the skeleton crossfades out as the content
// fades in, instead of a hard pop. Falls back to an instant swap when view
// transitions aren't supported or under reduced motion — exactly today's behavior.
// `fn` performs the actual `view.innerHTML = …` swap. When this render is ALREADY
// running inside a transition (a seg-tap wraps the handler in one, and finishes with
// viewEnter()), we DON'T nest a second one — stacking startViewTransition() aborts the
// outer and flickers. We just swap and let the surrounding fade carry it.
function skelSwap(fn: () => unknown): Promise<unknown> {
  if (_vtActive) { return Promise.resolve(fn()); }
  return withViewTransition(fn);
}

// Run a DOM-swapping fn inside a shared-element view transition when supported.
// `_vtActive` guards against accidentally nesting a transition inside another
// (which the browser would resolve by aborting the outer one).
let _vtActive = false;
function isViewTransitionAbort(err: unknown): boolean {
  const row = err instanceof Error ? { name: err.name, message: err.message } : uiRecord(err);
  const name = String(row.name || "");
  const msg = String(row.message || err || "");
  return name === "AbortError" || (name === "InvalidStateError" && /transition/i.test(msg));
}
function withViewTransition(fn: () => unknown): Promise<unknown> {
  const run = () => {
    try { return Promise.resolve(fn()); }
    catch (err) { return Promise.reject(err); }
  };
  const quietTransitionPromise = (promise: Promise<unknown>) => Promise.resolve(promise).catch((err) => {
    if (!isViewTransitionAbort(err)) throw err;
  });
  const quietSecondaryTransitionPromise = (promise: Promise<unknown>) => Promise.resolve(promise).catch((err) => {
    if (!isViewTransitionAbort(err)) setTimeout(() => { throw err; }, 0);
  });
  if (document.startViewTransition && !reducedMotion() && !_vtActive) {
    try {
      _vtActive = true;
      const tx = document.startViewTransition(run);
      const done = tx.updateCallbackDone || tx.finished || Promise.resolve();
      if (tx.ready) quietSecondaryTransitionPromise(tx.ready);
      if (tx.finished && tx.finished !== done) quietSecondaryTransitionPromise(tx.finished);
      return quietTransitionPromise(done)
        .finally(() => { _vtActive = false; });
    } catch { _vtActive = false; /* fall through */ }
  }
  return Promise.resolve(run());
}

// Put a button into a calm "working" state for the length of an agentic call:
// swap its label for a quiet ring + working text, disable it, and pin the current
// width so the footprint never jumps. Returns restore() — call it in `finally`.
// `label` defaults to the button's current text; `ghost` uses a light ring (for
// dark/accent buttons). Safe on a null button.
function btnBusy(btn: HTMLButtonElement | null | undefined, label?: unknown, { ghost = false }: { ghost?: boolean } = {}): () => void {
  if (!btn) return () => {};
  const busyBtn = btn as BusyButton;
  if (busyBtn._busyRestore) return busyBtn._busyRestore; // already working — don't stack
  const html = btn.innerHTML;
  const wasDisabled = btn.disabled;
  const minW = btn.style.minWidth;
  const text = label != null ? label : (btn.textContent || "").trim();
  btn.style.minWidth = btn.offsetWidth + "px"; // freeze footprint before swap
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.classList.add("btn-busy");
  btn.innerHTML = `<span class="btn-working"><span class="aspin aspin-sm${ghost ? " aspin-ghost" : ""}"></span>${escHtml(text)}</span>`;
  const restore = () => {
    if (busyBtn._busyRestore !== restore) return;
    busyBtn._busyRestore = null;
    btn.innerHTML = html;
    btn.disabled = wasDisabled;
    btn.removeAttribute("aria-busy");
    btn.classList.remove("btn-busy");
    btn.style.minWidth = minW;
  };
  busyBtn._busyRestore = restore;
  return restore;
}

// Count a numeral up from 0 → target. Respects prefers-reduced-motion (snaps).
function countUp(el: Element | null | undefined, target: unknown, { dur = 750, fmt = (v: number) => Math.round(v).toLocaleString() }: { dur?: number; fmt?: (value: number) => string } = {}): void {
  if (!el) return;
  const t = Number(target) || 0;
  if (reducedMotion() || !t) { el.textContent = fmt(t); return; }
  const t0 = performance.now();
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - p) ** 3; // settle, don't snap
    el.textContent = fmt(t * eased);
    if (p < 1 && el.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Full-area working state: the house .aspin ring + an italic label, centered in
// a region that's fetching/thinking (chat log hydrating, history overlay). The
// inline button-busy / typing-dots / filament cases live in btnBusy + the
// .aspin/.typing/.is-thinking CSS — see docs/DESIGN.md › Loading & progress.
function loadingState(label: unknown): string {
  return CairnUi.loadingStateHtml({ label });
}

// Curated, op-specific "an agent is thinking" scripts — calm, Atelier-voiced, a
// few lines each so a long wait reads as quiet motion rather than a frozen line.
// thinkingCaption() crossfades through these (~2.6s/line) and loops the tail.
const THINKING_SCRIPTS: Record<string, string[]> = {
  session_suggest: ["Reading your week…", "Weighing recovery…", "Shaping today's session…", "Choosing the right load…"],
  proposal: ["Reading your training…", "Weighing your recent sessions…", "Drafting next week's targets…", "Keeping the progression honest…"],
  endurance_runs: ["Reading your running…", "Checking your mileage and goal…", "Shaping this week's runs…", "Keeping it aerobic and conservative…"],
  meal_plan: ["Reading your week…", "Balancing the macros…", "Plating the days…", "Checking the protein floor…"],
  meal_swap: ["Reading the meal…", "Finding a match…", "Holding the macros…", "Plating the swap…"],
  recipe: ["Opening the kitchen…", "Sourcing the ingredients…", "Writing the steps…", "Tasting as it goes…"],
  nutrition_checkin: ["Reading your intake…", "Tracing the trend…", "Weighing the drift…", "Settling on a number…"],
  day_read_override: ["Hearing you…", "Re-reading the day…", "Reshaping the brief…"],
  chat_distill: ["Looking back over the thread…", "Keeping what matters…", "Tidying the rest away…"],
  onboard: ["Hearing you out…", "Folding it into your picture…", "Noting what matters…", "Setting things up…"],
  insight: ["Connecting the dots…", "Crossing the domains…", "Listening for one real thread…"],
};

// Rotate an op's script through `el` with a gentle crossfade (reusing the chat
// `.typing-cap` / capfade vocabulary), ~2.6s a line, looping the tail. Under
// reduced motion it shows line 1 statically. Returns stop() — call it when the
// op settles. Safe on a null element / unknown op (falls back to a calm line).
function thinkingCaption(el: HTMLElement | null | undefined, op: unknown): () => void {
  if (!el) return () => {};
  const lines = THINKING_SCRIPTS[String(op)] || ["Thinking…"];
  const paint = (txt: string) => {
    el.textContent = txt;
    if (!reducedMotion()) { el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; }
  };
  el.classList.add("typing-cap");
  paint(lines[0]);
  if (reducedMotion() || lines.length < 2) return () => {};
  let i = 0;
  const timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(timer); return; }
    i = i + 1 >= lines.length ? Math.max(1, lines.length - 2) : i + 1; // loop the tail, never restart at the intro
    paint(lines[i]);
  }, 2600);
  return () => clearInterval(timer);
}

// Calm fallback when a tab's (possibly agentic) render rejects — e.g. a network
// blip during a skeleton-first paint. Replaces the stranded shimmer with a quiet
// retry instead of freezing on the skeleton. No nag, just an option.
function tabErrorState(tab: unknown): void {
  view.innerHTML = `<div class="loadstate" role="alert">
    <div class="loadstate-label">Couldn't load this view — check your connection.</div>
    <button class="ghostbtn" data-tabretry style="margin-top:10px">Try again</button>
  </div>`;
  const btn = view.querySelector("[data-tabretry]");
  if (btn) btn.addEventListener("click", () => switchTab(tab));
}

// Skeleton-first paint helpers — reuse the .hshimmer shimmer primitive so every
// tab paints its shape instantly, then hydrates. Never invent a one-off spinner;
// these mirror the loading vocabulary in docs/DESIGN.md. `aria-hidden` because the
// real content carries its own labels once it lands.
function skelLines(n = 3): string {
  let s = `<div class="skel-card" aria-hidden="true"><div class="hshimmer hshimmer-lg"></div>`;
  for (let i = 0; i < n; i++) s += `<div class="hshimmer${i === n - 1 ? " hshimmer-sm" : ""}"></div>`;
  return s + `</div>`;
}
// Today: a Brief-shaped block + a couple of card silhouettes.
function todaySkeleton(): string {
  return `<div class="today-wrap today-skel" aria-busy="true">
    <div class="skel-brief" aria-hidden="true">
      <div class="hshimmer hshimmer-sm" style="width:34%"></div>
      <div class="hshimmer hshimmer-lg" style="width:64%;height:26px"></div>
      <div class="hshimmer"></div>
    </div>
    ${skelLines(2)}
    ${skelLines(3)}
  </div>`;
}
// A seg-bar tab (Progress / Plan / Me sub-views) — paint the REAL segmented
// control synchronously (it's constant, no await) so the thumb sits where the
// user tapped, then a hero + a couple of card silhouettes shimmer below until the
// data lands. The seg is already wired by the real render that follows.
function segSkeleton(active: string, seg: readonly UiSegment[], cards = 2): string {
  let s = segBar(active, seg) + `<div class="skel-region" aria-busy="true">${skelLines(2)}`;
  for (let i = 0; i < cards; i++) s += skelLines(3);
  return s + `</div>`;
}

// humanized big numbers: 12450 → "12.4k"
const fmtK = (n: unknown): string => {
  const v = Number(n) || 0;
  return v >= 10000 ? `${Math.round(v / 100) / 10}k` : Math.round(v).toLocaleString();
};

// Run count-ups for every [data-cu] numeral in scope (data-cufmt="k" → humanized).
// `snap:true` writes the final value with no animation — used when a warm SWR
// re-render replaces already-shown numerals, so they don't re-count from zero.
function runCountUps(scope?: ParentNode | null, { snap = false }: { snap?: boolean } = {}): void {
  (scope || view).querySelectorAll<HTMLElement>("[data-cu]").forEach((el) => {
    const fmt = el.dataset.cufmt === "k" ? fmtK : (x: number) => Math.round(x).toLocaleString();
    if (snap) { el.textContent = fmt(Number(el.dataset.cu) || 0); return; }
    countUp(el, Number(el.dataset.cu) || 0, { fmt });
  });
}

// ---------- progressive artwork (CairnArt SVG → generated photo) ----------
// Server contract: GET /api/art?kind=&q= → 200 image/* when cached, 204 when not ready
// (the 204 itself kicks off background generation; an <img> treats 204 as an error).
let artEnabled: boolean = true; // refreshed from /settings at boot + on Settings save
Object.defineProperty(globalThis, "artEnabled", {
  configurable: true,
  get: () => artEnabled,
  set: (value) => { artEnabled = !!value; },
});

// Primary training discipline ('strength'|'endurance'|'hybrid'), read once from the
// profile and used for a GENTLE emphasis reframe — never to hide a surface. Default
// 'strength' so a profile that never set it behaves exactly as before. Refreshed by
// the profile loader (renderToday/renderMeProfile) and on a profile save.
let primaryDiscipline: string = "strength";
Object.defineProperty(globalThis, "primaryDiscipline", {
  configurable: true,
  get: () => primaryDiscipline,
  set: (value) => { primaryDiscipline = String(value || "strength"); },
});
function setDiscipline(d: unknown): string {
  primaryDiscipline = d === "endurance" || d === "hybrid" ? d : "strength";
  return primaryDiscipline;
}
const isEndurance = (): boolean => primaryDiscipline === "endurance";
const isHybrid = (): boolean => primaryDiscipline === "hybrid";

// Whether the athlete has an endurance OBJECTIVE on file (a race or a standing
// readiness target). Primed from the profile alongside the discipline (warm-load +
// on save). Used to surface the Plan → Endurance tab even when the discipline label
// is 'strength' — setting a running goal is a clear signal you want a running plan.
let enduranceGoalSet: boolean = false;
Object.defineProperty(globalThis, "enduranceGoalSet", {
  configurable: true,
  get: () => enduranceGoalSet,
  set: (value) => { enduranceGoalSet = !!value; },
});
function setEnduranceGoalSet(present: unknown): boolean { enduranceGoalSet = !!present; return enduranceGoalSet; }
// A runner home is warranted when the athlete trains endurance OR has set a goal.
const showEnduranceTab = (): boolean => isEndurance() || isHybrid() || enduranceGoalSet;

// ---------- art readiness (instant, flash-free rendering of generated images) ----------
// Generated art is content-keyed + immutable on the server, so once we know an
// image exists we can render it IMMEDIATELY — eager, no fade, photo straight over
// the SVG — instead of starting from the wire placeholder every render. We track
// which "kind|query" tokens are ready in `artReady`, hydrated from three sources:
//   • localStorage  — every image this client has ever loaded (instant, at module load)
//   • /api/art/manifest — what the server already has on disk (covers a cold client)
//   • a live onload — anything generated after the page opened
// Keyed token-free (no auth token / retry param) so it survives token rotation.
const artReady = new Set<string>();
const artKey = (kind: unknown, q: unknown): string => `${kind}|${String(q || "").trim().slice(0, 120)}`;
const ART_READY_LS = "cairn-art-ready";
let _artReadyTimer: ReturnType<typeof setTimeout> | number = 0;
function persistArtReady(): void {
  clearTimeout(_artReadyTimer);
  _artReadyTimer = setTimeout(() => {
    // Cap so it can't grow unbounded; keep the most recently-added tokens.
    try { localStorage.setItem(ART_READY_LS, JSON.stringify([...artReady].slice(-3000))); } catch {}
  }, 600);
}
function markArtReady(token: unknown): void {
  const key = typeof token === "string" ? token : "";
  if (key && !artReady.has(key)) { artReady.add(key); persistArtReady(); }
}
(function loadArtReady() {
  try {
    const stored = JSON.parse(localStorage.getItem(ART_READY_LS) || "[]");
    if (Array.isArray(stored)) stored.forEach((k: unknown) => { if (typeof k === "string") artReady.add(k); });
  } catch {}
})();
// Prime from the server's on-disk manifest — makes a cold client (cleared cache,
// new browser) render already-generated art instantly instead of re-flashing the
// wire on its first paint. Fire-and-forget at boot; failures are silent.
async function primeArtManifest(): Promise<void> {
  try {
    const m = uiRecord(await api("/art/manifest"));
    if (m && "enabled" in m) artEnabled = !!m.enabled;
    if (m && Array.isArray(m.ready) && m.ready.length) {
      m.ready.forEach((k: unknown) => { if (typeof k === "string") artReady.add(k); });
      persistArtReady();
    }
  } catch {}
}

function artPhotoLoaded(img: HTMLImageElement): void {
  img.classList.add("on");
  markArtReady(img.dataset.artkey); // remember for instant render next time
}
function artPhotoFailed(img: HTMLImageElement): void {
  // Drop BOTH reveal classes — `.instant` also forces opacity:1, so leaving it on
  // would keep a failed image visible instead of falling back to the SVG beneath.
  img.classList.remove("on", "instant");
  // A token we promised was ready didn't load (server cache cleared, file gone) —
  // forget it so we stop rendering it eager and fall back to the SVG cleanly.
  const k = img.dataset.artkey;
  if (k && artReady.has(k)) { artReady.delete(k); persistArtReady(); }
  if (img.dataset.retried) return; // one quiet retry only
  img.dataset.retried = "1";
  const token = pollToken;
  setTimeout(() => {
    if (token !== pollToken || !img.isConnected) return; // stale tab / re-render — bail
    img.src = img.src.includes("&r=") ? img.src : img.src + "&r=1";
  }, 20000);
}

document.addEventListener("load", (e) => {
  const img = e.target instanceof HTMLImageElement ? e.target : null;
  if (img && img.dataset.artPhoto === "1") artPhotoLoaded(img);
}, true);
document.addEventListener("error", (e) => {
  const img = e.target instanceof HTMLImageElement ? e.target : null;
  if (!img) return;
  if (img.dataset.artPhoto === "1") { artPhotoFailed(img); return; }
  if (img.dataset.removeOnError === "1") img.remove();
}, true);

// Art tile that renders the generated studio photo over a CairnArt SVG. `svg` may
// be passed (exercise art needs muscleGroup); defaults to art(kind, q). Falls back
// to SVG-only when artwork generation is off.
//   • Known-ready (cache/manifest/seen) → eager, no fade — the photo is served
//     instantly from the SW/HTTP cache, so it paints over the SVG with no flash.
//   • Unknown → lazy, fades in on first load, then remembered for next time.
function artImg(kind: string, q: unknown, cls = "artile-md", svg: string | null = null): string {
  const s = svg != null ? svg : art(kind, q);
  if (!s) return "";
  const query = String(q || "").trim().slice(0, 120);
  if (!artEnabled || !query) return `<div class="artile ${cls}">${s}</div>`;
  const token = artKey(kind, query);
  const src = withToken(`/api/art?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}`);
  const ready = artReady.has(token);
  const imgCls = ready ? "artimg-photo on instant" : "artimg-photo";
  const load = ready ? "eager" : "lazy";
  return `<div class="artile artimg ${cls}">${s}<img class="${imgCls}" alt="${escAttr(query)}" loading="${load}" decoding="async" data-art-photo="1" data-artkey="${escAttr(token)}" src="${escAttr(src)}"></div>`;
}

// tiny inline sparkline (numbers only — safe for innerHTML)
function sparklineSvg(vals: unknown, w = 132, h = 30): string {
  const v = (Array.isArray(vals) ? vals : []).map(Number).filter((x: number) => !Number.isNaN(x));
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v);
  const x = (i: number) => 2 + (i * (w - 4)) / (v.length - 1);
  const y = (n: number) => max === min ? h / 2 : h - 3 - ((n - min) / (max - min)) * (h - 6);
  const pts = v.map((n: number, i: number) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  const last = v[v.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="currentColor"/>
    </svg>`;
}

// ---------- full-screen detail overlay (Morsel-style) ----------
let _detailOrigin: HTMLElement | null = null; // the tapped tile, for the reverse shared-element zoom
function closeDetail(instant?: boolean): void {
  const d = document.querySelector<HTMLElement>(".detail");
  if (!d) return;
  const origin = _detailOrigin;
  _detailOrigin = null;
  if (instant || !document.startViewTransition || reducedMotion()) {
    if (origin && origin.isConnected) origin.style.viewTransitionName = "";
    d.remove();
    return;
  }
  // old state: overlay art carries the name; new state: the originating tile does —
  // the photo glides back into its list tile, then the name is released.
  withViewTransition(() => {
    d.remove();
    if (origin && origin.isConnected) {
      origin.style.viewTransitionName = "detail-art";
      setTimeout(() => { origin.style.viewTransitionName = ""; }, 450);
    }
  });
}

// Open a detail overlay with a shared-element zoom from `tile` (an .artile in the list).
function openDetailFrom(tile: Element | null | undefined, build: () => unknown): void {
  closeDetail(true);
  const origin = tile instanceof HTMLElement ? tile : null;
  _detailOrigin = origin;
  if (origin && document.startViewTransition && !reducedMotion()) {
    origin.style.viewTransitionName = "detail-art";
    try {
      const t = document.startViewTransition(() => { origin.style.viewTransitionName = ""; build(); });
      t.finished.catch(() => {});
      return;
    } catch { origin.style.viewTransitionName = ""; }
  }
  build();
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".sheet")) { closeMealSheet(); return; }
  closeDetail();
});

// Mount the overlay scaffold; returns the .detail element. Caller fills .detail-scroll.
function mountDetail(inner: string, photoSrc?: string | null): HTMLElement {
  const d = document.createElement("div");
  d.className = "detail";
  d.innerHTML = `<div class="detail-bg">${photoSrc ? `<img alt="" src="${escAttr(photoSrc)}" data-remove-on-error="1">` : ""}</div>
    <button class="detail-x" aria-label="Close">✕</button>
    <div class="detail-scroll">${inner}</div>`;
  document.body.appendChild(d);
  d.querySelector(".detail-x")?.addEventListener("click", () => closeDetail());
  d.addEventListener("click", (e) => { if (e.target === d) closeDetail(); });
  return d;
}

// "Lean in": wheel / pinch zoom on the detail art, CSS transform clamped 1–2.2.
function wireArtZoom(artEl: Element | null | undefined): void {
  if (!artEl) return;
  const host = artEl as HTMLElement;
  const inner = (host.firstElementChild || host) as HTMLElement;
  let scale = 1;
  const apply = () => { inner.style.transform = `scale(${scale})`; };
  host.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault();
    scale = Math.min(2.2, Math.max(1, scale - e.deltaY * 0.0028));
    apply();
  }, { passive: false });
  const touches = new Map<number, { x: number; y: number }>();
  let pinchBase = 0, pinchScale = 1;
  const dist = () => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  host.addEventListener("pointerdown", (e: PointerEvent) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) { pinchBase = dist(); pinchScale = scale; }
  });
  host.addEventListener("pointermove", (e: PointerEvent) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinchBase > 0) {
      scale = Math.min(2.2, Math.max(1, pinchScale * (dist() / pinchBase)));
      apply();
    }
  });
  const lift = (e: PointerEvent) => { touches.delete(e.pointerId); if (touches.size < 2) pinchBase = 0; };
  host.addEventListener("pointerup", lift);
  host.addEventListener("pointercancel", lift);
}

// ---------- background enrichment (poll a row until its status settles) ----------
// pollToken is bumped on every full re-render so in-flight polls can detect a stale tab and bail.
let pollToken: number = 0;
function setPollTokenForClassicScripts(value: number): number {
  pollToken = value;
  return pollToken;
}
Object.defineProperty(globalThis, "pollToken", {
  configurable: true,
  get: () => pollToken,
  set: (value) => { pollToken = Number(value) || 0; },
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function enrichmentActive(status: unknown): boolean {
  return status === "pending" || status === "in_progress";
}
// Poll GET path/:id every ~1.5s up to ~10 tries. onUpdate(row) runs per fetch while the tab
// is still current; resolves once status leaves the active states (or the cap is hit). Returns the last row.
async function pollEnrichment<T extends UiRecord = UiRecord>(path: string, id: string | number, { tab, token, onUpdate, tries = 10, interval = 1500 }: PollEnrichmentOptions<T> = {}): Promise<T | null> {
  let row: T | null = null;
  for (let i = 0; i < tries; i++) {
    await sleep(interval);
    if (token !== pollToken || state.tab !== tab) return null; // navigated away / re-rendered
    try { row = uiRecord(await api(`${path}/${id}`)) as T; } catch { continue; }
    if (!row || row.error) continue;
    if (token !== pollToken || state.tab !== tab) return null;
    onUpdate && onUpdate(row);
    if (!enrichmentActive(row.enrichment_status)) return row;
  }
  return row;
}

// Status badge: a quiet spinner ONLY while the coach is still refining a just-logged
// entry. Once it settles there's NO permanent tag — the refined entry itself is the
// result, and the capture toast already confirmed the log at the moment of action.
// (A persistent "✦ noted" used to sit on every entry forever; that was pure noise.)
function enrichBadge(status: unknown): string {
  if (enrichmentActive(status)) return `<span class="enr enr-pending">enriching...</span>`;
  return ""; // done / skipped / failed / undefined -> no lingering tag
}

// One-line description of an activity row from its (possibly refined) fields.
function activityLine(a: UiRecord): string {
  const bits = [
    a.type,
    a.duration_min ? `${a.duration_min} min` : null,
    a.distance_km ? `${a.distance_km} km` : null,
    a.pace || null,
    a.rpe != null ? `RPE ${a.rpe}` : null,
  ].filter(Boolean).join(" · ");
  return bits || uiString(a.raw_text) || uiString(a.notes);
}

// ---------- in-app agent-login terminal (xterm over a WebSocket PTY) ----------
// Some coaching CLIs (Claude Code, Codex, Grok, …) authenticate with an
// interactive device login: they print a URL + code, you authorize in a browser,
// they finish. This modal pipes that interactive subprocess to the device over a
// WebSocket and renders it with xterm.js (vendored, UMD globals `Terminal` and
// `FitAddon.FitAddon`). One login runs server-side at a time. Self-contained and
// global so Settings can launch it: `openAgentLoginModal("claude")`.
//
// Styling lives in a JS-injected <style> (this module can't touch styles.css);
// the chrome harmonizes with the Atelier palette, the terminal panel is a calm
// dark slate. The vendored assets load lazily on first open (one cached promise).

let _xtermAssets: Promise<void> | null = null; // Promise<void>, resolved once xterm + fit addon are loaded
function xtermWindow(): { Terminal?: XtermConstructor; FitAddon?: { FitAddon?: XtermFitAddonConstructor } } {
  return window as unknown as { Terminal?: XtermConstructor; FitAddon?: { FitAddon?: XtermFitAddonConstructor } };
}
function loadXtermAssets(): Promise<void> {
  if (_xtermAssets) return _xtermAssets;
  _xtermAssets = new Promise<void>((resolve, reject) => {
    try {
      if (!document.querySelector('link[data-xterm-css]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/vendor/xterm.css";
        link.setAttribute("data-xterm-css", "1");
        document.head.appendChild(link);
      }
      // Already present (e.g. a second open before the first resolved)?
      const globals = xtermWindow();
      if (globals.Terminal && globals.FitAddon) { resolve(); return; }
      // the fit addon's UMD references the core, so always load core first
      const loadScript = (src: string): Promise<void> => new Promise<void>((res, rej) => {
        let el = document.querySelector<HTMLScriptElement>(`script[data-xterm-src="${src}"]`);
        if (el) { el.addEventListener("load", () => res()); el.addEventListener("error", () => rej(new Error("load " + src))); if (el.dataset.loaded) res(); return; }
        el = document.createElement("script");
        el.src = src;
        el.async = false;
        el.setAttribute("data-xterm-src", src);
        el.addEventListener("load", () => { el.dataset.loaded = "1"; res(); });
        el.addEventListener("error", () => rej(new Error("load " + src)));
        document.head.appendChild(el);
      });
      // core then addon, in order
      loadScript("/vendor/xterm.js")
        .then(() => loadScript("/vendor/xterm-addon-fit.js"))
        .then(() => resolve())
        .catch(reject);
    } catch (e) { reject(e); }
  });
  return _xtermAssets;
}

// Inject the modal + terminal chrome once. Kept out of styles.css on purpose
// (another stream owns that file); scoped under .agent-login-* so it's inert
// until a modal mounts.
function ensureAgentLoginStyles(): void {
  if (document.getElementById("agent-login-styles")) return;
  const s = document.createElement("style");
  s.id = "agent-login-styles";
  s.textContent = `
.agent-login-ov{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
  padding:max(env(safe-area-inset-top),18px) 16px max(env(safe-area-inset-bottom),18px);
  background:rgba(33,29,23,.46);backdrop-filter:saturate(1.1) blur(2px);
  animation:agentLoginFade .16s ease both}
@keyframes agentLoginFade{from{opacity:0}to{opacity:1}}
.agent-login{width:min(720px,100%);max-height:100%;display:flex;flex-direction:column;
  background:var(--card,#fffdf8);color:var(--ink,#211d17);border:1px solid var(--line,#e7dfd2);
  border-radius:var(--radius,18px);box-shadow:var(--shadow-lg,0 28px 64px rgba(0,0,0,.3));
  overflow:hidden;font-family:var(--font-ui,system-ui,sans-serif)}
.agent-login-hd{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line,#e7dfd2)}
.agent-login-hd h2{margin:0;font-family:var(--font-display,Georgia,serif);font-size:19px;font-weight:600;flex:1;line-height:1.2}
.agent-login-x{appearance:none;border:0;background:transparent;color:var(--muted,#746c5c);
  font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px}
.agent-login-x:hover{color:var(--ink,#211d17);background:var(--paper,#f4efe7)}
.agent-login-bd{padding:14px 16px 16px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.agent-login-term{background:var(--stone-deep,#2c2620);border-radius:12px;padding:10px 8px 8px;
  border:1px solid var(--stone,#473f36);min-height:180px;height:clamp(180px,42vh,340px)}
.agent-login-term .xterm{padding:0}
.agent-login-status{font-size:13px;color:var(--muted,#746c5c);min-height:18px;display:flex;align-items:center;gap:6px}
.agent-login-status.is-ok{color:var(--sage,#6e7f5c);font-weight:600}
.agent-login-status.is-err{color:var(--accent,#b4552d);font-weight:600}
.agent-login-hint{font-size:12.5px;color:var(--muted,#746c5c);line-height:1.5;margin:0}
.agent-login-hint code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
  background:var(--paper,#f4efe7);padding:1px 5px;border-radius:5px;border:1px solid var(--line,#e7dfd2)}
.agent-login-ft{display:flex;justify-content:flex-end;gap:10px;padding-top:2px}
.agent-login-btn{appearance:none;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;
  padding:9px 16px;border-radius:11px;border:1px solid var(--line,#e7dfd2);
  background:var(--paper,#f4efe7);color:var(--ink,#211d17)}
.agent-login-btn:hover{background:var(--card,#fffdf8)}
.agent-login-btn:focus-visible,.agent-login-x:focus-visible{outline:2px solid var(--accent,#b4552d);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.agent-login-ov{animation:none}}
`;
  document.head.appendChild(s);
}

// Tear down a mounted login modal: close the socket (kills the server session),
// dispose the terminal, drop window listeners, remove the overlay.
function closeAgentLoginModal(ov: DetailOverlay | null | undefined): void {
  if (!ov || ov.dataset.closing) return;
  ov.dataset.closing = "1";
  try { ov._ws && ov._ws.close(); } catch {}
  try { ov._term?.dispose?.(); } catch {}
  try { if (ov._onResize) window.removeEventListener("resize", ov._onResize); } catch {}
  try { if (ov._onKey) document.removeEventListener("keydown", ov._onKey); } catch {}
  ov.remove();
}

// Open the interactive agent-login terminal for `agentName`.
async function openAgentLoginModal(agentName: unknown): Promise<void> {
  const name = String(agentName || "").trim();
  if (!name) return;
  ensureAgentLoginStyles();

  // Build the modal shell immediately (so a slow asset load still shows chrome).
  const ov = document.createElement("div") as DetailOverlay;
  ov.className = "agent-login-ov";
  const grokNote = name.toLowerCase() === "grok"
    ? `<p class="agent-login-hint">Grok can also authenticate with an API key — set <code>XAI_API_KEY</code> in the server environment instead of this device login.</p>`
    : "";
  ov.innerHTML = `
    <div class="agent-login" role="dialog" aria-modal="true" aria-label="Connect ${escAttr(name)}">
      <div class="agent-login-hd">
        <h2>Connect ${escHtml(name)}</h2>
        <button class="agent-login-x" type="button" aria-label="Close">✕</button>
      </div>
      <div class="agent-login-bd">
        <div class="agent-login-status" role="status">Connecting…</div>
        <div class="agent-login-term"></div>
        ${grokNote}
        <p class="agent-login-hint">Follow the prompts. If a URL and a code appear, open the URL in your browser to authorize.</p>
        <div class="agent-login-ft">
          <button class="agent-login-btn" type="button" data-close>Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const statusEl = ov.querySelector<HTMLElement>(".agent-login-status");
  const termHost = ov.querySelector<HTMLElement>(".agent-login-term");
  const closeBtn = ov.querySelector<HTMLButtonElement>(".agent-login-ft [data-close]");
  const footer = ov.querySelector<HTMLElement>(".agent-login-ft");
  if (!statusEl || !termHost || !closeBtn || !footer) {
    ov.remove();
    return;
  }
  const setStatus = (text: string, cls?: string) => {
    statusEl.textContent = text;
    statusEl.classList.remove("is-ok", "is-err");
    if (cls) statusEl.classList.add(cls);
  };
  // On a failed/aborted login, keep the modal open so the terminal output stays
  // readable, turn Cancel into Close, and offer a one-tap retry (reopen).
  const markFailed = (msg: string) => {
    setStatus(msg, "is-err");
    ov._failed = true;
    if (closeBtn) closeBtn.textContent = "Close";
    if (!footer.querySelector("[data-retry]")) {
      const r = document.createElement("button");
      r.className = "agent-login-btn"; r.type = "button"; r.dataset.retry = "1"; r.textContent = "Try again";
      r.addEventListener("click", () => { closeAgentLoginModal(ov); openAgentLoginModal(name); });
      footer.insertBefore(r, closeBtn);
    }
  };
  // Esc + the × and Cancel buttons all tear down (which closes the WS session). Tab
  // is trapped within the modal chrome so focus can't escape to the page behind
  // (the terminal owns Tab while focused, so this mainly guards the chrome buttons).
  ov._onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { closeAgentLoginModal(ov); return; }
    if (e.key !== "Tab") return;
    const f = [...ov.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.offsetParent !== null);
    if (f.length < 2) return;
    const first = f[0], last = f[f.length - 1], act = document.activeElement;
    if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", ov._onKey);
  ov.querySelector(".agent-login-x")?.addEventListener("click", () => closeAgentLoginModal(ov));
  closeBtn.addEventListener("click", () => closeAgentLoginModal(ov));

  // Load xterm + fit, then spin up the terminal and the socket.
  let Terminal: XtermConstructor | undefined;
  let FitAddon: XtermFitAddonConstructor | undefined;
  try {
    await loadXtermAssets();
    const globals = xtermWindow();
    Terminal = globals.Terminal;
    FitAddon = globals.FitAddon && globals.FitAddon.FitAddon;
    if (typeof Terminal !== "function" || typeof FitAddon !== "function") {
      throw new Error("terminal library unavailable");
    }
  } catch {
    setStatus("Couldn't load the terminal. Reload and try again.", "is-err");
    return;
  }
  if (!ov.isConnected) return; // closed while loading

  const term = new Terminal({
    convertEol: false,
    fontSize: 13,
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    theme: {
      // warm near-black from the brand mark (--stone-deep) — xterm needs a
      // literal, so this mirrors the CSS .agent-login-term surface above.
      background: "#2c2620",
      foreground: "#ece6da",
      cursor: "#d9b48a",
      selectionBackground: "#3a3733",
      black: "#2c2620", red: "#d2795a", green: "#9bb07e", yellow: "#d9b48a",
      blue: "#7f9bb0", magenta: "#b08a9b", cyan: "#7fb0a8", white: "#ece6da",
    },
  });
  const fit = new FitAddon();
  term.loadAddon?.(fit);
  term.open(termHost);
  try { fit.fit(); } catch {}
  ov._term = term;
  ov._onResize = () => { try { fit.fit(); } catch {} };
  window.addEventListener("resize", ov._onResize);

  // Build the WS URL the way the rest of the PWA reaches the API + token.
  const token = (typeof authToken === "function" && authToken()) || "";
  const wsUrl = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host +
    "/api/agent-login/ws?agent=" + encodeURIComponent(name) +
    (token ? "&token=" + encodeURIComponent(token) : "");

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    setStatus("Couldn't open the connection.", "is-err");
    return;
  }
  ws.binaryType = "arraybuffer";
  ov._ws = ws;

  // Server control protocol (JSON text frames). Binary frames are raw PTY bytes.
  const handleControl = (m: unknown) => {
    if (!m || typeof m !== "object") return;
    const msg = uiRecord(m);
    switch (msg.t) {
      case "exit": {
        if (msg.code === 0) {
          // Success: brief confirm, then close + refresh the cards (Installed → ✓ Connected).
          setStatus("✓ Connected", "is-ok");
          setTimeout(() => {
            closeAgentLoginModal(ov);
            if (typeof renderSettings === "function") renderSettings();
          }, 1200);
        } else {
          // Non-zero exit (cancelled / wrong code / login refused): leave the modal
          // up so the terminal output is readable; offer Close + Try again.
          markFailed("Login didn't complete — check the terminal above, then try again.");
        }
        break;
      }
      case "busy":
        // The server closes the socket right after, so there's nothing to do here —
        // surface it as a toast and dismiss the empty terminal.
        if (typeof toast === "function") toast("Another login is already running — try again in a moment.");
        closeAgentLoginModal(ov);
        break;
      case "error":
        markFailed(msg.message ? String(msg.message) : "Something went wrong.");
        break;
      default:
        break;
    }
  };

  ws.onopen = () => {
    setStatus("Connected — follow the prompts below.");
    try { term.focus?.(); } catch {}
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try { handleControl(JSON.parse(ev.data)); } catch {}
    } else {
      if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
    }
  };
  ws.onerror = () => {
    if (!ov._failed) markFailed("Connection error — make sure the server is reachable, then try again.");
  };
  ws.onclose = () => {
    // Surface only an UNEXPECTED drop — don't clobber a success flash or an already-
    // shown failure message (exit/error handlers own those).
    if (ov.isConnected && !ov.dataset.closing && !ov._failed && !statusEl.classList.contains("is-ok")) {
      markFailed("Disconnected before the login finished — try again.");
    }
  };

  // Keystrokes → raw frames; xterm resize → JSON resize control frame.
  term.onData?.((d: string) => { if (ws.readyState === 1) ws.send(d); });
  term.onResize?.(({ cols, rows }: { cols: number; rows: number }) => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ t: "resize", cols, rows })); } catch {}
    }
  });
  // Push the initial geometry once connected.
  ws.addEventListener("open", () => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ t: "resize", cols: term.cols || 0, rows: term.rows || 0 })); } catch {}
    }
  });
}

const CAIRN_UI_SHELL_GLOBALS = {
  setTodayHeaderTitle,
  updateHeaderCondense,
  toast,
  armDelete,
  wireGuides,
  exerciseExplanation,
  exerciseExplanationHtml,
  replaceExerciseExplanation,
  gotoChatWith,
  openFoodDetail,
  segBar,
  wireSeg,
  fitSeg,
  PROGRESS_SEG,
  PROGRESS_HANDLERS,
  planSeg,
  PLAN_HANDLERS,
  art,
  stagger,
  reducedMotion,
  viewEnter,
  withViewTransition,
  skelSwap,
  btnBusy,
  countUp,
  fmtK,
  runCountUps,
  loadingState,
  thinkingCaption,
  tabErrorState,
  skelLines,
  todaySkeleton,
  segSkeleton,
  setDiscipline,
  isEndurance,
  isHybrid,
  setEnduranceGoalSet,
  showEnduranceTab,
  primeArtManifest,
  artImg,
  sparklineSvg,
  closeDetail,
  openDetailFrom,
  mountDetail,
  wireDetailCommon,
  wireArtZoom,
  setPollTokenForClassicScripts,
  enrichmentActive,
  pollEnrichment,
  enrichBadge,
  activityLine,
  openAgentLoginModal,
};

Object.assign(globalThis, CAIRN_UI_SHELL_GLOBALS);

if (typeof window !== "undefined") {
  Object.assign(window, CAIRN_UI_SHELL_GLOBALS);
}

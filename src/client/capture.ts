// @ts-check
// ==== capture.ts ====
function captureFailureIsTransient(error: unknown): boolean {
  const classify = (globalThis as unknown as {
    CairnApiCache?: { isTransientApiFailure?: (value: unknown) => boolean };
  }).CairnApiCache?.isTransientApiFailure;
  return typeof classify === "function" ? classify(error) : true;
}

async function quickLog(): Promise<void> {
  const inp = document.querySelector<HTMLInputElement>("#qlInput");
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = "";
  const wrap = view.querySelector<HTMLElement>("#qlRecent");
  let a: CaptureActivity | null = null;
  try {
    a = await api("/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }) as unknown as CaptureActivity;
  } catch (error) {
    if (!captureFailureIsTransient(error)) {
      inp.value = text;
      toast("Couldn't log that — try again.");
      return;
    }
    // Network dropped — DON'T lose the log. Queue the exact POST and replay it on
    // reconnect (the input was already cleared, so the text lives only in the outbox).
    outboxEnqueue("activity", "/activities", { text });
    toast("Saved — will sync when you're back online");
    return;
  }
  if (a && a.error) { toast("Couldn't log that — try again."); return; }
  toast("Logged");

  // Instant feedback: show the regex result at the top of Lately right away. The
  // full rebuild (reshapeToday → loadRecentActivities) normalizes it into a feed
  // row a beat later; this just avoids an empty gap between submit and that rebuild.
  if (wrap) {
    let head = wrap.querySelector(".lately-h");
    if (!head) {
      wrap.insertAdjacentHTML("afterbegin", `<div class="lately-h"><span class="ql-recent-h lbl">Lately</span></div>`);
      head = wrap.querySelector(".lately-h");
    }
    if (head) head.insertAdjacentHTML("afterend", actEntryHtml(a));
  }

  // A logged activity is movement — refresh the Brief so it reflects the day. This
  // re-renders Today once the recomputed (agentic) read is ready; the entry above
  // persists (rebuilt from server state). reshapeToday bumps pollToken, retiring any
  // prior poll, so resume enrichment polling against the fresh DOM afterward.
  await reshapeToday();
  if (state.tab === "today" && a && a.id && enrichmentActive(a.enrichment_status)) {
    const tab = state.tab, token = pollToken;
    pollEnrichment("/activities", a.id, {
      tab, token,
      onUpdate: (row) => {
        const el = view.querySelector(`.qlent[data-actid="${row.id}"]`);
        if (el) updateActEntry(el, row);
      },
    });
  }
}

function setupWeightChip(): void {
  const chip = view.querySelector<HTMLElement>("#wtChip");          // compass tile (in the week fold)
  const mini = view.querySelector<HTMLElement>("#wtChipMini");      // always-on capture-row chip
  const inline = view.querySelector<HTMLElement>("#wtInline");
  const input = view.querySelector<HTMLInputElement>("#wtInlineInput");
  const go = view.querySelector<HTMLElement>("#wtInlineGo");
  if (!inline || !input) return;
  const toggle = () => {
    inline.hidden = !inline.hidden;
    if (!inline.hidden) { input.focus(); input.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" }); }
  };
  if (chip) chip.addEventListener("click", toggle);
  if (mini) mini.addEventListener("click", toggle);
  const save = async (): Promise<void> => {
    const w = +input.value;
    if (!w) { input.focus(); return; }
    try {
      await api("/bodyweight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weight_lb: w }) });
    } catch (error) {
      if (!captureFailureIsTransient(error)) {
        toast("Couldn't log that — try again.");
        return;
      }
      // Offline — queue the weigh-in and reflect it optimistically; it syncs on reconnect.
      outboxEnqueue("weight", "/bodyweight", { weight_lb: w });
      const pendingVal = chip && chip.querySelector("[data-wtval]");
      if (pendingVal) pendingVal.innerHTML = `${w}<span class="stat-plus">+</span>`;
      if (mini) mini.innerHTML = `${w}<span class="wt-mini-unit">lb</span><span class="stat-plus">+</span>`;
      input.value = ""; inline.hidden = true;
      toast("Saved — will sync when you're back online");
      return;
    }
    // a weigh-in syncs profile.weight_lb and moves the weight trend / pace — drop the
    // caches that read it so Today's compass + the Weight/Energy views stay honest.
    swrInvalidate("progress:weight");
    swrInvalidate("stats");
    swrInvalidate("profile");
    swrInvalidate("progress:energy");
    const valEl = chip && chip.querySelector("[data-wtval]");
    if (valEl) valEl.innerHTML = `${w}<span class="stat-plus">+</span>`;
    if (mini) mini.innerHTML = `${w}<span class="wt-mini-unit">lb</span><span class="stat-plus">+</span>`;
    input.value = ""; inline.hidden = true;
    toast("Weight logged");
  };
  if (go) go.addEventListener("click", save);
  input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") save(); });
}

// ---------- effortless capture: voice (Web Speech), frequents, check-in ----------
function captureVoice(): Window["CairnCaptureVoice"] {
  return (globalThis as unknown as { CairnCaptureVoice: Window["CairnCaptureVoice"] }).CairnCaptureVoice;
}

const MIC_GLYPH = (globalThis as unknown as { CairnCaptureVoice?: Window["CairnCaptureVoice"] }).CairnCaptureVoice?.micGlyph ?? "";

function setupVoiceCapture(): void {
  captureVoice().setup({ root: view, quickLog });
}

// hour → meal slot, used both to label the re-logged food and to query frequents
function mealForHour(h: number): string {
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 18) return "snack";
  return "dinner";
}

// One-tap re-log of the foods most often eaten near this time of day. The chip
// POSTs the summary to /food-notes; enrichment polling then upgrades it in place.
// Quiet by default: nothing renders if there are no frequents.
async function loadFrequentFoods(): Promise<void> {
  const wrap = view.querySelector<HTMLElement>("#freqFoods");
  if (!wrap) return;
  const hour = new Date().getHours();
  let foods: CaptureFrequentFood[] = [];
  try { foods = await api("/frequent-foods?hour=" + hour) as CaptureFrequentFood[]; } catch { foods = []; }
  if (state.tab !== "today" || !wrap.isConnected) return;
  if (!Array.isArray(foods) || !foods.length) { wrap.innerHTML = ""; return; }
  const chips = foods.slice(0, 6).map((f) => {
    const summary = String(f.summary || "").trim();
    if (!summary) return "";
    const kcal = f.kcal != null ? `<span class="freq-chip-kcal">${Math.round(Number(f.kcal))}</span>` : "";
    return `<button class="freq-chip" data-freq="${escAttr(summary)}">
        <span class="freq-chip-art">${art("food", summary)}</span>
        <span class="freq-chip-name">${escHtml(summary)}</span>${kcal}
      </button>`;
  }).join("");
  if (!chips) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<div class="freq-head lbl">Usual around now</div>
    <div class="freq-chips">${chips}</div>`;
  wrap.querySelectorAll<HTMLElement>("[data-freq]").forEach((b) =>
    b.addEventListener("click", () => relogFrequent(b.dataset.freq, b)));
}

let _relogInFlight = false;
async function relogFrequent(summary: string | undefined, chip?: HTMLElement): Promise<void> {
  if (_relogInFlight || !summary) return;
  _relogInFlight = true;
  if (chip) chip.classList.add("freq-chip-busy");
  const meal = mealForHour(new Date().getHours());
  let f: CaptureFoodNote | null = null;
  try {
    f = await api("/food-notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meal, text: summary }),
    }) as CaptureFoodNote;
  } catch (error) {
    _relogInFlight = false;
    if (chip) chip.classList.remove("freq-chip-busy");
    if (!captureFailureIsTransient(error)) {
      toast("Couldn't log that — try again.");
      return;
    }
    // Offline — queue the re-log and replay it on reconnect rather than dropping it.
    outboxEnqueue("food", "/food-notes", { meal, text: summary });
    toast("Saved · " + meal + " — will sync when you're back");
    return;
  }
  _relogInFlight = false;
  if (chip) chip.classList.remove("freq-chip-busy");
  if (!f || f.error) { toast("Couldn't log that — try again."); return; }
  toast("Logged · " + meal);
  // poll the enrichment upgrade quietly (no visible row on Today; the meal lives in Plan → Food)
  if (f.id && enrichmentActive(f.enrichment_status)) {
    pollEnrichment("/food-notes", f.id, { tab: state.tab, token: pollToken });
  }
}

// ---------- optional how-you-feel (offered, never required) ----------
// A subtle, dismissible 1–5 mood/energy tap. If a check-in already exists for
// today it shows as a calm "noted" line; otherwise a small "how are you feeling?"
// affordance that expands on tap. Feeds the Brief's day-read; never nags.
async function loadCheckin(): Promise<void> {
  const slot = view.querySelector<HTMLElement>("#checkinSlot");
  if (!slot) return;
  let existing: CaptureCheckin | null = null;
  try { existing = await api("/checkins?date=" + localISO()) as CaptureCheckin | null; } catch { existing = null; }
  if (state.tab !== "today" || !slot.isConnected) return;
  if (existing && (existing.mood != null || existing.energy != null)) {
    renderCheckinDone(slot, existing);
    return;
  }
  // collapsed by default — one quiet line, opt-in
  slot.innerHTML = `<button class="checkin-open" id="checkinOpen" type="button">
      <span class="checkin-open-dot" aria-hidden="true"></span>
      how are you feeling?
    </button>`;
  const open = slot.querySelector("#checkinOpen");
  if (open) open.addEventListener("click", () => renderCheckinForm(slot));
}

const FEEL_FACES = ["·", "◦", "○", "◍", "●"]; // 1→5, quiet glyphs, no emoji
function feelScale(kind: "mood" | "energy", label: string): string {
  const dots = FEEL_FACES.map((g, i) =>
    `<button class="feel-dot" data-feel="${kind}" data-val="${i + 1}" aria-label="${escAttr(label + " " + (i + 1))}">${g}</button>`
  ).join("");
  return `<div class="feel-row"><span class="feel-lbl lbl">${escHtml(label)}</span><div class="feel-dots">${dots}</div></div>`;
}

function renderCheckinForm(slot: HTMLElement): void {
  slot.innerHTML = `<div class="checkin-form chip-in">
      ${feelScale("mood", "mood")}
      ${feelScale("energy", "energy")}
      <button class="checkin-dismiss" id="checkinDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
  const picked: { mood?: number; energy?: number } = {};
  slot.querySelectorAll<HTMLElement>(".feel-dot").forEach((b) =>
    b.addEventListener("click", async () => {
      const kind = b.dataset.feel === "energy" ? "energy" : "mood";
      const val = Number(b.dataset.val);
      picked[kind] = val;
      // highlight selected + everything below it (a 1–5 scale fill)
      slot.querySelectorAll<HTMLElement>(`.feel-dot[data-feel="${kind}"]`).forEach((d) =>
        d.classList.toggle("feel-dot-on", Number(d.dataset.val) <= val));
      try {
        const saved = await api("/checkins", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mood: picked.mood, energy: picked.energy }),
        }) as CaptureCheckin;
        if (saved && !saved.error) {
          renderCheckinDone(slot, saved);
          toast("Noted");
          reshapeToday(); // a fresh check-in can shift today's read — reflect it now
        }
      } catch { /* silent — it's optional */ }
    }));
  const dismiss = slot.querySelector("#checkinDismiss");
  if (dismiss) dismiss.addEventListener("click", () => { slot.innerHTML = ""; });
}

function renderCheckinDone(slot: HTMLElement, c: CaptureCheckin): void {
  const parts = [];
  if (c.mood != null) parts.push(`mood ${Number(c.mood)}/5`);
  if (c.energy != null) parts.push(`energy ${Number(c.energy)}/5`);
  if (!parts.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="checkin-done chip-in"><span class="checkin-done-mark" aria-hidden="true">✓</span> ${escHtml(parts.join(" · "))}</div>`;
}

let _captureReads: ReturnType<CaptureReadsRuntime["createController"]> | null = null;

function captureReads(): ReturnType<CaptureReadsRuntime["createController"]> {
  if (!_captureReads) {
    _captureReads = (globalThis as unknown as { CairnCaptureReads: CaptureReadsRuntime }).CairnCaptureReads.createController({
      root: view,
      state,
      api,
      runOp,
      toast,
      collapseEl,
      escapeHtml: escHtml,
      storage: localStorage,
    });
  }
  return _captureReads;
}

function weekRangeLabel(iso: unknown): string {
  return (globalThis as unknown as { CairnCaptureReads: CaptureReadsRuntime }).CairnCaptureReads.weekRangeLabel(iso);
}

function loadTodayReads(): Promise<void> {
  return captureReads().loadTodayReads();
}

function reconnectInsight(): ClientAgentOpHandlers | null {
  return captureReads().reconnectInsight();
}

// Classic client scripts share one global scope. Keep the cross-file capture API
// explicit while this surface is migrated incrementally to TypeScript.
Object.assign(globalThis, {
  MIC_GLYPH,
  weekRangeLabel,
  quickLog,
  setupWeightChip,
  setupVoiceCapture,
  loadFrequentFoods,
  relogFrequent,
  loadCheckin,
  loadTodayReads,
  reconnectInsight,
});

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
    const saved = await outboxEnqueue("activity", "/activities", { text });
    if (!saved) {
      inp.value = text;
      toast("Couldn’t save that on this device — free storage and try again.");
      return;
    }
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
      const saved = await outboxEnqueue("weight", "/bodyweight", { weight_lb: w });
      if (!saved) {
        toast("Couldn’t save that on this device — free storage and try again.");
        return;
      }
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

// Voice capture is scoped to Chat (product law: photo/voice logging ONLY in
// Chat). It mounts against whichever mic/input pair the chat composer emits
// in the shared `view` root — when Chat is the active surface both exist, so
// this does not early-return there; on any other tab neither exists yet and
// it quietly no-ops.
function setupVoiceCapture(): void {
  const mic = view.querySelector<HTMLElement>("#chatMic");
  const inp = view.querySelector<HTMLTextAreaElement>("#chatInput");
  if (!mic || !inp) return;
  captureVoice().setup({ mic, input: inp });
}

// Food frequents ("Usual around now") moved into the Chat composer as prefill
// chips (chat-frequents wiring in chat-screen.ts) — capture stays scoped to Chat,
// and a frequent is a starting draft to edit, never a verbatim one-tap re-log.

// ---------- optional how-you-feel (offered, never required) ----------
// The morning check-in, in WORDS. Three scales — energy, sleep, soreness — because
// those are the three the read actually leans on (`freshStatementHold`), and because
// the ceiling-easy sentence literally asks "tell me if that changes" and until now
// had no affordance beneath it. Mounted by the Brief on today's rest/easy reads only
// (see today-brief-client.ts): pull, never push. Nothing is required, one tap is a
// complete answer, and waving it off silences it for the day.
//
// It never prints a score. A dot's meaning is its WORD (aria-label and title), and
// the answered state is a sentence — "feeling strong · slept well · a little sore" —
// not "energy 4/5". A number on the Brief's own screen is an Amendment 2 violation
// however small it is.
type CheckinField = {
  key: "energy" | "sleep_feel" | "soreness";
  label: string;
  // 1→5, the word each dot means.
  words: readonly [string, string, string, string, string];
  // 1→5, the same rung spoken back in the answered line.
  done: readonly [string, string, string, string, string];
};

const CHECKIN_FIELDS: readonly CheckinField[] = [
  {
    key: "energy",
    label: "energy",
    words: ["running on empty", "low", "steady", "good", "strong"],
    done: ["running on empty", "low energy", "feeling steady", "feeling good", "feeling strong"],
  },
  {
    key: "sleep_feel",
    label: "sleep",
    words: ["barely slept", "rough night", "okay", "slept well", "slept deeply"],
    done: ["barely slept", "slept rough", "slept okay", "slept well", "slept deeply"],
  },
  {
    key: "soreness",
    label: "soreness",
    words: ["nothing sore", "a little sore", "sore", "pretty sore", "very sore"],
    done: ["nothing sore", "a little sore", "sore today", "pretty sore", "very sore"],
  },
];

// One question, asked a few different ways, stable for the whole day — the same
// pickDayVariant rotation the deterministic reads use, so a daily affordance never
// becomes one sentence printed at the athlete every morning for a month.
const CHECKIN_LEADS = [
  "How's the body this morning?",
  "How are you landing today?",
  "How does today feel so far?",
];

function checkinLead(iso: string): string {
  const ms = Date.parse(`${String(iso ?? "").slice(0, 10)}T00:00:00Z`);
  const dayIndex = Number.isFinite(ms) ? Math.floor(ms / 864e5) : 0;
  const span = CHECKIN_LEADS.length;
  return CHECKIN_LEADS[((dayIndex % span) + span) % span];
}

const CHECKIN_DISMISS_KEY = "cairn.checkin.dismissed.v1";

function checkinDismissedToday(iso: string): boolean {
  try {
    return localStorage.getItem(CHECKIN_DISMISS_KEY) === iso;
  } catch {
    return false;
  }
}

function dismissCheckinForToday(iso: string): void {
  try {
    localStorage.setItem(CHECKIN_DISMISS_KEY, iso);
  } catch { /* private mode / full storage — the dismiss just doesn't persist */ }
}

function checkinAnswered(c: CaptureCheckin | null | undefined): boolean {
  if (!c) return false;
  return CHECKIN_FIELDS.some((field) => (c as Record<string, unknown>)[field.key] != null) || c.mood != null;
}

// One tap is a complete answer, but it is not THE answer — the other two scales
// have to survive it. The draft is what the athlete has answered so far today,
// held in module state so the reshapeToday() a save triggers (and every other
// repaint that calls loadCheckin) re-asks the unanswered scales instead of
// collapsing the row into the done line after the first dot.
type CheckinDraft = { iso: string; picked: Partial<Record<CheckinField["key"], number>> };
let _checkinDraft: CheckinDraft | null = null;

function checkinDraftFor(iso: string): CheckinDraft | null {
  return _checkinDraft && _checkinDraft.iso === iso ? _checkinDraft : null;
}

function checkinDraftComplete(draft: CheckinDraft | null): boolean {
  return !!draft && CHECKIN_FIELDS.every((field) => draft.picked[field.key] != null);
}

async function loadCheckin(): Promise<void> {
  const slot = view.querySelector<HTMLElement>("#checkinSlot");
  if (!slot) return;
  const today = localISO();
  let existing: CaptureCheckin | null = null;
  try { existing = await api("/checkins?date=" + today) as CaptureCheckin | null; } catch { existing = null; }
  if (state.tab !== "today" || !slot.isConnected) return;
  // Mid-answer: the row stays a form until all three are in (or it is waved off).
  // A form already on screen is left completely alone — re-rendering under the
  // athlete's finger would drop the marks and the listeners mid-tap.
  const draft = checkinDraftFor(today);
  if (draft && !checkinDraftComplete(draft)) {
    if (slot.querySelector(".checkin-form")) return;
    renderCheckinForm(slot, today);
    return;
  }
  if (checkinAnswered(existing)) {
    renderCheckinDone(slot, existing as CaptureCheckin);
    return;
  }
  // Waved off this morning — stay gone until tomorrow. Asking again after a dismiss
  // is the definition of nagging.
  if (checkinDismissedToday(today)) { slot.innerHTML = ""; return; }
  renderCheckinForm(slot, today);
}

const FEEL_FACES = ["·", "◦", "○", "◍", "●"]; // 1→5, quiet glyphs, no emoji
function feelScale(field: CheckinField, rung?: number | null): string {
  const dots = FEEL_FACES.map((g, i) =>
    `<button class="feel-dot${rung != null && i + 1 <= rung ? " feel-dot-on" : ""}" type="button" data-feel="${escAttr(field.key)}" data-val="${i + 1}" title="${escAttr(field.words[i])}" aria-label="${escAttr(`${field.label}: ${field.words[i]}`)}">${g}</button>`
  ).join("");
  // The answered scale says its own word back, inline, while the other two stay
  // askable. Words only — a number here would be the same Amendment 2 violation
  // the done line is careful to avoid.
  const said = rung != null ? escHtml(field.done[rung - 1]) : "";
  return `<div class="feel-row"><span class="feel-lbl lbl">${escHtml(field.label)}</span><div class="feel-dots">${dots}</div><span class="feel-said" data-said="${escAttr(field.key)}">${said}</span></div>`;
}

function renderCheckinForm(slot: HTMLElement, iso?: string): void {
  const today = iso || localISO();
  const draft = checkinDraftFor(today);
  // Carry whatever is already answered today back onto the freshly drawn row, so
  // a repaint never asks a question the athlete has already answered this morning.
  const picked: Partial<Record<CheckinField["key"], number>> = { ...(draft ? draft.picked : {}) };
  _checkinDraft = { iso: today, picked };
  slot.innerHTML = `<div class="checkin-form chip-in">
      <span class="checkin-lead">${escHtml(checkinLead(today))}</span>
      ${CHECKIN_FIELDS.map((field) => feelScale(field, picked[field.key] ?? null)).join("")}
      <button class="checkin-dismiss" id="checkinDismiss" type="button" aria-label="Not now">✕</button>
    </div>`;
  slot.querySelectorAll<HTMLElement>(".feel-dot").forEach((b) =>
    b.addEventListener("click", async () => {
      const field = CHECKIN_FIELDS.find((f) => f.key === b.dataset.feel);
      if (!field) return;
      const val = Number(b.dataset.val);
      picked[field.key] = val;
      // highlight selected + everything below it (a five-rung scale fill)
      slot.querySelectorAll<HTMLElement>(`.feel-dot[data-feel="${field.key}"]`).forEach((d) =>
        d.classList.toggle("feel-dot-on", Number(d.dataset.val) <= val));
      const said = slot.querySelector<HTMLElement>(`[data-said="${field.key}"]`);
      if (said) said.innerHTML = escHtml(field.done[val - 1]);
      try {
        // POST /checkins INSERTS a row and GET ?date= reads the newest, so every
        // tap has to carry everything answered so far — a partial body would drop
        // the earlier scales off today's row.
        const saved = await api("/checkins", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...picked }),
        }) as CaptureCheckin;
        if (saved && !saved.error) {
          toast("Noted");
          // The form stays mounted until all three are in; only then does the row
          // become the answered sentence.
          if (checkinDraftComplete({ iso: today, picked })) {
            _checkinDraft = null;
            renderCheckinDone(slot, saved);
          }
          reshapeToday(); // a fresh check-in can shift today's read — reflect it now
        }
      } catch { /* silent — it's optional */ }
    }));
  const dismiss = slot.querySelector("#checkinDismiss");
  if (dismiss) dismiss.addEventListener("click", () => {
    dismissCheckinForToday(today);
    // Waving off a half-answered row still keeps what was said — the answered
    // scales become the done line rather than vanishing.
    const answered = _checkinDraft && _checkinDraft.iso === today ? _checkinDraft.picked : null;
    _checkinDraft = null;
    if (answered && CHECKIN_FIELDS.some((field) => answered[field.key] != null)) {
      renderCheckinDone(slot, answered as unknown as CaptureCheckin);
      return;
    }
    slot.innerHTML = "";
  });
}

function checkinRung(value: unknown): number | null {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function renderCheckinDone(slot: HTMLElement, c: CaptureCheckin): void {
  const parts: string[] = [];
  for (const field of CHECKIN_FIELDS) {
    const rung = checkinRung((c as unknown as Record<string, unknown>)[field.key]);
    if (rung != null) parts.push(field.done[rung - 1]);
  }
  // A legacy row carrying only the retired mood field still deserves an answered
  // state — just never a number for it.
  if (!parts.length && c.mood != null) parts.push("you checked in");
  if (!parts.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="checkin-done chip-in"><span class="checkin-done-mark" aria-hidden="true">✓</span> ${escHtml(parts.join(" · "))}</div>`;
}

// ---------- context tags: cheap one-tap life context (WHOOP-journal pattern) ----------
// A quiet row of chips — travel / drinks / rough sleep setup / work crunch / feeling
// off. Tap tags today, tap again untags. No streaks, no history guilt: this is
// evidence the insight generator quietly tests against outcomes, never advice, and
// never gates anything. Renders nothing until the vocab + today's state are both in.
let _tagToggleInFlight = false;
async function loadTagChips(): Promise<void> {
  const slot = view.querySelector<HTMLElement>("#tagsSlot");
  if (!slot) return;
  let vocab: CaptureContextTagDef[] = [];
  let tagged: CaptureContextTag[] = [];
  try {
    [vocab, tagged] = await Promise.all([
      api("/context-tags/vocab") as Promise<CaptureContextTagDef[]>,
      api("/context-tags?date=" + localISO()) as Promise<CaptureContextTag[]>,
    ]);
  } catch { return; }
  if (state.tab !== "today" || !slot.isConnected) return;
  if (!Array.isArray(vocab) || !vocab.length) { slot.innerHTML = ""; return; }
  const onKeys = new Set((Array.isArray(tagged) ? tagged : []).map((t) => t.key));
  renderTagChips(slot, vocab, onKeys);
}

function renderTagChips(slot: HTMLElement, vocab: CaptureContextTagDef[], onKeys: Set<string>): void {
  const chips = vocab.map((t) =>
    `<button class="tag-chip${onKeys.has(t.key) ? " tag-chip-on" : ""}" data-tag="${escAttr(t.key)}" type="button">${escHtml(t.label)}</button>`
  ).join("");
  slot.innerHTML = `<div class="tags-chips">${chips}</div>`;
  slot.querySelectorAll<HTMLElement>("[data-tag]").forEach((b) =>
    b.addEventListener("click", () => toggleTagChip(b)));
}

async function toggleTagChip(chip: HTMLElement): Promise<void> {
  if (_tagToggleInFlight) return;
  const key = chip.dataset.tag;
  if (!key) return;
  _tagToggleInFlight = true;
  try {
    const res = await api("/context-tags/toggle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }) as CaptureContextTagToggleResponse;
    if (res && !res.error) {
      chip.classList.toggle("tag-chip-on", !!res.on);
    } else {
      toast("Couldn't save that — try again.");
    }
  } catch { toast("Couldn't save that — try again."); }
  _tagToggleInFlight = false;
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
  loadCheckin,
  loadTagChips,
  loadTodayReads,
  reconnectInsight,
});

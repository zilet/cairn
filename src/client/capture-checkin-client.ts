// @ts-check
// The morning check-in (Today's Brief, rest/easy reads): three quiet scales, a save
// lane that answers every tap in-frame, and a date-keyed paint memo. Loaded ahead of
// capture.ts, which keeps `loadCheckin` as the Brief's entry point.

function checkinFailureIsTransient(error: unknown): boolean {
  const classify = (globalThis as unknown as {
    CairnApiCache?: { isTransientApiFailure?: (value: unknown) => boolean };
  }).CairnApiCache?.isTransientApiFailure;
  return typeof classify === "function" ? classify(error) : true;
}

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

// The check-in line as it last stood today, remembered on this device so the next
// paint of the Brief carries it in the SAME frame — the answered sentence or the
// open form — instead of an empty slot that fills a round trip later and pushes the
// rest of the Brief down under the reader. Date-keyed: yesterday's answer never
// paints on today's Brief. The network read below reconciles it.
const CHECKIN_PAINT_KEY = "cairn.checkin.paint.v1";
type CheckinPaintMemo = { iso: string; answered: Partial<Record<CheckinField["key"], number>> | null };

function readCheckinPaint(iso: string): CheckinPaintMemo | null {
  try {
    const raw = localStorage.getItem(CHECKIN_PAINT_KEY);
    if (!raw) return null;
    const memo = JSON.parse(raw) as CheckinPaintMemo | null;
    return memo && memo.iso === iso ? memo : null;
  } catch {
    return null;
  }
}

function writeCheckinPaint(iso: string, answered: Partial<Record<CheckinField["key"], number>> | null): void {
  try {
    localStorage.setItem(CHECKIN_PAINT_KEY, JSON.stringify({ iso, answered }));
  } catch { /* private mode / full storage — the next paint just waits for the read */ }
}

function checkinAnsweredFields(c: CaptureCheckin | null | undefined): Partial<Record<CheckinField["key"], number>> | null {
  if (!c) return null;
  const out: Partial<Record<CheckinField["key"], number>> = {};
  for (const field of CHECKIN_FIELDS) {
    const rung = checkinRung((c as unknown as Record<string, unknown>)[field.key]);
    if (rung != null) out[field.key] = rung;
  }
  return Object.keys(out).length ? out : null;
}

async function loadCaptureCheckin(): Promise<void> {
  const slot = view.querySelector<HTMLElement>("#checkinSlot");
  if (!slot) return;
  const today = localISO();
  const hadDraft = !!checkinDraftFor(today);
  // The watch already measured last night: nothing is pushed. The slot stays shut
  // behind one small optional link unless the athlete already answered or opened it.
  const quiet = slot.dataset.quiet === "1";
  // Same frame as the Brief: paint what this device last knew for today. It is
  // quiet (no entrance) because it is what was already on screen.
  if (!slot.innerHTML.trim() && !hadDraft) {
    const memo = readCheckinPaint(today);
    if (memo?.answered) {
      slot.classList.add("slot-quiet");
      renderCheckinDone(slot, memo.answered as unknown as CaptureCheckin);
    } else if (memo && !quiet && !checkinDismissedToday(today)) {
      slot.classList.add("slot-quiet");
      renderCheckinForm(slot, today);
    }
  }
  let existing: CaptureCheckin | null = null;
  try { existing = await api("/checkins?date=" + today) as CaptureCheckin | null; } catch { existing = null; }
  if (state.tab !== "today" || !slot.isConnected) return;
  // Mid-answer: the row stays a form until all three are in (or it is waved off).
  // A form already on screen is left completely alone — re-rendering under the
  // athlete's finger would drop the marks and the listeners mid-tap.
  // (A draft the memo paint opened with nothing tapped yet is not an answer in
  // progress — the server's word decides that row.)
  const draft = checkinDraftFor(today);
  const answering = !!draft && (hadDraft || Object.keys(draft.picked).length > 0);
  if (draft && answering && !checkinDraftComplete(draft)) {
    if (slot.querySelector(".checkin-form")) return;
    renderCheckinForm(slot, today);
    return;
  }
  if (checkinAnswered(existing)) {
    if (draft && !answering) _checkinDraft = null;
    writeCheckinPaint(today, checkinAnsweredFields(existing));
    renderCheckinDone(slot, existing as CaptureCheckin);
    return;
  }
  // Waved off this morning — stay gone until tomorrow. Asking again after a dismiss
  // is the definition of nagging.
  if (checkinDismissedToday(today)) { slot.innerHTML = ""; return; }
  if (quiet) {
    if (slot.querySelector(".checkin-form, .checkin-open")) return;
    slot.innerHTML = `<button class="linkbtn linkbtn-plain linkbtn-sm checkin-open" id="checkinOpen" type="button">Add how you feel</button>`;
    slot.querySelector("#checkinOpen")?.addEventListener("click", () => renderCheckinForm(slot, today));
    return;
  }
  writeCheckinPaint(today, null);
  if (slot.querySelector(".checkin-form")) return;
  renderCheckinForm(slot, today);
}

// ---- the check-in's save lane ----
// A tap is answered on screen in the same frame (the dots fill, the word is said);
// the write rides behind it. One save in flight at a time, and a tap that lands
// while one is out is folded into the NEXT save — every save carries everything
// answered so far (POST /checkins inserts, GET reads the newest), so the last one
// to land is always the whole answer, never a partial that raced past it. A lost
// connection queues the answer in the outbox (it replays on reconnect); a refusal
// puts the dots back to what is actually saved and says so.
type CheckinPicked = Partial<Record<CheckinField["key"], number>>;
let _checkinPending: { iso: string; picked: CheckinPicked } | null = null;
let _checkinSaving: Promise<void> | null = null;
let _checkinSaved: { iso: string; picked: CheckinPicked } | null = null;

function saveCheckin(iso: string, picked: CheckinPicked, onRefused: (saved: CheckinPicked) => void): Promise<void> {
  _checkinPending = { iso, picked: { ...picked } };
  if (!_checkinSaving) {
    _checkinSaving = drainCheckinSaves(onRefused).finally(() => { _checkinSaving = null; });
  }
  return _checkinSaving;
}

async function drainCheckinSaves(onRefused: (saved: CheckinPicked) => void): Promise<void> {
  let landed = false;
  while (_checkinPending) {
    const next = _checkinPending;
    _checkinPending = null;
    // Dated, so a save queued offline and replayed after midnight lands on its own day.
    const dated = { date: next.iso, ...next.picked };
    const body = JSON.stringify(dated);
    try {
      const saved = await api("/checkins", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      }) as CaptureCheckin;
      if (!saved || saved.error) throw new Error(String(saved?.error || "refused"));
      _checkinSaved = next;
      landed = true;
    } catch (error) {
      if (checkinFailureIsTransient(error) && typeof outboxEnqueue === "function") {
        const queued = await outboxEnqueue("checkin", "/checkins", dated).catch(() => null);
        if (queued) { _checkinSaved = next; continue; }
      }
      _checkinPending = null;
      const saved = _checkinSaved && _checkinSaved.iso === next.iso ? _checkinSaved.picked : {};
      onRefused(saved);
      toast("Couldn't save that — try again.");
      return;
    }
  }
  if (landed) checkinLanded();
}

// What a saved check-in changes: the Brief's read of the day, and the caches that
// carry it. Never a rebuild of Today — the Brief reconciles in place, once the
// answer has settled (all three in, or the athlete has left the row alone).
const CHECKIN_SETTLE_MS = 3500;
let _checkinRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function checkinLanded(): void {
  try {
    const invalidation = (globalThis as {
      CairnWriteInvalidation?: { targetsForChatAction?(type: string): readonly string[]; invalidate?(targets: readonly string[], opts?: { keep?: readonly string[] }): unknown };
    }).CairnWriteInvalidation;
    const targets = invalidation?.targetsForChatAction?.("log_checkin");
    // The Brief on screen is kept: it is reconciled in place just below. The day's
    // composition and prescription caches go too, so the next quiet repaint of the
    // plan surface reads a composition this check-in may have moved.
    if (targets) invalidation?.invalidate?.([...targets, "today:daily-session:", "today:session:"], { keep: ["@brief"] });
  } catch { /* cache hygiene is best-effort */ }
  scheduleCheckinBriefRefresh(checkinDraftComplete(_checkinDraft) || !_checkinDraft ? 450 : CHECKIN_SETTLE_MS);
}

function scheduleCheckinBriefRefresh(delayMs: number): void {
  const refresh = (globalThis as { refreshTodayBrief?: () => unknown }).refreshTodayBrief;
  if (typeof refresh !== "function" || typeof setTimeout !== "function") return;
  if (_checkinRefreshTimer) clearTimeout(_checkinRefreshTimer);
  _checkinRefreshTimer = setTimeout(() => {
    _checkinRefreshTimer = null;
    // Still mid-answer and still touching it: wait for the row to go quiet.
    if (_checkinSaving) { scheduleCheckinBriefRefresh(delayMs); return; }
    try { void refresh(); } catch { /* the Brief keeps its read */ }
  }, delayMs);
}

// A row changing height (the three scales folding into one sentence) eases from
// its old height to its new one (Today's shared helper) instead of snapping.
function settleCheckinHeight(slot: HTMLElement, write: () => void): void {
  const hold = (globalThis as { CairnTodaySlotHold?: { settleHeight(slot: HTMLElement, write: () => void): void } }).CairnTodaySlotHold;
  if (hold) hold.settleHeight(slot, write);
  else write();
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
  const paintScale = (field: CheckinField, val: number | null | undefined) => {
    // highlight selected + everything below it (a five-rung scale fill)
    slot.querySelectorAll<HTMLElement>(`.feel-dot[data-feel="${field.key}"]`).forEach((d) => {
      const on = val != null && Number(d.dataset.val) <= val;
      d.classList.toggle("feel-dot-on", on);
      d.setAttribute("aria-pressed", val != null && Number(d.dataset.val) === val ? "true" : "false");
    });
    const said = slot.querySelector<HTMLElement>(`[data-said="${field.key}"]`);
    if (said) said.innerHTML = val != null ? escHtml(field.done[val - 1]) : "";
  };
  // A refused save puts the marks back to what is actually saved — reopening the
  // row when it had already folded into its sentence.
  const rollback = (saved: CheckinPicked) => {
    if (!slot.isConnected) return;
    const draft = checkinDraftFor(today);
    if (!draft || !slot.querySelector(".checkin-form")) {
      _checkinDraft = { iso: today, picked: { ...saved } };
      writeCheckinPaint(today, null);
      renderCheckinForm(slot, today);
      return;
    }
    for (const field of CHECKIN_FIELDS) {
      if (saved[field.key] != null) draft.picked[field.key] = saved[field.key];
      else delete draft.picked[field.key];
      if (slot.querySelector(".checkin-form")) paintScale(field, draft.picked[field.key] ?? null);
    }
  };
  slot.querySelectorAll<HTMLElement>(".feel-dot").forEach((b) =>
    b.addEventListener("click", () => {
      const field = CHECKIN_FIELDS.find((f) => f.key === b.dataset.feel);
      if (!field) return Promise.resolve();
      const val = Number(b.dataset.val);
      picked[field.key] = val;
      // The answer is on screen in this frame; the network is behind it.
      slot.classList.remove("slot-quiet");
      paintScale(field, val);
      const complete = checkinDraftComplete({ iso: today, picked });
      if (complete) {
        // All three in: the row folds into the sentence right away, in place.
        _checkinDraft = null;
        writeCheckinPaint(today, { ...picked });
        settleCheckinHeight(slot, () => renderCheckinDone(slot, picked as unknown as CaptureCheckin));
      }
      return saveCheckin(today, picked, rollback);
    }));
  const dismiss = slot.querySelector("#checkinDismiss");
  if (dismiss) dismiss.addEventListener("click", () => {
    dismissCheckinForToday(today);
    // Waving off a half-answered row still keeps what was said — the answered
    // scales become the done line rather than vanishing.
    const answered = _checkinDraft && _checkinDraft.iso === today ? _checkinDraft.picked : null;
    _checkinDraft = null;
    if (answered && CHECKIN_FIELDS.some((field) => answered[field.key] != null)) {
      writeCheckinPaint(today, { ...answered });
      settleCheckinHeight(slot, () => renderCheckinDone(slot, answered as unknown as CaptureCheckin));
      // Done answering: the Brief can take the answer in now.
      if (_checkinSaved && _checkinSaved.iso === today) scheduleCheckinBriefRefresh(450);
      return;
    }
    settleCheckinHeight(slot, () => { slot.innerHTML = ""; });
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
  const html = `<div class="checkin-done chip-in"><span class="checkin-done-mark" aria-hidden="true">✓</span> ${escHtml(parts.join(" · "))}</div>`;
  // The same sentence already standing is left alone (no entrance re-played).
  const standing = slot.querySelector(".checkin-done");
  if (standing && standing.textContent === `✓ ${parts.join(" · ")}`) return;
  slot.innerHTML = html;
}

const CAIRN_CAPTURE_CHECKIN: Window["CairnCaptureCheckin"] = { loadCheckin: loadCaptureCheckin };
Object.assign(globalThis, { CairnCaptureCheckin: CAIRN_CAPTURE_CHECKIN });

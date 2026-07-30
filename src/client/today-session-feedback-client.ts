// @ts-check
// Today session feedback rendering and persistence helpers.
//
// PAIN & INJURY IS DISPLAY-ONLY. There is no composer, no movement dropdown, no
// pain-free/pain-present pair, no "it returned" form and no per-card movement check.
// The athlete reports pain the way they already talk — in their session note or in
// chat — and the agentic extraction lane derives the structure from those words
// (src/symptomCapture.ts). What survives here is what a person needs to SEE: their
// own words, how long it has been watched, what training has quietly shown since,
// and one tap to close it when it's gone.
//
// The structured write endpoints all still exist; they are the API/MCP surface an
// agent uses. What was removed is asking a HUMAN to fill them in.

type TodaySessionFeedbackStatusApi = {
  feedbackDoneHtml(session: Record<string, unknown> | null | undefined): string;
  feedbackFormHtml(session: Record<string, unknown> | null | undefined): string;
  feedbackOpenHtml(): string;
  hasFeedback(session: Record<string, unknown> | null | undefined): boolean;
};

type TodaySessionFeedbackDeps = {
  state: { logDate: string };
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  toast(message: string, options?: { action?: string; onAction?: () => void }): void;
  sessionStatus: TodaySessionFeedbackStatusApi;
};

type ClientTrainingSymptom = import("../contracts/client-api.js").ClientTrainingSymptom;

(() => {
  function responseRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }

  function renderFeedbackDone(slot: Element | null | undefined, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps): void {
    if (!slot) return;
    const html = deps.sessionStatus.feedbackDoneHtml(session);
    if (!html) {
      slot.innerHTML = "";
      return;
    }
    slot.innerHTML = html;
    slot.querySelector("#feedbackEdit")?.addEventListener("click", () => renderFeedbackForm(slot, session, deps));
    void renderSymptomLifecycle(slot, session, deps);
  }

  // Whether this feedback slot lives inside a finished-session DONE card. There the
  // 1-tap capture folds in OPEN (it's the natural "how did that feel" moment); the
  // mid-session finish slot keeps the quiet collapsed affordance so it never nags
  // between sets. Guarded — `closest` is absent under the vm test harness.
  function inDoneCard(slot: Element): boolean {
    return typeof (slot as Element & { closest?: (s: string) => Element | null }).closest === "function"
      ? !!slot.closest(".sessiondone")
      : false;
  }

  function renderFeedback(
    slot: Element | null | undefined,
    session: Record<string, unknown>,
    deps: TodaySessionFeedbackDeps,
    options?: { hasLoggedSets?: boolean }
  ): void {
    if (!slot) return;
    // No sets logged yet (a rest day, or before the first one) means there is no
    // session to rate — but the Pain & injury panel is the only place a note can be
    // closed, so it renders on its own rather than the whole slot staying empty.
    if (options && options.hasLoggedSets === false && !deps.sessionStatus.hasFeedback(session)) {
      slot.innerHTML = `<div data-symptom-lifecycle></div>`;
      void renderSymptomLifecycle(slot, session, deps);
      return;
    }
    if (deps.sessionStatus.hasFeedback(session)) {
      renderFeedbackDone(slot, session, deps);
      return;
    }
    // Fold the capture into the done moment: render the 1-tap form in place (not a
    // buried "how did that feel?" button) so the affordance is where the moment is.
    // Once answered it pre-dismisses to the compact done summary on the next render.
    if (inDoneCard(slot)) {
      renderFeedbackForm(slot, session, deps);
      return;
    }
    slot.innerHTML = deps.sessionStatus.feedbackOpenHtml();
    slot.querySelector("#feedbackOpen")?.addEventListener("click", () => renderFeedbackForm(slot, session, deps));
    void renderSymptomLifecycle(slot, session, deps);
  }

  // The calm settled line once both scales are in — a persistent confirmation that
  // the signal will bend next week, never a nag. (The reload state still shows the
  // recorded values with an edit affordance via feedbackDoneHtml.)
  function renderFeedbackNoted(slot: Element): void {
    slot.innerHTML = `<div class="checkin-done feedback-done chip-in">
      <span class="checkin-done-mark" aria-hidden="true">✓</span> Noted — it'll shape next week.
    </div><div data-symptom-lifecycle></div>`;
  }

  function movementCount(count: number): string {
    return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
  }

  // The quiet evidence line. Silence must never read as an all-clear: an exposure
  // Cairn inferred from a logged set is real evidence that the movement was trained
  // without incident, and nothing more, so the wording says exactly that much.
  function movementEvidenceHtml(symptom: ClientTrainingSymptom): string {
    const rows = Array.isArray(symptom.movement_readiness) ? symptom.movement_readiness : [];
    if (!rows.length) return "";
    return rows.map((movement) => {
      const count = Math.max(0, Number(movement.pain_free_exposures) || 0);
      if (!count) return "";
      const note = movement.inferred_only
        ? `Tolerated in training ${movementCount(count)} — no word from you yet.`
        : movement.trial_ready
          ? "Two pain-free sessions on record — enough for a careful recheck; the note stays open."
          : `${count} pain-free ${count === 1 ? "session" : "sessions"} on record.`;
      return `<div class="sess-line"><strong>${escHtml(movement.movement_name)}</strong> · ${escHtml(note)}</div>`;
    }).join("");
  }

  // Their own words, or — for a row that predates keeping them — the derived label,
  // which is all that row ever had.
  function symptomWords(symptom: ClientTrainingSymptom): string {
    const spoken = String(symptom.report_text ?? "").trim();
    return spoken || String(symptom.area_text ?? "").trim();
  }

  function symptomRowHtml(symptom: ClientTrainingSymptom): string {
    const words = symptomWords(symptom);
    if (symptom.status !== "active") {
      const closed = symptom.resolved_on ? String(symptom.resolved_on).slice(0, 10) : "";
      return `<div class="symptom-history-row" data-symptom-row="${escAttr(symptom.id)}">
        <div class="symptom-history-main">
          <span class="symptom-area">${escHtml(words)}</span>
          ${closed ? `<span class="symptom-resolved-on">closed ${escHtml(humanDate(closed))}</span>` : ""}
        </div>
      </div>`;
    }
    // An imported note is NOT a current finding — nobody has confirmed it since the
    // session it came from. Framing it as an ordinary "Watching" row states more
    // than the evidence does (the session primer already says this in words).
    const stateLabel = symptom.legacy_unconfirmed
      ? `<span class="symptom-watching symptom-unconfirmed">Older note · unconfirmed</span>`
      : `<span class="symptom-watching">Watching</span>`;
    const stateNote = symptom.legacy_unconfirmed
      ? `<div class="sess-line">Imported from an older session note. Mark it resolved if it's long gone, or just mention how it feels next time you write one.</div>`
      : "";
    const systemicNote = symptom.scope === "systemic"
      ? `<div class="sess-line">A whole-body note — it isn't tied to any one movement.</div>`
      : "";
    return `<article class="symptom-active-row well-accent-sm" data-symptom-row="${escAttr(symptom.id)}">
      <div class="symptom-row-heading"><span class="symptom-area">${escHtml(words)}</span>${stateLabel}</div>
      ${stateNote}
      ${systemicNote}
      ${movementEvidenceHtml(symptom)}
      <div class="symptom-row-actions" aria-label="Actions for ${escAttr(words)}">
        <button class="linkbtn linkbtn-quiet linkbtn-sm" type="button" data-symptom-resolve="${escAttr(symptom.id)}">Mark resolved</button>
      </div>
    </article>`;
  }

  function responseSymptoms(value: unknown): ClientTrainingSymptom[] {
    return Array.isArray(value)
      ? value.filter((entry): entry is ClientTrainingSymptom => !!entry && typeof entry === "object")
      : [];
  }

  async function renderSymptomLifecycle(
    slot: Element,
    session: Record<string, unknown>,
    deps: TodaySessionFeedbackDeps
  ): Promise<void> {
    const host = slot.querySelector<HTMLElement>("[data-symptom-lifecycle]");
    if (!host) return;
    let symptoms: ClientTrainingSymptom[];
    try {
      const viewedDate = encodeURIComponent(String(session.date || deps.state.logDate));
      symptoms = responseSymptoms(await deps.api(`/training-symptoms?on=${viewedDate}&include_resolved=1`));
    } catch {
      host.innerHTML = `<section class="symptom-lifecycle symptom-lifecycle-error" aria-label="Pain and injury"><div class="feedback-prompt lbl">Pain &amp; injury</div><p>Notes couldn't load right now.</p></section>`;
      return;
    }
    if (!host.isConnected && typeof (host as HTMLElement & { isConnected?: boolean }).isConnected === "boolean") return;
    const activeSymptoms = symptoms.filter((symptom) => symptom.status === "active");
    const resolvedSymptoms = symptoms.filter((symptom) => symptom.status !== "active");
    const activeSummary = activeSymptoms.length
      ? `${activeSymptoms.length} active ${activeSymptoms.length === 1 ? "note" : "notes"}`
      : "No active notes.";
    host.innerHTML = `<section class="symptom-lifecycle" aria-label="Pain and injury">
      <div class="symptom-lifecycle-head">
        <div><div class="feedback-prompt lbl">Pain &amp; injury</div><p>${escHtml(activeSummary)}</p></div>
      </div>
      ${activeSymptoms.length ? `<div class="symptom-active-list">${activeSymptoms.map(symptomRowHtml).join("")}</div>` : ""}
      <p class="symptom-capture-hint sess-line">Mention pain in your session notes or chat — Cairn picks it up.</p>
      ${resolvedSymptoms.length ? `<details class="symptom-history"><summary>Resolved history <span>${resolvedSymptoms.length}</span></summary><div class="symptom-history-list">${resolvedSymptoms.map(symptomRowHtml).join("")}</div></details>` : ""}
    </section>`;

    const reload = () => renderSymptomLifecycle(slot, session, deps);
    // Closing a note is a lifecycle TAP, not a form — the one thing here that is
    // genuinely the athlete's decision rather than a description of it.
    host.querySelectorAll<HTMLElement>("[data-symptom-resolve]").forEach((button) =>
      button.addEventListener("click", async () => {
        try {
          await deps.api(`/training-symptoms/${button.dataset.symptomResolve}/resolve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ on: String(session.date || deps.state.logDate) }),
          });
          deps.toast("Marked resolved");
          await reload();
        } catch {
          deps.toast("Couldn't update that note — try again.");
        }
      }));
  }

  function renderFeedbackForm(slot: Element, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps): void {
    slot.innerHTML = deps.sessionStatus.feedbackFormHtml(session);
    void renderSymptomLifecycle(slot, session, deps);
    const date = String(session.date || deps.state.logDate);
    const picked: Record<string, number | undefined> = {};
    // A save is confirmed only when the server accepts it (no {error}, no network
    // throw). Returning that truth lets the tap handler avoid a lying "Noted".
    const save = async (): Promise<boolean> => {
      const joint = slot.querySelector<HTMLInputElement>("#feedbackJoint");
      const jointVal = joint ? joint.value.trim() : "";
      try {
        const saved = await deps.api(`/sessions/${date}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            soreness: picked.soreness,
            performance: picked.performance,
            joint_pain: jointVal || null,
          }),
        });
        const row = responseRecord(saved);
        if (row.error) return false;
        Object.assign(session, row);
        // The words the athlete typed are captured verbatim server-side and the
        // extraction lane derives the record from them; the client no longer opens
        // one itself. Re-render so anything already derived shows up.
        if (jointVal) void renderSymptomLifecycle(slot, session, deps);
        return true;
      } catch {
        return false;
      }
    };

    // Confirm once, and only on a real save — this is optional signal, so a failed
    // write stays silent rather than nagging or (worse) faking a "Noted".
    let notified = false;
    slot.querySelectorAll<HTMLElement>(".feel-dot").forEach((button) =>
      button.addEventListener("click", async () => {
        const kind = String(button.dataset.feel || "");
        const val = Number(button.dataset.val);
        const dots = [...slot.querySelectorAll<HTMLElement>(`.feel-dot[data-feel="${kind}"]`)];
        // Optimistic apply — but snapshot the prior selection + fill so a rejected
        // write rolls back instead of silently desyncing the dots from the truth.
        const prevVal = picked[kind];
        const prevOn = dots.map((dot) => dot.classList.contains("feel-dot-on"));
        picked[kind] = val;
        dots.forEach((dot) => dot.classList.toggle("feel-dot-on", Number(dot.dataset.val) <= val));
        const ok = await save();
        if (ok) {
          if (!notified) {
            notified = true;
            deps.toast("Noted");
          }
          // Both scales in → collapse to the calm settled line (the joint note, if
          // any, was already carried on this same save). The finish moment stays two
          // taps, never a lingering form.
          if (picked.soreness != null && picked.performance != null) renderFeedbackNoted(slot);
          if (picked.soreness != null && picked.performance != null) void renderSymptomLifecycle(slot, session, deps);
          return;
        }
        // Roll back the optimistic fill to exactly what was showing before the tap.
        picked[kind] = prevVal;
        dots.forEach((dot, index) => dot.classList.toggle("feel-dot-on", prevOn[index]));
        deps.toast("Couldn't save that — try again.");
      }));

    // The joint free-text starts collapsed behind "anything ache?"; reveal it in place.
    const jointToggle = slot.querySelector<HTMLElement>("#feedbackJointToggle");
    const joint = slot.querySelector<HTMLInputElement>("#feedbackJoint");
    jointToggle?.addEventListener("click", () => {
      jointToggle.hidden = true;
      if (joint) {
        joint.hidden = false;
        joint.focus();
      }
    });
    if (joint) joint.addEventListener("change", () => {
      if (picked.soreness || picked.performance || joint.value.trim()) void save();
    });
    slot.querySelector("#feedbackDismiss")?.addEventListener("click", () => {
      slot.innerHTML = "";
    });
  }

  const CAIRN_TODAY_SESSION_FEEDBACK = {
    renderFeedback,
  };

  Object.assign(globalThis, { CairnTodaySessionFeedback: CAIRN_TODAY_SESSION_FEEDBACK });

  if (typeof window !== "undefined") {
    window.CairnTodaySessionFeedback = CAIRN_TODAY_SESSION_FEEDBACK;
  }
})();

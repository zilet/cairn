// @ts-check
// Today session feedback rendering and persistence helpers.

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

  function renderFeedback(slot: Element | null | undefined, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps): void {
    if (!slot) return;
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
  }

  function renderFeedbackForm(slot: Element, session: Record<string, unknown>, deps: TodaySessionFeedbackDeps): void {
    slot.innerHTML = deps.sessionStatus.feedbackFormHtml(session);
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
          return;
        }
        // Roll back the optimistic fill to exactly what was showing before the tap.
        picked[kind] = prevVal;
        dots.forEach((dot, index) => dot.classList.toggle("feel-dot-on", prevOn[index]));
        deps.toast("Couldn't save that — try again.");
      }));

    const joint = slot.querySelector<HTMLInputElement>("#feedbackJoint");
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

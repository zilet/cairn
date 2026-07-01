(() => {
// @ts-check
// Today session feedback rendering and persistence helpers.
(() => {
    function responseRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function renderFeedbackDone(slot, session, deps) {
        if (!slot)
            return;
        const html = deps.sessionStatus.feedbackDoneHtml(session);
        if (!html) {
            slot.innerHTML = "";
            return;
        }
        slot.innerHTML = html;
        slot.querySelector("#feedbackEdit")?.addEventListener("click", () => renderFeedbackForm(slot, session, deps));
    }
    function renderFeedback(slot, session, deps) {
        if (!slot)
            return;
        if (deps.sessionStatus.hasFeedback(session)) {
            renderFeedbackDone(slot, session, deps);
            return;
        }
        slot.innerHTML = deps.sessionStatus.feedbackOpenHtml();
        slot.querySelector("#feedbackOpen")?.addEventListener("click", () => renderFeedbackForm(slot, session, deps));
    }
    function renderFeedbackForm(slot, session, deps) {
        slot.innerHTML = deps.sessionStatus.feedbackFormHtml(session);
        const date = String(session.date || deps.state.logDate);
        const picked = {};
        // A save is confirmed only when the server accepts it (no {error}, no network
        // throw). Returning that truth lets the tap handler avoid a lying "Noted".
        const save = async () => {
            const joint = slot.querySelector("#feedbackJoint");
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
                if (row.error)
                    return false;
                Object.assign(session, row);
                return true;
            }
            catch {
                return false;
            }
        };
        // Confirm once, and only on a real save — this is optional signal, so a failed
        // write stays silent rather than nagging or (worse) faking a "Noted".
        let notified = false;
        slot.querySelectorAll(".feel-dot").forEach((button) => button.addEventListener("click", async () => {
            const kind = String(button.dataset.feel || "");
            const val = Number(button.dataset.val);
            picked[kind] = val;
            slot.querySelectorAll(`.feel-dot[data-feel="${kind}"]`).forEach((dot) => dot.classList.toggle("feel-dot-on", Number(dot.dataset.val) <= val));
            const ok = await save();
            if (ok && !notified) {
                notified = true;
                deps.toast("Noted");
            }
        }));
        const joint = slot.querySelector("#feedbackJoint");
        if (joint)
            joint.addEventListener("change", () => {
                if (picked.soreness || picked.performance || joint.value.trim())
                    void save();
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
})();

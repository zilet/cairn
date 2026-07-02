(() => {
// @ts-check
// Shared transient UI actions: toast and two-tap destructive confirmation.
{
    let toastTimer = null;
    function showToast(msg, opts = {}) {
        let toastEl = document.querySelector(".toast");
        if (!toastEl) {
            toastEl = document.createElement("div");
            toastEl.className = "toast";
            // Announced to assistive tech: a transient, non-interrupting status line.
            toastEl.setAttribute("role", "status");
            toastEl.setAttribute("aria-live", "polite");
            toastEl.setAttribute("aria-atomic", "true");
            document.body.appendChild(toastEl);
        }
        if (toastTimer)
            clearTimeout(toastTimer);
        if (opts.action) {
            toastEl.textContent = "";
            const span = document.createElement("span");
            span.textContent = String(msg);
            const btn = document.createElement("button");
            btn.className = "toast-act";
            btn.textContent = opts.action;
            btn.addEventListener("click", () => {
                if (toastTimer)
                    clearTimeout(toastTimer);
                toastEl.classList.remove("show", "toast-actionable");
                opts.onAction && opts.onAction();
            });
            toastEl.append(span, btn);
            toastEl.classList.add("toast-actionable");
        }
        else {
            toastEl.textContent = String(msg);
            toastEl.classList.remove("toast-actionable");
        }
        toastEl.classList.add("show");
        toastTimer = setTimeout(() => toastEl.classList.remove("show", "toast-actionable"), opts.action ? 5000 : 1400);
    }
    function armDestructiveAction(btn, onConfirm, { label = "remove?" } = {}) {
        if (!btn)
            return;
        const target = btn;
        if (target.dataset.armed) {
            onConfirm();
            return;
        }
        if (!target.dataset.restGlyph)
            target.dataset.restGlyph = target.textContent || "×";
        target.dataset.armed = "1";
        target.classList.add("armed");
        target.textContent = label;
        const reset = () => {
            delete target.dataset.armed;
            target.classList.remove("armed");
            target.textContent = target.dataset.restGlyph || "×";
            clearTimeout(timer);
        };
        const timer = setTimeout(reset, 3000);
        target.addEventListener("blur", reset, { once: true });
    }
    const CAIRN_UI_ACTIONS = {
        armDelete: armDestructiveAction,
        toast: showToast,
    };
    Object.assign(globalThis, { CairnUiActions: CAIRN_UI_ACTIONS });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnUiActions: CAIRN_UI_ACTIONS });
    }
}
})();

(() => {
// @ts-check
// Today session skip/restore and off-plan removal helpers.
(() => {
    function responseRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function addSkipName(name, deps) {
        const line = deps.root.querySelector("#skipLine");
        const names = line?.querySelector(".skipline-names");
        if (!line || !names)
            return;
        const dup = [...names.querySelectorAll("[data-unskip]")]
            .some((button) => decodeURIComponent(button.dataset.unskip || "").toLowerCase() === name.toLowerCase());
        if (!dup) {
            const tpl = document.createElement("template");
            tpl.innerHTML = deps.sessionStatus.skipNameHtml(name).trim();
            const el = tpl.content.firstElementChild;
            if (!el)
                return;
            el.classList.add("chip-in");
            names.appendChild(el);
        }
        line.classList.remove("skipline-empty");
    }
    function removeSkipName(name, deps) {
        const line = deps.root.querySelector("#skipLine");
        if (!line)
            return;
        [...line.querySelectorAll("[data-unskip]")]
            .filter((button) => decodeURIComponent(button.dataset.unskip || "").toLowerCase() === name.toLowerCase())
            .forEach((button) => button.remove());
        if (!line.querySelector("[data-unskip]"))
            line.classList.add("skipline-empty");
    }
    async function skipFromCard(card, exercise, deps) {
        if (!card)
            return;
        let result;
        try {
            result = responseRecord(await deps.api("/sessions/skip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ date: deps.state.logDate, exercise }),
            }));
        }
        catch {
            deps.toast("Couldn't skip — try again");
            return;
        }
        if (result.ok !== true) {
            deps.toast(result.error ? "Sets already logged — delete them first" : "Couldn't skip — try again");
            return;
        }
        deps.invalidate("today:session:" + deps.state.logDate);
        const anchor = card.nextElementSibling;
        deps.collapseEl(card, () => {
            card.remove();
            addSkipName(exercise, deps);
            if (deps.state.tab === "today")
                void deps.renderToday({ soft: true });
        });
        deps.toast(`${exercise} skipped today`, { action: "Undo", onAction: () => { void undoSkip(card, anchor, exercise, deps); } });
    }
    async function undoSkip(card, anchor, exercise, deps) {
        try {
            await deps.api("/sessions/skip", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ date: deps.state.logDate, exercise }),
            });
        }
        catch {
            deps.toast("Couldn't restore — try again");
            return;
        }
        deps.invalidate("today:session:" + deps.state.logDate);
        if (deps.state.tab !== "today")
            return;
        removeSkipName(exercise, deps);
        if (!card.isConnected) {
            const before = anchor && anchor.isConnected ? anchor : deps.root.querySelector(".addex");
            if (!before || !before.parentNode) {
                deps.renderToday();
                return;
            }
            before.parentNode.insertBefore(card, before);
        }
        deps.expandEl(card);
    }
    function removeOffPlanCard(card, deps) {
        if (!card)
            return;
        const name = card.dataset.card;
        const pending = deps.state.pendingOffPlan?.[deps.state.logDate];
        if (name && pending) {
            deps.state.pendingOffPlan[deps.state.logDate] = pending.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
        }
        deps.collapseEl(card, () => card.remove());
    }
    function wireSkips(deps) {
        deps.root.querySelectorAll(".ex-skip").forEach((button) => {
            if (button.dataset.wired)
                return;
            button.dataset.wired = "1";
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                const card = button.closest(".ex");
                if (button.hasAttribute("data-remove-card")) {
                    removeOffPlanCard(card, deps);
                    return;
                }
                void skipFromCard(card, decodeURIComponent(button.dataset.skip || ""), deps);
            });
        });
        const line = deps.root.querySelector("#skipLine");
        if (line && !line.dataset.wired) {
            line.dataset.wired = "1";
            line.addEventListener("click", async (event) => {
                const button = event.target?.closest("[data-unskip]");
                if (!button)
                    return;
                const exercise = decodeURIComponent(button.dataset.unskip || "");
                try {
                    await deps.api("/sessions/skip", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ date: deps.state.logDate, exercise }),
                    });
                }
                catch {
                    deps.toast("Couldn't restore — try again");
                    return;
                }
                deps.invalidate("today:session:" + deps.state.logDate);
                deps.toast(`${exercise} is back on`);
                deps.renderToday();
            });
        }
    }
    const CAIRN_TODAY_SESSION_SKIP = {
        wireSkips,
    };
    Object.assign(globalThis, { CairnTodaySessionSkip: CAIRN_TODAY_SESSION_SKIP });
    if (typeof window !== "undefined") {
        window.CairnTodaySessionSkip = CAIRN_TODAY_SESSION_SKIP;
    }
})();
})();

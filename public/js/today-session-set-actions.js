(() => {
// @ts-check
// Today session set actions: log rows, delete chips, and update local set UI after commits.
(() => {
    function wireDeletes(deps) {
        deps.root.querySelectorAll("[data-del]").forEach((button) => {
            if (button.dataset.wired)
                return;
            button.dataset.wired = "1";
            button.addEventListener("click", async (event) => {
                event.stopPropagation();
                await deps.api(`/sets/${button.dataset.del}`, { method: "DELETE" });
                CairnTodaySessionSetModel.invalidateSetTruth(deps);
                deps.renderToday();
            });
        });
    }
    function bumpProgress(card) {
        const prog = card.querySelector("[data-prog]");
        if (!prog)
            return;
        const done = card.querySelectorAll("[data-logged] .chip").length;
        const goal = Number((prog.textContent?.match(/\/\s*(\d+)/) || [])[1] || 0);
        prog.innerHTML = `${done}${goal ? ` / ${goal}` : ""} <span>set${done === 1 && !goal ? "" : "s"}</span>`;
        const complete = goal && done >= goal;
        prog.classList.toggle("done", !!complete);
        card.classList.toggle("ex-complete", !!complete);
    }
    function refreshFinishStat(deps) {
        const chips = deps.root.querySelectorAll(".ex [data-logged] .chip");
        if (!chips.length)
            return false;
        const stat = deps.root.querySelector("[data-finishstat]");
        if (!stat) {
            deps.withViewTransition(() => Promise.resolve(deps.renderToday()).then(() => deps.viewEnter()));
            return true;
        }
        let sets = 0;
        let tonnage = 0;
        chips.forEach((chip) => {
            sets++;
            const match = chip.textContent?.match(/(-?\d+(?:\.\d+)?)\s*×\s*(\d+)/);
            if (match) {
                const wt = Number(match[1]);
                const reps = Number(match[2]);
                if (wt > 0)
                    tonnage += wt * reps;
            }
        });
        const isToday = deps.state.logDate === deps.localISO();
        stat.textContent = `${sets} sets · ${Math.round(tonnage).toLocaleString()} lb ${isToday ? "logged today" : "on " + deps.state.logDate}`;
        return false;
    }
    function wireLogRow(row, deps) {
        if (!(row instanceof HTMLElement))
            return;
        const logBtn = row.querySelector(".logbtn");
        if (!logBtn || logBtn.dataset.wired)
            return;
        logBtn.dataset.wired = "1";
        logBtn.addEventListener("click", async () => {
            if (logBtn.disabled)
                return;
            const payload = CairnTodaySessionSetModel.logPayloadFromRow(row, deps);
            if (!payload.ok) {
                deps.toast(payload.message);
                payload.focus?.();
                return;
            }
            logBtn.disabled = true;
            let result;
            try {
                result = CairnTodaySessionSetModel.responseRecord(await deps.api("/sets", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload.body),
                }));
            }
            catch {
                logBtn.disabled = false;
                deps.toast("Couldn't log that set — check your connection.");
                return;
            }
            logBtn.disabled = false;
            if (!result || result.ok === false || result.error || result.id == null) {
                deps.toast(result && result.error ? String(result.error) : "Couldn't log that set.");
                return;
            }
            CairnTodaySessionSetModel.invalidateSetTruth(deps);
            const card = row.closest(".ex");
            const loggedWrap = card?.querySelector("[data-logged]");
            const tpl = document.createElement("template");
            tpl.innerHTML = deps.sessionStatus.setChipHtml(result).trim();
            const chipEl = tpl.content.firstElementChild;
            if (!card || !loggedWrap || !chipEl)
                return;
            chipEl.classList.add("chip-in");
            loggedWrap.appendChild(chipEl);
            wireDeletes(deps);
            bumpProgress(card);
            card.querySelector(".ex-skip")?.remove();
            if (result.pr) {
                deps.toast("🏆 New PR!");
                if (typeof navigator !== "undefined" && navigator.vibrate)
                    navigator.vibrate([60, 40, 120]);
            }
            else {
                deps.toast("Set logged");
            }
            deps.startRest();
            if (!refreshFinishStat(deps))
                deps.scheduleRxRefresh();
        });
    }
    const CAIRN_TODAY_SESSION_SET_ACTIONS = {
        wireDeletes,
        wireLogRow,
        refreshFinishStat,
    };
    Object.assign(globalThis, { CairnTodaySessionSetActions: CAIRN_TODAY_SESSION_SET_ACTIONS });
    if (typeof window !== "undefined") {
        window.CairnTodaySessionSetActions = CAIRN_TODAY_SESSION_SET_ACTIONS;
    }
})();
})();

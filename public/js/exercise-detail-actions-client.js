(() => {
// @ts-check
// Exercise detail modal action wiring.
function exerciseDetailActionRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function wireExerciseDetailActions(el, row, fallbackName, timed, deps) {
    const displayName = String(row.name || fallbackName);
    el.querySelector("#askForm")?.addEventListener("click", () => {
        deps.closeDetail(true);
        deps.gotoChatWith(`How should I perform ${fallbackName} with good form? Flag anything for my injury constraints.`);
    });
    const typeBtn = el.querySelector("#exType");
    if (typeBtn)
        typeBtn.addEventListener("click", async () => {
            typeBtn.disabled = true;
            const next = timed ? "reps" : "timed";
            try {
                await deps.postExerciseMode(displayName, next);
                if (deps.state.exModes)
                    deps.state.exModes[displayName] = next;
                deps.toast(`${displayName} is now ${next === "timed" ? "timed (hold)" : "reps-based"}`);
                deps.closeDetail(true);
                if (deps.state.tab === "today")
                    deps.renderToday();
            }
            catch {
                typeBtn.disabled = false;
                deps.toast("Couldn't change type — try again");
            }
        });
    const deleteBtn = el.querySelector("#exDelete");
    if (deleteBtn)
        deleteBtn.addEventListener("click", async () => {
            deleteBtn.disabled = true;
            let result;
            try {
                result = exerciseDetailActionRecord(await deps.api("/exercises/" + encodeURIComponent(displayName), { method: "DELETE" }));
            }
            catch {
                deleteBtn.disabled = false;
                deps.toast("Couldn't delete — try again");
                return;
            }
            if (result && result.ok) {
                deps.toast(`Deleted ${displayName}`);
                deps.closeDetail(true);
                if (deps.state.tab === "today")
                    deps.renderToday();
            }
            else {
                deleteBtn.disabled = false;
                deps.toast(result && result.error ? `Can't delete ${displayName}. ${result.error}` : "Couldn't delete");
            }
        });
}
const CAIRN_EXERCISE_DETAIL_ACTIONS = {
    wireActions: wireExerciseDetailActions,
};
Object.assign(globalThis, { CairnExerciseDetailActions: CAIRN_EXERCISE_DETAIL_ACTIONS });
if (typeof window !== "undefined") {
    window.CairnExerciseDetailActions = CAIRN_EXERCISE_DETAIL_ACTIONS;
}
})();

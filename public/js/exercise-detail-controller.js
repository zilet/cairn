(() => {
// @ts-check
// Exercise detail modal controller: guide wiring, explanation hydration, and exercise actions.
(() => {
    function exerciseExplanation(row, deps) {
        return CairnExerciseDetailExplanation.exerciseExplanation(row, deps);
    }
    function exerciseExplanationHtml(row, explanation, deps) {
        return CairnExerciseDetailExplanation.exerciseExplanationHtml(row, explanation, deps);
    }
    function replaceExerciseExplanation(el, row, explanation, deps) {
        CairnExerciseDetailExplanation.replaceExerciseExplanation(el, row, explanation, deps);
    }
    async function hydrateExerciseExplanation(el, row, deps) {
        await CairnExerciseDetailExplanation.hydrateExerciseExplanation(el, row, deps);
    }
    function wireGuides(scope, deps) {
        (scope || deps.root).querySelectorAll("[data-guide]").forEach((button) => {
            const wiredButton = button;
            if (wiredButton._wired)
                return;
            wiredButton._wired = true;
            const name = decodeURIComponent(String(button.dataset.guide || ""));
            const tileOf = () => button.closest(".ex, .prog-row")?.querySelector(".artile") || null;
            button.addEventListener("click", () => {
                void openExerciseModal(name, tileOf(), deps);
            });
            const tile = tileOf();
            if (tile && !tile._wired) {
                tile._wired = true;
                tile.style.cursor = "pointer";
                tile.addEventListener("click", () => {
                    void openExerciseModal(name, tile, deps);
                });
            }
        });
    }
    async function openExerciseModal(nameInput, fromTile, deps) {
        const name = String(nameInput || "");
        const row = CairnExerciseDetailData.record(await deps.api("/exercise/" + encodeURIComponent(name)));
        const svg = deps.art("exercise", name, row?.muscle_group);
        if (!row || !row.found) {
            deps.openDetailFrom(fromTile, () => {
                deps.mountDetail(CairnExerciseDetailRender.missingHtml(name, svg, deps));
                deps.wireDetailCommon();
            });
            return;
        }
        const view = CairnExerciseDetailData.view(row, deps);
        deps.openDetailFrom(fromTile, () => {
            const el = deps.mountDetail(CairnExerciseDetailRender.modalHtml(row, name, svg, view, exerciseExplanationHtml(row, null, deps), deps));
            deps.runCountUps(el);
            deps.wireDetailCommon();
            void hydrateExerciseExplanation(el, row, deps);
            CairnExerciseDetailActions.wireActions(el, row, name, view.timed, deps);
        });
    }
    const CAIRN_EXERCISE_DETAIL_CONTROLLER = {
        exerciseExplanation,
        exerciseExplanationHtml,
        hydrateExerciseExplanation,
        openExerciseModal,
        replaceExerciseExplanation,
        wireGuides,
    };
    Object.assign(globalThis, { CairnExerciseDetailController: CAIRN_EXERCISE_DETAIL_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnExerciseDetailController = CAIRN_EXERCISE_DETAIL_CONTROLLER;
    }
})();
})();

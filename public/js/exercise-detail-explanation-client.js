(() => {
// @ts-check
// Exercise detail explanation hydration and replacement.
const exerciseExplanationMisses = new Set();
function exerciseDetailExplanationClientRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function exerciseDetailExplanationValue(row, deps) {
    return deps.exerciseDetail.explanation(row);
}
function exerciseDetailExplanationHtmlValue(row, explanation, deps) {
    return deps.exerciseDetail.explanationHtml(row, explanation);
}
function validExerciseDetailHydrationPayload(value, deps) {
    return deps.exerciseDetail.validExplanationPayload(exerciseDetailExplanationClientRecord(value));
}
function replaceExerciseDetailExplanation(el, row, explanation, deps) {
    const current = el.querySelector("[data-exercise-explain]");
    if (!current || current.dataset.exercise !== String(row?.name || ""))
        return;
    const wrap = document.createElement("template");
    wrap.innerHTML = exerciseDetailExplanationHtmlValue(row, explanation, deps).trim();
    const next = wrap.content.firstElementChild;
    if (next)
        current.replaceWith(next);
}
async function hydrateExerciseExplanation(el, row, deps) {
    const key = String(row?.name || "");
    if (!key || exerciseExplanationMisses.has(key))
        return;
    try {
        const cached = await deps.api("/exercise/" + encodeURIComponent(key) + "/explanation");
        if (validExerciseDetailHydrationPayload(cached, deps)) {
            replaceExerciseDetailExplanation(el, row, cached.explanation, deps);
            if (!cached.stale)
                return;
        }
    }
    catch {
        return;
    }
    try {
        const generated = await deps.api("/exercise/" + encodeURIComponent(key) + "/explanation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agent: "auto" }),
        });
        if (validExerciseDetailHydrationPayload(generated, deps)) {
            replaceExerciseDetailExplanation(el, row, generated.explanation, deps);
        }
        else {
            exerciseExplanationMisses.add(key);
        }
    }
    catch {
        exerciseExplanationMisses.add(key);
    }
}
const CAIRN_EXERCISE_DETAIL_EXPLANATION = {
    exerciseExplanation: exerciseDetailExplanationValue,
    exerciseExplanationHtml: exerciseDetailExplanationHtmlValue,
    hydrateExerciseExplanation,
    replaceExerciseExplanation: replaceExerciseDetailExplanation,
    validExerciseExplanationPayload: validExerciseDetailHydrationPayload,
};
Object.assign(globalThis, { CairnExerciseDetailExplanation: CAIRN_EXERCISE_DETAIL_EXPLANATION });
if (typeof window !== "undefined") {
    window.CairnExerciseDetailExplanation = CAIRN_EXERCISE_DETAIL_EXPLANATION;
}
})();

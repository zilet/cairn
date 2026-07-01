// @ts-check
// Exercise detail explanation hydration and replacement.

type ExerciseDetailExplanationClientRecord = Record<string, unknown>;
type ExerciseDetailExplanationClientPayload = { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
type ExerciseDetailExplanationClientRow = ExerciseDetailExplanationClientRecord & {
  name?: string;
  muscle_group?: string;
};
type ExerciseDetailExplanationDeps = {
  api(path: string, opts?: RequestInit & { headers?: Record<string, string> }): Promise<unknown>;
  exerciseDetail: {
    explanation(row: ExerciseDetailExplanationClientRow | null | undefined): ExerciseDetailExplanationClientPayload;
    explanationHtml(row: ExerciseDetailExplanationClientRow | null | undefined, explanation?: ExerciseDetailExplanationClientPayload | null): string;
    validExplanationPayload(row: {
      ok?: unknown;
      explanation?: ExerciseDetailExplanationClientPayload | null | undefined;
      stale?: unknown;
    } | null | undefined): boolean;
  };
};

const exerciseExplanationMisses = new Set<string>();

function exerciseDetailExplanationClientRecord(value: unknown): ExerciseDetailExplanationClientRecord {
  return value && typeof value === "object" ? value as ExerciseDetailExplanationClientRecord : {};
}

function exerciseDetailExplanationValue(row: ExerciseDetailExplanationClientRow | null | undefined, deps: ExerciseDetailExplanationDeps): ExerciseDetailExplanationClientPayload {
  return deps.exerciseDetail.explanation(row);
}

function exerciseDetailExplanationHtmlValue(
  row: ExerciseDetailExplanationClientRow | null | undefined,
  explanation: ExerciseDetailExplanationClientPayload | null | undefined,
  deps: ExerciseDetailExplanationDeps,
): string {
  return deps.exerciseDetail.explanationHtml(row, explanation);
}

function validExerciseDetailHydrationPayload(
  value: unknown,
  deps: ExerciseDetailExplanationDeps,
): value is { explanation?: ExerciseDetailExplanationClientPayload | null; stale?: boolean } {
  return deps.exerciseDetail.validExplanationPayload(exerciseDetailExplanationClientRecord(value) as {
    ok?: unknown;
    explanation?: ExerciseDetailExplanationClientPayload | null | undefined;
    stale?: unknown;
  });
}

function replaceExerciseDetailExplanation(
  el: ParentNode,
  row: ExerciseDetailExplanationClientRow,
  explanation: ExerciseDetailExplanationClientPayload | null | undefined,
  deps: ExerciseDetailExplanationDeps,
): void {
  const current = el.querySelector<HTMLElement>("[data-exercise-explain]");
  if (!current || current.dataset.exercise !== String(row?.name || "")) return;
  const wrap = document.createElement("template");
  wrap.innerHTML = exerciseDetailExplanationHtmlValue(row, explanation, deps).trim();
  const next = wrap.content.firstElementChild;
  if (next) current.replaceWith(next);
}

async function hydrateExerciseExplanation(el: ParentNode, row: ExerciseDetailExplanationClientRow, deps: ExerciseDetailExplanationDeps): Promise<void> {
  const key = String(row?.name || "");
  if (!key || exerciseExplanationMisses.has(key)) return;
  try {
    const cached = await deps.api("/exercise/" + encodeURIComponent(key) + "/explanation");
    if (validExerciseDetailHydrationPayload(cached, deps)) {
      replaceExerciseDetailExplanation(el, row, cached.explanation, deps);
      if (!cached.stale) return;
    }
  } catch {
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
    } else {
      exerciseExplanationMisses.add(key);
    }
  } catch {
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

// @ts-check
// Exercise detail explanation hydration and replacement.

type ExerciseDetailExplanationClientRecord = Record<string, unknown>;
type ExerciseDetailExplanationClientPayload = { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
type ExerciseDetailExplanationClientRow = ExerciseDetailExplanationClientRecord & {
  name?: string;
  muscle_group?: string;
  explanation?: unknown;
  explanation_stale?: unknown;
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

// Explanations this app session has already seen, keyed by exercise name: a reopened
// sheet paints the real cues straight from here, never the generic template first.
type ExerciseDetailStoredExplanation = { explanation: ExerciseDetailExplanationClientPayload; stale: boolean };
const exerciseExplanationStore = new Map<string, ExerciseDetailStoredExplanation>();
// Exercises whose explanation was already (re)generated — or attempted — this session.
// A stale or missing one revalidates at most once per app session, whatever the outcome.
const exerciseExplanationRevalidated = new Set<string>();

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

function exerciseExplanationKey(row: ExerciseDetailExplanationClientRow | null | undefined): string {
  return String(row?.name || "").trim().toLowerCase();
}

function exerciseExplanationSignature(explanation: ExerciseDetailExplanationClientPayload | null | undefined): string {
  if (!explanation) return "";
  return JSON.stringify([explanation.setup, explanation.move, explanation.feel, explanation.avoid].map((part) => String(part ?? "")));
}

function validExerciseExplanationValue(
  explanation: unknown,
  deps: ExerciseDetailExplanationDeps,
): explanation is ExerciseDetailExplanationClientPayload {
  return !!explanation && typeof explanation === "object" &&
    deps.exerciseDetail.validExplanationPayload({ ok: true, explanation: explanation as ExerciseDetailExplanationClientPayload });
}

// What the sheet knows before any request: a fresh explanation from this session wins,
// then the one riding on the detail payload, then an older session copy. `known` is
// false only when the payload predates the explanation field and nothing is stored.
function exerciseExplanationInitialState(
  row: ExerciseDetailExplanationClientRow | null | undefined,
  deps: ExerciseDetailExplanationDeps,
): { entry: ExerciseDetailStoredExplanation | null; known: boolean } {
  const key = exerciseExplanationKey(row);
  if (!key) return { entry: null, known: true };
  const stored = exerciseExplanationStore.get(key) || null;
  if (stored && !stored.stale) return { entry: stored, known: true };
  const payloadCarries = !!row && "explanation" in row;
  if (payloadCarries && validExerciseExplanationValue(row?.explanation, deps)) {
    const entry = { explanation: row?.explanation as ExerciseDetailExplanationClientPayload, stale: row?.explanation_stale === true };
    exerciseExplanationStore.set(key, entry);
    return { entry, known: true };
  }
  if (stored) return { entry: stored, known: true };
  return { entry: null, known: payloadCarries };
}

/** The explanation the sheet should paint on open, or null for the generic template. */
function initialExerciseExplanation(
  row: ExerciseDetailExplanationClientRow,
  deps: ExerciseDetailExplanationDeps,
): ExerciseDetailExplanationClientPayload | null {
  return exerciseExplanationInitialState(row, deps).entry?.explanation || null;
}

async function hydrateExerciseExplanation(el: ParentNode, row: ExerciseDetailExplanationClientRow, deps: ExerciseDetailExplanationDeps): Promise<void> {
  const name = String(row?.name || "");
  const key = exerciseExplanationKey(row);
  if (!key) return;
  const initial = exerciseExplanationInitialState(row, deps);
  let current = initial.entry;
  // Painted from the store or the payload already — only an old payload asks again.
  if (!initial.known) {
    try {
      const cached = await deps.api("/exercise/" + encodeURIComponent(name) + "/explanation");
      if (validExerciseDetailHydrationPayload(cached, deps) && cached.explanation) {
        current = { explanation: cached.explanation, stale: cached.stale === true };
        exerciseExplanationStore.set(key, current);
        replaceExerciseDetailExplanation(el, row, current.explanation, deps);
      }
    } catch {
      return;
    }
  }
  if (current && !current.stale) return;
  if (exerciseExplanationRevalidated.has(key)) return;
  exerciseExplanationRevalidated.add(key);
  try {
    const generated = await deps.api("/exercise/" + encodeURIComponent(name) + "/explanation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "auto" }),
    });
    if (validExerciseDetailHydrationPayload(generated, deps) && generated.explanation) {
      const next = { explanation: generated.explanation, stale: generated.stale === true };
      exerciseExplanationStore.set(key, next);
      if (exerciseExplanationSignature(next.explanation) !== exerciseExplanationSignature(current?.explanation)) {
        replaceExerciseDetailExplanation(el, row, next.explanation, deps);
      }
    }
  } catch {
    /* the painted explanation stands; no second attempt this session */
  }
}

const CAIRN_EXERCISE_DETAIL_EXPLANATION = {
  exerciseExplanation: exerciseDetailExplanationValue,
  exerciseExplanationHtml: exerciseDetailExplanationHtmlValue,
  hydrateExerciseExplanation,
  initialExerciseExplanation,
  replaceExerciseExplanation: replaceExerciseDetailExplanation,
  validExerciseExplanationPayload: validExerciseDetailHydrationPayload,
};

Object.assign(globalThis, { CairnExerciseDetailExplanation: CAIRN_EXERCISE_DETAIL_EXPLANATION });

if (typeof window !== "undefined") {
  window.CairnExerciseDetailExplanation = CAIRN_EXERCISE_DETAIL_EXPLANATION;
}

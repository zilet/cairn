// @ts-check
// Pure Exercise detail helpers for the vanilla PWA.

type ExerciseDetailLike = {
  name?: unknown;
  muscle_group?: unknown;
};

type ExerciseExplanation = {
  setup?: unknown;
  move?: unknown;
  feel?: unknown;
  avoid?: unknown;
};

type ExerciseExplanationPayload = {
  ok?: unknown;
  explanation?: ExerciseExplanation | null;
};

function exerciseDetailLine(setup: string, move: string, feel: string, avoid = "Stop if pain changes your position or range."): ExerciseExplanation {
  return { setup, move, feel, avoid };
}

function exerciseDetailExplanation(exercise: ExerciseDetailLike | null | undefined): ExerciseExplanation {
  const name = String(exercise?.name || "").toLowerCase();
  const muscleGroup = String(exercise?.muscle_group || "").toLowerCase();

  if (/bulgarian|split squat|lunge/.test(name)) return exerciseDetailLine(
    "Front foot far enough forward that you can stay balanced; rear foot is just support.",
    "Lower under control with a slight torso lean, then drive through the front midfoot.",
    "Front-leg quad and glute. Stop short of any knee or hip pinch.",
    "Do not push off the rear leg or let the front knee cave inward."
  );
  if (/romanian|rdl|deadlift|hinge/.test(name) || muscleGroup.includes("posterior")) return exerciseDetailLine(
    "Soft knees, ribs down, bar or dumbbells close to the legs.",
    "Push the hips back until the hamstrings stretch, then stand tall without leaning back.",
    "Hamstrings and glutes, not the low back."
  );
  if (/squat/.test(name)) return exerciseDetailLine(
    "Feet planted, brace before each rep, eyes fixed slightly ahead.",
    "Sit between the hips, let knees track over toes, then drive the floor away.",
    "Quads and glutes with a stable torso."
  );
  if (/pull.?up|pulldown/.test(name)) return exerciseDetailLine(
    "Start tall with shoulders set down away from the ears.",
    "Pull elbows toward the ribs, pause with the chest lifted, then control the stretch.",
    "Lats and mid-back. Avoid turning it into a shrug."
  );
  if (/row/.test(name)) return exerciseDetailLine(
    "Brace the trunk and keep the chest quiet.",
    "Pull elbows back toward the pockets, pause, then return without rounding forward.",
    "Mid-back and lats, with minimal torso swing."
  );
  if (/overhead|shoulder press/.test(name)) return exerciseDetailLine(
    "Ribs down, glutes tight, forearms vertical.",
    "Press up and slightly back so the weight finishes over the shoulders.",
    "Shoulders and triceps without low-back arch."
  );
  if (/press/.test(name) && /incline|bench|db|dumbbell/.test(name)) return exerciseDetailLine(
    "Shoulder blades tucked, feet steady, elbows about 30-45 degrees from the body.",
    "Control the stretch, then press without letting the shoulders roll forward.",
    "Chest and triceps, not the front of the shoulder."
  );
  if (/lateral raise/.test(name)) return exerciseDetailLine(
    "Use a light load, slight lean, soft elbows.",
    "Lead with the elbows to shoulder height, pause briefly, then lower slowly.",
    "Side delts. If traps take over, go lighter."
  );
  if (/face pull|rear delt/.test(name)) return exerciseDetailLine(
    "Cable set high, light load, ribs down.",
    "Pull toward eye level with high elbows and rotate the hands back.",
    "Rear delts and upper back, not neck tension."
  );
  if (/curl/.test(name)) return exerciseDetailLine(
    "Elbows pinned near the ribs, wrists quiet.",
    "Curl without swinging, squeeze, then lower all the way under control.",
    "Biceps or forearms, depending on grip."
  );
  if (/triceps|pushdown|extension/.test(name)) return exerciseDetailLine(
    "Elbows stay fixed; shoulders stay out of it.",
    "Extend to a strong squeeze, then return until the triceps stretch.",
    "Triceps, with no elbow pain."
  );
  if (/calf/.test(name)) return exerciseDetailLine(
    "Use the full foot on the platform with knees tracking over toes.",
    "Sink into a deep stretch, pause, rise high, and pause again.",
    "Calves through the full range, no bouncing."
  );
  if (/leg extension/.test(name)) return exerciseDetailLine(
    "Seat set so the knee lines up with the machine pivot.",
    "Lift smoothly, pause near lockout, then lower without the stack bouncing.",
    "Quads, especially near the knee, without joint irritation."
  );
  if (/leg curl/.test(name)) return exerciseDetailLine(
    "Hips pinned down and knees lined up with the machine pivot.",
    "Curl to a hard squeeze, then take the eccentric slowly.",
    "Hamstrings, not hips lifting off the pad."
  );

  return exerciseDetailLine(
    "Pick a load you can control through the full comfortable range.",
    "Move deliberately, pause where the target muscle is working, and keep the reps repeatable.",
    "The target muscle should work more than joints or momentum."
  );
}

function exerciseDetailExplanationHtml(
  exercise: ExerciseDetailLike | null | undefined,
  explanation?: ExerciseExplanation | null,
): string {
  const value = explanation || exerciseDetailExplanation(exercise);
  if (!value) return "";
  const rows = [
    ["Set up", value.setup],
    ["Move", value.move],
    ["Feel", value.feel],
    ["Avoid", value.avoid],
  ].filter(([, text]) => text);
  return `<div class="detail-section ex-explain" data-exercise-explain data-exercise="${escAttr(exercise?.name || "")}">
      <div class="lbl">How to do it</div>
      ${rows.map(([label, text]) => `<div class="explain-row"><span>${escHtml(label)}</span><p>${escHtml(text)}</p></div>`).join("")}
    </div>`;
}

function validExerciseDetailExplanationPayload(value: ExerciseExplanationPayload | null | undefined): boolean {
  return !!(value && value.ok && value.explanation && value.explanation.setup && value.explanation.move && value.explanation.feel);
}

const CAIRN_EXERCISE_DETAIL = {
  explanation: exerciseDetailExplanation,
  explanationHtml: exerciseDetailExplanationHtml,
  validExplanationPayload: validExerciseDetailExplanationPayload,
};

Object.assign(globalThis, { CairnExerciseDetail: CAIRN_EXERCISE_DETAIL });

if (typeof window !== "undefined") {
  window.CairnExerciseDetail = CAIRN_EXERCISE_DETAIL;
}

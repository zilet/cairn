// @ts-check
// Progress Muscle trajectory presentation helpers.

type MuscleVaryOption = {
  name?: unknown;
  why?: unknown;
};

type MuscleGroupTrajectoryRow = {
  group?: unknown;
  label?: unknown;
  verdict?: unknown;
  lead_lift?: unknown;
  volume_band?: unknown;
  trend?: unknown;
  stalled_signal?: unknown;
  note?: unknown;
  vary_options?: MuscleVaryOption[];
};

type MuscleTrajectory = {
  available?: boolean;
  headline?: unknown;
  groups?: MuscleGroupTrajectoryRow[];
};

async function loadMuscleTrajectory(): Promise<void> {
  const slot = view.querySelector("#progMuscleSlot");
  if (!slot) return;
  let trajectory: MuscleTrajectory | null = null;
  try {
    trajectory = (await api("/muscle-trajectory")) as MuscleTrajectory;
  } catch {
    trajectory = null;
  }
  if (state.tab !== "progress" || state.progressSeg !== "program" || !slot.isConnected) return;
  const html = muscleTrajectoryHtml(trajectory);
  slot.innerHTML = html || "";
}

function muscleVerdictTone(verdict: unknown): string {
  if (verdict === "advancing") return "strong";
  if (verdict === "stalling") return "watch";
  return "steady";
}

function muscleVerdictWord(verdict: unknown): string {
  if (verdict === "advancing") return "Advancing";
  if (verdict === "stalling") return "Stalling";
  if (verdict === "building") return "Building";
  if (verdict === "maintaining") return "Holding";
  return "";
}

function muscleTrendGlyph(trend: unknown): string {
  if (trend === "rising") return "↑";
  if (trend === "falling") return "↓";
  if (trend === "stable") return "→";
  return "";
}

function muscleGroupRowHtml(group: MuscleGroupTrajectoryRow): string {
  const tone = muscleVerdictTone(group.verdict);
  const word = muscleVerdictWord(group.verdict);
  const figs: string[] = [];
  if (group.lead_lift) figs.push(escHtml(group.lead_lift));
  if (group.volume_band) figs.push(`${escHtml(group.volume_band)} volume`);
  const trendGlyph = muscleTrendGlyph(group.trend);
  if (trendGlyph) figs.push(`${trendGlyph} ${escHtml(group.trend)}`);
  const options = Array.isArray(group.vary_options) ? group.vary_options.filter((option) => option && option.name) : [];
  const varyHtml =
    group.verdict === "stalling" && options.length
      ? `<div class="pmus-vary"><span class="pmus-vary-lbl lbl">update a future session</span><div class="pmus-opts">${options
          .slice(0, 3)
          .map((option) => `<span class="pmus-opt"${option.why ? ` title="${escAttr(option.why)}"` : ""}>${escHtml(option.name)}</span>`)
          .join("")}</div></div>`
      : "";
  return `<div class="pmus-row pmus-${tone}">
      <div class="pmus-row-head">
        <span class="pmus-name">${escHtml(group.label || group.group || "")}</span>
        ${word ? `<span class="pmus-verdict pmus-v-${tone}">${escHtml(word)}</span>` : ""}
      </div>
      ${figs.length ? `<div class="pmus-figs lbl">${figs.join(" · ")}</div>` : ""}
      ${group.stalled_signal ? `<div class="pmus-signal">${escHtml(group.stalled_signal)}</div>` : ""}
      ${group.note ? `<div class="pmus-note">${escHtml(group.note)}</div>` : ""}
      ${varyHtml}
    </div>`;
}

function muscleTrajectoryHtml(trajectory: MuscleTrajectory | null | undefined): string {
  if (!trajectory || trajectory.available === false || !Array.isArray(trajectory.groups) || !trajectory.groups.length) return "";
  return `<div class="pmus-card">
      <div class="pmus-card-head lbl">Muscle groups — advancing vs stalling</div>
      ${trajectory.headline ? `<div class="pmus-headline">${escHtml(trajectory.headline)}</div>` : ""}
      <div class="pmus-rows">${trajectory.groups.map(muscleGroupRowHtml).join("")}</div>
    </div>`;
}

const CAIRN_PROGRESS_MUSCLE_TRAJECTORY = {
  loadMuscleTrajectory,
  muscleVerdictTone,
  muscleVerdictWord,
  muscleTrendGlyph,
  muscleGroupRowHtml,
  muscleTrajectoryHtml,
};

Object.assign(globalThis, {
  CairnProgressMuscleTrajectory: CAIRN_PROGRESS_MUSCLE_TRAJECTORY,
  loadMuscleTrajectory,
  muscleVerdictTone,
  muscleVerdictWord,
  muscleTrendGlyph,
  muscleGroupRowHtml,
  muscleTrajectoryHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressMuscleTrajectory: CAIRN_PROGRESS_MUSCLE_TRAJECTORY,
    loadMuscleTrajectory,
    muscleVerdictTone,
    muscleVerdictWord,
    muscleTrendGlyph,
    muscleGroupRowHtml,
    muscleTrajectoryHtml,
  });
}

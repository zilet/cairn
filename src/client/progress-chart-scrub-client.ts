// @ts-check
// Progress chart pointer/scrub interaction helpers.

type ProgressChartScrubCanvas = HTMLCanvasElement & {
  _chartXs?: number[];
  _setTarget?: (idx: number | null, scrubbing: boolean) => void;
  _scrubWired?: boolean;
};

function progressChartIndexFromPointer(canvas: ProgressChartScrubCanvas, event: PointerEvent): number | null {
  const axis = canvas._chartXs;
  const rect = canvas.getBoundingClientRect();
  const px = event.clientX - rect.left;
  return CairnProgressLineChartModel.nearestIndex(axis, px);
}

function wireProgressChartScrub(canvas: ProgressChartScrubCanvas): void {
  if (canvas._scrubWired) return;
  canvas._scrubWired = true;
  let touchActive = false;
  const show = (event: PointerEvent) => {
    const index = progressChartIndexFromPointer(canvas, event);
    if (index != null) canvas._setTarget?.(index, true);
  };
  const rest = () => {
    canvas._setTarget?.(null, false);
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") {
      touchActive = true;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {}
    }
    show(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" || touchActive) show(event);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "mouse") {
      touchActive = false;
      rest();
    }
  });
  canvas.addEventListener("pointercancel", () => {
    touchActive = false;
    rest();
  });
  canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") rest();
  });
}

const CAIRN_PROGRESS_CHART_SCRUB = {
  wire: wireProgressChartScrub,
};

Object.assign(globalThis, {
  CairnProgressChartScrub: CAIRN_PROGRESS_CHART_SCRUB,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressChartScrub: CAIRN_PROGRESS_CHART_SCRUB,
  });
}

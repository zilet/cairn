// @ts-check
// Progress chart color helpers.

type ProgressChartPalette = {
  accent: string;
  sage: string;
  gold: string;
  ink: string;
  paper: string;
  card: string;
  line2: string;
  label: string;
};

type ProgressChartPoint = {
  date: string;
  v: number;
};

type ProgressLineChartOptions = {
  goal?: number | null;
  fmt?: (value: number) => string;
  peak?: boolean;
};

type ProgressChartCanvas = HTMLCanvasElement & {
  _chartXs?: number[];
  _raf?: number | null;
  _hl?: { x: number; y: number; pop: number };
  _setTarget?: (idx: number | null, scrubbing: boolean) => void;
  _scrubWired?: boolean;
};

function withAlpha(hex: unknown, alpha: number): string {
  let value = String(hex || "").trim().replace("#", "");
  if (value.length === 3) value = value.split("").map((part) => part + part).join("");
  if (value.length < 6) return `rgba(0,0,0,${alpha})`;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function chartColors(): ProgressChartPalette {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  return {
    accent: value("--accent", "#b4552d"),
    sage: value("--sage", "#6e7f5c"),
    gold: value("--gold", "#c9a86a"),
    ink: value("--ink", "#211d17"),
    paper: value("--paper", "#f4efe7"),
    card: value("--card", "#fffdf8"),
    line2: value("--line-2", "#d8cfbd"),
    label: value("--muted", "#746c5c"),
  };
}

function drawLineChart(
  canvas: (HTMLCanvasElement & Partial<ProgressChartCanvas>) | null | undefined,
  pts: ProgressChartPoint[] | null | undefined,
  opts: ProgressLineChartOptions = {},
): void {
  if (!canvas) return;
  const points = Array.isArray(pts) ? pts : [];
  const chartCanvas = canvas as ProgressChartCanvas;
  const colors = chartColors();
  const count = points.length;
  if (!count) return;
  const vals = points.map((point) => Number(point.v));
  const allValues = opts.goal != null ? [...vals, Number(opts.goal)] : vals;
  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const spread = max - min;
  min -= spread * 0.14;
  max += spread * 0.2;
  const padL = 36;
  const padR = 16;
  const padT = 30;
  const padB = 28;
  const fmtVal = opts.fmt || ((value: number) => String(Math.round(value)));

  const dpr = window.devicePixelRatio || 1;
  const width = chartCanvas.clientWidth;
  const height = chartCanvas.clientHeight;
  chartCanvas.width = width * dpr;
  chartCanvas.height = height * dpr;
  const ctx = chartCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = (index: number) => count === 1 ? (padL + width - padR) / 2 : padL + (index * (width - padL - padR)) / (count - 1);
  const y = (value: number) => height - padB - ((value - min) / (max - min)) * (height - padT - padB);
  const xs = vals.map((_, index) => x(index));
  const ys = vals.map((value) => y(value));
  chartCanvas._chartXs = xs;

  const slopes = new Array(count).fill(0);
  if (count > 1) {
    const deltas: number[] = [];
    for (let index = 0; index < count - 1; index++) {
      deltas.push((ys[index + 1] - ys[index]) / (xs[index + 1] - xs[index]));
    }
    slopes[0] = deltas[0];
    slopes[count - 1] = deltas[count - 2];
    for (let index = 1; index < count - 1; index++) {
      slopes[index] = deltas[index - 1] * deltas[index] <= 0 ? 0 : (deltas[index - 1] + deltas[index]) / 2;
    }
    for (let index = 0; index < count - 1; index++) {
      if (deltas[index] === 0) {
        slopes[index] = 0;
        slopes[index + 1] = 0;
        continue;
      }
      const a = slopes[index] / deltas[index];
      const b = slopes[index + 1] / deltas[index];
      const hyp = Math.hypot(a, b);
      if (hyp > 3) {
        slopes[index] = ((3 * a) / hyp) * deltas[index];
        slopes[index + 1] = ((3 * b) / hyp) * deltas[index];
      }
    }
  }

  const drawBase = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px system-ui, sans-serif";
    for (let grid = 0; grid <= 3; grid++) {
      const value = min + ((max - min) * grid) / 3;
      const yy = y(value);
      ctx.strokeStyle = withAlpha(colors.line2, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(width - padR, yy);
      ctx.stroke();
      ctx.fillStyle = colors.label;
      ctx.textAlign = "right";
      ctx.fillText(String(Math.round(value)), padL - 7, yy + 3);
    }
    ctx.textAlign = "left";
    if (opts.goal != null) {
      const goalY = y(Number(opts.goal));
      ctx.save();
      ctx.strokeStyle = colors.sage;
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padL, goalY);
      ctx.lineTo(width - padR, goalY);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = colors.sage;
      ctx.font = "600 9px system-ui, sans-serif";
      ctx.fillText(`GOAL ${opts.goal}`, padL + 3, goalY - 5);
    }
    const tracePath = () => {
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let index = 0; index < count - 1; index++) {
        const dx = (xs[index + 1] - xs[index]) / 3;
        ctx.bezierCurveTo(
          xs[index] + dx,
          ys[index] + slopes[index] * dx,
          xs[index + 1] - dx,
          ys[index + 1] - slopes[index + 1] * dx,
          xs[index + 1],
          ys[index + 1],
        );
      }
    };
    if (count > 1) {
      tracePath();
      ctx.lineTo(xs[count - 1], height - padB);
      ctx.lineTo(xs[0], height - padB);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padT, 0, height - padB);
      grad.addColorStop(0, withAlpha(colors.accent, 0.16));
      grad.addColorStop(1, withAlpha(colors.accent, 0));
      ctx.fillStyle = grad;
      ctx.fill();
      tracePath();
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2.25;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.fillStyle = colors.accent;
      for (let index = 0; index < count - 1; index++) {
        ctx.beginPath();
        ctx.arc(xs[index], ys[index], 2, 0, 7);
        ctx.fill();
      }
    }
    if (opts.peak && count > 1) {
      let peakIndex = 0;
      vals.forEach((value, index) => {
        if (value > vals[peakIndex]) peakIndex = index;
      });
      if (peakIndex !== count - 1) {
        ctx.fillStyle = colors.gold;
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("▲", xs[peakIndex], ys[peakIndex] - 9);
        ctx.textAlign = "left";
      }
    }
    ctx.fillStyle = colors.label;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(fmtShortDate(points[0].date), padL, height - 8);
    if (count > 1) {
      ctx.textAlign = "right";
      ctx.fillText(fmtShortDate(points[count - 1].date), width - padR, height - 8);
    }
    ctx.textAlign = "left";
  };

  const drawHighlight = (hx: number, hy: number, index: number, pop: number, withDate: boolean) => {
    if (withDate && count > 1) {
      ctx.save();
      ctx.strokeStyle = withAlpha(colors.ink, 0.22);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT - 6);
      ctx.lineTo(hx, height - padB);
      ctx.stroke();
      ctx.restore();
    }
    const radius = 4.5 + 2.2 * pop;
    ctx.beginPath();
    ctx.arc(hx, hy, radius + 3.5, 0, 7);
    ctx.fillStyle = withAlpha(colors.accent, 0.16);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, radius, 0, 7);
    ctx.fillStyle = colors.accent;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, radius, 0, 7);
    ctx.strokeStyle = colors.card;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    const badgeText = withDate ? `${fmtVal(vals[index])} · ${fmtShortDate(points[index].date)}` : fmtVal(vals[index]);
    ctx.font = "600 11px system-ui, sans-serif";
    const textWidth = ctx.measureText(badgeText).width;
    const badgeX = Math.min(Math.max(hx - textWidth / 2 - 8, padL), width - padR - textWidth - 16);
    let badgeY = hy - 32;
    if (badgeY < 4) badgeY = hy + 14;
    ctx.fillStyle = colors.ink;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, textWidth + 16, 20, 10);
      ctx.fill();
    } else {
      ctx.fillRect(badgeX, badgeY, textWidth + 16, 20);
    }
    ctx.fillStyle = colors.paper;
    ctx.fillText(badgeText, badgeX + 8, badgeY + 14);
  };

  if (chartCanvas._raf) {
    cancelAnimationFrame(chartCanvas._raf);
    chartCanvas._raf = null;
  }
  const finalIndex = count - 1;
  const highlight = { x: xs[finalIndex], y: ys[finalIndex], pop: 0 };
  const target = { x: xs[finalIndex], y: ys[finalIndex], idx: finalIndex, scrubbing: false };
  chartCanvas._hl = highlight;
  const render = () => {
    drawBase();
    drawHighlight(highlight.x, highlight.y, target.idx, highlight.pop, target.scrubbing);
  };
  const tick = () => {
    highlight.x += (target.x - highlight.x) * 0.32;
    highlight.y += (target.y - highlight.y) * 0.32;
    highlight.pop *= 0.8;
    const settled =
      Math.abs(highlight.x - target.x) < 0.4 &&
      Math.abs(highlight.y - target.y) < 0.4 &&
      highlight.pop < 0.02;
    if (settled) {
      highlight.x = target.x;
      highlight.y = target.y;
      highlight.pop = 0;
    }
    render();
    chartCanvas._raf = settled ? null : requestAnimationFrame(tick);
  };
  chartCanvas._setTarget = (idx: number | null, scrubbing: boolean) => {
    const index = idx == null ? finalIndex : Math.max(0, Math.min(count - 1, idx));
    if (index !== target.idx) highlight.pop = 1;
    target.x = xs[index];
    target.y = ys[index];
    target.idx = index;
    target.scrubbing = !!scrubbing;
    if (reducedMotion()) {
      highlight.x = target.x;
      highlight.y = target.y;
      highlight.pop = 0;
      render();
      return;
    }
    if (!chartCanvas._raf) chartCanvas._raf = requestAnimationFrame(tick);
  };

  if (!chartCanvas._scrubWired) {
    chartCanvas._scrubWired = true;
    let touchActive = false;
    const idxFromEvent = (event: PointerEvent) => {
      const axis = chartCanvas._chartXs;
      if (!axis || !axis.length) return null;
      const rect = chartCanvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      let index = 0;
      let best = Infinity;
      for (let candidate = 0; candidate < axis.length; candidate++) {
        const distance = Math.abs(axis[candidate] - px);
        if (distance < best) {
          best = distance;
          index = candidate;
        }
      }
      return index;
    };
    const show = (event: PointerEvent) => {
      const index = idxFromEvent(event);
      if (index != null) chartCanvas._setTarget?.(index, true);
    };
    const rest = () => {
      chartCanvas._setTarget?.(null, false);
    };
    chartCanvas.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") {
        touchActive = true;
        try {
          chartCanvas.setPointerCapture(event.pointerId);
        } catch {}
      }
      show(event);
    });
    chartCanvas.addEventListener("pointermove", (event) => {
      if (event.pointerType === "mouse" || touchActive) show(event);
    });
    chartCanvas.addEventListener("pointerup", (event) => {
      if (event.pointerType !== "mouse") {
        touchActive = false;
        rest();
      }
    });
    chartCanvas.addEventListener("pointercancel", () => {
      touchActive = false;
      rest();
    });
    chartCanvas.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") rest();
    });
  }

  render();
}

const CAIRN_PROGRESS_CHART = {
  withAlpha,
  chartColors,
  drawLineChart,
};

Object.assign(globalThis, {
  CairnProgressChart: CAIRN_PROGRESS_CHART,
  withAlpha,
  chartColors,
  drawLineChart,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressChart: CAIRN_PROGRESS_CHART,
    withAlpha,
    chartColors,
    drawLineChart,
  });
}

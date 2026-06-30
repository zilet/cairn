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

const CAIRN_PROGRESS_CHART = {
  withAlpha,
  chartColors,
};

Object.assign(globalThis, {
  CairnProgressChart: CAIRN_PROGRESS_CHART,
  withAlpha,
  chartColors,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressChart: CAIRN_PROGRESS_CHART,
    withAlpha,
    chartColors,
  });
}

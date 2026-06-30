// @ts-check
// Progress performance standing presentation helpers.

type PerformanceCapacity = {
  tone?: unknown;
  percentile?: unknown;
  exercise?: unknown;
  est_1rm?: unknown;
  to_next?: { lb?: unknown; level?: unknown } | null;
  label?: unknown;
  level?: unknown;
};

type PerformanceMomentumChip = {
  dir?: unknown;
  text?: unknown;
};

type PerformanceImbalance = {
  severity?: unknown;
  title?: unknown;
  why?: unknown;
};

type PerformanceTestDue = {
  exercise?: unknown;
  why?: unknown;
};

type PerformanceStanding = {
  capacities?: PerformanceCapacity[];
  endurance?: {
    headline?: unknown;
    vo2max?: unknown;
    tone?: unknown;
  } | null;
  lever?: {
    headline?: unknown;
    why?: unknown;
    target?: unknown;
  } | null;
  hero?: {
    headline?: unknown;
    sub?: unknown;
  } | null;
  momentum?: {
    chips?: PerformanceMomentumChip[];
  } | null;
  sex?: unknown;
  imbalances?: PerformanceImbalance[];
  tests_due?: PerformanceTestDue[];
  variety?: {
    note?: unknown;
    suggestions?: unknown[];
  } | null;
  balance_note?: unknown;
};

type PerformanceRenderOptions = {
  suppressLever?: boolean;
};

async function loadPerformance(): Promise<void> {
  const slot = view.querySelector("#progPerfSlot");
  if (!slot) return;
  let performance: PerformanceStanding | null = null;
  try {
    performance = (await api("/performance")) as PerformanceStanding;
  } catch {
    performance = null;
  }
  if (!performance || (!(performance.capacities || []).length && !performance.endurance && !performance.lever)) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = performanceHtml(performance, { suppressLever: !!_progFocusCard });
}

function pctClamp(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(2, Math.min(99, Math.round(numeric))) : 0;
}

function capacityRowHtml(capacity: PerformanceCapacity, sexWord: unknown): string {
  const tone = capacity.tone === "strong" ? "strong" : capacity.tone === "watch" ? "watch" : "steady";
  const pct = pctClamp(capacity.percentile);
  const sub: string[] = [];
  if (capacity.exercise) sub.push(escHtml(capacity.exercise));
  if (capacity.est_1rm) sub.push(`~${escHtml(String(capacity.est_1rm))} lb 1RM`);
  sub.push(`stronger than ${pct}% of ${escHtml(sexWord || "people")} your age`);
  if (capacity.to_next) sub.push(`+${escHtml(String(capacity.to_next.lb))} lb → ${escHtml(capacity.to_next.level)}`);
  return `<div class="pcap">
    <div class="pcap-top"><span class="pcap-label">${escHtml(capacity.label)}</span><span class="pcap-level pcap-${tone}">${escHtml(capacity.level)}</span></div>
    <div class="pcap-bar"><span class="pcap-fill pcap-fill-${tone}" style="width:${pct}%"></span><span class="pcap-mark" style="left:${pct}%"></span></div>
    <div class="pcap-sub lbl">${sub.join(" · ")}</div>
  </div>`;
}

function performanceHtml(performance: PerformanceStanding | null | undefined, options: PerformanceRenderOptions = {}): string {
  if (!performance) return "";
  const suppressLever = !!options.suppressLever;
  const capacities = Array.isArray(performance.capacities) ? performance.capacities : [];
  const chips = Array.isArray(performance.momentum?.chips) ? performance.momentum.chips : [];
  let html = `<section class="pperf">`;

  if (performance.hero?.headline) {
    html += `<div class="pperf-hero">
      <div class="pperf-hero-mast lbl">Where you stand</div>
      <div class="pperf-hero-head">${escHtml(performance.hero.headline)}</div>
      ${performance.hero.sub ? `<div class="pperf-hero-sub">${escHtml(performance.hero.sub)}</div>` : ""}
      ${chips.length ? `<div class="pperf-chips">${chips.map((chip) => `<span class="pperf-chip pperf-chip-${chip.dir === "good" ? "good" : "neutral"}">${escHtml(chip.text)}</span>`).join("")}</div>` : ""}
    </div>`;
  }

  if (capacities.length) {
    const sexWord = performance.sex === "female" ? "women" : "men";
    html += `<div class="pperf-caps">${capacities.map((capacity) => capacityRowHtml(capacity, sexWord)).join("")}</div>`;
  }

  if (performance.endurance?.headline && performance.endurance.vo2max != null) {
    const tone =
      performance.endurance.tone === "strong" ? "strong" : performance.endurance.tone === "watch" ? "watch" : "steady";
    html += `<div class="pperf-aero pperf-aero-${tone}">${escHtml(performance.endurance.headline)}</div>`;
  }

  if (!suppressLever && performance.lever?.headline) {
    html += `<div class="pperf-lever">
      <div class="pperf-lever-lbl lbl">The lever</div>
      <div class="pperf-lever-head">${escHtml(performance.lever.headline)}</div>
      ${performance.lever.why ? `<div class="pperf-lever-why">${escHtml(performance.lever.why)}</div>` : ""}
      ${performance.lever.target ? `<div class="pperf-lever-target">${escHtml(performance.lever.target)}</div>` : ""}
    </div>`;
  }

  const imbalances = Array.isArray(performance.imbalances) ? performance.imbalances : [];
  if (imbalances.length) {
    html += `<div class="pperf-block"><div class="pperf-block-lbl lbl">Balance &amp; symmetry</div>${imbalances
      .map(
        (imbalance) =>
          `<div class="pperf-imb pperf-imb-${imbalance.severity === "watch" ? "watch" : "note"}"><div class="pperf-imb-title">${escHtml(imbalance.title)}</div><div class="pperf-imb-why">${escHtml(imbalance.why)}</div></div>`,
      )
      .join("")}</div>`;
  }

  const testsDue = Array.isArray(performance.tests_due) ? performance.tests_due : [];
  if (testsDue.length) {
    html += `<div class="pperf-block"><div class="pperf-block-lbl lbl">Worth re-testing</div>${testsDue
      .map(
        (testDue) =>
          `<div class="pperf-test"><span class="pperf-test-ex">${escHtml(testDue.exercise)}</span><span class="pperf-test-why">${escHtml(testDue.why)}</span></div>`,
      )
      .join("")}</div>`;
  }

  const varietySuggestions = Array.isArray(performance.variety?.suggestions) ? performance.variety.suggestions : [];
  if (performance.variety?.note) {
    html += `<div class="pperf-variety"><div class="pperf-block-lbl lbl">A little variety</div><div class="pperf-variety-note">${escHtml(performance.variety.note)}</div>${
      varietySuggestions.length
        ? `<div class="pperf-variety-opts">${varietySuggestions.map((suggestion) => `<span class="pperf-opt">${escHtml(suggestion)}</span>`).join("")}</div>`
        : ""
    }</div>`;
  }

  if (performance.balance_note) html += `<div class="pperf-balance">${escHtml(performance.balance_note)}</div>`;

  html += `</section>`;
  return html;
}

const CAIRN_PROGRESS_PERFORMANCE = {
  loadPerformance,
  pctClamp,
  capacityRowHtml,
  performanceHtml,
};

Object.assign(globalThis, {
  CairnProgressPerformance: CAIRN_PROGRESS_PERFORMANCE,
  loadPerformance,
  pctClamp,
  capacityRowHtml,
  performanceHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressPerformance: CAIRN_PROGRESS_PERFORMANCE,
    loadPerformance,
    pctClamp,
    capacityRowHtml,
    performanceHtml,
  });
}

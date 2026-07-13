// @ts-check
// Reading-layer primitives for the vanilla PWA — the shared, composable grammar
// every read speaks (VISION.md Amendment 2). Plain-language first; wins made
// visible; gaps stated as calm information; visual state expressed against the
// athlete's OWN baseline range in qualitative words (in / below / above your
// range) — never a score, grade, or population-relative geometry.
//
// Pure HTML-string renderers: no fetching, no global state mutation beyond the
// namespace export, every caller-supplied string escaped. These are the API the
// later reading surfaces (Brief, Energy Balance, Stand, Train) compose against.
// Frozen contract: docs/DESIGN.md "Reading layer primitives".

type ContributorTone = "ok" | "watch" | "quiet";
type TrendTone = "toward" | "away" | "stable";

type BaselineBandOptions = {
  label?: unknown;
  position?: unknown;
  rangeStart?: unknown;
  rangeEnd?: unknown;
  phrase?: unknown;
  hot?: boolean;
};
type ContributorRow = {
  label?: unknown;
  state?: unknown;
  tone?: unknown;
};
type LevelChipOptions = {
  label?: unknown;
  detail?: unknown;
};
type TrendLeadOptions = {
  name?: unknown;
  phrase?: unknown;
  tone?: unknown;
};

const CONTRIB_TONES: ReadonlySet<ContributorTone> = new Set<ContributorTone>(["ok", "watch", "quiet"]);
const TREND_TONES: ReadonlySet<TrendTone> = new Set<TrendTone>(["toward", "away", "stable"]);

// A ratio in [0,1], or null when the value isn't a finite number. Positions are
// clamped to the edges so a caller can hand over a raw ratio without pre-guarding.
function clampFraction(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// A fraction as a CSS percentage. Only ever fed internally-computed numbers, so
// the output is always a safe literal (never a caller string).
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

// Clamp a contributor tone to the allowlist; unknown → the calm neutral `quiet`
// (thin data reads looser), never an arbitrary caller class.
function contribTone(tone: unknown): ContributorTone {
  return typeof tone === "string" && CONTRIB_TONES.has(tone as ContributorTone) ? (tone as ContributorTone) : "quiet";
}

// Clamp a trend tone to the allowlist; unknown → `stable` (muted).
function trendTone(tone: unknown): TrendTone {
  return typeof tone === "string" && TREND_TONES.has(tone as TrendTone) ? (tone as TrendTone) : "stable";
}

// Personal-baseline band: a soft sage region is the athlete's OWN range, a dot is
// where today sits (ink; terracotta via `hot` when it's a lever), and a
// plain-language phrase carries the meaning. NO number is surfaced. When the range
// data is missing it degrades to just the label + phrase — the band is never drawn
// empty. When the range is present but the position isn't, the region shows without
// a dot. Positions are clamped to [0,1] and expressed as percentages.
function baselineBandHtml(options: BaselineBandOptions = {}): string {
  const label = options.label == null ? "" : String(options.label);
  const phrase = options.phrase == null ? "" : String(options.phrase);
  const start = clampFraction(options.rangeStart);
  const end = clampFraction(options.rangeEnd);
  const pos = clampFraction(options.position);
  const hasRange = start != null && end != null;

  const labelHtml = label.trim() ? `<span class="read-band-label lbl">${escHtml(label)}</span>` : "";
  const phraseHtml = phrase.trim() ? `<span class="read-band-phrase">${escHtml(phrase)}</span>` : "";
  const hotClass = options.hot ? " hot" : "";

  if (!hasRange) {
    if (!labelHtml && !phraseHtml) return "";
    return `<div class="read-band${hotClass}">${labelHtml}${phraseHtml}</div>`;
  }

  const lo = Math.min(start as number, end as number);
  const hi = Math.max(start as number, end as number);
  const rangeStyle = `left:${pct(lo)};width:${pct(hi - lo)}`;
  const dotHtml = pos == null ? "" : `<span class="read-band-dot" style="left:${pct(pos)}"></span>`;
  return `<div class="read-band${hotClass}">${labelHtml}<div class="read-band-track"><span class="read-band-range" style="${rangeStyle}"></span>${dotHtml}</div>${phraseHtml}</div>`;
}

// Contributor rows: a label + a qualitative state line, each led by a small state
// pip — sage `ok`, terracotta `watch` (attention / a lever), neutral-outline
// `quiet` (thin data, "the read is looser"). Tone is clamped to the allowlist. NO
// numbers — the state line is words. Empty rows are dropped; no rows → "".
function contributorRowsHtml(rows: unknown): string {
  const list = Array.isArray(rows) ? rows : [];
  const items = list
    .map((row) => {
      const r = (row && typeof row === "object" ? row : {}) as ContributorRow;
      const label = r.label == null ? "" : String(r.label);
      const state = r.state == null ? "" : String(r.state);
      if (!label.trim() && !state.trim()) return "";
      const tone = contribTone(r.tone);
      const labelHtml = label.trim() ? `<span class="read-contrib-label">${escHtml(label)}</span>` : "";
      const stateHtml = state.trim() ? `<span class="read-contrib-state">${escHtml(state)}</span>` : "";
      return `<div class="read-contrib"><span class="read-contrib-pip ${tone}" aria-hidden="true"></span>${labelHtml}${stateHtml}</div>`;
    })
    .filter(Boolean);
  if (!items.length) return "";
  return `<div class="read-contribs">${items.join("")}</div>`;
}

// A qualitative level chip (sage-soft) for a capacity / benchmark word —
// "intermediate", "in your range" — with an optional muted detail. A reference
// read, never a graded score. Empty label → "".
function levelChipHtml(options: LevelChipOptions = {}): string {
  const label = options.label == null ? "" : String(options.label);
  if (!label.trim()) return "";
  const detail = options.detail == null ? "" : String(options.detail);
  const detailHtml = detail.trim() ? `<span class="level-chip-detail">${escHtml(detail)}</span>` : "";
  return `<span class="level-chip">${escHtml(label)}${detailHtml}</span>`;
}

// A trend-first headline row: a serif name + a directional phrase — sage `toward`
// (moving toward optimal), terracotta `away` (away and actionable), muted `stable`.
// Tone is clamped to the allowlist. Direction is words, never an arrow on a score.
// Empty name → "".
function trendLeadHtml(options: TrendLeadOptions = {}): string {
  const name = options.name == null ? "" : String(options.name);
  if (!name.trim()) return "";
  const phrase = options.phrase == null ? "" : String(options.phrase);
  const tone = trendTone(options.tone);
  const phraseHtml = phrase.trim() ? `<span class="trend-lead-phrase ${tone}">${escHtml(phrase)}</span>` : "";
  return `<div class="trend-lead"><span class="trend-lead-name">${escHtml(name)}</span>${phraseHtml}</div>`;
}

const CAIRN_UI_READS = {
  baselineBandHtml,
  contributorRowsHtml,
  levelChipHtml,
  trendLeadHtml,
};

Object.assign(globalThis, { CairnUiReads: CAIRN_UI_READS });

if (typeof window !== "undefined") {
  window.CairnUiReads = CAIRN_UI_READS;
}

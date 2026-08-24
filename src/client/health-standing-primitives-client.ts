// @ts-check
// Pure Health Standing percentile, metric, and supporting-card render primitives.

type HealthStandingPrimitiveMeasure = import("../contracts/client-api.js").ClientHealthStandingMeasure;
type HealthStandingPrimitiveComparison = import("../contracts/client-api.js").ClientHealthStandingComparison;
type HealthStandingPrimitiveDimension = import("../contracts/client-api.js").ClientHealthStandingDimension;
type HealthStandingPrimitiveBpReading = import("../contracts/client-api.js").ClientBloodPressureReading;
type HealthStandingPrimitiveBloodPressure = import("../contracts/client-api.js").ClientHealthStandingBloodPressure;
type HealthStandingPrimitiveBodyComp = import("../contracts/client-api.js").ClientHealthStandingBodyComp;

(() => {
function hstandDecade(age: unknown): number {
  const n = Number(age);
  if (!Number.isFinite(n)) return 40;
  return Math.max(20, Math.min(70, Math.floor(n / 10) * 10));
}

function hstandPct(value: unknown): number | null {
  const pct = Math.round(Number(value));
  return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
}

function localDateTimeInputValue(date: Date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function hstandTone(tone: unknown): string {
  return ["strong", "steady", "watch", "missing"].includes(String(tone)) ? String(tone) : "missing";
}

function hstandMeasureHtml(measure: HealthStandingPrimitiveMeasure | null | undefined): string {
  if (!measure) return "";
  const value = measure.value == null || measure.value === "" ? "—" : CairnHealthClient.formatMarkerNumber(measure.value);
  return `<span class="hstand-measure"><span class="lbl">${escHtml(measure.label || "")}</span><b>${escHtml(value)}</b>${measure.unit ? `<em>${escHtml(measure.unit)}</em>` : ""}</span>`;
}

// Mirrors repo bandForPercentile: strong (sage) -> steady (gold) -> watch (terracotta).
function hstandBandTone(percentile: unknown): string {
  const value = Number(percentile);
  if (!Number.isFinite(value)) return "missing";
  return value >= 75 ? "strong" : value >= 50 ? "steady" : "watch";
}

// A calm qualitative capacity word derived from an age-band percentile, using the
// SAME thresholds as hstandBandTone (75 / 50) — the reading-grammar replacement for
// the retired percentile fill bar (VISION.md Amendment 2 bans population-relative
// geometry; the number feeds this ladder and never prints). "" when there's no
// percentile to read.
function hstandLevelWord(percentile: unknown): string {
  const value = Number(percentile);
  if (!Number.isFinite(value)) return "";
  return value >= 75 ? "strong" : value >= 50 ? "solid" : "building";
}

function hstandCompHtml(comparison: HealthStandingPrimitiveComparison, sexWord: string, calendarAge: unknown): string {
  const percentile = hstandPct(comparison.percentile);
  const tone = hstandBandTone(percentile);
  const value = comparison.value == null ? "—" : CairnHealthClient.formatMarkerNumber(comparison.value);
  const equivalentAge = Number(comparison.equivalent_age);
  const showEquivalent =
    !comparison.estimated &&
    Number.isFinite(equivalentAge) &&
    (!Number.isFinite(Number(calendarAge)) || equivalentAge <= Number(calendarAge) + 5);
  const equivalentChip = comparison.estimated
    ? `<span class="hstand-eq hstand-eq-est">est. now</span>`
    : showEquivalent ? `<span class="hstand-eq">moves like age ${escHtml(String(Math.round(equivalentAge)))}</span>` : "";
  let where = "";
  if (comparison.next) {
    const next = comparison.next;
    const sign = next.direction === "down" ? "−" : "+";
    const magnitude = Math.max(1, Math.round(Number(next.delta) || 0));
    const unit = comparison.unit ? ` ${escHtml(comparison.unit)}` : "";
    const ageBit = Number.isFinite(Number(next.equivalent_age))
      ? `, like age ${escHtml(String(Math.round(Number(next.equivalent_age))))}`
      : "";
    where = `<div class="hstand-where"><span class="hstand-where-arrow" aria-hidden="true">↗</span><span class="lbl">where to head</span> <b>${sign}${magnitude}${unit}</b> → ${escHtml(next.label)}${ageBit}</div>`;
  } else if (percentile != null && percentile >= 75) {
    where = `<div class="hstand-where hstand-where-top"><span class="hstand-where-arrow" aria-hidden="true">✦</span>among the strongest in your age band — hold it here</div>`;
  }
  const referencePercentile = hstandPct(comparison.reference_percentile);
  const referenceDiff =
    comparison.reference_age_band &&
    comparison.actual_age_band &&
    comparison.reference_age_band !== comparison.actual_age_band;
  const referenceWord = hstandLevelWord(referencePercentile);
  const referenceLine = referenceDiff && referenceWord
    ? `<div class="hstand-comp-ref lbl">vs your ${escHtml(comparison.reference_age_band)}: ${escHtml(referenceWord)}</div>`
    : "";
  const reading = comparison.reading || {};
  const provenance = [
    comparison.source,
    reading.source ? `${String(reading.source)}${reading.date ? `, ${relAge(String(reading.date))}` : ""}` : "",
  ].filter(Boolean).join(" · ");
  const levelWord = hstandLevelWord(percentile);
  const levelChip = CairnUiReads.levelChipHtml({ label: levelWord });
  const read = levelWord
    ? `<div class="hstand-comp-read"><b>${escHtml(levelWord)}</b> among ${escHtml(sexWord)} your age</div>`
    : "";
  return `<div class="hstand-comp hstand-comp-${tone}">
      <div class="hstand-comp-head">
        <span><b>${escHtml(comparison.label || comparison.key || "")}</b> <span class="lbl">${escHtml(value)}${comparison.unit ? ` ${escHtml(comparison.unit)}` : ""}</span></span>
        ${equivalentChip}
      </div>
      ${levelChip ? `<div class="hstand-comp-bar">${levelChip}</div>` : ""}
      ${read}
      ${where}
      ${referenceLine}
      ${provenance ? `<div class="hstand-source lbl">${escHtml(provenance)}</div>` : ""}
    </div>`;
}

function hstandRefSummaryHtml(
  comparisons: HealthStandingPrimitiveComparison[] | null | undefined,
  referenceAge: unknown,
  actualDecade: number | null,
  sexWord: string,
): string {
  const list = Array.isArray(comparisons)
    ? comparisons.filter((comparison) => hstandPct(comparison.reference_percentile) != null)
    : [];
  if (!list.length) {
    return `<div class="hstand-refsum hstand-refsum-empty lbl">A VO2max or DEXA / body-fat anchor unlocks the age-band comparison.</div>`;
  }
  const isPeers = actualDecade != null && Number(referenceAge) === Number(actualDecade);
  const head = isPeers
    ? `Among ${escHtml(sexWord)} your age`
    : `Among ${escHtml(sexWord)} in their ${escHtml(String(referenceAge))}s`;
  const rows = list.map((comparison) => {
    const referencePercentile = hstandPct(comparison.reference_percentile);
    const levelWord = hstandLevelWord(referencePercentile);
    const levelChip = CairnUiReads.levelChipHtml({ label: levelWord });
    return `<div class="hstand-refsum-row">
        <span class="hstand-refsum-metric">${escHtml(comparison.label || comparison.key || "")}</span>
        <span class="hstand-refsum-bar">${levelChip}</span>
        <span class="hstand-refsum-read">${levelWord ? `<b>${escHtml(levelWord)}</b>` : "—"}</span>
      </div>`;
  }).join("");
  return `<div class="hstand-refsum">
      <span class="lbl hstand-refsum-head">${head}</span>
      ${rows}
    </div>`;
}

function hstandDimensionHtml(dimension: HealthStandingPrimitiveDimension, index: number): string {
  const measures = Array.isArray(dimension.measures) && dimension.measures.length
    ? `<div class="hstand-measures">${dimension.measures.map(hstandMeasureHtml).join("")}</div>`
    : "";
  return `<div class="hstand-dim hstand-${hstandTone(dimension.tone)} reveal" style="${stagger(index)}">
      <div class="hstand-dim-top"><span class="lbl">${escHtml(dimension.label || "")}</span><span class="hstand-tone-dot" aria-hidden="true"></span></div>
      <h3>${escHtml(dimension.headline || "")}</h3>
      ${dimension.body ? `<p>${escHtml(dimension.body)}</p>` : ""}
      ${measures}
    </div>`;
}

function hstandBpRows(rows: HealthStandingPrimitiveBpReading[] | null | undefined): string {
  if (!Array.isArray(rows) || !rows.length) return `<div class="bp-empty">No readings yet.</div>`;
  return rows.slice(0, 8).map((row) => {
    const bp = `${escHtml(String(row.systolic ?? "—"))}/${escHtml(String(row.diastolic ?? "—"))}`;
    const pulse = row.pulse != null ? `<span>${escHtml(String(row.pulse))} bpm</span>` : "";
    const when = row.measured_at ? relTime(String(row.measured_at).replace(" ", "T")) : "";
    const meta = [when, row.position, row.source && row.source !== "manual" ? row.source : ""]
      .filter(Boolean)
      .map((item) => `<span>${escHtml(String(item))}</span>`)
      .join("");
    return `<div class="bp-row">
        <b>${bp}</b>
        <div>${pulse}${meta}</div>
      </div>`;
  }).join("");
}

function hstandBodyCompHtml(bodyComp: HealthStandingPrimitiveBodyComp | null | undefined): string {
  if (!bodyComp) {
    return `<div class="hstand-panel hstand-bodycomp">
      <div class="hstand-panel-head"><span class="lbl">Body composition</span></div>
      <div class="hstand-empty">A DEXA or a compatible scale anchors this — then it tracks live as your weight moves.</div>
    </div>`;
  }
  const estimated = bodyComp.estimated;
  const measured = bodyComp.measured || {};
  const fat = bodyComp.fat_mass;
  const lost = fat && fat.delta_lbs != null && Number(fat.delta_lbs) < 0
    ? Math.abs(Math.round(Number(fat.delta_lbs)))
    : null;
  const big = estimated ? `~${estimated.value}` : measured.value != null ? `${measured.value}` : "—";
  const regional = bodyComp.regional;
  const regionalHtml = regional && Array.isArray(regional.notes) && regional.notes.length
    ? `<div class="hstand-bc-regional">${regional.notes.map((note) => {
        const tone = ["strong", "steady", "watch"].includes(String(note.tone)) ? String(note.tone) : "steady";
        return `<div class="hstand-bc-rnote hstand-${tone}"><span class="hstand-bc-rdot" aria-hidden="true"></span><span>${escHtml(note.text || "")}</span></div>`;
      }).join("")}</div>`
    : "";
  return `<div class="hstand-panel hstand-bodycomp">
    <div class="hstand-panel-head"><span class="lbl">Body composition</span>${estimated ? `<span class="lbl">live estimate</span>` : ""}</div>
    <div class="hstand-bc-big"><b>${escHtml(String(big))}</b><span class="hstand-bc-unit">% body fat${estimated ? " · est. now" : ""}</span></div>
    ${estimated && measured.value != null ? `<div class="hstand-bc-from">from <b>${escHtml(String(measured.value))}%</b> at your DEXA${measured.date ? ` · <span title="${escAttr(absDate(String(measured.date)))}">${escHtml(relAge(String(measured.date)))}</span>` : ""}</div>` : ""}
    ${lost != null ? `<div class="hstand-bc-win">≈ ${lost} lb of fat off since the scan</div>` : ""}
    ${bodyComp.trunk_fat_pct != null && !regionalHtml ? `<div class="hstand-bc-note">Trunk fat ${escHtml(String(bodyComp.trunk_fat_pct))}% — the metabolic one, and what a cut trims first.</div>` : ""}
    ${regionalHtml}
    ${bodyComp.note ? `<div class="hstand-source lbl">${escHtml(bodyComp.note)}</div>` : ""}
  </div>`;
}

function hstandBpCardHtml(bp: HealthStandingPrimitiveBloodPressure | null | undefined): string {
  if (!bp) {
    return `<div class="hstand-panel hstand-bp">
      <div class="hstand-panel-head"><span class="lbl">Blood pressure</span></div>
      <div class="hstand-empty">Log a couple of resting home readings and Cairn can read the pattern.</div>
      <div class="bp-recent">${hstandBpRows([])}</div>
      <button class="ghostbtn hstand-bp-log" type="button" id="bpLogOpen">+ Log a reading</button>
    </div>`;
  }
  const data = bp;
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const category = data.category;
  const categoryLabel =
    category === "optimal" ? "Optimal" :
    category === "elevated" ? "Elevated" :
    category === "high" ? "Above target" :
    category === "low" ? "Low" :
    "No trend yet";
  const trajectory = data.trajectory;
  const improving = trajectory && trajectory.dir === "improving" && trajectory.from && trajectory.to;
  return `<div class="hstand-panel hstand-bp">
    <div class="hstand-panel-head"><span class="lbl">Blood pressure</span>${data.latest ? `<span class="hstand-bp-cat hstand-${hstandTone(data.tone)}">${escHtml(categoryLabel)}</span>` : ""}</div>
    ${data.read ? `<div class="hstand-bp-read">${escHtml(data.read)}</div>` : `<div class="hstand-empty">Log a couple of resting home readings and Cairn can read the pattern.</div>`}
    ${improving ? `<div class="hstand-bp-traj"><span class="hstand-bp-was">${escHtml(String(trajectory.from?.systolic))}/${escHtml(String(trajectory.from?.diastolic))}</span><span class="hstand-bp-arrow">→</span><span class="hstand-bp-now">${escHtml(String(trajectory.to?.systolic))}/${escHtml(String(trajectory.to?.diastolic))}</span></div>` : ""}
    <div class="bp-recent">${hstandBpRows(recent)}</div>
    <button class="ghostbtn hstand-bp-log" type="button" id="bpLogOpen">+ Log a reading</button>
    ${data.note ? `<div class="hstand-source lbl">${escHtml(data.note)}</div>` : ""}
  </div>`;
}

const CAIRN_HEALTH_STANDING_PRIMITIVES = {
  hstandDecade,
  hstandPct,
  localDateTimeInputValue,
  hstandTone,
  hstandBandTone,
  hstandLevelWord,
  hstandMeasureHtml,
  hstandCompHtml,
  hstandRefSummaryHtml,
  hstandDimensionHtml,
  hstandBpRows,
  hstandBodyCompHtml,
  hstandBpCardHtml,
};

Object.assign(globalThis, { CairnHealthStandingPrimitives: CAIRN_HEALTH_STANDING_PRIMITIVES });

if (typeof window !== "undefined") {
  window.CairnHealthStandingPrimitives = CAIRN_HEALTH_STANDING_PRIMITIVES;
}
})();

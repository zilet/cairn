// @ts-check
// Pure Health Standing renderer for the vanilla PWA.

type HealthStandingMeasure = {
  label?: unknown;
  value?: unknown;
  unit?: unknown;
};

type HealthStandingNextTarget = {
  direction?: unknown;
  delta?: unknown;
  label?: unknown;
  equivalent_age?: unknown;
};

type HealthStandingComparison = {
  key?: unknown;
  label?: unknown;
  value?: unknown;
  unit?: unknown;
  percentile?: unknown;
  reference_percentile?: unknown;
  reference_age_band?: unknown;
  actual_age_band?: unknown;
  equivalent_age?: unknown;
  estimated?: unknown;
  verb?: unknown;
  source?: unknown;
  next?: HealthStandingNextTarget | null;
  reading?: {
    source?: unknown;
    date?: unknown;
  } | null;
};

type HealthStandingDimension = {
  id?: unknown;
  tone?: unknown;
  label?: unknown;
  headline?: unknown;
  body?: unknown;
  measures?: HealthStandingMeasure[];
};

type HealthStandingBpReading = {
  systolic?: unknown;
  diastolic?: unknown;
  pulse?: unknown;
  measured_at?: unknown;
  position?: unknown;
  source?: unknown;
};

type HealthStandingBloodPressure = {
  latest?: unknown;
  category?: unknown;
  tone?: unknown;
  read?: unknown;
  note?: unknown;
  trajectory?: {
    dir?: unknown;
    from?: { systolic?: unknown; diastolic?: unknown } | null;
    to?: { systolic?: unknown; diastolic?: unknown } | null;
  } | null;
  recent?: HealthStandingBpReading[];
};

type HealthStandingBodyComp = {
  estimated?: { value?: unknown } | null;
  measured?: { value?: unknown; date?: unknown } | null;
  fat_mass?: { delta_lbs?: unknown } | null;
  trunk_fat_pct?: unknown;
  note?: unknown;
  regional?: {
    notes?: Array<{ tone?: unknown; text?: unknown }>;
  } | null;
};

type HealthStandingRead = {
  subject?: {
    age?: unknown;
    sex?: unknown;
    reference_age?: unknown;
  } | null;
  hero?: {
    headline?: unknown;
    calendar_age?: unknown;
    biological_age?: unknown;
    biological_age_source?: unknown;
    biological_age_delta?: unknown;
    direction?: unknown;
  } | null;
  headline?: unknown;
  confidence?: unknown;
  momentum?: {
    has_momentum?: unknown;
    chips?: Array<{ dir?: unknown; text?: unknown }>;
  } | null;
  lead_lever?: {
    uncertain?: unknown;
    group?: unknown;
    why?: unknown;
    move?: unknown;
  } | null;
  comparisons?: HealthStandingComparison[];
  dimensions?: HealthStandingDimension[];
  body_comp?: HealthStandingBodyComp | null;
  blood_pressure?: HealthStandingBloodPressure | null;
  balance?: unknown;
};

type HealthStandingRenderOptions = {
  referenceAge?: unknown;
};

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

function hstandMeasureHtml(measure: HealthStandingMeasure | null | undefined): string {
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

function hstandCompHtml(comparison: HealthStandingComparison, sexWord: string, calendarAge: unknown): string {
  const percentile = hstandPct(comparison.percentile);
  const tone = hstandBandTone(percentile);
  const value = comparison.value == null ? "—" : CairnHealthClient.formatMarkerNumber(comparison.value);
  const verb = comparison.verb || "ahead of";
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
  const referenceLine = referenceDiff && referencePercentile != null
    ? `<div class="hstand-comp-ref lbl">vs your ${escHtml(comparison.reference_age_band)}: ${escHtml(verb)} ${referencePercentile}%</div>`
    : "";
  const reading = comparison.reading || {};
  const provenance = [
    comparison.source,
    reading.source ? `${String(reading.source)}${reading.date ? `, ${relAge(String(reading.date))}` : ""}` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="hstand-comp hstand-comp-${tone}">
      <div class="hstand-comp-head">
        <span><b>${escHtml(comparison.label || comparison.key || "")}</b> <span class="lbl">${escHtml(value)}${comparison.unit ? ` ${escHtml(comparison.unit)}` : ""}</span></span>
        ${equivalentChip}
      </div>
      <div class="hstand-comp-bar"><span class="hstand-track"><span class="hstand-fill hstand-fill-${tone}" style="width:${percentile ?? 0}%"></span></span></div>
      <div class="hstand-comp-read">${escHtml(verb)} <b>${percentile == null ? "—" : `${percentile}%`}</b> of ${escHtml(sexWord)} your age</div>
      ${where}
      ${referenceLine}
      ${provenance ? `<div class="hstand-source lbl">${escHtml(provenance)}</div>` : ""}
    </div>`;
}

function hstandRefSummaryHtml(
  comparisons: HealthStandingComparison[] | null | undefined,
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
    : `If you stood among ${escHtml(sexWord)} in their ${escHtml(String(referenceAge))}s`;
  const rows = list.map((comparison) => {
    const referencePercentile = hstandPct(comparison.reference_percentile);
    const tone = hstandBandTone(referencePercentile);
    const verb = comparison.verb || "ahead of";
    return `<div class="hstand-refsum-row">
        <span class="hstand-refsum-metric">${escHtml(comparison.label || comparison.key || "")}</span>
        <span class="hstand-refsum-bar"><span class="hstand-track"><span class="hstand-fill hstand-fill-${tone}" style="width:${referencePercentile ?? 0}%"></span></span></span>
        <span class="hstand-refsum-read">${escHtml(verb)} <b>${referencePercentile == null ? "—" : `${referencePercentile}%`}</b></span>
      </div>`;
  }).join("");
  return `<div class="hstand-refsum">
      <span class="lbl hstand-refsum-head">${head}</span>
      ${rows}
    </div>`;
}

function hstandDimensionHtml(dimension: HealthStandingDimension, index: number): string {
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

function hstandBpRows(rows: HealthStandingBpReading[] | null | undefined): string {
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

function hstandBodyCompHtml(bodyComp: HealthStandingBodyComp | null | undefined): string {
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

function hstandBpCardHtml(bp: HealthStandingBloodPressure | null | undefined): string {
  const data = bp || {};
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

function renderHealthStandingHtml(data: HealthStandingRead | null | undefined, options: HealthStandingRenderOptions = {}): string {
  const standing = data || {};
  const subject = standing.subject || {};
  const hero = standing.hero || {};
  const ageNumber = Number(subject.age);
  const hasAge = Number.isFinite(ageNumber);
  const actualDecade = hasAge ? hstandDecade(ageNumber) : null;
  const referenceAge = Number(subject.reference_age || options.referenceAge || actualDecade || 20);
  const referenceAges = [...new Set([...(actualDecade ? [actualDecade] : []), 20, 30, 40, 50, 60, 70])];
  const referenceButtons = referenceAges.map((age) => {
    const label = actualDecade != null && age === actualDecade ? "Age peers" : `${age}s`;
    return `<button type="button" class="hstand-refbtn${age === referenceAge ? " active" : ""}" data-refage="${age}">${escHtml(label)}</button>`;
  }).join("");

  const calendarAge = hero.calendar_age != null ? escHtml(String(hero.calendar_age)) : subject.age != null ? escHtml(String(subject.age)) : "—";
  const biologicalAge = hero.biological_age != null ? escHtml(String(hero.biological_age)) : "—";
  const biologicalSource = hero.biological_age_source === "lab" ? "biological age" : "Cairn read";
  const direction = hero.direction || "unknown";
  const arrow = direction === "younger" ? "↓" : direction === "older" ? "↑" : "≈";
  const directionWord = direction === "younger" ? "younger" : direction === "older" ? "older" : "in line";
  const delta = hero.biological_age_delta;
  const deltaRounded = delta != null ? Math.abs(Math.round(Number(delta))) : null;
  const deltaChip = delta != null && deltaRounded != null && deltaRounded >= 1
    ? `<span class="hstand-deltachip ${Number(delta) < 0 ? "is-younger" : "is-older"}">${Number(delta) < 0 ? "−" : "+"}${deltaRounded} yr${deltaRounded === 1 ? "" : "s"}</span>`
    : "";
  const confidence = standing.confidence ? `<span class="hstand-conf">${escHtml(standing.confidence)} confidence</span>` : "";

  const momentum = standing.momentum || {};
  const momentumHtml = momentum.has_momentum && Array.isArray(momentum.chips) && momentum.chips.length
    ? `<section class="hstand-momentum reveal" style="${stagger(0)}">
        <span class="lbl">This quarter — moving the right way</span>
        <div class="hstand-chips">${momentum.chips.map((chip) => `<span class="hstand-chip hstand-chip-${chip.dir === "good" ? "good" : "n"}">${escHtml(chip.text)}</span>`).join("")}</div>
      </section>`
    : "";

  const leadLever = standing.lead_lever;
  const leverHtml = leadLever
    ? `<section class="hstand-lever reveal" style="${stagger(1)}">
        <span class="lbl">The one lever${leadLever.uncertain ? " · worth confirming" : ""}</span>
        <h3>${escHtml(leadLever.group || "")}</h3>
        <p>${escHtml(leadLever.why || "")}</p>
        ${leadLever.move ? `<p class="hstand-lever-move"><span class="lbl">The move</span>${escHtml(leadLever.move)}</p>` : ""}
        <button class="linkbtn" type="button" data-lever-go>See the markers →</button>
      </section>`
    : "";

  const sexWord = subject.sex === "female" ? "women" : "men";
  const comparisons = Array.isArray(standing.comparisons) && standing.comparisons.length
    ? standing.comparisons.map((comparison) => hstandCompHtml(comparison, sexWord, ageNumber)).join("")
    : `<div class="hstand-empty">VO2max or a DEXA/body-fat anchor unlocks real age-band percentiles.</div>`;
  const dimensions = Array.isArray(standing.dimensions)
    ? standing.dimensions
        .filter((dimension) => dimension.id !== "bp" && dimension.id !== "body")
        .map(hstandDimensionHtml)
        .join("")
    : "";
  const balanceHtml = standing.balance
    ? `<section class="hstand-balance reveal"><span class="lbl">Living well</span><p>${escHtml(standing.balance)}</p></section>`
    : "";

  return `<div class="hstand">
      <section class="hstand-hero hstand-hero-${escAttr(direction)}">
        <div class="hstand-hero-main">
          <span class="lbl">Health standing</span>
          <h2>${escHtml(hero.headline || standing.headline || "Your standing read will sharpen as data lands.")}</h2>
          <div class="hstand-ages">
            <span class="hstand-age"><b>${calendarAge}</b><em>calendar</em></span>
            <span class="hstand-age-mid"><span class="hstand-age-arrow">${arrow}</span><em>${directionWord}</em></span>
            <span class="hstand-age hstand-age-bio"><b>${biologicalAge}</b><em>${escHtml(biologicalSource)}</em>${deltaChip}</span>
          </div>
          ${confidence}
        </div>
        <div class="hstand-ref">
          <span class="lbl">Compare against</span>
          <div class="hstand-refgrid">${referenceButtons}</div>
          ${hstandRefSummaryHtml(standing.comparisons, referenceAge, actualDecade, sexWord)}
        </div>
      </section>
      ${momentumHtml}
      ${leverHtml}
      <details class="full-read">
        <summary>Full standing</summary>
        <div class="full-read-body">
          <section class="hstand-grid">
            ${hstandBodyCompHtml(standing.body_comp)}
            ${hstandBpCardHtml(standing.blood_pressure)}
          </section>
          <div id="hDexaSlot" class="pdexa-slot"></div>
          <section class="hstand-panel">
            <div class="hstand-panel-head"><span class="lbl">Where you stand</span><span class="lbl">among ${escHtml(sexWord)} your age</span></div>
            ${comparisons}
          </section>
          ${dimensions ? `<section class="hstand-dims">${dimensions}</section>` : ""}
          ${balanceHtml}
        </div>
      </details>
    </div>`;
}

const CAIRN_HEALTH_STANDING = {
  hstandDecade,
  hstandPct,
  localDateTimeInputValue,
  hstandTone,
  hstandBandTone,
  hstandMeasureHtml,
  hstandCompHtml,
  hstandRefSummaryHtml,
  hstandDimensionHtml,
  hstandBpRows,
  hstandBodyCompHtml,
  hstandBpCardHtml,
  renderHealthStandingHtml,
};

Object.assign(globalThis, { CairnHealthStanding: CAIRN_HEALTH_STANDING });

if (typeof window !== "undefined") {
  window.CairnHealthStanding = CAIRN_HEALTH_STANDING;
}
})();

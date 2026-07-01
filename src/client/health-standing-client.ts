// @ts-check
// Pure Health Standing renderer for the vanilla PWA.

type HealthStandingRead = import("../contracts/client-api.js").ClientHealthStanding;

type HealthStandingRenderOptions = {
  referenceAge?: unknown;
};

(() => {
const {
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
} = CairnHealthStandingPrimitives;

function renderHealthStandingHtml(data: HealthStandingRead | null | undefined, options: HealthStandingRenderOptions = {}): string {
  if (!data) {
    return `<div class="hstand hstand-panel"><div class="empty">Health standing will appear once the read is available.</div></div>`;
  }
  const primitives = CairnHealthStandingPrimitives;
  const standing: Partial<HealthStandingRead> = data;
  const subject: Partial<HealthStandingRead["subject"]> = standing.subject ?? {};
  const hero: Partial<HealthStandingRead["hero"]> = standing.hero ?? {};
  const ageNumber = Number(subject.age);
  const hasAge = Number.isFinite(ageNumber);
  const actualDecade = hasAge ? primitives.hstandDecade(ageNumber) : null;
  const referenceAge = Number(subject.reference_age || options.referenceAge || actualDecade || 20);
  const referenceAges = [...new Set([...(actualDecade ? [actualDecade] : []), 20, 30, 40, 50, 60, 70])];
  const referenceButtons = referenceAges.map((age) => {
    const label = actualDecade != null && age === actualDecade ? "Age peers" : `${age}s`;
    return `<button type="button" class="hstand-refbtn${age === referenceAge ? " active" : ""}" data-refage="${age}">${escHtml(label)}</button>`;
  }).join("");

  const direction = hero.direction || "unknown";
  const arrow = direction === "younger" ? "↓" : direction === "older" ? "↑" : "≈";
  const directionWord = direction === "younger" ? "trending younger" : direction === "older" ? "reading older" : "in line";
  // Plain-language biological-age read — the hero renders THIS, never a raw bio-age
  // number (constitution: no score on the athlete). Prefer the server's `bio_read`;
  // else phrase from direction when a REAL measure (lab / PhenoAge) backs it.
  const heroRead = typeof hero.bio_read === "string" && hero.bio_read.trim() ? hero.bio_read.trim() : "";
  const hasRealBio = hero.biological_age_source === "lab" || hero.biological_age_source === "phenoage";
  const fallbackRead = hasRealBio
    ? (direction === "younger" ? "Your biological age is reading younger than your calendar age."
      : direction === "older" ? "Your biological age is reading older than your calendar age — the movable kind."
      : direction === "aligned" ? "Your biological age is right in line with your calendar age." : "")
    : "";
  const bioReadText = heroRead || fallbackRead;
  const directionLine = direction && direction !== "unknown"
    ? `<p class="hstand-heroline hstand-heroline-${escAttr(String(direction))}"><span class="hstand-heroarrow" aria-hidden="true">${arrow}</span> <span class="hstand-heroword">${escHtml(directionWord)}</span>${bioReadText ? ` — <span class="hstand-heroread">${escHtml(bioReadText)}</span>` : ""}</p>`
    : "";
  const confidence = standing.confidence ? `<span class="hstand-conf">${escHtml(standing.confidence)} confidence</span>` : "";

  const momentum: Partial<HealthStandingRead["momentum"]> = standing.momentum ?? {};
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
    ? standing.comparisons.map((comparison) => primitives.hstandCompHtml(comparison, sexWord, ageNumber)).join("")
    : `<div class="hstand-empty">VO2max or a DEXA/body-fat anchor unlocks real age-band percentiles.</div>`;
  const dimensions = Array.isArray(standing.dimensions)
    ? standing.dimensions
        .filter((dimension) => dimension.id !== "bp" && dimension.id !== "body")
        .map(primitives.hstandDimensionHtml)
        .join("")
    : "";
  const balanceHtml = standing.balance
    ? `<section class="hstand-balance reveal"><span class="lbl">Living well</span><p>${escHtml(standing.balance)}</p></section>`
    : "";

  return `<div class="hstand">
      <section class="hstand-hero hstand-hero-${escAttr(String(direction))}">
        <div class="hstand-hero-main">
          <span class="lbl">Health standing</span>
          <h2>${escHtml(hero.headline || standing.headline || "Your standing read will sharpen as data lands.")}</h2>
          ${directionLine}
          ${confidence}
        </div>
      </section>
      ${momentumHtml}
      ${leverHtml}
      <details class="full-read">
        <summary>Full standing</summary>
        <div class="full-read-body">
          <section class="hstand-ref">
            <span class="lbl">Compare against</span>
            <div class="hstand-refgrid">${referenceButtons}</div>
            ${primitives.hstandRefSummaryHtml(standing.comparisons, referenceAge, actualDecade, sexWord)}
          </section>
          <section class="hstand-grid">
            ${primitives.hstandBodyCompHtml(standing.body_comp)}
            ${primitives.hstandBpCardHtml(standing.blood_pressure)}
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
  hstandDecade: CairnHealthStandingPrimitives.hstandDecade,
  hstandPct: CairnHealthStandingPrimitives.hstandPct,
  localDateTimeInputValue: CairnHealthStandingPrimitives.localDateTimeInputValue,
  hstandTone: CairnHealthStandingPrimitives.hstandTone,
  hstandBandTone: CairnHealthStandingPrimitives.hstandBandTone,
  hstandMeasureHtml: CairnHealthStandingPrimitives.hstandMeasureHtml,
  hstandCompHtml: CairnHealthStandingPrimitives.hstandCompHtml,
  hstandRefSummaryHtml: CairnHealthStandingPrimitives.hstandRefSummaryHtml,
  hstandDimensionHtml: CairnHealthStandingPrimitives.hstandDimensionHtml,
  hstandBpRows: CairnHealthStandingPrimitives.hstandBpRows,
  hstandBodyCompHtml: CairnHealthStandingPrimitives.hstandBodyCompHtml,
  hstandBpCardHtml: CairnHealthStandingPrimitives.hstandBpCardHtml,
  renderHealthStandingHtml,
};

Object.assign(globalThis, { CairnHealthStanding: CAIRN_HEALTH_STANDING });

if (typeof window !== "undefined") {
  window.CairnHealthStanding = CAIRN_HEALTH_STANDING;
}
})();

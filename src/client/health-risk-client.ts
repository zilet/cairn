// @ts-check
// Pure Cardiovascular Risk (AHA PREVENT 2023) renderer for the vanilla PWA.

type CardiovascularRiskRead = import("../contracts/client-api.js").ClientCardiovascularRisk;
type CardiovascularRiskHorizon = import("../contracts/client-api.js").ClientRiskHorizon;
type CardiovascularRiskEnhancer = import("../contracts/client-api.js").ClientRiskEnhancer;
type CardiovascularRiskProjection = import("../contracts/client-api.js").ClientRiskProjection;
type CardiovascularRiskAssumption = import("../contracts/client-api.js").ClientPreventAssumption;

(() => {
  function riskPct(fraction: unknown): string | null {
    const n = Number(fraction);
    return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : null;
  }

  function finiteNumber(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  function pointForRisk(year: number, fraction: number | null): { x: number; y: number } {
    const x = year === 30 ? 350 : year === 10 ? 164 : 24;
    const risk = clamp01((fraction ?? 0) / 0.35);
    return { x, y: Math.round((166 - risk * 112) * 10) / 10 };
  }

  function projectionPressure(projection: CardiovascularRiskProjection): number | null {
    const current = finiteNumber(projection.current);
    const target = finiteNumber(projection.target);
    if (current == null || target == null) return null;
    if (projection.expected_direction === "higher") {
      if (target <= 0 || current >= target) return 0;
      return clamp01((target - current) / target);
    }
    if (target <= 0 || current <= target) return 0;
    return clamp01((current - target) / Math.max(target, 1));
  }

  function hrisk_projectionLabel(projection: CardiovascularRiskProjection): string | null {
    if (projection.current == null) return null;
    const unit = projection.unit ? escHtml(projection.unit) : "";
    return `${escHtml(projection.label)} ${escHtml(String(projection.current))}${unit} to ${escHtml(String(projection.target))}${unit}`;
  }

  function hrisk_horizonStat(
    label: string,
    horizon: CardiovascularRiskHorizon,
    note: string,
    primary?: boolean
  ): string {
    const ten = riskPct(horizon.ten_year);
    const thirty = horizon.thirty_year != null ? riskPct(horizon.thirty_year) : null;
    return `<div class="hrisk-stat${primary ? " hrisk-stat-primary" : ""}">
    <span class="lbl">${escHtml(label)} · 10-yr</span>
    <b class="hrisk-stat-num">${ten ?? "—"}</b>
    <span class="hrisk-stat-sub">${thirty ? `30-yr: ${thirty}` : escHtml(note)}</span>
  </div>`;
  }

  function hrisk_enhancerRow(enhancer: CardiovascularRiskEnhancer): string {
    return `<div class="hrisk-enh-row">
    <div class="hrisk-enh-top"><b>${escHtml(enhancer.label)}</b><span class="hrisk-enh-find">${escHtml(enhancer.finding)}</span></div>
    <p class="hrisk-enh-why">${escHtml(enhancer.why)}</p>
    ${enhancer.lever ? `<p class="hrisk-enh-lever"><span class="lbl">The move</span>${escHtml(enhancer.lever)}</p>` : ""}
  </div>`;
  }

  // The vascular age is derived from PREVENT's base inputs alone — it does NOT see
  // ApoB/Lp(a)/hs-CRP/fitness/family-history, so it can read favorable while those
  // enhancers say true risk is higher. This is the honesty guard: when that tension
  // exists, name it explicitly right beside the number, never let the age stand alone.
  function hrisk_enhancerLede(showsTension: boolean, hasEnhancers: boolean): string {
    if (showsTension) {
      return "Your base numbers read favorable — but the factors below push your real risk higher than this age suggests.";
    }
    if (hasEnhancers) return "These factors shape your risk beyond the base read above.";
    return "No additional risk enhancers stood out from your labs.";
  }

  function hrisk_leverChip(projection: CardiovascularRiskProjection): string {
    if (projection.current == null) return "";
    const unit = projection.unit ? escHtml(projection.unit) : "";
    return `<span class="hrisk-lev-chip"><b>${escHtml(projection.label)}</b> ${escHtml(String(projection.current))}${unit} → ${escHtml(String(projection.target))}${unit}</span>`;
  }

  function hrisk_assumptionRow(assumption: CardiovascularRiskAssumption): string {
    return `<li><b>${escHtml(assumption.input)}</b> assumed ${escHtml(assumption.assumed)} — ${escHtml(assumption.reason)}</li>`;
  }

  function hrisk_riskViz(data: CardiovascularRiskRead): string {
    const prevent = data.prevent;
    const ten = finiteNumber(prevent?.estimates?.total_cvd?.ten_year);
    if (!prevent || ten == null) return "";
    const thirty = finiteNumber(prevent.estimates.total_cvd.thirty_year);
    const current30 = thirty ?? ten;
    const p0 = pointForRisk(0, 0);
    const p10 = pointForRisk(10, ten);
    const p30 = pointForRisk(30, current30);
    // Track E2: optimized path must bind to a real PREVENT counterfactual
    // (prevent.projection / targets_met) when that DTO lands. Until then we keep
    // a calm SVG ribbon only — do NOT invent a second clinical risk score for 3D.
    // See docs/VIZ-3D-ATELIER.md §3 E2. The current visual gap is lever-shaped
    // geometry (not a recompute); honesty copy below says so explicitly.
    const leverPressures = (data.projections ?? []).map(projectionPressure).filter((n): n is number => n != null);
    const leverPressure = leverPressures.length ? leverPressures.reduce((sum, n) => sum + n, 0) / leverPressures.length : 0;
    const enhancerPressure = clamp01((data.enhancers ?? []).length / 5);
    // Prefer a server counterfactual when present; else a temporary lever-shaped
    // visual only (labeled non-clinical in the note below).
    const cf = (prevent as { counterfactual?: { total_cvd?: { ten_year?: number | null; thirty_year?: number | null } } })
      ?.counterfactual?.total_cvd;
    const cf10 = finiteNumber(cf?.ten_year);
    const cf30 = finiteNumber(cf?.thirty_year);
    let o10: { x: number; y: number };
    let o30: { x: number; y: number };
    if (cf10 != null || cf30 != null) {
      o10 = pointForRisk(10, cf10 ?? ten);
      o30 = pointForRisk(30, cf30 ?? cf10 ?? current30);
    } else {
      const optimizedLift = Math.round((18 + leverPressure * 42 + enhancerPressure * 10) * 10) / 10;
      o10 = { x: p10.x, y: Math.min(164, p10.y + optimizedLift * 0.45) };
      o30 = { x: p30.x, y: Math.min(164, p30.y + optimizedLift) };
    }
    const riskLine = `M ${p0.x} ${p0.y} C 76 ${p0.y - 2}, 118 ${p10.y + 8}, ${p10.x} ${p10.y} S 288 ${p30.y}, ${p30.x} ${p30.y}`;
    const optLine = `M ${p0.x} ${p0.y} C 76 ${p0.y}, 118 ${o10.y + 6}, ${o10.x} ${o10.y} S 288 ${o30.y}, ${o30.x} ${o30.y}`;
    const band = `${riskLine} L ${o30.x} ${o30.y} C 288 ${o30.y}, 214 ${o10.y}, ${o10.x} ${o10.y} S 76 ${p0.y}, ${p0.x} ${p0.y} Z`;
    const tenLabel = riskPct(ten) ?? "not available";
    const thirtyLabel = thirty != null ? riskPct(thirty) : null;
    const projectionLabels = (data.projections ?? []).map(hrisk_projectionLabel).filter(Boolean).slice(0, 3);
    const projectionText = projectionLabels.length
      ? projectionLabels.join("; ")
      : "projection targets will appear once current lever values are available";
    const arteryWidth = Math.round((14 - enhancerPressure * 5 - leverPressure * 2) * 10) / 10;
    const plaqueRadius = Math.round((3 + enhancerPressure * 5 + leverPressure * 3) * 10) / 10;
    const aria = [
      `Current PREVENT total CVD risk: 10-year ${tenLabel}`,
      thirtyLabel ? `30-year ${thirtyLabel}` : "30-year horizon not available for this age",
      `optimized lever path shaped by ${projectionText}`,
      `${(data.enhancers ?? []).length} risk enhancer${(data.enhancers ?? []).length === 1 ? "" : "s"} in context`,
    ].join(". ");

    return `<div class="hrisk-viz${prevent.provisional ? " hrisk-viz-provisional" : ""}">
    <div class="hrisk-viz-top">
      <b>30-year risk ribbon</b>
      <span>PREVENT base read with lever targets</span>
    </div>
    <svg class="hrisk-viz-svg" viewBox="0 0 380 210" role="img" aria-label="${escHtml(aria)}">
      <defs>
        <linearGradient id="hriskRibbon" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stop-color="#d8b06a" stop-opacity=".18"/>
          <stop offset="60%" stop-color="#b9684a" stop-opacity=".24"/>
          <stop offset="100%" stop-color="#8d4e3d" stop-opacity=".32"/>
        </linearGradient>
      </defs>
      <path class="hrisk-viz-grid" d="M24 54H350 M24 110H350 M24 166H350"/>
      <path class="hrisk-viz-band" d="${band}"/>
      <path class="hrisk-viz-current" d="${riskLine}"/>
      <path class="hrisk-viz-optimized" d="${optLine}"/>
      <g class="hrisk-viz-artery" transform="translate(214 52)">
        <path class="hrisk-viz-heart" d="M35 21c-8-17-34-10-34 9 0 19 34 39 34 39s34-20 34-39c0-19-26-26-34-9Z"/>
        <path class="hrisk-viz-vessel" style="stroke-width:${arteryWidth}" d="M35 68 C35 92 22 110 22 133 C22 153 35 166 35 188"/>
        <circle class="hrisk-viz-plaque" cx="24" cy="126" r="${plaqueRadius}"/>
        <circle class="hrisk-viz-plaque hrisk-viz-plaque-soft" cx="39" cy="145" r="${Math.max(2.5, plaqueRadius - 2)}"/>
      </g>
      <g class="hrisk-viz-points">
        <circle cx="${p10.x}" cy="${p10.y}" r="4"/>
        <circle cx="${p30.x}" cy="${p30.y}" r="4"/>
        <circle cx="${o30.x}" cy="${o30.y}" r="3"/>
      </g>
      <text class="hrisk-viz-axis" x="24" y="192">today</text>
      <text class="hrisk-viz-axis" x="144" y="192">10 yr ${escHtml(tenLabel)}</text>
      <text class="hrisk-viz-axis" x="292" y="192">${thirtyLabel ? `30 yr ${escHtml(thirtyLabel)}` : "30 yr n/a"}</text>
    </svg>
    <div class="hrisk-viz-legend">
      <span><i class="hrisk-viz-key hrisk-viz-key-current"></i>Current PREVENT path</span>
      <span><i class="hrisk-viz-key hrisk-viz-key-optimized"></i>Optimized lever path</span>
    </div>
    <p class="hrisk-viz-note">${
      cf10 != null || cf30 != null
        ? "The upper path is the computed PREVENT total-CVD read. The lower path is a PREVENT recompute under your lever targets (not a separate clinical score)."
        : "The upper path is the computed PREVENT total-CVD read. The lower path is a provisional visual shaped by current-to-target levers until a full PREVENT counterfactual is available — not a separate clinical risk score."
    }</p>
  </div>`;
  }

  function hrisk_missingHtml(data: CardiovascularRiskRead): string {
    const missing = data.inputs?.missing_inputs ?? [];
    return `<section class="hrisk hrisk-missing">
    <span class="lbl">Cardiovascular risk read</span>
    <p class="hrisk-missing-lead">Add these to see your heart-age read</p>
    ${
      missing.length
        ? `<ul class="hrisk-missing-list">${missing.map((item) => `<li>${escHtml(item)}</li>`).join("")}</ul>`
        : `<p class="hrisk-missing-note">Check back after your next lab or vitals reading.</p>`
    }
  </section>`;
  }

  function hrisk_computedHtml(data: CardiovascularRiskRead): string {
    const prevent = data.prevent;
    if (!prevent) return hrisk_missingHtml(data);
    const age = data.inputs?.age ?? null;
    const vascularAge = prevent.vascular_age;
    const enhancers = data.enhancers ?? [];
    const hasVascular = vascularAge != null;
    const showsTension = hasVascular && age != null && vascularAge < age && enhancers.length > 0;

    const vageHtml = hasVascular
      ? `<div class="hrisk-vage">
        <b class="hrisk-vage-num">${escHtml(String(Math.round(vascularAge)))}</b>
        <span class="hrisk-vage-label">vascular age${age != null ? `<span class="hrisk-vage-sub">vs. ${escHtml(String(age))} calendar</span>` : ""}</span>
      </div>`
      : "";

    const stats = `<div class="hrisk-stats">
    ${hrisk_horizonStat("Total CVD", prevent.estimates.total_cvd, prevent.horizons_note, true)}
    ${hrisk_horizonStat("ASCVD", prevent.estimates.ascvd, prevent.horizons_note)}
    ${hrisk_horizonStat("Heart failure", prevent.estimates.heart_failure, prevent.horizons_note)}
  </div>`;

    const vizHtml = hrisk_riskViz(data);

    const enhancersHtml = `<div class="hrisk-enh">
    <p class="hrisk-enh-lede${showsTension ? " hrisk-enh-lede-tension" : ""}">${escHtml(hrisk_enhancerLede(showsTension, enhancers.length > 0))}</p>
    ${enhancers.length ? enhancers.map(hrisk_enhancerRow).join("") : ""}
  </div>`;

    const leverChips = (data.projections ?? []).map(hrisk_leverChip).filter(Boolean).join("");
    const leversHtml = leverChips
      ? `<div class="hrisk-levers"><span class="lbl">What moves it</span><div class="hrisk-lev-row">${leverChips}</div></div>`
      : "";

    const provisionalHtml = prevent.provisional
      ? `<div class="hrisk-provisional">
        <span class="hrisk-badge">Provisional read</span>
        <ul class="hrisk-assumptions">${prevent.assumptions.map(hrisk_assumptionRow).join("")}</ul>
        <button type="button" class="linkbtn linkbtn-plain hrisk-sharpen" data-risk-sharpen>Answer 3 quick questions to sharpen this →</button>
      </div>`
      : "";

    return `<section class="hrisk">
    <span class="lbl">Cardiovascular risk read</span>
    ${vageHtml}
    ${enhancersHtml}
    ${stats}
    ${vizHtml}
    ${leversHtml}
    ${provisionalHtml}
    <p class="hrisk-frame">${escHtml(prevent.frame)}</p>
  </section>`;
  }

  function renderCardiovascularRiskHtml(data: CardiovascularRiskRead | null | undefined): string {
    if (!data) {
      return `<div class="hrisk hrisk-panel"><div class="empty">Couldn't load your cardiovascular risk read right now.</div></div>`;
    }
    if (data.model_status?.prevent === "insufficient_inputs" || !data.prevent) return hrisk_missingHtml(data);
    return hrisk_computedHtml(data);
  }

  const CAIRN_HEALTH_RISK = {
    renderCardiovascularRiskHtml,
  };

  Object.assign(globalThis, { CairnHealthRisk: CAIRN_HEALTH_RISK });

  if (typeof window !== "undefined") {
    window.CairnHealthRisk = CAIRN_HEALTH_RISK;
  }
})();

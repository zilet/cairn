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

  // The clinical band label shown beside the plain-language interpretation. A
  // category (per ACC/AHA), NOT a 0-100 wellness grade.
  const HRISK_CATEGORY_LABEL: Record<string, string> = {
    low: "Low 10-year risk",
    borderline: "Borderline 10-year risk",
    intermediate: "Intermediate 10-year risk",
    high: "High 10-year risk",
  };

  // A calm, additive interpretation well: what the risk % actually means, in one
  // human sentence, with the ACC/AHA category as a small pill. Empty when the
  // backend has nothing to say (older payload / no ASCVD horizon).
  function hrisk_interpretationHtml(prevent: NonNullable<CardiovascularRiskRead["prevent"]>): string {
    const interpretation = prevent.interpretation ? String(prevent.interpretation) : "";
    if (!interpretation) return "";
    const category = prevent.category ? String(prevent.category) : "";
    const pill =
      category && HRISK_CATEGORY_LABEL[category]
        ? `<span class="hrisk-cat hrisk-cat-${escAttr(category)}">${escHtml(HRISK_CATEGORY_LABEL[category])}</span>`
        : "";
    return `<div class="hrisk-interp">
    <div class="hrisk-interp-head"><span class="lbl">What this means</span>${pill}</div>
    <p class="hrisk-interp-line">${escHtml(interpretation)}</p>
  </div>`;
  }

  // Risk accumulates over the horizon: both paths start at ~0 today and rise to
  // the 10-yr and 30-yr total-CVD reads. The plot region (x 44→328, y 30→150) is
  // kept clear of the decorative heart glyph and the axis row so it never reads
  // busy. clamp scales 0–35% risk across the vertical band.
  const VX0 = 44;
  const VX10 = 186;
  const VX30 = 328;
  const VYBASE = 150;
  const VYTOP = 30;

  function vizY(fraction: number | null): number {
    return Math.round((VYBASE - clamp01((fraction ?? 0) / 0.35) * (VYBASE - VYTOP)) * 10) / 10;
  }

  function vizPath(ten: number, thirty: number): string {
    const y10 = vizY(ten);
    const y30 = vizY(thirty);
    return `M ${VX0} ${VYBASE} C ${VX0 + 46} ${VYBASE}, ${VX10 - 46} ${y10}, ${VX10} ${y10} S ${VX30 - 46} ${y30}, ${VX30} ${y30}`;
  }

  // The showpiece: a REAL current-vs-targets-met counterfactual straight from
  // data.prevent.projection (a genuine second PREVENT pass). Every dimension is
  // bound to a computed number — there is no invented "optimized lift". When no
  // lever can be pulled, only the current trajectory is drawn (no fabricated gap).
  function hrisk_riskViz(data: CardiovascularRiskRead): string {
    const prevent = data.prevent;
    const projection = prevent?.projection ?? null;
    const curTen = finiteNumber(projection?.current?.ten_year ?? prevent?.estimates?.total_cvd?.ten_year);
    if (!prevent || curTen == null) return "";
    const curThirty = finiteNumber(projection?.current?.thirty_year ?? prevent.estimates.total_cvd.thirty_year);
    const cur30 = curThirty ?? curTen;

    const levers = projection?.levers_applied ?? [];
    const hasLevers = levers.length > 0;
    const optTen = hasLevers ? finiteNumber(projection?.targets_met?.ten_year) : null;
    const optThirtyRaw = hasLevers ? finiteNumber(projection?.targets_met?.thirty_year) : null;
    const opt30 = optThirtyRaw ?? optTen;
    const curVage = finiteNumber(projection?.current?.vascular_age ?? prevent.vascular_age);
    const optVage = hasLevers ? finiteNumber(projection?.targets_met?.vascular_age) : null;

    const tenLabel = riskPct(curTen) ?? "not available";
    const thirtyLabel = curThirty != null ? riskPct(curThirty) : null;
    const optTenLabel = optTen != null ? riskPct(optTen) : null;
    const optThirtyLabel = optThirtyRaw != null ? riskPct(optThirtyRaw) : null;

    // Enumerate ONLY the dimensions that actually move at display precision. For a
    // young, low-risk person the 10-yr % can round identical while the 30-yr and
    // vascular age visibly improve — so the copy never claims "from 0.7% to 0.7%".
    // If nothing changes visibly, there's no gap to draw (no fabricated ribbon).
    const changed: string[] = [];
    if (thirtyLabel && optThirtyLabel && optThirtyLabel !== thirtyLabel) {
      changed.push(`30-year risk from ${thirtyLabel} to ${optThirtyLabel}`);
    }
    if (optTenLabel && optTenLabel !== tenLabel) {
      changed.push(`10-year risk from ${tenLabel} to ${optTenLabel}`);
    }
    if (curVage != null && optVage != null && optVage !== curVage) {
      changed.push(`vascular age from ${curVage} to ${optVage}`);
    }
    const showOptimized = hasLevers && optTen != null && opt30 != null && changed.length > 0;

    const curLine = vizPath(curTen, cur30);
    const optLine = showOptimized ? vizPath(optTen!, opt30!) : "";
    const y10 = vizY(curTen);
    const y30 = vizY(cur30);
    const oy10 = showOptimized ? vizY(optTen!) : y10;
    const oy30 = showOptimized ? vizY(opt30!) : y30;
    const band = showOptimized
      ? `${curLine} L ${VX30} ${oy30} C ${VX30 - 46} ${oy30}, ${VX10 + 46} ${oy10}, ${VX10} ${oy10} S ${VX0 + 46} ${VYBASE}, ${VX0} ${VYBASE} Z`
      : "";

    const deltaSentence = showOptimized
      ? `Hitting your lever targets lowers your ${changed.join(", ")} — recomputed with the PREVENT equations, not a separate score.`
      : "No modifiable lever moves this read right now, so only your current PREVENT trajectory is shown.";

    const aria = [
      `Current PREVENT total CVD risk: 10-year ${tenLabel}`,
      thirtyLabel ? `30-year ${thirtyLabel}` : "30-year horizon not available for this age",
      showOptimized
        ? `if you hit your targets: ${changed.join(", ")}, from ${levers.map((l) => l.label).join(", ")}`
        : "no lever changes this read",
    ].join(". ");

    const optChips = showOptimized
      ? `<div class="hrisk-viz-legend">
      <span><i class="hrisk-viz-key hrisk-viz-key-current"></i>Current path</span>
      <span><i class="hrisk-viz-key hrisk-viz-key-optimized"></i>If you hit your targets</span>
    </div>`
      : `<div class="hrisk-viz-legend">
      <span><i class="hrisk-viz-key hrisk-viz-key-current"></i>Current path</span>
    </div>`;

    return `<div class="hrisk-viz${prevent.provisional ? " hrisk-viz-provisional" : ""}">
    <div class="hrisk-viz-top">
      <b>Risk trajectory</b>
      <span>${showOptimized ? "Current vs. if you hit your targets" : "Your current PREVENT path"}</span>
    </div>
    <svg class="hrisk-viz-svg" viewBox="0 0 360 196" role="img" aria-label="${escHtml(aria)}">
      <defs>
        <linearGradient id="hriskRibbon" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#b9684a" stop-opacity=".26"/>
          <stop offset="100%" stop-color="#b9684a" stop-opacity=".05"/>
        </linearGradient>
      </defs>
      <path class="hrisk-viz-grid" d="M${VX0} ${VYTOP}H${VX30} M${VX0} ${(VYTOP + VYBASE) / 2}H${VX30} M${VX0} ${VYBASE}H${VX30}"/>
      <g class="hrisk-viz-motif" aria-hidden="true" transform="translate(${VX0 - 8} 8)">
        <path class="hrisk-viz-heart" d="M9 16C3 8 -3 12 1 18 3 21 9 25 9 25s6-4 8-7c4-6 -2-10 -8-2Z"/>
      </g>
      ${band ? `<path class="hrisk-viz-band" d="${band}"/>` : ""}
      <path class="hrisk-viz-current" d="${curLine}"/>
      ${optLine ? `<path class="hrisk-viz-optimized" d="${optLine}"/>` : ""}
      <g class="hrisk-viz-points">
        <circle cx="${VX10}" cy="${y10}" r="4"/>
        <circle cx="${VX30}" cy="${y30}" r="4"/>
        ${showOptimized ? `<circle class="hrisk-viz-point-opt" cx="${VX30}" cy="${oy30}" r="3.5"/>` : ""}
      </g>
      <text class="hrisk-viz-axis" x="${VX0}" y="180">today</text>
      <text class="hrisk-viz-axis" x="${VX10}" y="180" text-anchor="middle">10 yr ${escHtml(tenLabel)}</text>
      <text class="hrisk-viz-axis" x="${VX30}" y="180" text-anchor="end">${thirtyLabel ? `30 yr ${escHtml(thirtyLabel)}` : "30 yr n/a"}</text>
    </svg>
    ${optChips}
    <p class="hrisk-viz-note">${escHtml(deltaSentence)}</p>
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

    const interpHtml = hrisk_interpretationHtml(prevent);
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
    ${interpHtml}
    ${vizHtml}
    ${leversHtml}
    ${provisionalHtml}
    <p class="hrisk-frame">${escHtml(data.frame || prevent.frame)}</p>
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

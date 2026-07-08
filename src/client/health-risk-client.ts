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

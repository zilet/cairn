// @ts-check
// Progress → Fuel → Intake. Pure, escaped rendering over the deterministic
// nutrition-progress read; missing days/nutrients remain visible gaps.

type IntakeProgress = import("../contracts/client.js").ClientNutritionProgress;
type IntakeNutrient = import("../contracts/client.js").ClientNutritionProgressNutrient;

(() => {
  const ORDER: IntakeNutrient[] = ["kcal", "protein_g", "carbs_g", "fat_g", "fiber_g"];
  const SHORT: Record<IntakeNutrient, string> = {
    kcal: "Energy",
    protein_g: "Protein",
    carbs_g: "Carbs",
    fat_g: "Fat",
    fiber_g: "Fiber",
  };

  function intakeNumber(value: unknown, unit: string): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return "unknown";
    const rounded = unit === "kcal" ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toLocaleString();
    return `${rounded} ${unit}`;
  }

  function intakeTrend(value: unknown): string {
    return value === "rising"
      ? "trending up"
      : value === "falling"
        ? "trending down"
        : value === "steady"
          ? "holding steady"
          : "trend still forming";
  }

  function intakeDate(value: string): string {
    return typeof dateLabel === "function" ? dateLabel(value) : value;
  }

  function unavailableHtml(): string {
    return `<div class="empty">The intake read isn't available right now. Your recorded food is still safe.</div>`;
  }

  function intakeChartHtml(progress: IntakeProgress, selected: IntakeNutrient): string {
    const summary = progress.nutrients.find((item) => item.nutrient === selected);
    const points = progress.series
      .map((day) => day.nutrients[selected])
      .filter((value): value is number => value != null && Number.isFinite(Number(value)));
    const targetFor = (day: IntakeProgress["series"][number]): number | null => {
      if (selected === "fiber_g") return 30;
      const value = day.target?.[selected as "kcal" | "protein_g" | "carbs_g" | "fat_g"];
      return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
    };
    const targets = progress.series.map(targetFor).filter((value): value is number => value != null);
    const ceiling = Math.max(1, ...points.map(Number), ...targets);
    const bars = progress.series
      .map((day) => {
        const value = day.nutrients[selected];
        const known = value != null && Number.isFinite(Number(value));
        const target = targetFor(day);
        const height = known ? Math.max(3, Math.min(100, (Number(value) / ceiling) * 100)) : 0;
        const targetHeight = target == null ? null : Math.max(0, Math.min(100, (target / ceiling) * 100));
        const partial = day.capture === "partial" || day.capture === "open" ? " partial" : "";
        const title = known
          ? `${intakeDate(day.date)}: ${intakeNumber(value, summary?.unit || "g")} recorded${partial ? " · partial day" : ""}`
          : `${intakeDate(day.date)}: ${day.logged ? `${SHORT[selected]} unknown` : "unlogged day"}`;
        return `<span class="nprog-day${known ? "" : " gap"}${partial}" role="img" aria-label="${escAttr(title)}" title="${escAttr(title)}">
          ${known ? `<i style="height:${height.toFixed(1)}%"></i>` : `<i aria-hidden="true"></i>`}
          ${targetHeight == null ? "" : `<em style="bottom:${targetHeight.toFixed(1)}%" aria-hidden="true"></em>`}
        </span>`;
      })
      .join("");
    const referenceLabel =
      summary?.reference != null && summary.reference_label
        ? selected === "fiber_g"
          ? `${intakeNumber(summary.reference, summary.unit)} · ${summary.reference_label}`
          : `Daily marks follow the ${summary.reference_label.replace(/^current\s+/i, "")} effective on each date · current ${intakeNumber(summary.reference, summary.unit)}`
        : "No target is invented for this nutrient.";
    return `<section class="nprog-chartcard" aria-labelledby="nprogChartTitle">
      <div class="nprog-charthead">
        <div><div class="lbl" id="nprogChartTitle">${escHtml(SHORT[selected])} timeline</div>
          <div class="nprog-chartread">${escHtml(summary?.average == null ? "No known values in this window" : `${intakeNumber(summary.average, summary.unit)} recorded average · ${intakeTrend(summary.trend)}`)}</div></div>
        <div class="nprog-reftext">${escHtml(referenceLabel)}</div>
      </div>
      <div class="nprog-chart" role="group" aria-label="${escAttr(`${SHORT[selected]} by day; gaps are unlogged or unknown, never zero`)}">
        <div class="nprog-bars">${bars}</div>
      </div>
      <div class="nprog-axis"><span>${escHtml(intakeDate(progress.since))}</span><span>visible gaps = unknown</span><span>${escHtml(intakeDate(progress.through))}</span></div>
    </section>`;
  }

  function intakeBalanceHtml(progress: IntakeProgress): string {
    const split = progress.energy_split;
    if (!split)
      return `<div class="nprog-balance"><div class="lbl">Macro balance</div><p>Not enough days have all three energy macros known to calculate a balance.</p></div>`;
    const rows = [
      ["Protein", split.protein_pct],
      ["Carbs", split.carbs_pct],
      ["Fat", split.fat_pct],
    ];
    return `<div class="nprog-balance"><div class="lbl">Recorded macro balance</div>
      <div class="nprog-split" role="img" aria-label="${escAttr(`Recorded macro energy split: ${split.protein_pct}% protein, ${split.carbs_pct}% carbohydrate, ${split.fat_pct}% fat across ${split.known_days} known days`)}">
        ${rows.map(([label, value]) => `<span><b style="width:${Number(value)}%"></b><i>${escHtml(String(label))} ${Number(value)}%</i></span>`).join("")}
      </div>
      <p>Calculated only across ${split.known_days} days where protein, carbohydrate, and fat were all known.</p>
    </div>`;
  }

  function intakeFoodQualityHtml(progress: IntakeProgress): string {
    const estimates = progress.food_quality_estimates;
    if (!estimates) return "";
    if (!estimates.sampled_entries) {
      return `<section class="nprog-health nprog-quality"><div class="lbl">Food quality estimates</div>
        <p>${escHtml(estimates.note)}</p></section>`;
    }
    const quality = estimates.food_quality;
    const saturated = estimates.saturated_fat;
    const sugar = estimates.added_sugar;
    const omega = estimates.omega_3_source;
    const grams = estimates.fat_grams;
    const fatRead = grams.sampled_entries
      ? `${intakeNumber(grams.average_saturated_fat_g, "g")} saturated and ${intakeNumber(grams.average_unsaturated_fat_g, "g")} unsaturated estimated average per sampled entry across ${grams.sampled_entries} ${grams.sampled_entries === 1 ? "entry" : "entries"}`
      : `${saturated.low} low · ${saturated.moderate} moderate · ${saturated.high} high saturated-fat estimates`;
    const mineralRead = `sodium high ${estimates.sodium.high}; potassium moderate/high ${
      estimates.potassium.moderate + estimates.potassium.high
    }; calcium moderate/high ${estimates.calcium.moderate + estimates.calcium.high}; iron moderate/high ${
      estimates.iron.moderate + estimates.iron.high
    }`;
    const rows = [
      [
        "Food composition",
        `${quality.mostly_whole} mostly whole · ${quality.mixed} mixed · ${quality.mostly_ultra_processed} mostly ultra-processed`,
      ],
      ["Fat quality", fatRead],
      ["Added sugar", `${sugar.low} low · ${sugar.moderate} moderate · ${sugar.high} high estimates`],
      ["Omega-3 source", `${omega.yes} present · ${omega.no} absent · ${omega.unknown} unknown`],
      ["Mineral signals", mineralRead],
    ];
    return `<section class="nprog-health nprog-quality"><div class="lbl">Food quality estimates</div>
      <ul>${rows
        .map(
          ([label, value]) =>
            `<li class="nprog-healthrow"><div class="nprog-healthtop"><span>${escHtml(label)}</span><span class="level-chip">sample only</span></div><p>${escHtml(value)}</p></li>`
        )
        .join("")}</ul>
      <div class="nprog-frame">${escHtml(estimates.note)} Preparation details and user-reported oils take priority when available; these remain estimates.</div>
    </section>`;
  }

  function safeCitation(value: unknown): string {
    const raw = String(value || "").trim();
    if (!/^https?:\/\//i.test(raw)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
      return raw ? `<span class="nprog-evidence">Evidence: ${escHtml(raw)}</span>` : "";
    }
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return `<a class="linkbtn linkbtn-sm" href="${escAttr(url.href)}" target="_blank" rel="noopener noreferrer">See evidence</a>`;
    } catch {
      return "";
    }
  }

  function intakeHealthHtml(progress: IntakeProgress): string {
    if (!progress.health_context.length) {
      return `<section class="nprog-health"><div class="lbl">Longevity &amp; bloodwork context</div>
        <p>No active nutrition-specific bloodwork context needs space here right now.</p>
        <div class="nprog-frame">${escHtml(progress.frame)}</div></section>`;
    }
    const rows = progress.health_context
      .map((item) => {
        const stale = item.stale || item.stale_measurement;
        const state = stale
          ? "older context"
          : item.uncertain
            ? "uncertain"
            : item.domain === "nutrition"
              ? "active nutrition context"
              : "worth keeping in view";
        const detail = item.transient_reason || item.rescan_reason || item.rationale || "";
        return `<li class="nprog-healthrow">
          <div class="nprog-healthtop"><span>${escHtml(item.marker || "Health context")}</span><span class="level-chip">${escHtml(state)}</span></div>
          ${item.directive ? `<p>${escHtml(item.directive)}</p>` : ""}${detail ? `<small>${escHtml(detail)}</small>` : ""}
          ${safeCitation(item.citation)}
        </li>`;
      })
      .join("");
    return `<section class="nprog-health"><div class="lbl">Longevity &amp; bloodwork context</div>
      <ul>${rows}</ul><div class="nprog-frame">${escHtml(progress.frame)}</div></section>`;
  }

  function intakeBodyHtml(progress: IntakeProgress, selected: IntakeNutrient = "kcal"): string {
    const active = ORDER.includes(selected) ? selected : "kcal";
    const coverage = progress.coverage;
    const pending = coverage.pending_entries
      ? ` · ${coverage.pending_entries} ${coverage.pending_entries === 1 ? "entry is" : "entries are"} still being estimated`
      : "";
    const density = String(coverage.observation_density || "none");
    const selector = ORDER.map(
      (nutrient) =>
        `<button class="nprog-pick${nutrient === active ? " active" : ""}" type="button" data-intake-nutrient="${nutrient}" aria-pressed="${nutrient === active ? "true" : "false"}">${SHORT[nutrient]}</button>`
    ).join("");
    return `<div class="nprog">
      <section class="nprog-read reveal" style="--i:0">
        <div class="lbl">Recorded intake · ${progress.window_days} days</div>
        <h1>${escHtml(progress.read)}</h1>
        <p>${escHtml(`Record coverage is ${density}: ${coverage.logged_days} days include food; ${coverage.macro_known_days} closed days have all five tracked nutrients known${pending}. ${coverage.note}`)}</p>
        <div class="nprog-next well-accent-sm"><span class="lbl">One next move</span>${escHtml(progress.next_move)}</div>
      </section>
      <nav class="nprog-picks" aria-label="Choose nutrient timeline">${selector}</nav>
      ${intakeChartHtml(progress, active)}
      ${intakeBalanceHtml(progress)}
      ${intakeFoodQualityHtml(progress)}
      ${intakeHealthHtml(progress)}
    </div>`;
  }

  function render(root: Element, progress: IntakeProgress, selected: IntakeNutrient = "kcal"): void {
    root.innerHTML = intakeBodyHtml(progress, selected);
    root.querySelectorAll<HTMLElement>("[data-intake-nutrient]").forEach((button) =>
      button.addEventListener("click", () => {
        const nutrient = button.dataset.intakeNutrient as IntakeNutrient;
        render(root, progress, nutrient);
      })
    );
  }

  const API = { intakeBodyHtml, intakeChartHtml, intakeFoodQualityHtml, render, unavailableHtml };
  Object.assign(globalThis, { CairnProgressIntake: API });
  if (typeof window !== "undefined") Object.assign(window, { CairnProgressIntake: API });
})();

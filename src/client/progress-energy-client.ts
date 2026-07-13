// @ts-check
// Progress Energy Balance read helpers.

type EnergyExpenditure = {
  tdee?: unknown;
  confidence?: unknown;
  trend_lb_wk?: unknown;
  intake_avg_kcal?: unknown;
  points?: unknown;
  window_days?: unknown;
  tdee_basis?: unknown;
  basis?: unknown;
  coverage?: unknown;
  // Server loss-goal signal — populated only when there's a goal with weight still to
  // lose (see repo/profile.ts projectGoalPace), so its presence marks an intended deficit.
  projection_text?: unknown;
};

type EnergyRead = {
  lead: string;
  body: string;
  tone: "quiet" | "read";
  dir?: "down" | "up" | "flat" | null;
  // A read where easing the deficit is the calm lever — retints the card accent
  // terracotta (attention, never punishment). Absent/false everywhere else.
  lever?: boolean;
};

type EnergyBodyHtml = {
  heroHtml: string;
  cardHtml: string;
};

type NutritionProposal = {
  parsed?: unknown;
  parsed_json?: unknown;
  nutrition?: unknown;
  summary?: unknown;
  notes?: unknown;
};

type NutritionCheckinResult = {
  proposal?: unknown;
  summary?: unknown;
  autonomy?: unknown;
};

(() => {
const ENERGY_CONF_WORD: Record<string, string> = { high: "well-established", medium: "settling in", low: "still early" };

// Lean-safe pace anchors (lb/week). The server defines lean-safe as ≤1% of CURRENT
// bodyweight/week; current bodyweight isn't in the expenditure payload, so the verbal
// read leans on conservative absolute anchors that read as lean-safe across the
// realistic weight range and NEVER alarm — a brisk pace is a calm lever, not a verdict.
const LEAN_SAFE_CEILING_LB_WK = 1.5; // at/under ~1%/wk for anyone ~150 lb+
const FAST_LOSS_LB_WK = 2.0; // beyond this reads as faster than lean-safe for most
const ENERGY_FLAT_BAND_LB_WK = 0.05; // |trend| under this = holding steady

// Confidence as geometry — the "maintenance zone" band widens (and, via CSS in the
// §04d eb-zone rules, softens) as confidence drops. Uncertainty is shown as WIDTH,
// never a number, tick, or score (VISION.md Amendment 2). `none` degrades to a
// phrase-only band (baselineBandHtml draws no track without a range).
const ENERGY_ZONE_RANGE: Record<string, [number, number] | null> = {
  high: [0.4, 0.6],
  medium: [0.32, 0.68],
  low: [0.2, 0.8],
  none: null,
};
const ENERGY_ZONE_PHRASE: Record<string, string> = {
  high: "Your maintenance zone is dialed in.",
  medium: "Your maintenance zone is settling in.",
  low: "Still a wide estimate this week — more logging narrows it.",
  none: "Not enough yet to place your maintenance zone.",
};

function kcalFmt(value: unknown): string {
  return Math.round(Number(value) || 0).toLocaleString();
}

// A weekly weight-change rate as plain words, e.g. "1.1 lb/week" (magnitude only —
// direction rides in the surrounding sentence). Always one decimal.
function rateWords(trend: unknown): string {
  const abs = Math.abs(Math.round(Number(trend) * 10) / 10);
  return `${abs} lb/week`;
}

function energyBasis(exp: EnergyExpenditure | null | undefined): string {
  if (!exp) return "";
  const explicit = typeof exp.basis === "string" ? exp.basis.trim() : "";
  if (explicit) return explicit;
  const basis = String(exp.tdee_basis || "");
  if (basis === "outcome_trend") return "Learned from your intake and weight trend.";
  if (basis === "blended_outcome_prior") return "Settling in — blending your trend with the strongest available starting anchor.";
  if (basis === "measured_rmr_active") return "Backed by measured RMR and recent activity.";
  if (basis === "garmin_total_calories") return "Backed by recent Garmin total-calorie days.";
  if (basis === "profile_seed") return "Starting estimate from your profile and activity setting.";
  return "";
}

// The verbal headline — the reframe (VISION.md Amendment 2 / MacroFactor grammar):
// lead with the OUTCOME the athlete intended, never a target-vs-actual shortfall.
// Numbers may ride INSIDE the sentence as supporting facts; the sentence is the
// object. Pure over the loaded expenditure payload. `projection_text` is the server's
// loss-goal signal (only populated when there's a goal with weight still to lose), so
// its presence distinguishes "the deficit you intended" from a maintenance read.
// Adherence-neutral throughout: a thin week lowers confidence, it never blames.
function energyRead(exp: EnergyExpenditure | null | undefined): EnergyRead {
  if (!exp || exp.tdee == null) {
    return {
      lead: "Not enough logged yet to read your energy balance.",
      body: "Keep logging meals and the odd weigh-in when you can — a few weeks in, I'll read your real energy balance here.",
      tone: "quiet",
      dir: null,
    };
  }
  const conf = String(exp.confidence);
  const trend = exp.trend_lb_wk == null ? null : Number(exp.trend_lb_wk);
  const dir = trend == null ? null : trend < -ENERGY_FLAT_BAND_LB_WK ? "down" : trend > ENERGY_FLAT_BAND_LB_WK ? "up" : "flat";
  const rate = trend == null ? "" : rateWords(trend);
  const around = exp.intake_avg_kcal != null ? `~${kcalFmt(exp.intake_avg_kcal)} kcal/day` : `~${kcalFmt(exp.tdee)} kcal/day`;
  const hasLossGoal = typeof exp.projection_text === "string" && exp.projection_text.trim().length > 0;
  const body = energyBasis(exp);

  // Starting estimate — no outcome evidence yet. Calm, never a gap-as-failure.
  if (conf === "none") {
    const lead = exp.tdee_basis === "profile_seed"
      ? `Starting around ${kcalFmt(exp.tdee)} kcal/day — a few weeks of logging turns this into a real read.`
      : "Still early — keep logging and your real energy balance comes into focus.";
    return { lead, body, tone: "read", dir };
  }

  // Loose week — the read is genuinely looser, so don't make a confident pace claim.
  if (conf === "low") {
    return {
      lead: "The picture's a little loose this week — a few more logged days will sharpen it.",
      body,
      tone: "read",
      dir,
    };
  }

  // Medium/high confidence but no scale trend yet — speak to the steady read.
  if (trend == null) {
    return {
      lead: `Best read is about ${kcalFmt(exp.tdee)} kcal/day to hold steady — a few weigh-ins will show which way you're moving.`,
      body,
      tone: "read",
      dir: null,
    };
  }

  // Medium/high confidence with a real trend — speak to the intended outcome.
  let lead: string;
  let lever = false;
  if (hasLossGoal) {
    if (dir === "down") {
      const absTrend = Math.abs(trend);
      if (absTrend <= LEAN_SAFE_CEILING_LB_WK) {
        lead = `You're running the deficit you set — down about ${rate}, a steady lean-safe pace.`;
      } else if (absTrend <= FAST_LOSS_LB_WK) {
        lead = `Losing at a good clip — down about ${rate}. Sustainable, but if it's faster than you meant, easing the deficit protects muscle.`;
      } else {
        lead = `You're dropping faster than lean-safe — down about ${rate}. Easing the deficit ~100–200 kcal/day protects muscle while you keep losing.`;
        lever = true;
      }
    } else if (dir === "flat") {
      lead = `Weight's holding steady at ${around} — a small trim would start it moving toward your goal.`;
    } else {
      lead = `You're eating a little above a loss right now — weight's edged up about ${rate}. A small trim gets it heading down again.`;
    }
  } else if (dir === "flat") {
    lead = `Holding steady around ${around} — right about where maintenance sits.`;
  } else if (dir === "down") {
    lead = `Drifting down gently, about ${rate}, eating ${around}.`;
  } else {
    lead = `Trending up gently, about ${rate}, eating ${around}.`;
  }
  return { lead, body, tone: "read", dir, lever };
}

function energyUsable(exp: EnergyExpenditure | null | undefined): boolean {
  return !!(exp && exp.tdee != null);
}

function energyHeroHtml(exp: EnergyExpenditure | null | undefined): string {
  if (!energyUsable(exp)) return progressHero("Energy Balance", []);
  return progressHero("Energy Balance", [
    ["est. expenditure · kcal", exp?.tdee],
    exp?.intake_avg_kcal != null ? ["avg intake · kcal", exp.intake_avg_kcal] : null,
    exp?.trend_lb_wk != null ? ["trend · lb/wk", `${Number(exp.trend_lb_wk) > 0 ? "+" : ""}${Math.round(Number(exp.trend_lb_wk) * 10) / 10}`, { text: true }] : null,
  ]);
}

// Quiet contributor rows for the looser reads — what's thin, stated as calm
// information (adherence-neutral), never as a failing. `quiet` pip = thin data,
// "the read is looser"; `ok` when a signal is solid. Words, no numbers.
function energyContribRows(exp: EnergyExpenditure | null | undefined): Array<{ label: string; state: string; tone: "ok" | "quiet" }> {
  const cov = record(exp?.coverage);
  const intakeDays = Number(exp?.points ?? cov.intake_days);
  const weighDays = Number(cov.weigh_in_days);
  const rows: Array<{ label: string; state: string; tone: "ok" | "quiet" }> = [];
  const loggingSolid = Number.isFinite(intakeDays) && intakeDays >= 10;
  rows.push({
    label: "Logging",
    state: loggingSolid ? "steady this week — plenty to read" : "light this week — the read stays looser",
    tone: loggingSolid ? "ok" : "quiet",
  });
  if (Number.isFinite(weighDays)) {
    const weighSolid = weighDays >= 4;
    rows.push({
      label: "Weigh-ins",
      state: weighSolid ? "enough to see the trend" : "a few more sharpen the trend",
      tone: weighSolid ? "ok" : "quiet",
    });
  }
  return rows;
}

// The confidence-as-geometry band: a scoreless "maintenance zone" whose WIDTH grows
// as confidence drops (softening is CSS). No axis, tick, or number — the width IS the
// uncertainty. Low/none also surface the quiet contributor rows. Composes the shared
// §04d primitives (CairnUiReads) rather than reinventing a read.
function energyZoneHtml(exp: EnergyExpenditure | null | undefined): string {
  const raw = String(exp?.confidence ?? "none");
  const key = raw in ENERGY_ZONE_RANGE ? raw : "none";
  const range = ENERGY_ZONE_RANGE[key];
  const band = CairnUiReads.baselineBandHtml({
    label: "Maintenance zone",
    rangeStart: range ? range[0] : undefined,
    rangeEnd: range ? range[1] : undefined,
    phrase: ENERGY_ZONE_PHRASE[key] || ENERGY_ZONE_PHRASE.none,
  });
  const loose = key === "low" || key === "none";
  const contribs = loose ? CairnUiReads.contributorRowsHtml(energyContribRows(exp)) : "";
  if (!band && !contribs) return "";
  return `<div class="eb-zone eb-zone--${key}">${band}${contribs}</div>`;
}

function energyCardHtml(exp: EnergyExpenditure | null | undefined): string {
  const read = energyRead(exp);
  const usable = energyUsable(exp);
  const conf = String(exp?.confidence);
  const points = Number(exp?.points);
  const windowDays = Number(exp?.window_days);
  const confidence = exp?.confidence === "none" ? "starting estimate" : ENERGY_CONF_WORD[conf] || "";
  const ctx = usable
    ? `<div class="eb-ctx lbl">${escHtml([confidence, Number.isFinite(points) && points > 0 ? `${points} outcome day${points === 1 ? "" : "s"}` : "", Number.isFinite(windowDays) ? `${windowDays}-day window` : ""].filter(Boolean).join(" · "))}</div>`
    : "";
  const kicker = !usable ? "Not enough data yet" : conf === "none" ? "Getting your read" : "How you're tracking";
  const leverClass = read.lever ? " eb-card--lever" : "";
  const zone = usable ? energyZoneHtml(exp) : "";
  return `<section class="eb-card reveal${leverClass}" style="--i:1">
      <div class="eb-kicker lbl"><span class="eb-glyph" aria-hidden="true">◇</span> ${escHtml(kicker)}</div>
      <p class="eb-lead">${escHtml(read.lead)}</p>
      ${read.body ? `<p class="eb-body">${escHtml(read.body)}</p>` : ""}
      ${zone}
      ${ctx}
      <div class="eb-foot">
        <button class="ghostbtn eb-checkin" id="runCheckin" type="button">Run a check-in</button>
        <span class="eb-note lbl">a reviewed read — costs an agent call</span>
      </div>
    </section>`;
}

function energyBodyHtml(exp: EnergyExpenditure | null | undefined): EnergyBodyHtml {
  return {
    heroHtml: energyHeroHtml(exp),
    cardHtml: energyCardHtml(exp),
  };
}

function nutritionCheckinLoadingHtml(): string {
  return `<div class="eb-checking lbl"><span class="aspin aspin-xs"></span> ${CairnUi.jobCaptionHtml({ text: "reading your trend…" })}</div>`;
}

function nutritionCheckinOkHtml(result: NutritionCheckinResult | null | undefined): string {
  const summary = result?.summary && String(result.summary).trim();
  return `<div class="eb-checkin-ok settle-in">
            <span class="eb-ok-mark" aria-hidden="true">✓</span>
            <div><div class="eb-ok-lead">No change needed — you're tracking well.</div>
            ${summary ? `<p class="eb-ok-body">${escHtml(summary)}</p>` : ""}</div>
          </div>`;
}

function nutritionCheckinFailHtml(): string {
  return `<div class="eb-checkin-quiet">Couldn't run a check-in right now — no worries, your read above still stands. Try again in a bit.</div>`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function proposalPayload(result: NutritionCheckinResult | null | undefined): NutritionProposal {
  const proposal = record(result?.proposal);
  const payload = proposal.parsed ?? proposal.parsed_json ?? result?.proposal ?? {};
  if (typeof payload === "string") {
    try {
      return record(JSON.parse(payload));
    } catch {
      return {};
    }
  }
  return record(payload);
}

function nutritionCheckinProposalHtml(result: NutritionCheckinResult | null | undefined): string {
  const parsed = proposalPayload(result);
  const autonomy = record(result?.autonomy);
  const scheduled = autonomy.pending === true || autonomy.announced === true;
  const nutrition = record(parsed.nutrition);
  const target = Number(nutrition.target_kcal);
  const prev = nutrition.prev_target_kcal != null ? Number(nutrition.prev_target_kcal) : null;
  const delta = prev != null && Number.isFinite(target) ? target - prev : null;
  const macroBits: string[] = [];
  if (nutrition.protein_g != null) macroBits.push(`${Math.round(Number(nutrition.protein_g))}g protein`);
  if (nutrition.carbs_g != null) macroBits.push(`${Math.round(Number(nutrition.carbs_g))}g carbs`);
  if (nutrition.fat_g != null) macroBits.push(`${Math.round(Number(nutrition.fat_g))}g fat`);
  const reason = nutrition.reason || parsed.summary || "";
  const notes = parsed.notes && String(parsed.notes).trim();
  return `<section class="eb-proposal well-accent settle-in">
      <div class="eb-kicker lbl"><span class="eb-glyph" aria-hidden="true">◇</span> ${scheduled ? "Your team adjusted the next target" : "A target worth considering"}</div>
      <div class="eb-target">
        <span class="numeral numeral-lg"${Number.isFinite(target) ? ` data-cu="${Math.round(target)}"` : ""}>${Number.isFinite(target) ? "0" : "—"}</span>
        <span class="eb-target-unit lbl">kcal / day${delta != null ? ` · ${delta > 0 ? "+" : ""}${kcalFmt(delta)} vs now` : ""}</span>
      </div>
      ${macroBits.length ? `<div class="eb-macros lbl">${escHtml(macroBits.join(" · "))}</div>` : ""}
      ${reason ? `<p class="eb-why">${escHtml(String(reason))}</p>` : ""}
      ${notes ? `<p class="eb-body">${escHtml(notes)}</p>` : ""}
      <div class="eb-foot">
        <button class="draftbtn" id="ckGoMeals" type="button">Open meals</button>
        <button class="ghostbtn" id="ckDismiss" type="button">Got it</button>
      </div>
      <div class="eb-advisory lbl">${scheduled ? `lands ${escHtml(String(autonomy.effective_date || "at the next food-day boundary"))} · meals refresh in the background · Undo available` : "review posture — your call before anything changes"}</div>
    </section>`;
}

const CAIRN_PROGRESS_ENERGY = {
  CONF_WORD: ENERGY_CONF_WORD,
  kcalFmt,
  energyRead,
  energyHeroHtml,
  energyCardHtml,
  energyBodyHtml,
  nutritionCheckinLoadingHtml,
  nutritionCheckinOkHtml,
  nutritionCheckinFailHtml,
  nutritionCheckinProposalHtml,
};

Object.assign(globalThis, {
  CairnProgressEnergy: CAIRN_PROGRESS_ENERGY,
  CONF_WORD: ENERGY_CONF_WORD,
  kcalFmt,
  energyRead,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressEnergy: CAIRN_PROGRESS_ENERGY,
    CONF_WORD: ENERGY_CONF_WORD,
    kcalFmt,
    energyRead,
  });
}
})();

// @ts-check
// Progress Energy Balance read helpers.

type EnergyExpenditure = {
  tdee?: unknown;
  confidence?: unknown;
  trend_lb_wk?: unknown;
  intake_avg_kcal?: unknown;
  points?: unknown;
  window_days?: unknown;
};

type EnergyRead = {
  lead: string;
  body: string;
  tone: "quiet" | "read";
  dir?: "down" | "up" | "flat" | null;
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
};

(() => {
const ENERGY_CONF_WORD: Record<string, string> = { high: "well-established", medium: "settling in", low: "still early" };

function kcalFmt(value: unknown): string {
  return Math.round(Number(value) || 0).toLocaleString();
}

function energyRead(exp: EnergyExpenditure | null | undefined): EnergyRead {
  if (!exp || exp.tdee == null || exp.confidence === "none") {
    return {
      lead: "Not enough logged yet to estimate.",
      body: "Keep logging meals and the odd weigh-in when you can — once there's a few weeks of data, I'll read your real energy balance here.",
      tone: "quiet",
    };
  }
  const trend = exp.trend_lb_wk == null ? null : Number(exp.trend_lb_wk);
  const dir = trend == null ? null : trend < -0.05 ? "down" : trend > 0.05 ? "up" : "flat";
  const rate = trend == null ? "" : `about ${Math.abs(Math.round(trend * 10) / 10)} lb/week`;
  const intake = exp.intake_avg_kcal != null ? `eating ~${kcalFmt(exp.intake_avg_kcal)} kcal/day` : "";
  let movement = "";
  if (dir === "down") movement = `trending down ${rate}`;
  else if (dir === "up") movement = `trending up ${rate}`;
  else if (dir === "flat") movement = "holding steady";
  const lead = [intake, movement].filter(Boolean).join(", ") || "Reading your energy balance.";
  return { lead: lead.charAt(0).toUpperCase() + lead.slice(1) + ".", body: "", tone: "read", dir };
}

function energyUsable(exp: EnergyExpenditure | null | undefined): boolean {
  return !!(exp && exp.tdee != null && exp.confidence !== "none");
}

function energyHeroHtml(exp: EnergyExpenditure | null | undefined): string {
  if (!energyUsable(exp)) return progressHero("Energy Balance", []);
  return progressHero("Energy Balance", [
    ["est. expenditure · kcal", exp?.tdee],
    exp?.intake_avg_kcal != null ? ["avg intake · kcal", exp.intake_avg_kcal] : null,
    exp?.trend_lb_wk != null ? ["trend · lb/wk", `${Number(exp.trend_lb_wk) > 0 ? "+" : ""}${Math.round(Number(exp.trend_lb_wk) * 10) / 10}`, { text: true }] : null,
  ]);
}

function energyCardHtml(exp: EnergyExpenditure | null | undefined): string {
  const read = energyRead(exp);
  const usable = energyUsable(exp);
  const points = Number(exp?.points);
  const windowDays = Number(exp?.window_days);
  const ctx = usable
    ? `<div class="eb-ctx lbl">${escHtml(ENERGY_CONF_WORD[String(exp?.confidence)] || "")} · ${Number.isFinite(points) ? points : 0} day${points === 1 ? "" : "s"} of data · ${Number.isFinite(windowDays) ? windowDays : 0}-day window</div>`
    : "";
  return `<section class="eb-card reveal" style="--i:1">
      <div class="eb-kicker lbl"><span class="eb-glyph" aria-hidden="true">◇</span> ${usable ? "How you're tracking" : "Not enough data yet"}</div>
      <p class="eb-lead">${escHtml(read.lead)}</p>
      ${read.body ? `<p class="eb-body">${escHtml(read.body)}</p>` : ""}
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
  return `<section class="eb-proposal settle-in">
      <div class="eb-kicker lbl"><span class="eb-glyph" aria-hidden="true">◇</span> A target worth considering</div>
      <div class="eb-target">
        <span class="numeral numeral-lg"${Number.isFinite(target) ? ` data-cu="${Math.round(target)}"` : ""}>${Number.isFinite(target) ? "0" : "—"}</span>
        <span class="eb-target-unit lbl">kcal / day${delta != null ? ` · ${delta > 0 ? "+" : ""}${kcalFmt(delta)} vs now` : ""}</span>
      </div>
      ${macroBits.length ? `<div class="eb-macros lbl">${escHtml(macroBits.join(" · "))}</div>` : ""}
      ${reason ? `<p class="eb-why">${escHtml(String(reason))}</p>` : ""}
      ${notes ? `<p class="eb-body">${escHtml(notes)}</p>` : ""}
      <div class="eb-foot">
        <button class="draftbtn" id="ckGoMeals" type="button">Regenerate meal plan around this</button>
        <button class="ghostbtn" id="ckDismiss" type="button">Got it</button>
      </div>
      <div class="eb-advisory lbl">advisory — nothing changes until you act on it</div>
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

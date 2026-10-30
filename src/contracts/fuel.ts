// The Fuel contract (v2 wave 2, "Food, the logging already done every day, made editable").
//
// Three server-owned reads Train › Intake paints and the coach reads:
//   - the PROTEIN ANCHOR — the day's protein target, which always comes first;
//   - the OBSERVED INTAKE BAND — where this athlete's weight turned, read only off the
//     days `classifyIntakeDay` calls complete plus the bodyweight response over the same
//     weeks (src/repo/intake-band.ts). An observation, never a target and never a
//     maintenance measurement; it bounds ENERGY only and never trims protein;
//   - FUEL IDEAS — up to three deterministic ideas built from what the athlete eats
//     again and again, each sized as ONE MEAL of the rest of today (never sized up),
//     inside that band, protein first (src/repo/fuel-ideas.ts).
//     An idea is never a plan and is never shown as eaten: "Start from this" fills the
//     composer, and nothing is logged until the person logs it.
//
// Served by `GET /api/nutrition/intake-band` (`get_intake_band`) and
// `GET /api/fuel/ideas` (`get_fuel_ideas`). Every sentence arrives finished — a renderer
// frames it and never works it out again. Numbers carry units; there is no score.
//
// Self-contained on purpose: src/client/** can read these types through
// `import("../contracts/fuel.js")`, and this module imports nothing.

/**
 * What today's energy room is measured under (src/repo/fuel-ideas.ts fuelEnergyBound):
 * the band's no-gain ceiling; during a cut, the band's loss edge (the most eaten in a
 * week the weight still came down) or a target the athlete set or accepted, whichever
 * is lower.
 */
export type ClientFuelEnergyBound = "observed_ceiling" | "loss_edge" | "accepted_target";

/**
 * How sure the band read is, as a word. Never a percentage. Spoken as "tentative"
 * (low), "observed" (moderate) and "strong" (high) — see `confidence_words`. A
 * tentative band sizes nothing (src/repo/fuel-ideas.ts fuelEnergyBound).
 */
export type ClientIntakeBandConfidence = "low" | "moderate" | "high";

/** Why there is (or is not) a band. `ok` is the only status that carries one. */
export type ClientIntakeBandStatus = "ok" | "too_few_days" | "no_weight_response";

/** Which way the weight moved over one week, from the canonical bodyweight series. */
export type ClientIntakeWeekResponse = "down" | "steady" | "up" | "unknown";

export interface ClientProteinAnchor {
  /** The day's protein target in grams (the accepted target first, else the formula). */
  protein_g: number;
  /** Where the number comes from (`effective_target` source, or "formula"). */
  source: string;
  /** Spoken sentence: the anchor, and that the energy range never trims it. */
  words: string;
}

export interface ClientIntakeBandWeek {
  week_start: string;
  week_end: string;
  /** Complete days in this week — the only days its average is built from. */
  complete_days: number;
  /** Mean kcal over the complete days only; null under the per-week minimum. */
  kcal_avg: number | null;
  /** Weight slope across the week (shifted by a short lag), lb per week; null when unreadable. */
  weight_change_lb_per_week: number | null;
  /**
   * This ONE week's own read against the scale's noise. On a real scale most single
   * weeks read "unknown"; the band is read from the pooled weeks (`pooled`), not from
   * these.
   */
  response: ClientIntakeWeekResponse;
}

/**
 * One side of the pooled read: the weeks at the lower (or upper) intakes, and which
 * way the smoothed weight trend moved across them together.
 */
export interface ClientIntakeBandGroup {
  /** Lowest and highest weekly complete-day average in the group, kcal/day. */
  kcal_min: number;
  kcal_max: number;
  weeks: number;
  /** The group's pooled trend, lb per week, off one continuous fitted weight line. */
  lb_per_week: number;
  response: ClientIntakeWeekResponse;
}

export interface ClientIntakeBand {
  /** Always "observation": this is what the record showed, never a target. */
  kind: "observation";
  status: ClientIntakeBandStatus;
  as_of: string;
  /** Protein comes first, and is null only when the profile cannot derive one. */
  protein_anchor: ClientProteinAnchor | null;
  window: {
    since: string;
    through: string;
    weeks: number;
    complete_days: number;
    /** Partial days are counted here only to say they were left out — never averaged. */
    partial_days: number;
    missing_days: number;
    weigh_in_days: number;
  };
  /**
   * The observed range where the weight turned, in kcal/day. `low_kcal` is the most
   * eaten in a week the weight still went down (or the lowest steady week when no week
   * went down); `high_kcal` is the least eaten in a week the weight went up (or, when no
   * week went up, the most eaten without a gain — `high_is_gain_edge:false`).
   * Null whenever `status !== "ok"`.
   */
  band: {
    low_kcal: number;
    high_kcal: number;
    low_is_loss_edge: boolean;
    high_is_gain_edge: boolean;
    /** Some weeks went down at an intake where others went up — the range is loose. */
    mixed: boolean;
  } | null;
  /**
   * The most eaten, on average, in a week the weight did NOT trend up (and below any
   * week that did). What ideas are sized within. Null with no band, when every
   * readable week went up, or when the pooled sides run backwards (weight falling
   * faster at the higher intakes). Never licenses a surplus: it is a no-gain intake by
   * construction, and it never stands in for measured maintenance.
   */
  energy_ceiling_kcal: number | null;
  confidence: ClientIntakeBandConfidence | null;
  confidence_words: string | null;
  /** Spoken summary of the band (or of why there is none). */
  words: string;
  weeks: ClientIntakeBandWeek[];
  /**
   * The pooled read the band comes from: every week with complete days and weigh-ins,
   * fitted as one continuous weight trend, split at the intake that best separates the
   * weeks (1 group when no split stands clear of the noise, 2 when one does — lower
   * intakes first). Null when there was too little to fit.
   */
  pooled: {
    groups: ClientIntakeBandGroup[];
    /** Day-to-day scale scatter around the fitted trend, lb. */
    scale_noise_lb: number;
  } | null;
  /** Machine register — third-person evidence prose for the provenance trail. */
  reason: string;
}

export interface ClientFuelIdea {
  /** Stable key for "Another idea" (`?exclude=`): the staple key plus the portion. Never holds a comma. */
  key: string;
  /** Card-sized, in the athlete's own food words, never naming alcohol. */
  title: string;
  /** Portion of the athlete's usual serving: 1, 0.75 or 0.5 — never above the usual. */
  portion: number;
  portion_words: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  /** True when it fits ONE MEAL's share of today's energy room; null when there is no room to claim. */
  fits_band: boolean | null;
  /** Spoken reason it was offered (what it brings — protein toward what is owed only when it is a protein food — then the idea as one meal of the day). */
  why: string;
  /** Text "Start from this" drops into the composer — never logged by itself. */
  prefill: string;
  /** How often it has been logged (distinct days) and when last. */
  times_logged: number;
  last_logged: string | null;
  /** "staple" = a whole meal that repeats; "components" = built from items logged often. */
  source: "staple" | "components";
}

export interface ClientFuelIdeas {
  /** Always "ideas": never a meal plan, never shown as eaten. */
  kind: "ideas";
  date: string;
  protein_anchor: ClientProteinAnchor | null;
  /**
   * What is logged so far — a PARTIAL sum until the day reads complete, never the day's
   * total. The sums count only meals that carry numbers; a meal still being estimated
   * (or never estimated) is left out explicitly and counted in `meals_unestimated`,
   * never added as a zero.
   */
  today_so_far: {
    kcal: number;
    protein_g: number;
    fiber_g: number;
    /** "in progress" for today and any partial day — never "low". */
    state: "in progress" | "complete" | "nothing logged";
    /** True unless the day reads complete with every meal estimated: the sums are a floor, not the whole day. */
    partial: boolean;
    /** Meals whose numbers are in the sums. */
    meals_counted: number;
    /** Meals left out of the sums because nothing has estimated them yet. */
    meals_unestimated: number;
    /** Spoken line: protein first, "so far", and any meal left out, in words. */
    words: string;
  };
  room: {
    /** Grams still to reach the protein anchor (0 once met); null with no anchor. */
    protein_g: number | null;
    /**
     * kcal left under `energy_bound`; null with no band, or with a band too loose to
     * size inside (mixed weeks or low confidence) — then no idea makes an energy claim.
     */
    energy_kcal: number | null;
    /** What `energy_kcal` is measured under; null exactly when `energy_kcal` is null. */
    energy_bound: ClientFuelEnergyBound | null;
    /** Meals the rest of the day plausibly still holds (the shared meal windows), at least 1. */
    meals_ahead: number;
    /** One meal's share of the room — what each idea is sized against. */
    meal_share: { protein_g: number | null; energy_kcal: number | null };
  };
  band_status: ClientIntakeBandStatus;
  ideas: ClientFuelIdea[];
  /** Spoken line about the ideas as a set (e.g. there were no staples to build from). */
  words: string;
}

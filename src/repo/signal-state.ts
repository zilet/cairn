// Unified daily signal state — the deterministic arbitration layer between raw
// evidence and planning. It resolves duplicate observations once, then groups the
// survivors into independent latent dimensions. Dimensions are never averaged
// together: sleep, training load, fueling, health constraints, and life pressure
// retain their own provenance/conflicts and only meet at one bounded INTERNAL
// arbitration index that emits plain-language posture/reasons (never a score).
import { pickDayVariant } from "./brain/day-read-rules.js";
import { joinList } from "./shared.js";

export type SignalDimension =
  | "recovery_capacity"
  | "training_load_tolerance"
  | "energy_fueling"
  | "health_constraints"
  | "life_capacity";
export type SignalDirection = "support" | "neutral" | "caution" | "constraint";
export type SignalConfidence = "none" | "low" | "medium" | "high";
export type SignalFreshness = "fresh" | "recent" | "stale";
export type SignalPosture = "train" | "modify" | "easy" | "rest" | "done";
export type PlanningTrainingDirective = "proceed" | "hold_aggression" | "modify" | "recover";

export interface SignalObservation {
  dimension: SignalDimension;
  field: string;
  date: string | null;
  source: string;
  direction: SignalDirection;
  // MACHINE-facing evidence prose, written about the athlete in the third person.
  // renderSignalState, the coach context and evidence provenance all read this. It
  // is NOT what the athlete reads — see `voice` and SIGNAL_VOICE below.
  summary: string;
  // WHICH athlete-facing phrasing this observation speaks, if it ever reaches a
  // surface the athlete reads. A key (plus an optional subject to substitute), not
  // the sentences themselves, so the state stays small enough to keep riding in
  // every prompt payload.
  voice?: SignalVoiceRef;
  confidence?: Exclude<SignalConfidence, "none">;
  coverage?: { samples: number; expected?: number | null; window_days?: number | null };
  value?: unknown;
  observation_id?: string | null;
  subject_key?: string | null;
  max_age_days?: number;
  safety_override?: boolean;
}

export interface ResolvedSignalEvidence extends SignalObservation {
  identity: string;
  age_days: number | null;
  freshness: SignalFreshness;
  selected_from: string[];
}

export interface SignalDimensionState {
  dimension: SignalDimension;
  status: "unknown" | "supportive" | "steady" | "watch" | "constrained";
  confidence: SignalConfidence;
  latest_date: string | null;
  coverage: {
    observed_fields: string[];
    active_fields: string[];
    stale_fields: string[];
    samples: number;
  };
  provenance: Array<{ field: string; source: string; date: string | null; freshness: SignalFreshness }>;
  evidence: ResolvedSignalEvidence[];
  conflicts: string[];
  reason: string;
  // The athlete-facing voice of the same evidence `reason` speaks for, on the same
  // terms as `action.voice`: a surface that shows one DIMENSION rather than the day's
  // posture (the conductor's fueling and schedule cards) has words of its own instead
  // of falling back to the machine-facing summary.
  voice: SignalVoiceRef;
}

export interface UnifiedSignalState {
  date: string;
  dimensions: Record<SignalDimension, SignalDimensionState>;
  action: {
    readiness: "ready" | "caution" | "protect" | "complete" | "unknown";
    posture: SignalPosture;
    reason: string;
    reasons: string[];
    // The athlete-facing voice of the SAME evidence `reason` speaks for — the one
    // thing a surface the athlete reads (the Brief's `why`) may use. Always set.
    voice: SignalVoiceRef;
    source_dimensions: SignalDimension[];
    confidence: SignalConfidence;
    directives: {
      training: PlanningTrainingDirective;
      // WHICH dimension's status produced `training`. `action.voice` speaks the
      // POSTURE, and on a ready/train day that posture is drawn from SUPPORT
      // evidence — so a `hold_aggression` day voiced through it tells the athlete
      // they slept fine and then asks them to hold, naming nothing they are holding
      // for. This names the dimension whose status produced the directive, so an
      // athlete-facing surface can lead with that dimension's own `voice` instead.
      // `null` only when `training` is "proceed".
      training_source: SignalDimension | null;
      fueling: "normal" | "settling" | "protect";
      schedule: "normal" | "compress" | "reschedule";
    };
  };
  provenance: string[];
  conflicts: string[];
}

// ---------- the athlete voice (a second vocabulary, never a rewrite of `summary`) ----------
// Every observation's `summary` is written for machines and coaches: it states the
// evidence, in the third person, ABOUT the athlete ("The athlete reports high soreness
// today."). renderSignalState, the coach context and the provenance trail all read
// those strings, so they stay exactly as they are.
//
// One path made them athlete-facing anyway: day-read's protect rule assigns
// `action.reason` to the Brief's `why` — the most prominent line on the screen — so an
// observer's note about the athlete was printed TO the athlete, in one fixed literal
// per signal, every morning a stable input fired the same branch (VISION.md Amendment
// 2: a read leads with a plain-language sentence, in the athlete's own register).
//
// So the athlete voice is a SEPARATE vocabulary sitting alongside `summary`. Each entry
// carries several phrasings of the same judgement — pickDayVariant rotates them by
// calendar day, exactly like the day-read rules (see brain/day-read-rules.ts) — plus the
// one idea those phrasings must carry, right beside the prose, so a new variant cannot
// drift away from the signal it speaks for.
//
// `{}` is replaced with the observation's `voice.subject` (an injury title, the sore
// joints, an event name), so a specific line can name the real thing WITHOUT splicing in
// another subsystem's sentence: the composed summaries (a mesocycle note, a hybrid
// headline, an underfueling action line, a context classifier's reason) stay
// machine-facing, and the athlete always hears an authored sentence in one register.
// `sample` is both the substitution when no subject is supplied and what the static
// registry renders for the constitution tests.
export interface SignalVoiceEntry {
  concept: RegExp;
  sample?: string;
  variants: readonly [string, ...string[]];
}

export const SIGNAL_VOICE = {
  // Recovery capacity — wearable and felt.
  //
  // ONE night and a MULTI-NIGHT trend are different evidence and get different words.
  // `recovery.sleep_min` is the latest dated night, not an average (getRecoverySummary
  // keeps `avg_sleep_min` separate, and day-read's own `low_sleep` flag reads THAT), so
  // a chronic sentence spoken off it asserted a pattern from a single reading — and the
  // Brief printed "Short nights have been stacking up" directly above its own signals
  // row saying sleep was about normal. The `*_night` pair speaks for the one night; the
  // chronic pair below speaks only for an observation built from the window.
  sleep_night_short: {
    // Singular `night` — a `\b`-bounded "night" cannot match "nights", so a phrasing
    // that drifted into claiming a run of them fails this key's own guard.
    concept: /\bnight\b/i,
    variants: [
      "Your most recent night came up short, so today is worth easing into.",
      "The last night on record was a short one — today is a good place to give some of that back.",
      "You've got one short night behind you, which is reason enough to keep today gentle.",
    ],
  },
  sleep_night_ok: {
    concept: /\bnight\b/i,
    variants: [
      "Your most recent night looks fine.",
      "The last night on record went well enough.",
      "Nothing about your latest night argues with the planned day.",
    ],
  },
  // Chronic: only ever spoken for the windowed `sleep_trend` observation.
  sleep_short: {
    concept: /\b(?:sleep|nights)\b/i,
    variants: [
      "Your sleep has been coming up short across the past couple of weeks, so today is better spent recovering than pushing.",
      "Short nights have been stacking up — today is a good day to give some of that back.",
      "You haven't been getting much sleep lately, and that is worth protecting today.",
    ],
  },
  // Readiness rides a ≤1-day window (see the observation below), so these speak about
  // the latest reading rather than "this morning": one day old is still yesterday.
  readiness_subdued: {
    concept: /\b(?:readiness|reading|watch)\b/i,
    variants: [
      "Your latest readiness reading came in subdued, so today is worth easing into.",
      "The last thing your watch sent read low, which is worth respecting rather than pushing through.",
      "Your most recent reading is on the quiet side, and a gentler day fits it.",
    ],
  },
  readiness_ok: {
    concept: /\b(?:readiness|reading|watch)\b/i,
    variants: [
      "Your latest readiness reading looks supportive.",
      "The last thing your watch sent reads fine.",
      "Your most recent reading sits in a good place.",
    ],
  },
  hrv_below: {
    concept: /\bvariability\b/i,
    variants: [
      "Your heart-rate variability is running below your own norm, which usually means fatigue is still there.",
      "Your variability has dipped under where it usually sits for you — worth easing rather than pushing.",
      "Heart-rate variability is under your own norm right now, so today deserves a lighter touch.",
    ],
  },
  hrv_steady: {
    concept: /\bvariability\b/i,
    variants: [
      "Your heart-rate variability is steady against your own norm.",
      "Variability is sitting where it usually does for you.",
      "There is nothing unusual in your heart-rate variability today.",
    ],
  },
  resting_hr_up: {
    concept: /\bheart rate\b/i,
    variants: [
      "Your resting heart rate is running above your own norm, which often means recovery is not finished.",
      "Resting heart rate is up on your usual, which is a fair reason to take today gently.",
      "Your resting heart rate is sitting higher than it normally does for you.",
    ],
  },
  resting_hr_steady: {
    concept: /\bheart rate\b/i,
    variants: [
      "Your resting heart rate is steady against your own norm.",
      "Resting heart rate is sitting where it usually does for you.",
      "There is nothing unusual in your resting heart rate today.",
    ],
  },
  felt_energy_low: {
    // Shared verbatim with the day-read felt_run_down_rest rule (RUN_DOWN_WHY), which
    // fires on the SAME check-in. Two sentences for one trigger is how the athlete
    // ends up reading two different voices depending on which rule wins the morning.
    concept: /\b(?:run-down|low)\b/i,
    variants: [
      "You're feeling run-down today — rest is the smart call.",
      "You said you're low today, and that's the signal that counts — rest.",
      "Feeling run-down is reason enough. Take today.",
    ],
  },
  felt_energy_ok: {
    concept: /\benergy\b/i,
    variants: [
      "You checked in with workable energy today.",
      "Your own read on your energy today is fine.",
      "Energy feels workable to you today, by your own account.",
    ],
  },
  sleep_feel_low: {
    concept: /\b(?:rested|recovered|slept)\b/i,
    variants: [
      "You don't feel recovered this morning, whatever the watch says — and that's the read that counts.",
      "You woke up feeling poorly rested, which outranks any device reading.",
      "By your own read you're not rested today, so today is for recovering.",
    ],
  },
  sleep_feel_ok: {
    concept: /\b(?:rested|slept)\b/i,
    variants: [
      "You woke up feeling reasonably rested.",
      "By your own read, you slept fine.",
      "You're feeling rested enough today.",
    ],
  },
  // Training load and tolerance.
  soreness_high: {
    concept: /\bsore(?:ness)?\b/i,
    variants: [
      "You're carrying a lot of soreness today, so let it settle before loading again.",
      "You checked in sore today, which is worth easing around.",
      "Soreness is high for you today — give it room to come down.",
    ],
  },
  soreness_ok: {
    concept: /\bsore(?:ness)?\b/i,
    variants: [
      "You're not carrying much soreness today.",
      "Soreness isn't an issue for you today.",
      "Nothing sore is holding you back today.",
    ],
  },
  session_soreness: {
    concept: /\bsore(?:ness)?\b/i,
    variants: [
      "Your recent session feedback shows soreness building.",
      "You've been logging more soreness after sessions lately.",
      "Soreness has been showing up in your recent session notes.",
    ],
  },
  low_performance: {
    concept: /\b(?:session|sessions|work|loading)\b/i,
    variants: [
      "Your recent sessions have felt below your usual, so easing the loading makes sense.",
      "The last few sessions haven't felt like your normal, which is worth easing for.",
      "Recent work has felt heavier than it should, so back the loading off a little.",
    ],
  },
  generic_activity_load: {
    concept: /\b(?:already|moved|movement)\b/i,
    sample: "some real movement",
    variants: [
      "You've already got {} on the board today.",
      "Your watch already shows {} today, so you've moved.",
      "There's {} recorded today already, which counts even without a session attached.",
    ],
  },
  deload_due: {
    concept: /\b(?:load|training|work)\b/i,
    variants: [
      "The training you've stacked up says a recovery stretch is due.",
      "You've accumulated enough work that a lighter stretch is the next right move.",
      "The load you've built says it's time to let it absorb.",
    ],
  },
  acute_load_high: {
    concept: /\b(?:load|training)\b/i,
    variants: [
      "You're training above the base you've built lately.",
      "Your recent training load is running ahead of your usual, so let it catch up.",
      "You've picked the load up quickly, and it's worth giving it a chance to settle.",
    ],
  },
  acute_load_ok: {
    concept: /\bload\b/i,
    variants: [
      "Your training load is sitting inside what you've built for.",
      "The load you're carrying is within your usual range.",
      "Nothing about your recent load is out of the ordinary.",
    ],
  },
  hybrid_interference: {
    concept: /\b(?:endurance|running)\b/i,
    variants: [
      "Your recent endurance work changes how today's strength session should land.",
      "The running in your legs shapes what the next lifting session can be.",
      "Recent endurance work is still in your legs, so keep the strength work sensible today.",
    ],
  },
  // Energy and fueling.
  hybrid_fuel: {
    concept: /\b(?:fuel|fueling|eat)\b/i,
    variants: [
      "Your recent endurance work raises what you need to eat around training.",
      "The running you've been doing asks for more fuel around the work.",
      "Endurance work is adding up, so fueling matters more than usual right now.",
    ],
  },
  expenditure: {
    concept: /\b(?:energy|intake)\b/i,
    variants: [
      "Your energy balance is still settling into a clear picture.",
      "There isn't a settled read on your energy balance yet.",
      "Your intake and your weight trend haven't converged on a clear answer yet.",
    ],
  },
  fuel_protect: {
    concept: /\b(?:fuel|enough)\b/i,
    variants: [
      "Your fuel needs looking after before anything else today.",
      "Fuel is the thing to protect right now, ahead of adding work.",
      "Getting enough in matters more than training hard today.",
    ],
  },
  fuel_watch: {
    concept: /\b(?:fuel|fueling|eating)\b/i,
    variants: [
      "Your fueling has been running light lately.",
      "Fuel has been on the thin side recently.",
      "You've been eating a little under what the training asks for.",
    ],
  },
  fuel_strain_persistent: {
    concept: /\b(?:strain|fuel|fueling)\b/i,
    variants: [
      "Fuel, performance and recovery all still read strained, so the next training dose should come down.",
      "The strain hasn't lifted since the fuel change settled, which means asking less of today, not more.",
      "Your fueling correction has settled and the strain is still there, so ease the next dose.",
    ],
  },
  fuel_strain_hold: {
    concept: /\b(?:fuel|fueling|progression|loading)\b/i,
    variants: [
      "Fuel and performance agree enough to hold off on pushing progression for now.",
      "Hold the progression where it is while your fueling catches up.",
      "Keep loading steady rather than climbing until the fueling settles.",
    ],
  },
  // Health constraints.
  active_injury: {
    concept: /\b(?:pain-free|around|comfortable)\b/i,
    sample: "injury",
    variants: [
      "Keep whatever you do today pain-free around your {}.",
      "Work around your {} today and stop short of anything that aggravates it.",
      "Your {} still needs working around, so keep every movement comfortable today.",
    ],
  },
  joint_pain: {
    concept: /\b(?:pain-free|around|comfortable)\b/i,
    sample: "sore joints",
    // The subject is `joinList(joint_areas)`, so its NUMBER is unknown here — one area
    // or several. Every phrasing must therefore agree with neither: no verb inflected on
    // the subject, no pronoun referring back to it. "Your {} need working around" read
    // "Your left knee need working around" on the common single-area day.
    variants: [
      "Keep today pain-free around your {} and swap out any movement that provokes pain.",
      "Worth working around your {} today, so choose movements that stay comfortable.",
      "Stay off anything that bothers your {} today and pick a pain-free substitute.",
    ],
  },
  illness: {
    // An illness arrives as a titled event ("Head cold"), i.e. a LABEL, not a noun
    // phrase that takes an article — so every phrasing has to read correctly with the
    // title dropped in bare, and with the generic sample too.
    concept: /\b(?:recover|recovering|recovery|gentle)\b/i,
    sample: "something",
    variants: [
      "{} is reason enough to keep today gentle.",
      "With {} in the picture, today is for recovering rather than training.",
      "Recovery comes first while {} is going on.",
    ],
  },
  health_constraint: {
    concept: /\b(?:ease|easing|around|health)\b/i,
    variants: [
      "There's something health-related worth easing around right now.",
      "Something needs working around today, so keep the load conservative.",
      "There's something to ease around today rather than load through.",
    ],
  },
  fueling_disrupted: {
    concept: /\b(?:fueling|eating)\b/i,
    variants: [
      "Travel or illness is likely to scramble your normal fueling right now.",
      "Your normal eating rhythm is disrupted at the moment.",
      "Fueling is harder than usual to keep normal while this is going on.",
    ],
  },
  // Life capacity.
  schedule_pressure: {
    concept: /\b(?:recovery|sleep|rest)\b/i,
    variants: [
      "What's on right now is likely to eat into your recovery.",
      "A busy or stressful stretch tends to cost you sleep, so keep today's ask modest.",
      "There's enough going on right now to squeeze your recovery.",
    ],
  },
  commitment_pressure: {
    concept: /\b(?:schedule|room|time)\b/i,
    sample: "a commitment",
    variants: [
      "Today's schedule has {} in it, which leaves less room than usual.",
      "You've got {} today, so time is the tighter constraint.",
      "With {} on today, the schedule is what's squeezed.",
    ],
  },
  // Already covered.
  completed_today: {
    concept: /\b(?:done|already|in)\b/i,
    variants: [
      "Today's planned work is already done.",
      "You've already covered today's work.",
      "What was planned for today is already in.",
    ],
  },
  // The floors, for evidence that carries no voice of its own (a caller assembling
  // raw observations) and for a posture reached with no evidence at all.
  unvoiced_protect: {
    concept: /\b(?:protect|recovery)\b/i,
    variants: [
      "Today reads like a day to protect your recovery rather than push.",
      "What's showing up today asks for recovery more than effort.",
      "The kinder read on today is to protect your recovery.",
    ],
  },
  unvoiced_open: {
    concept: /\b(?:feel|signal|signals)\b/i,
    variants: [
      "There isn't enough fresh signal to call today either way, so go by how you feel.",
      "Nothing fresh has come in to call today either way — trust how you feel.",
      "Today's signals are thin, so let how you feel decide.",
    ],
  },
  unvoiced_clear: {
    concept: /\bsignals?\b/i,
    variants: [
      "Nothing in today's signals argues against the plan.",
      "There's room in today's signals for the day you had planned.",
      "Today's signals leave the planned day alone.",
    ],
  },
} as const satisfies Record<string, SignalVoiceEntry>;

export type SignalVoiceKey = keyof typeof SIGNAL_VOICE;
export interface SignalVoiceRef {
  key: SignalVoiceKey;
  subject?: string;
}

// The athlete-facing phrasings for one voice, subject substituted. Never empty: an
// unknown or missing key degrades to the protect floor rather than to silence (or,
// worse, to a machine-facing `summary`).
export function signalVoice(ref?: SignalVoiceRef | null): readonly [string, ...string[]] {
  const entry: SignalVoiceEntry = (ref && SIGNAL_VOICE[ref.key]) || SIGNAL_VOICE.unvoiced_protect;
  const subject = String(ref?.subject ?? "").trim() || entry.sample || "";
  return entry.variants.map((variant) => variant.replace(/\{\}/g, subject)) as [string, ...string[]];
}

// The whole athlete vocabulary this layer can speak, rendered (templated entries use
// their sample subject). Exported so day-read can register it in DAY_READ_WHY_VARIANTS
// / DAY_READ_REQUIRED_CONCEPT — the constitution guards live over there, beside the
// rest of the Brief's words, and this path used to escape them entirely.
export const SIGNAL_VOICE_REGISTRY: Readonly<Record<string, { concept: RegExp; variants: readonly string[] }>> =
  Object.fromEntries(
    Object.keys(SIGNAL_VOICE).map((key) => [
      key,
      {
        concept: SIGNAL_VOICE[key as SignalVoiceKey].concept,
        variants: signalVoice({ key: key as SignalVoiceKey }),
      },
    ])
  );

// The rotation keys the athlete-facing surfaces share. TWO surfaces speak this
// layer's words — the Brief's `why` (day-read) and the conductor's lead/caveat
// (coaching-focus) — and they are reached from different tabs on the same day. Same
// key + same date + same voice ⇒ the same sentence, so one signal reads as ONE
// observation rather than two loosely-related notes about the athlete's morning.
// The protect key is deliberately the day-read rule code that owns that read, so the
// registered vocabulary and the rotation stay keyed alike.
export const SIGNAL_VOICE_KEYS = {
  protect: "acute_signal_protection",
  injury: "active_injury",
  // Their own keys: these ride as PARALLEL cards that can co-render with a lead
  // drawn from the same evidence, and a coincidental collision should read as a
  // second phrasing, never as the same sentence printed twice on one screen.
  fueling: "signal_state:fueling",
  schedule: "signal_state:schedule",
} as const;

// The one sentence a voice says on a given day. Every athlete-facing consumer of
// this layer goes through here, so the rotation contract lives in one place.
export function spokenSignalVoice(
  ref: SignalVoiceRef | null | undefined,
  date: string,
  key: string = SIGNAL_VOICE_KEYS.protect
): string {
  return pickDayVariant(signalVoice(ref), date, key);
}

// `directives.schedule === "compress"` has TWO unrelated causes, and only one of them
// is about the clock: a real dated commitment (voice `commitment_pressure`), or
// `context.expect_worse_sleep` — a late night or a stressful stretch, which squeezes
// RECOVERY and nothing else (voice `schedule_pressure`). Both observations write the
// same `field`, so the directive alone cannot tell them apart, and reading it alone
// told an athlete with only "Brutal week at work" on record that a commitment was
// shortening their training window.
//
// Two surfaces need the distinction — the Brief's caveat and its 60→40 clamp
// (day-read) and the conductor's compress card (coaching-focus) — and each had grown
// its own copy. It lives here because it is a question about the signal state, and
// because two copies of a discriminator drift into two different answers.
//
// The arbitrated dimension voice IS the answer, and deliberately the only one consulted.
// One of the two former copies also scanned raw `evidence` when that key came back empty
// — but dimensionState always assigns a voice, so the branch was unreachable from the
// builder, and a second path that can contradict arbitration is a competing arbitration
// rule rather than a null-safety floor. An absent key means no life-capacity evidence
// won, which is not a commitment.
export function lifeCapacityIsCommitment(state: UnifiedSignalState | null | undefined): boolean {
  return String(state?.dimensions?.life_capacity?.voice?.key ?? "").trim() === "commitment_pressure";
}

const DIMENSIONS: SignalDimension[] = [
  "recovery_capacity",
  "training_load_tolerance",
  "energy_fueling",
  "health_constraints",
  "life_capacity",
];
const DIRECTION_RANK: Record<SignalDirection, number> = { neutral: 0, support: 1, caution: 2, constraint: 3 };

// A brake summary joined onto a support summary ("… supports the day. But …") sits
// mid-sentence, so its sentence-initial capital comes down — but only when that capital
// is one. An acronym ("HRV is below the athlete's recent norm.") or a device name
// ("Apple daily activity shows …") owns its case, and lowercasing it unconditionally
// put "hRV" and "apple" into the coach context and the provenance trail. Same posture as
// the injury-vs-illness titles further down: decide from what the string IS, never blind.
const PROPER_OPENER = /^(?:Apple|Garmin|Oura|Whoop|Cairn)\b/;
function joinedCase(summary: string): string {
  if (/^[A-Z]{2,}/.test(summary) || PROPER_OPENER.test(summary)) return summary;
  return `${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
}

function ageDays(reference: string, date: string | null): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const age = Math.floor((Date.parse(`${reference}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function sourceRank(observation: SignalObservation): number {
  const source = observation.source.toLowerCase();
  if (observation.safety_override && /user|checkin|manual|session/.test(source)) return 1_000;
  if (/manual_session|cairn_session/.test(source)) return 950;
  if (/user|checkin/.test(source)) return 925;
  if (/garmin/.test(source)) return 900;
  if (/oura|whoop/.test(source)) return 850;
  if (/apple/.test(source)) return 800;
  if (/manual/.test(source)) return 750;
  if (/profile|formula/.test(source)) return 600;
  return 500;
}

function canonicalIdentity(observation: SignalObservation): string {
  if (observation.observation_id) return `${observation.dimension}:${observation.observation_id}`;
  return [observation.dimension, observation.field, observation.subject_key ?? "", observation.date ?? "undated"].join(
    ":"
  );
}

export function resolveSignalObservations(date: string, observations: SignalObservation[]): ResolvedSignalEvidence[] {
  const groups = new Map<string, SignalObservation[]>();
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (!observation || !DIMENSIONS.includes(observation.dimension) || !observation.field || !observation.source)
      continue;
    const identity = canonicalIdentity(observation);
    groups.set(identity, [...(groups.get(identity) ?? []), observation]);
  }
  const resolved: ResolvedSignalEvidence[] = [];
  for (const [identity, candidates] of groups) {
    const selected = [...candidates].sort((a, b) => {
      const safety = Number(!!b.safety_override) - Number(!!a.safety_override);
      if (safety) return safety;
      const source = sourceRank(b) - sourceRank(a);
      if (source) return source;
      return DIRECTION_RANK[b.direction] - DIRECTION_RANK[a.direction];
    })[0];
    const age = ageDays(date, selected.date);
    const maxAge = Math.max(0, selected.max_age_days ?? 7);
    const freshness: SignalFreshness =
      age == null || age > maxAge ? "stale" : age <= Math.min(1, maxAge) ? "fresh" : "recent";
    resolved.push({
      ...selected,
      identity,
      age_days: age,
      freshness,
      selected_from: [...new Set(candidates.map((candidate) => candidate.source))],
    });
  }
  return resolved.sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) ||
      String(b.date ?? "").localeCompare(String(a.date ?? "")) ||
      a.field.localeCompare(b.field)
  );
}

function dimensionState(dimension: SignalDimension, evidence: ResolvedSignalEvidence[]): SignalDimensionState {
  const all = evidence.filter((item) => item.dimension === dimension);
  const active = all.filter((item) => item.freshness !== "stale");
  const strongest = [...active].sort((a, b) => {
    const safety = Number(!!b.safety_override) - Number(!!a.safety_override);
    return safety || DIRECTION_RANK[b.direction] - DIRECTION_RANK[a.direction];
  })[0];
  const status: SignalDimensionState["status"] = !strongest
    ? "unknown"
    : strongest.direction === "constraint"
      ? "constrained"
      : strongest.direction === "caution"
        ? "watch"
        : strongest.direction === "support"
          ? "supportive"
          : "steady";
  const directions = new Set(active.map((item) => item.direction));
  const conflicts: string[] = [];
  if (directions.has("support") && (directions.has("caution") || directions.has("constraint"))) {
    const support = active.find((item) => item.direction === "support");
    const brake =
      active.find((item) => item.direction === "constraint") ?? active.find((item) => item.direction === "caution");
    if (support && brake) conflicts.push(`${support.summary} But ${joinedCase(brake.summary)}`);
  }
  const activeFields = [...new Set(active.map((item) => item.field))];
  const staleFields = [...new Set(all.filter((item) => item.freshness === "stale").map((item) => item.field))];
  let confidence: SignalConfidence = "none";
  if (all.length)
    confidence =
      active.length === 0
        ? "low"
        : activeFields.length >= 3 && conflicts.length === 0
          ? "high"
          : activeFields.length >= 2
            ? "medium"
            : "low";
  const latestDate =
    all
      .map((item) => item.date)
      .filter((value): value is string => !!value)
      .sort()
      .at(-1) ?? null;
  return {
    dimension,
    status,
    confidence,
    latest_date: latestDate,
    coverage: {
      observed_fields: [...new Set(all.map((item) => item.field))],
      active_fields: activeFields,
      stale_fields: staleFields,
      samples: all.reduce((sum, item) => sum + Math.max(1, Number(item.coverage?.samples) || 1), 0),
    },
    provenance: all.map((item) => ({
      field: item.field,
      source: item.source,
      date: item.date,
      freshness: item.freshness,
    })),
    evidence: all,
    conflicts,
    reason:
      strongest?.summary ??
      (all.length ? "Only stale evidence is available, so this stays open." : "No current evidence in this dimension."),
    voice: strongest?.voice ?? {
      key: status === "constrained" || status === "watch" ? "unvoiced_protect" : "unvoiced_clear",
    },
  };
}

const DIMENSION_WEIGHT: Record<SignalDimension, number> = {
  recovery_capacity: 3,
  training_load_tolerance: 3,
  energy_fueling: 1,
  health_constraints: 4,
  life_capacity: 2,
};
const STATUS_VALUE: Record<SignalDimensionState["status"], number> = {
  unknown: 0,
  supportive: 2,
  steady: 0,
  watch: -1,
  constrained: -3,
};
const CONFIDENCE_WEIGHT: Record<SignalConfidence, number> = { none: 0, low: 0.5, medium: 0.75, high: 1 };

// Private structured metric: fixed dimension/confidence weights and a bounded
// result. Hard safety gates run first; this breaks only the remaining mixed-signal
// ties. The number is deliberately never returned or rendered.
function privateArbitration(dimensions: Record<SignalDimension, SignalDimensionState>) {
  const components = DIMENSIONS.map((dimension) => ({
    dimension,
    contribution:
      STATUS_VALUE[dimensions[dimension].status] *
      DIMENSION_WEIGHT[dimension] *
      CONFIDENCE_WEIGHT[dimensions[dimension].confidence],
  }));
  return {
    components,
    value: Math.max(
      -12,
      Math.min(
        12,
        components.reduce((sum, component) => sum + component.contribution, 0)
      )
    ),
  };
}

function planningDirectives(dimensions: Record<SignalDimension, SignalDimensionState>) {
  const recovery = dimensions.recovery_capacity.status;
  const trainingLoad = dimensions.training_load_tolerance.status;
  const health = dimensions.health_constraints.status;
  const energy = dimensions.energy_fueling.status;
  const life = dimensions.life_capacity.status;
  // ONE ordered precedence chain, evaluated once: each rung carries both the verdict
  // and the dimension whose status produced it, so the directive and its cause can
  // never drift apart the way two parallel condition chains would. The rungs are the
  // original chain flattened — every `||` inside a tier became its own rung in the
  // order it was written, which cannot change the verdict because a tier's alternatives
  // all resolve to the same one.
  const rungs: ReadonlyArray<{
    fires: boolean;
    training: Exclude<PlanningTrainingDirective, "proceed">;
    source: SignalDimension;
  }> = [
    { fires: recovery === "constrained", training: "recover", source: "recovery_capacity" },
    { fires: trainingLoad === "constrained", training: "recover", source: "training_load_tolerance" },
    { fires: health === "constrained", training: "modify", source: "health_constraints" },
    { fires: recovery === "watch", training: "hold_aggression", source: "recovery_capacity" },
    { fires: trainingLoad === "watch", training: "hold_aggression", source: "training_load_tolerance" },
    { fires: health === "watch", training: "hold_aggression", source: "health_constraints" },
    { fires: energy === "constrained", training: "hold_aggression", source: "energy_fueling" },
  ];
  const decided = rungs.find((rung) => rung.fires) ?? null;
  return {
    training: decided?.training ?? ("proceed" as const),
    training_source: decided?.source ?? null,
    fueling:
      energy === "constrained"
        ? ("protect" as const)
        : energy === "watch"
          ? ("settling" as const)
          : ("normal" as const),
    schedule:
      life === "constrained" ? ("reschedule" as const) : life === "watch" ? ("compress" as const) : ("normal" as const),
  };
}

function actionState(dimensions: Record<SignalDimension, SignalDimensionState>) {
  const active = Object.values(dimensions).flatMap((dimension) =>
    dimension.evidence.filter((item) => item.freshness !== "stale")
  );
  const done = active.find((item) => item.field === "completed_today" && item.direction === "support");
  if (done) return { readiness: "complete" as const, posture: "done" as const, evidence: [done] };
  const feltProtect = active.find(
    (item) =>
      item.safety_override && item.direction === "constraint" && /fatigue|energy|sleep_feel|illness/.test(item.field)
  );
  if (feltProtect) return { readiness: "protect" as const, posture: "rest" as const, evidence: [feltProtect] };
  // Recovery and accumulated-load protection own the overall posture before a
  // simultaneous health work-around. The health dimension remains intact, so an
  // injury still caveats any movement; it just cannot reopen hard training on a
  // day the canonical recovery/load state has already made easy.
  const recoveryConstraints = active.filter(
    (item) =>
      (item.dimension === "recovery_capacity" || item.dimension === "training_load_tolerance") &&
      item.direction === "constraint"
  );
  if (recoveryConstraints.length)
    return { readiness: "protect" as const, posture: "easy" as const, evidence: recoveryConstraints };
  const healthConstraints = active.filter(
    (item) => item.dimension === "health_constraints" && item.direction === "constraint"
  );
  if (healthConstraints.length)
    return { readiness: "caution" as const, posture: "modify" as const, evidence: healthConstraints };
  const fuelPrescription = active.find(
    (item) =>
      item.dimension === "energy_fueling" && item.field === "underfueling_control" && item.direction === "constraint"
  );
  if (fuelPrescription)
    return { readiness: "caution" as const, posture: "modify" as const, evidence: [fuelPrescription] };
  const arbitration = privateArbitration(dimensions);
  const brakes = active.filter((item) => item.direction === "constraint" || item.direction === "caution");
  if (arbitration.value <= -8) return { readiness: "protect" as const, posture: "rest" as const, evidence: brakes };
  if (arbitration.value <= -4) return { readiness: "protect" as const, posture: "easy" as const, evidence: brakes };
  if (arbitration.value <= -2) return { readiness: "caution" as const, posture: "modify" as const, evidence: brakes };
  if (!active.length) return { readiness: "unknown" as const, posture: "train" as const, evidence: [] };
  return {
    readiness: "ready" as const,
    posture: "train" as const,
    evidence: active.filter((item) => item.direction === "support"),
  };
}

export function buildUnifiedSignalState(date: string, observations: SignalObservation[]): UnifiedSignalState {
  const resolved = resolveSignalObservations(date, observations);
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, dimensionState(dimension, resolved)])
  ) as Record<SignalDimension, SignalDimensionState>;
  const action = actionState(dimensions);
  const directives = planningDirectives(dimensions);
  const reasons = action.evidence
    .map((item) => item.summary)
    .filter(Boolean)
    .slice(0, 3);
  const reason =
    reasons[0] ??
    (action.readiness === "unknown"
      ? "There is not enough fresh signal to call recovery either way; use how you feel and keep the default flexible."
      : "The current signals leave room for the planned day.");
  // The athlete-facing voice of the SAME evidence `reason` speaks for. When that
  // evidence carries no voice of its own — a caller assembling raw observations, or a
  // posture reached with no active evidence at all — it falls back to a floor written
  // for the athlete, never to the machine-facing summary above.
  const voice: SignalVoiceRef = action.evidence[0]?.voice ?? {
    key:
      action.readiness === "unknown"
        ? "unvoiced_open"
        : action.posture === "rest" || action.posture === "easy" || action.posture === "modify"
          ? "unvoiced_protect"
          : "unvoiced_clear",
  };
  const sourceDimensions = [...new Set(action.evidence.map((item) => item.dimension))];
  const actionConfidence: SignalConfidence =
    sourceDimensions.length === 0
      ? "none"
      : sourceDimensions.some((dimension) => dimensions[dimension].confidence === "high")
        ? "high"
        : sourceDimensions.some((dimension) => dimensions[dimension].confidence === "medium")
          ? "medium"
          : "low";
  return {
    date,
    dimensions,
    action: {
      readiness: action.readiness,
      posture: action.posture,
      reason,
      reasons,
      voice,
      source_dimensions: sourceDimensions,
      confidence: actionConfidence,
      directives,
    },
    provenance: [...new Set(resolved.map((item) => `${item.field}:${item.source}:${item.date ?? "undated"}`))],
    conflicts: DIMENSIONS.flatMap((dimension) => dimensions[dimension].conflicts),
  };
}

function observation(
  dimension: SignalDimension,
  field: string,
  date: string | null,
  source: string,
  direction: SignalDirection,
  summary: string,
  extra: Partial<SignalObservation> = {}
): SignalObservation {
  return { dimension, field, date, source, direction, summary, ...extra };
}

// Adapter from the existing deterministic domain reads. It does no DB access:
// getCoachContext and dayRead pass the exact snapshot they already computed.
export function planningSignalState(input: {
  date: string;
  recovery?: any;
  checkin?: any;
  trainingSignals?: any;
  programState?: any;
  expenditure?: any;
  underfueling?: any;
  context?: any;
  contextEvents?: any[];
  completedToday?: boolean;
}): UnifiedSignalState {
  const date = input.date;
  const observations: SignalObservation[] = [];
  const quality = input.recovery?.quality ?? input.recovery?.recovery?.quality ?? {};
  const addRecovery = (
    field: string,
    qualityField: string,
    direction: SignalDirection,
    summary: string,
    voice: SignalVoiceKey,
    maxAgeDays = 3
  ) => {
    const q = quality[qualityField] ?? {};
    observations.push(
      observation("recovery_capacity", field, q.latest_date ?? null, q.source ?? "recovery", direction, summary, {
        voice: { key: voice },
        coverage: {
          samples: Number(q.sample_count) || 1,
          expected: q.expected_days ?? null,
          window_days: q.window_days ?? null,
        },
        max_age_days: maxAgeDays,
      })
    );
  };
  const current = input.recovery?.recovery ?? {};
  // ONE night. `recovery.sleep_min` is the latest dated reading (getRecoverySummary's
  // `current(...)`), never an average — so the direction bands stay as they were (under
  // 5h owns the day, under 6h is a caution) while the words claim only that night.
  if (current.sleep_min != null)
    addRecovery(
      "sleep",
      "sleep_min",
      Number(current.sleep_min) < 300 ? "constraint" : Number(current.sleep_min) < 360 ? "caution" : "support",
      Number(current.sleep_min) < 360
        ? "The most recent recorded night came in short."
        : "The most recent recorded night supports the planned day.",
      Number(current.sleep_min) < 360 ? "sleep_night_short" : "sleep_night_ok"
    );
  // The multi-night trend, which is the only evidence a chronic sentence may be spoken
  // for. Same <6h line day-read's own `low_sleep` flag uses, off the same `avg_sleep_min`,
  // so the Brief's headline and its signals row cannot contradict each other. Caution
  // only: a short average informs the day, it never owns it — the night above does that.
  const avgSleepMin = Number(current.avg_sleep_min);
  if (Number.isFinite(avgSleepMin) && avgSleepMin > 0 && avgSleepMin < 360)
    addRecovery(
      "sleep_trend",
      "sleep_min",
      "caution",
      "Sleep across the recent window is averaging under six hours.",
      "sleep_short"
    );
  // Readiness rides a ONE-day window, matching day-read's own gate ("a stale current
  // value cannot" force a recommendation, src/repo/day-read.ts). At the former 3 days a
  // reading the deterministic Brief refused to act on still reached the athlete through
  // this layer: the protect rule leads off `action.posture` alone, so a three-day-old
  // subdued reading produced an easy read voiced as though it had come in that morning.
  // Older readings are not deleted — they resolve `stale`, which is exactly the "context,
  // never a gate" standing the prompt already tells the agent to give them.
  if (current.training_readiness != null)
    addRecovery(
      "training_readiness",
      "training_readiness",
      Number(current.training_readiness) < 35
        ? "constraint"
        : Number(current.training_readiness) < 50
          ? "caution"
          : "support",
      Number(current.training_readiness) < 50
        ? "The wearable readiness signal is subdued."
        : "The wearable readiness signal is supportive.",
      Number(current.training_readiness) < 50 ? "readiness_subdued" : "readiness_ok",
      1
    );
  if (input.recovery?.delta?.hrv != null)
    addRecovery(
      "hrv",
      "hrv_ms",
      Number(input.recovery.delta.hrv) < -5 ? "caution" : "support",
      Number(input.recovery.delta.hrv) < -5
        ? "HRV is below the athlete's recent norm."
        : "HRV is steady against the athlete's norm.",
      Number(input.recovery.delta.hrv) < -5 ? "hrv_below" : "hrv_steady"
    );
  if (input.recovery?.delta?.rhr != null)
    addRecovery(
      "resting_hr",
      "resting_hr",
      Number(input.recovery.delta.rhr) > 3 ? "caution" : "support",
      Number(input.recovery.delta.rhr) > 3
        ? "Resting heart rate is above the athlete's norm."
        : "Resting heart rate is steady against the athlete's norm.",
      Number(input.recovery.delta.rhr) > 3 ? "resting_hr_up" : "resting_hr_steady"
    );

  // Apple daily activity is not a sport-specific workout record, but meaningful
  // exercise minutes/distance still say the athlete has carried recent load. Keep
  // it deliberately generic and caution-only: it may hold aggression, but cannot
  // invent a run/ride, satisfy compliance, or force a recovery day. When the
  // program state already has an endurance activity on the same date, that richer
  // record owns the observation so a mirrored Apple total is not counted twice.
  const activityCandidates = [
    { field: "exercise_min", value: current.exercise_min, quality: quality.exercise_min },
    { field: "distance_km", value: current.distance_km, quality: quality.distance_km },
  ]
    .filter(
      (candidate) =>
        candidate.value != null &&
        candidate.quality?.latest_date &&
        /apple/i.test(String(candidate.quality?.source ?? ""))
    )
    .sort((a, b) => String(b.quality.latest_date).localeCompare(String(a.quality.latest_date)));
  const genericActivity = activityCandidates[0];
  const activityDate = genericActivity?.quality?.latest_date ?? null;
  const mirroredEnduranceDates = new Set(
    [input.programState?.hybrid?.recent_endurance, ...(input.programState?.hybrid?.recent_endurance_all ?? [])]
      .map((item) => item?.date)
      .filter(Boolean)
  );
  const exerciseMinutes =
    quality.exercise_min?.latest_date === activityDate && /apple/i.test(String(quality.exercise_min?.source ?? ""))
      ? Number(current.exercise_min)
      : Number.NaN;
  const distanceKm =
    quality.distance_km?.latest_date === activityDate && /apple/i.test(String(quality.distance_km?.source ?? ""))
      ? Number(current.distance_km)
      : Number.NaN;
  const meaningfulGenericActivity =
    (Number.isFinite(exerciseMinutes) && exerciseMinutes >= 20) || (Number.isFinite(distanceKm) && distanceKm >= 2);
  if (genericActivity && meaningfulGenericActivity && !mirroredEnduranceDates.has(activityDate)) {
    const details = [
      Number.isFinite(exerciseMinutes) && exerciseMinutes > 0
        ? `${Math.round(exerciseMinutes)} exercise minutes`
        : null,
      Number.isFinite(distanceKm) && distanceKm > 0 ? `${Math.round(distanceKm * 10) / 10} km of movement` : null,
    ].filter(Boolean);
    observations.push(
      observation(
        "training_load_tolerance",
        "generic_activity_load",
        activityDate,
        String(genericActivity.quality.source),
        "caution",
        `Apple daily activity shows ${details.join(" and ")}; treat it as generic recent load without assuming a sport.`,
        {
          // The athlete hears the movement itself, never the sport we deliberately
          // refuse to infer from it.
          voice: { key: "generic_activity_load", subject: details.join(" and ") },
          coverage: {
            samples: Number(genericActivity.quality.sample_count) || 1,
            expected: genericActivity.quality.expected_days ?? null,
            window_days: genericActivity.quality.window_days ?? null,
          },
          max_age_days: genericActivity.quality.freshness === "fresh" ? 1 : 3,
        }
      )
    );
  }

  const checkin = input.checkin;
  if (checkin?.energy != null)
    observations.push(
      observation(
        "recovery_capacity",
        "felt_energy",
        date,
        "user_checkin",
        Number(checkin.energy) <= 2 ? "constraint" : Number(checkin.energy) >= 4 ? "support" : "neutral",
        // Third-person evidence, like every sibling: this string is the POSTURE line in
        // the prompt and the `based_on` provenance, and it was handing the model a
        // verdict ("rest is the smart call") where the contract promises an observation.
        // The athlete-facing sentence is the `felt_energy_low` voice and is unchanged.
        Number(checkin.energy) <= 2
          ? "The athlete reports feeling run-down today."
          : "The athlete reports workable energy today.",
        {
          voice: { key: Number(checkin.energy) <= 2 ? "felt_energy_low" : "felt_energy_ok" },
          safety_override: Number(checkin.energy) <= 2,
          max_age_days: 0,
        }
      )
    );
  if (checkin?.sleep_feel != null)
    observations.push(
      observation(
        "recovery_capacity",
        "sleep_feel",
        date,
        "user_checkin",
        Number(checkin.sleep_feel) <= 2 ? "constraint" : Number(checkin.sleep_feel) >= 4 ? "support" : "neutral",
        Number(checkin.sleep_feel) <= 2
          ? "The athlete feels poorly recovered despite any wearable reading."
          : "The athlete feels reasonably rested.",
        {
          voice: { key: Number(checkin.sleep_feel) <= 2 ? "sleep_feel_low" : "sleep_feel_ok" },
          safety_override: Number(checkin.sleep_feel) <= 2,
          max_age_days: 0,
        }
      )
    );
  if (checkin?.soreness != null)
    observations.push(
      observation(
        "training_load_tolerance",
        "felt_soreness",
        date,
        "user_checkin",
        Number(checkin.soreness) >= 4 ? "constraint" : "neutral",
        Number(checkin.soreness) >= 4
          ? "The athlete reports high soreness today."
          : "The athlete reports no high soreness today.",
        {
          voice: { key: Number(checkin.soreness) >= 4 ? "soreness_high" : "soreness_ok" },
          safety_override: Number(checkin.soreness) >= 4,
          max_age_days: 0,
        }
      )
    );

  const autoreg = input.trainingSignals?.autoregulation;
  if (autoreg?.joint_areas?.length)
    observations.push(
      observation(
        "health_constraints",
        "joint_pain",
        date,
        "manual_session",
        "constraint",
        `Recent user-reported joint pain calls for pain-free substitutions around ${autoreg.joint_areas.join(", ")}.`,
        {
          voice: {
            key: "joint_pain",
            subject: joinList(autoreg.joint_areas.map((a: unknown) => String(a).toLowerCase())),
          },
          safety_override: true,
          max_age_days: 7,
        }
      )
    );
  if (autoreg?.low_performance_flag)
    observations.push(
      observation(
        "training_load_tolerance",
        "felt_fatigue",
        date,
        "manual_session",
        "constraint",
        "Recent sessions felt below usual performance, so loading should ease.",
        { voice: { key: "low_performance" }, safety_override: true, max_age_days: 7 }
      )
    );
  else if (autoreg?.soreness_flag)
    observations.push(
      observation(
        "training_load_tolerance",
        "felt_soreness",
        date,
        "manual_session",
        "caution",
        "Recent session feedback shows elevated soreness.",
        { voice: { key: "session_soreness" }, safety_override: true, max_age_days: 7 }
      )
    );

  const meso = input.programState?.mesocycle;
  if (meso?.phase === "deload-due")
    observations.push(
      observation(
        "training_load_tolerance",
        "mesocycle",
        date,
        "cairn_program_state",
        "constraint",
        meso.note || "Accumulated training load says recovery is due.",
        // The program state's own note is a planning line, not athlete prose; the
        // athlete hears an authored sentence rather than a spliced foreign one.
        { voice: { key: "deload_due" }, max_age_days: 1 }
      )
    );
  else if (meso?.acute_chronic_ratio != null)
    observations.push(
      observation(
        "training_load_tolerance",
        "acute_load",
        date,
        "cairn_program_state",
        Number(meso.acute_chronic_ratio) > 1.5 ? "caution" : "support",
        Number(meso.acute_chronic_ratio) > 1.5
          ? "Acute training load is running above the established base."
          : "Training load is within the established tolerance band.",
        {
          voice: { key: Number(meso.acute_chronic_ratio) > 1.5 ? "acute_load_high" : "acute_load_ok" },
          max_age_days: 1,
        }
      )
    );
  if (input.programState?.hybrid?.status === "fuel-protect")
    observations.push(
      observation(
        "energy_fueling",
        "hybrid_fuel",
        date,
        "cairn_hybrid_state",
        "constraint",
        input.programState.hybrid.headline || "Recent endurance work raises fueling needs around the planned training.",
        { voice: { key: "hybrid_fuel" }, max_age_days: 2 }
      )
    );
  else if (input.programState?.hybrid?.status && input.programState.hybrid.status !== "clear")
    observations.push(
      observation(
        "training_load_tolerance",
        "hybrid_interference",
        date,
        "cairn_hybrid_state",
        "caution",
        input.programState.hybrid.headline ||
          "Recent endurance work changes how the next strength session should land.",
        { voice: { key: "hybrid_interference" }, max_age_days: 2 }
      )
    );

  const exp = input.expenditure;
  if (exp?.tdee != null)
    observations.push(
      observation(
        "energy_fueling",
        "expenditure",
        date,
        String(exp.prior_basis || exp.tdee_basis || "cairn_expenditure"),
        exp.quality?.intake === "partial" || exp.quality?.outcome?.startsWith?.("implausible")
          ? "caution"
          : exp.confidence === "high"
            ? "support"
            : "neutral",
        exp.quality?.explanation || exp.basis || "Energy balance is still settling.",
        {
          voice: { key: "expenditure" },
          coverage: {
            samples: Number(exp.points) || 1,
            expected: exp.window_days ?? null,
            window_days: exp.window_days ?? null,
          },
          max_age_days: 3,
        }
      )
    );

  const underfueling = input.underfueling;
  if (["execution_gap", "prescription_strain", "settling", "persistent_strain"].includes(String(underfueling?.state))) {
    const persistent = underfueling.state === "persistent_strain";
    const protective = ["prescription_strain", "persistent_strain"].includes(String(underfueling.state));
    observations.push(
      observation(
        "energy_fueling",
        "underfueling_control",
        date,
        "cairn_underfueling",
        protective ? "constraint" : "caution",
        String(underfueling.action?.line || underfueling.rationale || "Fuel availability is being protected."),
        {
          voice: { key: protective ? "fuel_protect" : "fuel_watch" },
          coverage: { samples: Number(underfueling.agreeing_channels?.length) || 1, window_days: 14 },
          max_age_days: 1,
        }
      )
    );
    if (
      persistent ||
      (underfueling.action?.training === "hold_aggression" && underfueling.state !== "prescription_strain")
    ) {
      observations.push(
        observation(
          "training_load_tolerance",
          "fuel_protection",
          date,
          "cairn_underfueling",
          persistent ? "constraint" : "caution",
          persistent
            ? "Independent fuel, performance, and recovery channels still show strain after the correction settled, so the next training dose should reduce."
            : "Fuel and outcome signals agree enough to hold progression aggression while the next correction settles.",
          { voice: { key: persistent ? "fuel_strain_persistent" : "fuel_strain_hold" }, max_age_days: 1 }
        )
      );
    }
  }

  const context = input.context;
  const activeLoadContexts = Array.isArray(context?.active)
    ? context.active.filter((item: any) => item?.reduce_load !== false)
    : [];
  const activeInjuries = activeLoadContexts.filter((item: any) => String(item?.kind ?? "") === "injury");
  const activeIllnesses = activeLoadContexts.filter(
    (item: any) => String(item?.kind ?? "") !== "injury" && item?.reduce_load === true
  );
  const injurySummary = activeInjuries[0]
    ? [activeInjuries[0]?.title, activeInjuries[0]?.reason].filter(Boolean).join(": ")
    : "";
  // The athlete hears the injury by NAME, in an authored sentence. The summary above
  // joins that name to context-effect's generic classifier line ("Achilles
  // tendinopathy: an active injury is worth easing or working around"), which is
  // useful provenance for a model and redundant prose for a person.
  //
  // An injury reads as a CONDITION the sentence owns ("your shoulder strain"), so it is
  // lowercased exactly as the train-day caveat already does. An illness or a dated
  // commitment reads as a LABEL ("Head cold", "School pickup") and keeps its own case —
  // lowercasing those produced "you're working through head cold", a bare noun phrase
  // missing its article.
  const injuryTitle = String(activeInjuries[0]?.title ?? "")
    .trim()
    .toLowerCase();
  const illnessTitle = String(activeIllnesses[0]?.title ?? "").trim();
  if (context?.reduce_load && activeInjuries.length)
    observations.push(
      observation(
        "health_constraints",
        "active_injury",
        date,
        "user_context",
        "constraint",
        injurySummary || "An active injury calls for easing or working around load.",
        { voice: { key: "active_injury", subject: injuryTitle }, safety_override: true, max_age_days: 0 }
      )
    );
  if (context?.reduce_load && activeIllnesses.length)
    observations.push(
      observation(
        "health_constraints",
        "illness",
        date,
        "user_context",
        "constraint",
        activeIllnesses[0]?.reason || "An active illness calls for protecting recovery.",
        { voice: { key: "illness", subject: illnessTitle }, safety_override: true, max_age_days: 0 }
      )
    );
  // A FLOOR, not a live path. `activeContextEffect` derives `reduce_load` as
  // `active.some((a) => a.reduce_load)` over items whose own `reduce_load` is a required
  // boolean, so whenever this flag is true at least one item lands in `activeInjuries`
  // (kind injury) or `activeIllnesses` (everything else that reduces load) above — both
  // live callers pass that snapshot, so this never fires for them. It stays because the
  // `context` input is untyped: a caller that supplies the coarse flag without an
  // itemized `active` list must still put a load-reducing health constraint into the
  // health dimension rather than silently drop it.
  if (context?.reduce_load && !activeInjuries.length && !activeIllnesses.length)
    observations.push(
      observation(
        "health_constraints",
        "active_health_constraint",
        date,
        "user_context",
        "constraint",
        "An active health constraint calls for easing or working around load.",
        { voice: { key: "health_constraint" }, safety_override: true, max_age_days: 0 }
      )
    );
  if (context?.fueling_disrupted)
    observations.push(
      observation(
        "energy_fueling",
        "routine_disruption",
        date,
        "user_context",
        "caution",
        "Current travel or illness may disrupt normal fueling.",
        { voice: { key: "fueling_disrupted" }, max_age_days: 0 }
      )
    );
  if (context?.expect_worse_sleep)
    observations.push(
      observation(
        "life_capacity",
        "schedule_pressure",
        date,
        "user_context",
        "caution",
        "A current commitment or stressful stretch is likely to compress recovery capacity.",
        { voice: { key: "schedule_pressure" }, max_age_days: 0 }
      )
    );
  const activePressure = (Array.isArray(input.contextEvents) ? input.contextEvents : []).filter(
    (event) =>
      event &&
      event.start_date <= date &&
      (!event.end_date || event.end_date >= date) &&
      /trip|life_event|family_event/.test(String(event.kind || ""))
  );
  if (activePressure.length && !context?.expect_worse_sleep)
    observations.push(
      observation(
        "life_capacity",
        "schedule_pressure",
        date,
        "user_context",
        "caution",
        `${activePressure[0].title || "A current commitment"} adds schedule pressure today.`,
        {
          voice: { key: "commitment_pressure", subject: String(activePressure[0].title ?? "").trim() },
          max_age_days: 0,
          observation_id: `life:${activePressure[0].id ?? activePressure[0].title}`,
        }
      )
    );
  if (input.completedToday)
    observations.push(
      observation(
        "training_load_tolerance",
        "completed_today",
        date,
        "cairn_training_log",
        "support",
        "Today's planned work is already complete.",
        { voice: { key: "completed_today" }, max_age_days: 0 }
      )
    );

  return buildUnifiedSignalState(date, observations);
}

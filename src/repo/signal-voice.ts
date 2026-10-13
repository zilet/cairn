// The athlete voice of the unified signal state — the SIGNAL_VOICE vocabulary and the
// one entry point (`spokenSignalVoice`) every surface a person reads speaks it through.
//
// It lives in its own module, apart from the arbitration in signal-state.ts, because the
// Brief's prose (day-read-prose.ts) borrows these sentences AT LOAD TIME (RUN_DOWN_WHY and
// friends are top-level constants), and signal-state.ts sits inside the repo layer's big
// import cycle: pulled from there, a day-read-prose loaded first reached `SIGNAL_VOICE`
// before it was initialized. This module imports nothing from that cycle (the posture is
// a type-only import), so any load order sees the vocabulary whole. signal-state.ts
// re-exports every name here, so existing importers are unchanged; anything that reads
// the vocabulary at top level imports it from HERE.
import { pickDayVariant } from "./brain/day-read-rules.js";
import type { SignalPosture } from "./signal-state.js";
import { WEAR_ABSENCE_SAMPLE_AGE, WEAR_ABSENCE_SENTENCES } from "./wear-pattern-voice.js";

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
      "One short night sits behind today, so there's no need to make this a big one.",
      "Last night came up short — a good day to ask a little less of yourself.",
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
  // ONE verified reading off the norm, which is not yet a finding. These belong to a
  // `neutral` observation — it can neither brake the day nor endorse it — so every
  // phrasing has to be genuinely non-directive. A sentence here telling the athlete to
  // ease off would be a brake the arbitration never agreed to.
  hrv_unsettled: {
    concept: /\bvariability\b/i,
    variants: [
      "One recent heart-rate variability reading came in off your usual — worth noticing, not worth reading into yet.",
      "Your last variability reading was on the low side for you. One reading is not a pattern.",
      "There is a single odd heart-rate variability reading in your recent numbers, which is worth keeping an eye on.",
      "Variability came in lower than usual once recently — nothing to act on unless it repeats.",
    ],
  },
  resting_hr_unsettled: {
    concept: /\bheart rate\b/i,
    variants: [
      "One recent resting heart rate reading came in off your usual — worth noticing, not worth reading into yet.",
      "Your last resting heart rate reading was on the high side for you. One reading is not a pattern.",
      "There is a single odd resting heart rate reading in your recent numbers, which is worth keeping an eye on.",
      "Resting heart rate came in higher than usual once recently — nothing to act on unless it repeats.",
    ],
  },
  // The EXCURSION pair — a RUN of verified readings well outside the athlete's own
  // norm, which is a different fact from the multi-day trend the `*_below` / `*_up`
  // sets speak for and needs words that cannot be mistaken for it. Deliberately no
  // "this morning": HRV and resting HR ride a 3-day window (SENSOR_MAX_AGE_DAYS), and
  // the newest VERIFIED reading may be older still, so a sentence claiming the morning
  // would be exactly the overclaim these observations were built to stop.
  hrv_excursion: {
    concept: /\bvariability\b/i,
    variants: [
      "Your latest heart-rate variability reading came in a long way under where it normally sits for you.",
      "The most recent variability reading is unusually low for you — worth easing rather than pushing through.",
      "Your last heart-rate variability reading stands out as low against your own usual, so give today a gentler shape.",
      "Variability on your most recent reading is well off your normal range, which is reason enough to go easy.",
    ],
  },
  resting_hr_excursion: {
    concept: /\bheart rate\b/i,
    variants: [
      "Your latest resting heart rate reading came in a long way above where it normally sits for you.",
      "The most recent resting heart rate reading is unusually high for you, which is worth taking gently.",
      "Your last resting heart rate reading stands out against your own usual, so ease into today.",
      "Resting heart rate on your most recent reading is well off your normal range, and that is worth respecting.",
    ],
  },
  // The SATURATION voice: the number looks good and the work says otherwise. It must
  // lead with the divergence rather than with the number, because an athlete told
  // "your variability is high, take it easy" hears a contradiction — and it must stay
  // a suggestion, so every phrasing names what is being believed rather than issuing
  // an instruction about what today is.
  hrv_saturation: {
    concept: /\b(?:costing|harder|work)\b/i,
    variants: [
      "Your recovery numbers look fine, but the work itself has been costing you more lately — that's the truer signal of the two.",
      "The variability reading is healthy while the training has been feeling harder, and where those two disagree the training usually has it right.",
      "Your numbers say recovered and the sessions say otherwise. When that happens it's worth going with what the work is telling you.",
      "Recovery is reading well, but recent work has been harder than it should be — that's worth more attention than the number is.",
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
      "You're running low today, and that's the read that counts — rest.",
      "Low by your own account today, so let this one be a rest day.",
    ],
  },
  // The same run-down tap WITHOUT anything objective behind it (see
  // FELT_REST_CORROBORATION): a lighter day, not a rest day, and it still says so in
  // the athlete's own terms.
  felt_energy_light: {
    concept: /\b(?:run-down|low)\b/i,
    variants: [
      "You're feeling a bit run-down today, so keep the work on the lighter side.",
      "You said you're low today — still move, just take the edge off.",
      "Feeling run-down by your own account, so today's work stays light.",
      "You're running low today; a lighter version of the day fits better than a hard one.",
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
      "You haven't woken up rested, and that's worth listening to ahead of anything a watch says.",
      "However you slept, you don't feel recovered — today is for getting some of that back.",
    ],
  },
  sleep_feel_light: {
    concept: /\b(?:rested|recovered|slept)\b/i,
    variants: [
      "You don't feel fully rested this morning, so keep today on the lighter side.",
      "You woke up not quite recovered — move today, just take the edge off.",
      "By your own read you slept poorly, so today's work stays light.",
      "However you slept, you don't feel rested yet — a lighter day fits.",
    ],
  },
  // A short night by the athlete's own read, on a morning they ALSO said they feel
  // good. Their energy answers the sleep question; the night rides as a caveat only.
  sleep_feel_mixed: {
    concept: /\b(?:slept|sleep|night)\b/i,
    variants: [
      "The night was short by your own read, but you feel good — let the warm-up tell you how hard to go.",
      "You didn't sleep your best, and you still feel good; train, and let the first sets set the pace.",
      "A rougher night, a good feeling this morning — go by how the warm-up feels.",
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
  // The POSITIVE counterpart of `low_performance`. Every other rated-session voice in
  // this registry speaks a brake; nothing spoke the case where the athlete's own
  // ratings say the current dose is landing well, so a maximally-supported day and an
  // evidence-less one sounded identical.
  session_strong: {
    concept: /\b(?:session|sessions|work)\b/i,
    variants: [
      "Your recent sessions have come back strong.",
      "The last session you rated felt like your usual self or better.",
      "Recent work has been landing well by your own account.",
      "You've been rating your sessions well lately.",
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
  // A flagged lab finding the connected brain has turned into an active hold on
  // endurance volume. The athlete never hears the machinery — no stored-record talk, no
  // clinical claim, no instruction — only what is being waited on and what that makes
  // this stretch worth. Subject is the marker family in plain words ("your iron stores").
  endurance_hold_flagged: {
    concept: /\b(?:recover|mend|catching up|coming back)\b/i,
    sample: "your iron stores",
    variants: [
      "With {} still catching up, keeping the running where it is serves you better than building on it.",
      "Your recent lab work has {} still on the mend, so steady endurance suits this stretch better than more of it.",
      "While {} recover, there's more to gain from holding the running steady than from adding to it.",
      "With {} still coming back, this is a better stretch for keeping the endurance where it is than for stretching it.",
    ],
  },
  // Easy running that is not easy. The subject is the athlete's OWN easy ceiling in
  // bpm — a measurement off the personal model, not a grade, and the one number that
  // makes this sentence actionable instead of vague. Deliberately never a gate: the
  // finding is that the hard days would land better, not that today is forbidden.
  run_intensity_compressed: {
    concept: /\beasy\b/i,
    sample: "148 bpm",
    variants: [
      "Your easy runs have been finishing up near your hard end lately — letting one settle under {} is what makes the quality days land.",
      "Nothing in the past couple of weeks has actually run easy. An easy day that stays under {} would give the hard ones something to bite into.",
      "Every recent run has sat above where easy lives for you — under {} — and one genuinely easy outing is worth more right now than another middling one.",
      "Your easy pace has drifted up toward the hard end; keeping one run under {} protects the sessions you want to be sharp for.",
      "The easy days have been coming in about as hard as the hard days. Under {} is where easy actually sits for you, if there's room to give one back.",
    ],
  },
  // The CHRONIC drift voice. Its sibling above speaks for a fortnight in which
  // NOTHING read easy; this one speaks for the commoner shape — some easy running
  // survives, most of it has crept up. So no phrasing here may claim "nothing" or
  // "every run", and the suggestion is the same one that pays: easy days buy the
  // hard ones.
  run_intensity_chronic_drift: {
    concept: /\beasy\b/i,
    sample: "148 bpm",
    variants: [
      "Most of your running over the past few weeks has drifted above where easy sits for you — under {} — and easy days are what buy the hard ones.",
      "The easy end has crept up on you lately: more of your runs finish above {} than under it, and the quality days are what pay for that.",
      "Your easy runs have mostly been landing above {} this past few weeks. Letting more of them settle under it is what makes the hard sessions land.",
      "Across the last few weeks the majority of your running has sat above {}, which is the easy ceiling doing the work of a moderate day.",
      "More of your recent runs have finished above {} than below it — giving the easy ones back their easiness is worth more than another middling week.",
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
      "Give your {} a wide berth today and keep everything else comfortable.",
      "Today works best built around your {}, with nothing that puts it under strain.",
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
      "Choose movements that leave your {} comfortable today.",
      "Today is worth shaping around your {}, skipping anything that provokes pain.",
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
      "The gentler read on today is to look after your recovery first.",
      "Today reads as one to protect rather than press.",
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
  // The SHAPE of the silence, when the wearable's own cadence explains it.
  //
  // `unvoiced_open` above says the honest thing about an empty morning ("not
  // enough fresh signal, go by feel") but says it identically whether the watch
  // has been on the wrist every night for a year and stopped, or is worn for runs
  // and the occasional night and simply wasn't worn last night. Those are
  // different facts, and only one of them is worth mentioning. The words live in
  // wear-pattern-voice.ts, beside the same sets the Brief's contributor row and
  // the next step speak from, so absence has ONE vocabulary rather than one per
  // surface — which is exactly how "no wearable data synced yet" ended up on the
  // screen of an athlete whose watch was working perfectly.
  //
  // `{}` is the plain-words age of the last reading ("about 3 weeks ago").
  wear_absence_episodic: {
    concept: /\bwatch\b/i,
    sample: WEAR_ABSENCE_SAMPLE_AGE,
    variants: WEAR_ABSENCE_SENTENCES.episodic,
  },
  // The same silence, said about a NIGHT — reachable only when the series behind the
  // cadence really is sleep. Splitting the key rather than the sentence keeps the
  // rotation stable: an athlete whose sleep series is the one that went quiet reads
  // the same words every morning it stays quiet, instead of drifting between nouns.
  wear_absence_episodic_nights: {
    concept: /\bwatch\b/i,
    sample: WEAR_ABSENCE_SAMPLE_AGE,
    variants: WEAR_ABSENCE_SENTENCES.episodic_nights,
  },
  wear_absence_lapsed: {
    concept: /\b(?:watch|reading)\b/i,
    sample: WEAR_ABSENCE_SAMPLE_AGE,
    variants: WEAR_ABSENCE_SENTENCES.lapsed,
  },
  wear_absence_unworn: {
    concept: /\b(?:wearable|watch)\b/i,
    variants: WEAR_ABSENCE_SENTENCES.unworn,
  },
  // NOTE: there is deliberately no voice for the BACKED day here. The one athlete-facing
  // surface that speaks on a backed morning is the Brief's `why`, and it already owns a
  // dedicated, grammar-registered set for exactly that state (TRAIN_PUSH_WHY in
  // day-read.ts). A second vocabulary for one state is how two surfaces end up saying
  // slightly different things about the same morning — which is the drift this whole
  // layer exists to prevent. `SignalSupport` therefore carries evidence, not words.
} as const satisfies Record<string, SignalVoiceEntry>;

export type SignalVoiceKey = keyof typeof SIGNAL_VOICE;
export interface SignalVoiceRef {
  key: SignalVoiceKey;
  subject?: string;
}

// Where an unknown or missing voice lands, BY DIRECTION of the day.
//
// The floor used to be `unvoiced_protect` unconditionally, which meant a green
// morning whose voice went missing was handed protective words — the layer failing
// safe in the engineering sense and unsafe in the coaching one, since a read that
// tells a fresh athlete to protect their recovery for no stated reason is exactly the
// unfounded brake this whole vocabulary exists to prevent. So the floor follows the
// posture: protective words only where the day is actually protective, and the
// honestly-thin "go by how you feel" line everywhere else.
export const POSTURE_FALLBACK_VOICE: Readonly<Record<SignalPosture, SignalVoiceKey>> = {
  rest: "unvoiced_protect",
  easy: "unvoiced_protect",
  modify: "unvoiced_protect",
  train: "unvoiced_open",
  done: "unvoiced_open",
};

// The athlete-facing phrasings for one voice, subject substituted. Never empty: an
// unknown or missing key degrades to `fallback` rather than to silence (or, worse, to
// a machine-facing `summary`). `fallback` defaults to the protective floor because a
// caller that knows nothing about the day should claim nothing about it; a caller
// that HAS a posture should pass POSTURE_FALLBACK_VOICE[posture].
export function signalVoice(
  ref?: SignalVoiceRef | null,
  fallback: SignalVoiceKey = "unvoiced_protect"
): readonly [string, ...string[]] {
  const entry: SignalVoiceEntry =
    (ref && SIGNAL_VOICE[ref.key]) || SIGNAL_VOICE[fallback] || SIGNAL_VOICE.unvoiced_protect;
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
  key: string = SIGNAL_VOICE_KEYS.protect,
  // The posture whose direction the FLOOR should follow when `ref` names no voice.
  // Omitted, the protective floor stands (see POSTURE_FALLBACK_VOICE).
  posture?: SignalPosture | null
): string {
  const fallback = posture ? POSTURE_FALLBACK_VOICE[posture] : undefined;
  return pickDayVariant(signalVoice(ref, fallback ?? "unvoiced_protect"), date, key);
}

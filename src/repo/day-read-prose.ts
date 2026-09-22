// The Brief's words — the athlete-facing vocabulary of the deterministic day read.
//
// Split out of day-read.ts (W2-H2). Everything here is PROSE: the per-rule outcome
// sentences, the why / lead / caveat / earn-path / headline / policy-reason variant
// sets, the required-concept guards over them, and the prose identity that pins one
// wording per morning. It knows nothing about the read engine — the engine imports
// these, never the other way round — so a phrasing change is reviewable on its own.
//
// LAW (see CLAUDE.md): a rule's words are a VARIANT SET, never one literal, rotated by
// calendar date through pickDayVariant. Add a phrasing to the set; never a literal.
import { pickDayVariant, type DayReadRuleOutcome } from "./brain/day-read-rules.js";
import { mondayOf } from "../lib/dates.js";
import { SIGNAL_VOICE_REGISTRY, signalVoice, type SignalVoiceRef } from "./signal-state.js";
import type { MesoPhase, MesocycleState } from "./program-state.js";
import type { getEnduranceGoal } from "./profile.js";
// Type-only, therefore erased at build time: the week-ahead DTO stays with the engine
// that produces it, and this module borrows only its shape (no runtime import back).
import type { WeekAheadDay } from "./day-read.js";

// Every rule outcome the deterministic floor can report: the STABLE code that
// keys the accountability ledger, and the athlete-facing sentence right beside
// it, so the words can never drift away from the rule that says them (see the
// contract note in brain/day-read-rules.ts). Exported so the vocabulary is
// enumerable — there is no way for a rule to reach the athlete without words.
export const DAY_READ_OUTCOMES = {
  logged_loading_work_today: {
    code: "logged_loading_work_today",
    reasons: [
      "You've already got real training in today.",
      "Today's work is already done and logged.",
      "The session's in — today is covered.",
    ],
  },
  // The week's own seam. Not a brake and not an argument — the athlete built a rest
  // day into their template and today is it, so the read simply says so. Every safety
  // floor above still wins on a morning that has its own reason to rest, and keeps its
  // own words; this one only speaks when nothing else needed to.
  template_rest_day: {
    code: "template_rest_day",
    reasons: [
      "Your week has a rest day here, and today is it.",
      "Today is the rest day your week is built around.",
      "The plan leaves today open — this is the rest day in your week.",
      "Your template puts a rest day here, so today is yours.",
    ],
  },
  acute_sleep_corroborated: {
    code: "acute_sleep_corroborated",
    reasons: [
      "Last night was short, and your sleep has been running short for a while now.",
      "A short night on top of a stretch of short nights.",
      "Sleep came up short again last night, the way it has for a while.",
      "Last night was thin, and it isn't a one-off right now.",
    ],
  },
  acute_signal_protection: {
    code: "acute_signal_protection",
    reasons: [
      "Today's signals point to protecting your recovery rather than pushing.",
      "What you're showing today asks for protection more than effort.",
      "Today reads like a day to look after recovery first.",
      "The signals today lean toward guarding recovery.",
    ],
  },
  recovery_dose_overrun: {
    code: "recovery_dose_overrun",
    reasons: [
      "Yesterday went well past the lighter dose this recovery week is built around.",
      "Yesterday ran a long way past what this reduced week asks for.",
      "This week is meant to be light, and yesterday was not.",
    ],
  },
  accumulated_load_rest: {
    code: "accumulated_load_rest",
    reasons: [
      "You've stacked several loading days in a row without a break.",
      "Several real training days back to back, with nothing in between.",
      "That's a run of hard days now, uninterrupted.",
      "You've been loading day after day without a gap.",
    ],
  },
  // The accumulated-load rest, answered by the athlete's own standing preference.
  // It is NOT a second opinion about the same evidence: every safety input that
  // produces a rest still produces one, and this rule only ever fires on the ONE
  // shape of rest that is about rhythm rather than about a signal — stacked loading
  // days with nothing else pulling the other way. The preference sets the posture;
  // the evidence still decides the day (see the rule in dayRead for the whole gate).
  push_drive_targeted_training: {
    code: "push_drive_targeted_training",
    reasons: [
      "You've asked to keep training when recovery reads well, and there's real work due.",
      "Recovery reads clear, and some muscle groups are genuinely due.",
      "The days have stacked up, but nothing is pulling the other way and work is still due.",
      "You'd rather train than take the day off, and there's due work worth doing.",
    ],
  },
  // The accumulated-load rest, RE-TIMED rather than answered. Same family as the push
  // drive above and the same one shape of rest — stacked loading days, nothing else
  // pulling the other way — but the reason is the calendar rather than a preference:
  // tomorrow is already claimed by a trip or a commitment, so the discretionary break
  // is better taken then. The athlete still gets their break; the read only moves which
  // day it lands on, and only ever offers EASY work in exchange.
  lookahead_retimed_training: {
    code: "lookahead_retimed_training",
    reasons: [
      "Tomorrow is already committed, so the quiet day is better taken then.",
      "The break still comes — tomorrow is spoken for, so it lands there instead of here.",
      "There's something on tomorrow, which makes it the natural day to sit out.",
      "Tomorrow already has a claim on it, so today holds the easy movement instead.",
    ],
  },
  // The same-day mirror of the look-ahead: the calendar already owns TODAY. Two
  // shapes, two codes. `day_claimed_rest` honors the athlete's own claims_day — their
  // word that the day is taken, which the read accepts rather than re-litigates.
  // `lab_draw_morning` is gentler: the day still opens, but everything it offers goes
  // AFTER the draw, because exercise beforehand can nudge the very numbers being
  // measured — so every phrasing puts the needle first and keeps what follows easy.
  day_claimed_rest: {
    code: "day_claimed_rest",
    reasons: [
      "You said today is taken, and that settles it.",
      "Today is already claimed on the calendar, by your own word.",
      "You marked today as spoken for, so the quiet day lands here.",
    ],
  },
  // THE TRADE (owner ruling, 2026-09-02). The same claim machinery as the rule above
  // — a `claims_day` event the athlete wrote — but they wrote it about themselves:
  // they kept training on a morning that read quiet and moved the break here. So the
  // words name the trade rather than a commitment, because "you said today is taken"
  // would read as an appointment they do not have. Still only a suggestion; training
  // through it is exactly as available as it is on any other morning.
  day_traded_rest: {
    code: "day_traded_rest",
    reasons: [
      "This is the rest you traded for when you trained through the quiet day.",
      "You moved this rest here yourself, so today is the quiet one.",
      "Today is the rest you swapped forward — it's yours to take.",
    ],
  },
  lab_draw_morning: {
    code: "lab_draw_morning",
    reasons: [
      "A blood draw is on today's calendar, so the day stays simple around it.",
      "Today holds a lab draw, and easy movement after it is plenty.",
      "With a blood draw today, anything worth doing comes after the draw.",
    ],
  },
  low_readiness_rest: {
    code: "low_readiness_rest",
    reasons: [
      "This morning's readiness reading came in low.",
      "Today's readiness reading is on the low side.",
      "Your watch read this morning as low readiness.",
    ],
  },
  // The band BELOW the one above, and a genuinely different read (owner ruling,
  // 2026-08-28). A subdued reading earns an easy day; a reading this deep is the
  // watch saying the night restored nothing, and the day it earns is rest. The
  // outcome ladder may still ease it — but only as far as easy movement.
  rest_grade_readiness: {
    code: "rest_grade_readiness",
    reasons: [
      "This morning's readiness reading is about as low as it goes.",
      "Your readiness reading this morning is barely off the floor.",
      "The reading this morning is at the very bottom of its range.",
      "Whatever last night was, the morning reading says it didn't restore much.",
    ],
  },
  felt_run_down_rest: {
    code: "felt_run_down_rest",
    reasons: [
      "You said you're feeling run-down today.",
      "You told us you're low today, and that's the signal that counts.",
      "You checked in feeling run-down.",
    ],
  },
  logged_light_work_today: {
    code: "logged_light_work_today",
    reasons: [
      "You've already moved today.",
      "Something's already on the board for today.",
      "You've already got movement in today.",
    ],
  },
  endurance_volume_spike: {
    code: "endurance_volume_spike",
    reasons: [
      "Your running has ramped up this week and needs a day to absorb.",
      "This week's mileage jumped, and it wants a day to settle.",
      "You've run more than usual this week — absorbing it matters now.",
    ],
  },
  chronic_sleep_watch: {
    code: "chronic_sleep_watch",
    reasons: [
      "Your sleep has been running short lately, without a fresh warning that calls for full rest.",
      "Sleep has been thin for a while now, though nothing this morning says stop.",
      "The sleep trend has been short lately — worth easing, not worth stopping.",
      "Short sleep has been the pattern recently, with nothing acute on top of it.",
    ],
  },
  planned_reduced_training: {
    code: "planned_reduced_training",
    reasons: [
      "Your recovery week calls for the planned lighter session today.",
      "This is a reduced week, and today's lighter session is the plan.",
      "The lighter version of today's session is what this week asks for.",
    ],
  },
  planned_training: {
    code: "planned_training",
    reasons: [
      "A session is due and nothing is asking you to hold back.",
      "Today's session is due, and nothing is pulling the other way.",
      "You're due, and everything reads clear for it.",
      "A session is waiting and you look ready for it.",
    ],
  },
  // The one rule that reads the athlete's OWN outcomes back into the floor. Every
  // other rule above looks only at today's inputs, which is why a stable picture
  // could suggest rest for eleven mornings running while the athlete trained
  // through six of them and rated those sessions well: the disagreement was
  // recorded, reconciled and then never consulted. This rule consults it, and does
  // exactly one thing with it — turns a rest into an EASY day. Never a train day,
  // never against a clinical constraint, never against a fresh short night.
  outcome_feedback_soften: {
    code: "outcome_feedback_soften",
    reasons: [
      "You've trained through the last few of these and it's gone well.",
      "The last few times today read like this, you trained and came out fine.",
      "Training through reads like this has been working for you lately.",
      "You've kept training on days like this recently, and it's held up.",
    ],
  },
  // The MIRROR of the rule above, one rung further up the ladder (owner ruling,
  // 2026-08-17). The rest→easy softening closed half the loop: it could answer a rest
  // the athlete kept overruling, and then the eased day became the new floor and the
  // loop went quiet again — an athlete whose easy mornings kept turning into real
  // sessions, week after week, was still being offered an easy morning. This answers
  // that one, on the same evidence bar and with the same resets, and it too moves
  // exactly ONE step: easy → train, never further, never against anything clinical,
  // never inside a reduced week.
  outcome_feedback_open: {
    code: "outcome_feedback_open",
    reasons: [
      "Your last few easy mornings turned into real sessions and they went well.",
      "The last handful of easy reads became proper training, and it held up.",
      "You've been turning days like this into solid sessions lately, and they've landed fine.",
      "Easy mornings have been becoming real work for you recently, and coming out fine.",
    ],
  },
  // The LONG loop (owner ruling, 2026-09-22): a MATURE "you train anyway, and it costs
  // you nothing" pattern — six weeks, not ten days — may move a non-floor rest or easy
  // read straight to "train, with the caveat". Every health, safety, rest-grade, injury
  // and acute-gate floor stays out of its reach (see day-read.ts).
  learned_train_anyway: {
    code: "learned_train_anyway",
    reasons: [
      "You've trained through reads like this for weeks and it has held up — with the caveat that today's quieter signals still stand.",
      "Weeks of mornings like this became training days and went fine; back off if today feels different.",
      "Training through quiet reads has worked well for you for a while — one caveat: ease off if it doesn't feel right.",
    ],
  },
} as const satisfies Record<string, DayReadRuleOutcome>;

// The athlete-facing `why` for each deterministic read, in several calm phrasings
// of the SAME judgement — rotated per calendar day exactly like the outcome
// reasons above, and for the same reason: a stable signal fires a stable rule, and
// one literal per rule is what made the Brief print an identical sentence every
// morning. The words move; the posture never does.
export const DONE_WHY: ReadonlyArray<(label: string) => string> = [
  (label) => `You already got a solid ${label} in today — the rest of the day is for recovery.`,
  (label) => `Today's ${label} is done. Everything from here is recovery.`,
  (label) => `That ${label} is in the books — let the rest of the day work on you.`,
];
export const ACUTE_SLEEP_WHY: readonly string[] = [
  "Last night was short and the longer sleep trend is short too — rest is the safer suggestion today.",
  "A short night on top of a short stretch — today is better spent resting.",
  "Sleep's been thin lately and last night didn't help, so rest is the kinder call.",
  "Between last night and the last couple of weeks, you're carrying a real sleep debt — rest suits today.",
];
export const DOSE_OVERRUN_WHY: readonly string[] = [
  "Yesterday's recovery session materially exceeded its reduced dose — take today to absorb it before continuing.",
  "Yesterday ran well past what this lighter week asks for, so today is for absorbing it.",
  "This week is meant to be reduced and yesterday wasn't — give today back to recovery.",
];
export const STACKED_LOAD_WHY: readonly string[] = [
  "You've trained hard several days running — let it consolidate.",
  "That's a real run of training days. Today is where it turns into fitness.",
  "Several loading days back to back — the adaptation happens on the day you stop.",
  "You've stacked the work. Let today do the quiet half of it.",
];
// At the hard-day ceiling with recovery still reading well: easier, not off. The
// count is a caveat that has run out of room to keep stacking, not a brake of its
// own — so the day stays open, just quieter, and the athlete is asked to say if
// that picture changes.
export const STACKED_LOAD_CEILING_WHY: readonly string[] = [
  "That's a run of hard days, and you're still carrying them well — keep today easier, and tell me if that changes.",
  "You've stacked several training days, and nothing is pulling the other way — an easier day fits, and say so if it starts to feel off.",
  "Several loading days in a row, and you're still absorbing them — go easier today, and let me know if that shifts.",
  "The work has stacked up, and you're still feeling good on it — keep today lighter, and tell me if that changes.",
];
// The same stacked days, read for an athlete who has asked to keep training. It has
// three jobs at once and every phrasing carries all three: name the groups that are
// actually due (templated, because a targeted day that will not say what it is
// targeting is just a rest day with a nicer headline), frame the day as NARROW rather
// than as a licence to do more, and acknowledge the run of days honestly instead of
// pretending it is not there. No phrasing agrees a verb with the subject — the groups
// arrive as one phrase that may be singular ("quads") or plural ("quads and back").
export const PUSH_DRIVE_WHY: ReadonlyArray<(groups: string) => string> = [
  (groups) =>
    `Several loading days back to back, and nothing is pulling the other way — so keep today narrow: the heavy work due for your ${groups}, and nothing extra stacked on top.`,
  (groups) =>
    `You'd rather train while the evidence looks good, and it does — go after your ${groups}, which is where the work is due, and leave the running out of today.`,
  (groups) =>
    `That's a real run of training days, so make today count where it is due — heavy, focused sets for your ${groups}, and no added miles on top of them.`,
  (groups) =>
    `The days have stacked up, but recovery reads clear and you'd rather train — so spend today on what is due, your ${groups}, and save the extra cardio for another day.`,
];
export const LOW_READINESS_WHY: readonly string[] = [
  "A lighter day is the safer call today — your readiness reading came in low this morning.",
  "This morning's reading came in low, so keeping today light is the safer bet.",
  "Readiness is down today — worth respecting rather than pushing through.",
];
// The deep band. Every phrasing names the READING (that is the whole basis of the
// day) and offers rest without a verdict about the athlete — and none of them
// mentions running, because the one thing this morning must not do is put another
// run in front of them.
export const REST_GRADE_READINESS_WHY: readonly string[] = [
  "Your readiness reading this morning is about as low as that number goes — today is a rest day.",
  "This morning's reading is at the very bottom of its range, so today is best spent resting.",
  "The reading came back this morning saying almost nothing was restored — rest is the day.",
  "Readiness is scraping the floor this morning; a genuine rest day is what fits.",
];
// The same words the unified signal state speaks for the same check-in, borrowed
// rather than re-declared: a low-energy check-in reaches the athlete through BOTH
// this rule and the protect posture below, and two literals for one trigger is
// exactly how the same morning ends up reading in two different voices.
export const RUN_DOWN_WHY: readonly string[] = signalVoice({ key: "felt_energy_low" });
export const LIGHT_WORK_WHY: readonly string[] = [
  "You've already moved today — keep the rest of it easy.",
  "Something's already on the board today, so keep the rest gentle.",
  "You've moved today. That's enough — let the rest stay easy.",
];
// The re-timed rest: the same stacked days, read against a tomorrow that is already
// claimed. It is NOT a second opinion about whether the athlete needs a break — they
// do, and they still get one; it is a question about WHICH day the break lands on, and
// it fires only when the break in question is the discretionary rhythm one.
//
// Every phrasing carries three things: that tomorrow is spoken for (the whole basis of
// the read — a sentence that drops it is a train day with no explanation), that today
// is therefore the day that can hold the movement, and that the movement is EASY. The
// last one matters most: this rule reaches into a run of loading days, so it may offer
// a comfortable session and must never sound like a reason to reach for more. Written
// to fit both branches — a due plan day and a bare open one — because the sentence is
// about the calendar either way, and the focus is what tells the two apart.
export const LOOKAHEAD_RETIME_WHY: readonly string[] = [
  "Tomorrow is already spoken for, so today is the better day to move — keep it easy and it still counts.",
  "Something's on tomorrow, which makes today the natural place for the gentle work. No need to make it a big one.",
  "Tomorrow already has a claim on it, so if today is the day you move, keep the effort comfortable.",
  "With tomorrow taken, an easy turn today fits better than waiting for a day that isn't yours.",
];
// The same-day holds (see the outcome note above). The claimed-day set accepts the
// athlete's word without a trace of argument — no phrasing may bargain the day back
// open. The lab-draw set carries the ONE sequencing fact the athlete actually needs
// said out loud: the draw goes first, and whatever movement follows stays easy.
export const DAY_CLAIMED_WHY: readonly string[] = [
  "You said today is spoken for, so let it be — training picks back up when the calendar hands the day back.",
  "Today is already claimed, by your own word. A quiet day here costs nothing.",
  "You marked today as taken, so rest is the honest read — tomorrow is soon enough.",
];

// The trade's own sentence: it names whose idea this was and what it bought, and it
// never bargains the day back (the athlete may still train; the read does not argue
// either way). `rest_trade` on the claiming event is what selects it — see
// REST_TRADE_META_KEY.
export const DAY_TRADED_WHY: readonly string[] = [
  "This is the rest you traded for — you took the training day, so the quiet one lands here. It's still yours to spend however you like.",
  "You swapped this rest forward yourself when you trained through the quiet read, so today is where it comes due.",
  "The rest you moved here is due today — you kept the session, and this is the other half of that trade.",
];
export const LAB_DRAW_WHY: readonly string[] = [
  "Your blood draw comes first today — keep the morning quiet, and an easy spin of the legs after it is plenty if you feel like moving.",
  "Today holds your lab draw, so let the needle go first; easy movement afterwards still counts.",
  "With labs on the calendar this morning, save any movement for after the draw and keep it comfortable.",
  "The draw owns the morning — nothing before it, and if you move later, keep it easy.",
];
export const VOLUME_SPIKE_WHY: readonly string[] = [
  "Your running's ramped this week — an easy day lets it absorb.",
  "This week's mileage jumped, so today is for letting it settle.",
  "You've run more than usual this week; easy today is how it sticks.",
];
export const CHRONIC_SLEEP_WHY: readonly string[] = [
  "Sleep has been running short for a while now, and today doesn't add anything new to that — easing off is enough.",
  "The sleep trend's been thin for a while — nothing alarming today, so ease rather than stop.",
  "Short sleep has been the pattern recently; an easier day covers it.",
  "Nothing acute this morning, but sleep's been light lately — keep today gentle.",
];
// The softened rest. It has to do two things at once: name the evidence honestly
// (their own logged days, not a hunch) and point forward, because the whole reason
// this rule exists is that a read which never moves stops being coaching. Still a
// suggestion — every phrasing offers a lighter day, none of them asks for a session.
export const OUTCOME_FEEDBACK_SOFTEN_WHY: readonly string[] = [
  "You've trained through the last few reads like this one and it's gone well, so today leans light rather than fully off.",
  "The last handful of times this came up you trained and it held up — so today reads easy instead of a full stop.",
  "Training through days like this has been working for you lately, so keep today light rather than taking it off entirely.",
  "You've been training through these and coming out fine, so today's an easy day rather than a rest day.",
];
// The opened easy day — the same job one rung up. It has to name the evidence (their
// own last few mornings, not a hunch) AND still offer rather than instruct: every
// phrasing says the day CAN open, none of them asks for a session, and none names a
// number about them. "solid" / "real" describe the sessions they already logged.
export const OUTCOME_FEEDBACK_OPEN_WHY: readonly string[] = [
  "Your last few easy mornings became solid sessions and it went well, so today can open harder if you want it to.",
  "The last handful of days like this turned into real training and held up — so today reads as a training day.",
  "You've been turning these into proper sessions lately and coming out fine, so today's open for one.",
  "Easy mornings have been becoming real work for you and it's been landing, so today can be a session rather than a stroll.",
];
// The long loop's sentence. It opens the day AND keeps the caveat in the same breath:
// the quiet read's signals have not gone away, the athlete's weeks of evidence simply
// outrank them — so the day is a suggestion to train that still says what to watch.
export const LEARNED_TRAIN_WHY: readonly string[] = [
  "You've trained through mornings like this for weeks and come out fine, so today reads as a training day — with the caveat that the quieter signals are still there, so ease off if it doesn't feel right.",
  "Weeks of training through reads like this one have held up, so today's a session — one caveat: the signals asking for a quieter day haven't gone away, so back off if the warm-up feels flat.",
  "Mornings like this have been training days for you for a while now, and they've gone well — so train, with the caveat that today's quieter signals are still on the board; keep an eye on how it lands.",
];
// …and the sentence for the morning that pattern does NOT get to open. It is appended
// to the winning rule's own `why` — the rule still says what today is about, and this
// says why a fortnight of history did not argue with it. Every phrasing credits the
// athlete's own word and none of them bargains: this is a day standing where it is,
// not a day being talked down.
//
// TWO sets, because the veto has two doors and the sentence must not describe the wrong
// one. A check-in is something they filled in this morning and may be named as such; a
// symptom they reported is not a check-in, and the first cut told athletes who had never
// opened one that their check-in had held the day. The arm is already known
// (`held_by_statement`), so the words follow it rather than hedging across both.
export const OUTCOME_FEEDBACK_HELD_WHY: readonly string[] = [
  "You said this morning was a heavy one, and that's the newer word — today keeps its easier shape.",
  "Your own check-in this morning is the most current thing on record, so today stays where it is.",
  "You told the app how today actually feels, and that counts for more than the last couple of weeks.",
  "What you said about this morning still stands, so today stays the gentler one.",
];
// The symptom arm: they put something on record about how a part of them is feeling.
// Never "check-in" — there may not be one — and never a name for what they reported,
// which is the winning rule's job rather than this sentence's.
export const OUTCOME_FEEDBACK_HELD_SYMPTOM_WHY: readonly string[] = [
  "You put something on record about today, and that's the newer word — today keeps its easier shape.",
  "You told the app how something is feeling today, so today stays where it is.",
  "What you said about today is the most current thing on record, and it counts for more than the last fortnight.",
  "You said something was up today, so today stays the gentler one.",
];
export const UNPROGRAMMED_WHY: readonly string[] = [
  "Nothing programmed — some easy movement is plenty today.",
  "Nothing's due today, so move however you feel like moving.",
  "The plan's open today — anything easy counts.",
  "No session waiting on you today; easy movement is the whole ask.",
];
export const TRAIN_CLEAR_WHY: readonly string[] = [
  "You're recovered and due — good to go.",
  "You're due and everything reads clear. Go get it.",
  "Nothing's holding you back today — the session's yours.",
  "Recovery looks fine and the session is due. Good day for it.",
];
// The clear day's louder sibling, for the day the evidence positively BACKS rather
// than merely permits (signal_state.action.support === "backed"). Until this set
// existed the floor could only ever get quieter: the arbitration had rest, easy and
// modify thresholds and nothing above train, so a week of strongly-rated sessions
// with nothing pulling the other way read exactly like a day with no evidence at
// all — "nothing's holding you back", forever.
//
// Still a SUGGESTION and still inside the reading grammar: every phrasing OFFERS the
// reach ("worth", "if you feel like it", "a good day to"), none of them asks for it,
// and none names a number. The one idea each must carry is that today is a day to go
// AFTER something, on the evidence of what they have already logged.
export const TRAIN_PUSH_WHY: readonly string[] = [
  "Everything you've logged lately says you're carrying this well — a good day to go after a little more.",
  "Your recent sessions have come back strong and nothing's pulling the other way, so today's worth reaching on.",
  "You're due, you're absorbing the work, and today looks like a day to ask a bit more of yourself.",
  "By your own recent evidence this block is landing — if you feel like pushing today, today's the day for it.",
];
export const TRAIN_CAVEAT_LEAD: readonly string[] = [
  "You're good to train",
  "Today's a green light",
  "You're clear to train",
  "The session's on",
];
// The hold branch's own connective. It sits where TRAIN_CAVEAT_LEAD sits on the
// sibling branch — after the brake's spoken sentence, before the caveat run — and
// fires on exactly the same stable inputs, so it rotates on the same terms rather
// than printing one literal every morning a dimension sits at watch.
export const TRAIN_HOLD_LEAD: readonly string[] = [
  "Keep today's work conservative",
  "Keep the session on the conservative side",
  "Worth keeping today measured",
  "Keep today's effort in check",
];

// The hold lead's softer sibling, for the caution that is REAL but unseconded — one
// dimension at watch on a board where nothing else is pulling (see the second-opinion
// bar in planningDirectives, owner ruling 2026-08-17). That caution used to counsel
// holding load and volume everywhere; now it only speaks. The lead has to work in two
// shapes: with a caveat run after it, and on its own with nothing but the earn path
// behind it — so each phrasing is a complete clause that survives a full stop.
export const TRAIN_NOTED_LEAD: readonly string[] = [
  "The session's still yours",
  "Today's still a training day",
  "That doesn't close the day down",
  "The work still stands",
];
// The push lead. The push and the caveat run used to be mutually exclusive — any
// caveat at all withdrew the push — so a backed day carrying nothing worse than a
// bookkeeping note read exactly like a day with a brake on it. Now that bookkeeping
// caveats no longer veto the push, the composed sentence needs a lead that OFFERS the
// reach and still hands off to the caveats honestly.
export const TRAIN_PUSH_CAVEAT_LEAD: readonly string[] = [
  "There's room to reach today",
  "Today's a day you can ask more of",
  "Worth going after a little more today",
  "Today has room in it for more",
];

// The LEADS above, registered. They rotated from the start but belonged to
// neither existing registry, so nothing held them to the constitution and a new
// phrasing could skip it entirely: they are not a whole `why` (they carry no
// terminal punctuation — a caveat run follows) and not a caveat fragment (they open
// with a capital, because they open the sentence). Their own registry, keyed by the
// same pickDayVariant rotation key the rule passes, with the shape rules that follow
// from sitting at the FRONT of a composed sentence. Guards in test/dayRead.test.js.
export const DAY_READ_LEAD_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  "planned_training:caveats": TRAIN_CAVEAT_LEAD,
  "planned_training:hold_lead": TRAIN_HOLD_LEAD,
  "planned_training:noted_lead": TRAIN_NOTED_LEAD,
  "planned_training:push_caveats": TRAIN_PUSH_CAVEAT_LEAD,
};

// The one idea each lead must carry, exactly as DAY_READ_CAVEAT_CONCEPT does for the
// fragments: the green-light lead has to still read as a green light, and the hold
// lead has to still ask for restraint.
export const DAY_READ_LEAD_CONCEPT: Readonly<Record<string, RegExp>> = {
  "planned_training:caveats": /\b(?:train|session|green light)\b/i,
  "planned_training:hold_lead": /\b(?:conservative|measured|in check)\b/i,
  // A noted caution must leave the day OPEN — that is the whole difference between it
  // and the hold lead sitting above it.
  "planned_training:noted_lead": /\b(?:still|doesn't close)\b/i,
  "planned_training:push_caveats": /\b(?:room|reach|more)\b/i,
};

// ---------- THE EARN PATH (owner ruling, 2026-08-17) ----------
//
// A brake the athlete cannot see the end of is a verdict wearing a suggestion's
// clothes. Every surface where something holds the day back now closes with the
// condition that opens it again — never a date, never a target, never a number about
// the person, and never an instruction ("you must" is already a grammar violation).
//
// Two sets, because exactly one brake in this vocabulary can name a CONCRETE unlock:
// the run-intensity caution, whose voice already carries the athlete's own easy
// ceiling in bpm as its subject (SIGNAL_VOICE.run_intensity_compressed). A ceiling is
// a measurement, not a grade, and it is the one thing that makes "keep the next runs
// under it" actionable rather than vague. Everything else gets the honest general
// form: a clean stretch on whatever is being watched and the room comes back.
export const EARN_PATH_INTENSITY: ReadonlyArray<(ceiling: string) => string> = [
  (ceiling) => `Bring the next few runs in under ${ceiling} and the room to build opens back up.`,
  (ceiling) => `A couple of runs that actually sit under ${ceiling} is what gives this back.`,
  (ceiling) => `Once the easy runs are landing under ${ceiling} again, there's room to reach for more.`,
  (ceiling) => `Give it a run or two under ${ceiling} and the harder work has somewhere to go again.`,
];
const EARN_PATH_GENERAL: readonly string[] = [
  "A clear day or two on that and there's room to reach again.",
  "Once it settles, the room to push comes back with it.",
  "Give it a day or two to come good and today's ceiling lifts again.",
  "It opens back up as soon as that reads clear again.",
];

// The earn-path vocabulary, registered beside the rest of the Brief's words
// (templated set rendered with a sample ceiling, exactly as DAY_READ_WHY_VARIANTS
// does for its own templated entries).
export const DAY_READ_EARN_PATH_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  "planned_training:earn_path_intensity": EARN_PATH_INTENSITY.map((render) => render("148 bpm")),
  "planned_training:earn_path": EARN_PATH_GENERAL,
};
// The one idea each must carry: something OPENS. A phrasing that names the brake and
// forgets the way out is the sentence this whole layer exists to replace.
export const DAY_READ_EARN_PATH_CONCEPT: Readonly<Record<string, RegExp>> = {
  "planned_training:earn_path_intensity": /\b(?:opens?|back|again|somewhere to go)\b/i,
  "planned_training:earn_path": /\b(?:opens?|back|again|room)\b/i,
};

// The one earn-path sentence for the brake that is actually holding the day, or "" when
// the brake carries no voice at all. Keyed off the VOICE rather than the dimension: the
// run-intensity caution is the only one carrying a concrete unlock, and it identifies
// itself by voice key, so a second brake that grows one later joins here rather than in
// a parallel chain somewhere else.
export function earnPathClause(voice: SignalVoiceRef | null | undefined, date: string): string {
  const ceiling = String(voice?.subject ?? "").trim();
  return voice?.key === "run_intensity_compressed" && ceiling
    ? pickDayVariant(EARN_PATH_INTENSITY, date, "planned_training:earn_path_intensity")(ceiling)
    : pickDayVariant(EARN_PATH_GENERAL, date, "planned_training:earn_path");
}

// (A `RECOVERY_WEEK_TRAIN_WHY` set used to sit here as the third arm of the planned-
// training `why` chain — `holdAggression ? … : caveats.length ? … : recoveryWeek ? … :
// TRAIN_CLEAR_WHY`. It was DEAD: a recovery week always pushes RECOVERY_WEEK_CAVEAT, so
// `caveats.length >= 1` whenever `recoveryWeek` is true and the arm could never be
// reached. Hoisting the check above the caveat arm was the other way to revive it, but
// that arm is the only one that can carry the day's OTHER caveats — an injury to work
// around, a short-sleep stretch, a hold on aggression — so reviving it would have
// traded live safety guidance for a phrasing nobody had ever read. It is retired
// instead: a recovery-week train day speaks through the registered lead
// (`planned_training:caveats`) plus the registered `planned_training:recovery_week`
// caveat, which is what it has always actually printed.)

// ---------- the planned-training caveats (the fragments after the dash) ----------
// The planned-training rule is the one that fires on most mornings, and its `why` is
// assembled rather than picked: a lead, then a run of lowercase FRAGMENTS joined with
// "; and ", then a full stop. The leads rotated from the start; the fragments did not
// — each was a single hardcoded string, so an athlete in a chronic-short-sleep stretch
// or a recovery week read the identical clause every single morning, which is exactly
// the failure this whole layer exists to remove.
//
// Every set below is therefore a variant set on the same terms as the `why` sets
// above, with two extra shape rules that come from being spliced mid-sentence:
// each phrasing starts LOWERCASE and carries NO terminal punctuation, so any
// combination of them still reads as one grammatical sentence. Each set also gets
// its OWN pickDayVariant rotation key, so two caveats firing on the same day rotate
// independently instead of moving in lockstep. DAY_READ_CAVEAT_VARIANTS /
// DAY_READ_CAVEAT_CONCEPT below register them for the constitution tests.
export const RECOVERY_WEEK_CAVEAT: readonly string[] = [
  "this is the reduced recovery-week dose, so keep every set crisp and well shy of failure",
  "the recovery week has this dialled down on purpose, so keep the reps crisp and nowhere near failure",
  "you're inside a reduced week, so treat the prescription as a ceiling and leave a couple of reps in reserve",
  "this is the lighter recovery-week dose, so it should still feel easy on the way out",
];
// Templated on the injury title, following the same renderer-array pattern as
// RECOVERY_WEEK_TRAIN_WHY / QUIET_STREAK_WHY. The subject arrives already lowercased.
export const INJURY_CAVEAT: ReadonlyArray<(subject: string) => string> = [
  (subject) => `you've got ${subject} to work around, so skip anything that aggravates it`,
  (subject) => `${subject} is still there to work around, so steer clear of anything that aggravates it`,
  (subject) => `keep ${subject} in mind and work around it, since nothing today is worth aggravating it for`,
  (subject) => `there's ${subject} to work around today, so drop any movement that makes it speak up`,
];
// Session-reported joint pain, templated on the sore areas exactly as INJURY_CAVEAT is
// templated on the injury title. It needs its own set because it reaches the read by a
// different route and reads differently: an injury is a NAMED condition from a context
// event ("a sore left knee"), joint pain is a bare list of areas from session feedback
// ("left knee"), and the ask is a pain-free SUBSTITUTION rather than avoiding a known
// aggravator. Every phrasing avoids a verb agreeing with the subject, because the areas
// arrive joined ("left knee, right shoulder") and a singular verb reads wrong on one of
// the two.
export const JOINT_PAIN_CAVEAT: ReadonlyArray<(subject: string) => string> = [
  (subject) => `keep today pain-free around your ${subject} and swap out anything that aggravates it`,
  (subject) => `there's recent soreness around your ${subject} to work around, so skip anything that provokes it`,
  (subject) => `work around your ${subject} today and stop short of anything that nags`,
  (subject) => `pick movements that keep your ${subject} comfortable rather than pushing through the soreness`,
];
export const EASE_AROUND_CAVEAT: readonly string[] = [
  "there's something to ease around right now, so keep the load conservative",
  "something needs easing around at the moment, so keep the load on the conservative side",
  "you've got something to ease around today, so hold the load where it stays comfortable",
  "there's something worth easing around, so keep today's load modest",
];
export const ANTICIPATE_DELOAD_CAVEAT: readonly string[] = [
  "recovery's drifting below your norm, so a couple more hard days and you'll likely want a reset",
  "your recovery's been sliding a little, so another hard day or two and a reset will probably be worth taking",
  "recovery's running under where it usually sits, and a reset is probably only a few hard days away",
  "recovery's been trending a touch low, so a lighter week may be closer than it looks",
];
// Fueling ADVICE after heavy endurance work in a cut (the advice-only hybrid_fuel
// observation): it holds nothing back, it rides the caveat run.
export const FUEL_AROUND_TRAINING_CAVEAT: readonly string[] = [
  "the recent endurance work asks for fuel around the session, so get some carbs in before and after",
  "with the running adding up, eat around today's session, carbs before and a proper meal after",
  "fuel the work today: some carbs beforehand and a real meal after, given the endurance load",
];
export const VOLUME_SPIKE_CAVEAT: readonly string[] = [
  "your running's ramped this week, so keep today's miles easy and don't pile on hard intensity",
  "the running's climbed this week, so keep today's miles gentle rather than stacking more intensity on top",
  "you've put more running in than usual this week, so today's miles are better kept easy",
  "there's been a jump in running this week, so let today's miles stay comfortable and save the intensity",
];
// Stacked hard days with nothing pulling the other way — a caveat, never a brake
// of their own. Mirrors volume_spike: the count is named, the day stays open, and
// the athlete is asked to say if that picture changes. Lowercase fragments spliced
// after the planned-training lead.
export const STACKED_DAYS_CAVEAT: readonly string[] = [
  "the days have stacked up, but nothing is pulling the other way, so go, and tell me if that changes",
  "that's a run of hard days, and you're still carrying them well, so go, and say so if it starts to feel off",
  "several training days in a row, with nothing arguing against today, so go, and tell me if that shifts",
  "you've stacked the work, and you're still absorbing it, so go, and let me know if that changes",
];
export const LOW_SLEEP_CAVEAT: readonly string[] = [
  "sleep's been running short lately, so keep the session controlled and stop a rep or two shy",
  "your sleep's been on the short side, so keep the session controlled and leave a couple of reps in the tank",
  "the nights have been short for a while now, so keep today measured and stop shy of failure",
  "sleep hasn't been generous recently, so hold the session steady and finish a rep or two early",
];
// Round W3.4, rule 4: what short sleep actually costs is INJURY EXPOSURE, not the
// session. LOW_SLEEP_CAVEAT above asks for a controlled session, which is the right
// general instinct and stops one step short of the specific one — the coach prompt is
// being told to strip the PR attempts and the plyometric work while the easy volume
// and the technique work stay, and the athlete deserves to be told the same thing
// rather than being handed a session that quietly lost its top set.
//
// So no phrasing here may suggest cutting the session, and none may name a number.
export const SLEEP_EXPOSURE_CAVEAT: readonly string[] = [
  "short sleep is the wrong night to chase a personal best or do much jumping, so keep the session and leave the risky edges out",
  "the session stands, but a short night isn't the time for a max attempt or hard plyometrics, so keep the volume and the technique work instead",
  "keep today as planned and just take the sharp edges off it: no maxing out, nothing explosive, and the rest stays",
  "a night this short mostly costs you on the risky stuff, so skip the max attempts and the jumping and keep everything else",
];
// The pronoun in the first phrasing ("until that settles") points at the sentence
// before it — the brake's own spoken voice, named by action.directives.training_source.
// The middle two name the thing outright, so a short lead still leaves a caveat that
// stands on its own.
export const HOLD_AGGRESSION_CAVEAT: readonly string[] = [
  "hold off on adding load or volume until that settles",
  "leave the load and the volume where they are for now rather than reaching for more",
  "today isn't the day to add load or volume, so keep both where they were last time",
  "hold the load and the volume steady until that eases off",
];
// `directives.schedule === "compress"` has TWO unrelated causes and only one of them
// is about the clock, so it gets TWO caveats (see the split in the rule below). This
// one speaks only for a real dated commitment, where the claim is true and the 60→40
// clamp is earned.
export const COMMITMENT_PRESSURE_CAVEAT: readonly string[] = [
  "a current dated commitment compresses today's training window, so keep the session focused",
  "something on today's calendar squeezes the training window, so keep the session focused",
  "you've got a commitment today that shortens the training window, so keep it tight",
  "today's schedule leaves a narrower window than usual, so plan for a compact session",
];
// ...and this one for the other cause: `context.expect_worse_sleep`, a late night or a
// stressful stretch. There is no commitment and nothing about the clock is squeezed —
// what is thinner is RECOVERY. So it asks for less intensity at full length, never a
// shorter day. Naming a commitment here was a false claim about the athlete's calendar.
export const LIFE_PRESSURE_CAVEAT: readonly string[] = [
  "there's enough going on right now to thin out your recovery, so keep the intensity honest rather than the day short",
  "a stretch like this usually costs you sleep, so hold the intensity where it is and take the session as it comes",
  "what's on at the moment tends to eat into your recovery, so keep today's hardest sets a notch easier",
  "this stretch is thinner on recovery than usual, so ease the intensity rather than the length",
];

// The caveat vocabulary, keyed by its own pickDayVariant rotation key (templated sets
// rendered with a sample subject, exactly as DAY_READ_WHY_VARIANTS does). Separate from
// DAY_READ_WHY_VARIANTS because these are FRAGMENTS: they start lowercase and end
// without punctuation, so the sentence-shape guards on the `why` vocabulary would
// (correctly) reject them. Their own guards live beside those, in test/dayRead.test.js.
export const DAY_READ_CAVEAT_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  "planned_training:recovery_week": RECOVERY_WEEK_CAVEAT,
  "planned_training:injury": INJURY_CAVEAT.map((render) => render("a sore left knee")),
  "planned_training:ease_around": EASE_AROUND_CAVEAT,
  "planned_training:anticipate_deload": ANTICIPATE_DELOAD_CAVEAT,
  "planned_training:volume_spike": VOLUME_SPIKE_CAVEAT,
  "planned_training:fuel_around": FUEL_AROUND_TRAINING_CAVEAT,
  "planned_training:stacked_days": STACKED_DAYS_CAVEAT,
  "planned_training:low_sleep": LOW_SLEEP_CAVEAT,
  "planned_training:sleep_exposure": SLEEP_EXPOSURE_CAVEAT,
  "planned_training:hold_aggression": HOLD_AGGRESSION_CAVEAT,
  "planned_training:commitment_pressure": COMMITMENT_PRESSURE_CAVEAT,
  "planned_training:life_pressure": LIFE_PRESSURE_CAVEAT,
  "planned_training:joint_pain": JOINT_PAIN_CAVEAT.map((render) => render("left knee")),
};

// The one idea each caveat must carry whichever phrasing lands — the same drift guard
// DAY_READ_REQUIRED_CONCEPT applies to the `why` vocabulary.
export const DAY_READ_CAVEAT_CONCEPT: Readonly<Record<string, RegExp>> = {
  "planned_training:recovery_week": /\b(?:recovery week|recovery-week|reduced|lighter)\b/i,
  "planned_training:injury": /\bwork(?:ing)? around\b/i,
  "planned_training:ease_around": /\beas(?:e|ing) around\b/i,
  "planned_training:anticipate_deload": /\brecovery(?:'s)?\b/i,
  "planned_training:volume_spike": /\b(?:running|miles)\b/i,
  "planned_training:fuel_around": /\b(?:fuel|eat|carbs)\b/i,
  // The idea is the RUN OF DAYS itself, so the probe names the ways a variant may say
  // it. A bare /\bdays\b/ would pass on almost any sentence in this file and register
  // nothing.
  "planned_training:stacked_days": /\b(?:stacked (?:up|the work)|run of hard days|training days in a row)\b/i,
  "planned_training:low_sleep": /\b(?:sleep|nights?)\b/i,
  // The exposure caveat must stay about the RISKY ELEMENTS, never about shortening
  // or skipping the day — that disjointness is what keeps rule 4's "downgrade
  // exposure, never cancel" from drifting back into a soft rest read.
  "planned_training:sleep_exposure": /\b(?:max(?:ing)?|personal best|jumping|plyometrics|explosive|edges)\b/i,
  "planned_training:hold_aggression": /\b(?:load|volume)\b/i,
  // The commitment caveat must stay about the CLOCK, and the life-pressure one about
  // RECOVERY. Keeping the two concepts disjoint is what stops the false-commitment
  // claim from creeping back in under a new phrasing.
  "planned_training:commitment_pressure": /\b(?:window|commitment|calendar)\b/i,
  "planned_training:life_pressure": /\b(?:recovery|sleep|thinner|stretch)\b/i,
  "planned_training:joint_pain": /\b(?:work(?:ing)? around|pain-free|comfortable)\b/i,
};

// The rest→easy softening clamp in enforceRecoveryWeekCadence (src/dayread.ts) is a
// server-policy override, not one of the rules above — but it fires inside an APPLIED
// recovery week and can repeat for several consecutive days just like any other rule
// (that's exactly the path most likely to print the same sentence for a week straight),
// so it rotates through the same pickDayVariant mechanism, keyed on the same calendar
// date. Exported so dayread.ts can pick from it directly.
export const RECOVERY_WEEK_SOFTEN_WHY: readonly string[] = [
  "Yesterday carried a real load — keep today easy, without turning the reduced week into another full rest day.",
  "You put in real work yesterday, so ease off today rather than taking the whole day off.",
  "There was a genuine loading day yesterday — today stays light, not another full rest day in this reduced week.",
  "Yesterday's load was real, which is reason enough to keep today easy without stacking a second rest day.",
];

// The server-policy `decision.reason` literals in dayread.ts's policyDecision() calls
// are ALSO athlete-facing — the Brief renders decision.reason whenever it's non-empty
// — and every clamp path below can fire on consecutive days exactly like a rule above,
// so they rotate through the same pickDayVariant mechanism, keyed on their own
// rule_code. Each set stays in the register the original literal established:
// explaining what the server policy did and why, which is DELIBERATELY DIFFERENT
// content from the day's own narrative `why` — most visibly for the recovery-week
// softening clamp, where RECOVERY_WEEK_SOFTEN_REASON explains that a full-rest read
// got dialed back to easy, rather than restating RECOVERY_WEEK_SOFTEN_WHY's "yesterday
// carried load" narrative on the same card.
const COMPLETION_FACT_NOT_LOGGED_REASON: readonly string[] = [
  "No training is logged yet today, so today is still open.",
  "Nothing's been logged for today yet — the day is still ahead of you.",
  "Today doesn't show any training logged yet, so it's still wide open.",
  "There's nothing logged today, which means today hasn't actually happened yet.",
];
const COMPLETION_FACT_PRESERVED_REASON: readonly string[] = [
  "Your logged training already covers today.",
  "What you logged stands — today doesn't get reopened as a fresh suggestion.",
  "The work's already logged, so today isn't turning back into a recommendation.",
  "Today's covered by what you logged; that doesn't need reinterpreting.",
];
const DETERMINISTIC_SAFETY_FLOOR_REASON: readonly string[] = [
  "Your recent training and recovery still point to keeping today lighter.",
  "Everything in your recent training and recovery still argues for a lighter day.",
  "The picture from recent training and recovery hasn't changed — today stays lighter.",
  "Recent training and recovery both still say lighter, not harder.",
];
const RECOVERY_WEEK_REDUCED_TRAIN_REASON: readonly string[] = [
  "Yesterday was already easy, so today goes back to the planned lighter session.",
  "There wasn't a loading day yesterday to ease off from, so today returns to the planned session.",
  "Yesterday didn't carry real load, which means today's planned lighter session stands.",
  "With nothing heavy yesterday, today goes back to what the reduced week already had planned.",
];
const RECOVERY_WEEK_SOFTEN_REASON: readonly string[] = [
  "A full rest day here would go further than this reduced week calls for, so it softened to easy instead.",
  "Full rest got dialed back to easy — the reduced week already answers a loaded day like yesterday.",
  "This stayed at easy rather than a full stop, since the recovery week is already the answer to yesterday's load.",
  "The suggested rest eased to a lighter day instead, in line with how this reduced week already handles load.",
];

// The agent's own conservative adjustment is the fifth athlete-facing `decision.reason`
// and the only one the rotation missed. It is written in computeDayRead rather than by
// a policyDecision() clamp — `basis` there is "agent", not "server_policy" — but it is
// rendered by exactly the same Brief line (todayBriefDecisiveReason, on rest/easy days,
// which is the only shape `conservative` can take), and it fires every day an agent
// steps a planned session down. So it lives in the same map and rotates on the same
// terms; only the reason LOOKUP is shared with policyDecision, never the basis.
const AGENT_CONSERVATIVE_ADJUSTMENT_REASON: readonly string[] = [
  "Your coach eased today back from the planned session.",
  "Today came back a notch from what the plan had down.",
  "Your coach dialled today down from the session that was scheduled.",
  "The planned session got softened a little for today.",
];

// Keyed by rule_code (the SAME string dayread.ts passes as both the ledger code and
// the pickDayVariant key), mirroring DAY_READ_WHY_VARIANTS so the two vocabularies —
// the day's `why` and the server policy's `reason` — are tested the same way.
export const DAY_READ_POLICY_REASON_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  completion_fact_not_logged: COMPLETION_FACT_NOT_LOGGED_REASON,
  completion_fact_preserved: COMPLETION_FACT_PRESERVED_REASON,
  deterministic_safety_floor: DETERMINISTIC_SAFETY_FLOOR_REASON,
  recovery_week_reduced_train_after_non_loading_day: RECOVERY_WEEK_REDUCED_TRAIN_REASON,
  recovery_week_rest_softened_to_easy_after_loading_day: RECOVERY_WEEK_SOFTEN_REASON,
  agent_conservative_adjustment: AGENT_CONSERVATIVE_ADJUSTMENT_REASON,
};

// The ONE lookup for a rendered `decision.reason`. Every writer of that field goes
// through here so the map cannot acquire a second, differently-rotated reader (it
// already had one: the agent branch in computeDayRead hand-wrote its literal).
// An unregistered code yields "" — the Brief renders a reason only when there is a
// specific one, and narrating Cairn's internals is worse than saying nothing.
export function dayReadPolicyReason(ruleCode: string, date: string): string {
  const variants = DAY_READ_POLICY_REASON_VARIANTS[ruleCode];
  return variants?.length ? pickDayVariant(variants, date, ruleCode) : "";
}

// ---------- the Brief's headline ----------
// The most prominent string on the whole Brief (`<h2 class="brief-headline">`), and
// the last one still printed as an unrotated literal — one fixed sentence per kind,
// implemented THREE times (a `deterministicHeadline` in dayread.ts, a byte-identical
// `dayReadHeadline` in the day-read use case, and a hardcoded "Take it easy." inside
// the recovery-week softening clamp, directly above the `why` that was fixed for
// exactly this reason). Everything beneath it rotated this round; it did not. On this
// athlete's real history roughly half of mornings open on `rest`, so "Rest today." was
// the sentence they read verbatim, indefinitely.
//
// One implementation now, rotated by calendar day like the rest of the vocabulary.
// DATE-KEYED, never random: todayBriefMateriallyDiffers compares `headline` to decide
// whether to repaint, and the clamp paths rewrite it on every call, so a
// non-deterministic pick would repaint the Brief on every poll.
export const DAY_READ_HEADLINE_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  done: ["You're done for today.", "Today's work is in.", "That's today's training done.", "Today's already covered."],
  rest: ["Rest today.", "Today's a rest day.", "Today is for resting.", "A rest day today."],
  easy: ["Take it easy.", "Keep today easy.", "An easy day today.", "Easy does it today."],
  train: ["Good to train.", "Good day to train.", "You're clear to train.", "Today's a training day."],
};

// A train day that knows its focus makes the FOCUS the headline ("Lower body."), so
// the rotation moves the frame around it instead of replacing it — the plain form
// stays first, and every phrasing still names the focus.
const TRAIN_FOCUS_HEADLINE: ReadonlyArray<(focus: string) => string> = [
  (focus) => `${focus}.`,
  (focus) => `${focus} today.`,
  (focus) => `${focus} is on today.`,
];

// The BACKED train day's headline sets — its own rather than a fifth `kind` entry in
// DAY_READ_HEADLINE_VARIANTS above, because the read's kind really is `train` (the
// safety ladder in enforceDayReadSafetyPosture ranks rest < easy < train and knows
// nothing else) and every consumer that maps a kind to a headline set must keep
// resolving to the same four. The push is a FLAVOUR of train, not a fifth posture.
const TRAIN_PUSH_HEADLINE: readonly string[] = [
  "Good day to go after it.",
  "Today's one to push.",
  "A day to train and reach a little.",
  "Good day to ask more of yourself.",
];
const TRAIN_PUSH_FOCUS_HEADLINE: ReadonlyArray<(focus: string) => string> = [
  (focus) => `${focus} — go after it.`,
  (focus) => `${focus}, and a good day to push.`,
  (focus) => `${focus} today. Reach a little.`,
];

// The drive read's own headline sets, on the same terms as the backed day's above: the
// kind really is `train`, and this is a third FLAVOUR of it rather than a fifth posture.
// It has to read differently from the push sets, because it means something different —
// the backed day offers MORE, this one offers a NARROWER day in place of a rest — so a
// phrasing that says "go after it" would misdescribe the very restraint the rule is
// built around.
const TRAIN_DRIVE_HEADLINE: readonly string[] = [
  "Train what's due today.",
  "A targeted day, not a day off.",
  "Keep today narrow and useful.",
  "Today's for the work that's due.",
];
const TRAIN_DRIVE_FOCUS_HEADLINE: ReadonlyArray<(focus: string) => string> = [
  (focus) => `${focus} — what's due today.`,
  (focus) => `${focus}, and keep it targeted.`,
  (focus) => `${focus} today, and nothing on top.`,
];

// The one headline a read gets on a given day. Every writer of the field goes through
// here (dayread.ts's clamps and agent fallback, and the use case's factual replace).
//
// `signals.push_bias` is read rather than a fifth kind for the reason above: a caller
// that passes only `{kind, focus}` (every clamp, and the agent fallback for a read the
// agent itself downgraded) is asking the plain question and gets the plain answer.
export function dayReadHeadline(
  read: { kind?: unknown; focus?: unknown; signals?: Record<string, any> | null },
  date: string
): string {
  const kind = String(read?.kind ?? "");
  const focus = typeof read?.focus === "string" ? read.focus.trim() : "";
  const push = kind === "train" && !!read?.signals?.push_bias;
  // The drive read is checked FIRST because the two flags can co-occur (a backed day
  // is one of the two ways the drive gate can be satisfied), and when they do, the
  // narrower sentence is the honest one: this day exists in place of a rest.
  const drive = kind === "train" && !!read?.signals?.training_drive_push;
  if (kind === "train" && focus) {
    return drive
      ? pickDayVariant(TRAIN_DRIVE_FOCUS_HEADLINE, date, "headline:train_focus_drive")(focus)
      : push
        ? pickDayVariant(TRAIN_PUSH_FOCUS_HEADLINE, date, "headline:train_focus_push")(focus)
        : pickDayVariant(TRAIN_FOCUS_HEADLINE, date, "headline:train_focus")(focus);
  }
  if (drive) return pickDayVariant(TRAIN_DRIVE_HEADLINE, date, "headline:train_drive");
  if (push) return pickDayVariant(TRAIN_PUSH_HEADLINE, date, "headline:train_push");
  const variants = DAY_READ_HEADLINE_VARIANTS[kind] ?? DAY_READ_HEADLINE_VARIANTS.train;
  return pickDayVariant(variants, date, `headline:${kind || "train"}`);
}

// The idea each headline must carry whichever phrasing lands, exactly as
// DAY_READ_REQUIRED_CONCEPT does for the `why` vocabulary. (The focus form declares
// none: its required content is the focus itself, which the guard asserts directly.)
export const DAY_READ_HEADLINE_CONCEPT: Readonly<Record<string, RegExp>> = {
  done: /\b(?:done|in|covered)\b/i,
  rest: /\brest(?:ing)?\b/i,
  easy: /\beasy\b/i,
  train: /\btrain(?:ing)?\b/i,
};

// The focus form, rendered with a sample focus — registered so the shape and
// constitution guards cover it alongside the fixed sets.
export const DAY_READ_FOCUS_HEADLINE_VARIANTS: readonly string[] = TRAIN_FOCUS_HEADLINE.map((render) =>
  render("Lower body")
);

// The backed train day's two headline forms, registered on the same terms: a phrasing
// the athlete can read has to be enumerable and held to the constitution, whichever
// branch of dayReadHeadline reaches it.
export const DAY_READ_PUSH_HEADLINE_VARIANTS: readonly string[] = TRAIN_PUSH_HEADLINE;
export const DAY_READ_PUSH_FOCUS_HEADLINE_VARIANTS: readonly string[] = TRAIN_PUSH_FOCUS_HEADLINE.map((render) =>
  render("Lower body")
);

// The drive read's two headline forms, registered for the same guards.
export const DAY_READ_DRIVE_HEADLINE_VARIANTS: readonly string[] = TRAIN_DRIVE_HEADLINE;
export const DAY_READ_DRIVE_FOCUS_HEADLINE_VARIANTS: readonly string[] = TRAIN_DRIVE_FOCUS_HEADLINE.map((render) =>
  render("Lower body")
);

// `applyContinuityVoice` asks for the ordinal of TODAY (`quiet_streak + 1`), and
// `dayReadContinuity` walks `recentDayReads(date, 7)` — so the streak reaches 7 and
// this is called with 8, one past where the table used to end. It fell through to
// "another" and printed "That's your another quiet day in a row." The table now
// covers the whole reachable range, and the fallback is a word that reads correctly
// in EVERY template below ("your latest quiet day", "Latest quiet day running",
// "this is the latest", "the latest quiet day") — so widening the continuity window
// degrades readably instead of breaking the sentence again.
const QUIET_ORDINALS = ["", "", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];
export function quietOrdinal(n: number): string {
  return QUIET_ORDINALS[n] || "latest";
}

// A long quiet stretch must not keep re-asserting itself. Past roughly two, the
// read stops repeating its own logic and offers the smallest thing worth doing —
// still a suggestion, never a gate, never a nag, never a score.
export const QUIET_STREAK_WHY: ReadonlyArray<(ordinal: string) => string> = [
  (o) =>
    `That's your ${o} quiet day in a row. Nothing here is pushing you to train — but if you want the smallest thing worth doing, ten easy minutes on your feet is plenty.`,
  (o) =>
    `${o.charAt(0).toUpperCase() + o.slice(1)} quiet day running. Staying rested is completely fine; so is a short walk or five minutes of easy mobility if you'd rather do something.`,
  (o) =>
    `You've had a few quiet days now — this is the ${o}. No pressure either way, though a gentle walk today would do more for you than another full stop.`,
  (o) =>
    `This makes the ${o} quiet day. If the rest still feels right, take it. If you're getting restless, something small and easy is the place to start.`,
];

// The same escalation for a day carrying a movement work-around. Three of the four
// phrasings above offer the smallest thing worth doing as time on your feet — and
// on an injury day that sentence lands AFTER the caveat warning them off exactly
// that, so the read's last and most memorable words contradicted its own guardrail
// (on some days only, since the variant is date-keyed). These carry the same idea —
// the rest is fine, and you are not obliged to do nothing — without naming a
// weight-bearing option, and rotate the same way, so pinning the guarded day to one
// phrasing never reintroduces the daily repetition this whole layer exists to fix.
export const QUIET_STREAK_GUARDED_WHY: ReadonlyArray<(ordinal: string) => string> = [
  (o) =>
    `That's your ${o} quiet day in a row. Nothing here is pushing you to train, and while there's something to work around, resting is a perfectly good answer.`,
  (o) =>
    `${o.charAt(0).toUpperCase() + o.slice(1)} quiet day running. Staying rested is completely fine; if you do want to do something, keep it comfortable and stop short of anything that nags.`,
  (o) =>
    `You've had a few quiet days now — this is the ${o}. There's no pressure to break the run while something still needs working around.`,
  (o) =>
    `This makes the ${o} quiet day. If the rest still feels right, take it; if you're getting restless, stay well inside what feels good today.`,
];

// Honest thin-data degradation: when nothing has actually moved, say so plainly
// instead of re-deriving the same sentence as though it were news.
export const NOTHING_MOVED_CLAUSES: readonly string[] = [
  "Nothing's really moved since yesterday.",
  "That's unchanged from yesterday.",
  "Same picture as yesterday, honestly.",
  "Nothing new has come in since yesterday's read.",
];

// The whole athlete-facing vocabulary of the deterministic floor, keyed by rule
// code (templated variants rendered with a sample argument). Exported so a caller
// — and the tests — can reason about what a rule MAY say rather than pinning one
// literal, and so a new variant that breaks the constitution is catchable in one
// place. `quiet_streak` is the escalation voice, which belongs to no single rule;
// `quiet_streak_guarded` is that same voice on a day with something to work around.
// The unified signal state's athlete voice, folded into the SAME registry under the
// rule whose `why` it becomes (`acute_signal_protection`, one entry per signal). That
// path — the dominant rest/easy path — used to assign the machine-facing evidence
// `summary` straight to the Brief's headline, so it reached the athlete without
// passing a single one of the constitution guards below. Now every phrasing it can
// speak is enumerable and tested here beside the rest of the Brief's vocabulary.
const SIGNAL_VOICE_WHY: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(SIGNAL_VOICE_REGISTRY).map(([key, entry]) => [`acute_signal_protection:${key}`, entry.variants])
);
const SIGNAL_VOICE_CONCEPTS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(SIGNAL_VOICE_REGISTRY).map(([key, entry]) => [`acute_signal_protection:${key}`, entry.concept])
);

// The programmed rest day speaks in the athlete's own terms: the day is theirs, and
// what is offered is movement rather than nothing at all. Several phrasings because
// this rule fires on the SAME weekday every week — one literal would print the same
// sentence every Sunday morning for as long as the template stands.
export const TEMPLATE_REST_DAY_WHY: readonly string[] = [
  "Your week has a rest day here, so today is yours — a walk or some easy mobility if you feel like moving.",
  "Today is the rest day in your template. Nothing is owed; a gentle walk or some mobility is plenty.",
  "The plan keeps today clear for recovery, so this is a rest day — move easily if you want to, or not at all.",
  "This is the rest day your week is built around. Some easy mobility or a walk fits it well.",
  "Your template puts rest here, so today is open — an easy walk is the whole ask, and even that is optional.",
];

export const DAY_READ_WHY_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  template_rest_day: TEMPLATE_REST_DAY_WHY,
  logged_loading_work_today: DONE_WHY.map((render) => render("session")),
  acute_sleep_corroborated: ACUTE_SLEEP_WHY,
  recovery_dose_overrun: DOSE_OVERRUN_WHY,
  accumulated_load_rest: [...STACKED_LOAD_WHY, ...STACKED_LOAD_CEILING_WHY],
  push_drive_targeted_training: PUSH_DRIVE_WHY.map((render) => render("quads and back")),
  lookahead_retimed_training: LOOKAHEAD_RETIME_WHY,
  day_claimed_rest: DAY_CLAIMED_WHY,
  day_traded_rest: DAY_TRADED_WHY,
  lab_draw_morning: LAB_DRAW_WHY,
  low_readiness_rest: LOW_READINESS_WHY,
  rest_grade_readiness: REST_GRADE_READINESS_WHY,
  felt_run_down_rest: RUN_DOWN_WHY,
  logged_light_work_today: LIGHT_WORK_WHY,
  endurance_volume_spike: VOLUME_SPIKE_WHY,
  chronic_sleep_watch: CHRONIC_SLEEP_WHY,
  outcome_feedback_soften: OUTCOME_FEEDBACK_SOFTEN_WHY,
  outcome_feedback_open: OUTCOME_FEEDBACK_OPEN_WHY,
  learned_train_anyway: LEARNED_TRAIN_WHY,
  // Not rule codes — SENTENCES appended to whichever rule kept the day, exactly as the
  // signal-voice keys below are not rule codes either. Registered here so the
  // constitution guards (grammar, several phrasings, a declared meaning) hold over both
  // arms like every other athlete-facing string.
  outcome_feedback_held: OUTCOME_FEEDBACK_HELD_WHY,
  outcome_feedback_held_symptom: OUTCOME_FEEDBACK_HELD_SYMPTOM_WHY,
  unprogrammed_easy_day: UNPROGRAMMED_WHY,
  planned_training: TRAIN_CLEAR_WHY,
  // The backed train day. It keeps the `planned_training` LEDGER code — the decision
  // is the same one, and a second code would split the adherence history of the most
  // common read in two — and carries its own registered vocabulary, keyed off
  // `signals.push_bias` rather than off the rule that produced it.
  planned_training_push: TRAIN_PUSH_WHY,
  // `planned_reduced_training` has no `why` set of its own on purpose: a recovery-week
  // train day composes its sentence from the registered lead + the registered
  // `planned_training:recovery_week` caveat (see the retired RECOVERY_WEEK_TRAIN_WHY
  // note above), so its words are covered by DAY_READ_LEAD_VARIANTS and
  // DAY_READ_CAVEAT_VARIANTS. Its ledger `reasons` still live on the outcome.
  quiet_streak: QUIET_STREAK_WHY.map((render) => render("third")),
  quiet_streak_guarded: QUIET_STREAK_GUARDED_WHY.map((render) => render("third")),
  // The floor this rule falls back to when the winning evidence carries no voice.
  acute_signal_protection: SIGNAL_VOICE_REGISTRY.unvoiced_protect.variants,
  ...SIGNAL_VOICE_WHY,
};

// The one idea each rule's words MUST carry, whichever phrasing lands on the day.
// The old single-literal cases pinned this by accident — a test asserting
// /last night was short/ was really asserting "this read talks about sleep" — and
// that guarantee would have quietly evaporated the moment one sentence became
// several. It is explicit now, and it lives HERE, beside the prose, so a new
// variant cannot drift away from the meaning the rule exists to convey. Applies to
// BOTH registers: the athlete-facing `why` and the ledger `reason`.
export const DAY_READ_REQUIRED_CONCEPT: Readonly<Record<string, RegExp>> = {
  // The one fact this read exists to carry: the REST is the athlete's own week
  // talking, not a brake. A phrasing that stops naming the plan/week/template would
  // read as an unexplained quiet day, which is exactly the sentence a first-class
  // rest day was built to stop producing.
  template_rest_day: /\b(?:plan|week|template)\b/i,
  logged_loading_work_today: /\b(?:in today|done|books|covered|logged)\b/i,
  acute_sleep_corroborated: /\b(?:sleep|night|nights)\b/i,
  acute_signal_protection: /\b(?:protect|protecting|protection|recovery|guarding)\b/i,
  recovery_dose_overrun: /\byesterday\b/i,
  accumulated_load_rest: /\b(?:trained|training|loading|stacked|hard days)\b/i,
  // The one word this rule may never lose. It offers TRAINING on a day the floor would
  // otherwise have rested, and the only thing that earns that is work genuinely being
  // owed — a phrasing that drops "due" would be offering the session on the strength of
  // the preference alone, which is exactly what the gate below refuses to do.
  push_drive_targeted_training: /\bdue\b/i,
  // The one word this read may never lose. Every other rule explains itself from
  // today's evidence; this one's entire basis is the NEXT day, and a phrasing that
  // stops naming it is an unexplained training day inside a run of loading days.
  lookahead_retimed_training: /\btomorrow\b/i,
  // The athlete's word is this rule's entire basis, so every phrasing has to say the
  // day is theirs and already given: a sentence that drops "claimed / taken / spoken
  // for" is an unexplained rest.
  day_claimed_rest: /\b(?:claimed|taken|spoken for)\b/i,
  // The trade is the whole basis of this read, so every phrasing has to say the rest
  // was MOVED here by the athlete — a sentence that drops it is an unexplained rest.
  day_traded_rest: /\b(?:traded|trade|moved|swapped)\b/i,
  // The one fact this read exists to carry is the draw itself — a phrasing that stops
  // naming it is an unexplained easy day, and the sequencing advice goes with it.
  lab_draw_morning: /\b(?:draw|labs?|blood)\b/i,
  low_readiness_rest: /\b(?:readiness|reading)\b/i,
  // Same one word as its shallower sibling, for the same reason: the reading IS the
  // argument, and a phrasing that stops naming it is an unexplained rest day.
  rest_grade_readiness: /\b(?:readiness|reading)\b/i,
  felt_run_down_rest: /\b(?:run-down|low)\b/i,
  logged_light_work_today: /\b(?:moved|movement|board)\b/i,
  endurance_volume_spike: /\b(?:running|run|mileage)\b/i,
  chronic_sleep_watch: /\bsleep\b/i,
  // Both halves, not one. This rule's whole claim is "you trained through reads like
  // this AND it went well" — a phrasing that keeps the history and drops how it turned
  // out would soften the day without saying what earned it, which is the one thing an
  // outcome-driven rule may never do.
  outcome_feedback_soften: /\b(?:trained|training)\b(?=[\s\S]*\b(?:well|held up|working|fine)\b)/i,
  // Same two-part guard as its sibling above, for the same reason: this rule OPENS a
  // day the floor wanted quiet, and the only thing that earns that is the athlete's
  // own recent mornings AND how they turned out. A phrasing that keeps the history and
  // drops the outcome would be opening the day on a hunch.
  outcome_feedback_open: /\b(?:sessions?|training|work)\b(?=[\s\S]*\b(?:well|held up|landing|fine)\b)/i,
  // Three parts: the history, how it turned out, AND the caveat. A phrasing that opens
  // the day without saying what still stands is the long loop overruling a signal it
  // was only allowed to outweigh.
  learned_train_anyway:
    /\b(?:trained|training)\b(?=[\s\S]*\b(?:fine|well|held up)\b)(?=[\s\S]*\b(?:caveat|ease off|back off)\b)/i,
  // The whole point of these sentences is WHOSE word held the day. A phrasing that stops
  // crediting the athlete's own account is an unexplained refusal to move. The symptom
  // arm additionally may not claim a check-in, which its own case pins.
  outcome_feedback_held: /\b(?:you said|you told|your own|you(?:'ve)? put)\b/i,
  outcome_feedback_held_symptom: /\b(?:you said|you told|your own|you(?:'ve)? put)\b/i,
  planned_reduced_training: /\b(?:reduced|light|lighter)\b/i,
  planned_training: /\b(?:due|train|session)\b/i,
  // A push read that forgets to offer the reach is just a clear day with extra words.
  planned_training_push: /\b(?:more|reach(?:ing)?|push(?:ing)?)\b/i,
  unprogrammed_easy_day: /\b(?:nothing|no session|open)\b/i,
  quiet_streak: /\bquiet days?\b/i,
  quiet_streak_guarded: /\bquiet days?\b/i,
  // Each signal voice declares its own required idea in signal-state.ts, beside the
  // phrasings — a soreness read must still be about soreness on the day a different
  // wording lands.
  ...SIGNAL_VOICE_CONCEPTS,
};

// One quiet purpose line tying a planned day to the block/goal it serves —
// GROUNDED only: a lift/mixed day speaks to the strength mesocycle's phase, a
// run day speaks to the active race/endurance goal, and either is entirely
// absent (not a fallback literal) when the program state can't ground it. Each
// phase gets its own small variant set so a phase that lasts for weeks doesn't
// print the identical sentence every day.
const WEEK_AHEAD_MESO_NOTE: Partial<Record<NonNullable<MesoPhase>, readonly string[]>> = {
  accumulation: [
    "part of the block's base-building work",
    "building volume for the block ahead",
    "laying down the block's foundation",
  ],
  intensification: [
    "the block's sharpening work",
    "pushing toward the block's peak",
    "intensifying toward the block's target",
  ],
  "deload-due": [
    "easing the load — the block's recovery stretch is close",
    "lighter work while the block nears its reset",
  ],
  deload: [
    "easing the load — the block's recovery stretch",
    "lighter work while the block resets",
    "recovery work for the block",
  ],
};

const WEEK_AHEAD_RACE_NOTE: Record<"base" | "build" | "sharpen" | "taper", readonly string[]> = {
  base: [
    "building the aerobic base for {goal}",
    "base miles toward {goal}",
    "laying down the base ahead of {goal}",
  ],
  build: ["building toward {goal}", "part of the build for {goal}", "adding toward {goal}"],
  sharpen: ["sharpening toward {goal}", "quality work ahead of {goal}", "sharpening work for {goal}"],
  taper: ["taper work ahead of {goal}", "easing in before {goal}", "holding fitness into {goal}"],
};

export function weekAheadDayNote(kind: WeekAheadDay["kind"], date: string, meso: MesocycleState | null, goal: ReturnType<typeof getEnduranceGoal>): string | null {
  if (kind === "rest") return null;
  if (kind === "run") {
    if (!goal) return null;
    const phase = goal.phase;
    if (phase !== "base" && phase !== "build" && phase !== "sharpen" && phase !== "taper") return null;
    const label = (goal.is_race ? goal.event : goal.label) || null;
    if (!label) return null;
    const variants = WEEK_AHEAD_RACE_NOTE[phase];
    return pickDayVariant(variants, date, `weekahead-note:run:${phase}`).replace("{goal}", label);
  }
  // lift or mixed
  const phase = meso?.phase;
  if (!phase) return null;
  const variants = WEEK_AHEAD_MESO_NOTE[phase];
  if (!variants) return null;
  return pickDayVariant(variants, date, `weekahead-note:lift:${phase}`);
}

// The week-ahead card's own quiet race line — context, not a countdown. A dated
// race an athlete never sees mentioned on Today reads as the coach not knowing
// about it; this is the one place that names it. Terse label-style line, so no
// pickDayVariant rotation (that's for full sentences). null on no race goal, an
// unusable date, or a race that has already happened.
//
// Spoken words for the machine phase key, matching the race-build card's own
// phaseLabel (src/client/progress-run-plan-client.ts) so the vocabulary is one
// contract across the two surfaces — never the raw "build"/"sharpen" key, which
// is engineering vocabulary the athlete never wrote.
const WEEK_AHEAD_RACE_PHASE_WORD: Record<"base" | "build" | "sharpen" | "taper", string> = {
  base: "base",
  build: "building",
  sharpen: "sharpening",
  taper: "tapering",
};

export function weekAheadRaceLine(
  goal: ReturnType<typeof getEnduranceGoal>,
  asOf: string
): {
  label: string;
  date: string;
  weeks_to_race: number;
  days_to_race: number;
  phase: "base" | "build" | "sharpen" | "taper";
  text: string;
} | null {
  if (!goal || !goal.is_race || !goal.date) return null;
  const phase = goal.phase;
  if (phase == null || phase === "past") return null;
  const days = goal.days_to_race;
  if (!Number.isFinite(days as number)) return null;
  const label = goal.event || "Race";
  // CALENDAR week count, matching the Plan ladder (raceBuild's projectRaceBuildWeeks,
  // src/repo/race-build.ts) rather than getEnduranceGoal's ceil(days/7): the week
  // that holds race day is race week whatever weekday the start line falls on, so a
  // race on Saturday read on the Tuesday before is "race week" on BOTH surfaces, not
  // "1 week out" here and "race week" there.
  const weeks = Math.round((Date.parse(`${mondayOf(goal.date)}T00:00:00Z`) - Date.parse(`${mondayOf(asOf)}T00:00:00Z`)) / (7 * 864e5));
  const isRaceWeek = weeks <= 0;
  const weeksWord = weeks === 1 ? "week" : "weeks";
  const text = isRaceWeek
    ? `${label} · race week`
    : `${label} · ${weeks} ${weeksWord} out · ${WEEK_AHEAD_RACE_PHASE_WORD[phase]}`;
  return {
    label,
    date: goal.date as string,
    weeks_to_race: weeks,
    days_to_race: days as number,
    phase,
    text,
  };
}

// ---------- one wording per morning ----------
// The read's PROSE IDENTITY: the deterministic call the sentence was written for.
// Two recomputes landing on the same (date, kind, rule_code, focus) are the same call
// about the same day, so they must read the same — see the pin in computeDayRead
// (src/dayread.ts). Always computed from the DETERMINISTIC BASELINE, never from an
// agent row's own decision (whose rule_code is always `agent_day_read`), and persisted
// beside the row so a later recompute can compare against the call the cached prose
// actually answered.
export function dayReadProseIdentity(
  date: string,
  read: { kind?: unknown; focus?: unknown; decision?: { rule_code?: unknown } | null } | null | undefined
): string {
  const kind = String(read?.kind ?? "").trim();
  const rule = String(read?.decision?.rule_code ?? "").trim();
  const focus = typeof read?.focus === "string" ? read.focus.trim().toLowerCase() : "";
  return `${date}|${kind}|${rule}|${focus}`;
}

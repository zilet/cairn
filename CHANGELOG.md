# Changelog

All notable changes to Cairn are documented here. The project follows [Semantic
Versioning](https://semver.org/) for tagged releases.

## [Unreleased]

### Added

- **An optional how-to layer behind every exercise** — a pulled-in step-by-step guide, primary
  and secondary muscles, equipment and two demonstration photos, tucked behind a quiet "How to"
  row in the exercise detail view. Nothing is fetched until you ask for it from Settings, and a
  movement it can't confidently match asks you a single yes/no instead of guessing.
- **The Brief looks one day ahead** — a trip, event, or appointment on the calendar for tomorrow
  can now gently re-time an already-planned rest day into an easy session, so today doesn't lose
  ground to a rest that was only ever going to move by a day anyway. A rest called for your own
  safety is never touched by this.

### Changed

- **Progress is judged lift by lift, not day by day** — a confounder on one exercise (a skipped
  accessory, a shared training day) no longer keeps every other lift that day from counting
  toward progression. A day pushed at your own request can now earn real progress under a "push"
  training preference, while every safety check still applies exactly as before.
- **A day you opened on purpose stays open** — returning to the app no longer silently drops you
  back on yesterday's Brief after you deliberately looked at a different day.
- **A session's adjustments are explained once, calmly** — instead of repeating the same
  explanation on every affected exercise, an adapted session now says why just once, in a
  quieter tone.

### Fixed

- **Art generation recovers on its own** — a failing image model now backs off and retries
  automatically instead of needing a restart, and Settings shows a calm status line when
  something needs attention.

## [1.7.3] — 2026-08-17

The theme of this patch is a coach whose evidence discipline matches its confidence. Under lead
mode it now gives you a heads-up with a one-tap undo instead of asking permission for changes it
can safely own — and in exchange it holds itself to a harder standard of proof: a protective
calorie raise can never outrun measured maintenance, a half-logged day is treated as absent
rather than "low", a queued change is re-checked against the evidence in force on the morning it
applies, and a target you set yourself outranks anything the machine had queued.

### Added

- **The coach gives a heads-up instead of asking** — under lead mode, goal-date and structural
  plan changes are announced with a one-tap undo instead of parking behind a question
  (VISION Amendment 3). Clinical findings, locked exercises, and irreversible changes still ask.
  A change that misses the week's change budget is delayed to the next natural boundary, not
  dropped.
- **The cut is grounded in the log** — the calorie target during a cut derives from a safe
  pace band (0.5–0.75% of bodyweight per week) and a bounded deficit against maintenance
  measured from your own logged reality. When the numbers say the date, the *date* moves —
  the calories stop inflating to defend an optimistic deadline.
- **Your own number outranks the queue** — you can set your calorie target directly
  (`POST /api/nutrition/target`, MCP `set_nutrition_target`); any queued machine adjustment is
  set aside with a receipt saying exactly that.
- **The coach asks for the measurement it's missing** — when a decision is steering on a stale
  weigh-in or waist measurement, a quiet request appears: one card at a time, a few asks, then
  it lets go instead of nagging.
- **The week ahead answers instantly** — the week-ahead read is served from a cache warmed in
  the background, never composed inline while you wait.

### Changed

- **Protection buys maintenance, never a surplus** — a protective fuel raise (heavy endurance
  load during a cut) is capped at measured maintenance, and only when maintenance really is
  measured from complete logged days; a formula estimate can hold the target but never raise it.
- **An unlogged day is not a small one** — logged intake counts as evidence only when the day
  reads complete: a morning-to-evening span carrying real calories, or a whole day declared at
  once. A partial or missing day is absent, never "low" — so thin logging can no longer read as
  under-eating, and "you're behind on fuel" nudges are withheld when the log can't support them.
  The system recognizes your logging mode — full, occasional, or quiet — and adjusts what it
  treats as evidence accordingly.
- **A pending change is judged against the day it applies** — a queued nutrition change is
  re-derived at its boundary before applying; if the evidence in force that morning no longer
  supports the number, it is trimmed or set aside with a receipt instead of applied on faith.
- **The brake needs a second opinion** — a single watch-state dimension no longer holds back a
  training day by itself, and an HRV dip registers on a meaningful band of your baseline rather
  than a bare sign flip. Safety vetoes are untouched.
- **A goal date is not renegotiated weekly** — the goal date adapts only when the projection is
  materially past it (two weeks or more) and never twice inside a cooldown window.

### Fixed

- **A parked change is not a reading** — a change parked by the change budget stays parked until
  its turn instead of being quietly reclassified and observed away.
- **Draft proposals with future evidence dates no longer jam adoption** — provenance dates are
  clamped at write time, quarantined per row at read time, and a repair migration heals existing
  poisoned drafts.
- **An outranked measurement request keeps its place** — a higher-priority ask no longer resets
  the patience ladder of the requests waiting behind it.

### Notes

- Schema migration 92 runs automatically on boot (repairs draft rows carrying future evidence
  dates). Back up before deploying, as always.
- No changes under `public/`; installed PWAs need no update and the service worker version is
  unchanged.
- Bundled agent CLI pins bumped: Claude Code 2.1.233, Codex 0.147.0; the Grok installer checksum
  re-pinned.

## [1.7.2] — 2026-08-06

The theme of this patch is a coach that runs on *your* numbers. Heart-rate zones now come from your
own logged runs instead of a population formula, a race goal becomes a steady pull that only green
weeks follow, the strength block's phase enters the progression math, and the training week is read
as the repeating ring it actually is — so the planner stops creating the collisions its own reader
then flags. Around that core, another round of honesty: a day is judged against the calorie bar that
was in force that day, an explanation buys time instead of permanent silence, and a correction never
eats a receipt.

### Added

- **Your zones, from your runs** — a personal heart-rate model is derived nightly from your logged
  runs (field test, then sustained-effort estimate, then a ceiling fallback), and every surface that
  speaks a zone resolves through it, with the population formula only as a last resort. A
  calibration ladder tracks when your threshold, easy pace, and lift estimates were last anchored to
  real evidence — and quietly suggests a test only when a stale number is steering a live decision.
- **The race pulls** — a race goal becomes a constrained trajectory whose pull rides the top of the
  safe band on green weeks only, yields during strength peak weeks, and the countdown anchors to the
  plan week (a finished race goes quiet the next morning).
- **The block's phase enters the math** — accumulation banks rep saturation at half-pace steps,
  intensification lets a strong top set earn the step, and a realization week prescribes a genuine
  heavy single whose logged result anchors the calibration ladder.
- **A hard day earns its fuel** — each day is classified light/standard/big from the run intentions
  and heavy-lower days; a big day earns one quiet carb-bias line (today only, never retrospective),
  and the weekly meal plan is drafted against the week's demand map.
- **The week reads its own shape** — the layout read flags a recovery day sitting adjacent to the
  long or quality run and three-hard-days-in-a-row stacks, and hands the evolution prompt a verified
  suggested move. The quality-slot placement ladder searches the whole ring — no layout places
  quality work on a leg day when a legal alternative exists.
- **Easy runs are held to your own easy** — the last fourteen days of runs are read through your
  personal bands; hard work everywhere with easy work nowhere becomes a gentle caution quoting your
  own ceiling in bpm — counsel, never a gate. An insufficient or implausible model stays silent.
- **The blank page gets a week** — a brand-new plan offers "Shape my first week": an agentic
  first-week composer running through the same propose→apply autonomy gate as everything else, with
  an optional one-line instruction ("I can only train 3 days…") carried end to end.
- **Chat can write a run** — one run per turn, through the same writer the weekly tick uses,
  merge-not-replace, personal-model zone tags, refusals over guesses — and every readback is
  composed from a re-read of the store, never from the model's memory.
- **A combined stress budget** — the run planner reads the strength-sourced share of leg fatigue
  decayed forward to the long-run day, and the two engines stop spiking the same week.
- **Sign-in fits the screen** — the agent-login terminal spawns at the browser's fitted size instead
  of a fixed 80×24 that folded OAuth screens out of view, and any sign-in URL the CLI prints
  surfaces as tap-friendly Open / Copy buttons.

### Changed

- **A regression during underfueling holds** — instead of cutting load, it holds with the fueling
  story; repeated deloads escalate into a rep-scheme wave with a settle bound. Movement risk demotes
  pain-flagged swaps, and Epley noise on a thin estimate can no longer earn a deload by itself.
- **The week is a ring** — collision detection, hard-stack scanning, clearing-slot legality and
  day-after checks all read Mon–Sun as cyclic (a Fri→Mon stretch is one stack), so week-boundary
  collisions stop hiding.
- **The anchor reads the closed week** — weekly run volume anchors to the previous full Mon–Sun week
  on both halves of the calculation, so a week's prescription can no longer grow from the runs it
  itself prescribed.
- **A day is judged against the bar in force that day** — the underfueling read reconstructs the
  accepted calorie target per day from its history instead of applying today's bar to the whole
  window, weights days by energy, and ignores a fat-fingered outlier bar that would otherwise own
  the verdict.
- **An explanation buys time, not silence** — a strength-regression explanation whose remedy was
  delivered and given a fair test window becomes dated history instead of suppressing the case
  conference forever; a live symptom never expires.
- **A plan vouches for the week it judges** — compliance learned that a prescription too stale to
  vouch for the week behaves as absent, and the weekly auto-apply tick leads only after you have
  explicitly handed the run week over.

### Fixed

- **Today is the local calendar day everywhere** — every remaining UTC-framed date site now frames
  through your local day, so evaluation windows and evidence dates stop drifting a day forward every
  evening.
- **A correction never eats a receipt** — a chat correction is judged against the original reply it
  corrects, and a refused or failed revert whose prose claimed success is replaced by an honest
  correction; change receipts survive both.
- **A question is never a veto** — asking "will you revert this?" is read as the question it is, in
  every gate, instead of being executed.

### Notes

- Two new tables (`hr_model_state`, `calibration_events`) created on boot; no migration required.
  Schema version is unchanged.
- Service worker cache v543 → v548; installed PWAs self-update on next open.

## [1.7.1] — 2026-08-04

The theme of this patch is accountability in both directions. The brain already knew how to lower
your training volume to protect recovery or fuelling; now every set it takes away is owed back, said
out loud, and returned when the reason passes — and everything it is still holding for your decision
has a place where you can actually see it. Underneath, the signals it reasons from got another round
of honesty: a lab marker's age is judged by what kind of marker it is, a stale readiness number
behaves as absent, and a calorie target arrives with its arithmetic instead of as a bare number.

### Added

- **A cut set is owed back** — when the brain reduces an exercise's sets (to protect fuelling, for
  example), it now steps down at most one set at a time, announces the change instead of applying it
  quietly, and records a debt: once fuelling settles and the day reads "proceed", it proposes the
  climb back, one step per week boundary. Editing the exercise yourself clears the debt — your hand
  always wins.
- **"Waiting on you"** — decisions the coaching brain is holding for your call no longer age off the
  bottom of the Changes feed. A new block beside the plan's forward note (plus an API endpoint and
  MCP tool) lists everything still waiting, each in the plain sentence the case conference wrote for
  you — and it stays until you resolve it.
- **A calorie target shows its work** — when a nutrition target moves, the note now carries the
  arithmetic behind it: your logged intake over the last three weeks, your weight trend over the same
  window, and the maintenance those two imply. Thin logging gets an honest "confidence is lower"
  line, never blame.
- **Plan rewrites explain themselves per movement** — a full program restructure now records what
  each exercise looked like before and after, so the Changes screen can say exactly what moved
  instead of only that "the plan changed".
- **A marker's age is judged by its kind** — genetic results never go stale, slow-moving markers
  keep their standing for months, fast-moving ones are doubted sooner. Lab findings re-derive daily
  so a directive is always built from readings that are still current.
- **Push drive answers with the work that's due** — a stacked-days rest suggestion now comes with
  the targeted work that has genuinely accumulated, not a blanket day off (from the preceding
  rounds, first released here).
- **The Apple Health Shortcut ships signed in the repo** — install works with zero configuration.

### Fixed

- A stale training-readiness reading can no longer steer today's decision — it behaves as absent,
  like every other wearable signal, and the rolling-average back door is closed.
- The learning ledger can reach conclusions again: predictions survive recomputes, verdicts land on
  the decision that owns the metric, and trust adjustments stay within the same signal source.
- Interpretation stops outrunning its evidence — what the model is told and what you read both stay
  inside what was actually observed, and cautions are built only from readings that are still
  current.
- A rest-day session keeps its movements, and the last of the old pain mini-forms is gone — pain is
  reported in your own words.
- Two wearable-absence phrasings could collapse into the same sentence on the same morning; the
  "nights" voice now has its own words.

## [1.7.0] — 2026-07-30

Several connected rounds land here, and they share one direction: the coaching brain got harder to
fool and easier to trust. It can now tell a day you have genuinely earned from a day it simply knows
nothing about — so a morning read can offer room to reach instead of only asking you to hold back —
and it checks its own advice afterwards, quietly walking a change back when what it predicted did
not happen. Underneath that, the signals it reads got more honest: a wearable number that stopped
syncing now behaves as absent rather than as this morning's truth, muscle recovery fades over hours
instead of flipping at midnight, and a rest suggestion you have repeatedly trained through without
harm softens instead of repeating itself. Training also gained your own ordering of what it is all
for, endurance that knows the difference between a road ride and a trail climb, and a pain note you
can actually close. Food estimates now say how sure they are, and a meal logged in chat fills in with
the review it promised.

### Added

- **Your priorities, in your order** — you can now say what training is actually for, ranked
  (longevity, muscle, leanness, strength, endurance), what role endurance plays alongside it, and a
  duration you want to be capable of. The coaching picture follows that order instead of assuming a
  mixed profile means every goal weighs the same. Left unset, nothing about your existing setup
  changes. Cairn also reads your logged work to describe a capability as ready, building, rebuilding,
  or not yet observed — a description, never a change to your plan.
- **Endurance that knows the terrain** — trail and lift-served mountain biking, road, gravel, alpine
  and Nordic skiing, touring and the rest are now distinct rather than one "cycling" or "skiing"
  bucket. A road ride no longer counts as evidence you are ready for a two-hour trail day, and load
  accounting reflects climbing, technical descending, and the trunk and grip demand each mode
  actually asks for.
- **A running week that moves with your life** — the run plan is now a set of weekly intentions
  reconciled with what you did: an actual run closes the matching easy, quality, or long intention
  whichever day you ran it, key runs are spread rather than stacked onto one opening, and work that
  no longer has a clean opening simply stays undated. Nothing is called missed, and nothing turns
  into catch-up mileage.
- **Rest days come with somewhere to put the energy** — a rest or easy Brief now offers two or three
  low-key options (an easy spin, a walk, mobility, core) drawn from what you have actually been
  loading and steered clear of anything currently sore, so a quiet day does not read as a void. Still
  a suggestion; still nothing you owe anyone.
- **Pain and injury you can actually close** — the finished-session note became a lifecycle. Report
  it, get asked about only the movements it genuinely touches, and resolve it in one tap from the
  Life card, the panel (now reachable on a rest day too) or chat — and resolving it truly quiets the
  Brief, the banner and the timeline instead of leaving an echo behind. A recurrence starts a fresh
  chapter without erasing the history. Soreness and performance read as words now, never numbers.
- **A day you have earned reads like one** — when your own logged evidence backs it (recent sessions
  coming back strong, nothing fresh pulling the other way), the morning read offers room to reach
  inside the session rather than a flat "train". A watch alone can never grant this, and it never
  makes the session longer — it is permission to push, not extra volume.
- **A week you have earned can build a little faster** — a run of aligned outcomes with nothing
  missed and no training symptom on record now earns a slightly larger next step on a lift, and a
  slightly bigger running week, each inside a declared ceiling. Safety floors never move, one good
  week straight after a bad one cannot whipsaw you upward, and mileage is held to the stricter
  standard because tendon and bone adapt on a slower clock than a good fortnight can prove.
- **The brain checks its own advice — and walks it back when it was wrong** — a change to your
  training now predicts something checkable and only when you are already logging what could
  disprove it: that sessions do not start feeling worse, that joint pain does not get more frequent
  than it already was, that a lift holds its strength, that a bigger running week does not cost your
  overnight recovery. If one of those genuinely misses, the change is drafted back to where it was
  through the same review and one-tap-undo path as anything else. A missed workout never triggers
  this — that is your call, and undoing your plan over it would be punishment.
- **Home base, and travel that stays temporary** — set your home location once, by hand. A dated trip
  becomes the coaching location while it is active and reverts on its own afterwards, while upcoming
  and past trips stay on the timeline without ever overwriting home. No weather provider, no browser
  location request, no daily "where are you" prompt — context only.
- **A logged meal fills in with its own review** — chat's "I'll fill in the nutrition details"
  finally resolves visibly, inside the same message: the ingredients the estimate was built from,
  each with its own amount, and a plain line saying how the numbers were obtained. No follow-up
  message, no notification, and a later revision updates the review in place rather than adding a
  second one.

### Changed

- **A reading that stopped syncing stops speaking** — every wearable number now carries how old it is
  allowed to be before it can speak for today (a night's sleep two days, readiness one, heart-rate
  variability and resting heart rate and load three, fitness markers a fortnight). Past that it
  behaves exactly as absent — never a stale vote at a discount. A wearable trend whose newest point
  is weeks old likewise reports no direction and no projection, and says when it was actually last
  measured.
- **Muscle recovery fades instead of flipping at midnight** — recently trained muscle used to be a
  yes/no with a hard cliff, so four sets and thirty sets were the same thing and both went from
  smoked to fresh overnight. It is now a dose that decays at each muscle group's own rate; a
  110-minute run is no longer the same event as a 55-minute one; and a running week finally counts as
  work in the weekly balance read. Everything that asks "is this still recovering" now asks one
  question, which is why the Brief no longer says quads and calves are due the morning after the long
  run that flattened them.
- **Soreness brakes only what you trained** — a rough session used to slow your whole body for three
  days. It now scopes to the muscle groups that session actually worked, and stays conservative when
  it cannot tell which those were.
- **Rest stops repeating itself when you keep training through it** — if several recent rest mornings
  were trained through with nothing in your feedback suggesting it cost you, the next one softens a
  notch to easy rather than repeating a suggestion you have already answered. Anything clinical is an
  absolute floor and is never softened, and a rest morning you honor resets the pattern.
- **Estimates say how sure they are** — a vague guess no longer counts the same as a photo read: a
  low-confidence food entry stays visible but is excluded from the food-quality tallies and from lab
  correlation evidence, because an uncertain estimate is not evidence either way. A meal plan more
  than three weeks past its week now reads as aged even when nothing upstream changed, and an active
  lab finding on saturated fat or added sugar now lands a plain, non-blocking note on a plan that
  reads "watch" on that band.
- **The mood you log is part of the picture** — a check-in's mood has been recorded since the very
  first check-in and read by nothing. It now appears in the evidence behind a read as context,
  deliberately without steering the read itself: a passing low mood should not be able to turn an
  otherwise evidence-free morning into a conclusion about your recovery.
- **Rotating a movement in starts from a real number** — a swapped or added movement is now grounded
  server-side: your supplied target if you gave one, then that lift's own logged history, then a
  conservative starting idea from a related lift (advisory only, never saved, and retired by your
  first logged set), then the baseline cue. A plan target that had fallen behind your actual lifting
  catches up through the ordinary progression path.
- **Training cards say one thing once** — a session's easing is stated once instead of three times in
  competing voices, the fuel guard keeps its training consequence without printing calorie mechanics
  onto a lift card, and progression phrasing rotates by day and by movement so the same sentence does
  not greet you for a fortnight.
- **A quieter morning** — logging a burst of sets on a day whose read is already settled no longer
  sets off a chain of coaching recomputes, while a late correction still re-opens the day for an
  honest re-read.
- **More reliable coaching responses on one more assistant** — structured-output enforcement now
  covers an additional connected coaching CLI, so plan changes, meal plans and swaps come back in the
  expected shape rather than narrated around.
- **The repo reads like the project it is** — the README is roughly half its former length with one
  quickstart instead of two, live counts instead of a year-old drifted number, and the MCP server
  promoted from a footnote to its own section. Executed one-round build plans are out of `docs/` (git
  history keeps them), the vision document's plan of record caught up with what actually shipped and
  records two honest reversals, and the design and quickstart docs name tabs that exist.
- **Dependencies current** — a high-severity path-traversal advisory in the HTTP-server dependency
  chain is cleared, along with a URI host-confusion issue; the audit now reports zero known
  vulnerabilities.

### Fixed

- **A watch worn only in the daytime reported a resting heart rate that was not one** — readings in
  the 94–118 range taken off a daytime low, which then fed a daily false "resting heart rate
  elevated" caution. That value is now accepted only when the watch genuinely witnessed rest, "no
  data" sentinel values are rejected at the door, and the affected history is repaired.
- **A rough session could prolong its own verdict** — the low-performance signal read your last few
  sessions, so a rest suggestion made sessions rarer and the evidence that would clear the flag took
  longer to arrive. It now reads a plain seven-day window, a later good session clears an earlier
  flag, an opened-and-abandoned session counts as nothing, and each flag dates to the session that
  caused it rather than to "now".
- **The brain's self-checking almost never reached a conclusion** — two changes whose questions
  overlapped cancelled each other out, and with several questions opening a week the ledger had
  reached exactly two conclusions in its entire life against 82 left hanging. The most recent change
  now owns the measure, so the question that is actually live gets a real answer.
- **The learned adjustments could freeze on old evidence** — the model read the oldest verdicts
  rather than the newest once the history grew, a learned step for one lift could be shadowed by an
  unrelated note, a safeguard against repeatedly reversed decisions quietly stopped firing on the
  busiest area (exactly the one it exists for), and an adjustment earned once applied at full
  strength forever. Learned adjustments now fade with age and stop moving numbers after a year.
- **A meal correction in chat reached nothing** — "add half the Brussels sprouts from the appetizer
  list" minutes after logging lunch was answered as though it had been recorded, while nothing
  changed and no estimate was made. Menu wording now counts as food, a follow-up amendment lands on
  the meal you just logged instead of creating a duplicate, the assistant is barred from claiming it
  logged something when it did not, and the fuel strip no longer disagrees with the reply beside it.
- **A restart no longer costs a day of learning** — the nightly pass was the last job still gated on
  the server being awake at exactly 3am, with its last-run date held only in memory. A deploy through
  that hour silently threw away the whole day's reconciliation, evaluation and model rebuilds; it now
  catches up like every other daily job.
- **Escaped punctuation in a morning headline** — a read that stored an ampersand as its escape code
  ("Push session `&amp;` run complete") printed the code itself. Prose is decoded on the way in now,
  refused if it still arrives escaped, and the stored history is repaired.
- **Plan notes that had fossilized** — coaching adjustment notes layered on top of each other until
  old fragments were stranded mid-sentence, and one internal-sounding line ("Explicit plan-day
  override: Day 2.") reached the athlete. Notes keep one replaceable layer, truncate at a sentence
  boundary, and the existing damage is repaired.
- **A completed long effort closes the long run** — a quality-bearing long session now closes the
  matching intention instead of leaving duplicate long work open, and a completed cardio date is
  reserved rather than offered again.
- **Movement checks only appear when they mean something** — the check now renders only for a
  movement with a genuinely relevant, live pain note, and an imported legacy note can no longer
  masquerade as a live prompt.
- **A calorie target is no longer eased for a plan you did not eat** — when the weight did not move
  as expected, the target was the only explanation available, so it got adjusted even on a week the
  plan was never followed. How closely the plan was actually eaten is read first now, and an unclear
  week ends the question honestly rather than convicting a target that was fine.
- **A check-in is no longer judged against the trend it was made to change** — the weight slope
  behind a nutrition check-in now starts at the check-in, waits for enough weigh-ins to say anything,
  and stays quiet until then.

### Notes

- This round includes schema migrations **80** through **87**. Two add optional profile fields
  (ordered training priorities, home location); the rest change no schema and repair or compact data:
  fossilized plan notes, implausible historical watch readings and "no data" sentinels, escaped
  day-read prose, a large pile of historical resolved-directive rows, and overlapping prediction
  windows. All are idempotent. Down-migrations remain unsupported — back up before deploying.
- PWA cache `cairn-v538`.
- Learned adjustments, predictions and their verdicts remain internal instrumentation: they ground
  future tuning in what actually happened, and none of it is ever shown to you as a score.

## [1.6.0] — 2026-07-25

Three connected rounds land here. The day read grew more self-consistent and more honest about what
it actually knows — the Brief and the full coaching picture can no longer disagree, a single short
night no longer reads as a stacking trend, and a chronically short sleeper is offered their due
session instead of being told outright to rest. The coaching brain also gained a way to check
whether its own advice was followed, a few small honesty passes landed in athlete-facing text, and
responses from a connected coaching assistant are now more reliably shaped. Food logging also got
more honest about time and richer under the hood: a meal now remembers when you actually ate it,
not just when you typed it, and chat, a written note, and a photo all capture a meal the same
complete way.

### Added

- **Today picks one true lead** — the main column now arbitrates a single lead among the Brief,
  feedback, an insight, the weekly read, or fuel instead of stacking competing cards; a quiet day
  with nothing new lets another surface take the position.
- **The coaching brain checks itself** — each morning's read now carries a plain, checkable
  prediction (did you rest when it suggested rest, train when it suggested training), settled the
  very next day. This is internal instrumentation that grounds future tuning in what actually
  happened — never a score, and nothing about it is shown to you directly.
- **More reliable coaching responses** — when the connected coaching assistant supports it, plan
  changes, program evolution, the week-ahead preview, and meal plans/swaps are now structurally
  enforced to match the expected shape, so a malformed or narrated-around response can no longer
  slip through unnoticed.
- **Log a meal for when you actually ate it** — mention "a late dinner last night" or "lunch
  yesterday" in chat and it's recorded against the day and time you meant, not the moment you typed
  it. An unstated time is left exactly that — unstated, never guessed at or shown as midnight — and
  you can move an entry to the right day or fix its time afterward the same way you'd fix a macro.
- **Meals captured more consistently everywhere** — chat, a written note, and a plate photo now
  read a meal the same way: broken into its parts with a quantity for each, plus a coarse read on
  things like sodium, added sugar, and food quality that can later be weighed against your labs.
  Every estimate now records how it was obtained, so a stated amount and a rough guess are never
  presented as the same kind of number.

### Fixed

- **The Brief and the coach can't quietly disagree anymore** — a gap where the Brief's own read
  could build a thinner picture than the full coaching context let the Brief say "train" on a day
  the fuller picture had already called for rest.
- **One night isn't a trend** — a single short night no longer reads as "stacking up," and a
  several-day-old readiness reading no longer forces a recommendation as if it just came in this
  morning.
- **Chronic short sleep gets an easier read** — instead of being told outright to rest, a
  persistently short sleeper is now offered their due session with a caveat, and only a fresh short
  night backed by a genuinely short rolling average forces rest.
- **Lists read the way a person says them** — "your left knee, right shoulder, and lower back"
  instead of a run-on comma splice, across joint-pain notes, plan-selection reasoning, and other
  athlete-facing text.
- **A real closing line when you finish a session** — varied phrasing consistent with the rest of
  the Brief's voice, instead of one fixed client-side message.
- **The meal-plan assistant sees your coaching focus** — it was already being handed the day's
  coaching focus but wasn't rendering it into the prompt.
- **Factual percentages are no longer flagged as scores** — "you're at 80% of your protein target"
  now reads through; a bare or invented percentage still doesn't.
- **The day-read history no longer double-counts a revisited day** — a day whose read legitimately
  evolved (rest in the morning, trained anyway) had been recorded as several duplicate rows, skewing
  any date-by-date look at that history.
- Corrected an invalid default AI model name that was silently breaking image-similarity matching.

### Notes

- This round includes schema migrations **78** and **79**. Migration 78 deduplicates historical
  day-read ledger rows and hardens the guard that prevents the duplication from recurring. Migration
  79 adds an optional, additive "eaten at" time to logged meals. Down-migrations remain unsupported.

## [1.5.1] — 2026-07-24

Progress now opens into Fuel → Intake: a calm, gap-honest 35-day read of
Energy, Protein, Carbs, Fat, and Fiber. It keeps historical and current target
provenance visible, excludes open days, and pairs sampled clearly estimated
food quality and saturated-versus-unsaturated fat context with preparation,
cooking-oil, and culinary-memory context. Today and the day-fuel view gain the
same richer picture without making Food a primary navigation destination.

### Added

- **Progress Intake analysis** — a 35-day, gap-honest Energy/Protein/Carbs/Fat/
  Fiber view with target provenance and open-day exclusion.
- **Food-quality context** — clearly estimated, sampled quality and fat-balance
  reads that account for preparation, cooking oils, and remembered culinary
  context.
- **Fuel across surfaces** — expanded Today and day-fuel detail, with matching
  REST and MCP availability for the nutrition progress data.

### Fixed

- **More resilient nutrition refreshes** — privacy, error, and enrichment
  handling stay bounded when nutrition data is incomplete or a refresh fails.

### Notes

- Intake and food-quality reads are estimates; older categorical history may
  not support the same detail. No schema migration is required.

## [1.5.0] — 2026-07-23

Cairn's learning brain became more reactive and legible: fuel truth, lab and
felt-signal feedback, freshness, coach reads, learned models, and daily
composition stages moved forward together. Chat gained adaptive lane routing
with per-run model/reasoning bindings and local-frame weekly reads; Today now
focuses attention on meaningful actions, and timed training sets have a
stopwatch.

### Added

- **Durable daily sessions** — accepting a suggested or chosen session now creates
  a full, versioned snapshot that survives reloads and keeps custom work distinct
  from weekly-plan templates. The Today flow restores that session, preserves its
  prescription, and explains when a different replacement is no longer safe after
  meaningful work has started.

## [1.4.0] — 2026-07-19

Cairn can now keep medical imaging with the written findings that give it
meaning. Bring in JPEG, PNG, PDF, or MyChart findings and organize them by
body region and marker; import DICOM Part-10 files or ZIP archives into a
durable, recoverable study library. The viewer is deliberately non-diagnostic:
it helps you navigate supported classic monochrome images, while the written
report remains authoritative. PWA cache `cairn-v510`.

### Added

- **Imaging alongside findings** — JPEG, PNG, PDF, and MyChart findings can be
  associated with clinically organized body-region and marker groups.
- **Durable DICOM import** — direct Part-10 and ZIP import with resumable jobs,
  recovery after interruption, Study/Series/Instance indexing, and safeguards
  against UID and patient-identity conflicts.
- **A bounded, non-diagnostic viewer** — supported classic monochrome studies
  offer window/level, frame, and instance navigation; unsupported objects say
  clearly why they cannot be shown.
- **Careful image assistance** — AI use is limited to representative PNGs, and
  any image observations remain explicitly unconfirmed; written reports are
  the clinical authority.
- **Privacy-first imaging controls** — authentication and no-store responses,
  privacy-redacted public and export surfaces, crash-safe deletion/quarantine,
  and read-only MCP imaging tools. Raw imaging files are PHI.

### Notes

- Imaging schema updates run automatically on boot. The current migration is
  **v67** (`dicom-private-identity-hardening`); down-migrations remain
  unsupported.

## [1.3.0] — 2026-07-17

Endurance becomes a first-class citizen alongside the barbell: runs and hikes
shape recovery, rest, fueling, and the week, and the coaching brain learns how
the athlete responds to mileage the same way it learns lifts. Training identity
got sharper — one lift is one row everywhere — and the daily surfaces read
faster: a muscle-first Train tab, a week-in-review that reads in seconds, and a
workout moment with a pre-session primer. PWA cache `cairn-v506`.

### Added

- **Endurance, first-class** — runs and hikes participate in recovery, rest-day
  logic, fueling guidance, and the week view; a hybrid week sequences the
  runner and the lifter so the two don't compete on the same day.
- **The brain learns endurance** — run-volume expectations in the decision
  ledger, VO2max and easy-pace response patterns, and a hold/ease-only learned
  run-volume step.
- **Cut-quality read** — whether a cut is preserving muscle: weight trending
  down while strength holds, read calmly from Energy Balance.
- **Exercise identity** — one lift, one row, everywhere: plural and possessive
  variants fold into a single identity, with one-tap merge suggestions for
  near-duplicates and a curated lift read replacing the uncapped scroll.
- **Support-work intelligence** — a lagging lift proposes building its weak
  link, not just more of itself.
- **The workout moment** — a pre-session primer, felt freshness, and
  finish-moment feedback folded into the done card.
- **Week-in-review and the road ahead** — a latest-state, grouped weekly card
  that reads in seconds, plus one dated forward timeline of what's coming.
- **Next checkup** — the doctor loop surfaced: ordered future labs and
  follow-through tracked to completion.
- **The team's week** — a digest of the coaching brain's specialist voices with
  visible evaluations.

### Changed

- **Train leads with muscle groups** — the journey story folds beneath a
  muscle-first overview.
- **The weekly read persists compactly** — acknowledging it is not dismissing
  it; the read stays quietly available.
- **A resumed PWA checks for updates actively** — an installed client catches
  up on next open instead of sitting stale.
- **A sturdier brain under the hood** — metabolic control loop, autonomy
  atomicity, and scheduler durability; meal quality and constraint freshness
  enforced on nutrition writes.

### Fixed

- **iOS agent-login paste** — a native paste box under the login terminal; iOS
  never offers its paste menu on xterm's hidden textarea, so OAuth codes were
  impossible to enter from a phone.
- **"Hold this" sticks** — holds persist and review holds retire on every
  terminal transition; routine progressions no longer consume the surprise
  budget, and budget holds wait quietly instead of interrupting Today.
- **Chat verifies plan writes before confirming** — no confident confirmations
  over failed writes; newly created sessions finish reliably.
- **Cross-domain marker asks dedupe** — the same lab request no longer arrives
  from two domains at once.

### Notes

- Migration **v66** (`exercise-key-plural-fold`) singularizes exercise-key
  tokens so plural variants fold into one identity; down-migrations remain
  unsupported.

## [1.2.0] — 2026-07-14

Cairn's daily loop is calmer and more trustworthy: the Brief explains the
signals behind its read, recovery and training load use personal baselines, and
nutrition changes carry through to the plan instead of stopping at advice.
Capture is more durable offline, Garmin strength imports reconcile safely, and
Apple Health gains secure, revocable, least-privilege Shortcut pairing
groundwork. PWA cache `cairn-v492`.

### Added

- **A clearer daily read** — the Brief leads with the win, names the few signals
  that shaped the day, and frames gaps as calm context rather than a verdict.
- **Personal recovery and load context** — wearable recovery and training-load
  bands learn the athlete's own baseline, with sparse-data fallbacks that stay
  useful without pretending to know more than the history supports.
- **Nutrition follow-through** — accepted energy-target changes can refresh the
  downstream meal plan through the existing autonomy and undo ledger; Energy
  Balance now leads with plain-language direction and visible confidence.
- **Apple Health pairing groundwork** — an authenticated owner can create a
  short-lived, single-use pairing code, exchange it for a hashed, revocable
  token scoped only to daily-metric ingestion, and manage connections through
  REST and Settings. Pairing management is intentionally owner-only REST, not
  an MCP capability.

### Changed

- **Background coaching follows local time** — scheduling, freshness, seed
  dates, and draft-adoption grace windows use the configured local day while
  retaining UTC timestamps for durable ordering.
- **Adaptation survives interrupted stewardship** — eligible orphaned drafts
  can re-enter the server-owned autonomy path after a bounded grace period,
  preserving vetoes, natural boundaries, and Undo.
- **Energy estimates are more robust** — expenditure reads weigh the whole
  available picture, degrade honestly when inputs are thin, and avoid letting
  one anomalous signal dominate a recommendation.

### Fixed

- **Offline logs are recoverable** — failed outbox rows can be retried or
  removed, so a stale “Needs attention” toast no longer remains over the app.
- **Garmin strength imports are atomic** — detected sets reconcile as one
  transaction, respect hand-entered work, and cannot leave partial sessions
  behind when an import fails.
- **Small-screen polish and determinism** — wrapped pills no longer clip, tape
  inputs prefill from the latest measurement, and local-date tests no longer
  flake around midnight UTC.

### Notes

- Migration **v65** adds nullable source-agnostic daily-metric fields for total
  calories, distance, exercise minutes, stand hours, SpO2, and VO2max. Fresh
  Apple Health pairing/connection tables are created idempotently with
  `CREATE TABLE IF NOT EXISTS`; down-migrations remain unsupported.
- Cairn does **not** ship a validated Apple Shortcut artifact by default. Guided
  iPhone installation remains opt-in and unvalidated until an operator
  configures a trusted Shortcut URL; the documented manual-builder path remains
  the fallback.

## [1.1.1] — 2026-07-12

Cairn can now support a household safely by running one isolated released
instance per person on the same private Docker host. Each member gets their own
database, uploads, tokens, connector secrets, provider login home, tools, and
Tailscale HTTPS origin; Cairn remains intentionally single-user per process.
No schema migration is required. PWA cache `cairn-v473`.

### Added

- **Household deployment guide** — a production-oriented Compose/Tailscale path
  for adding partners or family members without sharing clinical data or credentials.
- **Clean personal bootstrap** — `CAIRN_BLANK_PROFILE=1` seeds only a neutral
  exercise catalog, with no example plan, measurements, or training history.
- **Explicit onboarding sex** — first-run setup captures the value used for
  sex-specific health ranges instead of silently defaulting a blank profile to male.

### Changed

- **Reusable release Compose** — container name, loopback bind, and host port are
  configurable while existing single-instance defaults remain unchanged.
- **Reliable release updates** — in-app and public instructions refresh the
  release Compose file before pulling, because tagged release assets pin exact images.
- **Release security parity** — fail-closed auth and Settings-secret encryption
  variables now pass through the published Compose file.

## [1.1.0] — 2026-07-11

Cairn's background expert team becomes more trustworthy and less chore-like. Intelligence outputs
are now accepted by meaning, not merely by valid JSON; failed providers repair, rotate, and fall
back calmly. Plan and Meals show the current plan, upcoming changes, and recent changes instead of
making Drafts the normal workflow. The Docker image is leaner, with coaching providers installed on
demand into a persistent tools volume. No schema migration is required. PWA cache `cairn-v472`.

### Added

- **Visible future adaptation** — Plan, Meals, and Today surface scheduled changes before they land,
  with Hold, Why, and Undo near the change rather than a separate Drafts inbox.
- **On-demand coaching CLI installation** — install only the provider you use from Settings; pinned
  identities/checksums and a persistent `cairn-tools` volume keep upgrades reproducible.

### Changed

- **Semantic intelligence contracts** — each operation validates the shape and meaning it needs,
  attempts one bounded repair, then rotates to another provider before using deterministic or stale
  fallback content.
- **Food intent stays clean** — ordinary food events no longer become durable meal preferences that
  distort later planning.
- **Autonomy language is consistent** — public docs and program-evolution prompts now match the
  server-owned policy: bounded reversible changes can land at natural boundaries, structural changes
  announce first, and clinical or goal-identity decisions always ask.

### Fixed

- **Stop remains Stop** — cancellation now propagates through verification and week-ahead fallback,
  preventing canceled work from being persisted later.
- **Calm degradation** — invalid agent responses no longer create empty drafts or misleading Today
  reads, and failure telemetry retains the rejected contract for diagnosis.

## [0.8.0] — 2026-07-04

The body surfaces get an **elite figure**: the crude ellipse packs are replaced by one
authored anatomical drawing (male/female from a shared skeleton) shared across Train and
Stand. PWA cache `cairn-v427`.

### Added

- **Elite body figures** — a vendored, dependency-free `public/cairn-body-figure.js`
  (`window.CairnBodyFigure`) replaces the crude ellipse packs with one authored
  anatomical drawing (male/female from a shared skeleton). It powers **Train ›
  Muscle balance** (front/back muscle map with band tone overlays and a due-only
  pulse; tap a muscle to jump to its row) and the **Stand › Where you stand** figure
  — a fixed reference silhouette whose tappable measurement callouts read each site
  against a reference physique scaled to your height (waist ≤ half height, shoulder
  ≈ 1.4–1.6× reference waist, arm ≈ calf, weight from FFMI), with a selected-site
  detail panel and an under/reference/over read. Both surfaces degrade gracefully to
  the prior figures if the library is absent. PWA cache `cairn-v427`.

## [0.7.0] — 2026-06-27

Cairn's coaching brain now has a **conductor**: one sequenced, whole-athlete focus that
arbitrates training, running, DEXA, labs, nutrition and recovery instead of flooding the
app and prompts with competing cards. This release also adds the deterministic running
engine, richer DEXA and muscle-group reads, stronger HealthOS validation, in-app update
detection, and the first data-triggered plan-evolution cadence. Migrations **v44-v47** run
automatically on boot. PWA cache `cairn-v166`.

### Added

- **Whole-athlete coaching focus** — new `GET /api/coaching-focus` + MCP
  `get_coaching_focus` return one lead lever, 1-2 parallel levers, explicit deferrals,
  cross-domain connections, and one batched re-test checkpoint. The same read is rendered
  first in plan prompts and surfaced as the lead card/thread in the PWA.
- **Running brain** — new run zones, weekly periodized run plan, run variety read,
  endurance re-test prompts, and a draft-only apply path:
  `GET /api/run-plan`, `/run-zones`, `POST /api/program/run-plan/apply`, plus MCP
  mirrors. Prescriptions carry real bpm zone bands and structured intervals.
- **DEXA targeting** — DEXA regional data now drives concrete training/nutrition targets
  with a plain "path to your next scan"; low BMD and visceral-fat signals stay
  clinician-framed and informational.
- **Muscle-group trajectory + test week** — per-canonical-group advancing/stalling reads,
  plateau variation menus, and a cadenced strength test-week invitation with benchmark
  lifts to re-test.
- **HealthOS hardening** — blood-pressure capture/read, symptom-to-marker connections,
  transient-marker handling, numeric plausibility clamps, non-clinical marker filtering,
  and conventional clinical marker ordering for the app and doctor report.
- **Training-intelligence standing** — Progress now benchmarks strength capacity against
  sex/age standards, reads VO2max for age, flags imbalances, names the lever, and folds
  DEXA/endurance re-tests into the performance read.
- **Garmin richness** — daily and activity sync populate more runner metrics, stress,
  body-battery-style fields where the device provides them, race predictions, training
  load balance, HR extremes, and richer activity detail.
- **Self-hosted update detection** — Settings → Data now shows the running Cairn version,
  latest release status, a What's-new link, and copy-paste update commands. The Docker
  image bakes `CAIRN_VERSION` from the release tag.
- **Data-triggered plan evolution** — the scheduler can draft an early plan evolution
  when logged data materially shifts (stalled lift, under-trained weak point, test week
  due), with cooldown/signature dedupe so it drafts once per real shift.

### Changed

- **Me opens to Standing** — the review-first Me surface now leads with "Where to focus",
  then the where-you-stand health read. Health is the lab-data home with Read / Markers /
  Records / Share / Learned; the old Brain view is folded into Health → Read.
- **Progress and Endurance are quieter** — conductor-led views keep the main action visible
  and collapse deeper benchmark detail behind a single "The full read" disclosure.
- **Today speaks with fewer competing banners** — the conductor thread subsumes the old
  health lever/goal-line pile when it has a trustworthy lead.
- **Doctor-facing marker review is easier to scan** — clinical panels now follow a
  conventional lab-review order, electrolyte ordering is explicit, and doctor export
  actions stay reachable.
- **Release workflow** — the tag-driven image workflow now bakes the exact tag into the
  image so update checks report the running version correctly.

### Fixed

- Run-plan proposals now persist structured interval prescriptions through the normal
  plan apply path without touching strength work.
- Plateau variation menus render real exercise names instead of leaking `[object Object]`.
- Urine dipstick markers group as urinalysis instead of being mis-filed under serum
  glucose/bilirubin/blood-cell groups.
- Eyeglass-prescription fields extracted from eye documents no longer show up as lab
  markers.
- The standalone health/performance lever is suppressed when the conductor already owns
  the focus, so the same advice does not repeat in three places.

### Notes

- Schema migrations **v44-v47** are additive and run automatically. Back up before
  deploying schema changes; down-migrations are not supported.

## [0.6.1] — 2026-06-24

Maintenance release for the early clinician/export follow-up after 0.6.0.

### Changed

- Improved the Health panel information architecture and clinician report readability.
- Clinically ordered health markers and kept report export actions sticky.

## [0.6.0] — 2026-06-24

The biggest release since the open-source launch: Cairn stops feeling like a set of tabs you
operate and becomes **one invisible coach that speaks through Today**. It reads your whole day,
knows who you are, follows your own device's clock, evolves your training plan over time, and
connects every lab finding to the meals and the training it should change. A run of schema
migrations (**v38–v43**) and dozens of new surfaces — all holding the constitution: calm, no
scores, pull-never-push, you-drive, nothing auto-applies. No manual upgrade step; migrations run
on boot. PWA cache `cairn-v140`.

### Added

**The unified coach — Today as one voice**
- **Honest "done" day-read** — a day you genuinely trained reads *TRAINED TODAY*, never "EASY DAY";
  the agent voices it as a fact it can't downgrade.
- **Post-session debrief** — after you train, the Brief reads you back: today's top set, the next
  session, a real protein gap — woven into a warm read-back, not a form.
- **Day-ahead forward line** — a quiet "↗ Next: …" under the Brief shows tomorrow's focus and muscle
  groups, attached on every read (survives caching), so the Program tab is never required reading.
- **One coach voice on the Today rail** — a single "✦ Also worth a look" masthead and one shared card
  frame (accent spine + radius), so the arbitrated cards read as one continued voice, not loose features.
- **The adjustments digest reads like a coach** — leads with earned overloads and frames missing-pattern
  gaps gently ("add a little core", never "no X programmed").

**Goal beyond weight loss (migration v41)**
- **Goal modes — lose / maintain / gain** — the goal is first-class: a maintaining athlete anchors to
  real TDEE (no forced deficit), a building athlete gets a conservative lean surplus, and the
  getting-lean/deficit framing is conditioned out of every plan / meal / chat prompt so you're never
  pushed into a cut you didn't ask for. Lose/Maintain/Gain selector in Me → Profile.
- **Daily fuel review + edit** — a calm "today's fuel" glance on Today taps through to an editable day
  review in Plan → Meals (correct a macro, rename, fix a meal slot). Capture stays in Chat; the review
  is never a logging form.

**Era 2 — the calm daily driver**
- **The Today salience arbiter** — one deterministic ranking pass over the whole Today surface: the
  Brief is always the hero, the top couple of cards render inline, the rest collapse behind one quiet
  "N more". An empty-data card self-omits — a quiet day is just the Brief. (The fuel card surfaces only
  when there's food to *evaluate*, so Today never nudges you to log.)
- **Reachable cited evidence** — a curated, offline trusted-guidelines pack (AHA/ACC, Endocrine Society,
  KDIGO…) keyed to the connected-brain markers, so the brain can cite its directives with no web access.
  `GET /api/guidelines` + MCP `get_guidelines`.
- **Photo → macros** — a plate photo in Chat creates an instant food note, then a vision agent estimates
  editable, confidence-banded macros that upgrade it in place. Degrades cleanly with no vision agent.
- **"Since you last looked"** — one calm line for the single most notable change (a merged lab, a resolved
  directive, a PR, an applied plan) since you last opened Today. Never a streak or counter; silent on a
  first open.
- **Gentle "is this still your goal?"** — a rare (~90-day), dismissible check-in card; confirm or change
  restarts the clock, and a new user is never nagged.
- **The learned timeline** — a pull-only Me → Health → Learned read that projects your load-bearing
  memories, outcome learnings, and connected-brain directives. Explains, never grades.
  `GET /api/learned-timeline` + MCP mirror.

**A device-following clock (migrations v42 / v43)**
- **Time-of-day-aware coaching** — Cairn's whole clock now follows your *device* instead of the
  server/UTC, via an IANA zone the PWA sends and the chat worker re-establishes. An evening log lands on
  the right day at home *and* while traveling, and the agentic brain knows whether it's your morning or
  your night ("RIGHT NOW: …" in the prompts). Logs stay UTC instants — only the framing moves.

**The knows-me coach**
- **Grounded, personalized "knows-me" coaching** — responses are grounded in who you actually are
  (memory, about-me, history), so the coach reads less like a generic model and more like someone who's
  been coaching you for months.

**Elite strength planning (migration v40)**
- **Exercise canonicalization** — a 13-group canonical muscle taxonomy that adds first-class core /
  forearms / mobility, deterministic classification, duplicate-movement dedup, and per-group weekly-set
  bands (plain words, never a score).
- **Auto-progression engine** — reads your last logged top set + RIR and proposes the next session's
  target (overload / hold / deload / vary — conservatively clamped, injury-aware), surfaced on Today's
  lift card with "apply to my plan".
- **The logged-lifts → plan loop closes** — program state (per-lift trend, plateau/stall, volume
  landmarks, mesocycle) feeds the coach; a "what changed & why" digest surfaces on Today and Progress →
  Program.

**Adaptive program intelligence (migration v38)**
- **The plan evolves** — a deterministic program-state engine under an agentic plan-evolution loop that
  progresses what's working, deloads/rotates what's stalled, and periodizes toward an active mesocycle
  block, plus a movement-variation library for plateau breaks. Drafted through propose → apply, never
  auto-applied. `POST /api/program/evolve` + MCP mirror.
- **Intensity-aware Brief** — only genuinely-loading days count toward earned rest; a recovery day breaks
  the streak; off-plan sessions get content-true titles; the Lately feed expands strength rows to their
  movement breakdown.

**The connected brain goes deeper**
- **Whole-picture synthesis** — a prioritization layer collapses the directive flood into a handful of
  tiered, connected priorities, and an agentic pass writes the whole-picture story (the headline, the 2–3
  priorities and how they connect, the single highest-leverage move). `GET /api/health/focus`,
  `GET /api/health/synthesis` + MCP mirrors.
- **Marker canonicalization** — different labs name the same analyte differently ("Vitamin D" /
  "25-OH Vitamin D"), splitting one series in two; a deterministic KB plus an agentic reconciler now merge
  them (never conflating clinically-distinct measures), so every connected-brain surface aligns
  automatically.
- **Stale acute-marker decay** — an aging hs-CRP/ESR-class finding drops out of the daily "honor these"
  block to an informational "recheck" note instead of capping training every morning (chronic markers like
  ApoB never decay).

**Doctor-ready export (migration v39)**
- **Clinical report** — a self-contained, print-to-PDF clinical document: findings to discuss, markers
  grouped into panels with the latest value + lab flag + optimal target + full dated history, a DEXA
  section, supplements, and a "Copy for MyChart" plain-text twin. Stamped with your name (`profile.name`,
  migration v39). `GET /api/health-report(.txt)` + MCP `get_health_report`, surfaced as "Export for my
  doctor".

**Distribution & onboarding**
- **Secure self-host phone path** — `scripts/setup-phone.sh` auto-detects your private `https://…ts.net`
  URL via Tailscale Serve; a fail-closed `CAIRN_REQUIRE_AUTH` boot guard refuses to start an exposed
  instance without a token; a one-click "Open in GitHub Codespaces" front door; a "Phone & PWA access"
  Settings card.
- **Offline seed-art pack** — pre-baked studio illustrations ship in the repo so a fresh seed and the demo
  render real photos with no Gemini key (`npm run seed:art:build` to rebuild).

### Changed
- **Today is agenda-driven** — the rail is produced by the salience arbiter, reusing the rich existing
  cards and falling back to the fixed rail if the route is absent. Plus interactive progress charts,
  cardio-prose labels, and an "add to home screen" install coach.
- **Generated reference indexes regenerated** for the new surfaces: `docs/API.md` (**195 routes**) and
  `docs/MCP-TOOLS.md` (**162 tools**).

### Fixed
- **Auto-progression "apply to my plan" now applies** — the change carries `day_number`/reps/reason (the
  missing `day_number` was the "No plan day NaN" / "Couldn't apply" failure) and dedups drafts per day.
- A planned **run is skippable** on Today exactly like a lift ("not today"); a synced run overrides a stale
  skip.
- `latestSleep`'s 30-day HRV baseline dedups to one row per date, so two wearables feeding the same nights
  no longer double-weight the recovery norm.

### Notes
- The schema spans migrations **v38–v43**; they run automatically on boot. Back up before deploying schema
  changes — down-migrations are not supported (see `docs/OPERATIONS.md`).

## [0.5.1] — 2026-06-18

**Pasted lab panels now capture every marker.** A comprehensive panel (e.g. a Function Health export
with 100+ markers) was being analyzed down to ~40 — the analyzer dropped the "boring" in-range long
tail. This release makes health-record analysis complete and faithful: it transcribes the whole
panel, prefers the strongest model, and self-corrects a short read. No schema change — a drop-in upgrade.

### Fixed
- **Every marker is captured now.** A 100+ marker paste was curated down to the "decision-useful" ~40
  — the full CBC differential, electrolytes, the entire urinalysis, the omega/fatty-acid
  sub-fractions, and the sex/thyroid hormone panel were silently dropped. The analyzer now
  transcribes the complete panel verbatim, in-range markers included. (Re-analyzing a real Function
  Health paste went from **44 → 128** markers.)
- A silent **100-marker cap** that would clip a comprehensive panel even on a perfect read — raised
  to 250, comfortably clearing any real-world panel.

### Changed
- **Health-record analysis now prefers the best model.** Lab / DEXA ingestion runs **Claude-first**
  (then Codex), instead of the load-spreading round-robin rotation — faithful transcription matters
  more than spreading load for a one-off panel. An explicit per-task `health` agent route still wins.
- The extraction prompt now demands a complete, verbatim transcription — no curation, every
  in-range/normal marker included, the long-tail categories named explicitly — plus a self-reported
  marker count per panel. (It previously said "prefer real, decision-useful markers", which was the
  curation bug.) The same "no curation" guidance was added to the chat `log_health` path.

### Added
- **Self-correcting completeness check.** For a pasted-text panel, Cairn estimates how many results
  the source lists and, if the extraction comes back grossly short, re-runs the analysis once
  (Claude-first, with an explicit "you missed many" nudge) and keeps whichever read captured more.

## [0.5.0] — 2026-06-18

**Connect a coaching CLI without touching a terminal.** This release makes the agent layer
first-class and honest: sign in from inside the app, see which CLIs are connected and what model each
runs, and trust that only working agents are used. No schema change — a drop-in upgrade.

### Added
- **In-app agent login** — open **Settings → Agents → Connect** and a real terminal opens right in
  the browser to walk you through that CLI's sign-in (Claude Code / Codex / Antigravity / Grok). The
  server runs the login as itself, so the credential lands where the agent reads it — no
  `docker exec`, no `-u app` to remember. A PTY bridge over a WebSocket, with no native build step.
- **Honest rotation** — an installed-but-not-logged-in CLI is automatically kept **out** of the
  coaching rotation, so a half-configured host degrades cleanly instead of failing requests. Each
  card shows a clear **✓ Connected / Connect → / Installed / Not installed** state.
- **Version & current-model visibility** — every agent card shows the installed CLI version and the
  model it's currently using (read for free where the CLI exposes it; codex from its config).
  Transparency only — defaults are kept, nothing is pinned. `GET /api/agents/:name/info` + `/models`
  (+ MCP `get_agent_info` / `list_agent_models`)
- **Reorganized Settings** — a calm segmented sub-nav (**Agents / Sources / Automation / Data**) that
  never drops an unsaved edit when you switch sections.

### Changed
- The **agent-health card speaks plain words** ("reliable" / "mostly clean" / "often retries")
  instead of a percentage — no numeric scores, per the constitution.
- A pinned per-task agent now goes through the same retry + circuit-breaker + telemetry path as the
  auto rotation.
- Docs lead with in-app **Connect** as the easy path (`docker exec` as the fallback); the generated
  API/MCP reference and `SECURITY.md` cover the new surface. PWA cache `cairn-v89`.

### Fixed
- Grok now shows **✓ Connected** after an in-app device-auth login (it was stuck on "Installed").
- The login modal keeps a failed or interrupted login readable (Close + **Try again**) instead of
  vanishing after a second, traps focus, and fits small phone screens.
- The Settings save bar no longer false-flags "Unsaved changes" on a fresh load.
- The Settings sub-nav highlights the selected section correctly; off-plan exercise cards persist
  after the first logged set.

### Security
- The in-app login bridge is gated by the same `CAIRN_AUTH_TOKEN` and optional per-IP rate limit as
  the rest of the API, the login command is chosen server-side from an allowlist (never the browser),
  and the login subprocess is scrubbed of Cairn's own secrets (`CAIRN_AUTH_TOKEN`, `GARMIN_PASSWORD`)
  before it runs. An active login is also torn down cleanly on server shutdown.

## [0.4.0] — 2026-06-17

The first release with **endurance & running as a first-class discipline** — Cairn now coaches
lifting, running, or a hybrid of both — folded together with the open-source launch hardening that
landed since 0.3.0.

### Added
- **Endurance & running, first-class** — set your **primary discipline** (strength / endurance /
  hybrid) and an **endurance goal**: a dated **race** Cairn periodizes a conservative ramp + taper
  toward, or a **standing** readiness target with no date ("stay 10k-ready" — maintain, don't peak).
  The Brief, the plan, the coaching read, and the meals all speak to what you're actually training
  for (migrations **v35** / **v37**). `GET /api/endurance-goal` + MCP `get/set_endurance_goal`
- **Plan → Endurance race-coach** — a dedicated tab with a race-countdown / standing-goal banner,
  the current phase (base → build → sharpen → taper), and this week's run shaping
- **Applyable run prescriptions** — the coach hands back the week's runs (easy / tempo / intervals /
  long, each with distance, duration, and target zone) as a draft you approve; applying attaches
  each run to its day **surgically**, leaving strength work intact (`repo.setWeeklyRuns`)
- **The runner loop closes** — a synced Garmin run reconciles against the run that was prescribed:
  Today shows "**N of M km this week**" compliance in plain words (never a percentage), a prescribed
  run that already synced flips to a calm done card ("✓ Easy run — 8.2 km · synced from Garmin ·
  mostly Z2"), and next week adapts **conservatively** to actual mileage (fell short → hold, never
  make up missed volume). `GET /api/run-compliance`, `GET /api/cardio` (+ MCP mirrors)
- **Day-type-aware Today** — the day reads **TODAY · A RUN**, **TODAY · LIFT + RUN**, or a lift day,
  with cardio floated to the top on run days, plus a quiet Garmin **sync-trust** line ("synced 2h
  ago · Sync now")
- **Endurance progress & PRs** — Progress → Endurance shows weekly mileage, moving time, longest
  run, time-in-zone, and pace trend, plus endurance PRs; VO2max, resting HR, and HRV join the
  connected brain as optimal-zone markers (never a 0–100 score). `GET /api/endurance-prs` + MCP mirror
- **Agentic "How to do it"** — tap any exercise for a generated, plain-language explanation of how
  to perform it well, alongside its est-1RM trend and history
- **The week ahead on Today** — a calm forward look at the next few days, so today's read sits in context
- **Connected-brain visibility** — cached research evidence is now discoverable: a "see the evidence (N)"
  count on directives, a calm Settings toggle to enable research, and a quiet "What Cairn has noticed" card
  surfacing the durable suggestion→outcome learnings. `GET /api/evidence/summary`, `GET /api/learnings`
  (+ MCP mirrors). Pull-never-push, no scores
- **Structured injury impacts** — an active injury now links to the exercises it loads, with calm swap
  suggestions (deterministic; suggestion-not-gate). `GET /api/injury-impacts` + MCP `get_injury_impacts`,
  surfaced in Me→Life
- **Structured health export** — `GET /api/health-export` + MCP `get_health_export`: a portable,
  FHIR-inspired markers/observations summary in optimal-zone framing (no scores), to hand a physician or
  another tool; "Export health summary" in Me→Health
- **Garmin reconcile-now** — a calm Today card when the watch logged a strength session Cairn hasn't
  linked yet; one tap reconciles it. `GET /api/garmin/unreconciled` + MCP `list_unreconciled_garmin_strength`
- **Per-task agent routing** — optionally pin a task to a specific agent (chat → one, meal drafts →
  another) in Settings (migration **v34**); "Auto" everywhere keeps today's rotation
- **Linter, smoke test & positioning** — `biome` wired (`npm run lint` / `npm run format`, no tree-wide
  reformat); `npm run smoke` boots the server and exercises key flows over HTTP (kept out of the offline
  `npm test`); `docs/WHY-CAIRN.md` (vs MacroFactor / Oura / "ChatGPT + a spreadsheet")
- **Polish** — empty/degraded-state audit (incl. a markers-loader fix so it never sticks on a placeholder
  when offline), calm motion on the new cards, and a `seed:demo` refresh that populates the new surfaces.
  PWA cache `cairn-v68`
- **Weekly read card on Today** — the standing `weekly_read` ("how the week went + the one change")
  now surfaces as its own calm, editorial card under the Brief: a sage "THE WEEK · Jun 15–21" masthead,
  the read in Fraunces display, and the keystone `next_step` set apart as a terracotta "One change"
  well. It has a dedicated slot so a newer connection insight never buries it; the one-at-a-time
  connection insight sits below as the smaller aside (one `/api/insights` fetch split into both).
  Pull-never-push, with a weekend-gated client fallback to the proactive scheduler
- `docs/QUICKSTART.md` — five-minute getting-started path
- `docs/DEPLOYMENT.md` — Tailscale, HTTPS PWA, Pi, and backup guidance
- `CODE_OF_CONDUCT.md` and GitHub issue/PR templates
- **Family-aware meals + allergy/diet hard-exclusions** — structured allergies + dietary
  restrictions on the athlete and each family member (migration **v33**); meal/swap/recipe
  prompts hard-exclude declared allergens (safety) and add optional kid-friendly household mods
- **One-command quickstart** — `./quickstart.sh` (Docker-or-Node) + `scripts/quickstart-rpi.sh`
- **Cloud sandbox** — portable `.devcontainer/` + `docs/SANDBOX.md` (Daytona / Codespaces / Gitpod)
- **iCal plan export** — `GET /api/plan.ics` + MCP `get_plan_ics`; subscribe-able weekly plan (pull-not-push)
- **Last-night sleep/HRV in the Brief** — `repo.latestSleep()` names last night's architecture in plain words
- **Optional rate limiting** — per-IP fixed-window cap on `/api` + `/mcp`, gated on `CAIRN_AUTH_TOKEN`
  (`CAIRN_RATE_LIMIT` / `CAIRN_RATE_WINDOW_MS`)
- **Reference indexes** — generated `docs/API.md` (147 routes) + `docs/MCP-TOOLS.md` (121 tools) via
  `npm run docs:index`
- **Apple Health / Oura / Whoop** — `docs/APPLE_HEALTH.md` Shortcut guide for `/api/health-metrics`
- **Backup template** — `scripts/backup-example.sh` (cron-friendly, rotates exports + DB snapshots)
- **Supplement understanding** (not a daily log) — say it once in plain words ("creatine daily, omega-3,
  some D, whey occasionally"); a deterministic KB approximates name/dose/cadence + the markers each touches
  and the connected brain folds it into meals/training/marker reads. Chat `log_supplement`, `/api/supplements`,
  MCP tools, and a "What you're taking" card in Me→Health
- **Frictionless onboarding** — first run is one optional free-text intro (or Skip) → `/api/onboard`
  understands + applies profile/about-me/supplements/injuries/memories in one pass; no question barrage

### Changed
- **Information architecture & desktop** — the elite-launch IA restructure plus a responsive
  **two-column desktop layout**, so the phone-first PWA uses the wider screen on a laptop
- **Proposals UX** — applying a training proposal now retires its sibling open drafts (server-side
  `superseded`, distinct from a user discard), older Coach items fold behind a "Show earlier"
  disclosure, an applied proposal shows a clear "✓ Applied to your plan" confirmation, and
  plan-proposal drafting runs through an elite async loader instead of blocking
- **Modular frontend & data layer** — the two largest files were split for maintainability,
  behavior-preserving: `public/app.js` (~10k lines) → ten ordered modules under `public/js/`
  (`01-core` … `10-boot`), loaded as classic scripts that share one global scope (no bundler;
  the split concatenates byte-identical to the original); `src/repo.ts` (~7k lines, 251 exports)
  → 14 domain modules under `src/repo/` behind a re-export **barrel**, so external `./repo.js`
  imports are unchanged. Verified by `tsc` + 185 tests + 21 smoke assertions + an in-browser
  pass over every tab. PWA cache `cairn-v70`
- `package.json` — removed `private: true` for public OSS signal
- `CLAUDE.md` — schema version (v34), new surfaces, and service-worker version kept current
- **E1 closed by design** — in-app food-photo logging already lives in Chat (camera → `/api/chat` →
  the agent reads the plate, emits `log_food`, note written with the photo attached) and is
  **deliberately scoped there**: photo/voice capture is occasional and as-needed, not spread across
  surfaces; food shown elsewhere is **inspiration, not a "log this" button**
- Removed the orphaned `maybeBuildStarterPlan` (dead since the onboarding rewrote first-run as one
  free-text intro); doc-drift fixes

### Fixed
- **Onboarding** — first-run is a calmer hybrid: a few quick taps (age, training days/week, a
  goal) plus one optional free-text note, composed into a single intro through the agentic
  `/api/onboard` (nothing is lost without an agent — the endpoint keeps a deterministic base).
  Replaces a single free-text box whose welcome line rendered as a shouty wall of tracked
  ALL-CAPS (a full sentence in the `.modal-sub` kicker style)

### Notes
- **Agent CLIs are not version-pinned.** The container installs the latest Claude / Codex /
  Antigravity / Grok CLIs at image-build time (`cairn-update-agent-clis`), and the app can
  self-update them at runtime. Chat token-streaming is verified for Claude and Grok (Grok 0.2.51);
  Codex delivers only a complete `item.completed` (no token deltas) and Antigravity has no headless
  streaming flag, so both stay one-shot. Pin via the Dockerfile `INSTALL_*` build args if you need a
  reproducible CLI set.

## [0.3.0] — 2026-06-16

### Added
- **Today "Lately" feed** — strength sessions and cardio activities merged, newest-first;
  Garmin-linked rows carry HR zones, effort, and body-reaction detail
- **Chat history overlay** — scrollable read-only past conversations; left-aligned bubbles
- **Streaming chat** — token streaming for Claude and Grok headless CLIs; durable
  `chat_turns` queue survives reload/restart
- **Workout lifecycle** — finished-session done card, tap-to-edit history, `reopenSession`,
  `updateSet`, `deleteExercise` guards
- **Trust layer** — apply-path clamp guardrails, evidence surface, agent health telemetry
- **Connected brain** — marker trends/forecasting, directive feedback memory, proactive
  scheduler (pull-never-push)
- **120-test** offline harness covering constitution-critical cores

### Changed
- Service worker auto-activates on deploy (`skipWaiting` + one-shot reload)
- PWA cache `cairn-v61`

### Fixed
- Chat strips agent tool-narration before the reply marker reaches the bubble
- Segmented sub-nav scrolls when pills overflow (no clipped "Calendar" tab)

[Unreleased]: https://github.com/zilet/cairn/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/zilet/cairn/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/zilet/cairn/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/zilet/cairn/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/zilet/cairn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/zilet/cairn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zilet/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zilet/cairn/releases/tag/v0.3.0

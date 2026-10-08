# Cairn IA + component architecture (approved 2026-10-06)

## Approved decisions
1. "Your path" (race estimate, weight + deadlift goals, trail) moves from Today to the Horizon landing. Today keeps ONE glance line ("26 days to Cambridge · Sharpen, wk 6 of 6 ›") that opens Horizon.
2. The KM/MI toggle leaves Horizon. ALL units are controlled from Settings (one Units group). Distance (km/mi) exists; add weight (lb/kg) and design the foundation so any further unit (height, pace-per-unit, temperature, energy) is a one-place change.
3. Today keeps the "What's ahead" week strip as a quick GLANCE (no summary line owned by it — Horizon owns the week summary sentence). Tap a chip -> day peek inline.
4. Horizon keeps three segments (Week, To the race, Season); WEEK is always the default landing (never remembered per session) and is a DESIGNED page with real information + visualization (frame hero, week shape bars by planned load, still-open sessions, next milestones, compact goals). Richer visuals welcome (race ladder, load shape, goal progress) — calm, no numeric scores.
5. Weight/units: one server formatter + one client formatter, driven by settings; routes through weightWords now, kg supported.

## Principles
1. One home per fact: one owner surface shows it in full; elsewhere at most a one-line glance that links to the owner.
2. Glance -> peek -> page. Every object has all three; the same component renders each level.
3. Present focus first, by horizon: Today = now; Horizon = shape of time (week, block/race, season); Train = is it working (trajectory); Ask = conversation + what changed; You = whole picture, health, settings.
4. One server line per concept (stage word, week summary, weight trend, today's lift, countdown, new bests). Renderers frame it; they never rebuild it.
5. Units and dates follow the athlete everywhere: server writes prose in the athlete's units; every number through one formatter, every date through one date-words function; NO raw ISO date ever renders; no per-surface unit toggle.
6. Same verb, same action: a day chip opens the day peek; a day row opens the day page; Back returns to the opener; "›" always means deeper.
7. Calm surfaces scale with news: a card with nothing new collapses; a repeated fact is a bug. No scores, no metric walls; meaning-first sentence leads every block.

## Tab model
| Tab | Job | Tier 1 | Tier 2 (expand in place) | Tier 3 (page) | Does NOT show |
|---|---|---|---|---|---|
| Today | What this day is + the one next move | Brief (headline, why, today's lift, Start/Log); week strip glance | day peek from a strip chip; why; Fuel today | Session, Fuel, Day page | path trail, Coming up, This block, goals board -> one Horizon glance line |
| Horizon | Shape of time ahead + where you stand | frame hero + week shape | week rows; milestone details | Day, Race build, Goal line, Checkup | today's session detail, muscle balance, intake |
| Train | Is the training working | Where to focus (headline WITHOUT new bests); What moved | Why/the move; muscle-balance rows | History, Lift trends, Volume, Endurance, Program editor, Body, Fuel trends | the Today card (delete it); the week list; the race countdown |
| Ask | Talk to the team + see what it changed | Thread | food chip, ripple card | Changes feed (only full home; Today shows one glance line with a count) | |
| You | The whole cairn, health, about you, settings | Stones (glance) | stone peek | Health pages, Records, Settings (units live here) | training trajectory |

## Drill-down grammar (one controller, CairnDrill)
- Inline expand: disclosures inside a card (aria-expanded), no URL change.
- Peek: compact view of an object (day, exercise, milestone, marker); inline under a strip on Today or a sheet elsewhere; adds ?peek= to history so Back closes it; always ends with one "Open full ›".
- Page: canonical home-free URL per object: /app/day/:date, /app/exercise/:id, /app/race, /app/goal. The tab bar keeps the OPENER's tab lit. Back = history.back() falling back to the opener tab root; back label = opener's name (state.drillFrom). Old URLs (/app/horizon/day?date=) keep working via route-state.ts aliases.

## Shared objects
- Day: one DTO (/plan/day-detail DayDetail) + one view family day-detail-* with variant chip|row|compact|full. Chip/row come from the same model so lift/run words are identical on Today, Horizon, Program.
- Week: new server WeekRead (GET /api/week?start=, built on planWeek; /plan/week stays as alias): frame {stage word, block week, countdown} from ONE weekFrameLine(); summary one sentence; totals {lift days done/planned, run distance done/planned} already in athlete units; days: DayChip[]; load_shape per-day planned dose as a WORD + relative height (never a number). One week-strip component with variants glance (Today) and shape (Horizon), plus a week-list row variant for Program.

## Horizon landing (Week segment — default always)
1. Frame hero: "26 days to Cambridge Half"; one line under: "Sharpen · block week 6 of 6 · push through Nov 15" (single source of stage words).
2. Your road (journey-trail-client.ts, GET /api/week `journey`): the Path trail, moved here from Today — to scale in time from where the stretch began, through today, to the furthest dated goal (the summit). One calm line of where the athlete stands, tappable marks (the next one open), "Behind you" (what already moved toward a goal). Nothing dated ahead (this week only): a starter with one-tap openers that hand chat a first sentence, never sent for the athlete.
3. This week's shape: 7 columns with stone-coloured bars sized by planned dose; today pinned/outlined, done ticked, open key sessions hollow; the week's one summary sentence under it (owned here). Column tap -> day peek; row tap/"Open day" -> day page.
4. Still open this week: at most 2 lines.
5. Next up: next 2-3 milestones beyond this week (same milestone-row component as Season). "All of the season ›".
6. Goals compact: race estimate WITH its time, weight trend, deadlift (goal-row moved from Today's Path card).
Segments: Week = shape of this week; To the race = week-by-week ramp (keeps the ladder chart; KM/MI toggle removed; hero replaced by the shared frame line); Season = months: goal line, labs, scans (dedupe lab rows: one per draw).
Relation to Today: Today shows the week strip glance + one Horizon glance line; Horizon never shows session detail, the Brief or Fuel.

## Component architecture (DRY / modular / separation of concerns)
Server (prose already in athlete units):
- src/repo/display-words.ts (new, the one server formatter): distanceWords(km, units), paceWords(secPerKm, units), weightWords(lb, units), dateWords(iso, today, style), sinceWords(iso, today); KM_PER_MI defined once. Every prose builder takes units from settings (day-detail segments+intent, race-build focus, coaching-focus changes, today-path, plan-week summary).
- weekStageWord(date)/weekFrameLine(date): ONE stage vocabulary resolving RACE_WEEK_WORD against phase words; consumed by day-detail week.race.word, plan-week, today-path, race-build, coaching-focus block_line.
- weightTrendRead(): one rate + one on-pace verdict for Path, Body, Season, What moved (today four different figures exist).
- Machine dates are *_date/date; athlete-facing text never contains ISO dates; companion *_words fields (e.g. changed_since[].since_words).
Client layers:
| Layer | Files | Rule |
|---|---|---|
| Format | ui-format.ts (merges display parts of format-utils + date-utils): CairnFmt.distance/.pace/.weight/.date(iso,{style})/.relDay | only place 1.609344 and toLocaleDateString may appear; delete the 4 copies in day-detail-model, race-week-model, race-week-runs-model, horizon-terrain-client and the inline one in today-strip-client; merge relativeWords/daysBetween (day-detail-model + day-record-client); retire runWords once server writes miles |
| Models (pure) | week-model.ts (replaces horizon-week-model + strip model), day-detail-model.ts, milestone-model.ts, goal-row-model.ts | DTO in -> view-model out; never fetches/touches DOM/state; never compares dates to build a status |
| Views | week-strip-client.ts (glance/shape), week-list-client.ts, day-detail-client.ts (chip/row/compact/full), milestone-row-client.ts, goal-row-client.ts, frame-line-client.ts | deterministic *Html(model, opts); escaped; no unit/date logic |
| Controllers | week-controller.ts (fetch /week SWR, paint, delegate), day-detail-controller.ts, drill-controller.ts (CairnDrill.open(kind,id,{from,mode}), history/back) | fetch+paint only; CairnUiActions.mount; token + isConnected checks |
| Screens | today-screen, horizon-screen, progress-screen | compose slots only |
Naming: keep flat src/client + suffix contract; prefix = the OBJECT (week-*, day-*, milestone-*), surface-specific modules keep today-*/horizon-*/train-*.
Bundles (eager 220 KB brotli, ~1.4 KB headroom): rename lazy `day` bundle -> `calendar` (week/day models+views+controllers, milestone+goal rows, drill-controller); today-ahead, horizon, train reach it via withBundle("calendar"). Only ui-format.ts is eager and must be byte-neutral or smaller than the code it replaces.
Rules: (1) no renderer derives state, no new Date/Date.now in *-client.ts; (2) one formatter for units and dates; (3) one drill controller (nothing else calls activateTab("day") or builds a day URL); (4) a fact's full form lives only in its owner component, glances take {line, href} from the server; (5) no regex rewriting of server prose on the client; (6) file size limits per DESIGN.md.
Units foundation (new, from the athlete): settings gains a Units group — distance (km|mi, exists as run_units), weight (lb|kg, new weight_units), designed so more units slot in (one registry: unit kind -> options -> server formatter + client formatter). Settings is the ONLY writer; every surface reads. Garmin/Apple data stays canonical metric/lb internally; conversion only at the formatter edge.

## Contract tests (deterministic; DOM harness + static scans)
1. noRawIsoInText: render every exported *Html from fixtures, walk textContent, fail on /\b\d{4}-\d{2}-\d{2}\b/; static twin bans escHtml(<expr>.since|.date|.until) without CairnFmt.
2. unitsFollowAthlete: seed run_units='mi' (and weight_units='kg'), build dayDetail, raceBuild, coachingFocus, todayPath, planWeek, WeekRead, deep-scan every string field not named *_date/key; fail on /\d\s?km\b|\/km\b/ (mi athlete) and the mirror for lb/kg; client twin renders endurance views with a mi fixture; grep test: 1.609 occurs in exactly one client file and one server file.
3. noDoubleUnit: fail on /\b(lb|kg|km|mi)\s*\1\b/i and /\dlb lb/ in any rendered fixture.
4. oneHomePerFact: src/contracts/fact-owners.ts maps fact key -> owner component + allowed glance components; render Today, Train, Horizon from one seeded fixture; fail if a sentence of 8+ words appears twice within a screen or the owner's sentence appears in full on a non-owner screen.
5. oneStageWord / oneWeightTrend: one fixture; every surface's stage word from weekStageWord(); every printed weight rate equal.
6. drillGrammar: static scan: day URLs and activateTab("day") only inside drill-controller; harness: open a day page from Horizon, Back, land on Horizon.
7. staleNoteGuard: in a non-deload resolved week no day-detail exercise note starts with "Deload".

## Audit findings still to fix (beyond the already-fixed ones)
Duplicates: the week x4 (Today strip, Horizon Week, Program "The week ahead", Train "2 of 5 sessions"); today's lift line x6 (Brief, strip, Horizon, Program, Train TODAY card, You Strength stone — Train TODAY card adds nothing: delete); new bests x3 on Train (headline [fixed], What moved, strip/session card); race/goal milestones on Today Path + Today Coming up + Horizon Season; this week's mileage three ways (strip "~31 km", Horizon race "3.8 of 19.3 mi", Train adjustments "~31 km"); "deload set aside" on Today This block + Train block line (twice in one sentence); push stance on Brief + Train focus + Today "What the team did"; Season lab rows x3 identical.
Conflicts: units (km vs mi across surfaces); stage word (SHARPEN / Build week / "Three weeks of build…" vs "Sharpen" chip); weight trend four figures (-0.93 Path, -0.9 Body, -0.87 Season, "1.0 lb lower" What moved, "needs -0.98") -> one weightTrendRead; new bests count 3 vs 4; Today card "Training shaped by your labs" is really HRV and contradicts Body & recovery; OHP target 95->105 (Program) vs "+25 lb reaches advanced" (focus); Fuel tab header reads "Intake", Body tab header "Weight"; <main> aria-label stays "Horizon" on Train while loading.
Visibly wrong: "159.6lb lb" (unit twice) in Body & recovery; Season headline "Leaning-out phase / since Sep 25 / toward 154 lb" raw slashes (also Train Journey link); garbled "NOV 17 – JAN 12, 27"; bare caveat "Head blurriness on walks" on a Pull/threshold day with no why; Train muscle label "Chest stalling … in the productive range" contradictory; a session titled just "Session"; Horizon opens cold on "To the race" skeleton and default varies with session memory (chosenView); day page under Horizon tab has back link "‹ Today".
Orphans: Fuel tab food-quality wall (no owner read, no meaning-first sentence); finish estimate "Fits" on Horizon shows no time (time only on Today Path); Today "This block" card has no drill-down to Program; "Coming up · FOCUS: 25-OH VITAMIN D & RECOMPOSITION" kicker leads nowhere; KM/MI toggle (write control on a read surface).

## Implementation streams (agents do NOT commit; one heavy job at a time via `heavy`; no lint; no full suite on the Pi; targeted single test files each with own mktemp -d)
S1 Server words + units foundation (display-words.ts, weekStageWord/weekFrameLine, weightTrendRead, WeekRead + /api/week, since_words, units registry + weight_units setting + settings API, prose builders take units, stale-note guard extension). S2 Client format foundation (ui-format.ts, delete unit/date copies, "159.6lb lb", Settings Units group UI, retire runWords). S3 Day + drill (route-state /app/day/:date + aliases, day-open-client, drill-controller, day-detail variants, "Open day ›", build-client `day`->`calendar`, sw.js CORE_ASSETS, index.html preload regeneration). S4 Horizon landing (Week segment design above, week-model/week-strip shape, milestone-row, goal-row lifted from Today Path, To-the-race hero -> frame line, Season lab dedupe, KM/MI toggle removed). S5 Today/Train dedupe (Today composition: Path card + Coming up -> one Horizon glance line, This block card, labs-card title, Train TODAY card + "2 of 5" removed, Fuel/Body header titles, aria-labels; update tests that expect removed cards). S6 integration/QA in Mac Chrome (390px; compare with audit shots in ~/.cache/tmp/ia-audit; no writes).
Order: S1 || S2 -> S3 -> S4 || S5 -> S6.

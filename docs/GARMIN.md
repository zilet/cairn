# Garmin Integration

Cairn treats Garmin as one input source. It does not make Garmin the plan authority:
manual lifting logs remain the source of truth for strength progression, while Garmin
activities and recovery metrics inform load, fatigue, conditioning, and goal context.
For parallel strength tracking, Cairn is the workout ledger and Garmin is the sensor
layer feeding heart-rate, recovery, and body-response context into the connected brain.
For a same-day strength session that already has Cairn-logged sets, reconciliation
keeps those exact exercises and sets authoritative and adds only Garmin physiology
(duration, heart rate/zones, calories, and training effect) plus an optional narrative.
Garmin-detected sets are imported only when the session is still empty as its queued
strength job begins. An empty session stays pending between reconciliation and that
job, so any Cairn sets logged in the interval become authoritative. Empty or unusable
watch set data does not resolve that pending state: with enrichment unavailable, an
agent failure, or no usable agent fallback, a later Cairn log can still win. A richer
later watch sync becomes watch-authoritative only if the session is still empty when
its usable set batch is committed. Set batches and their per-activity import markers
commit atomically, so a failed batch is safe to retry. The resolved watch-only policy
is preserved across later re-syncs. Legacy linked sessions without an authority marker
resolve conservatively: any existing sets make Cairn authoritative because their
provenance cannot be established safely.

## Current Local Connector

The local experimental connector uses the unofficial `garmin-connect` Node package.
It is intended for self-hosted personal use and pilots where every user explicitly
provides their own Garmin credentials.

Environment:

```bash
GARMIN_USERNAME="you@example.com"
GARMIN_PASSWORD="..."
# optional; defaults to data/garmin-token
GARMIN_TOKEN_DIR="/path/to/token-dir"
```

You can also enter the Garmin email/password in the PWA Settings tab. Saved
settings override `GARMIN_USERNAME` / `GARMIN_PASSWORD`; blank secret fields in
Settings preserve the current saved/env value. For the lowest plaintext exposure,
prefer env vars. If you use Settings for the password, set a stable
`CAIRN_SETTINGS_SECRET_KEY` in `.env`; Cairn will store new Settings secrets
encrypted at rest and will seal older plaintext rows the next time settings or
Garmin credentials are read. Keep that key backed up: if it is lost, encrypted
Settings secrets must be re-entered.

Manual sync:

```bash
npm run garmin:sync -- --days=30 --limit=100
```

REST/MCP:

- `POST /api/garmin/sync` with `{ "days": 30, "limit": 100 }`
- `GET /api/garmin/summary`
- MCP tools: `sync_garmin`, `get_garmin_summary`, `upsert_garmin_activity`,
  `upsert_garmin_daily_metric`

The connector stores token files under the data volume so rebuilds keep the session.
If Garmin changes login, MFA, or anti-automation behavior, the unofficial connector may
fail. The normalized tables and API are deliberately separate so an official Garmin API
adapter can replace it later without changing the coach model.

## Data Model

- `garmin_sources`: connector state, mode, status, cursor, and token JSON if needed.
- `garmin_activities`: normalized Garmin workouts, deduped by provider external id.
- `garmin_daily_metrics`: normalized all-day/recovery metrics by date.
- `activities.source/external_id`: mirrored Garmin activity row so existing calendar,
  streak, and cardio-load behavior keeps working.

### Full dataset (migrations v22–v23, v45–v46)

The sync mines the rich response Garmin already returns plus a handful of the
connector's internal endpoints. **Every field is best-effort and null-safe** —
each lives in its own `try/catch`, so a missing endpoint (or a device that doesn't
record a metric) degrades that field to `null` rather than failing the sync. The
full provider payloads are still preserved in `raw_json` for re-derivation.

The internal endpoints key on the account's GUID-style **displayName**. The sync
resolves it from the package's profile call, falling back to the social-profile
endpoint and then the activity payloads' `ownerDisplayName`/`ownerId` — a null
displayName no longer silently skips the entire daily-summary block (the bug that
left stress, body battery, calories, HR extremes, SpO₂, respiration, intensity
minutes, floors, and distance all null). Internal `client.get(...)` calls log a
warning on unexpected failures (URL + message) so a wrong-path vs device-doesn't-
report endpoint is diagnosable rather than invisibly degrading. The experimental
skin-temperature endpoint is disabled by default because the underlying connector
prints Garmin's 404 before Cairn can quiet it; set `GARMIN_SKIN_TEMP_ENABLED=1`
to test it on a device/account that is known to report the metric.

`garmin_daily_metrics` now captures, where the device/account reports it:

- **Sleep architecture**: total + deep/light/REM/awake/nap minutes, restlessness,
  average sleep stress, sleep score. (from `getSleepData`)
- **Heart**: resting HR, daily max/min HR, last-7-day avg resting HR. (sleep + daily summary)
- **HRV**: overnight average + status (balanced/unbalanced/low). (`getSleepData` + `/hrv-service`)
- **Stress & Body Battery**: avg/max stress, body-battery high/low/charged/drained.
- **Respiration & SpO₂**: avg/min/max respiration, average + lowest pulse-ox.
- **Skin temperature**: overnight skin-temp deviation, opt-in via
  `GARMIN_SKIN_TEMP_ENABLED=1` until the endpoint is verified for the account.
- **Energy & movement**: steps, distance, floors, active/total/BMR calories,
  moderate + vigorous intensity minutes.
- **Fitness**: VO₂max (running + cycling), training readiness, training status,
  acute load, fitness age. (`/metrics-service`; fitness age from the dedicated
  `/fitnessage-service/fitnessage/{date}` endpoint — the maxmet payload only
  carries VO₂max.)
- **Runner performance** (migration v45): race-time predictions (5K / 10K / half /
  marathon, in seconds), endurance score, hill score, and a training-load-balance
  feedback phrase. (race predictions, endurance score, hill score, and the
  training-status aggregate under `/metrics-service/metrics/...`)
- **Body composition**: weight, body-fat %, muscle mass, body water %, bone mass,
  BMI, visceral fat. (from `getDailyWeightData`)
- **Richer sleep**: when the package's `getSleepData` returns a reduced DTO,
  `sleep_score` / `avg_sleep_stress` / `restless_count` are gap-filled from
  `/wellness-service/wellness/dailySleepData/{displayName}`.

`garmin_activities` now also captures per-workout body reaction: moving time,
elevation loss, aerobic + anaerobic training effect (and label), cadence, power
(avg/max/normalized), speed, ambient temperature, activity-level VO₂max, and the
**HR time-in-zone breakdown** (`hr_zones_json`, one bounded detail call per recent
activity — see `GARMIN_HR_ZONE_LIMIT`, default 20). Migration v46 adds list-payload
richness (`steps`, `avg_stride_len`, `min/max_elevation_m`, `lap_count`) plus
**running dynamics** (`avg_ground_contact_ms`, `avg_vertical_osc_cm`,
`avg_vertical_ratio`) and the per-activity **training load** — the last three come
from one bounded `/activity-service/activity/{id}` detail call per recent activity
(`summaryDTO`), since the list payload omits them.

Tunables: `GARMIN_SYNC_DAYS` (activity lookback, default 30), `GARMIN_SYNC_LIMIT`
(activity count, default 100), `GARMIN_HR_ZONE_LIMIT` (per-activity HR-zone fetches,
default 20), `GARMIN_DETAIL_LIMIT` (per-activity detail fetches for training load +
running dynamics, default 20). Daily wellness is fetched for the most recent
`min(days, 14)` days.

The coach receives a compact summary (it never sees the raw rows):

- recent activity volume by type, with hard/long sessions + their HR zones / training effect
- sleep (with deep/REM), resting HR, HRV + status, stress, Body Battery, respiration,
  SpO₂, skin-temp deviation, training readiness, VO₂max + training status, and body
  composition where available
- runner performance: race-time predictions, endurance score, hill score, and the
  training-load-balance phrase (latest non-null) where available
- source status and last sync

## Strength Write-Back (Cairn → Garmin)

Garmin is the INPUT for runs, sleep and recovery, and that stays true. Strength is the
one thing that also travels the other way: an athlete who lifts with Cairn on their
phone had a blank strength history on Garmin, and one who started the watch got a
recording with no exercises in it. So a **finished** Cairn strength session is pushed
back as that day's exercise sets (`src/garminExport.ts`), in one of three shapes:

1. **Cairn-only** (no watch activity that day) — Cairn creates a manual strength
   activity (`POST /activity-service/activity/manual`) and writes the sets onto it. The
   activity is mirrored into `garmin_activities` and reconciled, so the day shows ONE
   strength activity and a later real sync of the same id updates that row.
2. **Parallel** (Cairn sets AND a same-day Garmin strength activity) — the sets are
   written onto the EXISTING watch activity, in place. Never a second upload: the
   watch's heart rate, duration and calories are the physiology worth keeping, and a
   duplicate activity would double-count the day everywhere Garmin aggregates.
3. **Garmin-only** (`sessions.garmin_json.cairn_sets_authoritative === false`) —
   Garmin's own detected sets are the truth for that day and are never overwritten.

And one repair: if a manual activity was created and the watch's own recording of the
same workout syncs afterwards, the sets move onto the watch activity, the manual shell
is deleted, and `export` retargets to the watch id. The day ends up with one activity.
Heart rate and calories rank *which* watch recording is the richer home; they do not
gate the move — a watch activity with no HR still owns the day.

**The endpoint is UNOFFICIAL** — `PUT /activity-service/activity/{id}/exerciseSets`, on
the same undocumented connectapi surface the read path already uses. Every failure is
therefore a quiet no-op: the Cairn log is the record of truth and a write that didn't
land costs nothing but a retry on the next sync. A create that lands and a PUT that
then fails is remembered locally so the retry writes onto the same activity rather
than inventing a second one.

**FILL vs REPLACE.** When writing onto a watch activity Cairn first GETs the existing
`exerciseSets`. If the watch recorded *exactly* as many plausible ACTIVE slots
(duration ≤ 600 s) as Cairn logged sets, the exercise/reps/load are written INTO those
slots — the watch knows *when* each set happened, which is evidence Cairn does not have
— and REST periods are left exactly as they were. A timed hold overlays its logged
duration onto the slot. A mismatch (three logged sets onto an eight-set watch session)
is REPLACE: one ACTIVE slot per Cairn set, spread across the session span. A positional
fill of the first N would relabel the wrong lifts.

**Lookback.** `finishSession` exports the session just finished. A Garmin *sync* only
enqueues finished sessions from the last 7 days, so turning the (default-on) toggle on
does not silently backfill a month of history into the athlete's Garmin calendar.

### Backfilling history

The 7-day lookback is a guard, not a limit: an athlete who *wants* their whole Cairn
strength history on Garmin gets it explicitly, through `POST /api/garmin/export-backfill`
(MCP: `garmin_export_backfill`, `src/garminExportBackfill.ts`). It is batched and
**dry-run first**.

A dry run (the default) touches no network and enqueues nothing. It walks the eligible
finished sessions **oldest first** — `since` / `until` scope the window, `limit` caps the
batch (default 25, clamped 1–100) — and reports for each one its date, set count, how
many sets actually map onto the FIT catalog, the lifts that don't, the linked watch
activity if there is one, the activity the sets would land on (`target_activity_id`), the
shells it would withdraw (`surplus_activity_ids`), the prior export record, and `planned`:
`unchanged` / `fill_or_replace` / `create` / `retarget` (the sets move onto the watch's own
recording and Cairn's shells are withdrawn) / `drop_surplus` (nothing is rewritten; only a
surplus shell is removed) / `skip_no_mapped_sets`. `total_eligible` and `remaining` say how
much history is left to walk.

`planned` and `predicted_fingerprint` are a PREDICTION. `planned` **calls the exporter's own
target decision** (`planGarminExportTarget`) rather than restating it — a second copy of
those rules is how a preview starts lying about retargets and orphaned shells — but a watch
recording can sync or a set can be edited between the preview and the job, in which case
`exportSessionToGarmin`'s answer wins. It stays the single authority; nothing here writes to
Garmin itself.

`{apply: true}` enqueues every session that is not `unchanged` or `skip_no_mapped_sets` as
ordinary `garmin_export` jobs,
oldest first, so the serial enrichment queue paces the writes and Garmin's calendar fills
forward in time.

`{refine_unmapped: true}` additionally hands the movements in the batch to the agentic
`exercise` enrichment pass (the prompt carries the FIT candidate shortlist;
`applyExerciseEnrichment` validates the pick). **Two cohorts qualify**, reported with a
`reason` in `refine_candidates` / `refine_queued`:

- `unmapped` — the catalog could not place the lift, so it is silently missing from every
  export.
- `never_enriched` — `exercises.enrichment_status IS NULL`: the row was created before the
  background cleanup was wired up, so its name was never canonicalized and its group and
  equipment were never classified. An install of that vintage carries a tail of raw names
  ("Seated leg press - machine", "Single arm DB pulls"), and tidying one is often exactly
  what lets the catalog place it on the next pass — so a mapped-but-unenriched lift is a
  candidate too. The job is idempotent and the rename is identity-guarded, so re-queuing
  costs nothing.

Queueing goes through `queueExerciseEnrichment`, which stamps `enrichment_status` to
`pending` and enqueues, and it is gated on both `enrich_enabled` and `apply` — spending an
agent is a real action a dry run must not take. A dry run still lists both cohorts in
`refine_candidates` and stamps nothing.

The toggle and the credentials gate the whole run: with either missing the result is
`{ok:true, skipped:"export_disabled"|"garmin_not_configured"}` — the exporter's own
vocabulary.

**Mapping.** Garmin's strength model is a two-level FIT enum (a category such as
`BENCH_PRESS` plus an optional sub-exercise such as `BARBELL_BENCH_PRESS`), and an
unknown member 400s the whole payload. `src/repo/garmin-exercise-map.ts` resolves a
Cairn name against a checked-in catalog (`src/garmin-exercise-catalog.json`, 1527 rows
across 47 categories) — exact, token-key, fuzzy, or category-only — and never invents an
enum. The pair is stored on `exercises.garmin_category` / `garmin_exercise` /
`garmin_map_status` at insert, with no agent involved, so write-back works on a fresh
offline install. The long tail the catalog cannot place is offered to the `exercise`
enrichment agent as a shortlist it must choose from (or return null for), validated
again by `isValidGarminRef` before it is stored. A lift that still has no mapping is
simply left out of the payload; if NOTHING maps, the export is skipped whole. On a 400
the PUT is retried once with the sub-names dropped, since a bare category is always
legal.

Weight on the wire is **grams**. Cairn's encodings survive: a negative weight (assist)
and a null (bodyweight) both send no load at all, and a timed exercise sends a duration
with no reps.

**Idempotency.** A successful write is recorded on `sessions.garmin_json.export` as
`{ activity_id, source: "watch"|"manual", fingerprint, exported_at, mode }`. The
fingerprint is a stable hash of the ordered logged sets and their mapping, so a
re-finish, a re-sync or a scheduler pass over an unchanged session skips before touching
the network — while editing one rep re-exports.

**Toggle.** Settings → Sources → Garmin Connect → "Send finished strength sessions back
to Garmin" (`settings.garmin_export_strength`, default ON; also settable via MCP
`set_settings`). Off, nothing is ever written. The work runs on the serial enrichment
queue as the `garmin_export` kind — enqueued by `finishSession` and by `syncGarmin` for
finished sessions in the sync window — and is deliberately independent of
`enrich_enabled`, since it is deterministic and involves no agent.

## Official Garmin API Request

Garmin's Connect Developer Program is the right official path for any shared,
team, organization, or commercial deployment. Position the deployment truthfully:
if it is a private pilot, say that; if it is a wider hosted product, do not
borrow the private-pilot language below.

Example private-pilot application framing:

> Cairn is a private, internal training and wellness coaching application used by our
> company team and invited coworkers. It combines user-authorized Garmin activity and
> recovery data with manually logged strength training, nutrition notes, and training
> goals to provide individualized coaching recommendations. Garmin data is used as an
> input signal for workload, recovery, endurance activity, and body metrics; users can
> review and export their data, and no Garmin data is sold or used for advertising.

Ask for these APIs:

- **Activity API** for run, cycling, MTB, walking/hiking, cardio, and strength activity
  summaries plus FIT/original activity files where available.
- **Health API** for all-day metrics: sleep, heart rate/resting HR, stress, Body Battery,
  steps, calories, body composition/weight, HRV if available to the program.
- Optionally **Training API** later if Cairn should send structured workouts back to
  Garmin. Do not ask for this in the first request unless planned write-back is real.

Ask for these scopes/data categories:

- Activity summaries: id, type, sport/subsport, start time, duration, distance, elevation,
  calories, pace/speed, average/max HR, training effect/load, device metadata.
- Activity detail/FIT files: for richer run/cycle/MTB analysis and strength-set parsing
  where Garmin records it.
- Daily wellness: sleep duration/score/stages where available, resting HR, HRV/status,
  stress, Body Battery, steps, active calories.
- Body metrics: weight and body composition when users have supported Garmin data.
- Webhook or push delivery if Garmin supports it for the approved API set; otherwise
  daily/incremental polling.

Answers Garmin will likely care about:

- **Audience:** the actual deployment audience, such as one self-hosted user,
  invited pilot users, employees/coworkers, or a hosted user base.
- **Consent:** each user explicitly connects Garmin and can disconnect at any time.
- **Purpose:** personalized coaching, training-load awareness, recovery guidance, and
  goal progress. No ad targeting, resale, or third-party data brokerage.
- **Storage:** encrypted/token-protected server-side storage in a private deployment;
  least-privilege access; local/self-hosted deployments where applicable.
- **Retention:** user-controlled deletion/export; delete Garmin-derived records on
  disconnect if requested.
- **Security:** HTTPS, private network or authenticated deployment, secrets outside git,
  audit logging for sync jobs, and no raw credential sharing.
- **Scale:** expected initial and later user counts. For a private pilot, say so
  directly; for a public or hosted service, describe that honestly.

Suggested "why Garmin" answer:

> Garmin provides the activity and recovery context that manual gym logs cannot capture:
> outdoor runs/rides, MTB duration and elevation, daily sleep/recovery, resting heart rate,
> HRV, stress, and active calories. Cairn uses those signals to adjust coaching advice to
> the user's declared focus. For a strength-first user, Garmin mainly informs fatigue and
> conditioning load; for a runner or cyclist, Garmin activity trends become central and
> strength training supports the endurance plan.

Do not overstate medical use. Cairn should be described as fitness/wellness and coaching
support, not diagnosis, treatment, or clinical decision-making.

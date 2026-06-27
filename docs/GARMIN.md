# Garmin Integration

Cairn treats Garmin as one input source. It does not make Garmin the plan authority:
manual lifting logs remain the source of truth for strength progression, while Garmin
activities and recovery metrics inform load, fatigue, conditioning, and goal context.

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
minutes, floors, and distance all null). Every internal `client.get(...)` now
**logs a warning** on failure (URL + message) so a wrong-path vs device-doesn't-
report endpoint is diagnosable rather than invisibly degrading.

`garmin_daily_metrics` now captures, where the device/account reports it:

- **Sleep architecture**: total + deep/light/REM/awake/nap minutes, restlessness,
  average sleep stress, sleep score. (from `getSleepData`)
- **Heart**: resting HR, daily max/min HR, last-7-day avg resting HR. (sleep + daily summary)
- **HRV**: overnight average + status (balanced/unbalanced/low). (`getSleepData` + `/hrv-service`)
- **Stress & Body Battery**: avg/max stress, body-battery high/low/charged/drained.
- **Respiration & SpO₂**: avg/min/max respiration, average + lowest pulse-ox.
- **Skin temperature**: overnight skin-temp deviation (Fenix/Venu/Epix-class only).
- **Energy & movement**: steps, distance, floors, active/total/BMR calories,
  moderate + vigorous intensity minutes.
- **Fitness**: VO₂max (running + cycling), training readiness, training status,
  acute load, fitness age. (`/metrics-service`; fitness age from the dedicated
  `/fitnessage-service/fitnessage/{date}` endpoint — the maxmet payload only
  carries VO₂max.)
- **Runner performance** (migration v45): race-time predictions (5K / 10K / half /
  marathon, in seconds), endurance score, hill score, and a training-load-balance
  feedback phrase. (`/metrics-service/metrics/{racepredictions,endurancescore,hillscore,trainingloadbalance}`)
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

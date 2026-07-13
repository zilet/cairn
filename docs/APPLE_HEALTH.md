# Install the Apple Health Shortcut baseline

Cairn can read your daily wearable data — steps, sleep, resting heart rate, HRV,
active energy — to make the morning **Brief** and the recovery view richer. The
built-in **Shortcuts** app can read permitted samples from Health and POST a daily
summary to Cairn's `/api/health-metrics` endpoint. No native Cairn app is required.

This is an honest builder flow, not a fake one-tap install. Apple documents that shared
shortcut files are exported by Shortcuts and sent to Apple for validation. Cairn cannot
generate or sign that validated file. **Settings → Sources → Apple Health** therefore
opens Apple's empty shortcut editor and copies a personalized build sheet containing
this Cairn's URL and, only after an explicit tap, the access token stored in this browser.
You still add and approve the actions on the iPhone.

> **The honest version:** this is optional and entirely *pull* — Cairn never nags,
> shows no score, and works fine with **no wearable data at all**. The data just lets
> the Brief say "you slept well, HRV's steady" instead of staying generic. If you also
> run a Garmin sync, Garmin is preferred for sleep/HRV/RHR and this fills in the gaps.

The PWA's **Settings → Apple Health** card points here.

---

## What lands where

Each POST upserts one row per day into Cairn's `daily_metrics` table, which feeds
[`GET /api/recovery`](API.md) and the day-read Brief. Rows are unique per
`(source, date)` — re-posting the same day just updates it. The Cairn recipe always uses
`source: "apple_health"`; this keeps the install distinct from older `apple` rows while
the recovery resolver still counts each date/signal once if both exist during an upgrade.

| Field | Meaning | Units / range |
|---|---|---|
| `date` **(required)** | the calendar day these metrics are for | `"YYYY-MM-DD"` |
| `source` | provider tag | use `"apple_health"` for this Shortcut |
| `steps` | step count | integer, 0–200000 |
| `sleep_min` | total sleep | **minutes**, 0–1440 |
| `sleep_score` | sleep score (Apple has none — leave out unless Oura/Whoop gives one) | 0–100 |
| `resting_hr` | resting heart rate | bpm, 0–250 |
| `hrv_ms` | heart-rate variability (Apple stores SDNN) | **milliseconds**, 0–500 |
| `active_calories` | active energy burned | kcal, 0–20000 |
| `total_calories` | total (active + resting) energy burned | kcal, 0–30000 |
| `spo2_avg` | blood oxygen saturation | **percent**, 50–100 (a HealthKit 0.0–1.0 fraction is accepted and normalized to percent automatically) |
| `raw` | any extra JSON you want stored verbatim | object (kept, not parsed) |

Every field except `date` is optional, and junk values are coerced/clamped
server-side — so **omit whatever you don't have**; a missing metric is fine.

The endpoint accepts three body shapes:

```jsonc
// 1) one day
{ "date": "2026-06-16", "steps": 8200, "sleep_min": 437, "hrv_ms": 61, "resting_hr": 52 }

// 2) a batch (good for backfill — up to 366 rows per request)
{ "rows": [ { "date": "2026-06-15", "sleep_min": 420 }, { "date": "2026-06-16", "sleep_min": 437 } ] }

// 3) a bare array (same as rows)
[ { "date": "2026-06-15", "sleep_min": 420 } ]
```

---

## Auth

If your instance has **`CAIRN_AUTH_TOKEN`** set (recommended whenever the port is
reachable beyond `localhost` — see [`DEPLOYMENT.md`](DEPLOYMENT.md)), the Shortcut
must send the token in a header:

- `Authorization: Bearer <token>`
- `X-Cairn-Token: <token>`

Do not put the token in the URL: Cairn deliberately accepts query tokens only on a
small allowlist of GET/download surfaces, not on this POST endpoint. The Settings build
sheet reads the token from this browser only when you tap **Copy build sheet**. It does
not render it into the page or send it back to Cairn. The copied sheet is sensitive;
paste the token into the Shortcut header and then overwrite the clipboard.

On a pure localhost / tailnet instance with no token, no auth header is needed.

---

## Build the iOS Shortcut

On the iPhone, open Cairn → **Settings → Sources → Apple Health**:

1. Tap **Copy build sheet**.
2. Tap **Open Shortcuts**. Cairn uses Apple's documented
   `shortcuts://create-shortcut` URL, which opens a new empty shortcut.
3. Follow the copied sheet and the action details below.

Add these actions:

1. **Date** → `Get current date`, then **Adjust Date** by `-1 day` (most overnight
   metrics — sleep, HRV — settle for *yesterday*; use today for steps if you prefer).
2. **Format Date** → format that date as `yyyy-MM-dd`. Store it (it becomes `date`).
3. For each metric, add a **Find Health Samples** action, filtered to the chosen day:
   - *Sleep:* Find **Sleep** samples for the day → get the total **asleep** duration.
     Convert to **minutes** for `sleep_min`.
   - *Resting HR:* Find **Resting Heart Rate** → average → `resting_hr`.
   - *HRV:* Find **Heart Rate Variability (SDNN)** → average, **in milliseconds** → `hrv_ms`.
   - *Steps:* Find **Steps** → sum → `steps`.
   - *Active energy:* Find **Active Energy** → sum (kcal) → `active_calories`.
   - Optional: distance, exercise time, stand time, total energy burned, oxygen
     saturation, and VO₂ max can map to `distance_km`, `exercise_min`, `stand_hours`,
     `total_calories`, `spo2_avg`, and `vo2max`.
   Skip anything the phone doesn't record or you don't want to share. The first test
   run asks you to approve Health access.
4. **Text** / **Dictionary** → assemble the JSON body using the exact field names
   above and the values from the steps. A **Dictionary** action is the tidiest way:
   keys `source` = `apple_health`, `date`, and only the summaries you found.
5. **Get Contents of URL**:
   - **URL:** `http://<cairn-host>:8787/api/health-metrics`
   - **Method:** `POST`
   - **Request Body:** `JSON` → the Dictionary from step 4
   - **Headers:** add `Authorization` = `Bearer <token>` (only if your instance uses a token)
6. Read the response Dictionary. If `ok` is true, **Show Notification** “Cairn updated”.
   Otherwise **Show Alert** with `errors`. A network failure may stop the web request;
   rerun the shortcut after connectivity returns. Repeats are safe because the endpoint
   upserts the same `(source,date)` row instead of appending duplicates.
7. Test once. Then, optionally, create a **Personal Automation** → *Time of Day* →
   run this shortcut each morning. Apple documents that Time of Day automations can run
   without asking, but personal automations are device-specific and do not sync.

### Quick test with curl

```bash
# no token
curl -fsS -X POST http://localhost:8787/api/health-metrics \
  -H 'Content-Type: application/json' \
  -d '{"source":"apple_health","date":"2026-06-16","steps":8200,"sleep_min":437,"hrv_ms":61,"resting_hr":52}'

# with a token
curl -fsS -X POST http://localhost:8787/api/health-metrics \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"source":"apple_health","date":"2026-06-16","sleep_min":437}'
```

A successful POST returns `{"ok":true,"saved":1,...}`.

---

## Oura / Whoop

Both the Oura and Whoop apps can **write their sleep, HRV, and resting-HR data into
Apple Health**. Once you enable that in each app, the *same Shortcut above* picks those
samples up — no separate integration. Leave the recipe source as `apple_health`; changing
it to `oura` or `whoop` is appropriate only for a separate provider-specific Shortcut.

> Honest caveat: Apple Health is the lowest-common-denominator bridge. Core recovery
> signals carry through cleanly; provider-specific metrics (Whoop strain, Oura
> readiness, etc.) won't — Cairn only models the fields in the table above.

---

## Troubleshooting

- **401 unauthorized** → the instance has a token set and the Shortcut isn't sending it
  (or it's wrong). Add the `Authorization: Bearer …` header.
- **Nothing shows up** → check the `date` format is `YYYY-MM-DD`, and that the host URL
  is reachable *from the phone* (the Shortcut runs on the phone, so the Cairn host must
  be on the same LAN / tailnet — see [`DEPLOYMENT.md`](DEPLOYMENT.md)).
- **Numbers look off** → units matter: `sleep_min` is **minutes**, `hrv_ms` is
  **milliseconds**, and `spo2_avg` is a **percent** (a HealthKit 0.0–1.0 fraction is
  normalized to percent automatically). Most out-of-range values are clamped, not
  rejected — `spo2_avg` is the exception: still-implausible values (below 50 or
  above 100 after normalization) are dropped rather than clamped.
- **A field is missing** → that's fine. Omit any metric your device doesn't record.

---

## What Apple officially supports

- [Find Health Samples is a built-in Find action](https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios), and [Apple documents its support for returning sleep phases](https://support.apple.com/101583).
- [Get Contents of URL supports POST with a JSON request body](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios).
- [`shortcuts://create-shortcut` opens a new empty shortcut](https://support.apple.com/guide/shortcuts/open-create-and-run-a-shortcut-apda283236d7/ios).
- [Shared shortcut files are exported from Shortcuts and validated by Apple](https://support.apple.com/guide/shortcuts/share-shortcuts-apdf01f8c054/ios); Cairn does not synthesize or sign one.
- [Time of Day personal automations can run automatically](https://support.apple.com/guide/shortcuts/enable-or-disable-a-personal-automation-apd602971e63/ios), while [personal automations remain device-specific](https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/ios).
- A native background HealthKit integration would require an iOS/watchOS app with the
  [HealthKit capability, per-type permission, and background-delivery entitlement](https://developer.apple.com/documentation/xcode/configuring-healthkit-access).

---

*To expose the Cairn host to your phone over a private network, see
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md) (Tailscale Serve is the easiest path).*

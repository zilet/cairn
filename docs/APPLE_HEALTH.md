# Pipe Apple Health (and Oura / Whoop) into Cairn

Cairn can read your daily wearable data — steps, sleep, resting heart rate, HRV,
active energy — to make the morning **Brief** and the recovery view richer. There's
no special integration to install: an **iOS Shortcut** reads the numbers from Apple
Health and POSTs them to Cairn's `/api/health-metrics` endpoint.

> **The honest version:** this is optional and entirely *pull* — Cairn never nags,
> shows no score, and works fine with **no wearable data at all**. The data just lets
> the Brief say "you slept well, HRV's steady" instead of staying generic. If you also
> run a Garmin sync, Garmin is preferred for sleep/HRV/RHR and this fills in the gaps.

The PWA's **Settings → Apple Health** card points here.

---

## What lands where

Each POST upserts one row per day into Cairn's `daily_metrics` table, which feeds
[`GET /api/recovery`](API.md) and the day-read Brief. Rows are unique per
`(source, date)` — re-posting the same day just updates it.

| Field | Meaning | Units / range |
|---|---|---|
| `date` **(required)** | the calendar day these metrics are for | `"YYYY-MM-DD"` |
| `source` | provider tag (default `"apple"`) | e.g. `"apple"`, `"oura"`, `"whoop"` |
| `steps` | step count | integer, 0–200000 |
| `sleep_min` | total sleep | **minutes**, 0–1440 |
| `sleep_score` | sleep score (Apple has none — leave out unless Oura/Whoop gives one) | 0–100 |
| `resting_hr` | resting heart rate | bpm, 0–250 |
| `hrv_ms` | heart-rate variability (Apple stores SDNN) | **milliseconds**, 0–500 |
| `active_calories` | active energy burned | kcal, 0–20000 |
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
must send the token. Any of these work; a header is cleanest from a Shortcut:

- `Authorization: Bearer <token>`
- `X-Cairn-Token: <token>`
- `?token=<token>` on the URL

On a pure localhost / tailnet instance with no token, no auth header is needed.

---

## Build the iOS Shortcut

Open the **Shortcuts** app → **+** to create a new shortcut, then add these actions:

1. **Date** → `Get current date`, then **Adjust Date** by `-1 day` (most overnight
   metrics — sleep, HRV — settle for *yesterday*; use today for steps if you prefer).
2. **Format Date** → format that date as `yyyy-MM-dd`. Store it (it becomes `date`).
3. For each metric, add a **Find Health Samples** (or **Get Health Sample**) action:
   - *Sleep:* Find **Sleep** samples for the day → get the total **asleep** duration.
     Convert to **minutes** for `sleep_min`.
   - *Resting HR:* Find **Resting Heart Rate** → average → `resting_hr`.
   - *HRV:* Find **Heart Rate Variability (SDNN)** → average, **in milliseconds** → `hrv_ms`.
   - *Steps:* Find **Steps** → sum → `steps`.
   - *Active energy:* Find **Active Energy** → sum (kcal) → `active_calories`.
   (Skip any your device doesn't record — just leave that field out of the body.)
4. **Text** / **Dictionary** → assemble the JSON body using the exact field names
   above and the values from the steps. A **Dictionary** action is the tidiest way:
   keys `date`, `sleep_min`, `hrv_ms`, `resting_hr`, `steps`, `active_calories`.
5. **Get Contents of URL**:
   - **URL:** `http://<cairn-host>:8787/api/health-metrics`
   - **Method:** `POST`
   - **Request Body:** `JSON` → the Dictionary from step 4
   - **Headers:** add `Authorization` = `Bearer <token>` (only if your instance uses a token)
6. (Optional) **Personal Automation** → *Time of Day* → run this shortcut every
   morning. That's *you* scheduling a pull on your own terms — still not a push from Cairn.

### Quick test with curl

```bash
# no token
curl -fsS -X POST http://localhost:8787/api/health-metrics \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-06-16","steps":8200,"sleep_min":437,"hrv_ms":61,"resting_hr":52}'

# with a token
curl -fsS -X POST http://localhost:8787/api/health-metrics \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -d '{"date":"2026-06-16","sleep_min":437}'
```

A successful POST returns `{"ok":true,"saved":1,...}`.

---

## Oura / Whoop

Both the Oura and Whoop apps can **write their sleep, HRV, and resting-HR data into
Apple Health**. Once you enable that in each app, the *same Shortcut above* picks those
samples up — no separate integration. If you want to keep them distinct in Cairn, set
`source` to `"oura"` or `"whoop"` in the body (otherwise everything files under `apple`).

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
  **milliseconds**. A value out of range is clamped, not rejected.
- **A field is missing** → that's fine. Omit any metric your device doesn't record.

---

*To expose the Cairn host to your phone over a private network, see
[`docs/DEPLOYMENT.md`](DEPLOYMENT.md) (Tailscale Serve is the easiest path).*

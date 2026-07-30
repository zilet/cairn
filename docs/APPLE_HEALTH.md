# Apple Health via Shortcuts

Cairn accepts a daily Apple Health summary from an iPhone Shortcut. This is an
optional input for the Brief and recovery views; Cairn remains fully usable
without it.

## Setup

There is one setup path: install the Shortcut, pair it, then open it once.

**Admin: nothing, by default.** The repository ships the signed, device-validated
Shortcut template at `public/shortcuts/Cairn Apple Health Sync.shortcut`, and the
Install button serves it same-origin out of the box. Setting
`CAIRN_APPLE_HEALTH_SHORTCUT_URL` overrides that with your own published
`https://www.icloud.com/shortcuts/<id>` link or another same-origin `.shortcut`
asset (see *The maintained Shortcut template* below). Whatever is installed, its
name must be exactly `Cairn Apple Health Sync`, or
`CAIRN_APPLE_HEALTH_SHORTCUT_NAME` must carry the real one — **Connect & test
finds the Shortcut by name**, so a mismatch fails on the phone with nothing to
show for it.

**On the phone:**

1. In Cairn, open **Settings → Sources → Apple Health**.
2. Tap **Install Apple Health Sync**. Apple opens the published Shortcut and
   requires you to confirm **Add Shortcut**.
3. Return to Cairn and tap **Connect & test**. Cairn opens the installed Shortcut
   with only this instance's base URL and a high-entropy, one-time pairing code.
   The Shortcut exchanges that code for a dedicated ingest credential, saves it to
   `iCloud Drive/Shortcuts/Cairn/cairn-sync-config.txt`, and stops. It does not
   read Health yet.
4. Open the **Shortcuts** app and tap **Cairn Apple Health Sync** once. This run
   is where Apple asks for each Health permission, and it sends the first daily
   summary. Settings then shows *Last update …* instead of *Waiting for its first
   update*. Until this run happens, Cairn is paired but has no data.
   If iOS shows **“This action is trying to share N Health items, which is not
   allowed”**, that is Apple counting every raw sample behind the daily totals
   (a normal day of steps alone is over a hundred samples). Enable
   **Settings → Apps → Shortcuts → Advanced → Allow Sharing Large Amounts of
   Data** once, then tap the Shortcut again.
5. Optional: in Shortcuts → **Automation**, add a **Time of Day** automation that
   runs it daily.

The Add Shortcut confirmation, Health permission prompts, and personal-automation
setup are controlled by Apple and cannot be skipped — step 4 exists because Apple
will not grant Health access to a Shortcut launched from a URL. Personal
automations are device-specific. Cairn never puts the owner `CAIRN_AUTH_TOKEN` in
the deep link.

**Revoke** on a connection in Settings invalidates that credential immediately.
The config file on the phone then holds a dead token; pair again (step 3) to
replace it, or delete the file. Pairing again also cleans up: a successful
exchange removes earlier connections with the same label that never ingested
anything, so abandoned attempts do not pile up. A connection that has ever
received data is never removed automatically.

If Settings says **This server has no install link configured**, either the
bundled asset was removed from the deployment or
`CAIRN_APPLE_HEALTH_SHORTCUT_URL` was set to a value that failed validation — a
misconfigured URL deliberately surfaces as unavailable rather than being masked
by the bundled fallback. A hand-built Shortcut of the same name still works —
**Connect & test works either way**, since pairing only needs the name plus
`CAIRN_AUTH_TOKEN`.

## Authentication and pairing

Secure guided pairing requires `CAIRN_AUTH_TOKEN`. An owner-authenticated request
creates a pairing code that expires after ten minutes and can be exchanged once.
Only hashes of pairing codes and long-lived ingest credentials are stored in
SQLite. Each Shortcut connection can be revoked independently in Settings; a
revoked or expired credential cannot ingest or reach any other REST or MCP route.

The dedicated credential authorizes exactly:

```text
POST /api/health-metrics
```

Pairing-code exchange is public because the Shortcut does not have a credential
yet. It passes through Cairn's instance-wide pre-auth rate limiter whenever that
limiter is enabled; operators can deliberately disable it with
`CAIRN_RATE_LIMIT=0`. Pairing codes remain high-entropy, short-lived, and
single-use regardless of that setting.

Credential minting, connection listing, and revocation are owner-only REST
controls. They are intentionally not exposed as MCP tools, so a connected
coaching agent cannot create or manage Apple Health credentials.

Its `last_used_at` timestamp changes whenever at least one metrics row is saved,
including a partially successful batch. Scoped credentials always persist rows
as `source: "apple_health"`; a request cannot spoof or overwrite Garmin/manual
provenance by supplying a different `source`. On an intentionally auth-free
trusted-network instance, guided credential minting is disabled to prevent any
network client from creating credentials. A hand-built Shortcut may still use
the open endpoint, matching the rest of that deployment.

## The maintained Shortcut template

The repository ships the template two ways, both generated from the same source:

- **The signed artifact** at `public/shortcuts/Cairn Apple Health Sync.shortcut`,
  served same-origin and used automatically when no install URL is configured.
  It is signed with `shortcuts sign --mode anyone` and carries no account
  identity — only an anonymous Apple signing chain.
- **The generator** at `scripts/apple-shortcut/build_shortcut.py`, which emits
  the workflow plist the artifact is built from. The rebuild/re-sign recipe is
  in its header; signing requires any Mac with the Shortcuts app. Apple's
  signing certificate expires (~13 months from signing), so re-sign when
  refreshing the artifact or if imports start being refused — and validate on a
  real device before shipping, because Shortcuts parameter serialization is
  under-documented and several published references are wrong (the generator's
  comments record the discrepancies that were found the hard way).

Operators who prefer an `https://www.icloud.com/shortcuts/<id>` link (Apple's
own sharing mechanism — the share page exposes the workflow, not the sharer's
identity, but each re-share of an updated Shortcut mints a **new** URL) can set
`CAIRN_APPLE_HEALTH_SHORTCUT_URL` to theirs.

The template contract is:

- Name: `Cairn Apple Health Sync` by default (configurable with
  `CAIRN_APPLE_HEALTH_SHORTCUT_NAME`).
- Accept text input from `shortcuts://run-shortcut`.
- Parse a JSON object containing only `base_url` and `pairing_code`.
- `POST {base_url}/api/apple-health/pairing/exchange` with
  `{pairing_code, label, shortcut_version}`.
- Store the returned `ingest_token` with the base URL in
  `iCloud Drive/Shortcuts/Cairn/cairn-sync-config.txt`, and use it only as an
  `Authorization: Bearer …` header for `POST {base_url}/api/health-metrics`.
- When run with no input, read that file and post the summary for the **last
  complete day** (yesterday) — this is the daily path, and the run where Apple
  grants the Health permissions. `date` must be the plain `yyyy-MM-dd` custom
  format; the server rejects anything else.
- Judge success by the response's numeric `saved` count, not the boolean `ok` —
  how Shortcuts stringifies a JSON boolean inside a conditional is undocumented,
  while the number `1` is unambiguous.
- Never place the ingest credential in a URL, notification, or log.

Cairn validates configured install URLs. It exposes an Install button only for an
official HTTPS iCloud share or a same-origin `.shortcut` asset. To replace the
template, build and device-test the replacement first, then ship the new artifact
(or update the URL) and the optional name together. Existing paired credentials
continue working until revoked or expired.

For Docker installs, both compose files pass through
`CAIRN_APPLE_HEALTH_SHORTCUT_URL` and `CAIRN_APPLE_HEALTH_SHORTCUT_NAME` as
optional overrides; with neither set, the bundled signed template serves the
Install button.

## Metrics body

Each POST upserts one row per `(source,date)`, so retries are safe. Use
`source: "apple_health"`; `date` is required as `YYYY-MM-DD`. All other fields are
optional:

| Field | Meaning |
|---|---|
| `steps` | daily steps |
| `sleep_min` | total sleep in minutes |
| `resting_hr` | resting heart rate in bpm |
| `hrv_ms` | HRV/SDNN in milliseconds |
| `active_calories` / `total_calories` | energy in kcal |
| `distance_km` | distance in kilometres |
| `exercise_min` | exercise minutes |
| `stand_hours` | stand hours |
| `spo2_avg` | blood oxygen percent |
| `vo2max` | VO2 max |
| `raw` | optional source JSON |

One row, `{ "rows": [...] }`, or a bare array of up to 366 rows is accepted.

```json
{
  "source": "apple_health",
  "date": "2026-07-14",
  "steps": 8200,
  "sleep_min": 437,
  "hrv_ms": 61,
  "resting_hr": 52
}
```

## Building your own Shortcut

Cairn does not require the maintained Shortcut — anything that can POST the body
below works, including a hand-built Shortcut (Find Health Samples → Dictionary →
Get Contents of URL). Build it to the template contract above and give it the
configured name, and **Connect & test pairs it like any other install**; a
credential minted by pairing is always preferable to carrying the owner token on
the phone. If you do use the owner token on a trusted-network instance, it goes in
the `Authorization: Bearer …` header, never in the URL or the Shortcut's input.

Quick endpoint smoke test on an auth-free local instance:

```bash
curl -fsS -X POST http://localhost:8787/api/health-metrics \
  -H 'Content-Type: application/json' \
  -d '{"source":"apple_health","date":"2026-07-14","steps":8200}'
```

## Troubleshooting and Apple references

- `401 unauthorized`: the owner or scoped Bearer credential is absent, wrong,
  revoked, or expired.
- `invalid_or_expired_pairing`: start Connect & test again; pairing codes are
  intentionally short-lived and single-use.
- Connected, but stuck on *Waiting for its first update*: the pairing worked and
  the Shortcut has not been run on the phone yet. Open the Shortcuts app, tap the
  Shortcut once, allow the Health prompts, then tap **Refresh status** in Cairn.
- Connect & test does nothing on the phone: the installed Shortcut's name does not
  match `CAIRN_APPLE_HEALTH_SHORTCUT_NAME` (default `Cairn Apple Health Sync`).
- “Sync failed” from the Shortcut even though the phone is online: the server
  answered but refused the payload — almost always a malformed `date`. It must
  be a real `YYYY-MM-DD`; the response body's `errors` array says exactly what
  was rejected.
- First sync blocked with **“trying to share N Health items, which is not
  allowed”**: enable *Allow Sharing Large Amounts of Data* (see Setup, step 4).
- No data: verify the phone can reach the Cairn base URL and the date is real
  `YYYY-MM-DD`.
- Missing metric: omit it. Cairn treats sparse wearable data normally. In
  particular `sleep_min` is absent whenever nothing writes sleep samples into
  Apple Health — common when sleep is tracked on a non-Apple wearable whose
  companion app does not sync it back.
- Inflated steps/distance/calories: Find Health Samples sums raw samples across
  **all** HealthKit sources, so if another app (a wearable's companion app, a
  second tracker) writes those metrics into Apple Health, days it covers can
  double-count. Cairn softens this — recovery views resolve each field per day
  and prefer the dedicated Garmin lane outright wherever it has the field, and
  sources are never added together — but the honest fix is to stop the second
  writer in the Health app (Profile → Apps, or the companion app's own sync
  settings) so the `apple_health` row reflects one source of truth.

Apple documents [sharing shortcuts](https://support.apple.com/guide/shortcuts/share-shortcuts-apdf01f8c054/ios),
[running a shortcut from a URL](https://support.apple.com/guide/shortcuts/open-create-and-run-a-shortcut-apda283236d7/ios),
[Find Health Samples](https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios),
[JSON POST requests](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios),
and [personal automations](https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/ios).

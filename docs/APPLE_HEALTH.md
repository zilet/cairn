# Apple Health via Shortcuts

Cairn accepts a daily Apple Health summary from an iPhone Shortcut. This is an
optional input for the Brief and recovery views; Cairn remains fully usable
without it.

## Guided install

The intended phone flow is:

1. In Cairn, open **Settings → Sources → Apple Health**.
2. Tap **Install Apple Health Sync**. Apple opens the published Shortcut and
   requires you to confirm **Add Shortcut**.
3. Return to Cairn and tap **Connect & test**. Cairn opens the installed Shortcut
   with only this instance's base URL and a high-entropy, one-time pairing code.
4. The Shortcut exchanges that code for a dedicated ingest credential, requests
   only the Health permissions its actions use, and posts its first daily summary.
5. Optionally create a Time of Day personal automation on the phone.

The Add Shortcut confirmation, Health permission prompts, and personal-automation
setup are controlled by Apple and cannot be skipped. Personal automations are
device-specific. Cairn never puts the owner `CAIRN_AUTH_TOKEN` in the deep link.

If Settings says **Shortcut package not published yet**, that is intentional: this
checkout does not ship a fabricated or undocumented `.shortcut` binary and no
maintainer-private iCloud link is hard-coded. The advanced manual recipe remains
available while a release artifact is absent.

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

## Publishing the maintained Shortcut

The project can publish a static Shortcut template, but it must be authored and
exported from Apple's Shortcuts app. Apple validates shared shortcuts; do not
synthesize an undocumented workflow file in repository code.

The template contract is:

- Name: `Cairn Apple Health Sync` by default (configurable with
  `CAIRN_APPLE_HEALTH_SHORTCUT_NAME`).
- Accept text input from `shortcuts://run-shortcut`.
- Parse a JSON object containing only `base_url` and `pairing_code`.
- `POST {base_url}/api/apple-health/pairing/exchange` with
  `{pairing_code, label, shortcut_version}`.
- Store the returned `ingest_token` locally in the Shortcut and use it only as an
  `Authorization: Bearer …` header for `POST {base_url}/api/health-metrics`.
- Never place the ingest credential in a URL, notification, or log.

After validating the exported artifact on a clean iPhone:

1. Publish it through an official `https://www.icloud.com/shortcuts/<id>` share or
   as a signed same-origin `.shortcut` asset.
2. Set `CAIRN_APPLE_HEALTH_SHORTCUT_URL` to that URL.
3. If its name differs, set `CAIRN_APPLE_HEALTH_SHORTCUT_NAME` to the exact name.
4. Rebuild/redeploy and test install, pairing, first ingest, status, and revocation.

Cairn validates configured install URLs. It exposes an Install button only for an
official HTTPS iCloud share or a same-origin `.shortcut` asset. To replace a
template, publish and test the replacement first, then update the URL and optional
name together. Existing paired credentials continue working until revoked or
expired.

For Docker installs, both compose files pass through
`CAIRN_APPLE_HEALTH_SHORTCUT_URL` and `CAIRN_APPLE_HEALTH_SHORTCUT_NAME`; set
them in the deployment `.env` only after the human-authored Shortcut artifact is
published and validated. There is intentionally no default URL or `.shortcut`
file in the repository.

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

## Advanced manual fallback

Build a Shortcut with Find Health Samples actions, a Dictionary containing only
the metrics you choose to share, and Get Contents of URL posting JSON to:

```text
https://your-cairn-host/api/health-metrics
```

For an authenticated instance, prefer a scoped credential created by the pairing
flow. If manually using the owner token, put it in the `Authorization: Bearer …`
header, never the URL or copied Shortcut input. Test once and approve Health
permissions, then optionally create the Time of Day automation.

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
- No data: verify the phone can reach the Cairn base URL and the date is real
  `YYYY-MM-DD`.
- Missing metric: omit it. Cairn treats sparse wearable data normally.

Apple documents [sharing shortcuts](https://support.apple.com/guide/shortcuts/share-shortcuts-apdf01f8c054/ios),
[running a shortcut from a URL](https://support.apple.com/guide/shortcuts/open-create-and-run-a-shortcut-apda283236d7/ios),
[Find Health Samples](https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios),
[JSON POST requests](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios),
and [personal automations](https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/ios).

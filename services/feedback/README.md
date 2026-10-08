# Cairn feedback service

A tiny Cloudflare Worker + D1 database that receives in-app feedback and opt-in usage pings from
self-hosted Cairn instances. It is deployed once by the maintainer and is **not** part of the Cairn
app, its build, its tests or its Docker image.

## Privacy statement

**What is stored**

- Feedback you choose to send: the kind (bug / idea / praise / other), your message, an optional
  contact string you typed, the Cairn version and platform, a random per-install `instance_id`, and
  (only if the app attaches it) a small diagnostics object. Diagnostics are deleted after 90 days;
  the message text is kept.
- Usage pings (opt-in): the random `instance_id`, Cairn version, OS platform, CPU arch and Node
  version, plus first-seen / last-seen timestamps. Instances not seen for 180 days are deleted.
- Short-lived rate-limit counters keyed by `instance_id` or by a salted hash of the sender IP.

**What is not stored**

- No IP addresses, in raw or reversible form. For rate limiting the IP is hashed with a secret and
  the current date (so the hash changes daily and cannot be linked across days) and only counters
  keyed by that hash are kept for ~2 days.
- No health, training, nutrition or profile data, no names, no account identifiers. The
  `instance_id` is random and not derived from anything about you or your machine.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/feedback` | JSON `{kind, message(1..4000), contact?(<=200), version(<=40), platform(<=20), instance_id(uuid), diagnostics?(object, <=32KB)}` -> `200 {ok:true,id}` |
| POST | `/v1/ping` | JSON `{instance_id, version, platform, arch, node}` -> `204` |
| GET | `/v1/health` | `200` |
| GET | `/v1/admin/feedback?since=<epoch ms>&limit=<1..200>` | admin |
| GET | `/v1/admin/stats` | admin: active instances (7/30 days) by version and platform; feedback counts by kind |

Bodies over 48KB, or without `Content-Type: application/json`, are rejected. Errors are
`{ok:false,error}` (400/413/415/429). No CORS headers are sent (server-to-server only).

Rate limits (D1 counters, chosen over the Workers Rate Limiting binding so limits can differ per
key and need no extra config): 10 feedback/hour/instance, 5 feedback/hour/hashed IP, 2 pings/day/instance.

## Deploy

```bash
cd services/feedback
npm i
npx wrangler d1 create cairn-feedback          # paste the printed database_id into wrangler.toml
npm run db:schema                               # applies schema.sql to the remote database
npx wrangler secret put ADMIN_TOKEN             # required; e.g. `openssl rand -hex 32`
npx wrangler secret put RATE_SALT               # optional; falls back to ADMIN_TOKEN
npx wrangler deploy
```

Optional forwarding (each set with `wrangler secret put`):

- `GITHUB_TOKEN` + `GITHUB_REPO` (`owner/repo`): opens one issue per feedback, labelled `feedback`
  and the kind (create those labels first, or GitHub drops them). **`GITHUB_REPO` must be a PRIVATE
  repository**: issue bodies carry the message text and diagnostics. Use a fine-grained token with
  only Issues read/write on that repo. Diagnostics go in a collapsed `<details>` block.
- `NOTIFY_WEBHOOK_URL`: generic JSON POST with `text`, `content`, `id`, `kind`, `version`,
  `platform` (works with Slack/Discord-compatible endpoints).

Both are **off unless configured**. **Contact never leaves D1**: the optional contact string lives
only in the `feedback` row, readable through the admin API, and is never put in an issue or a
webhook payload.

**Daily caps.** Forwards are capped globally per UTC day, counted in D1 (`forward_counts`): 50 GitHub
issues and 50 webhook posts per day by default, overridable with the plain vars `GITHUB_DAILY_CAP` /
`WEBHOOK_DAILY_CAP` (non-negative integer; `0` disables that channel). Past the cap the feedback is
still stored, just not forwarded. Re-run `npm run db:schema` after updating to create the table.

Forwarding runs after the response is sent; failures are logged and never surfaced to the client.
A daily cron (03:17 UTC) applies the retention rules above.

## Point Cairn at it

Cairn already points at the project's own deployment of this service, `https://feedback.cairn.fit`
(`DEFAULT_FEEDBACK_URL` in `src/feedback.ts`), and only ever contacts it when a person presses Send in
the feedback sheet or has opted in to the weekly usage ping. A self-hoster can change that with
`CAIRN_FEEDBACK_URL` in the Cairn environment:

- `CAIRN_FEEDBACK_URL=https://<your-worker>.workers.dev` (or your custom domain, see the commented
  `routes` line in `wrangler.toml`) sends feedback and pings to your own deployment instead.
- `CAIRN_FEEDBACK_URL=""` disables the service entirely: feedback falls back to a prefilled GitHub
  issue the person reviews in their own browser, and the usage ping never sends.

Only `https://` URLs are accepted (plain `http://` only for `localhost`, for `wrangler dev`).

## Read feedback

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://<worker>/v1/admin/feedback?limit=20"
curl -H "Authorization: Bearer $ADMIN_TOKEN" "https://<worker>/v1/admin/stats"
```

or watch the GitHub issues if forwarding is enabled.

## Develop

```bash
npm test          # node:test over the pure logic in src/lib.ts (Node 24+ strips types natively)
npm run typecheck
npx wrangler dev
```

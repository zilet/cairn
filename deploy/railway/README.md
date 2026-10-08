# Railway template recipe (maintainer, one time)

You create Railway templates in Railway's web UI, not from a file in this repo. This page is the
exact recipe for building the "Deploy on Railway" template once. After it is published, every
deployer gets their own copy on their own Railway account. The user-facing guide is
[`docs/HOSTING.md`](../../docs/HOSTING.md).

The template is the no-terminal path. The main path is the one-command installer
(`curl -fsSL https://cairn.fit/install | sh`, choice 1, or `--target=railway`), which builds the
same service with the Railway CLI: same image, one volume at `/data`, the same variables (its
token and key are 64 hex characters, generated locally and sent on stdin), and a domain on port
8787. Keep the two in step: a variable added here belongs in `RW_PLAIN_VARS` in
[`deploy/install.sh`](../install.sh) too. The installer's exact CLI sequence is printed by
`sh deploy/install.sh --target=railway --dry-run`.

Railway docs used: [creating a template](https://docs.railway.com/guides/create),
[publishing and sharing](https://docs.railway.com/guides/publish-and-share),
[volumes](https://docs.railway.com/reference/volumes) and
[image auto updates](https://docs.railway.com/deployments/image-auto-updates).
Re-check them if the UI has moved.

## 1. Open the template composer

Go to your workspace **Templates** page and click **New Template**.

## 2. Add the service from the published image

Click **Add New** (or press `CMD + K`), choose **Docker Image**, and enter:

```
ghcr.io/zilet/cairn:latest
```

Name the service `cairn`. The image is public and multi-arch, so it needs no registry credentials.
`:latest` only moves when a release is tagged.

## 3. Attach the volume

Right-click the service, choose **Attach Volume**, and set the mount path to:

```
/data
```

Railway allows one volume per service, which is exactly what Cairn's single-volume mode expects.
Size matters: a trial volume is 0.5 GB, which fits one AI provider's tool, whichever it is (Grok
~180 MB, Google ~220 MB, Claude ~260 MB, ChatGPT ~400 MB; Codex was verified to install on a fresh
trial volume). On Hobby, 5 GB fits them all; an existing volume
grows with **Live Resize** on the volume after upgrading.
The database, uploads, provider sign-ins and installed AI tools all live under `/data`. Do **not**
set `RAILWAY_RUN_UID`. The image starts as root only long enough to fix the volume's ownership,
then drops to its unprivileged `app` user.

## 4. Variables

Add these on the service's **Variables** tab. Add the descriptions too: they appear on the deploy
screen.

| Variable | Value | Description to show deployers |
|---|---|---|
| `CAIRN_AUTH_TOKEN` | `${{secret(48)}}` | Your sign-in token. Copy it from this tab to sign in. |
| `CAIRN_SETTINGS_SECRET_KEY` | `${{secret(48)}}` | Encrypts stored integration passwords. Leave it as generated. |
| `CAIRN_REQUIRE_AUTH` | `1` | Refuse to start without a token: a Railway URL is public. |
| `CAIRN_SINGLE_VOLUME` | `1` | Keep sign-ins and AI tools on the one volume at /data. |
| `CAIRN_BLANK_PROFILE` | `1` | Start with an empty profile, with no demo data. |
| `CAIRN_PLATFORM` | `railway` | Tells Cairn how it was deployed. |
| `CAIRN_MAX_AGENT_PROCS` | `1` | Runs one background AI task at a time to keep memory low. |
| `PORT` | `8787` | The port Cairn listens on. |
| `CAIRN_FEEDBACK_URL` | `https://feedback.cairn.fit` | Where **Send feedback** delivers (only when you press Send). Delete it to open a GitHub issue instead. |

`secret(length)` is Railway's template-variable function. Railway fills it in once, for each
deployer, when they deploy, so every deployer gets their own token and key.
Leave `CAIRN_DEPLOY_HOOK_URL` unset: Railway updates the image itself (step 6).

## 5. Networking and health check

In the service's **Settings**:

- **Public Networking:** enable it and generate a domain that targets port `8787`.
- **Healthcheck Path:** `/api/health`. This endpoint answers without a token, even with
  `CAIRN_REQUIRE_AUTH=1`. The default healthcheck timeout is enough: a first boot creates the
  database in seconds.

## 6. Image auto updates

Go to the service's **Settings → Source → Configure Auto Updates**:

- Keep the tag as `latest`. For a non-semver tag, Railway redeploys when a new image (a new digest)
  is pushed under that tag.
- **Maintenance window:** pick **Night** (02:00–06:00 UTC) or **Weekends**. Updates only land
  inside the window. Railway caches registry checks for up to a few hours, so an update can lag a
  release by that much.
- On Railway's **Pro** plan, Railway backs up the attached volume before each auto update. On every
  plan, Cairn also writes its own restore point to `/data/backups/` before a release migrates the
  database.

If the composer does not carry the auto-update setting into deployed copies, keep the sentence about
it in the template overview (step 7), so deployers can switch it on from the same menu.

## 7. Template overview

Suggested text for the template page:

> **Cairn** is a self-hosted wellness OS for training, nutrition and longevity. It opens to a calm
> read of your day and a coach that suggests, never scores. This template runs the published image
> on your own Railway account. Everything lives on one volume at `/data`. A sign-in token is
> generated for you: find it on the **Variables** tab as `CAIRN_AUTH_TOKEN`. To use the AI coach,
> connect your own Claude, ChatGPT, Google or Grok subscription in **Settings → Agents**. Updates
> arrive automatically in your maintenance window (**Settings → Source → Configure Auto Updates**).
> At least 1 GB of memory is recommended for AI coaching. A trial volume is 0.5 GB, enough for
> one AI provider; on Hobby, grow the volume to 5 GB (click the volume → **Live Resize**). Guide:
> https://github.com/zilet/cairn/blob/main/docs/HOSTING.md

## 8. Publish and wire up the button

1. Click **Publish** and fill out the form (or go to **Templates** in workspace settings and
   choose **Publish**).
2. Copy the template code from the template's URL. The deploy link is
   `https://railway.com/new/template/<CODE>`.
3. Point the project site's `/railway` redirect at that deploy link (it is set on the site, not in
   this repo). Every Railway button in the repo (`README.md`, `docs/QUICKSTART.md`,
   `docs/HOSTING.md`, image `https://railway.com/button.svg`) links to `https://cairn.fit/railway`,
   a counted redirect, so the repo's links never change when the template is republished or moved.
4. Click the README button once and check that it lands on the template's deploy page.

## 9. Smoke test, in a scratch project

1. Deploy the published template. The health check should turn green.
2. Open the URL. Cairn should ask for a token, and the `CAIRN_AUTH_TOKEN` value from Variables
   should sign you in.
3. In **Settings → Agents**, install a provider and **Connect** it.
4. Redeploy the service. The provider should still show **Connected**: its sign-in lives in
   `/data/home` on the volume.
5. Delete the scratch project.

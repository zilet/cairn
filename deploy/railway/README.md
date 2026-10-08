# The Railway template, from the repo

The "Deploy on Railway" template is declared in this folder, so anyone can rebuild it into their
own Railway workspace. Nothing depends on one person's or one organization's Railway account. The
user-facing guide is [`docs/HOSTING.md`](../../docs/HOSTING.md).

| File | What it is |
|---|---|
| [`template.json`](template.json) | The source of truth: image, service name, volume, health check, port, image auto updates, every variable with its description, and the marketplace name, category and description. |
| [`overview.md`](overview.md) | The template page's overview text (the marketplace readme). |

The template is the no-terminal path. The main path is the one-command installer
(`curl -fsSL https://cairn.fit/install | sh`, choice 1, or `--target=railway`), which builds the same
service with the Railway CLI. Both read the same values: `RW_PLAIN_VARS`, `RW_SECRET_VARS` and the
`RW_TPL_*` constants in [`deploy/install.sh`](../install.sh) carry what `template.json` declares, and
`test/installScript.test.js` fails when the two drift. To change a variable, change both. The
install also switches on the same image auto updates (`RW_TPL_UPDATE_*`, the Night window) with the
same kind of environment patch, so an installed Cairn and a template-deployed one update alike.

## Make the template

Sign in to the Railway CLI (`railway login`, version 5.64 or newer) as the account whose workspace
should own the template, then from a checkout:

```bash
sh deploy/install.sh railway-template                 # build a private draft and check it
sh deploy/install.sh railway-template --dry-run       # print the plan and the CLI sequence only
sh deploy/install.sh railway-template --workspace="Team Name"   # when you have several workspaces
```

What it does, in order:

1. Creates a scratch project named `Cairn` (the template takes the project's name;
   `--railway-project-name=` changes it) with one service, `cairn`, a volume at `/data` and a public
   domain on port 8787.
2. Configures the service from the spec in one environment patch through `railway api`, with
   deployments skipped: the image, the health check `/api/health`, image auto updates, and the
   variables. `CAIRN_AUTH_TOKEN` and `CAIRN_SETTINGS_SECRET_KEY` are set to `${{secret(48)}}`,
   Railway's secret function, never to a value.
3. Runs `railway templates create`, which turns the project into an unpublished template draft.
4. Reads the draft back and compares it with the spec. If a secret variable holds anything but
   `${{secret(48)}}`, it deletes the draft and stops: a fixed value would give every deployer the
   same token.
5. Deletes the scratch project, also when a step fails or you press Ctrl-C. A project that already
   had the same name is never touched.
6. Prints the template code, its editor link, the deploy link
   (`https://railway.com/deploy/<code>`) and what is left for the editor. The draft's link is a
   draft's: Railway can give the published template a shorter code, so `--publish` prints the
   final link.

### What Railway's generate does and does not carry

Checked live on 2026-10-08 with Railway CLI 5.64:

| From the scratch project | In the draft |
|---|---|
| `${{secret(48)}}` on a variable | Kept as the function. Two deploys of the draft got two different 48-character tokens and keys. |
| A plain value (`PORT=8787`) | Dropped, unless the variable's `generator` is that value too, which the installer sets. Then it is the template's default. |
| Health check path, volume mount, domain port | Kept. |
| Image auto updates | Dropped. |
| Variable descriptions | Dropped (a project has nowhere to keep them). |

Railway's public API has no call that edits a template's configuration, so the last two are a
one-time step in the template editor (the link the command prints):

- **Auto updates:** the service → **Settings → Source → Auto Updates**: on, maintenance window
  **Night** (02:00–06:00 UTC).
- **Descriptions:** each variable's description, copied from `template.json`.

Then **Save**.

## Publish

Once the editor steps are saved:

```bash
sh deploy/install.sh railway-template --publish --template=<code>
```

It reads the draft again, refuses while a secret is anything but `${{secret(48)}}`, stops while an
editor step is missing (`--force` publishes anyway), prints the plan (category `AI/ML`, the
description, `overview.md`) and asks `[y/N]` before it runs `railway templates publish`. `--yes`
answers yes. `--template=<code>` without `--publish` only checks a draft. `railway-template --publish`
on its own builds a new draft and then stops at the editor steps, printing this command.

The project site's `/railway` address is a counted redirect that the site maintainer points at
whichever published template is current. Every Railway button in this repo (`README.md`,
`docs/QUICKSTART.md`, `docs/HOSTING.md`, image `https://railway.com/button.svg`) links there, so the
repo's links never change when the template is rebuilt, republished or moved. A fork points its own
buttons at its own deploy link.

## Manual fallback

Without the CLI, build the same thing in the dashboard: **Templates → New Template**, add a
**Docker Image** service named `cairn` from `ghcr.io/zilet/cairn:latest`, attach a volume at
`/data`, add every variable from `template.json` (the two secrets as `${{secret(48)}}`, with
descriptions), enable public networking on port 8787, set the healthcheck path to `/api/health`, and
turn on auto updates with the Night window. Then publish with the category, description and
`overview.md`. Do **not** set `RAILWAY_RUN_UID`: the image starts as root only long enough to fix
the volume's ownership, then drops to its unprivileged `app` user. Leave `CAIRN_DEPLOY_HOOK_URL`
unset: Railway updates the image itself.

Railway docs: [creating a template](https://docs.railway.com/guides/create),
[publishing and sharing](https://docs.railway.com/guides/publish-and-share),
[volumes](https://docs.railway.com/reference/volumes) and
[image auto updates](https://docs.railway.com/deployments/image-auto-updates).

## Volume size

A trial volume is 0.5 GB, which fits one AI provider's tool, whichever it is (Grok ~180 MB, Google
~220 MB, Claude ~260 MB, ChatGPT ~400 MB). On Hobby, 5 GB fits them all; an existing volume grows
with **Live Resize** after upgrading. The database, uploads, provider sign-ins and installed AI
tools all live under `/data`.

## Smoke test, in a scratch project

1. Deploy the draft or the published template (`railway init` in an empty folder, then
   `railway deploy -t <code>`, or the deploy link). The health check should turn green.
2. Open the URL. Cairn should open the sign-in screen with a "First time here?" note linking to the
   service's Variables tab, and the `CAIRN_AUTH_TOKEN` value from Variables should sign you in.
3. In **Settings → Agents**, install a provider and **Connect** it.
4. Redeploy the service. The provider should still show **Connected**: its sign-in lives in
   `/data/home` on the volume.
5. Delete the scratch project.

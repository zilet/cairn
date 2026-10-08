# Deploy and Host Cairn on Railway

**Cairn** is a self-hosted wellness OS for training, nutrition and longevity. It opens to a calm read
of your day and a coach that suggests, never scores. Open source (MIT): https://github.com/zilet/cairn

## About Hosting Cairn

This template runs the published image (`ghcr.io/zilet/cairn:latest`) on your own Railway account,
with one volume at `/data` for everything: the database, your AI provider's sign-in and its tools.
Image auto updates are on, so new releases arrive in your maintenance window.

## How to use it

1. Deploy, and wait until the service is healthy.
2. Open the public URL Railway gives the service and sign in with `CAIRN_AUTH_TOKEN` from the cairn
   service's **Variables** tab (the first screen links straight to it). Keep it somewhere safe; it
   is your recovery key. Add a passkey or pair your phone from **Settings → Devices**.
3. The welcome asks you to connect the AI subscription you already have (Claude, ChatGPT, Google or
   Grok). The coach then plans your first week.

## Common Use Cases

- A daily read of what kind of day today should be, from your lifts, runs, sleep and food
- Strength and running plans that adapt to what you actually log
- Lab results connected to training and nutrition (informational, not medical advice)

## Dependencies for Cairn Hosting

- An AI subscription you already have (Claude, ChatGPT, Google or Grok), connected in the app
- At least 1 GB of memory is recommended for AI coaching

### Deployment Dependencies

- Guide: https://github.com/zilet/cairn/blob/main/docs/HOSTING.md
- A trial volume is 0.5 GB, enough for one AI provider. On Hobby, grow it to 5 GB (click the volume
  → **Live Resize**).

## Why Deploy Cairn on Railway?

Nothing to keep running at home, a public HTTPS address out of the box, and updates that arrive on
their own. Your data lives on your own Railway volume, under your own account.

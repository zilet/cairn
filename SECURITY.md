# Security Policy

Cairn is a personal, hobby project maintained by one person. Security work here
is best-effort, but reports are genuinely welcome and taken seriously.

## Security model

Cairn is **self-hosted and single-user**, and it ships with **no authentication
by default**. It is designed to run on a network you already trust:

- `localhost` on your own machine, or
- a home LAN, or
- a private overlay network (Tailscale, WireGuard, or another VPN).

If you want a thin extra layer, you can set a shared bearer token via the
`CAIRN_AUTH_TOKEN` environment variable to gate the REST API (`/api/*`) and the
MCP surface (`/mcp`). This is a convenience guard, not a substitute for network
isolation.

**The safest posture is to never expose Cairn's port to the public internet.**
Keep it behind your firewall / VPN. Do not put it on a public IP or a
public-facing reverse proxy without your own authentication in front of it.

## What's at stake if it's exposed

Cairn stores personal data, so an exposed instance is a real privacy risk:

- **Personal health data** — bodyweight, training logs, nutrition, uploaded lab
  documents and extracted markers, family details, and free-text notes live in
  the `data/` volume (SQLite database plus uploaded files).
- **Live OAuth tokens** for the coaching CLIs (Claude Code, Codex, etc.) live in
  the `cairn-home` volume. Anyone who can reach those credentials could act as
  you against those services.

Treat both volumes as sensitive. Back them up privately and never commit them.

## Supported versions

Only the **latest released image** is supported. Fixes land on the newest
release; there are no back-ported patches for older tags.

## Reporting a vulnerability

Please report security issues **privately** by email:

**milos@spicefactory.co**

- Do **not** open a public GitHub issue or pull request for a security report.
- Include enough detail to reproduce (affected version/tag, steps, impact).
- Expect an initial response within **a few days**. As a solo hobby project,
  triage and fixes are best-effort, but I'll do my best to address real issues.

Thank you for helping keep Cairn and its users safe.

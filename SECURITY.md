# Security Policy

Cairn is a personal, hobby project maintained by one person. Security work here
is best-effort, but reports are genuinely welcome and taken seriously.

## Security model

Cairn is **self-hosted and single-user**, and it ships with **no authentication
by default**. It is designed to run on a network you already trust:

- `localhost` on your own machine, or
- a home LAN, or
- a private overlay network (Tailscale/MagicDNS, WireGuard, or another VPN).

If you want a thin extra layer, you can set a shared bearer token via the
`CAIRN_AUTH_TOKEN` environment variable to gate the REST API (`/api/*`), the
MCP surface (`/mcp`), and the in-app agent-login WebSocket. This is a convenience
guard, not a substitute for network isolation.

When you connect a coaching CLI from **Settings → Agents → Connect**, the login
runs in a real terminal on the server and is streamed to your browser over a
WebSocket (`/api/agent-login/ws`). That endpoint is gated by the same
`CAIRN_AUTH_TOKEN` (and the optional per-IP rate limit) as the rest of `/api`, the
login command is chosen server-side from an allowlist (never from the browser),
and the login subprocess has Cairn's own secrets (`CAIRN_AUTH_TOKEN`,
`GARMIN_PASSWORD`) stripped from its environment — it authenticates only to the
external provider, never to Cairn. Keep it on a trusted network like everything else.

**The safest posture is to never expose Cairn's port to the public internet.**
Keep it behind your firewall / VPN / tailnet. Do not put it on a public IP or a
public-facing reverse proxy without your own authentication in front of it. If
you run Cairn on a cloud VM, bind the port to localhost or a private interface
and reach it through Tailscale, WireGuard, an SSH tunnel, or an authenticated
reverse proxy.

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

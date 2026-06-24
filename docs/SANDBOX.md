# Run Cairn on a cloud sandbox

Cairn is a single Node service with a SQLite database — it runs happily on a small,
**on-demand cloud sandbox** that you start when you want it and stop when you don't.
This is a nice fit for trying Cairn without provisioning a server, or for keeping a
personal instance that costs almost nothing while it's idle.

The repo ships a standard [`.devcontainer/`](../.devcontainer/devcontainer.json), so the
same setup works on **[Daytona](https://www.daytona.io)** and **GitHub Codespaces** — and on
any other host that understands a devcontainer, so there's no vendor lock-in.

> **The honest version:** a sandbox is great for trying Cairn and for a private,
> stop-when-idle instance. It is *not* a substitute for the calm always-on home-server
> deploy in [`DEPLOYMENT.md`](DEPLOYMENT.md) if you want the Brief waiting for you every
> morning. Read the [caveats](#caveats-read-these) below before you rely on one.

The public-ready posture is:

- **Trial / occasional use:** Daytona or Codespaces with port `8787` previewed.
- **Personal daily driver:** Raspberry Pi, home server, or small VM on Tailscale/MagicDNS.
- **Never:** raw port `8787` exposed to the public internet without your own auth layer.

---

## What you get

The devcontainer:

- Boots **Node 24** (required — Cairn uses `node:sqlite`, which is unflagged only on 24).
- Runs `npm install && npm run build && npm run seed:demo` on create, so the sandbox opens
  to a **populated demo** (plan, history, markers) instead of an empty shell.
- Forwards port **8787** and auto-opens the PWA.
- On each start, prints the URLs and **launches the dev server**, then reminds you how to
  wire a coaching agent (see [`welcome.sh`](../.devcontainer/welcome.sh)).

Open **http://localhost:8787** (the sandbox forwards it to a public or tunneled URL) and you
land on the Brief.

---

## Daytona (primary)

[Daytona](https://www.daytona.io) is a good fit for on-demand evaluation because its sandboxes are
Docker/OCI-compatible, can [preview HTTP service ports](https://www.daytona.io/docs/en/preview/),
and can persist files across sandbox lifecycle via the sandbox filesystem or
[mounted volumes](https://www.daytona.io/docs/en/volumes/). Cairn's `.devcontainer/` gives Daytona
the Node 24 environment and starts the PWA on port `8787`.

```bash
# install the Daytona CLI first (see daytona.io docs), then:
daytona create https://github.com/zilet/cairn
```

Daytona CLI syntax evolves; if your CLI prompts instead of accepting a repo URL, create a workspace
from Git and paste `https://github.com/zilet/cairn`, then let it use the checked-in devcontainer.
The result should be a workspace with port `8787` previewed.

To keep cost minimal:

- **Stop, don't delete**, between sessions so the workspace data can survive and compute is not
  running while idle. Check your Daytona plan's billing page for the exact storage/compute policy.
- Keep the workspace small; Cairn's footprint is tiny (Node + a SQLite file).
- Keep `data/` persistent. If you want the instance to outlive the sandbox/workspace, mount a
  Daytona volume for app state or export the DB regularly.

### Daytona preview auth

[Daytona preview URLs](https://www.daytona.io/docs/en/preview/) can be token-protected or public,
depending on the sandbox/preview settings. For a browser link, Daytona also supports signed preview
URLs with an expiry. Treat any public preview as internet-reachable: set `CAIRN_AUTH_TOKEN` as a
Daytona secret before starting Cairn, or keep the preview private/authenticated and use the platform
token.

---

## GitHub Codespaces

Same devcontainer, zero extra config:

1. On the GitHub repo, **Code → Codespaces → Create codespace on main**.
2. Wait for the post-create build + demo seed.
3. The forwarded **8787** port opens the PWA.
4. **Stop the codespace** when idle (Codespaces also auto-stops after inactivity). A stopped
   codespace keeps its disk, so `data/` survives; you're billed for storage only.

Set agent keys as **Codespaces secrets** (Settings → Codespaces → Secrets), not in a committed
file — see [caveats](#caveats-read-these).

---

## Other devcontainer hosts

Any platform that reads a standard `.devcontainer/` can run Cairn the same way — it boots Node 24,
seeds the demo, and forwards port `8787`. Treat the workspace's persistence window as convenience,
not a backup of record: for anything you want to keep, take an export (below) rather than relying on
workspace retention.

---

## Persistence — what to keep

All durable state lives under **`data/`**:

| Path | Keep? | Why |
|---|---|---|
| `data/cairn.db` (+ `-wal`, `-shm`) | **Yes** | Your entire history — plan, sessions, weights, markers, memory, chat |
| `data/uploads/` | **Yes** | Original health-document files (labs, DEXA) |
| `data/art/` | No | Regenerable image cache — safe to drop, it rebuilds on demand |

The devcontainer keeps `data/` inside the workspace folder, so a **stopped** (not deleted)
sandbox retains everything. For a real backup that outlives the sandbox, use the built-in export
from inside the running container:

```bash
# JSON backup (portable):
curl -s http://localhost:8787/api/export > cairn-export.json
# or a SQLite snapshot:
curl -s http://localhost:8787/api/export/db -o cairn-snapshot.db
```

Download that file, or commit it to a private bucket — see [`OPERATIONS.md`](OPERATIONS.md) for
restore. **Treat workspace persistence as convenience, not as your backup of record.**

---

## Caveats (read these)

- **Node 24 is mandatory.** The devcontainer pins it; if you roll your own image, match it.
- **Agents in an ephemeral sandbox.** Cairn's coaching runs through external agent CLIs. The
  *interactive OAuth* logins (Claude Code, Codex, Antigravity) authenticate against a token that
  **won't survive a sandbox rebuild**. For a sandbox, prefer:
  - an **API-key agent** — set `GEMINI_API_KEY` or `XAI_API_KEY` (Grok) as a **sandbox/Codespaces
    secret**, never a committed file; or
  - the built-in **`stub`** agent (Settings → Agents) — no key, fully offline, exercises the
    propose/apply loop so you can see the flow.
  First paint (the Brief, logging, history) works with **no agent at all**.
- **Public URLs.** If the sandbox exposes a public forwarded URL, set **`CAIRN_AUTH_TOKEN`** (a
  secret) so `/api` and `/mcp` require a bearer token. On a private/tunneled URL it's optional.
- **Secrets hygiene.** Use the platform's secret store (Daytona/Codespaces), not `.env`
  in the repo. The agent subprocess env is already denylist-scrubbed of Cairn's own secrets.
- **Garmin sync** expects credentials and a long-lived process; it's a poor fit for a
  stop-start sandbox. Leave it off unless you're running always-on (see [`GARMIN.md`](GARMIN.md)).

---

## When to graduate off a sandbox

A sandbox is ideal for **trying Cairn** and for a **private, low-cost, stop-when-idle** instance.
Once you want the Brief genuinely waiting for you each morning — the nightly insight, the weekly
read, Garmin sync — move to the always-on deploy in [`DEPLOYMENT.md`](DEPLOYMENT.md) (a small VM,
a home server, or a Raspberry Pi on your Tailnet). Your `data/` export carries straight over.

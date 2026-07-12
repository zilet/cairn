# Household members

Cairn remains **single-user per instance**. The safe household pattern is one
released image running once per person, with a separate Compose project, token,
database, uploads, connector secrets, and coaching-CLI home for each person.
This keeps clinical and coaching data private without turning Cairn into a
multi-tenant service.

The **Me → Family** roster is context the coach plans around. It is not an
account, profile switcher, or permission boundary. Never copy one person's
`cairn-data` volume to initialize another person.

## Add a second person

The example below leaves an existing `~/cairn` installation untouched and adds
an independent instance at `~/cairn-partner` on host port `8788`.

```bash
mkdir -p ~/cairn-partner
cd ~/cairn-partner
curl -LO https://github.com/zilet/cairn/releases/latest/download/docker-compose.yml

umask 077
generate_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}
auth_token="$(generate_hex)"
settings_key="$(generate_hex)"
printf '%s\n' \
  'COMPOSE_PROJECT_NAME=cairn-partner' \
  'CAIRN_CONTAINER_NAME=cairn-partner' \
  'CAIRN_BIND_HOST=127.0.0.1' \
  'CAIRN_HOST_PORT=8788' \
  "CAIRN_AUTH_TOKEN=$auth_token" \
  'CAIRN_REQUIRE_AUTH=1' \
  "CAIRN_SETTINGS_SECRET_KEY=$settings_key" \
  'CAIRN_BLANK_PROFILE=1' \
  'TZ=America/New_York' > .env

docker compose up -d
for _ in $(seq 1 45); do
  curl -fsS http://127.0.0.1:8788/api/health >/dev/null && break
  sleep 2
done

test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/api/profile)" = 401
curl -fsS -H "Authorization: Bearer $auth_token" \
  http://127.0.0.1:8788/api/profile | grep -qx 'null'
curl -fsS -H "Authorization: Bearer $auth_token" \
  http://127.0.0.1:8788/api/plan | grep -qx '\[\]'
```

Change the project/container name and host port for each additional person.
Keep the internal container port at `8787`; `CAIRN_HOST_PORT` changes only the
private host-side listener. `CAIRN_BLANK_PROFILE=1` is read only on the first
boot of an empty database: it retains only the neutral exercise catalog and
omits the example plan, measurements, and completed training history.

Compose prefixes all three volumes with the project name, producing independent
state such as:

```text
cairn-partner_cairn-data
cairn-partner_cairn-home
cairn-partner_cairn-tools
```

Do not override those volumes to point at another person's volumes. `cairn-home`
contains live provider credentials, and `cairn-tools` is writable executable
state as well as being independently replaceable.

## Private phone access with Tailscale

Invite each person to the tailnet using **their own Tailscale identity**; do not
share one account. Tailscale supports family/user invitations and states that a
user account may not be shared by multiple people. See [Invite any user to your
tailnet](https://tailscale.com/docs/features/sharing/how-to/invite-any-user).

Give every Cairn instance its own HTTPS origin. If the primary instance already
uses HTTPS `443` → Cairn `8787`, expose the second instance on `8443` → `8788`:

```bash
sudo tailscale serve --bg --https=443  http://127.0.0.1:8787
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8788
sudo tailscale serve status
```

The two private URLs are then:

```text
https://<pi>.<tailnet>.ts.net/
https://<pi>.<tailnet>.ts.net:8443/
```

Different ports are different browser origins, so each installed PWA has its
own service worker, caches, and stored Cairn token. Do not proxy instances under
paths such as `/owner` and `/partner`; Cairn intentionally uses root-scoped
`/api`, `/mcp`, `/sw.js`, and manifest URLs. Tailscale documents configurable
HTTPS listeners in [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

The apps currently share the visible name **Cairn**. On iOS, rename the second
one while using Share → Add to Home Screen (for example, “Cairn — Partner”).

Tailnet membership is the private network boundary; the independent Cairn token
is still required as defense in depth. Optional Tailscale Grants can further
limit a household member to only their HTTPS port.

## First use

1. Open the person's HTTPS URL and enter the token from that instance's `.env`.
2. Complete onboarding with their own sex, goals, demographics, constraints,
   and preferences before asking Cairn for analysis.
3. Create their plan in Plan or ask the connected coach to draft one; blank
   household instances deliberately do not inherit another person's program.
4. Connect their Garmin/Apple Health source to **their URL and token**.
5. Install and connect a coaching provider from Settings → Agents inside their
   instance. Keep provider logins separate unless the provider explicitly
   permits shared credentials.
6. Stagger scheduled coaching times if several instances use heavyweight agent
   CLIs on a small host; each Cairn process serializes its own work, but separate
   containers can run agents concurrently.

## Updates, backups, and removal

Operate from the member's directory so Compose selects the right project:

```bash
cd ~/cairn-partner
curl -fsSLo docker-compose.yml.new \
  https://github.com/zilet/cairn/releases/latest/download/docker-compose.yml
mv docker-compose.yml.new docker-compose.yml
docker compose pull
docker compose up -d
docker compose ps
```

Take an application-consistent SQLite snapshot with that instance's token:

```bash
cd ~/cairn-partner
umask 077
mkdir -p -m 700 backups
token="$(sed -n 's/^CAIRN_AUTH_TOKEN=//p' .env)"
curl -fsS -H "Authorization: Bearer $token" \
  http://127.0.0.1:8788/api/export/db -o backups/cairn-partner-snapshot.db
```

Back up its `cairn-data` and `cairn-home` volumes privately. The `cairn-tools`
volume is regenerable. Never use another person's token, backup directory, or
volume names for this project.

To stop the member instance without deleting data:

```bash
cd ~/cairn-partner
docker compose down
```

Do **not** add `-v` unless the person explicitly wants their database, uploads,
login state, and installed tools permanently erased. Disable its HTTPS listener
separately with `sudo tailscale serve --https=8443 off`.

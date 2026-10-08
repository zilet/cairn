# deploy/

How Cairn gets onto a machine that is not a developer's checkout.

| Path | What it is |
|---|---|
| [`install.sh`](install.sh) | The one-command installer (`curl -fsSL https://cairn.fit/install \| sh`). POSIX `sh`; guide in [`docs/INSTALL.md`](../docs/INSTALL.md). |
| [`docker-compose.release.yml`](docker-compose.release.yml) | The release Compose file for a manual Docker setup. |
| [`railway/`](railway/) | The Railway template, declared ([`template.json`](railway/template.json)), and how to build it into your own workspace ([`README.md`](railway/README.md)). |

## Adding a hosting provider

Railway is one convenient host, not a dependency. A new host slots in the same way:

1. **One line in the installer's provider table.** `PROVIDERS` in `install.sh` lists every host as
   `target|label|blurb`. The chooser, `--target=` validation and the no-terminal hint all read it, so
   the new host shows up as choice N with no other change to them.
2. **One provider block in `install.sh`.** A `<target>_main` function that handles the commands
   (`install`, `status`, `open`, `update`, `logs`, `uninstall`), with its helpers prefixed by the
   target (the Railway block uses `rw_*`). Reuse the shared pieces: `confirm`/`consent_script` for
   questions (every prompt reads `/dev/tty`), `rand_hex` for secrets, `signin_block` and
   `recovery_block` for the ending, `tel_chose`/`tel_done` for the anonymous counter. Secrets go to
   the host's CLI on stdin, never in argv. If the install leaves a `cairn.sh` and a state file behind,
   teach `resolve_target` to recognize that state file by the installer's marker.
3. **A `deploy/<target>/` folder** with whatever the host declares declaratively (a template or app
   spec as data, with the same variables as the installer) and a `README.md` on how anyone rebuilds
   it into their own account.
4. **Tests** in `test/installScript.test.js`, against a fake of the host's CLI on `PATH` (see
   `FAKE_RAILWAY`): the command sequence, secrets never in argv, and a spec-to-installer sync check.
   The suite already asserts that every target in `PROVIDERS` has its `<target>_main` and, for a
   remote host, its folder.
5. **Docs:** a section in [`docs/HOSTING.md`](../docs/HOSTING.md) and the options in
   [`docs/INSTALL.md`](../docs/INSTALL.md).

The app needs the same few things everywhere: one persistent volume at `/data`
(`CAIRN_SINGLE_VOLUME=1` when the host gives only one), `CAIRN_REQUIRE_AUTH=1` with a generated
`CAIRN_AUTH_TOKEN` and `CAIRN_SETTINGS_SECRET_KEY` on any public URL, `CAIRN_PLATFORM=<target>`,
`PORT`, and a health check on `/api/health`.

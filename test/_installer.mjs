// Shared rig for the installer tests (deploy/install.sh): the sandboxed `run()`, the
// fake container engine / curl / Railway CLI scripts and the per-area helpers. The tests
// themselves are split by area across test/installScript*.test.js so they run in parallel
// (each file spawns the POSIX installer dozens of times; one file was the suite's long pole).
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const script = path.join(root, "deploy", "install.sh");
// `sh` is dash on Debian/Ubuntu CI and bash-as-sh on macOS; set CAIRN_INSTALLER_TEST_SH
// (e.g. /bin/dash, busybox sh) to run the whole file under another POSIX shell.
export const SH = process.env.CAIRN_INSTALLER_TEST_SH || "sh";

// No installer test may ever reach this machine's real Tailscale node or container engine.
//
// Why: the installer's uninstall path runs `tailscale serve --https=443 off` and, for a purge,
// `docker compose down --volumes` for the instance named "cairn". On a host that really serves
// Cairn (a Pi with the live `cairn` stack and a Serve mapping on the default port 8787) a bare
// PATH let a plain test run switch that mapping off, and an uninstall test with a real engine on
// PATH removed the live container AND its data volumes. So every spawn gets a stand-in directory
// FIRST on PATH:
//   tailscale                       reports "not connected" (like a CI box) and records calls in
//                                   $CAIRN_TEST_TS_LOG; $CAIRN_TEST_TS_SERVES=<port> makes it report a
//                                   Serve mapping to that port, for the tests that look at teardown.
//   docker, podman, *-compose       refuse, unless the next one on PATH is a test fake living under
//                                   the temp dir (FAKE_DOCKER rigs put theirs in <tmp>/…/bin).
// Wrap an env with hermetic(env); run() already does.
export const FAKE_TAILSCALE = String.raw`#!/bin/sh
[ -n "$CAIRN_TEST_TS_LOG" ] && printf '%s\n' "$*" >> "$CAIRN_TEST_TS_LOG"
if [ -n "$CAIRN_TEST_TS_SERVES" ]; then
  case "$1 $2" in
    "serve status") printf 'https://fake.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:%s\n' "$CAIRN_TEST_TS_SERVES"; exit 0 ;;
    "serve --bg"|"serve --https=443") exit 0 ;;
  esac
  case "$1" in status) exit 0 ;; serve) exit 0 ;; esac
fi
exit 1
`;
export const ENGINE_GUARD = `#!/bin/sh
# Container-engine guard: only a fake that lives under the test temp dir may run.
me=$(basename "$0")
here=$(cd "$(dirname "$0")" && pwd -P)
for d in $(printf '%s' "$PATH" | tr ':' ' '); do
  real=$(cd "$d" 2>/dev/null && pwd -P) || continue
  [ "$real" = "$here" ] && continue
  if [ -x "$real/$me" ] && [ -n "$CAIRN_TEST_TMP" ]; then
    case "$real" in "$CAIRN_TEST_TMP"/*) exec "$real/$me" "$@" ;; esac
  fi
done
echo "$me: refused: the installer tests never touch a real container engine" >&2
exit 1
`;
let stubDir = null;
function stubDirectory() {
  if (!stubDir) {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-installer-stubs-"));
    fs.writeFileSync(path.join(stubDir, "tailscale"), FAKE_TAILSCALE, { mode: 0o755 });
    for (const engine of ["docker", "podman", "docker-compose", "podman-compose"]) {
      fs.writeFileSync(path.join(stubDir, engine), ENGINE_GUARD, { mode: 0o755 });
    }
    process.on("exit", () => fs.rmSync(stubDir, { recursive: true, force: true }));
  }
  return stubDir;
}
export function hermetic(env) {
  return {
    ...env,
    CAIRN_TEST_TMP: fs.realpathSync(os.tmpdir()),
    PATH: `${stubDirectory()}:${env.PATH ?? process.env.PATH}`,
  };
}

export function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-installer-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Run the installer with no terminal (CAIRN_NO_TTY) and a throwaway HOME. Linux is
// forced so the plan does not depend on the machine running the suite. The anonymous
// install counter is off (CAIRN_NO_TELEMETRY) unless a test turns it on against a fake
// curl, so no run can reach cairn.fit.
export function run(args, { env = {}, input, viaStdin = false } = {}) {
  const argv = viaStdin ? ["-s", "--", ...args] : [script, ...args];
  const res = spawnSync(SH, argv, {
    encoding: "utf8",
    input: viaStdin ? fs.readFileSync(script, "utf8") : input,
    env: hermetic({
      PATH: process.env.PATH,
      HOME: env.HOME || os.tmpdir(),
      TZ: "Europe/Berlin",
      CAIRN_NO_TTY: "1",
      CAIRN_INSTALL_OS: "Linux",
      CAIRN_INSTALL_ARCH: "x86_64",
      CAIRN_INSTALL_LONG_BIT: "64",
      CAIRN_NO_TELEMETRY: "1",
      ...env,
    }),
  });
  // The installer writes `<target>/.env`. An agent sandbox's secrets guard can refuse any
  // file named .env (EPERM, "Operation not permitted"); the script then dies mid-install and
  // the assertion that trips reads like a regression. Name the cause instead. A CI runner
  // or a normal shell never hits this.
  if (/\/\.env\S*: Operation not permitted/.test(res.stderr || "")) {
    throw new Error(
      "this environment refuses to create files named .env (an agent sandbox's secrets guard?). " +
        "The installer writes one, so run the installer tests unsandboxed — this is not a regression.\n" +
        res.stderr
    );
  }
  return { code: res.status, out: res.stdout, err: res.stderr, all: `${res.stdout}\n${res.stderr}` };
}

export function section(out, name) {
  const start = out.indexOf(`----- ${name}`);
  assert.notEqual(start, -1, `missing section ${name}\n${out}`);
  const body = out.slice(out.indexOf("\n", start) + 1);
  return body.slice(0, body.indexOf("----- end -----"));
}

export function envKeys(text) {
  return new Set([...text.matchAll(/^\s+- ([A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

// A stand-in container engine: `docker` and `curl` shims backed by files in a state
// dir, so install -> update (current / updated / rolled back / held back) ->
// "Update now" trigger -> uninstall run end to end with no real engine or network.
export const FAKE_DOCKER = String.raw`#!/bin/sh
S="$FAKE_STATE"
echo "docker $*" >>"$S/log"
key() { printf 'tag_%s' "$(printf '%s' "$1" | tr '/:@' '___')"; }
tagid() { cat "$S/$(key "$1")" 2>/dev/null; }
img() { sed -n 's/^CAIRN_IMAGE=//p' .env; }
case "$1" in
  info) exit 0 ;;
  compose)
    shift
    if [ "$1" = version ]; then echo "Docker Compose version v2"; exit 0; fi
    [ "$1" = -p ] && shift 2
    sub="$1"; shift
    case "$sub" in
      pull) [ -f "$S/pull_fails" ] && exit 1; cp "$S/remote_id" "$S/$(key "$(img)")" ;;
      up)
        [ -f "$S/$(key "$(img)")" ] || cp "$S/remote_id" "$S/$(key "$(img)")"
        tagid "$(img)" >"$S/running_id"; touch "$S/running" "$S/exists" ;;
      down)
        rm -f "$S/running" "$S/exists"
        case "$*" in *--volumes*) touch "$S/volumes_removed" ;; esac ;;
    esac
    exit 0 ;;
  container)
    shift; [ "$1" = inspect ] && shift
    fmt=""; if [ "$1" = -f ]; then fmt="$2"; shift 2; fi
    [ -f "$S/exists" ] || exit 1
    case "$fmt" in
      "") ;;
      *State.Running*) if [ -f "$S/running" ]; then echo true; else echo false; fi ;;
      *Labels*com.docker.compose.project*) echo "$FAKE_PROJECT" ;;
      *Image*) echo "sha256:$(cat "$S/running_id")" ;;
      *) echo "<no value>" ;;
    esac
    exit 0 ;;
  image)
    shift; [ "$1" = inspect ] && shift; [ "$1" = -f ] && shift 2
    id=$(tagid "$1"); [ -n "$id" ] || exit 1; echo "sha256:$id" ;;
  tag)
    case "$2" in *[!0-9a-f]*) id=$(tagid "$2") ;; *) id="$2" ;; esac
    [ -n "$id" ] || exit 1; printf '%s\n' "$id" >"$S/$(key "$3")" ;;
  exec)
    shift
    while :; do case "$1" in -i) shift ;; -u) shift 2 ;; *) break ;; esac; done
    shift
    case "$1" in
      test) [ -f "$S/trigger" ] ;;
      rm) rm -f "$S/trigger" ;;
      sh) cat >"$S/status.json" ;;
    esac ;;
  rmi) exit 0 ;;
  rm) rm -f "$S/running" "$S/exists" ;;
  volume) [ "$2" = rm ] && touch "$S/volumes_removed" ;;
esac
`;

export const FAKE_CURL = `#!/bin/sh
S="$FAKE_STATE"
echo "curl $*" >>"$S/log"
out=""; url=""; wfmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    --max-time | -X | -H | -d) shift 2 ;;
    -K) cat >>"$S/curl_config"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[ -f "$S/running" ] || exit 7
id=$(cat "$S/running_id")
case "$url" in
  */api/health) [ -f "$S/healthy_$id" ] || exit 22; printf '{"ok":true,"auth_required":true,"version":"%s"}' "$(cat "$S/healthy_$id")" ;;
  */api/export/db) printf 'SQLite format 3' >"$out" ;;
  */api/auth/pairing-codes)
    [ -f "$S/pairing_ok" ] || exit 6
    printf '{"code":"LOCL-0001","expires_at":"2026-01-01T00:10:00Z"}' >"$out"
    [ -z "$wfmt" ] || printf '200' ;;
  *) exit 6 ;;
esac
`;

// A stand-in Railway CLI: records argv (and the directory it ran in), refuses to run
// when any argument looks like a generated secret, and answers from files in a state
// dir. Deployments: every redeploy creates dep-N whose status walks $S/statuses.
export const FAKE_RAILWAY = String.raw`#!/bin/sh
S="$FAKE_STATE"
{ printf 'railway'; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >>"$S/rlog"
pwd >>"$S/rcwd"
for a in "$@"; do
  if printf '%s' "$a" | grep -Eq '[0-9a-f]{64}|^[a-z0-9]{48}$'; then touch "$S/secret_in_argv"; exit 99; fi
done
case "$*" in *--help*) echo "  --stdin   --from-source"; exit 0 ;; esac
stdin_value=""
case " $* " in
  *" --stdin "*) stdin_value=$(cat) ;;
  *) if [ ! -t 0 ] && [ -n "$(cat)" ]; then touch "$S/stdin_not_closed"; fi ;;
esac
DOMAIN="cairn-production-a1b2.up.railway.app"
TPL_ID="11111111-2222-4333-8444-555555555555"
cmd="$1"; shift
case "$cmd" in
  whoami) [ -f "$S/logged_out" ] && { echo "Unauthorized. Please login" >&2; exit 1; }; echo "Logged in as Test User" ;;
  list)
    [ -f "$S/fail_list_after_init" ] && [ -f "$S/project" ] && { echo "Error: network (fake)" >&2; exit 1; }
    printf '['
    if [ -f "$S/deleted_project" ]; then
      printf '\n  {"id": "proj-gone", "name": "%s", "deletedAt": "2026-10-10T13:25:12.286Z", "environments": {"edges": []}},' "$(cat "$S/deleted_project")"
    fi
    if [ -f "$S/existing_project" ]; then
      printf '\n  {"id": "proj-0", "name": "%s", "environments": {"edges": []}}' "$(cat "$S/existing_project")"
      [ -f "$S/project" ] && printf ','
    fi
    if [ -f "$S/project" ]; then
      printf '\n  {\n    "id": "proj-1",\n    "name": "%s",\n    "environments": {"edges": [{"node": {"id": "env-1", "name": "production"}}]},\n    "services": {"edges": [{"node": {"id": "svc-9", "name": "other"}}]}\n  }' "$(cat "$S/project")"
    fi
    printf '\n]\n' ;;
  init)
    while [ $# -gt 0 ]; do [ "$1" = --name ] && printf '%s' "$2" >"$S/project"; shift; done
    [ -f "$S/init_quiet" ] || echo '{"id":"proj-1"}' ;;
  link | unlink) ;;
  service)
    case "$1" in
      list) if [ -f "$S/service" ]; then echo '[{"id":"svc-1","name":"cairn"}]'; else echo '[]'; fi ;;
    esac ;;
  add)
    touch "$S/service"
    while [ $# -gt 0 ]; do [ "$1" = --variables ] && printf '%s\n' "$2" >>"$S/vars"; shift; done
    echo '{"id":"svc-1","name":"cairn"}' ;;
  volume)
    case "$1" in
      list) if [ -f "$S/volume" ]; then echo '[{"id":"vol-1","mountPath":"/data"}]'; else echo '[]'; fi ;;
      add) touch "$S/volume"; echo '{"id":"vol-1","mountPath":"/data"}' ;;
    esac ;;
  variable)
    sub="$1"; shift
    case "$sub" in
      list) cat "$S/vars" 2>/dev/null ;;
      set)
        if [ -n "$stdin_value" ]; then printf '%s=%s\n' "$1" "$stdin_value" >>"$S/vars"
        else while [ $# -gt 0 ]; do case "$1" in *=*) printf '%s\n' "$1" >>"$S/vars" ;; esac; shift; done; fi ;;
    esac ;;
  domain)
    if [ "$1" = list ]; then
      if [ -f "$S/domain" ]; then echo "{\"domains\":[{\"domain\":\"$DOMAIN\"}]}"; else echo '{"domains":[]}'; fi
    else touch "$S/domain"; echo "{\"domain\":\"$DOMAIN\",\"port\":8787}"; fi ;;
  redeploy)
    n=$(( $(cat "$S/deploy_n" 2>/dev/null || echo 1) + 1 ))
    echo "$n" >"$S/deploy_n"
    cp "$S/statuses" "$S/queue"
    echo "{\"id\":\"dep-$n\",\"status\":\"INITIALIZING\"}" ;;
  deployment)
    n=$(cat "$S/deploy_n" 2>/dev/null || echo 1)
    if [ "$n" -gt 1 ]; then
      st=$(head -n 1 "$S/queue")
      if [ "$(wc -l <"$S/queue")" -gt 1 ]; then tail -n +2 "$S/queue" >"$S/queue.next"; mv "$S/queue.next" "$S/queue"; fi
      printf '[{"id":"dep-%s","status":"%s","meta":{"image":"x"}},{"id":"dep-1","status":"CRASHED"}]\n' "$n" "$st"
    else
      echo '[{"id":"dep-1","status":"CRASHED"}]'
    fi ;;
  logs)
    echo "Starting Container"
    grep '^CAIRN_AUTH_TOKEN=' "$S/vars" 2>/dev/null
    echo "Error: listen EADDRINUSE (fake failure)" ;;
  delete) touch "$S/deleted"; echo '{"ok":true}' ;;
  environment)
    case "$1" in
      config)
        # source.autoUpdates as Railway shows it: $S/au_type holds the type once one is set.
        if [ -f "$S/au_type" ]; then
          printf '{"services":{"svc-1":{"source":{"image":"x","autoUpdates":{"type":"%s","schedule":[{"day":0,"startHour":2,"endHour":6}]}}}}}\n' "$(cat "$S/au_type")"
        else echo '{"services":{"svc-1":{"source":{"image":"x"}}}}'; fi ;;
      *) echo '{"environments":[{"id":"env-1","name":"production","isEphemeral":false}]}' ;;
    esac ;;
  api)
    q="$1"; shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --variables) case "$2" in @*) cp "$(printf '%s' "$2" | cut -c2-)" "$S/patch.json" ;; esac; shift ;;
        --raw-var) printf '%s\n' "$2" >>"$S/api_vars"; shift ;;
      esac
      shift
    done
    case "$q" in
      mutation*)
        [ -f "$S/fail_api_mutation" ] && { echo "Error: Not Authorized (fake)" >&2; exit 1; }
        if grep -q '"autoUpdates"' "$S/patch.json" 2>/dev/null; then echo patch >"$S/au_type"; fi
        echo '{"data":{"environmentPatchCommit":"commitChanges/env-1/patch-1"}}' ;;
      *) cat "$S/template_response" 2>/dev/null || echo '{"data":{"template":null}}' ;;
    esac ;;
  templates)
    sub="$1"
    [ -f "$S/fail_templates_$sub" ] && { echo "Error: templates $sub failed (fake)" >&2; exit 1; }
    case "$sub" in
      create) touch "$S/template"; echo '{"code":"AbC123","editorUrl":"https://railway.com/workspace/templates/'"$TPL_ID"'","id":"'"$TPL_ID"'","name":"Cairn","status":"UNPUBLISHED"}' ;;
      publish) touch "$S/published"; echo '{"code":"cairn","id":"'"$TPL_ID"'","status":"PUBLISHED"}' ;;
      delete) touch "$S/template_deleted"; echo '{"deleted":true}' ;;
    esac ;;
  *) echo "fake railway: unhandled $cmd" >&2; exit 64 ;;
esac
`;

export const FAKE_CURL_RAILWAY = String.raw`#!/bin/sh
S="$FAKE_STATE"
echo "curl $*" >>"$S/clog"
out=""; url=""; wfmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) wfmt="$2"; shift 2 ;;
    -K) cat >>"$S/curl_config"; shift 2 ;;
    -X | -H | -d | --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://raw.githubusercontent.com/*/overview.md) printf '# Cairn (fake overview)\n' >"$out" ;;
  https://*/api/health) printf '{"ok":true,"auth_required":true,"version":"2.1.0"}' ;;
  https://*/api/auth/pairing-codes)
    if [ -f "$S/pair_404" ]; then code=404; printf '{"error":"not_found"}' >"$out"
    else code=200; printf '{\n  "code": "ABCD-EF12",\n  "expires_at": "2026-10-07T12:10:00Z"\n}\n' >"$out"; fi
    [ -z "$wfmt" ] || printf '%s' "$code" ;;
  *) exit 6 ;;
esac
`;

export function railwayRig(dir) {
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  for (const [name, body] of [
    ["railway", FAKE_RAILWAY],
    ["curl", FAKE_CURL_RAILWAY],
    ["sleep", "#!/bin/sh\nexit 0\n"],
    ["xdg-open", '#!/bin/sh\necho "$1" >>"$FAKE_STATE/opened"\n'],
  ]) {
    fs.writeFileSync(path.join(bin, name), body);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  fs.writeFileSync(path.join(state, "statuses"), "BUILDING\nDEPLOYING\nSUCCESS\n");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: dir,
    FAKE_STATE: state,
    CAIRN_HEALTH_TIMEOUT: "9",
    DISPLAY: ":0",
  };
  const stateDir = path.join(dir, ".cairn", "railway", "cairn");
  const read = (name) => (fs.existsSync(path.join(state, name)) ? fs.readFileSync(path.join(state, name), "utf8") : "");
  const cairnSh = (args) => {
    const res = spawnSync(SH, [path.join(stateDir, "cairn.sh"), ...args], {
      encoding: "utf8",
      env: hermetic({
        ...env,
        CAIRN_NO_TTY: "1",
        CAIRN_INSTALL_OS: "Linux",
        CAIRN_INSTALL_ARCH: "x86_64",
        CAIRN_INSTALL_LONG_BIT: "64",
      }),
    });
    return { code: res.status, out: res.stdout, err: res.stderr, all: `${res.stdout}\n${res.stderr}` };
  };
  const secrets = () => {
    const vars = read("vars");
    return {
      token: /^CAIRN_AUTH_TOKEN=([0-9a-f]{64})$/m.exec(vars)?.[1],
      key: /^CAIRN_SETTINGS_SECRET_KEY=([0-9a-f]{64})$/m.exec(vars)?.[1],
    };
  };
  return { state, env, stateDir, read, cairnSh, secrets };
}

// Assert that `wanted` appear in `lines` in this order (other lines may sit between).
export function assertSequence(lines, wanted) {
  let at = 0;
  for (const want of wanted) {
    const found = lines.findIndex((line, i) => i >= at && line.startsWith(want));
    assert.notEqual(found, -1, `missing (in order) "${want}" in:\n${lines.join("\n")}`);
    at = found + 1;
  }
}

// --yes answers prompts but is never consent to run a downloaded third-party install script
// (get.docker.com, railway.com/install.sh). Only --install-docker / --install-railway-cli, or an
// interactive yes, is. The rig fakes curl so the "downloaded script" only drops a marker file.
export function scriptConsentRig(dir, { railway = false } = {}) {
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  const installBody = railway
    ? '#!/bin/sh\ntouch "$FAKE_STATE/ran"\nmkdir -p "$HOME/.railway/bin"\nprintf "#!/bin/sh\\nexit 1\\n" >"$HOME/.railway/bin/railway"\nchmod +x "$HOME/.railway/bin/railway"\n'
    : '#!/bin/sh\ntouch "$FAKE_STATE/ran"\n';
  fs.writeFileSync(path.join(state, "installbody"), installBody);
  const files = {
    curl: `#!/bin/sh
echo "curl $*" >>"$FAKE_STATE/clog"
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
cat "$FAKE_STATE/installbody" >"$out"
`,
    // Never really escalate or touch the host: run only the downloaded script.
    sudo: '#!/bin/sh\nif [ "$1" = "sh" ]; then exec "$@"; fi\nexit 0\n',
    usermod: "#!/bin/sh\nexit 0\n",
    npm: "#!/bin/sh\nexit 1\n",
    sleep: "#!/bin/sh\nexit 0\n",
  };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(bin, name), body);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: dir,
    FAKE_STATE: state,
    TMPDIR: dir,
    CAIRN_CONTAINER_TOOL: "no-such-engine",
  };
  return { env, ran: () => fs.existsSync(path.join(state, "ran")) };
}

// ----------------------------------------------------------------------------- install counting

// The anonymous installer funnel: one GET when the plan is accepted (`chose`), one at the
// end (`done` or `failed` with a fixed step code). Every test points it at a fake curl.
export const EVENT_URL = "https://events.example.test/install/event";
export const COUNTING = { CAIRN_NO_TELEMETRY: "", CAIRN_INSTALL_EVENT_URL: EVENT_URL };
export const eventLines = (log) => log.split("\n").filter((line) => line.includes(EVENT_URL));
export const eventQuery = (line) => {
  const url = line.split(" ").find((word) => word.startsWith(EVENT_URL));
  return Object.fromEntries(new URL(url).searchParams);
};

// ----------------------------------------------------------------------------- Railway template

export const specPath = path.join(root, "deploy", "railway", "template.json");
export const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
// Railway's per-deployer secret function (a template string with the placeholder escaped).
export const SECRET_FN = `\${{secret(48)}}`;
export const TPL_ID = "11111111-2222-4333-8444-555555555555";
export const specSecrets = Object.keys(spec.variables).filter((k) => /^\$\{\{secret\(/.test(spec.variables[k].value));
export const specPlain = Object.entries(spec.variables).filter(([k]) => !specSecrets.includes(k));

// A shell assignment from install.sh: NAME="value" or NAME='value'.
export function shellConst(name) {
  const m = new RegExp(`^${name}=(?:"([^"]*)"|'([^']*)'|(\\S+))$`, "m").exec(fs.readFileSync(script, "utf8"));
  assert.ok(m, `install.sh has no ${name}=`);
  return m[1] ?? m[2] ?? m[3];
}

// What `railway api` answers for the draft: the shape Railway's template generate produced live
// (2026-10-08, CLI 5.64): every variable's default, the health check, volume and domain, but no
// variable descriptions and no image auto updates. Options model the editor having added them,
// or a draft that carries a fixed secret.
export function templateResponse({
  descriptions = false,
  autoUpdates = false,
  fixed = {},
  drop = [],
  status = "UNPUBLISHED",
} = {}) {
  const variables = {};
  for (const [k, v] of Object.entries(spec.variables)) {
    if (drop.includes(k)) continue;
    variables[k] = { defaultValue: fixed[k] ?? v.value, isOptional: false };
    if (descriptions) variables[k].description = v.description;
  }
  const svc = "00000000-0000-4000-8000-000000000000";
  const source = { image: spec.service.image };
  if (autoUpdates)
    source.autoUpdates = { type: spec.service.autoUpdates.type, schedule: spec.service.autoUpdates.schedule };
  return JSON.stringify(
    {
      data: {
        template: {
          id: TPL_ID,
          code: "AbC123",
          name: "Cairn",
          status,
          serializedConfig: {
            buckets: {},
            services: {
              [svc]: {
                deploy: {
                  healthcheckPath: spec.service.healthcheckPath,
                  restartPolicyMaxRetries: 10,
                  startCommand: null,
                },
                icon: null,
                name: spec.service.name,
                networking: { serviceDomains: { [`<hasDomain>:${spec.service.port}`]: { port: spec.service.port } } },
                source,
                variables,
                volumeMounts: { [svc]: { mountPath: spec.service.volumeMountPath } },
              },
            },
          },
        },
      },
    },
    null,
    2
  );
}

export function templateRig(dir, response = templateResponse()) {
  const rig = railwayRig(dir);
  fs.writeFileSync(path.join(rig.state, "template_response"), response);
  rig.env.TMPDIR = dir;
  const go = (args, env = {}) => run(["railway-template", ...args], { env: { ...rig.env, ...env } });
  const log = () => rig.read("rlog").trim().split("\n").filter(Boolean);
  const has = (name) => fs.existsSync(path.join(rig.state, name));
  const leftovers = () => fs.readdirSync(dir).filter((f) => f.startsWith("cairn-railway-template."));
  return { ...rig, go, log, has, leftovers };
}

// No generated secret (48-char secret() output, or the installer's own 64-hex) anywhere.
export function assertNoSecretValues(text) {
  assert.doesNotMatch(text, /[0-9a-f]{64}/);
  assert.doesNotMatch(text, /(^|[^A-Za-z0-9])[a-z0-9]{48}([^A-Za-z0-9]|$)/m);
}

// The autoUpdates value the spec declares (what the installer and the template both set).
export function autoUpdatesSpec() {
  return { type: spec.service.autoUpdates.type, schedule: spec.service.autoUpdates.schedule };
}

// The argv a printed re-run hint gives when a shell runs it: everything after `sh -s -- `.
export function hintArgv(text) {
  const m = /sh -s -- (.*)$/m.exec(text);
  assert.ok(m, `no re-run hint in:\n${text}`);
  const res = spawnSync(SH, ["-c", `set -- ${m[1]}; for a in "$@"; do printf '%s\\0' "$a"; done`], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.split("\0").slice(0, -1);
}

// A recorded install, with its project live in the fake Railway unless `live` is false.
export function recordedRig(dir, { name = "cairn", id = "proj-1", live = true, liveName = name } = {}) {
  const rig = railwayRig(dir);
  if (live) fs.writeFileSync(path.join(rig.state, "project"), liveName);
  fs.mkdirSync(rig.stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(rig.stateDir, "railway.state"),
    `RW_PROJECT_ID=${id}\nRW_PROJECT_NAME=${name}\nRW_SERVICE=cairn\nRW_ENVIRONMENT=production\nRW_DOMAIN=x.up.railway.app\n`
  );
  return rig;
}

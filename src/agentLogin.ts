import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildAgentSpawnOptions } from "./agentExecution.js";
import { resourceFailure, resourceFailureHeadline } from "./agentAvailability.js";
import { loadAgents } from "./agents.js";
import { log } from "./log.js";

// ---------------------------------------------------------------------------
// In-app coaching-CLI login bridge (Stream A).
//
// Lets the browser drive an interactive CLI login (claude / codex / grok / agy)
// rendered in an embedded terminal. We allocate a REAL PTY without any native
// module (no node-pty / node-gyp — the "no native build" rule):
//   • Linux (the Docker path): the util-linux `script -qfc "<cmd>" /dev/null`
//     makes the child's stdout a TTY over plain pipes — verified rendering the
//     CLI login TUI end-to-end through this bridge.
//   • macOS: BSD `script` can't allocate a PTY when its own stdin is a pipe (a
//     server subprocess), so we use `python3 -c 'import pty; pty.spawn([...])'`,
//     which does work with piped stdio and ships on macOS / most POSIX.
// Either way the child runs under a real TTY, which is what the CLIs need to
// render their onboarding/login TUI and what xterm.js consumes on the other end.
//
// The login command is chosen SERVER-SIDE from the agents.json allowlist — the
// client only supplies `agent` (validated) and keystrokes. We never interpolate
// client data into the command string.
// ---------------------------------------------------------------------------

// Mirror src/agents.ts: login subprocesses inherit the server's HOME so tokens
// land in ~/.claude / ~/.codex / ~/.gemini / ~/.grok where later agent runs read
// them, but they run from an isolated agent workspace instead of DATA_DIR.

// Per-CLI login argv, APPENDED to the agent's `command`. Stream B adds a `login`
// field to each agent in agents.json; we PREFER that when present and fall back
// to this map so we don't depend on Stream B landing first. (Verified per
// docs/AGENT_CONNECT_BUILD_PLAN.md §4.1 against the live image.)
const FALLBACK_LOGIN: Record<string, string[]> = {
  claude: ["auth", "login"],
  codex: ["login", "--device-auth"],
  grok: ["login", "--device-auth"], // re-verified on grok 1.0.46: URL + XXXX-XXXX code, no TTY needed
  antigravity: [], // bare interactive `agy` — agy 1.3.1 has no login subcommand; launching it bare IS the sign-in
};

// How much of the PTY's recent output is kept to explain a failed exit.
const EXIT_TAIL_CHARS = 4096;
const EXIT_DETAIL_MAX = 200;

// The one line worth showing a person when a login CLI exits non-zero: the last line
// that reads like an error, else the last non-empty line. Terminal escapes, carriage
// returns and box-drawing are stripped; a URL-only line (a sign-in link) never counts.
export function loginExitDetail(output: string): string | null {
  const plain = String(output || "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the point
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the point
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are the point
    .replace(/\x1b[()][A-Za-z0-9]|\x1b[=>78]/g, "");
  const lines = plain
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/[\u2500-\u257f\u2580-\u259f]+/g, " ").replace(/\s+/g, " ").trim())
    // A bare URL (the sign-in link) or a JSON envelope (print-mode telemetry) is never
    // the sentence to show a person.
    .filter((line) => line && !/^https?:\/\/\S+$/.test(line) && !/^[{[]/.test(line));
  if (!lines.length) return null;
  const errorLine = [...lines].reverse().find((line) => /\b(error|failed|denied|expired|invalid|unauthori[sz]ed|forbidden|not found|timed out|refused)\b/i.test(line));
  const pick = errorLine || lines[lines.length - 1];
  return pick.length > EXIT_DETAIL_MAX ? `${pick.slice(0, EXIT_DETAIL_MAX - 1)}\u2026` : pick;
}

// A login line made safe for the SERVER LOG: sign-in links (they carry codes and
// state), device codes and anything token-shaped are replaced. The person still sees
// the CLI's own words in the panel; only the log is scrubbed.
export function scrubLoginLogLine(line: string | null | undefined): string | null {
  if (!line) return null;
  return line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
    .replace(/\b[A-Z0-9]{3,}-[A-Z0-9]{3,}\b/g, "[code]")
    .replace(/[A-Za-z0-9_\-.~+/=]{24,}/g, "[redacted]")
    .slice(0, 200);
}

// Lifecycle bounds — mirror the chat-turn Stop ergonomics.
const IDLE_TIMEOUT_MS = 5 * 60_000; // no I/O for 5 min → kill
const HARD_CAP_MS = 15 * 60_000; // a login should never run longer than this

// PTY dimensions. `script`/pty.spawn fix the window at spawn (no native ioctl to
// resize later), so the client sends its REAL fitted size up front and we bake it
// in. The clamp floor matters: agy's sign-in screen is ~27 rows — at the old fixed
// 80x24 the OAuth URL and the authorization-code field sat below the fold, which
// read as "stuck at Signing in…". The default stays for size-less connects.
export const DEFAULT_PTY_SIZE = { cols: 100, rows: 32 } as const;
export function clampPtySize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = Number(cols);
  const r = Number(rows);
  return {
    cols: Number.isFinite(c) && c > 0 ? Math.min(400, Math.max(40, Math.floor(c))) : DEFAULT_PTY_SIZE.cols,
    rows: Number.isFinite(r) && r > 0 ? Math.min(200, Math.max(20, Math.floor(r))) : DEFAULT_PTY_SIZE.rows,
  };
}

export interface LoginCallbacks {
  onData?: (chunk: Buffer) => void;
  // `detail` is the CLI's own last error line when it exited non-zero on its own (a
  // forced kill or a clean exit carries none) — so a login that dies at once can say
  // why instead of reading as a silent "not signed in yet".
  // `reason` is set when the SERVER ran out of disk or memory; `detail` is then the
  // plain headline that says what to do.
  onExit?: (code: number | null, detail?: string | null, reason?: "disk_full" | "out_of_memory" | null) => void;
  onError?: (err: Error) => void;
}

export interface LoginSession {
  id: string;
  agent: string;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface ActiveSession extends LoginSession {
  child: ChildProcess;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  cols: number;
  rows: number;
  closed: boolean;
}

// Single active session per server (a login is a brief, human-driven, one-at-a-
// time act). A second concurrent start throws "BUSY…".
let active: ActiveSession | null = null;

export function loginSessionActive(): boolean {
  return !!active && !active.closed;
}

// Kill any in-progress login session — called on server shutdown so a mid-login
// PTY (and its child CLI) isn't orphaned on redeploy/restart.
export function killActiveLoginSession(): void {
  try {
    active?.kill();
  } catch {
    /* best effort */
  }
}

// Resolve the login argv for an agent from the allowlist. Throws if the agent is
// unknown / has no command. Returns null only when the agent is known but has no
// login capability declared anywhere (caller decides how to surface that).
export function resolveLoginArgv(agent: string): string[] {
  const agents = loadAgents();
  const def = agents[agent];
  if (!def || !def.command) {
    throw new Error(`Unknown agent "${agent}" — not in the configured allowlist.`);
  }
  // PREFER a `login` field from agents.json (Stream B), else the hardcoded
  // fallback. An agent with neither is treated as having no login flow.
  const login = (def as { login?: unknown }).login;
  const argv = Array.isArray(login) ? (login as string[]) : FALLBACK_LOGIN[agent];
  if (!argv) {
    throw new Error(`Agent "${agent}" does not support an interactive login.`);
  }
  return [def.command, ...argv];
}

// Pure, platform-PARAMETERIZED PTY invocation shape — no host probing and no side
// effects, so every platform's wrapper can be unit-tested from any dev machine, the
// Linux/Docker path (the one that actually ships) INCLUDED. That coverage is the
// whole point: a shell-quoting change to this function once passed local macOS tests
// yet failed the Linux CI build, because the host-bound branch was the only one a
// dev box ever exercised. `buildPtyInvocation` below is the thin host-bound wrapper
// that adds the runtime guard (macOS python3 presence) this pure function omits.
// The login argv is a fixed, server-chosen array — never client data.
export function ptyInvocationFor(
  platform: NodeJS.Platform,
  loginArgv: string[],
  size: { cols: number; rows: number } = DEFAULT_PTY_SIZE,
): { command: string; args: string[] } {
  if (platform === "win32") {
    throw new Error("In-app login is unsupported on Windows — run the CLI login in a terminal (e.g. `docker exec`).");
  }
  // Both platform paths fix the PTY window at spawn, so the size is applied from
  // INSIDE the PTY via stty before exec. The command STRING runs via /bin/sh, so
  // each token remains shell-quoted (the argv is server-chosen, but a future
  // agents.json entry with a space / metachar must not word-split or inject).
  const quoted = loginArgv.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(" ");
  const cmd = `stty cols ${Math.floor(size.cols)} rows ${Math.floor(size.rows)}; exec ${quoted}`;
  if (platform === "darwin") {
    // python3's pty.spawn allocates a PTY for the child even when its OWN stdio is
    // piped — BSD `script` instead errors (tcgetattr) on a non-tty stdin. The sh -c
    // wrapper applies the same stty init as the Linux path; the command string is
    // JSON-encoded into a Python string-list literal (safe).
    const code = `import pty,sys; sys.exit(pty.spawn(${JSON.stringify(["sh", "-c", cmd])}) >> 8)`;
    return { command: "python3", args: ["-c", code] };
  }
  // Linux (util-linux) and other POSIX with util-linux `script`: when `script` is
  // itself driven through pipes (our WebSocket bridge), its child PTY starts at
  // 0x0. Most login CLIs tolerate that; Antigravity waits for a usable window and
  // therefore renders nothing.
  return { command: "script", args: ["-qfc", cmd, "/dev/null"] };
}

// Build the host's PTY invocation: delegate the shape to `ptyInvocationFor` and add
// the runtime guard it deliberately omits — on macOS the python3 PTY path needs
// python3 actually present (it ships with the Xcode CLT, but isn't guaranteed).
export function buildPtyInvocation(
  loginArgv: string[],
  size: { cols: number; rows: number } = DEFAULT_PTY_SIZE,
): { command: string; args: string[] } {
  if (process.platform === "darwin" && !python3Present()) {
    throw new Error(
      "In-app login on macOS needs python3 (it ships with the Xcode Command Line Tools: `xcode-select --install`), or run Cairn via Docker.",
    );
  }
  return ptyInvocationFor(process.platform, loginArgv, size);
}

export function buildLoginSpawnOptions(sourceEnv: NodeJS.ProcessEnv = process.env) {
  return buildAgentSpawnOptions({ kind: "login", sourceEnv });
}

// Cached presence probe for the macOS python3 PTY path (mirrors agents.ts).
let _python3Present: boolean | null = null;
function python3Present(): boolean {
  if (_python3Present !== null) return _python3Present;
  try {
    const r = spawnSync("python3", ["--version"], { stdio: "ignore", timeout: 4000 });
    _python3Present = !r.error;
  } catch {
    _python3Present = false;
  }
  return _python3Present;
}

export function startLoginSession(
  opts: { agent: string; cols?: number; rows?: number } & LoginCallbacks,
): LoginSession {
  if (active && !active.closed) {
    throw new Error("BUSY: a login session is already in progress. Close it before starting another.");
  }

  const { agent, onData, onExit, onError } = opts;
  // Validate + resolve the login command from the allowlist (throws on unknown
  // agent / no-login agent — before any spawn).
  const loginArgv = resolveLoginArgv(agent);
  const size = clampPtySize(opts.cols, opts.rows);
  const { command, args } = buildPtyInvocation(loginArgv, size);

  // Interactive login needs to reach ~/.claude etc., so we KEEP HOME/PATH/USER
  // (and the rest of the inherited env). The login CLIs authenticate to EXTERNAL
  // providers (Anthropic/OpenAI/xAI/Google), never to Cairn — and every byte of
  // their PTY output is streamed to the browser. So we strip the same Cairn-owned
  // secrets/config that the headless agent runner denies to subprocesses.
  const child = spawn(command, args, buildLoginSpawnOptions());

  const id = randomUUID();
  let outputTail = "";

  const session: ActiveSession = {
    id,
    agent,
    child,
    idleTimer: null,
    hardTimer: null,
    cols: size.cols,
    rows: size.rows,
    closed: false,
    write(data: Buffer | string) {
      if (this.closed) return;
      try {
        child.stdin?.write(data);
      } catch {
        /* stdin already closed — child is exiting */
      }
      bumpIdle(this);
    },
    resize(cols: number, rows: number) {
      // Best-effort: `script` fixes the PTY window size at spawn, so we can't
      // resize the underlying TTY without a native ioctl. Record the dims so a
      // future native path could use them; this is intentionally a near no-op.
      if (Number.isFinite(cols) && cols > 0) this.cols = Math.floor(cols);
      if (Number.isFinite(rows) && rows > 0) this.rows = Math.floor(rows);
    },
    kill() {
      finish(this, null, true);
    },
  };

  // ---- timers ----
  const clearTimers = (s: ActiveSession) => {
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    if (s.hardTimer) {
      clearTimeout(s.hardTimer);
      s.hardTimer = null;
    }
  };

  function bumpIdle(s: ActiveSession) {
    if (s.closed) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      finish(s, null, true);
    }, IDLE_TIMEOUT_MS);
    s.idleTimer.unref?.();
  }

  // finish: tear the session down exactly once (clear timers, SIGKILL, registry,
  // and fire onExit). `killed` distinguishes a forced kill from a natural exit.
  function finish(s: ActiveSession, code: number | null, killed: boolean) {
    if (s.closed) return;
    s.closed = true;
    clearTimers(s);
    if (active === s) active = null;
    if (killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    const failed = !killed && code !== 0;
    const resource = failed ? resourceFailure({ code, raw: outputTail }) : null;
    const reason = resource ? (resource.state as "disk_full" | "out_of_memory") : null;
    const label = String(loadAgents()[agent]?.label || agent);
    const detail = reason
      ? resourceFailureHeadline(reason, label)
      : failed && code !== null
        ? loginExitDetail(outputTail)
        : null;
    const fields = { agent, code, killed, reason, detail: scrubLoginLogLine(detail) };
    if (killed || code === 0) log.info("[agent-login] ended", fields);
    else log.warn("[agent-login] exited without signing in", fields);
    try {
      onExit?.(code, detail, reason);
    } catch {
      /* a bad consumer must never break teardown */
    }
  }

  // ---- wire child I/O ----
  const handleData = (buf: Buffer) => {
    bumpIdle(session);
    outputTail = (outputTail + buf.toString("utf8")).slice(-EXIT_TAIL_CHARS);
    try {
      onData?.(buf);
    } catch {
      /* a bad consumer must never kill the stream */
    }
  };
  child.stdout?.on("data", handleData);
  child.stderr?.on("data", handleData);

  child.on("error", (err) => {
    try {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } catch {
      /* ignore */
    }
    finish(session, null, false);
  });

  child.on("exit", (code) => {
    finish(session, code, false);
  });

  // Hard cap: a login that drags on past the ceiling is killed regardless of I/O.
  session.hardTimer = setTimeout(() => {
    finish(session, null, true);
  }, HARD_CAP_MS);
  session.hardTimer.unref?.();
  bumpIdle(session);

  active = session;
  log.info("[agent-login] started", { agent, cols: size.cols, rows: size.rows });
  return session;
}

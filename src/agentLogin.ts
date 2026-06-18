import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadAgents } from "./agents.js";

// ---------------------------------------------------------------------------
// In-app coaching-CLI login bridge (Stream A).
//
// Lets the browser drive an interactive CLI login (claude / codex / grok / agy)
// rendered in an embedded terminal. We allocate a REAL PTY without any native
// module (no node-pty / node-gyp — the "no native build" rule) by spawning the
// OS `script` utility: `script -qfc "<cmd>" /dev/null` makes the child's stdout
// a TTY over plain pipes, which is exactly what the CLIs need to render their
// onboarding/login TUI and what xterm.js consumes on the other end.
//
// The login command is chosen SERVER-SIDE from the agents.json allowlist — the
// client only supplies `agent` (validated) and keystrokes. We never interpolate
// client data into the command string.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirror src/agents.ts: the login subprocess runs with the data dir as cwd, and
// inherits the server's HOME so tokens land in ~/.claude · ~/.codex · ~/.gemini
// where the agent runs read them (the server already runs as the `app` user).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

// Per-CLI login argv, APPENDED to the agent's `command`. Stream B adds a `login`
// field to each agent in agents.json; we PREFER that when present and fall back
// to this map so we don't depend on Stream B landing first. (Verified per
// docs/AGENT_CONNECT_BUILD_PLAN.md §4.1 against the live image.)
const FALLBACK_LOGIN: Record<string, string[]> = {
  claude: ["auth", "login"],
  codex: ["login"],
  grok: ["login", "--device-auth"],
  antigravity: [], // bare interactive `agy`
};

// Lifecycle bounds — mirror the chat-turn Stop ergonomics.
const IDLE_TIMEOUT_MS = 5 * 60_000; // no I/O for 5 min → kill
const HARD_CAP_MS = 15 * 60_000; // a login should never run longer than this

export interface LoginCallbacks {
  onData?: (chunk: Buffer) => void;
  onExit?: (code: number | null) => void;
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

// Resolve the login argv for an agent from the allowlist. Throws if the agent is
// unknown / has no command. Returns null only when the agent is known but has no
// login capability declared anywhere (caller decides how to surface that).
function resolveLoginArgv(agent: string): string[] {
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

// Build the platform-specific `script` argv that wraps the login command in a PTY.
//   linux  → script -qfc "<joined cmd>" /dev/null   (util-linux)
//   darwin → script -q /dev/null <argv...>          (BSD `script`)
// The login argv is a fixed, server-chosen array — never client data.
function buildScriptInvocation(loginArgv: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    throw new Error("PTY login is unsupported on Windows — use `docker exec` to run the CLI login.");
  }
  if (process.platform === "darwin") {
    // BSD script: pass the command as separate argv after the typescript file.
    return { command: "script", args: ["-q", "/dev/null", ...loginArgv] };
  }
  // Linux (util-linux) and other POSIX: -c takes a single command STRING.
  return { command: "script", args: ["-qfc", loginArgv.join(" "), "/dev/null"] };
}

export function startLoginSession(opts: { agent: string } & LoginCallbacks): LoginSession {
  if (active && !active.closed) {
    throw new Error("BUSY: a login session is already in progress. Close it before starting another.");
  }

  const { agent, onData, onExit, onError } = opts;
  // Validate + resolve the login command from the allowlist (throws on unknown
  // agent / no-login agent — before any spawn).
  const loginArgv = resolveLoginArgv(agent);
  const { command, args } = buildScriptInvocation(loginArgv);

  // Interactive login needs to reach ~/.claude etc., so we KEEP HOME/PATH/USER
  // (and the rest of the inherited env). This is a human-driven login, not a
  // headless agent run, so we deliberately do NOT strip secrets here.
  const env = { ...process.env };

  const child = spawn(command, args, {
    cwd: fs.existsSync(DATA_DIR) ? DATA_DIR : undefined,
    env,
  });

  const id = randomUUID();

  const session: ActiveSession = {
    id,
    agent,
    child,
    idleTimer: null,
    hardTimer: null,
    cols: 80,
    rows: 24,
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
    try {
      onExit?.(code);
    } catch {
      /* a bad consumer must never break teardown */
    }
  }

  // ---- wire child I/O ----
  const handleData = (buf: Buffer) => {
    bumpIdle(session);
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
  return session;
}

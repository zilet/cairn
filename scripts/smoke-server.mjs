import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..");
export const serverEntry = path.join(root, "dist", "server.js");

const requestedPort = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : 0;
const usedPorts = new Set();
const RANDOM_PORT_MIN = 18000;
const RANDOM_PORT_SPAN = 7000; // 18000-24999: avoids upper loopback ports blocked by some sandboxes.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickPort(offset = 0, attempt = 0) {
  if (requestedPort) {
    const port = requestedPort + offset + attempt;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid SMOKE_PORT-derived port: ${port}`);
    }
    return port;
  }
  for (let i = 0; i < 100; i++) {
    const port = RANDOM_PORT_MIN + Math.floor(Math.random() * RANDOM_PORT_SPAN);
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error("could not choose a unique smoke port");
}

async function waitForHealth(ctx, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastFetchError = "";
  while (Date.now() < deadline) {
    const log = ctx.serverLog();
    if (/EADDRINUSE|EACCES/.test(log)) return { ok: false, retryable: true };
    try {
      const res = await fetch(`${ctx.base}/api/health`);
      if (res.ok) return { ok: true };
    } catch (error) {
      lastFetchError = error?.cause?.code || error?.cause?.message || error?.message || String(error);
    }
    await sleep(log.includes("Cairn running:") ? 100 : 250);
  }
  return { ok: false, retryable: false, error: lastFetchError };
}

export async function stopServer(ctx) {
  try {
    if (ctx.child.exitCode == null && ctx.child.signalCode == null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        ctx.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        ctx.child.kill("SIGKILL");
      });
    }
  } finally {
    try { rmSync(ctx.dir, { recursive: true, force: true }); } catch {}
  }
}

export async function startBuiltServer({ label, authToken = "", portOffset = 0, extraEnv = {} }) {
  let lastLog = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = pickPort(portOffset, attempt);
    const base = `http://127.0.0.1:${port}`;
    const dir = mkdtempSync(path.join(tmpdir(), `cairn-smoke-${label}-`));
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dir,
      DB_PATH: path.join(dir, "cairn-smoke.db"),
      CAIRN_AUTH_TOKEN: authToken,
      CAIRN_RATE_LIMIT: "0",
      GEMINI_API_KEY: "",
      GOOGLE_AI_KEY: "",
      GARMIN_USERNAME: "",
      GARMIN_PASSWORD: "",
      COACH_ENABLED: "0",
      ...extraEnv,
    };

    const child = spawn(process.execPath, [serverEntry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });

    let serverLog = "";
    child.stdout.on("data", (d) => { serverLog += d.toString(); });
    child.stderr.on("data", (d) => { serverLog += d.toString(); });

    const ctx = { label, port, base, dir, child, serverLog: () => serverLog };
    const ready = await waitForHealth(ctx);
    if (ready.ok) return ctx;

    lastLog = serverLog;
    await stopServer(ctx);
    if (!ready.retryable) {
      if (ready.error) lastLog += `\n[smoke] last readiness fetch error: ${ready.error}\n`;
      break;
    }
  }

  const tail = lastLog.trim() ? `\n--- server output (tail) ---\n${lastLog.split("\n").slice(-20).join("\n")}` : "";
  throw new Error(`${label} server did not become healthy within the timeout${tail}`);
}

export async function withServer(opts, fn) {
  const ctx = await startBuiltServer(opts);
  try {
    console.log(`Cairn smoke: ${ctx.label} server up on ${ctx.base} (temp DB at ${ctx.dir})`);
    await fn(ctx);
  } catch (error) {
    error.serverLog = ctx.serverLog();
    throw error;
  } finally {
    await stopServer(ctx);
  }
}

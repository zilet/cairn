export const DEFAULT_SMOKE_MAX_RUNTIME_MS = 20 * 60_000;

export function smokeMaxRuntimeMs(env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.CAIRN_SMOKE_MODE !== "1") return null;
  // Defense in depth: this kill switch is valid only for a throwaway smoke DB.
  const dataDir = String(env.DATA_DIR || "");
  const dbPath = String(env.DB_PATH || "");
  if (!/cairn-(?:smoke|browser-smoke)-/.test(`${dataDir} ${dbPath}`)) return null;
  const requested = Number(env.CAIRN_SMOKE_MAX_RUNTIME_MS);
  if (!Number.isFinite(requested)) return DEFAULT_SMOKE_MAX_RUNTIME_MS;
  return Math.min(Math.max(Math.round(requested), 60_000), 30 * 60_000);
}

export function installSmokeLifetime(
  options: { env?: NodeJS.ProcessEnv; terminate?: () => void; setTimer?: typeof setTimeout } = {}
): ReturnType<typeof setTimeout> | null {
  const maxRuntime = smokeMaxRuntimeMs(options.env);
  if (maxRuntime == null) return null;
  const timer = (options.setTimer ?? setTimeout)(
    options.terminate ?? (() => process.kill(process.pid, "SIGTERM")),
    maxRuntime
  );
  timer.unref?.();
  return timer;
}

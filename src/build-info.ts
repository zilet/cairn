import { execFileSync } from "node:child_process";
import { getVersion } from "./version.js";

export interface BuildInfo {
  version: string;
  build_sha: string | null;
  build_source: "environment" | "git" | "fallback";
  build_id: string;
}

function validSha(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{7,64}$/.test(text) ? text.slice(0, 40) : null;
}

export function resolveBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  readGitSha: () => string = () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
): BuildInfo {
  const fromEnv = validSha(env.CAIRN_BUILD_SHA);
  if (fromEnv) {
    return { version: getVersion(), build_sha: fromEnv, build_source: "environment", build_id: fromEnv.slice(0, 12) };
  }
  try {
    const fromGit = validSha(readGitSha());
    if (fromGit)
      return { version: getVersion(), build_sha: fromGit, build_source: "git", build_id: fromGit.slice(0, 12) };
  } catch {
    /* runtime images intentionally contain no .git directory */
  }
  return { version: getVersion(), build_sha: null, build_source: "fallback", build_id: "source-unidentified" };
}

let cached: BuildInfo | null = null;
export function getBuildInfo(): BuildInfo {
  if (!cached) cached = resolveBuildInfo();
  return cached;
}

export function getBuildStamp(): string {
  const build = getBuildInfo();
  return `${build.version}@${build.build_id}`.slice(0, 80);
}

export function resetBuildInfoForTest(): void {
  cached = null;
}

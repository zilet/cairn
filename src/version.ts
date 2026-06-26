import fs from "node:fs";

// Cairn's own version + a tiny, dependency-free SemVer comparator. This is the
// source of truth for the in-app "is there a newer release?" check (updateCheck.ts).
// The running version is resolved ONCE, in priority order:
//   1. CAIRN_VERSION env — baked from the git tag into the release image, so the
//      value is exact even on the rolling `:latest` tag. Ignored when it isn't a
//      real version (e.g. a branch name like "main" on a dispatch build).
//   2. package.json `version` — bumped on every release; correct for source
//      builds and tagged images alike (package.json ships in the runtime image).
//   3. "0.0.0" — a dev tree with neither; the check just reads "unknown".

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

// Parse "v1.2.3", "1.2.3", "1.2.3-rc.1" → structured, or null when it isn't a
// recognizable version. Returning null (not 0.0.0) lets callers ignore garbage —
// a branch name baked into CAIRN_VERSION, a draft tag — instead of treating it as
// the lowest possible version.
export function parseVersion(raw: string | null | undefined): SemVer | null {
  if (!raw) return null;
  const m = String(raw)
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

// SemVer precedence: -1 (a < b), 0 (equal core + pre-release), 1 (a > b). A
// release outranks a pre-release of the same core (1.0.0 > 1.0.0-rc.1, per
// SemVer §11). Unparseable inputs sort as 0.0.0 so a comparison never throws.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? { major: 0, minor: 0, patch: 0, pre: [] };
  const pb = parseVersion(b) ?? { major: 0, minor: 0, patch: 0, pre: [] };
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  // Equal core. A version WITHOUT a pre-release outranks one WITH it.
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // a shorter pre-release set is lower
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1; // numeric identifiers rank below alphanumeric
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// True when `latest` is a strictly newer release than `current`. Either side
// unparseable → false (never nag on garbage / an unknown running version).
export function isNewer(latest: string, current: string): boolean {
  if (!parseVersion(latest) || !parseVersion(current)) return false;
  return compareVersions(latest, current) > 0;
}

function readPackageVersion(): string | null {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const v = JSON.parse(raw)?.version;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

let cached: string | null = null;

// The running version as a normalized string (no leading "v"), e.g. "0.6.1".
export function getVersion(): string {
  if (cached) return cached;
  const env = process.env.CAIRN_VERSION;
  const fromEnv = env && parseVersion(env) ? env.trim().replace(/^v/i, "") : null;
  cached = fromEnv || readPackageVersion() || "0.0.0";
  return cached;
}

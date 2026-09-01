// agy's headless `-p` mode cannot prompt. Web browsing (`read_url`) and shell
// (`command`) default to Ask, which becomes a soft-deny: the run exits 0 with
// empty stdout. Cairn never passes `--dangerously-skip-permissions` (that would
// auto-approve writes and arbitrary commands, including against a pasted URL's
// prompt injection). Instead we merge the one scoped grant Google documents for
// fetching pages — `read_url(*)` — into ~/.gemini/antigravity-cli/settings.json.
// File reads/writes inside the workspace stay on agy's own defaults.

import fs from "node:fs";
import path from "node:path";

export const ANTIGRAVITY_READ_URL_ALLOW = "read_url(*)";

export function antigravitySettingsPath(home = process.env.HOME || process.env.USERPROFILE || ""): string {
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * Idempotent merge: add `read_url(*)` to permissions.allow, creating the file
 * when missing. Malformed existing JSON is left untouched — never clobber a
 * human-edited settings file. Returns whether the grant is present after the call.
 */
export function ensureAntigravityHeadlessPermissions(home?: string): boolean {
  const root = home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!root) return false;
  const file = antigravitySettingsPath(root);
  let parsed: Record<string, unknown> = {};
  let existed = false;
  try {
    const raw = fs.readFileSync(file, "utf8");
    existed = true;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    parsed = value as Record<string, unknown>;
  } catch (e: any) {
    if (existed) return false;
    if (e && e.code !== "ENOENT") return false;
  }
  const permissions =
    parsed.permissions && typeof parsed.permissions === "object" && !Array.isArray(parsed.permissions)
      ? { ...(parsed.permissions as Record<string, unknown>) }
      : {};
  const allow = asStringArray(permissions.allow);
  if (allow.includes(ANTIGRAVITY_READ_URL_ALLOW)) return true;
  permissions.allow = [...allow, ANTIGRAVITY_READ_URL_ALLOW];
  parsed.permissions = permissions;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(parsed, null, 2)}\n`;
    fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

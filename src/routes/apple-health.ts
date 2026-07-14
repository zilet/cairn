import { Router } from "express";
import type { Request } from "express";
import { authEnabled } from "../auth.js";
import {
  createAppleHealthPairing,
  exchangeAppleHealthPairing,
  listAppleHealthConnections,
  revokeAppleHealthConnection,
} from "../repo/apple-health.js";

export const appleHealthRouter = Router();

const HELP_URL = "https://github.com/zilet/cairn/blob/main/docs/APPLE_HEALTH.md";

function noStore(res: { setHeader(name: string, value: string): unknown }) {
  res.setHeader("Cache-Control", "no-store");
}

export function validatedAppleHealthShortcutUrl(raw: unknown, requestBaseUrl: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (value.startsWith("/") && !value.startsWith("//")) {
    return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\.shortcut(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/.test(value)
      ? value
      : null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "www.icloud.com" && /^\/shortcuts\/[A-Za-z0-9-]+\/?$/.test(url.pathname))
      return url.toString();
    const requestUrl = new URL(requestBaseUrl);
    // Compare authority rather than scheme. A documented reverse proxy can
    // terminate HTTPS while Express correctly sees its upstream hop as HTTP;
    // trusting X-Forwarded-Proto globally would let an untrusted direct client
    // influence this decision. The destination remains operator-controlled by
    // CAIRN_APPLE_HEALTH_SHORTCUT_URL, must be HTTPS, and must match the exact
    // request host + port, so this does not admit arbitrary remote URLs.
    if (url.host === requestUrl.host && url.pathname.endsWith(".shortcut")) return url.toString();
  } catch {}
  return null;
}

function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host") || "localhost"}`;
}

function shortcutConfig(req: Request) {
  const installUrl = validatedAppleHealthShortcutUrl(process.env.CAIRN_APPLE_HEALTH_SHORTCUT_URL, requestOrigin(req));
  const configuredName = (process.env.CAIRN_APPLE_HEALTH_SHORTCUT_NAME || "Cairn Apple Health Sync")
    .trim()
    .slice(0, 80);
  return {
    available: !!installUrl,
    install_url: installUrl,
    shortcut_name: installUrl ? configuredName || "Cairn Apple Health Sync" : null,
    help_url: HELP_URL,
    pairing_available: authEnabled,
  };
}

// Public, non-secret install metadata. An install button is exposed only for a
// validated official iCloud URL or a same-origin signed .shortcut asset.
appleHealthRouter.get("/apple-health/config", (req, res) => res.json(shortcutConfig(req)));

// Owner-only list/status. Stored credential hashes are never selected here.
appleHealthRouter.get("/apple-health/connections", (_req, res) => {
  noStore(res);
  return res.json({ connections: listAppleHealthConnections() });
});

// Owner-only mint of a short-lived, single-use pairing code. Pairing is disabled
// on auth-free instances: otherwise any network client could mint an ingest
// credential. Trusted-network instances retain the documented manual POST path.
appleHealthRouter.post("/apple-health/pairings", (req, res) => {
  noStore(res);
  if (!authEnabled) {
    return res.status(409).json({
      error: "pairing_requires_auth",
      message: "Set CAIRN_AUTH_TOKEN before pairing a Shortcut credential.",
    });
  }
  const pairing = createAppleHealthPairing({
    label: req.body?.label,
    shortcut_version: req.body?.shortcut_version,
  });
  return res.status(201).json(pairing);
});

// Shortcuts-only exchange. The code is high-entropy, expires after ten minutes,
// and is claimed atomically exactly once. The returned ingest token is shown in
// this response only and the Shortcut stores it locally.
appleHealthRouter.post("/apple-health/pairing/exchange", (req, res) => {
  noStore(res);
  if (!authEnabled) return res.status(403).json({ error: "pairing_unavailable" });
  const result = exchangeAppleHealthPairing(req.body?.pairing_code, {
    label: req.body?.label,
    shortcut_version: req.body?.shortcut_version,
  });
  if (!result) return res.status(400).json({ error: "invalid_or_expired_pairing" });
  return res.json(result);
});

// Owner-only revocation of one Shortcut without rotating owner authentication.
appleHealthRouter.delete("/apple-health/connections/:id", (req, res) => {
  noStore(res);
  const id = Number(req.params.id);
  if (!revokeAppleHealthConnection(id)) return res.status(404).json({ error: "connection_not_found" });
  return res.json({ ok: true, id });
});

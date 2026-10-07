// Settings → Devices → "Connected AI apps": the per-app MCP keys and the OAuth grants an
// app signed in for, in one list (src/repo/mcp-clients.ts). REST-only by design — no MCP
// tool manages access, so a connected app can never mint, list or revoke connections.
//
// Reached through the ordinary /api guard: the master token or a device session (an AI
// app's own key opens /mcp alone, never these). A key is returned ONCE, by the POST that
// made it; nothing here ever reads a secret back.
import { Router } from "express";
import type { Request } from "express";
import { authEnabled, authPrincipal } from "../auth.js";
import { canonicalOrigin, mcpResourceUrl, oauthOriginAllowed } from "../mcpAccess.js";
import { getDevice } from "../repo/auth-devices.js";
import { createMcpTokenClient, listMcpClients, revokeMcpClient } from "../repo/mcp-clients.js";

export const mcpClientsRouter = Router();

function clientDto(client: ReturnType<typeof listMcpClients>[number]) {
  return {
    id: client.id,
    name: client.name,
    kind: client.kind,
    created_at: client.created_at,
    last_used_at: client.last_used_at,
    // Where an OAuth app returns the browser to — the redirect URI the owner APPROVED —
    // shown so a stranger's app is recognisable.
    redirect_host: client.redirect_host,
    // Which device made the key or approved the app (null under the master token).
    device_name: client.device_name,
  };
}

/** What the Settings card needs to write a setup snippet: the /mcp URL and whether OAuth can run here. */
function endpointInfo(req: Request) {
  const origin = canonicalOrigin(req);
  return {
    mcp_url: origin ? mcpResourceUrl(origin) : null,
    oauth_available: authEnabled && oauthOriginAllowed(origin),
  };
}

// Every live connection, most recently used first. Never a key.
mcpClientsRouter.get("/auth/mcp-clients", (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    auth_required: authEnabled,
    ...endpointInfo(req),
    clients: authEnabled ? listMcpClients().map(clientDto) : [],
  });
});

// {name} → a new per-app key, shown this once. A key made from a signed-in device
// remembers it: revoking that device from another one disconnects the key too.
mcpClientsRouter.post("/auth/mcp-clients", (req, res) => {
  if (!authEnabled) return res.status(409).json({ ok: false, error: "auth_disabled" });
  const principal = authPrincipal(req);
  const deviceId = principal.kind === "session" ? principal.device_id : null;
  const { client, token } = createMcpTokenClient({ name: req.body?.name, deviceId });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({
    ok: true,
    client: clientDto({
      ...client,
      redirect_host: null,
      device_name: deviceId == null ? null : (getDevice(deviceId)?.name ?? null),
    }),
    token,
    ...endpointInfo(req),
  });
});

// Revoke one connection: a key stops working at once; an OAuth app loses its tokens.
mcpClientsRouter.delete("/auth/mcp-clients/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || !revokeMcpClient(id)) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  res.json({ ok: true });
});

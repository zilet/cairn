// Access endpoints for a hosted Cairn: device sessions, one-time pairing codes and
// passkeys. The guard is src/auth.ts; storage is src/repo/auth-devices.ts; cookie,
// origin and challenge mechanics are src/authHttp.ts.
//
// Deliberately REST-only — no MCP mirror. An MCP client authenticates with the
// master token and has no cookie jar to put a device session in.
//
// Responses never echo a secret except the ones a signed-in caller asked for by design:
// the pairing code from POST /auth/pairing-codes (shown on the device that minted it),
// a two-minute resource link's ?sig= and the calendar link's ?feed= — and the session
// secret, which travels only inside an HttpOnly Set-Cookie.
import { Router } from "express";
import type { Request, Response } from "express";
import {
  CALENDAR_FEED_PATH,
  authEnabled,
  authPrincipal,
  presentsMasterToken,
  queryTokenAllowedPath,
  resourceLinks,
  trustProxyHops,
} from "../auth.js";
import {
  ChallengeStore,
  FailureLimiter,
  MAX_LOGIN_CHALLENGES_PER_IP,
  PAIRING_LIMITS,
  RESOURCE_LINK_TTL_MS,
  challengeFromClientData,
  clearedSessionCookie,
  isSameOriginRequest,
  readSessionCookie,
  relyingPartyFor,
  sessionCookie,
} from "../authHttp.js";
import {
  addPasskey,
  calendarFeedToken,
  consumePairingCode,
  createDeviceSession,
  createPairingCode,
  deletePasskey,
  deviceForSessionSecret,
  getDevice,
  getPasskeyByCredentialId,
  listDevices,
  listPasskeys,
  passkeysRemovedByRevoking,
  passkeysRemovedByRevokingOthers,
  recordPasskeyUse,
  renameDevice,
  resetCalendarFeedToken,
  revokeDevice,
  liveDeviceIdsExcept,
  revokeOtherDevices,
  webauthnUserId,
} from "../repo/auth-devices.js";
import { mcpClientsCreatedByDevices } from "../repo/mcp-clients.js";

export const authRouter = Router();

// Both doors count misses per address only — no global lock, which would hand anyone a
// way to keep the owner's pairing (or passkey) sign-in shut (src/authHttp.ts).
const pairLimiter = new FailureLimiter(PAIRING_LIMITS);
const passkeyLimiter = new FailureLimiter(PAIRING_LIMITS);
// Two stores: sign-in traffic (unauthenticated, capped per address) can never evict a
// registration a signed-in device is halfway through.
const loginChallenges = new ChallengeStore({ perIpMax: MAX_LOGIN_CHALLENGES_PER_IP });
const registerChallenges = new ChallengeStore();

function secure(req: Request): boolean {
  return req.secure === true;
}

function setSession(req: Request, res: Response, secret: string): void {
  res.append("Set-Cookie", sessionCookie(secret, { secure: secure(req) }));
}

function currentDeviceId(req: Request): number | null {
  const principal = authPrincipal(req);
  return principal.kind === "session" ? principal.device_id : null;
}

function authDisabled(res: Response): Response {
  return res.status(409).json({ ok: false, error: "auth_disabled" });
}

function limited(res: Response, retryAfterMs: number): Response {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return res.status(429).json({ ok: false, error: "rate_limited" });
}

function deviceDto(
  device: {
    id: number;
    name: string;
    kind: string;
    created_at: string;
    last_seen_at: string;
    user_agent_summary: string | null;
  },
  current: number | null,
  passkeys = 0
) {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    created_at: device.created_at,
    last_seen_at: device.last_seen_at,
    user_agent_summary: device.user_agent_summary,
    current: device.id === current,
    has_passkey: passkeys > 0,
  };
}

/**
 * The live device this request's own session cookie opens, or null. The sign-in doors
 * skip the guard, so they read the cookie here; a stamp that moved slides the cookie.
 */
function liveSession(req: Request, res: Response) {
  const secret = readSessionCookie(req.headers.cookie);
  const hit = secret ? deviceForSessionSecret(secret) : null;
  if (!hit) return null;
  if (hit.touched && secret) setSession(req, res, secret);
  return hit.device;
}

/** What every sign-in passes to createDeviceSession: a label, the UA, the device hint. */
function signInInput(req: Request) {
  return { name: req.body?.device_name, userAgent: req.get("user-agent"), hint: req.body?.device_hint };
}

function idParam(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---- who am I ----

// How this request was let in (master / session / open) and, for a session, its device.
authRouter.get("/auth/status", (req, res) => {
  const principal = authPrincipal(req);
  const device = principal.kind === "session" ? getDevice(principal.device_id) : null;
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    auth_required: authEnabled,
    method: principal.kind,
    device: device
      ? deviceDto(device, device.id, listPasskeys().filter((p) => p.device_id === device.id).length)
      : null,
  });
});

// ---- the master token → a device session (first sign-in, recovery, legacy migration) ----

// Bearer master token → this browser's device session cookie. A browser that already
// carries a live session gets THAT session back (no new row): a page load that raced
// two exchanges, or a sign-in screen opened over a session that was fine, never piles
// up a second "Chrome on Mac". A session alone never mints a new one.
authRouter.post("/auth/session", (req, res) => {
  if (!authEnabled) return authDisabled(res);
  const live = liveSession(req, res);
  if (live) return res.json({ ok: true, reused: true, device: deviceDto(live, live.id) });
  if (!presentsMasterToken(req)) return res.status(403).json({ ok: false, error: "master_token_required" });
  const { device, secret } = createDeviceSession(signInInput(req));
  setSession(req, res, secret);
  res.json({ ok: true, device: deviceDto(device, device.id) });
});

// ---- one-time pairing codes ----

// Signed in (master or session) → {code:"XXXX-XXXX", expires_at}: single use, ten minutes.
authRouter.post("/auth/pairing-codes", (req, res) => {
  if (!authEnabled) return authDisabled(res);
  const minted = createPairingCode({ createdByDeviceId: currentDeviceId(req) });
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ code: minted.code, expires_at: minted.expires_at });
});

// Unauthenticated door, failure-limited: a live pairing code → a new device session cookie.
// A browser that is already signed in keeps its session and leaves the code unspent.
authRouter.post("/auth/pair", (req, res) => {
  if (!authEnabled) return authDisabled(res);
  const live = liveSession(req, res);
  if (live) return res.json({ ok: true, already_signed_in: true, device: deviceDto(live, live.id) });
  const ip = req.ip || "unknown";
  const gate = pairLimiter.check(ip);
  if (!gate.allowed) return limited(res, gate.retryAfterMs);
  if (!consumePairingCode(req.body?.code)) {
    pairLimiter.fail(ip);
    return res.status(400).json({ ok: false, error: "invalid_or_expired_code" });
  }
  const { device, secret } = createDeviceSession(signInInput(req));
  setSession(req, res, secret);
  res.json({ ok: true, device: deviceDto(device, device.id) });
});

// ---- links a browser opens on its own ----

/**
 * A same-origin API path the query-credential allowlist covers, normalized
 * ("/api/health-report?name=X"), or null. The query string rides along untouched
 * except for any credential already on it.
 */
function linkablePath(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/api/") || value.startsWith("//")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value, "http://cairn.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://cairn.invalid" || url.hash) return null;
  // The parsed path must be the one written (no dot segments, no encoded detours).
  if (!value.startsWith(url.pathname) || !queryTokenAllowedPath(url.pathname, "GET")) return null;
  for (const key of ["sig", "token", "feed"]) url.searchParams.delete(key);
  return url;
}

// Signed in → `{url}`: the same path with a `?sig=` that opens it for two minutes (thirty
// seconds after first use), and only it. For a report in a new tab, a file, a download —
// an installed iOS app opens those in Safari, which never carries this app's cookie.
authRouter.post("/auth/resource-link", (req, res) => {
  const url = linkablePath(req.body?.path);
  if (!url) return res.status(400).json({ ok: false, error: "not_linkable" });
  res.setHeader("Cache-Control", "no-store");
  if (!authEnabled) return res.json({ ok: true, url: url.pathname + url.search });
  url.searchParams.set("sig", resourceLinks.mint(url.pathname, url.searchParams));
  res.json({ ok: true, url: url.pathname + url.search, expires_in_sec: RESOURCE_LINK_TTL_MS / 1000 });
});

// Signed in → `{url}`: the calendar subscription link (`/api/plan.ics?feed=…`). The same
// link every time until it is reset, so subscribing on a second device never cuts off
// the first calendar.
authRouter.post("/auth/calendar-link", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!authEnabled) return res.json({ ok: true, url: CALENDAR_FEED_PATH });
  res.json({ ok: true, url: `${CALENDAR_FEED_PATH}?feed=${calendarFeedToken()}` });
});

// Retire the calendar link: every subscribed calendar stops updating.
authRouter.delete("/auth/calendar-link", (_req, res) => {
  if (!authEnabled) return authDisabled(res);
  resetCalendarFeedToken();
  res.json({ ok: true });
});

// ---- devices ----

/** A passkey as a confirm sheet names it: id and label only. */
function passkeyLabel(p: { id: number; name: string }) {
  return { id: p.id, name: p.name };
}

/** A connected AI app as a confirm sheet names it: id and name only. */
function appLabel(c: { id: number; name: string }) {
  return { id: c.id, name: c.name };
}

// Every signed-in browser (this one marked `current`), newest activity first. Each other
// device carries `revoke_removes_passkeys` — the passkeys signing it out also removes —
// and `revoke_disconnects_apps` — the AI apps it connected, which signing it out from
// here disconnects; the list carries `revoke_others_removes_passkeys` and
// `revoke_others_disconnects_apps` for "Sign out other devices", so both confirm sheets
// name them before anything is removed. Signing THIS device out removes neither ([]).
authRouter.get("/auth/devices", (req, res) => {
  const current = currentDeviceId(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    devices: listDevices().map((d) => ({
      ...deviceDto(d, current, d.passkeys),
      revoke_removes_passkeys: d.id === current ? [] : passkeysRemovedByRevoking(d.id).map(passkeyLabel),
      revoke_disconnects_apps: d.id === current ? [] : mcpClientsCreatedByDevices([d.id]).map(appLabel),
    })),
    current_device_id: current,
    revoke_others_removes_passkeys: passkeysRemovedByRevokingOthers(current).map(passkeyLabel),
    revoke_others_disconnects_apps: mcpClientsCreatedByDevices(liveDeviceIdsExcept(current)).map(appLabel),
  });
});

// Rename a device ({name}, at most 60 characters).
authRouter.patch("/auth/devices/:id", (req, res) => {
  const id = idParam(req);
  const device = id ? renameDevice(id, req.body?.name) : null;
  if (!device) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, device: deviceDto(device, currentDeviceId(req)) });
});

// Sign a device out. Another device loses every passkey it could still hold (bound to it,
// added by it, or last used by it) and every AI app it connected; this one keeps both and
// is signed out.
authRouter.delete("/auth/devices/:id", (req, res) => {
  const id = idParam(req);
  const current = currentDeviceId(req);
  const isCurrent = id != null && id === current;
  if (!id || !revokeDevice(id, { keepPasskeys: isCurrent, keepApps: isCurrent }))
    return res.status(404).json({ ok: false, error: "not_found" });
  if (isCurrent) res.append("Set-Cookie", clearedSessionCookie({ secure: secure(req) }));
  res.json({ ok: true, signed_out: isCurrent });
});

// Sign out every device but the one asking, remove every passkey not bound to it
// (unbound ones too) or that another device added or last used, and disconnect every AI
// app one of those devices connected.
authRouter.post("/auth/devices/revoke-others", (req, res) => {
  const revoked = revokeOtherDevices(currentDeviceId(req));
  res.json({ ok: true, revoked });
});

// Unauthenticated door (src/auth.ts SIGN_IN_DOORS): ends only the session this request
// carries. A cookie-carrying logout must come from this origin, like any cookie write.
authRouter.post("/auth/logout", (req, res) => {
  const secret = readSessionCookie(req.headers.cookie);
  if (secret && authEnabled) {
    if (!isSameOriginRequest(req.headers, trustProxyHops())) {
      return res.status(403).json({ ok: false, error: "origin_mismatch" });
    }
    const hit = deviceForSessionSecret(secret);
    if (hit) revokeDevice(hit.device.id, { keepPasskeys: true, keepApps: true });
  }
  res.append("Set-Cookie", clearedSessionCookie({ secure: secure(req) }));
  res.json({ ok: true });
});

// ---- passkeys (WebAuthn) ----
// @simplewebauthn/server is imported on first use, never at boot: it carries an ASN.1
// stack a Raspberry Pi should not hold in memory for an instance that never uses it.

function relyingParty(req: Request) {
  return relyingPartyFor({
    hostname: req.hostname,
    protocol: req.protocol,
    host: req.host,
    headers: req.headers,
    trustedProxyHops: trustProxyHops(),
  });
}

function bytesFromB64url(value: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(value, "base64url");
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

// Registered passkeys: names and dates only, never key material.
authRouter.get("/auth/passkeys", (req, res) => {
  const current = currentDeviceId(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    passkeys: listPasskeys().map((p) => ({
      id: p.id,
      name: p.name,
      device_id: p.device_id,
      this_device: p.device_id != null && p.device_id === current,
      created_at: p.created_at,
      last_used_at: p.last_used_at,
    })),
  });
});

// Remove a passkey; it can no longer sign anything in.
authRouter.delete("/auth/passkeys/:id", (req, res) => {
  const id = idParam(req);
  if (!id || !deletePasskey(id)) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true });
});

// Signed in → WebAuthn creation options (discoverable credential, 5-minute single-use challenge).
authRouter.post("/auth/passkeys/register/options", async (req, res, next) => {
  try {
    if (!authEnabled) return authDisabled(res);
    const rp = relyingParty(req);
    if (!rp) return res.status(400).json({ ok: false, error: "unsupported_host" });
    const { generateRegistrationOptions } = await import("@simplewebauthn/server");
    const options = await generateRegistrationOptions({
      rpName: "Cairn",
      rpID: rp.rpID,
      userID: bytesFromB64url(webauthnUserId()),
      userName: "cairn",
      userDisplayName: "Cairn",
      attestationType: "none",
      excludeCredentials: listPasskeys().map((p) => ({ id: p.credential_id, transports: p.transports })),
      // Discoverable, so the sign-in screen never asks for a username.
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    registerChallenges.put(options.challenge, { kind: "register", deviceId: currentDeviceId(req), rpID: rp.rpID });
    res.setHeader("Cache-Control", "no-store");
    res.json(options);
  } catch (error) {
    next(error);
  }
});

// Verify the attestation and store the passkey, bound to the device that asked.
authRouter.post("/auth/passkeys/register/verify", async (req, res, next) => {
  try {
    if (!authEnabled) return authDisabled(res);
    const response = req.body?.response;
    const rp = relyingParty(req);
    const challenge = challengeFromClientData(response?.response?.clientDataJSON);
    const pending = registerChallenges.take(challenge, "register");
    if (!rp || !pending || !challenge || pending.rpID !== rp.rpID) {
      return res.status(400).json({ ok: false, error: "challenge_expired" });
    }
    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch {
      return res.status(400).json({ ok: false, error: "passkey_not_verified" });
    }
    if (!verification.verified) return res.status(400).json({ ok: false, error: "passkey_not_verified" });
    const { credential } = verification.registrationInfo;
    if (getPasskeyByCredentialId(credential.id))
      return res.status(409).json({ ok: false, error: "already_registered" });
    const deviceId = pending.deviceId ?? currentDeviceId(req);
    const device = deviceId ? getDevice(deviceId) : null;
    const passkey = addPasskey({
      deviceId: device && !device.revoked_at ? device.id : null,
      registeredDeviceId: device ? device.id : null,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      signCount: credential.counter,
      transports: credential.transports as string[] | undefined,
      name: req.body?.name || (device ? `${device.name}` : "Passkey"),
    });
    res.json({ ok: true, passkey: { id: passkey.id, name: passkey.name, device_id: passkey.device_id } });
  } catch (error) {
    next(error);
  }
});

// Unauthenticated door. Discoverable credentials: no allow-list, so this reveals
// nothing about which passkeys exist.
authRouter.post("/auth/passkeys/login/options", async (req, res, next) => {
  try {
    if (!authEnabled) return authDisabled(res);
    const gate = passkeyLimiter.check(req.ip || "unknown");
    if (!gate.allowed) return limited(res, gate.retryAfterMs);
    const rp = relyingParty(req);
    if (!rp) return res.status(400).json({ ok: false, error: "unsupported_host" });
    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred" });
    loginChallenges.put(options.challenge, { kind: "login", rpID: rp.rpID, ip: req.ip || "unknown" });
    res.setHeader("Cache-Control", "no-store");
    res.json(options);
  } catch (error) {
    next(error);
  }
});

// Unauthenticated door: a verified assertion signs this browser in as a new device.
authRouter.post("/auth/passkeys/login/verify", async (req, res, next) => {
  try {
    if (!authEnabled) return authDisabled(res);
    // Already signed in: keep that session; the assertion is not needed and not spent.
    const live = liveSession(req, res);
    if (live) {
      const passkeys = listPasskeys().filter((p) => p.device_id === live.id).length;
      return res.json({ ok: true, already_signed_in: true, device: deviceDto(live, live.id, passkeys) });
    }
    const ip = req.ip || "unknown";
    const gate = passkeyLimiter.check(ip);
    if (!gate.allowed) return limited(res, gate.retryAfterMs);
    const response = req.body?.response;
    const rp = relyingParty(req);
    const challenge = challengeFromClientData(response?.response?.clientDataJSON);
    const pending = loginChallenges.take(challenge, "login");
    const passkey = getPasskeyByCredentialId(response?.id);
    if (!rp || !pending || !challenge || pending.rpID !== rp.rpID || !passkey) {
      passkeyLimiter.fail(ip);
      return res.status(400).json({ ok: false, error: "passkey_not_verified" });
    }
    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    let verified = false;
    let newCounter = passkey.sign_count;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origins,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
        credential: {
          id: passkey.credential_id,
          publicKey: bytesFromB64url(passkey.public_key),
          counter: passkey.sign_count,
          transports: passkey.transports as any,
        },
      });
      verified = result.verified;
      newCounter = result.authenticationInfo.newCounter;
    } catch {
      verified = false;
    }
    if (!verified) {
      passkeyLimiter.fail(ip);
      return res.status(400).json({ ok: false, error: "passkey_not_verified" });
    }
    // A session for THIS browser — its own earlier row when its device hint matches,
    // else a new one: a synced passkey used on a laptop must never end the phone's
    // session it was first added on. The passkey stays bound to its device while that
    // device is signed in, and moves to this one otherwise.
    const { device, secret } = createDeviceSession(signInInput(req));
    const bound = passkey.device_id ? getDevice(passkey.device_id) : null;
    const bindTo = bound && !bound.revoked_at ? bound.id : device.id;
    recordPasskeyUse(passkey.id, { signCount: newCounter, deviceId: bindTo, usedByDeviceId: device.id });
    setSession(req, res, secret);
    res.json({ ok: true, device: deviceDto(device, device.id, bindTo === device.id ? 1 : 0) });
  } catch (error) {
    next(error);
  }
});

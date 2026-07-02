import { getAppState, setAppState } from "./app-state.js";
import { isValidTimeZone } from "../tz.js";

// ---------- last-seen client timezone (device-following warm) ----------
// The PWA sends its live IANA zone as X-Cairn-TZ. A request stores the whole
// request inside that zone (see src/tz.ts), but the SCHEDULER runs outside any
// request, so its boot-warm + nightly precompute have no device zone in scope and
// would otherwise warm the SERVER's calendar date. When the traveling owner's
// device date differs, that warm misses and the morning open pays a synchronous
// agent call. We record the most recent VALID client zone here so the warm can
// compute "today" in the device's zone. Single-user, last-writer-wins.
const CLIENT_TZ_KEY = "client_tz";

// Record the client's zone. Cheap: one indexed SELECT per call and a WRITE only
// when the zone actually changed, so the per-request middleware never writes on
// the steady state. An invalid/absent zone is ignored (keeps the last good one).
export function recordClientTimeZone(tz: unknown): void {
  if (!isValidTimeZone(tz)) return;
  if (getAppState(CLIENT_TZ_KEY) === tz) return; // unchanged → no write
  setAppState(CLIENT_TZ_KEY, tz);
}

// The last recorded client zone, or undefined when none/invalid — callers fall
// back to server-local. Used by the Brief warm so it lines up with the date the
// device's request keys the read to.
export function recordedClientTimeZone(): string | undefined {
  const tz = getAppState(CLIENT_TZ_KEY);
  return isValidTimeZone(tz) ? tz : undefined;
}

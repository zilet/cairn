// Calendar-day arithmetic over plain `YYYY-MM-DD` keys.
//
// DELIBERATELY DEPENDENCY-FREE: this module imports nothing from the rest of
// `src/` (no db, no tz, no repo), so a migration or a leaf module can use it
// without dragging the world in. Anything that needs the ACTIVE DEVICE ZONE —
// `localDateISO`, `localDayOfStamp`, `nowContext` — lives in `src/repo/shared.ts`
// instead and stays there; a local day key can only be *derived* with a zone in
// scope, and this file has none.
//
// Every helper here treats a day key as UTC midnight. That is not a timezone
// claim: once a date has already been reduced to Y/M/D, UTC midnight is simply
// the DST-free arithmetic frame in which "+1 day" is exactly 864e5 ms. Framing
// the day in the first place is `localDateISO`'s job.
//
// These are the canonical definitions. Before adding a private `isoDay` /
// `addDaysISO` / `daysBetween` to a module, import it from here — a contract test
// in `test/engineeringContracts.test.js` enforces that, with a small allowlist for
// the handful of copies whose divergent semantics their callers genuinely depend
// on.

const DAY_MS = 864e5;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The leading day key of anything date-shaped — `String(value ?? "").slice(0, 10)`.
 *
 * Lossy and unvalidating ON PURPOSE: it trims a stored timestamp down to its date
 * part for a same-string comparison against another day key. It does NOT re-key a
 * UTC instant to a local day (that is `localDayOfStamp`), and it does not promise
 * the result is a real date (that is `isoDate`).
 */
export function isoDay(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

/**
 * A REAL `YYYY-MM-DD` day key, or null. Rejects a well-shaped impossible date
 * ("2026-02-30") by round-tripping it, so a validated key can be trusted by every
 * helper below. Trims and stringifies first — callers hand this raw agent output
 * and raw DB columns alike.
 */
export function isoDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!ISO_DATE_RE.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

/**
 * The same validation, but THROWING — for a write path where an unusable date must
 * never be silently coerced into today. `fallback` covers the "the caller may omit
 * the date" shape; pass none and an absent value fails like a malformed one.
 */
export function requireIsoDate(value: unknown, fallback?: string): string {
  const date = String(value ?? fallback ?? "");
  if (isoDate(date) !== date) throw new Error("date must be a real YYYY-MM-DD");
  return date;
}

/** Milliseconds at UTC midnight of a valid day key, or null. The sortable/diffable form. */
export function dayEpoch(iso: unknown): number | null {
  const day = isoDay(iso);
  if (!ISO_DATE_RE.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/** `iso` shifted by `days` (negative shifts back), or null when `iso` is unparseable. */
export function addDaysISO(iso: string, days: number): string | null {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * `iso` shifted BACK by `days` — the reading-window form (`isoDaysAgo(today, 30)`).
 *
 * Unlike `addDaysISO` this THROWS on an unparseable date rather than returning
 * null, exactly as the five private copies it replaces did: every caller uses it to
 * build a window bound it then interpolates into SQL, where a silent null would
 * widen the window instead of failing.
 */
export function isoDaysAgo(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * SIGNED whole days from `earlierISO` to `laterISO`, or null when either side is
 * unparseable. Note the argument order: LATER FIRST, so the sign reads the way the
 * name does (`daysBetweenISO(today, then)` is "how long ago").
 *
 * Null is the answer for "no date", never 0 — a missing anchor is not "today".
 * A caller that wants an absolute distance writes `Math.abs(… ?? 0)` at its own
 * call site, so the choice to erase the sign is visible where it is made.
 */
export function daysBetweenISO(laterISO: string, earlierISO: string): number | null {
  const later = Date.parse(`${String(laterISO).slice(0, 10)}T00:00:00Z`);
  const earlier = Date.parse(`${String(earlierISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return Math.round((later - earlier) / DAY_MS);
}

/**
 * The MONDAY of the ISO week containing `dateISO`. Throws on an unparseable date,
 * like the private copies it replaces — a week start is a map key here, and a null
 * one would silently merge two weeks into an "unknown" bucket.
 */
export function mondayOf(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// The athlete's unit SYSTEM — one coarse read over the per-kind units in Settings, and the
// first-run guess at those units from the device's locale and time zone.
//
// Settings stays the only owner of the per-kind choices (`run_units`, `weight_units`,
// display-words.ts's UNIT_REGISTRY). This module derives from them and never stores:
//   - `unitSystemOf(units)` — "us" | "metric", weight-led (bodyweight is the body-side
//     unit, and pounds is the one choice no metric country makes).
//   - `lengthUnitOf(units)` — the tape measure's unit (body circumferences, height):
//     follows the same weight-led system, so kg ⇒ cm and lb ⇒ in. There is no separate
//     length setting on purpose; a body-measurement screen may offer a quick in-place
//     toggle, but its default is always this.
//   - `detectUnits({ locale, timeZone })` — the DEFAULT a fresh install starts in, or null
//     when the device gave no usable signal. A guess only: settings.ts applies it once,
//     and never over a choice the person made.
//
// Pure: no DB, no clock.

import type { AthleteUnits } from "./display-words.js";

export type UnitSystem = "us" | "metric";
export type LengthUnit = "in" | "cm";

/** "us" when the athlete weighs in pounds, else "metric" — the one coarse unit-system read. */
export function unitSystemOf(units: Pick<AthleteUnits, "weight">): UnitSystem {
  return units.weight === "lb" ? "us" : "metric";
}

/** The tape-measure unit (circumferences, height) that goes with the athlete's units. */
export function lengthUnitOf(units: Pick<AthleteUnits, "weight">): LengthUnit {
  return unitSystemOf(units) === "us" ? "in" : "cm";
}

// ---------------------------------------------------------------------------
// First-run detection
// ---------------------------------------------------------------------------

/**
 * Where a device's signals place it, unit-wise:
 *   - "us": the United States and its territories, Liberia, Myanmar — miles and pounds;
 *   - "gb": the United Kingdom — miles on the road and in races, kilograms for bodyweight
 *     (Cairn has no stone; kg is what UK scales, gyms and the NHS read in);
 *   - "metric": everywhere else — kilometres and kilograms.
 */
type UnitRegion = "us" | "gb" | "metric";

const US_REGIONS = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM", "LR", "MM"]);
const GB_REGIONS = new Set(["GB", "UK", "IM", "JE", "GG"]);

// Zones that sit in the US-unit countries. A time zone is a strong signal for WHERE a
// person is (which a borrowed en-US browser is not), so it leads when it is specific.
const US_ZONE_PREFIXES = ["America/Indiana/", "America/Kentucky/", "America/North_Dakota/", "US/"];
const US_ZONES = new Set([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "America/Boise",
  "America/Detroit",
  "America/Menominee",
  "America/Indianapolis",
  "America/Louisville",
  "America/Puerto_Rico",
  "America/St_Thomas",
  "America/Virgin",
  "Pacific/Honolulu",
  "Pacific/Johnston",
  "Pacific/Guam",
  "Pacific/Saipan",
  "Pacific/Pago_Pago",
  "Pacific/Samoa",
  "Pacific/Midway",
  "Pacific/Wake",
  "Navajo",
  "EST5EDT",
  "CST6CDT",
  "MST7MDT",
  "PST8PDT",
  "Africa/Monrovia",
  "Asia/Yangon",
  "Asia/Rangoon",
]);
const GB_ZONES = new Set([
  "Europe/London",
  "Europe/Belfast",
  "Europe/Isle_of_Man",
  "Europe/Jersey",
  "Europe/Guernsey",
  "GB",
  "GB-Eire",
]);

/** The region subtag of a BCP 47 locale ("en-GB" → "GB", "es-419" → "419", "my" → "MM"), else null. */
export function localeRegion(locale: unknown): string | null {
  const raw = String(locale ?? "")
    .trim()
    .replace(/_/g, "-");
  if (!raw) return null;
  const parts = raw.split("-").filter(Boolean);
  // Language, optional script (4 letters), then the region (2 letters or 3 digits).
  for (const part of parts.slice(1)) {
    if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) return part.toUpperCase();
    if (/^[A-Za-z]{4}$/.test(part)) continue; // script subtag
    break; // a variant / extension — no region before it
  }
  // Burmese without a region is still Myanmar.
  if (parts[0]?.toLowerCase() === "my") return "MM";
  return null;
}

function regionOfLocale(locale: unknown): UnitRegion | null {
  const region = localeRegion(locale);
  if (!region) return null;
  if (US_REGIONS.has(region)) return "us";
  if (GB_REGIONS.has(region)) return "gb";
  return "metric";
}

/**
 * The unit region a time zone places the device in, or null when the zone says nothing
 * about a country (absent, UTC / Etc/*, unparseable).
 */
function regionOfTimeZone(timeZone: unknown): UnitRegion | null {
  const tz = String(timeZone ?? "").trim();
  if (!tz || /^(Etc\/|UTC$|UCT$|GMT|Greenwich$|Universal$|Zulu$)/i.test(tz)) return null;
  if (US_ZONES.has(tz) || US_ZONE_PREFIXES.some((p) => tz.startsWith(p))) return "us";
  if (GB_ZONES.has(tz)) return "gb";
  // A legacy alias with no area ("CET", "EST") names no country.
  if (!tz.includes("/")) return null;
  return "metric";
}

const REGION_UNITS: Record<UnitRegion, AthleteUnits> = {
  us: { distance: "mi", weight: "lb" },
  gb: { distance: "mi", weight: "kg" },
  metric: { distance: "km", weight: "kg" },
};

export interface UnitHint {
  /** The browser's language tag (`navigator.language`), e.g. "en-GB". */
  locale?: unknown;
  /** The device's IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
  timeZone?: unknown;
}

/**
 * The units a fresh install should start in, from the device's locale and zone, or null
 * when neither gives a signal (keep the registry defaults).
 *
 * The zone leads when it names a country: plenty of Europeans run an en-US browser, but
 * their clock still says Europe/Berlin. The one exception is a US zone beside a locale
 * that positively names another country (an expat who set their browser to de-DE) — the
 * person's own regional choice wins there, so US units need BOTH signals to agree or the
 * locale to be absent. With no usable zone, the locale's region decides.
 */
export function detectUnits(hint: UnitHint): AthleteUnits | null {
  const fromZone = regionOfTimeZone(hint.timeZone);
  const fromLocale = regionOfLocale(hint.locale);
  let region: UnitRegion | null;
  if (fromZone === "us") region = fromLocale && fromLocale !== "us" ? fromLocale : "us";
  else region = fromZone ?? fromLocale;
  return region ? { ...REGION_UNITS[region] } : null;
}

// THE ONE SERVER FORMATTER — every number and date a person reads, in the athlete's units.
//
// Canonical stored data never changes: distances are kilometres, bodyweight and loads
// are pounds, dates are YYYY-MM-DD. Conversion happens HERE, at the edge where a number
// becomes words, and nowhere else on the server (a static test asserts the conversion
// constants are defined once). A prose builder takes the athlete's units
// (`athleteUnits()`, settings.ts) and hands them to these functions; it never multiplies
// by a constant of its own and never writes a literal " km" or " lb".
//
// The UNIT REGISTRY is the one place a unit kind is declared: which setting stores it,
// the options, the default, and the formatter that says a canonical value in it. A new
// kind (height, temperature, energy) is one entry here plus its settings column (the
// schema two-step). The client's twin (ui-format.ts) mirrors this table.
//
// Pure: no DB, no settings read, no clock (lib/numbers only). Dates are compared against a `today` the
// caller passes, so a past-date read speaks about its own day.

import { round1 } from "../lib/numbers.js";

/** Kilometres in one statute mile. The ONLY definition on the server. */
export const KM_PER_MI = 1.609344;
/** Pounds in one kilogram. The ONLY definition on the server. */
export const LB_PER_KG = 2.2046226218;

export type DistanceUnit = "km" | "mi";
export type WeightUnit = "lb" | "kg";

/** The athlete's display units, one field per registered kind. */
export interface AthleteUnits {
  distance: DistanceUnit;
  weight: WeightUnit;
}

/** One registered unit kind: where it is stored, what it may be, how it is said. */
export interface UnitKind<U extends string> {
  /** The settings column that stores the athlete's choice. */
  setting: string;
  /** The Settings group's label for the kind. */
  label: string;
  options: readonly U[];
  /** Plain words per option, for the Settings control. */
  option_words: Readonly<Record<U, string>>;
  default: U;
}

/**
 * THE UNIT REGISTRY: unit kind → setting → options → default. The formatters below are
 * the kind's server formatter (`distanceWords` / `weightWords`). Settings normalizes
 * every stored value through `normalizeUnit`, so an unknown value reads as the default.
 */
export const UNIT_REGISTRY = {
  distance: {
    setting: "run_units",
    label: "Distance",
    options: ["km", "mi"],
    option_words: { km: "Kilometres", mi: "Miles" },
    default: "km",
  } satisfies UnitKind<DistanceUnit>,
  weight: {
    setting: "weight_units",
    label: "Weight",
    options: ["lb", "kg"],
    option_words: { lb: "Pounds", kg: "Kilograms" },
    default: "lb",
  } satisfies UnitKind<WeightUnit>,
} as const;

export type UnitKindKey = keyof typeof UNIT_REGISTRY;

/** The default units: what a fresh install (or an unreadable setting) speaks in. */
export const DEFAULT_UNITS: AthleteUnits = {
  distance: UNIT_REGISTRY.distance.default,
  weight: UNIT_REGISTRY.weight.default,
};

/** A stored value for `kind`, or the kind's default when it is not one of its options. */
export function normalizeUnit<K extends UnitKindKey>(kind: K, value: unknown): AthleteUnits[K] {
  const entry = UNIT_REGISTRY[kind];
  const v = String(value ?? "").trim();
  return ((entry.options as readonly string[]).includes(v) ? v : entry.default) as AthleteUnits[K];
}

/** A value for `kind` when it is valid, else null (a PUT that sends junk keeps what is stored). */
export function validUnit<K extends UnitKindKey>(kind: K, value: unknown): AthleteUnits[K] | null {
  const v = String(value ?? "").trim();
  return (UNIT_REGISTRY[kind].options as readonly string[]).includes(v) ? (v as AthleteUnits[K]) : null;
}

/** One registered kind as the Settings Units group reads it: options in words and the current choice. */
export interface UnitKindRead {
  kind: UnitKindKey;
  setting: string;
  label: string;
  options: { value: string; words: string }[];
  default: string;
  value: string;
}

/** The registry with the athlete's current choice, in registry order — the Settings Units group's one source. */
export function unitsRegistryRead(units: AthleteUnits): UnitKindRead[] {
  return (Object.keys(UNIT_REGISTRY) as UnitKindKey[]).map((kind) => {
    const entry = UNIT_REGISTRY[kind] as UnitKind<string>;
    return {
      kind,
      setting: entry.setting,
      label: entry.label,
      options: entry.options.map((value) => ({ value, words: entry.option_words[value] ?? value })),
      default: entry.default,
      value: units[kind],
    };
  });
}

/** Units from any partial record (a settings row, a fixture): each kind normalized. */
export function unitsFrom(raw: Partial<Record<string, unknown>> | null | undefined): AthleteUnits {
  return {
    distance: normalizeUnit("distance", raw?.[UNIT_REGISTRY.distance.setting] ?? raw?.distance),
    weight: normalizeUnit("weight", raw?.[UNIT_REGISTRY.weight.setting] ?? raw?.weight),
  };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** "5", "2.5" — one decimal at most, no trailing ".0". */
function plain(n: number, decimals = 1): string {
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
  return Number.isInteger(r) ? String(r) : r.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

/** A signed number with a true minus: "+0.4", "−0.9", "0". */
export function signedWords(n: number, decimals = 1): string {
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
  const body = plain(Math.abs(r), decimals);
  return r > 0 ? `+${body}` : r < 0 ? `−${body}` : body;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** A canonical km value in the athlete's distance unit (one decimal). */
export function distanceValue(km: number, units: DistanceUnit = "km"): number {
  return round1(units === "mi" ? km / KM_PER_MI : km);
}

/** A miles value back to canonical km (two decimals) — input parsing only. */
export function kmFromMiles(mi: number): number {
  return Math.round(mi * KM_PER_MI * 100) / 100;
}

/**
 * A distance in a sentence: "5 km", "2.5 km", "3.1 mi". `approx` prefixes "~";
 * `whole` rounds to the nearest whole unit ("~31 km this week").
 */
export function distanceWords(
  km: number,
  units: DistanceUnit = "km",
  opts: { approx?: boolean; whole?: boolean } = {}
): string {
  const v = units === "mi" ? km / KM_PER_MI : km;
  const n = opts.whole ? String(Math.round(v)) : plain(v);
  return `${opts.approx ? "~" : ""}${n} ${units}`;
}

/** "3.8 of 19.3 mi" — two distances, one unit said once. */
export function distanceOfWords(doneKm: number, plannedKm: number, units: DistanceUnit = "km"): string {
  const v = (km: number) => plain(units === "mi" ? km / KM_PER_MI : km);
  return `${v(doneKm)} of ${v(plannedKm)} ${units}`;
}

/** A race distance's name: "Half marathon", "10K", "15 km race" / "9.3 mi race". */
export function raceDistanceName(km: number, units: DistanceUnit = "km"): string {
  if (Math.abs(km - 21.1) < 0.6) return "Half marathon";
  if (Math.abs(km - 42.2) < 0.8) return "Marathon";
  if (Math.abs(km - 10) < 0.3) return "10K";
  if (Math.abs(km - 5) < 0.2) return "5K";
  return `${distanceWords(km, units)} race`;
}

// ---------------------------------------------------------------------------
// Pace and clock
// ---------------------------------------------------------------------------

/** Seconds as m:ss ("6:11"); h:mm:ss past the hour. */
export function clockWords(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** A pace's clock in the athlete's unit, no suffix ("6:11" per km → "9:57" per mile). */
export function paceClock(secPerKm: number, units: DistanceUnit = "km"): string {
  const perUnit = units === "mi" ? secPerKm * KM_PER_MI : secPerKm;
  const s = Math.round(perUnit);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "6:11/km", "9:57/mi"; `spaced` writes "6:11 /km" (a band's register). */
export function paceWords(secPerKm: number, units: DistanceUnit = "km", opts: { spaced?: boolean } = {}): string {
  return `${paceClock(secPerKm, units)}${opts.spaced ? " " : ""}/${units}`;
}

/** A pace band, fast–slow: "5:10–5:25 /km"; one value when the two meet. */
export function paceBandWords(fastSecPerKm: number, slowSecPerKm: number, units: DistanceUnit = "km"): string {
  const fast = paceClock(fastSecPerKm, units);
  const slow = paceClock(slowSecPerKm, units);
  return fast === slow ? `${fast} /${units}` : `${fast}–${slow} /${units}`;
}

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------

/** A canonical lb value in the athlete's weight unit (one decimal). */
export function weightValue(lb: number, units: WeightUnit = "lb"): number {
  return round1(units === "kg" ? lb / LB_PER_KG : lb);
}

/** A kg value back to canonical lb (two decimals) — input parsing only. */
export function lbFromKg(kg: number): number {
  return Math.round(kg * LB_PER_KG * 100) / 100;
}

/**
 * Bodyweight or a load in a sentence: "159.6 lb", "72.4 kg". `whole` rounds to the
 * nearest unit (a lift's load: "185 lb", "84 kg").
 */
export function weightWords(
  lb: number,
  units: WeightUnit = "lb",
  opts: { whole?: boolean; grouped?: boolean } = {}
): string {
  const v = units === "kg" ? lb / LB_PER_KG : lb;
  // `grouped`: a big total said with thousands separators ("12,450 lb" — a session's tonnage).
  if (opts.grouped) return `${Math.round(v).toLocaleString("en-US")} ${units}`;
  return `${opts.whole ? String(Math.round(v)) : plain(v)} ${units}`;
}

/** A load in kg to the nearest half kilo (what a kg athlete loads a bar with). */
function kgLoad(lb: number): string {
  const v = Math.round((lb / LB_PER_KG) * 2) / 2;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * A lift's load: "185 lb", "84 kg", "bodyweight", "30 lb assist" (negative = assisted;
 * null = bodyweight). Stored loads are lb; a kg athlete reads the nearest half kilo.
 */
export function loadWords(lb: number | null, units: WeightUnit = "lb"): string {
  if (lb == null) return "bodyweight";
  const w = Math.abs(lb);
  const n = units === "kg" ? kgLoad(w) : Number.isInteger(w) ? String(w) : w.toFixed(1);
  return lb < 0 ? `${n} ${units} assist` : `${n} ${units}`;
}

/** A load step in words: "+5 lb", "−2.5 kg", "hold 185 lb". */
export function loadChangeWords(fromLb: number | null, toLb: number | null, units: WeightUnit = "lb"): string | null {
  if (toLb == null) return null;
  if (fromLb == null) return loadWords(toLb, units);
  const d = toLb - fromLb;
  if (Math.abs(d) < 0.01) return `hold ${loadWords(toLb, units)}`;
  const n = units === "kg" ? kgLoad(Math.abs(d)) : plain(Math.abs(d));
  return `${d > 0 ? "+" : "−"}${n} ${units}`;
}

/** A weight change, signed: "−0.9 lb", "+0.4 kg". */
export function weightDeltaWords(lb: number, units: WeightUnit = "lb"): string {
  return `${signedWords(units === "kg" ? lb / LB_PER_KG : lb)} ${units}`;
}

/** A weekly rate, signed: "−0.9 lb/wk", "−0.4 kg/wk". One rounding for every surface. */
export function weightRateWords(lbPerWk: number, units: WeightUnit = "lb"): string {
  return `${signedWords(units === "kg" ? lbPerWk / LB_PER_KG : lbPerWk)} ${units}/wk`;
}

/** A weekly rate, signed, in the athlete's unit, one decimal: the NUMBER every surface prints. */
export function weightRateValue(lbPerWk: number, units: WeightUnit = "lb"): number {
  return round1(units === "kg" ? lbPerWk / LB_PER_KG : lbPerWk);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parts(iso: string): { y: number; m: number; d: number; dow: number; t: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), dow: new Date(t).getUTCDay(), t };
}

function dayDiff(iso: string, today: string): number | null {
  const a = parts(iso);
  const b = parts(today);
  return a && b ? Math.round((a.t - b.t) / 864e5) : null;
}

/**
 * - `short`   "Oct 6" (the year only when it is not today's year: "Aug 24, 2025")
 * - `weekday` "Mon, Oct 6"
 * - `day`     "Monday"
 * - `relative` "today" / "tomorrow" / "yesterday" / a weekday within the week either
 *             side ("Thursday", "last Thursday") / else `short`
 */
export type DateStyle = "short" | "weekday" | "day" | "relative";

/** A date in words, never an ISO string. Unparseable input reads as "". */
export function dateWords(iso: string | null | undefined, today?: string | null, style: DateStyle = "short"): string {
  const p = parts(String(iso ?? ""));
  if (!p) return "";
  const t = today ? parts(today) : null;
  const short = `${MONTHS[p.m - 1]} ${p.d}${t && t.y !== p.y ? `, ${p.y}` : ""}`;
  if (style === "day") return WEEKDAYS[p.dow];
  if (style === "weekday") return `${WEEKDAYS[p.dow].slice(0, 3)}, ${short}`;
  if (style === "relative" && today) {
    const diff = dayDiff(String(iso), today);
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff === -1) return "yesterday";
    if (diff != null && diff > 1 && diff < 7) return WEEKDAYS[p.dow];
    if (diff != null && diff < -1 && diff > -7) return `last ${WEEKDAYS[p.dow]}`;
  }
  return short;
}

/** "Oct 6 – Oct 12", "Nov 17 – Jan 12, 2027" — a window, each end once. */
export function dateRangeWords(startIso: string, endIso: string, today?: string | null): string {
  const a = parts(startIso);
  const b = parts(endIso);
  if (!a || !b) return dateWords(startIso, today) || dateWords(endIso, today);
  const ref = today ? parts(today) : null;
  const split = a.y !== b.y;
  const left = `${MONTHS[a.m - 1]} ${a.d}${split ? `, ${a.y}` : ""}`;
  const right = `${MONTHS[b.m - 1]} ${b.d}${split || (ref && ref.y !== b.y) ? `, ${b.y}` : ""}`;
  return `${left} – ${right}`;
}

/**
 * The companion of a `since` date: "since yesterday", "since Monday", "since Sep 25".
 * Empty when the date is unreadable.
 */
export function sinceWords(iso: string | null | undefined, today?: string | null): string {
  const p = parts(String(iso ?? ""));
  if (!p) return "";
  if (today) {
    const diff = dayDiff(String(iso), today);
    if (diff === 0) return "since this morning";
    if (diff === -1) return "since yesterday";
    if (diff != null && diff < -1 && diff > -7) return `since ${WEEKDAYS[p.dow]}`;
  }
  return `since ${dateWords(String(iso), today)}`;
}

/** "26 days to Cambridge Half" / "1 day to …" / "Race day". */
export function countdownWords(days: number, what: string): string {
  if (days <= 0) return `${what} is today`;
  return `${days} ${days === 1 ? "day" : "days"} to ${what}`;
}

/** True when the text carries a machine date (YYYY-MM-DD) — athlete prose must not. */
export function hasIsoDate(text: string): boolean {
  return /\b\d{4}-\d{2}-\d{2}\b/.test(String(text ?? ""));
}

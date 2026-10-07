// @ts-check
// The ONE client formatter: distances, paces, weights and every athlete-facing date
// word. Units follow the athlete (settings.run_units / weight_units, ONE cached read);
// the engine and Garmin/Apple data stay km / lb and are converted only here, at the
// edge. This is the only src/client file that may hold the km<->mi factor or build a
// date string with toLocale*/Intl (test/clientFormatContract.test.js). A further unit
// (height, temperature, energy) is one more entry in the factor/label table below.

// One block: nothing but CairnFmt and the legacy function names reaches the global scope.
{
const KM_PER_MILE = 1.609344;
const KG_PER_LB = 0.45359237;

function fmtKm(km: unknown): string {
  const v = Number(km);
  if (!Number.isFinite(v)) return "—";
  return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
}

function runUnits(value: unknown): "km" | "mi" {
  const s = String(value || "").trim().toLowerCase();
  return s === "mi" || s === "mile" || s === "miles" ? "mi" : "km";
}

function fmtRunUnitSuffix(units: unknown): string {
  return runUnits(units) === "mi" ? "/mi" : "/km";
}

/** "6.1 mi" / "9.8 km"; `bare` drops the unit ("6.1"). "—" for a non-number. */
function fmtDist(km: unknown, units?: unknown, bare?: boolean): string {
  const v = Number(km);
  if (!Number.isFinite(v)) return "—";
  const mi = runUnits(units) === "mi";
  const n = fmtKm(mi ? v / KM_PER_MILE : v);
  return bare ? n : `${n} ${mi ? "mi" : "km"}`;
}

/** "m:ss" per km, or per mile for a miles athlete; "—" for no pace. */
function fmtPaceFromSecPerKm(secPerKm: unknown, units?: unknown): string {
  const sec = Number(secPerKm);
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const total = Math.round(runUnits(units) === "mi" ? sec * KM_PER_MILE : sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function fmtPaceBand(band: { slow_sec_per_km?: unknown; fast_sec_per_km?: unknown; text?: unknown } | null | undefined, units?: unknown): string {
  if (!band) return "";
  const fast = fmtPaceFromSecPerKm(band.fast_sec_per_km, units);
  const slow = fmtPaceFromSecPerKm(band.slow_sec_per_km, units);
  if (fast === "—" && slow === "—") return String(band.text || "");
  const suffix = fmtRunUnitSuffix(units);
  if (fast === slow || slow === "—") return `${fast} ${suffix}`;
  if (fast === "—") return `${slow} ${suffix}`;
  return `${fast}–${slow} ${suffix}`;
}

/** "159.6 lb" / "72.4 kg" from the stored pounds; `bare` is the number alone. */
function fmtLb(lb: unknown, units?: unknown, bare?: boolean): string {
  const v = Number(lb);
  if (lb == null || lb === "" || !Number.isFinite(v)) return "—";
  const kg = units === "kg";
  const r = Math.round((kg ? v * KG_PER_LB : v) * 10) / 10;
  // A tonnage reads "12,450 lb", never "12450.3 lb".
  const n = Math.abs(r) >= 1000 ? Math.round(r).toLocaleString("en-US") : String(r);
  return bare ? n : `${n} ${kg ? "kg" : "lb"}`;
}

// ---- dates: one parser, one Intl door ----

type FmtStyle = "short" | "long" | "label" | "ago" | "age";
// `fmt` is the one escape hatch: Intl options for a rare shape ({ weekday: "long" }), `utc` for a chart axis.
type FmtDateOpts = { style?: FmtStyle; year?: boolean | "always"; today?: string; fmt?: Intl.DateTimeFormatOptions; utc?: boolean };

/** A calendar day at local noon (or UTC noon): never shifts a day across a zone. */
function isoDay(iso: unknown, utc?: boolean): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return null;
  const d = utc ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date(+m[1], +m[2] - 1, +m[3], 12);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtOn(iso: unknown, o: Intl.DateTimeFormatOptions, utc?: boolean): string {
  const d = isoDay(iso, utc);
  if (!d) return String(iso || "");
  return d.toLocaleDateString(utc ? "en-US" : undefined, utc ? { ...o, timeZone: "UTC" } : o);
}

function daysBetween(later: unknown, earlier: unknown): number {
  const a = isoDay(later, true);
  const b = isoDay(earlier, true);
  return a && b ? Math.round((a.getTime() - b.getTime()) / 86_400_000) : 0;
}

/** Where a day sits against `today`, in words: "Today", "Tomorrow", "In 4 days", "3 days ago". */
function relDay(iso: unknown, today: unknown): string {
  const n = daysBetween(iso, today);
  if (n === 0) return "Today";
  if (n === -1) return "Yesterday";
  if (n === 1) return "Tomorrow";
  if (n < 0) return -n < 14 ? `${-n} days ago` : `${Math.round(-n / 7)} weeks ago`;
  return n < 14 ? `In ${n} days` : `In ${Math.round(n / 7)} weeks`;
}

function ageWords(iso: unknown, long: boolean): string {
  if (!isoDay(iso)) return String(iso || "");
  const n = daysBetween(localISO(), iso);
  if (n < 0) return fmtOn(iso, { month: "short", day: "numeric", year: "numeric" });
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 7) return `${n} days ago`;
  if (n < 14) return "last week";
  if (n < 45) return `${Math.round(n / 7)} weeks ago`;
  if (!long) return fmtOn(iso, { month: "short", year: "numeric" });
  if (n < 320) return `${Math.max(1, Math.round(n / 30))} months ago`;
  return n < 550 ? "a year ago" : `${Math.round(n / 365)} years ago`;
}

function dateLabel(iso: string): string {
  if (iso === localISO()) return "Today";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return iso === localISO(y) ? "Yesterday" : fmtOn(iso, { weekday: "short", month: "short", day: "numeric" });
}

/** "Mar 4", or "Mar 4, 2025" outside this year (`today` names it); `year:false` never prints one, "always" always. */
function shortDate(iso: string, opts: { year?: boolean | "always"; today?: string } = {}): string {
  const withYear =
    opts.year === "always" || (opts.year !== false && String(iso || "").slice(0, 4) !== (opts.today || localISO()).slice(0, 4));
  return fmtOn(iso, withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
}

const humanDate = (iso: string): string => ageWords(iso, false);
const relAge = (iso: string): string => ageWords(iso, true);
const absDate = (iso: string): string => fmtOn(iso, { month: "long", day: "numeric", year: "numeric" });

const FMT_DATE: Record<FmtStyle, (iso: string, o: FmtDateOpts) => string> = {
  short: shortDate,
  long: absDate,
  label: dateLabel,
  ago: humanDate,
  age: relAge,
};

// ---- units: ONE cached settings read; Settings is the only writer ----

type FmtUnits = { distance: "km" | "mi"; weight: "lb" | "kg" };
let fmtUnitsMemo: FmtUnits | null = null;

function fmtSetUnits(settings: { run_units?: unknown; weight_units?: unknown } | null | undefined): FmtUnits {
  return (fmtUnitsMemo = { distance: runUnits(settings?.run_units), weight: settings?.weight_units === "kg" ? "kg" : "lb" });
}

const CairnFmt = {
  /** The athlete's units now (km / lb until the settings read lands). */
  units: (): FmtUnits => fmtUnitsMemo || { distance: "km", weight: "lb" },
  /** The settings read behind units(), once per memo; a failed read leaves km / lb. */
  ready: (): Promise<FmtUnits> =>
    fmtUnitsMemo
      ? Promise.resolve(fmtUnitsMemo)
      : api("/settings").then((r) => fmtSetUnits((r as unknown as { settings?: { run_units?: unknown; weight_units?: unknown } } | null)?.settings), () => CairnFmt.units()),
  /** Settings (the only writer) or any settings read hands over the athlete's units. */
  set: fmtSetUnits,
  /** Kilometres as words in the athlete's units ("6.1 mi"); `bare` is the number alone. */
  distance: (km: unknown, units?: unknown, bare?: boolean): string => fmtDist(km, units ?? CairnFmt.units().distance, bare),
  /** Kilometres as a plain number in the athlete's units (chart axes). */
  toUnit: (km: unknown, units?: unknown): number =>
    (Number(km) || 0) / (runUnits(units ?? CairnFmt.units().distance) === "mi" ? KM_PER_MILE : 1),
  /** "m:ss" per athlete unit (the caller adds fmtRunUnitSuffix). */
  pace: (secPerKm: unknown, units?: unknown): string => fmtPaceFromSecPerKm(secPerKm, units ?? CairnFmt.units().distance),
  /** Stored pounds as "159.6 lb" / "72.4 kg". */
  weight: (lb: unknown, units?: unknown, bare?: boolean): string => fmtLb(lb, units ?? CairnFmt.units().weight, bare),
  /** The write edge: a number typed in the athlete's weight unit, as stored pounds (0 for nothing). */
  toLb: (value: unknown, units?: unknown): number => {
    const v = Number(value) || 0;
    return (units ?? CairnFmt.units().weight) === "kg" ? Math.round((v / KG_PER_LB) * 100) / 100 : v;
  },
  /** The one door for an athlete-facing date: never an ISO string. */
  date: (iso: unknown, o: FmtDateOpts = {}): string =>
    o.fmt ? fmtOn(iso, o.fmt, o.utc) : (FMT_DATE[o.style || "short"] || shortDate)(String(iso || ""), o),
  relDay,
  daysBetween,
};

Object.assign(globalThis, {
  CairnFmt,
  fmtKm,
  runUnits,
  fmtRunUnitSuffix,
  fmtDist,
  fmtPaceFromSecPerKm,
  fmtPaceBand,
  fmtLb,
  dateLabel,
  humanDate,
  relAge,
  absDate,
  shortDate,
});
}

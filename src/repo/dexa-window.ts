// The DEXA re-scan window — ONE derivation shared by Train's forward timeline and
// Stand's next-checkup read so both surfaces tell the same story: a body-composition
// re-scan is a calm SUGGESTION WINDOW (roughly 12–16 weeks on from the last scan),
// never an appointment or a hard date. The attention engine keeps its own scheduling
// math (a next_due date) untouched — this is purely how the window is DERIVED and
// FRAMED for the athlete. Pure/offline, null-safe.
import { addDaysISO } from "./shared.js";

// 12–16 weeks past the baseline scan.
const RESCAN_START_DAYS = 84;
const RESCAN_END_DAYS = 112;

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// The most recent real DEXA / body-composition scan date across the marker history,
// or null when none carries a usable date. This is the WINDOW baseline: unlike the
// attention engine's scheduling date (which anchors to today when a scan is dateless),
// a window with no dated anchor is simply absent — better silent than fabricated.
export function latestDexaDate(markers: any[]): string | null {
  let latest: string | null = null;
  for (const marker of Array.isArray(markers) ? markers : []) {
    const name = String(marker?.name ?? "").toLowerCase();
    const looksDexa =
      marker?.latest?.kind === "dexa" ||
      (Array.isArray(marker?.points) && marker.points.some((p: any) => p?.kind === "dexa")) ||
      /\b(dexa|visceral|almi|ffmi|bmd|t-score|z-score)\b/.test(name);
    if (!looksDexa) continue;
    const date = iso(marker?.latest?.date ?? marker?.points?.at?.(-1)?.date);
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

export interface DexaRescanWindow {
  start: string;
  end: string;
}

// The 12–16-week re-scan window off a baseline scan date, or null when the baseline is
// missing/unparseable.
export function dexaRescanWindow(baseline: string | null | undefined): DexaRescanWindow | null {
  const anchor = iso(baseline);
  if (!anchor) return null;
  const start = addDaysISO(anchor, RESCAN_START_DAYS);
  const end = addDaysISO(anchor, RESCAN_END_DAYS);
  return start && end ? { start, end } : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}`;
}

// A calm window-framed when_text for the next-checkup DEXA row — "worth considering
// around <start>–<end>" — so Stand frames the re-scan as the same soft window Train
// shows, never a bare due date. Null when there's no window.
export function dexaRescanWhenText(window: DexaRescanWindow | null | undefined): string | null {
  if (!window) return null;
  return `worth considering around ${shortDate(window.start)}–${shortDate(window.end)}`;
}

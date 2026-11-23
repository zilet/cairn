// Blood pressure: the athlete's own home reading (like a weigh-in, the reading itself is
// fine to show), where it sits against the usual band in words, and which way it has moved
// since the earlier readings. The meaning comes from the ONE blood-pressure read
// (blood-pressure-read.ts, via propagation.ts bloodPressureNow): a single reading is a
// snapshot, a low reading that fits training or weight loss is the person's level, and only
// its own `raise_with_doctor` ever suggests a conversation. Informational, never advice.
import type { WeekReadStandingDirection, WeekReadStandingRow } from "../../../contracts/week-read.js";
import { addDaysISO } from "../../../lib/dates.js";
import { dateWords } from "../../../repo/display-words.js";
import { readingAgeDays, readingPastValidity } from "../../../repo/marker-validity.js";
import { bloodPressureNow } from "../../../repo/propagation.js";
import { standingLine, standingRow } from "./words.js";

/** A move in systolic pressure smaller than this reads as level (mmHg). */
export const BP_MOVE_MMHG = 5;
/** The recent readings: the latest two weeks. */
const RECENT_DAYS = 13;
/** The earlier readings: a month to three months before the latest. */
const EARLIER_FROM_DAYS = 90;
const EARLIER_TO_DAYS = 30;
/** Readings on this many days in the last two weeks are a home series. */
const SERIES_DAYS = 3;

type Point = { date: string; value: number };

function mean(points: Point[]): number | null {
  return points.length ? points.reduce((s, p) => s + p.value, 0) / points.length : null;
}

export function pressureRow(today: string): WeekReadStandingRow | null {
  const bp = bloodPressureNow();
  const lead = bp.systolic ?? bp.diastolic;
  if (!lead) return null;
  const latest = lead.points[lead.points.length - 1];
  // A reading past what blood pressure stays current for says nothing about today.
  if (readingPastValidity("Systolic BP", readingAgeDays(latest.date, today))) return null;

  const diaOn = bp.diastolic?.points.find((p) => p.date === latest.date) ?? null;
  const sysOn = bp.systolic?.points.find((p) => p.date === latest.date) ?? null;
  const reading =
    sysOn && diaOn
      ? `${Math.round(sysOn.value)}/${Math.round(diaOn.value)} mmHg`
      : sysOn
        ? `${Math.round(sysOn.value)} mmHg systolic`
        : `${Math.round((diaOn as Point).value)} mmHg diastolic`;

  const reads = [bp.systolic?.read, bp.diastolic?.read].filter((r): r is NonNullable<typeof r> => !!r);
  const high = reads.find((r) => r.side === "high") ?? null;
  const low = high ? null : (reads.find((r) => r.side === "low") ?? null);
  const raise = reads.some((r) => r.raise_with_doctor);
  const expectedLow = !!low?.expected;

  // Direction over systolic (diastolic when it is the only series): recent against earlier.
  const series = lead.points;
  const recentFrom = addDaysISO(latest.date, -RECENT_DAYS) ?? latest.date;
  const earlierFrom = addDaysISO(latest.date, -EARLIER_FROM_DAYS) ?? latest.date;
  const earlierTo = addDaysISO(latest.date, -EARLIER_TO_DAYS) ?? latest.date;
  const recent = series.filter((p) => p.date >= recentFrom);
  const earlier = series.filter((p) => p.date >= earlierFrom && p.date <= earlierTo);
  const recentMean = recent.length >= 2 ? mean(recent) : null;
  const earlierMean = earlier.length >= 2 ? mean(earlier) : null;
  let direction: WeekReadStandingDirection | null = null;
  let move: string | null = null;
  if (recentMean != null && earlierMean != null) {
    const delta = Math.round(recentMean - earlierMean);
    if (Math.abs(delta) < BP_MOVE_MMHG) {
      direction = "holding";
      move = "level with your earlier readings";
    } else {
      // Lower is better in and above the band (risk keeps falling toward about 90); on the
      // low side a reading that is the person's level holds, and one rising back toward
      // the band is the better way.
      if (low && expectedLow) direction = "holding";
      else if (low) direction = delta > 0 ? "better" : "worse";
      else direction = delta < 0 ? "better" : "worse";
      move = `${Math.abs(delta)} mmHg ${delta < 0 ? "lower" : "higher"} than your earlier readings`;
    }
  }

  const seriesDays = new Set(series.filter((p) => p.date >= recentFrom).map((p) => p.date)).size;
  const settled = reads.length ? reads.some((r) => r.settled) : seriesDays >= SERIES_DAYS;
  const fits = low?.note === "expected while losing weight" ? "losing weight" : "your training";
  const sideWords = high
    ? "On the high side"
    : low
      ? expectedLow
        ? "A little under the usual band"
        : "On the low side"
      : "In the usual band";
  const basis =
    (high ?? low)?.note ?? (settled ? "from several readings" : `measured ${dateWords(latest.date, today)}`);
  const note = `${sideWords.toLowerCase()}, ${basis}`;

  let words: string;
  if (high) {
    words = settled
      ? "Your recent readings sit on the high side."
      : "Your latest reading sat on the high side; a few home readings would settle whether it is your level.";
  } else if (low && expectedLow) {
    words = `Your readings sit a little under the usual band, which fits ${fits}.`;
  } else if (low) {
    words = "Your latest reading sat on the low side.";
  } else {
    words = settled ? "Your recent readings sit in the usual band." : "Your latest reading sits in the usual band.";
  }
  if (raise) words += " Worth raising with your doctor.";

  return standingRow("health", {
    key: "pressure",
    stone: "heart",
    label: "Blood pressure",
    words,
    since_words: direction ? `since ${dateWords(earlier[0]?.date ?? earlierFrom, today)}` : null,
    lines: [
      standingLine("health", {
        id: "pressure:latest",
        label: "Latest reading",
        now_text: reading,
        direction,
        move_words: move,
        note,
      }),
    ],
    invite: null,
    href: "/app/you/markers",
  });
}

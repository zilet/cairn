// Recovery trend bars — the ONE answer to "is this drift meaningful vs the athlete's
// own norm?". Signal-state and day-read used to disagree: HRV was already
// norm-relative in both, but resting HR (and sleep, in day-read) still used flat
// constants, so the Brief could warn about mounting fatigue while its own signal
// state said nothing was wrong.
//
// Former constants are kept as FLOORS so a tiny or missing norm can never make
// the test hypersensitive. A 40 ms HRV athlete's 10% collapse still registers;
// a 120 ms athlete's 5 ms of ordinary noise does not.

// A SECOND floor, and the evidence-based one: the smallest worthwhile change is a
// fraction of the athlete's OWN dispersion, not a fraction of the metric. Two
// athletes with the same 60 ms baseline can differ fourfold in how much their HRV
// swings between ordinary mornings, and a flat 5% told the noisy one their noise
// was a finding every other week.
//
// `dispersion` is the baseline window's own standard deviation (getRecoverySummary
// takes it over exactly the rows the baseline median is taken over, and withholds
// it below DISPERSION_MIN_N). It can only ever WIDEN the band — the constants below
// remain the floor — because the narrowing direction is the dangerous one: it would
// mint cautions for the athlete whose watch happens to be consistent, which is the
// athlete this system knows best. Absent dispersion changes nothing at all.
import { SWC_SD_FRACTION } from "./recovery-science.js";

export const RECOVERY_SAMPLE_FLOOR = 3;

export interface RecoveryDispersion {
  hrv?: unknown;
  rhr?: unknown;
  sleep?: unknown;
}

export function recoveryTrendBars(
  baseline?: { hrv?: unknown; rhr?: unknown; sleep?: unknown } | null,
  dispersion?: RecoveryDispersion | null
): {
  hrv: number;
  rhr: number;
  sleep: number;
} {
  const hrv = Number(baseline?.hrv);
  const rhr = Number(baseline?.rhr);
  const sleep = Number(baseline?.sleep);
  const swc = (value: unknown): number => {
    const sd = Number(value);
    return Number.isFinite(sd) && sd > 0 ? sd * SWC_SD_FRACTION : 0;
  };
  return {
    hrv: Math.max(Number.isFinite(hrv) && hrv > 0 ? Math.max(2, hrv * 0.05) : 5, swc(dispersion?.hrv)),
    rhr: Math.max(Number.isFinite(rhr) && rhr > 0 ? Math.max(3, rhr * 0.05) : 3, swc(dispersion?.rhr)),
    sleep: Math.max(Number.isFinite(sleep) && sleep > 0 ? Math.max(25, sleep * 0.05) : 25, swc(dispersion?.sleep)),
  };
}

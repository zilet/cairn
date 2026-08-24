// Recovery trend bars — the ONE answer to "is this drift meaningful vs the athlete's
// own norm?". Signal-state and day-read used to disagree: HRV was already
// norm-relative in both, but resting HR (and sleep, in day-read) still used flat
// constants, so the Brief could warn about mounting fatigue while its own signal
// state said nothing was wrong.
//
// Former constants are kept as FLOORS so a tiny or missing norm can never make
// the test hypersensitive. A 40 ms HRV athlete's 10% collapse still registers;
// a 120 ms athlete's 5 ms of ordinary noise does not.

export const RECOVERY_SAMPLE_FLOOR = 3;

export function recoveryTrendBars(baseline?: { hrv?: unknown; rhr?: unknown; sleep?: unknown } | null): {
  hrv: number;
  rhr: number;
  sleep: number;
} {
  const hrv = Number(baseline?.hrv);
  const rhr = Number(baseline?.rhr);
  const sleep = Number(baseline?.sleep);
  return {
    hrv: Number.isFinite(hrv) && hrv > 0 ? Math.max(2, hrv * 0.05) : 5,
    rhr: Number.isFinite(rhr) && rhr > 0 ? Math.max(3, rhr * 0.05) : 3,
    sleep: Number.isFinite(sleep) && sleep > 0 ? Math.max(25, sleep * 0.05) : 25,
  };
}

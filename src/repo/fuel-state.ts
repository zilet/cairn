// Fuel state — the deterministic, pace-aware read of "how is protein tracking so
// far today?" that the Brief's FUEL line and the day-read fuel signal both rest on.
//
// The bug this fixes: the old FUEL line was pace-BLIND — it said "protein is ~N g
// short of today's target" whenever ≥25 g remained, which is trivially true before
// dinner. At 11:51 AM, 65 g into a 175 g day after a 60 g breakfast, the athlete is
// ON pace, yet the line cried "110 g short — refuel". This module grades protein
// against where you'd EXPECT to be at this point in the eating window, so "on pace"
// (even with grams still to eat) is distinct from genuinely "behind".
//
// Pure + deterministic (inject `now` for tests). Null-safe throughout: no derivable
// target (incomplete profile) → null, i.e. no FUEL line at all. Kept in its own leaf
// module so day-read.ts can pull it into the deterministic signals with the existing
// benign function-body-only cycle (day-read → fuel-state → nutrition → profile →
// intelligence → day-read), never a load-time one.
import { getDayIntake } from "./nutrition.js";
import { localDateISO, localHourFraction, parseDbTime } from "./shared.js";

// The eating window the pace model measures elapsed time against. Start is the
// first logged meal's LOCAL time (else this floor); end is a plain "done eating
// for the day" o'clock. Both are local wall-clock hours (device zone).
const DEFAULT_WINDOW_START_HOUR = 7; // 07:00 — before a meal is logged, assume the day starts here
const WINDOW_END_HOUR = 21; // 21:00 — protein "should" be in by roughly here
// Grams of slack below the pace line before "behind" — a bucket boundary, not a nag.
const ON_PACE_SLACK_G = 20;
// Grams still owed at or under which the day is comfortably "met".
const MET_REMAINING_G = 10;

export type FuelBucket = "behind" | "on_pace" | "met";

export interface FuelState {
  bucket: FuelBucket;
  protein_so_far_g: number;
  target_g: number;
  // Grams you'd expect to have eaten by `now` given the eating window — the pace
  // line "behind"/"on_pace" is graded against. Equals target_g for a past date
  // (pace is meaningless once the day is over → the full day's total is the bar).
  expected_by_now_g: number;
  last_meal?: { minutes_ago: number; protein_g: number | null; label: string };
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// The pace-aware protein read for one local day. `date` defaults to today; `now`
// is injectable for deterministic tests. Returns null when there is no derivable
// protein target (profile incomplete) — the caller then simply omits the FUEL line.
export function dayFuelState(date?: string, now: Date = new Date()): FuelState | null {
  try {
    const today = localDateISO(now);
    const d = date || today;

    const intake: any = getDayIntake(d);
    const target = intake?.target;
    const targetProtein = Number(target?.protein_g);
    if (!target || !Number.isFinite(targetProtein) || targetProtein <= 0) return null;

    const target_g = Math.round(targetProtein);
    const protein_so_far_g = Math.round(Number(intake?.totals?.protein_g) || 0);

    // The most recent logged entry (entries are id-ASC, so the last one is newest)
    // — its recency lets the agent say "you last ate 3 h ago" when nudging.
    const entries: any[] = Array.isArray(intake?.entries) ? intake.entries : [];
    let last_meal: FuelState["last_meal"] | undefined;
    const lastEntry = entries.length ? entries[entries.length - 1] : null;
    if (lastEntry?.created_at) {
      const at = parseDbTime(lastEntry.created_at);
      if (at) {
        const minutes_ago = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60000));
        const pg = Number(lastEntry.protein_g);
        last_meal = {
          minutes_ago,
          protein_g: Number.isFinite(pg) ? Math.round(pg) : null,
          label: String(lastEntry.summary ?? lastEntry.meal ?? "meal").slice(0, 80),
        };
      }
    }

    // Expected-by-now grams. For a PAST local day, pace is meaningless — the whole
    // day's total is the bar (so the bucket is met-or-behind on full-day totals).
    // For today, grade against elapsed time through the eating window.
    let expected_by_now_g: number;
    if (d < today) {
      expected_by_now_g = target_g;
    } else {
      // Window start = first logged meal's local time (else the 07:00 floor).
      let startHour = DEFAULT_WINDOW_START_HOUR;
      const firstEntry = entries.length ? entries[0] : null;
      if (firstEntry?.created_at) {
        const firstAt = parseDbTime(firstEntry.created_at);
        if (firstAt) startHour = localHourFraction(firstAt);
      }
      const nowHour = localHourFraction(now);
      const windowSpan = WINDOW_END_HOUR - startHour;
      const frac = windowSpan > 0 ? clamp01((nowHour - startHour) / windowSpan) : 1;
      expected_by_now_g = Math.round(target_g * frac);
    }

    const remaining = target_g - protein_so_far_g;
    const bucket: FuelBucket =
      remaining <= MET_REMAINING_G
        ? "met"
        : protein_so_far_g >= expected_by_now_g - ON_PACE_SLACK_G
          ? "on_pace"
          : "behind";

    return { bucket, protein_so_far_g, target_g, expected_by_now_g, ...(last_meal ? { last_meal } : {}) };
  } catch {
    // A derivation failure must never break the deterministic day read — no signal.
    return null;
  }
}

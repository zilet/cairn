// Recovery: sleep, HRV and resting heart rate, the last week's middle night against the
// athlete's own usual month (getRecoverySummary's recent and 30-day medians, its coverage
// floors and its trust classification), judged by the ONE meaningful-change band
// (recoveryTrendBars). A stale reading is absent (sensor-freshness.ts), and the 0-100
// readiness number is never read here.
import type {
  WeekReadStandingDirection,
  WeekReadStandingLine,
  WeekReadStandingRow,
} from "../../../contracts/week-read.js";
import { getRecoverySummary } from "../../../repo/coach.js";
import { recoveryTrendBars } from "../../../repo/recovery-trend.js";
import { sensorIsCurrent, type SensorSignal } from "../../../repo/sensor-freshness.js";
import { cap, joinWords, sleepWords, standingLine, standingRow } from "./words.js";

interface Measure {
  key: "sleep" | "hrv" | "rhr";
  field: "sleep_min" | "hrv_ms" | "resting_hr";
  signal: SensorSignal;
  label: string;
  /** Higher is better (sleep, HRV) or lower is (resting heart rate). */
  higherIsBetter: boolean;
  now: (v: number) => string;
  amount: (v: number) => string;
  up: string;
  down: string;
}

const MEASURES: Measure[] = [
  {
    key: "sleep",
    field: "sleep_min",
    signal: "sleep",
    label: "Sleep",
    higherIsBetter: true,
    now: (v) => sleepWords(v),
    amount: (v) => sleepWords(v),
    up: "more than",
    down: "less than",
  },
  {
    key: "hrv",
    field: "hrv_ms",
    signal: "hrv",
    label: "HRV",
    higherIsBetter: true,
    now: (v) => `${Math.round(v)} ms`,
    amount: (v) => `${Math.round(v)} ms`,
    up: "above",
    down: "below",
  },
  {
    key: "rhr",
    field: "resting_hr",
    signal: "resting_hr",
    label: "Resting heart rate",
    higherIsBetter: false,
    now: (v) => `${Math.round(v)} bpm`,
    amount: (v) => `${Math.round(v)} bpm`,
    up: "higher than",
    down: "lower than",
  },
];

export function recoveryRow(today: string): WeekReadStandingRow | null {
  const rs: any = getRecoverySummary(14, undefined, today);
  if (!rs?.has_data) return null;
  const bars = recoveryTrendBars(rs.baseline, rs.dispersion);
  const lines: WeekReadStandingLine[] = [];
  const level: string[] = [];
  const moved: string[] = [];
  const plain: string[] = [];
  for (const m of MEASURES) {
    const latestDate = rs.quality?.[m.field]?.latest_date ?? null;
    if (!sensorIsCurrent(m.signal, latestDate, today)) continue;
    const recent = Number(rs.recent?.[m.key]);
    if (!Number.isFinite(recent) || recent <= 0) continue;
    const delta = rs.delta?.[m.key];
    let direction: WeekReadStandingDirection | null = null;
    let move: string | null = null;
    if (delta != null && Number.isFinite(Number(delta))) {
      const d = Number(delta);
      if (Math.abs(d) < bars[m.key]) {
        direction = "holding";
        move = "level with your usual";
      } else {
        const up = d > 0;
        direction = up === m.higherIsBetter ? "better" : "worse";
        move = `${m.amount(Math.abs(d))} ${up ? m.up : m.down} your usual`;
      }
    }
    const now = m.now(recent);
    lines.push(
      standingLine("health", {
        id: `recovery:${m.key}`,
        label: m.label,
        now_text: now,
        direction,
        move_words: move,
        note: direction ? "the last week against your usual month" : "a few more nights will let this compare",
      })
    );
    const name = m.key === "hrv" ? "HRV" : m.label.toLowerCase();
    if (direction === "holding") level.push(name);
    else if (move) moved.push(`${name} ${move}`);
    else plain.push(`${name} ${now}`);
  }
  if (!lines.length) return null;
  // "HRV and sleep level with your usual, resting heart rate 3 bpm lower than your usual."
  const parts = [...moved, ...(level.length ? [`${joinWords(level)} level with your usual`] : [])];
  const said = parts.length ? parts : plain;
  const words = `${cap(said.join(", "))}.`;
  return standingRow("health", {
    key: "recovery",
    stone: "recovery",
    label: "Recovery",
    words,
    since_words: "over the last week",
    lines,
    invite: null,
    href: "/app/you/recovery",
  });
}

// Blood, one line per marker PANEL (the clinical groups of propagation-data.ts), read over
// the ranked marker list (prioritizeMarkers) and the health focus. Counts in words only:
// "In range" or "Two to tighten" — never a lab value, never an internal ranking number, a
// forecast's weeks, a biological age or a risk figure. A band the surfaces may not speak
// about (markerOptimalTrusted, marker-public.ts) counts only by the lab's own flag.
// Informational, never medical advice.
import type {
  WeekReadStandingDirection,
  WeekReadStandingLine,
  WeekReadStandingRow,
} from "../../../contracts/week-read.js";
import { markerOptimalTrusted } from "../../health/marker-public.js";
import { sinceWords } from "../../../repo/display-words.js";
import { healthFocus } from "../../../repo/health-focus.js";
import { markerGroupRank, optimalDistance, type OptimalZone } from "../../../repo/propagation-data.js";
import { prioritizeMarkers } from "../../../repo/propagation.js";
import type { TodayPath } from "../../../contracts/today-path.js";
import {
  ageWords,
  cap,
  compactRangeWords,
  combineDirections,
  joinWords,
  mostCommon,
  numberWord,
  standingLine,
  standingRow,
} from "./words.js";

/** At most this many panels on the row: act-now first, then the rest in clinical order. */
export const BLOOD_LINES_MAX = 6;

// Not blood panels: vitals (blood pressure has its own row), fitness and body composition
// (the endurance and body rows), and the catch-all.
const NOT_BLOOD = new Set(["vitals", "fitness", "body", "other"]);

/** The short name a panel is said by. */
const PANEL_LABELS: Record<string, string> = {
  iron: "Iron and red cells",
  blood: "White cells",
  metabolic: "Glucose",
  electrolytes: "Electrolytes",
  kidney: "Kidney",
  liver: "Liver",
  lipids: "Lipids",
  inflammation: "Inflammation",
  thyroid: "Thyroid",
  hormones: "Hormones",
  vitamins: "Vitamins and minerals",
  cardiac: "Heart",
  autoimmune: "Antibodies",
  infectious: "Infection screen",
  screening: "Cancer screen",
  metals: "Heavy metals",
  urinalysis: "Urine",
};

interface MarkerStatus {
  judged: boolean;
  off: boolean;
  prevDate: string | null;
  /** -1 newly outside since the previous draw, +1 back in range, 0 neither. */
  step: -1 | 0 | 1;
  direction: WeekReadStandingDirection | null;
  date: string | null;
}

function flagOf(m: any): boolean {
  return m?.latest?.flag === "low" || m?.latest?.flag === "high";
}

function statusOf(m: any): MarkerStatus {
  const trusted = markerOptimalTrusted(m);
  const flagged = flagOf(m);
  // Under a meaningful low edge with no distance the worse way is "on the low side", not a
  // marker to tighten (health-focus.ts admits it the same way).
  const lowEdgeOnly = m?.below_optimal_floor === true && !(Number(m?.distance) > 0);
  const off = flagged || (trusted && m?.in_optimal === false && !lowEdgeOnly);
  const judged = flagged || (trusted && m?.in_optimal != null);
  const fc = m?.forecast?.direction;
  const direction: WeekReadStandingDirection | null =
    fc === "improving" ? "better" : fc === "worsening" ? "worse" : fc === "stable" ? "holding" : null;
  let step: -1 | 0 | 1 = 0;
  let prevDate: string | null = null;
  const points = Array.isArray(m?.points) ? m.points : [];
  if (trusted && points.length >= 2 && m?.optimal) {
    const zone = { optimal: [Number(m.optimal.low), Number(m.optimal.high)], dir: m.optimal.dir } as OptimalZone;
    const prev = points[points.length - 2];
    const prevOff = optimalDistance(Number(prev.value), zone) > 0;
    const nowOff = m?.in_optimal === false && !lowEdgeOnly;
    prevDate = String(prev.date ?? "").slice(0, 10) || null;
    step = prevOff && !nowOff ? 1 : !prevOff && nowOff ? -1 : 0;
  }
  return { judged, off, prevDate, step, direction, date: m?.latest?.date ? String(m.latest.date).slice(0, 10) : null };
}

/** The checkup the path already read ("next draw Dec 22–26"); null with none dated. */
function nextDrawWords(path: TodayPath | null | undefined, today: string): string | null {
  const m = (path?.milestones ?? []).find((x) => x.kind === "checkup" && x.date);
  return m ? `next draw ${compactRangeWords(m.date, m.end_date ?? null, today)}` : null;
}

export function bloodRow(today: string, path?: TodayPath | null): WeekReadStandingRow | null {
  const ranked = (prioritizeMarkers().markers ?? []) as any[];
  const panels = new Map<string, { key: string; statuses: MarkerStatus[] }>();
  for (const m of ranked) {
    if (m?.source === "wearable") continue;
    const key = String(m?.group ?? "");
    if (!key || NOT_BLOOD.has(key) || !PANEL_LABELS[key]) continue;
    const s = statusOf(m);
    if (!s.judged || !s.date) continue;
    if (!panels.has(key)) panels.set(key, { key, statuses: [] });
    panels.get(key)!.statuses.push(s);
  }
  if (!panels.size) return null;

  // Act-now panels lead (the health focus's own tier), then panels with something to
  // tighten, then the rest; clinical order inside each.
  const keyOfLabel = new Map<string, string>();
  for (const m of ranked) if (m?.group && m?.group_label) keyOfLabel.set(String(m.group_label), String(m.group));
  const actNow = new Set<string>();
  try {
    for (const p of healthFocus().priorities ?? []) {
      const key = keyOfLabel.get(p.group);
      if (p.tier === "act_now" && key && panels.has(key)) actNow.add(key);
    }
  } catch {
    /* no focus: clinical order alone */
  }
  const rank = (key: string, offCount: number) => (actNow.has(key) ? 0 : offCount > 0 ? 1 : 2);
  const ordered = [...panels.values()]
    .map((p) => ({ ...p, offCount: p.statuses.filter((s) => s.off).length }))
    .sort(
      (a, b) => rank(a.key, a.offCount) - rank(b.key, b.offCount) || markerGroupRank(a.key) - markerGroupRank(b.key)
    )
    .slice(0, BLOOD_LINES_MAX);

  const prevDates: string[] = [];
  const lines: WeekReadStandingLine[] = ordered.map((p) => {
    const back = p.statuses.filter((s) => s.step === 1).length;
    const out = p.statuses.filter((s) => s.step === -1).length;
    const prev = mostCommon(p.statuses.filter((s) => s.step !== 0).map((s) => s.prevDate));
    const direction: WeekReadStandingDirection | null =
      back || out
        ? back > out
          ? "better"
          : out > back
            ? "worse"
            : "holding"
        : combineDirections(p.statuses.map((s) => s.direction));
    let move: string | null = null;
    if ((back || out) && prev) {
      prevDates.push(prev);
      const since = sinceWords(prev, today);
      move =
        back && out
          ? `${numberWord(back)} back in range, ${numberWord(out)} newly outside ${since}`
          : back
            ? `${numberWord(back)} back in range ${since}`
            : `${numberWord(out)} newly outside ${since}`;
    }
    const latest = p.statuses
      .map((s) => s.date as string)
      .sort()
      .at(-1) as string;
    return standingLine("health", {
      id: `blood:${p.key}`,
      label: PANEL_LABELS[p.key],
      now_text: p.offCount ? `${cap(numberWord(p.offCount))} to tighten` : "In range",
      direction,
      move_words: move,
      note: ageWords("drawn", latest, today),
    });
  });

  const offLines = lines.filter((l) => l.now_text !== "In range");
  const inCount = lines.length - offLines.length;
  const panelsWord = (n: number) => `${numberWord(n)} ${n === 1 ? "panel" : "panels"}`;
  let words: string;
  if (!offLines.length) {
    words =
      lines.length === 1
        ? `${lines[0].label} in range.`
        : lines.length === 2
          ? "Both panels in range."
          : `All ${panelsWord(lines.length)} in range.`;
  } else {
    const named = joinWords(offLines.map((l) => l.label.toLowerCase()));
    words = inCount
      ? `${cap(panelsWord(inCount))} in range, ${named} with markers to tighten.`
      : `${cap(named)} with markers to tighten.`;
  }
  const next = nextDrawWords(path, today);
  if (next) words += ` ${cap(next)}.`;
  const since = mostCommon(prevDates);
  return standingRow("health", {
    key: "blood",
    stone: "heart",
    label: "Blood",
    words,
    since_words: since ? sinceWords(since, today) || null : null,
    lines,
    invite: null,
    href: "/app/you/markers",
  });
}

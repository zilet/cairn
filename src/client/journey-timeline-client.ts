// @ts-check
// The road ahead: a calm, vertical editorial timeline of where the athlete is
// headed — the declared goal date, the phase projection window, scheduled lab
// re-checks and strength re-tests, a DEXA re-scan window, the program block
// boundary, and the nearest strength standards on the horizon. Reads as a plan,
// never a countdown: no percent-complete, no urgency, no score. Dated entries
// show a real date, estimates show a soft window, and undated standards sit in a
// quiet "on the horizon" tail. Pure HTML-string renderer; every value escaped.

type ForwardTimelineEntry = import("../contracts/client-api.js").ClientForwardTimelineEntry;

type JourneyTimelineDeps = {
  stagger?(index?: number | null): string;
};

function ftlRows(value: unknown): ForwardTimelineEntry[] {
  return Array.isArray(value) ? (value as ForwardTimelineEntry[]) : [];
}

function ftlText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function ftlIsDated(entry: ForwardTimelineEntry): boolean {
  return !!(entry?.when?.date || entry?.when?.window);
}

// A window renders as a compact "Aug 25 – Sep 22" band (dropping the year unless
// the two ends straddle a year boundary). Dated entries lean on the shared relAge
// helper, which already renders a future date as an absolute "Sep 14, 2026".
function ftlShort(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return ftlText(iso);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(d.getTime())) return ftlText(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ftlWindowLabel(win: { start?: unknown; end?: unknown } | null | undefined): string {
  const start = String(win?.start ?? "");
  const end = String(win?.end ?? "");
  const startYear = start.slice(0, 4);
  const endYear = end.slice(0, 4);
  const startLabel = startYear !== endYear ? `${ftlShort(start)}, ${startYear}` : ftlShort(start);
  return `${startLabel} – ${ftlShort(end)}`;
}

function ftlWhenLabel(entry: ForwardTimelineEntry): string {
  if (entry.when?.date) {
    return typeof relAge === "function" ? relAge(String(entry.when.date)) : ftlShort(entry.when.date);
  }
  if (entry.when?.window) return ftlWindowLabel(entry.when.window);
  return "";
}

function ftlMonthName(iso: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "long" });
}

// A deterministic plain-language lead: name the destination month when a goal
// date anchors the road, and count the concrete checkpoints worth planning.
function ftlLead(entries: ForwardTimelineEntry[]): string {
  if (!entries.length) return "";
  const dated = entries.filter(ftlIsDated);
  const goal = entries.find((e) => e.kind === "goal" && e.when?.date);
  const hasRescan = entries.some((e) => e.kind === "rescan");
  const checkpoints = dated.filter((e) => e.kind === "recheck" || e.kind === "retest").length;
  if (goal) {
    const month = ftlMonthName(goal.when.date);
    const cp = checkpoints > 0 ? `${checkpoints} checkpoint${checkpoints === 1 ? "" : "s"}` : "a clear path";
    const tail = hasRescan ? " and a re-scan worth planning" : " worth planning";
    return month ? `The road to ${month}: ${cp}${tail}.` : `${cp}${tail}.`;
  }
  const n = dated.length;
  if (!n) return "A few things on the horizon to train toward.";
  return `What's ahead: ${n} thing${n === 1 ? "" : "s"} worth planning around.`;
}

function ftlRowHtml(entry: ForwardTimelineEntry): string {
  const kind = ftlText(entry.kind) || "milestone";
  const when = ftlWhenLabel(entry);
  const detail = ftlText(entry.detail);
  const basis = ftlText(entry.basis);
  return `<li class="ftl-row ftl-${escAttr(kind)}">
    <span class="ftl-dot" aria-hidden="true"></span>
    <div class="ftl-main">
      ${when ? `<div class="ftl-when">${escHtml(when)}</div>` : ""}
      <div class="ftl-label">${escHtml(entry.label)}</div>
      ${detail ? `<div class="ftl-detail">${escHtml(detail)}</div>` : ""}
      ${basis ? `<div class="ftl-basis">${escHtml(basis)}</div>` : ""}
    </div>
  </li>`;
}

// A one-line "what's next" read for a compact fold summary: names the nearest
// dated checkpoint and folds in the road-ahead lead, e.g.
// "Next: DEXA re-scan window · Aug 25 – Sep 22 — The road to November: 6
// checkpoints and a re-scan worth planning." Falls back to whichever half exists;
// "" when there is nothing dated on the road. Entries arrive chronologically, so
// the first dated entry is the nearest one.
function timelineNextLabel(value: unknown): string {
  const entries = ftlRows(value);
  if (!entries.length) return "";
  const next = entries.find(ftlIsDated) || null;
  const lead = ftlLead(entries);
  const when = next ? ftlWhenLabel(next) : "";
  const nextPart = next
    ? `Next: ${ftlText(next.label)}${when ? ` · ${when}` : ""}`
    : "";
  return [nextPart, lead].filter(Boolean).join(" — ");
}

function journeyTimelineCardHtml(value: unknown, deps: JourneyTimelineDeps = {}): string {
  const entries = ftlRows(value);
  if (!entries.length) return "";
  const dated = entries.filter(ftlIsDated);
  const horizon = entries.filter((e) => !ftlIsDated(e));
  const style = typeof deps.stagger === "function" ? deps.stagger(3) : typeof stagger === "function" ? stagger(3) : "";
  const datedHtml = dated.map(ftlRowHtml).join("");
  const horizonHtml = horizon.length
    ? `<li class="ftl-horizon-head"><span class="lbl">On the horizon</span></li>${horizon.map(ftlRowHtml).join("")}`
    : "";
  return `<section class="well-accent well-accent-sage ftl-card reveal" style="${style}" aria-label="The road ahead">
    <div class="ftl-head">
      <div class="lbl">The road ahead</div>
      <h3 class="ftl-lead">${escHtml(ftlLead(entries))}</h3>
    </div>
    <ol class="ftl-list">
      <li class="ftl-today"><span class="ftl-dot ftl-dot-now" aria-hidden="true"></span><span class="ftl-today-label">Today</span></li>
      ${datedHtml}
      ${horizonHtml}
    </ol>
  </section>`;
}

const CAIRN_JOURNEY_TIMELINE = {
  timelineCardHtml: journeyTimelineCardHtml,
  nextLabel: timelineNextLabel,
};

Object.assign(globalThis, { CairnJourneyTimeline: CAIRN_JOURNEY_TIMELINE });
if (typeof window !== "undefined") Object.assign(window, { CairnJourneyTimeline: CAIRN_JOURNEY_TIMELINE });

// @ts-check
// Progress Program summary renderers: lift rows, volume rows, mesocycle, and adaptations.

type ProgramStateRead = import("../contracts/client-api.js").ClientProgramState;
type ProgramLift = ProgramStateRead["lifts"][number];
type ProgramVolumeRow = ProgramStateRead["volume"][number];
type ProgramMesocycle = ProgramStateRead["mesocycle"];

function asProgramLift(lift: ProgramLift | null | undefined): ProgramLift | null {
  return lift ?? null;
}

function liftStatusWord(lift: ProgramLift | null | undefined): string {
  const row = asProgramLift(lift);
  if (!row) return "";
  const status = row.status;
  const weeksStatic = row.weeks_static;
  if (status === "progressing") return "climbing";
  if (status === "plateaued") {
    const weeks = Number(weeksStatic);
    const label = weeksStatic != null && Number.isFinite(weeks) && weeks > 0 ? `~${weeksStatic} wk` : null;
    return label ? `stalled ${label}` : "stalled";
  }
  if (status === "regressing") return "trending down";
  if (status === "maintaining") return "holding";
  if (status === "new") return "building baseline";
  return "";
}

function liftTrendFig(lift: ProgramLift | null | undefined): string {
  const row = asProgramLift(lift);
  if (!row) return "";
  const raw = row.trend_per_wk;
  if (raw == null) return "";
  const trend = Number(raw);
  if (!Number.isFinite(trend)) return "";
  if (row.mode === "timed") {
    const seconds = Math.round(Math.abs(trend));
    return seconds === 0 ? "" : `${trend > 0 ? "+" : "−"}${seconds} sec/wk`;
  }
  const pounds = Math.abs(Math.round(trend * 10) / 10);
  return pounds === 0 ? "" : `${trend > 0 ? "+" : "−"}${pounds} lb/wk`;
}

function liftBestFig(lift: ProgramLift | null | undefined): string {
  const row = asProgramLift(lift);
  if (!row) return "";
  if (row.mode === "timed" && row.best_seconds != null) return fmtDur(row.best_seconds);
  if (row.est_1rm != null) return `${Math.round(Number(row.est_1rm))} lb`;
  return "";
}

function sortLifts(lifts: ProgramLift[] | null | undefined): ProgramLift[] {
  const rank = (lift: ProgramLift) => {
    if (lift.status === "plateaued" || lift.status === "regressing") return 0;
    if (lift.status === "progressing") return 1;
    return 2;
  };
  return Array.isArray(lifts) ? lifts.slice().sort((a, b) => rank(a) - rank(b)) : [];
}

function volBandWord(band: unknown): string {
  if (band === "low") return "below productive range";
  if (band === "productive") return "in the productive zone";
  if (band === "high") return "above ideal range";
  return band ? String(band) : "";
}

function volTrendGlyph(trend: unknown): string {
  if (trend === "rising") return " ↑";
  if (trend === "falling") return " ↓";
  return "";
}

function phaseWord(phase: unknown): string {
  if (phase === "accumulation") return "Accumulation";
  if (phase === "intensification") return "Intensification";
  if (phase === "deload-due") return "Deload due";
  if (phase === "deload") return "Deload";
  return "";
}

function liftRowHtml(lift: ProgramLift | null | undefined, index: number): string {
  const row = asProgramLift(lift);
  if (!row) return "";
  const statusWord = liftStatusWord(row);
  const trendFig = liftTrendFig(row);
  const bestFig = liftBestFig(row);
  const isBad = row.status === "plateaued" || row.status === "regressing";
  const isGood = row.status === "progressing";
  const modCls = isBad ? " prow-stalled" : isGood ? " prow-good" : "";
  const figBits = [bestFig, trendFig].filter(Boolean);
  return `<div class="prow reveal${modCls}" style="${stagger(index)}">
    <div class="prow-head">
      <button type="button" class="prow-name" data-guide="${encodeURIComponent(row.exercise)}">${escHtml(row.exercise)}</button>
      <span class="prow-status${isBad ? " prow-status-warn" : isGood ? " prow-status-ok" : ""}">${escHtml(statusWord)}</span>
    </div>
    ${figBits.length ? `<div class="prow-figs lbl">${escHtml(figBits.join(" · "))}</div>` : ""}
    ${row.why ? `<div class="prow-why">${escHtml(row.why)}</div>` : ""}
  </div>`;
}

// ---- curated program surface (Wave E2) --------------------------------------
// The flat, uncapped one-row-per-lift list was hard to read. The read now leads
// with what needs attention, summarizes what's moving, and collapses the long
// tail grouped by movement family — all lifts stay reachable, nothing is hidden.
const NEEDS_LOOK_CAP = 4;
const CLIMBING_CAP = 3;

function programLiftList(lifts: ProgramLift[] | null | undefined): ProgramLift[] {
  return Array.isArray(lifts) ? lifts.filter((lift): lift is ProgramLift => !!lift) : [];
}

// Plateaued + regressing, most urgent first: actively-declining lifts ahead of
// flat ones, then the longest-static within each.
function needsLookLifts(lifts: ProgramLift[] | null | undefined): ProgramLift[] {
  return programLiftList(lifts)
    .filter((lift) => lift.status === "plateaued" || lift.status === "regressing")
    .sort((a, b) => {
      const rank = (lift: ProgramLift) => (lift.status === "regressing" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (Number(b.weeks_static) || 0) - (Number(a.weeks_static) || 0);
    });
}

// Progressing lifts, steepest climb first (a null trend sorts last).
function climbingLifts(lifts: ProgramLift[] | null | undefined): ProgramLift[] {
  const trendOf = (lift: ProgramLift) => (lift.trend_per_wk == null ? -Infinity : Number(lift.trend_per_wk));
  return programLiftList(lifts)
    .filter((lift) => lift.status === "progressing")
    .sort((a, b) => trendOf(b) - trendOf(a));
}

// Group every lift by movement family, preserving first-seen order (the server
// returns lifts last-trained first, so families surface by recency, and variants
// within a family stay recency-ordered too).
function familyGroups(
  lifts: ProgramLift[] | null | undefined
): Array<{ key: string; label: string; lifts: ProgramLift[] }> {
  const order: string[] = [];
  const byKey = new Map<string, { key: string; label: string; lifts: ProgramLift[] }>();
  for (const lift of programLiftList(lifts)) {
    const key = String(lift.family_key || lift.exercise || "").trim() || String(lift.exercise || "");
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: String(lift.family_label || lift.exercise || ""), lifts: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.lifts.push(lift);
  }
  return order.map((key) => byKey.get(key)).filter((group): group is NonNullable<typeof group> => !!group);
}

// Last-trained recency in plain words, via the shared relAge helper when present
// (kept guarded so the pure summary module renders in isolation/tests).
function recencyLabel(iso: unknown): string {
  const value = iso == null ? "" : String(iso);
  if (!value) return "";
  return typeof relAge === "function" ? relAge(value) : value;
}

// A compact one-line climbing row (name · status · trend), tappable to the guide.
function compactLiftRowHtml(lift: ProgramLift | null | undefined, index: number): string {
  const row = asProgramLift(lift);
  if (!row) return "";
  const meta = [liftStatusWord(row), liftTrendFig(row)].filter(Boolean).join(" · ");
  return `<button type="button" class="prow-compact prow-good reveal" data-guide="${encodeURIComponent(row.exercise)}" style="${stagger(index)}">
    <span class="prow-compact-head">
      <span class="prow-name">${escHtml(row.exercise)}</span>
      ${meta ? `<span class="prow-compact-meta lbl">${escHtml(meta)}</span>` : ""}
    </span>
    ${row.why ? `<span class="prow-why">${escHtml(row.why)}</span>` : ""}
  </button>`;
}

// A quiet long-tail variant row (name · status · last-trained), tappable.
function variantRowHtml(lift: ProgramLift | null | undefined, index: number): string {
  const row = asProgramLift(lift);
  if (!row) return "";
  const meta = [liftStatusWord(row), recencyLabel(row.last_trained)].filter(Boolean).join(" · ");
  return `<button type="button" class="prow-variant reveal" data-guide="${encodeURIComponent(row.exercise)}" style="${stagger(index)}">
    <span class="prow-variant-name">${escHtml(row.exercise)}</span>
    ${meta ? `<span class="prow-variant-meta lbl">${escHtml(meta)}</span>` : ""}
  </button>`;
}

// One movement family in the collapsed long tail: a single-lift family renders as
// a plain variant row; a multi-variant family shows the family name over its rows.
function familyGroupHtml(
  group: { key: string; label: string; lifts: ProgramLift[] } | null | undefined,
  index: number
): string {
  const rows = group && Array.isArray(group.lifts) ? group.lifts : [];
  if (!rows.length) return "";
  if (rows.length === 1) return variantRowHtml(rows[0], index);
  const head = `<div class="prow-fam-head">${escHtml(group?.label || rows[0].exercise)}</div>`;
  const body = rows.map((lift, i) => variantRowHtml(lift, index + i)).join("");
  return `<div class="prow-fam reveal" style="${stagger(index)}">${head}${body}</div>`;
}

// The whole curated lifts read: Needs a look → Climbing → Everything you train.
function curatedLiftsHtml(lifts: ProgramLift[] | null | undefined, startIndex = 6): string {
  const all = programLiftList(lifts);
  if (!all.length) return "";
  let idx = startIndex;
  const sections: string[] = [];

  const needs = needsLookLifts(all);
  if (needs.length) {
    const shown = needs.slice(0, NEEDS_LOOK_CAP);
    const rest = needs.slice(NEEDS_LOOK_CAP);
    let block = `<div class="prow-section-head lbl reveal" style="${stagger(idx++)}">Needs a look</div>`;
    block += shown.map((lift) => liftRowHtml(lift, idx++)).join("");
    if (rest.length) {
      const more = rest.map((lift) => liftRowHtml(lift, idx++)).join("");
      block += `<details class="full-read prow-more-fold reveal" style="${stagger(idx++)}">
        <summary>Show ${rest.length} more to look at</summary>
        <div class="full-read-body">${more}</div>
      </details>`;
    }
    sections.push(block);
  }

  const climbing = climbingLifts(all);
  if (climbing.length) {
    const shown = climbing.slice(0, CLIMBING_CAP);
    const extra = climbing.length - shown.length;
    let block = `<div class="prow-section-head lbl reveal" style="${stagger(idx++)}">Climbing</div>`;
    block += shown.map((lift) => compactLiftRowHtml(lift, idx++)).join("");
    if (extra > 0)
      block += `<div class="prow-more lbl reveal" style="${stagger(idx++)}">${escHtml(
        `${extra} more lift${extra === 1 ? " is" : "s are"} climbing.`
      )}</div>`;
    sections.push(block);
  }

  const groups = familyGroups(all);
  if (groups.length) {
    const body = groups
      .map((group) => {
        const html = familyGroupHtml(group, idx);
        idx += Math.max(1, group.lifts.length) + 1;
        return html;
      })
      .join("");
    // When neither highlight section rendered (everything is maintaining/new),
    // open the long tail by default so the training home is never visually empty.
    const openWhenAlone = !needs.length && !climbing.length ? " open" : "";
    sections.push(`<details class="full-read prow-all-fold reveal"${openWhenAlone} style="${stagger(idx++)}">
      <summary>Everything you train (${all.length})</summary>
      <div class="full-read-body">${body}</div>
    </details>`);
  }

  return sections.join("");
}

function volumeBlockHtml(volume: ProgramVolumeRow[] | null | undefined, startIdx: number): string {
  if (!Array.isArray(volume) || !volume.length) return "";
  const rows = volume.map((value, index) => {
    const row = value;
    const bandWord = volBandWord(row.band);
    const glyph = volTrendGlyph(row.trend);
    const bandCls = row.band === "high" ? " pvol-high" : row.band === "low" ? " pvol-low" : " pvol-ok";
    return `<div class="pvol-row reveal" style="${stagger(startIdx + index)}">
      <span class="pvol-name">${escHtml(row.muscle_group)}</span>
      <span class="pvol-meta lbl"><b>${escHtml(String(row.weekly_sets))}</b> sets/wk<span class="pvol-band${bandCls}">${escHtml(`${glyph} ${bandWord}`)}</span></span>
    </div>`;
  }).join("");
  return `<div class="pvol-card">${rows}</div>`;
}

function mesoBlockHtml(meso: ProgramMesocycle | null | undefined, index: number): string {
  if (!meso) return "";
  const row = meso;
  const phase = phaseWord(row.phase);
  const bits: string[] = [];
  if (phase) bits.push(phase);
  if (row.weeks_since_deload != null) bits.push(`${row.weeks_since_deload} wk since deload`);
  return `<div class="pmeso reveal" style="${stagger(index)}">
    ${bits.length ? `<div class="pmeso-phase lbl">${escHtml(bits.join(" · "))}</div>` : ""}
    <div class="pmeso-note">${escHtml(row.note || "")}</div>
  </div>`;
}

function adaptationsHtml(adaptations: string[] | null | undefined, index: number): string {
  if (!Array.isArray(adaptations) || !adaptations.length) return "";
  const items = adaptations.map((adaptation) => `<li class="padapt-item">${escHtml(adaptation)}</li>`).join("");
  return `<div class="padapt reveal" style="${stagger(index)}">
    <div class="padapt-head lbl">What to evolve next</div>
    <ul class="padapt-list">${items}</ul>
  </div>`;
}

const CAIRN_PROGRESS_PROGRAM_SUMMARY = {
  liftStatusWord,
  liftTrendFig,
  liftBestFig,
  sortLifts,
  volBandWord,
  volTrendGlyph,
  phaseWord,
  liftRowHtml,
  needsLookLifts,
  climbingLifts,
  familyGroups,
  recencyLabel,
  compactLiftRowHtml,
  variantRowHtml,
  familyGroupHtml,
  curatedLiftsHtml,
  volumeBlockHtml,
  mesoBlockHtml,
  adaptationsHtml,
};

Object.assign(globalThis, {
  CairnProgressProgramSummary: CAIRN_PROGRESS_PROGRAM_SUMMARY,
  liftStatusWord,
  liftTrendFig,
  liftBestFig,
  sortLifts,
  volBandWord,
  volTrendGlyph,
  phaseWord,
  liftRowHtml,
  needsLookLifts,
  climbingLifts,
  familyGroups,
  recencyLabel,
  compactLiftRowHtml,
  variantRowHtml,
  familyGroupHtml,
  curatedLiftsHtml,
  volumeBlockHtml,
  mesoBlockHtml,
  adaptationsHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressProgramSummary: CAIRN_PROGRESS_PROGRAM_SUMMARY,
    liftStatusWord,
    liftTrendFig,
    liftBestFig,
    sortLifts,
    volBandWord,
    volTrendGlyph,
    phaseWord,
    liftRowHtml,
    needsLookLifts,
    climbingLifts,
    familyGroups,
    recencyLabel,
    compactLiftRowHtml,
    variantRowHtml,
    familyGroupHtml,
    curatedLiftsHtml,
    volumeBlockHtml,
    mesoBlockHtml,
    adaptationsHtml,
  });
}

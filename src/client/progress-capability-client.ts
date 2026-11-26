// @ts-check
// Progress: how strength is moving per movement and per muscle (the capability read),
// with the single lift as evidence underneath. Directional words only, never a score.

type CapabilityRead = import("../contracts/strength-capability.js").StrengthCapabilityRead;
type CapabilityUnitRow = CapabilityRead["units"][number];
type CapabilityMuscleRow = CapabilityRead["muscles"][number];

function capVerdictWord(verdict: unknown): string {
  if (verdict === "climbing" || verdict === "progressing") return "climbing";
  if (verdict === "holding") return "holding";
  if (verdict === "slipping") return "easing";
  return "too early to tell";
}

// The context a flat or easing read sits in. Said as context, never as a verdict of its
// own: "holding through the cut" only beside a unit that is in fact holding.
function capQualifierWord(qualifier: unknown, verdict?: unknown): string {
  if (qualifier === "cut") return verdict === "holding" ? "holding through the cut" : "during the cut";
  if (qualifier === "run_build") return "the legs are carrying the run build";
  if (qualifier === "recovery") return "a lighter week";
  return "";
}

// The plateau ladder's next lever for a unit, as one quiet line. "" for a unit still
// climbing, one whose hold waits (too young, explained, already moving), or no lever at all.
function capNextLine(next: CapabilityUnitRow["next"] | null | undefined): string {
  if (!next) return "";
  if (next.lever === "rep_scheme") return "Next: a higher rep range at the same weight";
  if (next.lever === "set_quality") return "Next: take the sets a little closer to failure";
  if (next.lever === "volume") return "Next: one more set";
  if (next.lever === "variation") return next.candidate ? `Next: rotate in ${next.candidate}` : "Next: a close variation";
  return "";
}

// "rear delts" -> "Rear delts": a muscle name reads as a label.
function capGroupLabel(group: unknown): string {
  const text = String(group ?? "").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function capContributorHtml(row: CapabilityUnitRow["contributors"][number]): string {
  const when = row.last_trained && typeof relAge === "function" ? relAge(row.last_trained) : row.last_trained || "";
  // A lift the read cannot judge yet says so; one it can judge needs no word here (the
  // movement's own line speaks for it).
  const early = row.direction === "not_enough" ? "too early to tell" : "";
  const meta = [when ? `last trained ${when}` : "", row.in_plan ? "on your plan" : "not on the plan now", early]
    .filter(Boolean)
    .join(" · ");
  return `<div class="pcap-contrib">
    <button type="button" class="prow-name" data-guide="${encodeURIComponent(row.exercise)}">${escHtml(row.exercise)}</button>
    <span class="pcap-contrib-meta lbl">${escHtml(meta)}</span>
  </div>`;
}

function capUnitHtml(unit: CapabilityUnitRow, index: number): string {
  const quals = (unit.qualifiers || []).map((q) => capQualifierWord(q, unit.verdict)).filter(Boolean);
  const body = (unit.contributors || []).map(capContributorHtml).join("");
  const next = unit.in_plan ? capNextLine(unit.next) : "";
  return `<details class="pcap-unit reveal" style="${stagger(index)}">
    <summary>
      <span class="pcap-unit-head"><span class="pcap-unit-name">${escHtml(unit.label)}</span><span class="pcap-word lbl">${escHtml(capVerdictWord(unit.verdict))}</span></span>
      ${unit.line ? `<span class="pcap-line">${escHtml(unit.line)}</span>` : ""}
      ${quals.length ? `<span class="pcap-qual lbl">${escHtml(quals.join(" · "))}</span>` : ""}
      ${next ? `<span class="pcap-qual pcap-next lbl">${escHtml(next)}</span>` : ""}
    </summary>
    ${body ? `<div class="pcap-contribs">${body}</div>` : ""}
  </details>`;
}

function capMuscleHtml(muscle: CapabilityMuscleRow, index: number): string {
  return `<div class="pcap-muscle reveal" style="${stagger(index)}">
    <span class="pcap-unit-head"><span class="pcap-unit-name">${escHtml(capGroupLabel(muscle.group))}</span><span class="pcap-word lbl">${escHtml(capVerdictWord(muscle.verdict))}</span></span>
    ${muscle.line ? `<span class="pcap-line">${escHtml(muscle.line)}</span>` : ""}
  </div>`;
}

// The lead of the Program read. "" when the read is unavailable: the page stays as it was.
function capabilityHtml(read: CapabilityRead | null | undefined): string {
  if (!read || read.available !== true) return "";
  const units = Array.isArray(read.units) ? read.units : [];
  const muscles = Array.isArray(read.muscles) ? read.muscles : [];
  if (!read.overall && !units.length && !muscles.length) return "";
  let idx = 3;
  const onPlan = units.filter((unit) => unit.in_plan);
  const offPlan = units.filter((unit) => !unit.in_plan);
  const hero = read.overall?.line
    ? `<div class="pcap-hero reveal" style="${stagger(idx++)}"><h2 class="prog-lifts-line">${escHtml(read.overall.line)}</h2></div>`
    : "";
  const unitsHtml = onPlan.length
    ? `<div class="prow-section-head lbl reveal" style="${stagger(idx++)}">Movements</div><div class="pcap-list">${onPlan.map((unit) => capUnitHtml(unit, idx++)).join("")}</div>`
    : "";
  const musclesHtml = muscles.length
    ? `<div class="prow-section-head lbl reveal" style="${stagger(idx++)}">Muscles</div><div class="pcap-list">${muscles.map((m) => capMuscleHtml(m, idx++)).join("")}</div>`
    : "";
  const offHtml = offPlan.length
    ? `<details class="full-read pcap-also reveal" style="${stagger(idx++)}"><summary>Also trained lately (${offPlan.length})</summary><div class="full-read-body pcap-list">${offPlan.map((unit) => capUnitHtml(unit, idx++)).join("")}</div></details>`
    : "";
  return `<div class="pcap">${hero}${unitsHtml}${musclesHtml}${offHtml}<div class="prow-section-head lbl reveal" style="${stagger(idx)}">Lift by lift</div></div>`;
}

// Fills the Program landing's capability slot. The per-lift voice line gives way to the
// read's own hero; the per-lift list stays underneath as evidence.
async function loadCapability(): Promise<void> {
  const slot = view.querySelector("#progCapSlot");
  if (!slot) return;
  let read: CapabilityRead | null = null;
  try {
    read = (await api("/strength-capability")) as CapabilityRead;
  } catch {
    read = null;
  }
  if (state.tab !== "progress" || state.progressSeg !== "program" || !slot.isConnected) return;
  const html = capabilityHtml(read);
  if (!html) return;
  slot.innerHTML = html;
  if (read?.overall?.line) view.querySelector(".prog-lifts-voice")?.remove();
  wireGuides(slot as HTMLElement);
}

const CAIRN_PROGRESS_CAPABILITY = { capVerdictWord, capQualifierWord, capNextLine, capabilityHtml, loadCapability };

Object.assign(globalThis, { CairnProgressCapability: CAIRN_PROGRESS_CAPABILITY, capabilityHtml, loadCapability });

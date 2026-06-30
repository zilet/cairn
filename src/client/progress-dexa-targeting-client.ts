// @ts-check
// Progress/Health DEXA targeting presentation helpers.

type DexaTarget = {
  informational?: unknown;
  domain?: unknown;
  moves?: unknown[];
  area?: unknown;
  signal?: unknown;
  bias?: unknown;
  path?: unknown;
};

type DexaTargeting = {
  available?: boolean;
  targets?: DexaTarget[];
  lead?: { next_dexa_focus?: unknown } | null;
  next_dexa_focus?: unknown;
};

async function loadDexaTargeting(slotId: string): Promise<void> {
  const slot = document.getElementById(slotId);
  if (!slot) return;
  let targeting: DexaTargeting | null = null;
  try {
    targeting = (await api("/dexa-targeting")) as DexaTargeting;
  } catch {
    targeting = null;
  }
  if (!slot.isConnected) return;
  slot.innerHTML = dexaTargetingHtml(targeting) || "";
}

function dexaTargetToneCls(target: DexaTarget): string {
  if (target.informational) return "pdexa-info";
  if (target.domain === "nutrition") return "pdexa-nut";
  return "pdexa-train";
}

function dexaTargetHtml(target: DexaTarget): string {
  const moves = Array.isArray(target.moves) ? target.moves.filter(Boolean) : [];
  return `<div class="pdexa-target ${dexaTargetToneCls(target)}">
      <div class="pdexa-target-head">
        <span class="pdexa-area">${escHtml(target.area || "")}</span>
        ${target.informational ? `<span class="pdexa-tag lbl">worth discussing with your clinician</span>` : ""}
      </div>
      ${target.signal ? `<div class="pdexa-signal">${escHtml(target.signal)}</div>` : ""}
      ${target.bias ? `<div class="pdexa-bias">${escHtml(target.bias)}</div>` : ""}
      ${moves.length ? `<div class="pdexa-moves">${moves.map((move) => `<span class="pdexa-move">${escHtml(move)}</span>`).join("")}</div>` : ""}
      ${target.path ? `<div class="pdexa-path"><span class="lbl">Path to your next scan</span>${escHtml(target.path)}</div>` : ""}
    </div>`;
}

function dexaTargetingHtml(targeting: DexaTargeting | null | undefined): string {
  if (!targeting || targeting.available === false || !Array.isArray(targeting.targets) || !targeting.targets.length) return "";
  const heading = targeting.lead?.next_dexa_focus || targeting.next_dexa_focus || "From your DEXA — what to focus on next";
  return `<div class="pdexa-card">
      <div class="pdexa-card-head">
        <span class="lbl">From your DEXA</span>
        <div class="pdexa-focus">${escHtml(heading)}</div>
      </div>
      <div class="pdexa-targets">${targeting.targets.map(dexaTargetHtml).join("")}</div>
    </div>`;
}

const CAIRN_PROGRESS_DEXA_TARGETING = {
  loadDexaTargeting,
  dexaTargetToneCls,
  dexaTargetHtml,
  dexaTargetingHtml,
};

Object.assign(globalThis, {
  CairnProgressDexaTargeting: CAIRN_PROGRESS_DEXA_TARGETING,
  loadDexaTargeting,
  dexaTargetToneCls,
  dexaTargetHtml,
  dexaTargetingHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressDexaTargeting: CAIRN_PROGRESS_DEXA_TARGETING,
    loadDexaTargeting,
    dexaTargetToneCls,
    dexaTargetHtml,
    dexaTargetingHtml,
  });
}

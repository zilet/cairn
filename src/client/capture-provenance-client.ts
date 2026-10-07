// @ts-check
// Connected-brain provenance lines for Today and Meals.

let _provCache: { at: number; rows: CaptureDirective[] } | null = null;

async function activeDirectives(): Promise<CaptureDirective[]> {
  if (_provCache && Date.now() - _provCache.at < 4000) return _provCache.rows;
  let rows: CaptureDirective[] = [];
  try {
    const res = await api("/directives");
    rows = (res && Array.isArray(res.directives) ? res.directives : []).filter(
      (directive): directive is CaptureDirective => !directive.status || directive.status === "active",
    );
  } catch {
    rows = [];
  }
  _provCache = { at: Date.now(), rows };
  return rows;
}

function provenanceLineHtml(directive: CaptureDirective | null | undefined, label: string): string | null {
  if (!directive) return null;
  const consequence = String(directive.directive || "").trim();
  if (!consequence) return null;
  const soft = directive.uncertain && !directive.citation;
  const because = directive.marker ? `<span class="prov-marker">${escHtml(String(directive.marker))}</span>` : "";
  const lead = soft ? `<span class="prov-soft">Worth looking into · </span>` : "";
  return `<button class="prov-line" data-prov aria-label="${escAttr(label + ": " + consequence)}">
      <span class="prov-glyph" aria-hidden="true">✦</span>
      <span class="prov-text">${lead}${escHtml(consequence)}${because ? ` — ${because}` : ""}</span>
      <span class="prov-why" aria-hidden="true">why</span>
    </button>`;
}

function wireProvenance(scope?: ParentNode | null): void {
  // "Why is my plan doing this" → the directive behind it, managed in place on
  // Stand → Connections (the connected-brain home).
  (scope || view).querySelectorAll<HTMLElement>("[data-prov]").forEach((button) => button.addEventListener("click", () => {
    state.standSeg = "connections";
    activateTab("stand");
  }));
}

// A watch's overnight readings (HRV, resting HR) are Body & recovery's to say — read
// against last night and the athlete's own band. A directive judged on the week's
// average beside them would be a second, contradicting read of the same signal.
const PROV_RECOVERY_SIGNAL = /^(hrv|heart rate variability|resting hr|resting heart rate|rhr)$/i;

/** What shaped the training, named for its source: a watch reading is not a lab. */
function trainingProvenanceLabel(directive: CaptureDirective): string {
  const marker = String(directive.marker || "").trim();
  return /^vo2 ?max$/i.test(marker) ? `Training shaped by your ${marker}` : "Training shaped by your labs";
}

async function loadTrainingProvenance(_isToday?: boolean): Promise<void> {
  const slot = view.querySelector("#briefProvenance");
  if (!slot) return;
  const rows = (await activeDirectives()).filter((row) => !PROV_RECOVERY_SIGNAL.test(String(row.marker || "").trim()));
  if (state.tab !== "today" || !slot.isConnected) return;
  const directive = rows.find((row) => (row.domain || "watch") === "training" && !row.stale)
    || rows.find((row) => (row.domain || "watch") === "watch" && !row.stale);
  const html = directive ? provenanceLineHtml(directive, trainingProvenanceLabel(directive)) : null;
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
  wireProvenance(slot);
}

async function loadMealProvenance(): Promise<void> {
  const slot = view.querySelector("#mealProvenance");
  if (!slot) return;
  const rows = await activeDirectives();
  if (state.tab !== "plan" || !slot.isConnected) return;
  const directive = rows.find((row) => (row.domain || "watch") === "nutrition" && !row.stale);
  const html = provenanceLineHtml(directive, "Meals shaped by your labs");
  if (!html) { slot.innerHTML = ""; return; }
  slot.innerHTML = html;
  wireProvenance(slot);
}

const CAIRN_CAPTURE_PROVENANCE = {
  activeDirectives,
  provenanceLineHtml,
  trainingProvenanceLabel,
  wireProvenance,
  loadTrainingProvenance,
  loadMealProvenance,
};

Object.assign(globalThis, {
  CairnCaptureProvenance: CAIRN_CAPTURE_PROVENANCE,
  provenanceLineHtml,
  loadTrainingProvenance,
  loadMealProvenance,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnCaptureProvenance: CAIRN_CAPTURE_PROVENANCE,
    provenanceLineHtml,
    loadTrainingProvenance,
    loadMealProvenance,
  });
}

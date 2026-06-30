// @ts-check
// Progress program-adjustments digest presentation helpers.

type ProgramAdjustment = {
  kind?: unknown;
  title?: unknown;
  why?: unknown;
};

type AdjustmentMeta = {
  glyph: string;
  cls: string;
};

const PROGRAM_ADJUSTMENT_KIND: Record<string, AdjustmentMeta> = {
  progression: { glyph: "↑", cls: "padj-prog" },
  balance: { glyph: "◆", cls: "padj-bal" },
  deload: { glyph: "↓", cls: "padj-deload" },
  gap: { glyph: "○", cls: "padj-gap" },
  cardio: { glyph: "↗", cls: "padj-cardio" },
  dexa: { glyph: "◇", cls: "padj-dexa" },
  test: { glyph: "✦", cls: "padj-test" },
};

async function loadProgramAdjustments(): Promise<void> {
  const slot = view.querySelector("#progAdjustSlot");
  if (!slot) return;
  let rows: unknown = null;
  try {
    rows = await api("/program/adjustments");
  } catch {
    rows = null;
  }
  if (state.tab !== "progress" || state.progressSeg !== "program" || !slot.isConnected) return;
  const html = programAdjustmentsHtml(rows);
  if (!html) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = html;
}

function programAdjustmentsHtml(rows: unknown): string {
  if (!Array.isArray(rows) || !rows.length) return "";
  const items = rows
    .slice(0, 6)
    .map((row) => {
      const adjustment = (row && typeof row === "object" ? row : {}) as ProgramAdjustment;
      const kind = typeof adjustment.kind === "string" ? adjustment.kind : "";
      const meta = PROGRAM_ADJUSTMENT_KIND[kind] || PROGRAM_ADJUSTMENT_KIND.gap;
      return `<div class="padj-item ${meta.cls}">
        <span class="padj-glyph" aria-hidden="true">${meta.glyph}</span>
        <div class="padj-body">
          <div class="padj-title">${escHtml(adjustment.title || "")}</div>
          ${adjustment.why ? `<div class="padj-why">${escHtml(adjustment.why)}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");
  return `<div class="padj-card">
      <div class="padj-card-head lbl">What changed &amp; why</div>
      ${items}
    </div>`;
}

const CAIRN_PROGRESS_PROGRAM_ADJUSTMENTS = {
  PADJ_KIND: PROGRAM_ADJUSTMENT_KIND,
  loadProgramAdjustments,
  programAdjustmentsHtml,
};

Object.assign(globalThis, {
  CairnProgressProgramAdjustments: CAIRN_PROGRESS_PROGRAM_ADJUSTMENTS,
  PADJ_KIND: PROGRAM_ADJUSTMENT_KIND,
  loadProgramAdjustments,
  programAdjustmentsHtml,
});

if (typeof window !== "undefined") {
  Object.assign(window, {
    CairnProgressProgramAdjustments: CAIRN_PROGRESS_PROGRAM_ADJUSTMENTS,
    PADJ_KIND: PROGRAM_ADJUSTMENT_KIND,
    loadProgramAdjustments,
    programAdjustmentsHtml,
  });
}

// Shared Health directive loader/wiring. Pure directive markup lives in
// health-directives-client.ts; this module owns the execution path.
type DirectiveLoaderRow = Record<string, unknown>;
type DirectiveLoaderDirective = import("../contracts/client-api.js").ClientDirective;
type DirectiveLoaderEvidenceRow = import("../contracts/client-api.js").ClientEvidenceRow;
type DirectiveLoaderEvidenceSummary = {
  research_enabled?: unknown;
  by_marker?: Array<{ marker?: unknown; count?: unknown }>;
} | null | undefined;

function directiveLoaderRecord(value: unknown): DirectiveLoaderRow {
  return value && typeof value === "object" ? value as DirectiveLoaderRow : {};
}

function directiveLoaderRows<T extends DirectiveLoaderRow = DirectiveLoaderRow>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") as T[] : [];
}

function directiveLoaderEvidenceRows(value: unknown): DirectiveLoaderEvidenceRow[] {
  return directiveLoaderRows<DirectiveLoaderEvidenceRow>(directiveLoaderRecord(value).evidence);
}

async function directiveLoaderToggleEvidence(btn: HTMLElement): Promise<void> {
  const box = btn.nextElementSibling as HTMLElement | null;
  if (!box || !box.classList.contains("hb-evbox")) return;
  if (!btn.dataset.openLabel) btn.dataset.openLabel = btn.innerHTML;
  const opening = box.hidden;
  if (!opening) {
    box.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = btn.dataset.openLabel;
    return;
  }
  btn.setAttribute("aria-expanded", "true");
  btn.textContent = "hide the evidence";
  box.hidden = false;
  if (box.dataset.loaded === "1") {
    box.classList.remove("chip-in");
    void box.offsetWidth;
    box.classList.add("chip-in");
    return;
  }
  box.innerHTML = `<div class="hb-ev-loading lbl"><span class="aspin aspin-xs"></span> reading the source…</div>`;
  let res: unknown = null;
  try { res = await api(`/evidence?marker=${encodeURIComponent(btn.dataset.evidence || "")}`); } catch { res = null; }
  if (box.hidden) return;
  box.dataset.loaded = "1";
  box.innerHTML = CairnHealthClient.evidenceListHtml(directiveLoaderEvidenceRows(res));
  if (!reducedMotion()) {
    box.classList.remove("chip-in");
    void box.offsetWidth;
    box.classList.add("chip-in");
  }
}

function directiveLoaderPaint(wrap: Element, active: DirectiveLoaderDirective[], evSummary: DirectiveLoaderEvidenceSummary): void {
  wrap.innerHTML = CairnHealthDirectives.directivesSectionHtml(active, evSummary);
  $("#hbDerive")?.addEventListener("click", directiveLoaderDerive);
  $("#hbResearchNudge")?.addEventListener("click", () => switchTab("settings"));
  wrap.querySelectorAll<HTMLElement>("[data-ddone]").forEach((b) =>
    b.addEventListener("click", () => directiveLoaderResolve(b.dataset.ddone || "", "resolved"))
  );
  wrap.querySelectorAll<HTMLElement>("[data-ddismiss]").forEach((b) =>
    b.addEventListener("click", () => directiveLoaderResolve(b.dataset.ddismiss || "", "dismissed"))
  );
  wrap.querySelectorAll<HTMLElement>("[data-evidence]").forEach((b) =>
    b.addEventListener("click", () => { void directiveLoaderToggleEvidence(b); })
  );
}

async function directiveLoaderLoad(token: number): Promise<void> {
  const wrap = $<HTMLElement>("#hbDirectives");
  if (!wrap || !wrap.isConnected) return;
  let res: unknown = null, evSummary: DirectiveLoaderEvidenceSummary = null;
  try {
    [res, evSummary] = await Promise.all([
      api("/directives"),
      api("/evidence/summary").then((summary) => summary as DirectiveLoaderEvidenceSummary).catch(() => null),
    ]);
  } catch { res = null; }
  if (token !== pollToken || !wrap.isConnected) return;
  const all = directiveLoaderRows<DirectiveLoaderDirective>(directiveLoaderRecord(res).directives);
  const active = all.filter((d) => !d.status || d.status === "active");
  directiveLoaderPaint(wrap, active, evSummary);
}

async function directiveLoaderResolve(id: string, status: "resolved" | "dismissed"): Promise<void> {
  if (!id) return;
  const card = $(`#hbDirectives .hb-directive[data-dir="${id}"]`);
  let res: unknown = null;
  try {
    res = await api(`/directives/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
  } catch { res = null; }
  if (!directiveLoaderRecord(res).ok) { toast("Couldn't update"); return; }
  toast(status === "resolved" ? "Marked done" : "Dismissed");
  const after = () => { void directiveLoaderLoad(pollToken); };
  if (card) collapseEl(card, after); else after();
}

async function directiveLoaderDerive(): Promise<void> {
  const btn = $("#hbDerive");
  const restore = btnBusy(btn, "refreshing…");
  let res: unknown = null;
  try { res = await api("/directives/derive", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { res = null; }
  const row = directiveLoaderRecord(res);
  if (!row.ok) { toast("Couldn't refresh"); restore(); return; }
  toast(row.derived ? `Refreshed — ${row.derived} found` : "Up to date");
  void directiveLoaderLoad(pollToken);
}

const CAIRN_HEALTH_DIRECTIVE_LOADER = {
  load: directiveLoaderLoad,
};

Object.assign(globalThis, { CairnHealthDirectiveLoader: CAIRN_HEALTH_DIRECTIVE_LOADER });

if (typeof window !== "undefined") {
  window.CairnHealthDirectiveLoader = CAIRN_HEALTH_DIRECTIVE_LOADER;
}

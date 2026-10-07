// Health Share controller: the doctor packet, portable export, marker-alias hygiene,
// and the no-marker route back to Records.
//
// On Stand → "Share with your doctor" the packet is composed into the records slot
// (`CairnRecordsSlot`, registered below as "packet"): the packet-builder component
// (section toggles + live preview) with the visit-questions editor in its sub-slot.
// Sharing uses what the athlete chose — "Open the packet" and "Download as text" carry
// the builder's `?sections=` and the edited `?questions=` — and the informational,
// not-medical-advice line is part of the builder in every state. `render(deps)` then
// paints only the portable export and data hygiene below it. Without a packet slot in
// the view (the older Me → Health tab) `render` keeps the one-button report card.
{
type HealthShareRecord = Record<string, unknown>;
type HealthShareControllerResponse = {
  markers?: HealthShareRecord[];
  groups?: HealthShareRecord[];
};

function healthShareRecord(value: unknown): HealthShareRecord {
  return value && typeof value === "object" ? value as HealthShareRecord : {};
}

function healthShareRows<T extends HealthShareRecord = HealthShareRecord>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") as T[] : [];
}

function healthShareSelect<T extends Element = Element>(deps: ClientHealthShareControllerDeps, selector: string): T | null {
  return deps.root.querySelector<T>(selector) || deps.select<T>(selector);
}

// The report opens in a new tab and the downloads leave the app, so each carries a
// short-lived signed link (api-core.ts openResourceLink): an installed iOS app hands
// them to Safari, which does not share this app's sign-in.
function openShareLink(deps: ClientHealthShareControllerDeps, path: string, mode: "tab" | "download"): void {
  void (deps.openResourceLink || openResourceLink)(path, mode);
}

function openReportUrl(deps: ClientHealthShareControllerDeps, path: string): void {
  openShareLink(deps, path, "tab");
}

function openDoctorReportTab(deps: ClientHealthShareControllerDeps): void {
  openReportUrl(deps, "/api/health-report");
}

// The packet's two hand-overs, each carrying the builder's current query.
function sharePacket(deps: ClientHealthShareControllerDeps, kind: ClientPacketShareKind, query: string): void {
  if (kind === "open") {
    openReportUrl(deps, `/api/health-report${query}`);
    return;
  }
  openShareLink(deps, `/api/health-report.txt${query}`, "download");
  deps.toast("Packet downloaded as text");
}

// The "packet" records slot: packet-builder, with visit-questions mounted into its
// sub-slot. Returns the builder's teardown (which also tears the questions down).
function mountHealthPacket(host: Element, deps: ClientRecordsPacketDeps): () => void {
  return CairnPacketBuilderController.mount(host, {
    api: deps.api,
    cachedApi: deps.cachedApi,
    peekCached: deps.peekCached,
    onShare: (kind, query) => sharePacket(deps, kind, query),
    onAdd: () => deps.switchHealthSeg("records", { openPicker: true }),
    mountQuestions: (slot, onChange) =>
      CairnVisitQuestionsController.mount(slot, { cachedApi: deps.cachedApi, peekCached: deps.peekCached, onChange }),
  });
}

function hasPacketSlot(deps: ClientHealthShareControllerDeps): boolean {
  return !!deps.root.querySelector('[data-slot="packet"]');
}

function wireHealthShareActions(deps: ClientHealthShareControllerDeps): void {
  healthShareSelect(deps, "#hReportBtn")?.addEventListener("click", () => openDoctorReportTab(deps));
  healthShareSelect(deps, "#hExportBtn")?.addEventListener("click", () => {
    openShareLink(deps, "/api/health-export", "download");
    deps.toast("Structured data downloaded");
  });
  healthShareSelect(deps, "#hAlignBtn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget instanceof Element ? e.currentTarget : null;
    const restore = deps.btnBusy(btn, "aligning…");
    let result: unknown = null;
    try {
      result = await deps.api("/markers/reconcile", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {
      result = null;
    }
    restore();
    const out = healthShareRecord(result);
    const aligned = Number(out.aligned) || 0;
    if (!out || out.ok === false) {
      deps.toast("Couldn't align right now — try again in a bit.");
      return;
    }
    deps.toast(aligned ? `Merged ${aligned} duplicate marker${aligned === 1 ? "" : "s"}` : "Already aligned");
    if (aligned) deps.swrInvalidate("markers:priority");
  });
}

function paintHealthShareEmpty(content: HTMLElement, deps: ClientHealthShareControllerDeps): void {
  content.innerHTML = `<div class="empty-state reveal" style="${deps.stagger(0)}">
    <div class="empty-state-line">Nothing to share yet</div>
    <div class="hpic-hero-sub">Add a lab report or DEXA scan first. The report will stay grouped by clinical panel once markers exist.</div>
    <button id="hShareToRecords" class="logbtn hpic-cta-btn">ADD A DOCUMENT</button>
  </div>`;
  healthShareSelect(deps, "#hShareToRecords")?.addEventListener("click", () => deps.switchHealthSeg("records", { openPicker: true }));
}

function healthShareExtrasHtml(deps: ClientHealthShareControllerDeps, from: number): string {
  return `<div class="hshare-grid">
      <section class="hshare-card reveal" style="${deps.stagger(from)}">
        <div class="lbl hshare-kicker">Portable data</div>
        <h3 class="hshare-subtitle">Structured health export</h3>
        <p class="hshare-copy">A JSON snapshot for another tool: marker observations, history, supplements, and active connected-brain directives.</p>
        <button id="hExportBtn" class="ghostbtn">Download JSON</button>
      </section>
      <section class="hshare-card reveal" style="${deps.stagger(from + 1)}">
        <div class="lbl hshare-kicker">Data hygiene</div>
        <h3 class="hshare-subtitle">Align lab names</h3>
        <p class="hshare-copy">Merge obvious duplicate marker names from different labs so each trend stays one line.</p>
        <button id="hAlignBtn" class="ghostbtn">Align lab names</button>
      </section>
    </div>`;
}

function paintHealthShareReady(content: HTMLElement, response: HealthShareControllerResponse, deps: ClientHealthShareControllerDeps): void {
  if (hasPacketSlot(deps)) {
    // The packet builder above holds the report; this view keeps the other two tools.
    content.innerHTML = `<div class="hshare">${healthShareExtrasHtml(deps, 0)}</div>`;
    wireHealthShareActions(deps);
    return;
  }
  const markers = healthShareRows(response.markers);
  const groups = healthShareRows(response.groups);
  const count = markers.length;
  content.innerHTML = `<div class="hshare">
    <section class="hshare-card hshare-card-main reveal" style="${deps.stagger(0)}">
      <div>
        <div class="lbl hshare-kicker">For your doctor</div>
        <h2 class="hshare-title">Clinical marker report</h2>
        <p class="hshare-copy">Grouped by clinical panel, with findings first, dated history, DEXA body composition when available, and a MyChart-ready copy view.</p>
        <div class="hshare-meta">${count} marker${count === 1 ? "" : "s"} · ${groups.length || 1} panel${(groups.length || 1) === 1 ? "" : "s"}</div>
      </div>
      <div class="hshare-actions">
        <button id="hReportBtn" class="logbtn">Open doctor report</button>
      </div>
    </section>
    ${healthShareExtrasHtml(deps, 1)}
  </div>`;
  wireHealthShareActions(deps);
}

function paintHealthShareResponse(content: HTMLElement, response: unknown, deps: ClientHealthShareControllerDeps): void {
  const data = healthShareRecord(response) as HealthShareControllerResponse;
  if (!healthShareRows(data.markers).length) {
    // With the packet slot present, its builder shows the one empty state.
    if (hasPacketSlot(deps)) content.innerHTML = "";
    else paintHealthShareEmpty(content, deps);
    return;
  }
  paintHealthShareReady(content, data, deps);
}

function renderHealthShare(deps: ClientHealthShareControllerDeps): void {
  const content = healthShareSelect<HTMLElement>(deps, "#hContent");
  if (!content) return;
  const peek = deps.peekCached("markers:priority");
  if (peek) {
    paintHealthShareResponse(content, peek.data, deps);
  } else {
    content.innerHTML = `<div class="hshare">${skelLines(4)}</div>`;
  }
  void deps.cachedApi("/markers/priority", {
    key: "markers:priority",
    onUpgrade: (data, { changed }) => {
      if (changed || !peek) paintHealthShareResponse(content, data, deps);
    },
  }).catch(() => {
    if (!peek) paintHealthShareResponse(content, null, deps);
  });
}

const CAIRN_HEALTH_SHARE_CONTROLLER = {
  render: renderHealthShare,
  mountPacket: mountHealthPacket,
};

// Register at load: records-slot.js sits ahead of this module in the me-health bundle.
if (typeof CairnRecordsSlot !== "undefined") CairnRecordsSlot.register("packet", mountHealthPacket);

Object.assign(globalThis, { CairnHealthShareController: CAIRN_HEALTH_SHARE_CONTROLLER });

if (typeof window !== "undefined") {
  window.CairnHealthShareController = CAIRN_HEALTH_SHARE_CONTROLLER;
}
}

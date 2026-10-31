// @ts-check
// Records › "Check for duplicates": a calm, user-initiated look for records filed
// more than once (the same draw arriving as a PDF and a zip, a re-export, the same
// scan pasted twice). The check is a durable agent job (`health_dedupe_check`,
// POST /api/health-docs/dedupe {judge:true}) whose result is the server's dry-run
// plan; nothing changes until the person taps "Merge these", which posts
// {apply:true, clusters} — the clusters on screen, so the server folds exactly those
// or nothing ({ok:false, changed:true} when the records moved since the check). The
// server writes every `reason` and `removes_note`; this module prints them verbatim
// (escaped) and never grades.
//
// Lives in the lazy me-health bundle, mounted by the Records controller into the
// `#hDedupe` slot that CairnHealthRecords.recordsTabHtml lays down.

type RecordsDedupeDoc = {
  id?: unknown;
  kind?: unknown;
  doc_date?: unknown;
  label?: unknown;
};

type RecordsDedupeSuperseded = { name?: unknown };

type RecordsDedupeCluster = {
  date?: unknown;
  survivor?: RecordsDedupeDoc | null;
  merged?: RecordsDedupeDoc[] | null;
  rule?: unknown;
  reason?: unknown;
  removes_note?: unknown;
  removes?: RecordsDedupeDoc[] | null;
  superseded?: RecordsDedupeSuperseded[] | null;
};

type RecordsDedupePlan = {
  ok?: unknown;
  dry_run?: unknown;
  merged?: unknown;
  clusters?: RecordsDedupeCluster[] | null;
  judgement?: { skipped?: unknown } | null;
};

(() => {
  const SLOT = "#hDedupe";
  const CARD = "#hDedupeCard";
  const PATH = "/health-docs/dedupe";
  const JOB_KIND = "health_dedupe_check";

  // The last mount's deps, so a reconnected job (after a reload) paints with them.
  let mounted: ClientRecordsDedupeDeps | null = null;
  // The plan on screen: "Merge these" applies only while one is showing.
  let shownPlan: RecordsDedupePlan | null = null;

  function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  function rows<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value.filter((row) => row && typeof row === "object") as T[]) : [];
  }

  function dateText(value: unknown): string {
    const iso = typeof value === "string" ? value.slice(0, 10) : "";
    if (!iso) return "";
    return typeof absDate === "function" ? absDate(iso) : iso;
  }

  function kindText(kind: unknown): string {
    if (typeof CairnHealthDocs !== "undefined" && typeof CairnHealthDocs.healthKindLabel === "function") {
      return CairnHealthDocs.healthKindLabel(kind);
    }
    return String(kind || "Record");
  }

  // A record named the way the person filed it, else its kind and date.
  function docText(doc: RecordsDedupeDoc | null | undefined): string {
    const row = doc || {};
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (label) return label;
    const date = dateText(row.doc_date);
    return date ? `${kindText(row.kind)} · ${date}` : kindText(row.kind);
  }

  function andList(items: string[]): string {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }

  function controlHtml(): string {
    return `<div class="hdedupe-bar">
      <button type="button" class="ghostbtn hdedupe-check" data-hdedupe-check>Check for duplicates</button>
    </div>
    <div class="hdedupe-panel" data-hdedupe-panel></div>`;
  }

  function runningHtml(): string {
    return `<div class="hdedupe-card" id="hDedupeCard">${CairnUi.jobCaptionHtml({
      tag: "div",
      className: "job-cap hdedupe-cap",
      text: "Looking through your records…",
    })}</div>`;
  }

  function noAgentLineHtml(plan: RecordsDedupePlan): string {
    return record(plan.judgement).skipped === "no_agent"
      ? `<p class="hdedupe-note">Scans that might be the same study weren't compared — that needs a connected AI.</p>`
      : "";
  }

  function clusterHtml(cluster: RecordsDedupeCluster): string {
    const merged = rows<RecordsDedupeDoc>(cluster.merged).map(docText);
    const survivor = docText(cluster.survivor);
    const date = dateText(cluster.date);
    const reason = typeof cluster.reason === "string" ? cluster.reason.trim() : "";
    const names = [
      ...new Set(
        rows<RecordsDedupeSuperseded>(cluster.superseded)
          .map((row) => (typeof row.name === "string" ? row.name.trim() : ""))
          .filter(Boolean)
      ),
    ];
    const kept = names.length
      ? `<p class="hdedupe-kept">Keeps the later export's reading for ${escHtml(andList(names))}.</p>`
      : "";
    const removesNote = typeof cluster.removes_note === "string" ? cluster.removes_note.trim() : "";
    const removes = removesNote ? `<p class="hdedupe-kept">${escHtml(removesNote)}</p>` : "";
    return `<li class="hdedupe-row">
      ${date ? `<span class="hdedupe-date">${escHtml(date)}</span>` : ""}
      <p class="hdedupe-fold"><span class="hdedupe-doc">${escHtml(andList(merged))}</span> folds into <span class="hdedupe-doc">${escHtml(survivor)}</span></p>
      ${reason ? `<p class="hdedupe-reason">${escHtml(reason)}</p>` : ""}
      ${kept}
      ${removes}
    </li>`;
  }

  function planHtml(planInput: unknown): string {
    const plan = record(planInput) as RecordsDedupePlan;
    const clusters = rows<RecordsDedupeCluster>(plan.clusters);
    if (!clusters.length) {
      return `<div class="hdedupe-card" id="hDedupeCard" role="status">
        <p class="hdedupe-lead">No duplicates — every record is filed once.</p>
        ${noAgentLineHtml(plan)}
      </div>`;
    }
    const extra = clusters.reduce((sum, cluster) => sum + rows(cluster.merged).length, 0);
    const lead =
      extra === 1 ? "One record looks filed twice." : `${extra} records look like copies of ones already here.`;
    return `<div class="hdedupe-card" id="hDedupeCard" role="status">
      <p class="hdedupe-lead">${escHtml(lead)}</p>
      <ul class="hdedupe-list">${clusters.map(clusterHtml).join("")}</ul>
      ${noAgentLineHtml(plan)}
      <div class="hdedupe-actions">
        <button type="button" class="pillbtn pill-accent hdedupe-apply" data-hdedupe-apply>Merge these</button>
        <button type="button" class="ghostbtn hdedupe-dismiss" data-hdedupe-dismiss>Not now</button>
      </div>
    </div>`;
  }

  function mergedHtml(resultInput: unknown): string {
    const n = Number(record(resultInput).merged) || 0;
    const line =
      n > 0 ? `Merged ${n} ${n === 1 ? "record" : "records"}.` : "Nothing needed merging — every record is filed once.";
    return `<div class="hdedupe-card" id="hDedupeCard" role="status"><p class="hdedupe-lead">${escHtml(line)}</p></div>`;
  }

  function failHtml(message = "Couldn't check your records just now — they're unchanged."): string {
    return `<div class="hdedupe-card" id="hDedupeCard" role="status"><p class="hdedupe-note">${escHtml(message)}</p></div>`;
  }

  function slot(): HTMLElement | null {
    return document.querySelector<HTMLElement>(SLOT);
  }

  function panel(): HTMLElement | null {
    return slot()?.querySelector<HTMLElement>("[data-hdedupe-panel]") ?? null;
  }

  function checkButton(): HTMLButtonElement | null {
    return slot()?.querySelector<HTMLButtonElement>("[data-hdedupe-check]") ?? null;
  }

  function setChecking(on: boolean): void {
    const btn = checkButton();
    if (btn) btn.disabled = on;
  }

  function isFailedPlan(result: unknown): boolean {
    const row = record(result);
    return !result || row.ok === false || !Array.isArray(row.clusters);
  }

  function paintPlan(result: unknown, deps: ClientRecordsDedupeDeps): void {
    setChecking(false);
    const host = panel();
    if (!host) return;
    shownPlan = record(result) as RecordsDedupePlan;
    host.innerHTML = planHtml(shownPlan);
    wirePlan(host, deps);
  }

  function paintFail(message?: string): void {
    setChecking(false);
    shownPlan = null;
    const host = panel();
    if (host) host.innerHTML = failHtml(message);
  }

  function wirePlan(host: HTMLElement, deps: ClientRecordsDedupeDeps): void {
    host.querySelector("[data-hdedupe-dismiss]")?.addEventListener("click", () => {
      shownPlan = null;
      host.innerHTML = "";
    });
    const apply = host.querySelector<HTMLButtonElement>("[data-hdedupe-apply]");
    apply?.addEventListener("click", () => {
      void applyPlan(apply, deps);
    });
  }

  // The clusters on screen, as the server needs them to fold exactly those.
  function plannedClusters(
    plan: RecordsDedupePlan
  ): Array<{ survivor: number; merged: number[]; rule: string; removes: number[] }> {
    return rows<RecordsDedupeCluster>(plan.clusters).map((cluster) => ({
      survivor: Number(record(cluster.survivor).id),
      merged: rows<RecordsDedupeDoc>(cluster.merged).map((doc) => Number(doc.id)),
      rule: String(cluster.rule ?? ""),
      // the uploads the plan said it deletes: the server folds only if that still holds
      removes: rows<RecordsDedupeDoc>(cluster.removes).map((doc) => Number(doc.id)),
    }));
  }

  const CHANGED_TEXT = "Your records changed since the check — check again to see what's there now.";

  async function applyPlan(btn: HTMLButtonElement, deps: ClientRecordsDedupeDeps): Promise<void> {
    if (!shownPlan) return;
    const restore = typeof btnBusy === "function" ? btnBusy(btn, "Merging…") : () => {};
    let result: unknown = null;
    try {
      result = await deps.api(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true, clusters: plannedClusters(shownPlan) }),
      });
    } catch {
      result = null;
    }
    restore();
    const host = panel();
    const row = record(result);
    if (row.ok === false && row.changed === true) {
      if (host) host.innerHTML = failHtml(CHANGED_TEXT);
      shownPlan = null;
      return;
    }
    if (!result || row.ok === false) {
      if (host) host.innerHTML = failHtml("Couldn't merge them just now — your records are unchanged.");
      shownPlan = null;
      return;
    }
    shownPlan = null;
    if (host) host.innerHTML = mergedHtml(row);
    const n = Number(row.merged) || 0;
    if (n > 0) deps.onMerged(row, n);
  }

  function opHandlers(deps: ClientRecordsDedupeDeps): ClientAgentOpHandlers {
    return {
      path: PATH,
      anchor: CARD,
      caption: JOB_KIND,
      guard: () => !slot()?.isConnected,
      isFail: isFailedPlan,
      render: (result: unknown) => paintPlan(result, deps),
      onFail: () => paintFail(),
    };
  }

  async function check(deps: ClientRecordsDedupeDeps): Promise<void> {
    const host = panel();
    if (!host) return;
    shownPlan = null;
    setChecking(true);
    host.innerHTML = runningHtml();
    await deps.runOp(JOB_KIND, { judge: true }, opHandlers(deps));
  }

  function mount(host: Element | null, deps: ClientRecordsDedupeDeps): void {
    if (!host) return;
    mounted = deps;
    shownPlan = null;
    host.innerHTML = controlHtml();
    host.querySelector("[data-hdedupe-check]")?.addEventListener("click", () => {
      void check(deps);
    });
  }

  // Reattach a check still running after a reload — only while Records is on
  // screen with the slot mounted; otherwise the person simply checks again.
  function reconnect(_job?: unknown): ClientAgentOpHandlers | null {
    const deps = mounted;
    const host = panel();
    if (!deps || !host) return null;
    setChecking(true);
    host.innerHTML = runningHtml();
    const opts = opHandlers(deps);
    return {
      guard: opts.guard,
      onDone: (result: unknown) => {
        if (isFailedPlan(result)) paintFail();
        else paintPlan(result, deps);
      },
      onError: () => paintFail(),
      onCanceled: () => paintFail(),
    };
  }

  const CAIRN_RECORDS_DEDUPE = {
    PATH,
    JOB_KIND,
    controlHtml,
    planHtml,
    mergedHtml,
    failHtml,
    mount,
    check,
    reconnect,
  };

  Object.assign(globalThis, { CairnRecordsDedupe: CAIRN_RECORDS_DEDUPE, reconnectHealthDedupeCheck: reconnect });

  if (typeof window !== "undefined") {
    window.CairnRecordsDedupe = CAIRN_RECORDS_DEDUPE;
  }
})();

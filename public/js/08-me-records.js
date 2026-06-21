// ==== 08-me-records.js ====
// ====================================================================
// Evidence is inspectable — a calm "see the evidence" disclosure that lazy-fetches
// GET /api/evidence?marker= and lists the cited source(s): an outbound title link,
// a truncated body, the confidence word. INFORMATIONAL, not medical advice. Empty
// evidence ⇒ the citation string already shown stands alone (a quiet note here).
// ====================================================================

// Strict scheme allowlist for an outbound source URL — only real http(s) links open
// in a new tab (rel="noopener noreferrer"); anything else degrades to plain text.
function evidenceSafeUrl(u) {
  const url = String(u ?? "").trim();
  return /^https?:\/\//i.test(url) ? url.replace(/"/g, "&quot;") : null;
}

// Render the fetched evidence list (or a calm "no source on file" note when empty).
function evidenceListHtml(evidence) {
  const rows = (Array.isArray(evidence) ? evidence : []).filter((e) => e && (e.source_title || e.source_url || e.claim || e.body));
  if (!rows.length) {
    return `<div class="hb-ev-empty">No researched source on file yet — the citation above is the basis for now.</div>`;
  }
  return rows.slice(0, 6).map((e) => {
    const url = evidenceSafeUrl(e.source_url);
    const title = String(e.source_title || e.claim || "Source").trim();
    const titleHtml = url
      ? `<a class="hb-ev-link" href="${url}" target="_blank" rel="noopener noreferrer">${escHtml(title)}</a>`
      : `<span class="hb-ev-title">${escHtml(title)}</span>`;
    const claim = e.claim && e.claim !== title ? `<div class="hb-ev-claim">${escHtml(String(e.claim))}</div>` : "";
    const bodyText = String(e.body || "").trim();
    const body = bodyText ? `<div class="hb-ev-body">${escHtml(bodyText.length > 240 ? bodyText.slice(0, 237).trimEnd() + "…" : bodyText)}</div>` : "";
    const conf = e.confidence ? `<span class="hb-ev-conf">${escHtml(String(e.confidence))} confidence</span>` : "";
    return `<div class="hb-ev-row">${titleHtml}${claim}${body}${conf ? `<div class="hb-ev-meta">${conf}</div>` : ""}</div>`;
  }).join("");
}

// Toggle the evidence box for one directive; fetch once, then just show/hide.
async function toggleEvidence(btn) {
  const box = btn.nextElementSibling;
  if (!box || !box.classList.contains("hb-evbox")) return;
  // Remember the "see the evidence (N)" label (count included) so closing restores
  // it verbatim — the count is set in directiveHtml and must survive a toggle.
  if (!btn.dataset.openLabel) btn.dataset.openLabel = btn.innerHTML;
  const opening = box.hidden;
  if (!opening) { // closing
    box.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = btn.dataset.openLabel;
    return;
  }
  btn.setAttribute("aria-expanded", "true");
  btn.textContent = "hide the evidence";
  box.hidden = false;
  if (box.dataset.loaded === "1") { box.classList.remove("chip-in"); void box.offsetWidth; box.classList.add("chip-in"); return; }
  box.innerHTML = `<div class="hb-ev-loading lbl"><span class="aspin aspin-xs"></span> reading the source…</div>`;
  let res = null;
  try { res = await api(`/evidence?marker=${encodeURIComponent(btn.dataset.evidence || "")}`); } catch { res = null; }
  if (box.hidden) return; // user closed it mid-flight
  box.dataset.loaded = "1";
  box.innerHTML = evidenceListHtml(res && Array.isArray(res.evidence) ? res.evidence : []);
  if (!reducedMotion()) { box.classList.remove("chip-in"); void box.offsetWidth; box.classList.add("chip-in"); }
}

async function loadDirectives(token) {
  const wrap = $("#hbDirectives");
  if (!wrap || !wrap.isConnected) return;
  // Fetch the directives AND the evidence summary together (F1): the summary is
  // the per-marker count of cited rows on file, so each directive can offer "see
  // the evidence (N)" even without a citation — and we know whether research is
  // worth nudging — without an N-fetch fan-out. The summary is best-effort.
  let res = null, evSummary = null;
  try {
    [res, evSummary] = await Promise.all([
      api("/directives"),
      api("/evidence/summary").catch(() => null),
    ]);
  } catch { res = null; }
  if (token !== pollToken || !wrap.isConnected) return;
  const all = res && Array.isArray(res.directives) ? res.directives : [];
  const active = all.filter((d) => !d.status || d.status === "active");
  paintDirectives(wrap, active, evSummary);
}

// Build a case-insensitive marker → evidence-count map from the summary.
function evidenceCountMap(summary) {
  const map = new Map();
  const rows = summary && Array.isArray(summary.by_marker) ? summary.by_marker : [];
  for (const r of rows) {
    if (!r || !r.marker) continue;
    map.set(String(r.marker).toLowerCase(), Number(r.count) || 0);
  }
  return map;
}

function paintDirectives(wrap, active, evSummary) {
  const evMap = evidenceCountMap(evSummary);
  const researchOff = !!(evSummary && evSummary.research_enabled === false);
  if (!active.length) {
    wrap.innerHTML = `<div class="hb-section hb-dir-section">
      <div class="hb-sechead"><span class="lbl">Across your life</span><button class="hb-derive" id="hbDerive" title="Refresh from your latest labs">refresh from labs</button></div>
      <div class="empty">Nothing to carry across domains right now. When a lab finding has a clear lever, it'll show up here as something to review.</div>
    </div>`;
    $("#hbDerive")?.addEventListener("click", deriveDirectives);
    return;
  }
  // running index across groups → directives settle in one continuous stagger
  let dIdx = 0;
  const groups = DIRECTIVE_DOMAINS.map(([key, label, glyph]) => {
    const rows = active.filter((d) => (d.domain || "watch") === key);
    if (!rows.length) return "";
    return `<div class="hb-dgroup">
      <div class="hb-dgrouphead"><span class="hb-dglyph" aria-hidden="true">${glyph}</span><span class="hb-dgname">${label}</span></div>
      <div class="hb-dlist">${rows.map((d) => directiveHtml(d, dIdx++, evMap)).join("")}</div>
    </div>`;
  }).filter(Boolean).join("");
  // Research-discoverability nudge (F1): only when research is OFF and at least one
  // marker-bearing directive has NO source on file yet (a citation or cached
  // evidence). Calm, one line, informational — it surfaces a capability that's
  // genuinely relevant here, never nags. Hidden the moment everything is sourced.
  const unsourced = active.some((d) =>
    d.marker && !d.citation && !(evMap.get(String(d.marker).toLowerCase()) > 0));
  const researchNudge = researchOff && unsourced
    ? `<div class="hb-research-nudge">
        <span class="hb-rn-text">Cairn can research these and cite real sources behind each one.</span>
        <button class="hb-rn-link" id="hbResearchNudge" type="button">turn on research in Settings</button>
      </div>`
    : "";
  wrap.innerHTML = `<div class="hb-section hb-dir-section">
    <div class="hb-sechead"><span class="lbl">Across your life</span><button class="hb-derive" id="hbDerive" title="Refresh from your latest labs">refresh from labs</button></div>
    ${groups}
    ${researchNudge}
  </div>`;
  $("#hbDerive")?.addEventListener("click", deriveDirectives);
  $("#hbResearchNudge")?.addEventListener("click", () => switchTab("settings"));
  wrap.querySelectorAll("[data-ddone]").forEach((b) => b.addEventListener("click", () => resolveDirective(b.dataset.ddone, "resolved")));
  wrap.querySelectorAll("[data-ddismiss]").forEach((b) => b.addEventListener("click", () => resolveDirective(b.dataset.ddismiss, "dismissed")));
  wrap.querySelectorAll("[data-evidence]").forEach((b) => b.addEventListener("click", () => toggleEvidence(b)));
}

// Flip a directive's status (the review side — nothing auto-applies). The card
// collapses out gently on success.
async function resolveDirective(id, status) {
  const card = $(`#hbDirectives .hb-directive[data-dir="${id}"]`);
  let res = null;
  try {
    res = await api(`/directives/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
  } catch { res = null; }
  if (!res || !res.ok) { toast("Couldn't update"); return; }
  toast(status === "resolved" ? "Marked done" : "Dismissed");
  const after = () => {
    // if the group is now empty, drop its header too; reload to re-group cleanly
    loadDirectives(pollToken);
  };
  if (card) collapseEl(card, after); else after();
}

// Quiet "refresh from latest labs" — re-run the deterministic propagation engine.
async function deriveDirectives() {
  const btn = $("#hbDerive");
  const restore = btnBusy(btn, "refreshing…");
  let res = null;
  try { res = await api("/directives/derive", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { res = null; }
  if (!res || !res.ok) { toast("Couldn't refresh"); restore(); return; }
  toast(res.derived ? `Refreshed — ${res.derived} found` : "Up to date");
  loadDirectives(pollToken);
}

// ---- Markers tab: trends across every document ----
function paintHealthMarkersTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `<div id="hMarkers">${skelLines(4)}</div>
    <div id="hExport" hidden style="margin:18px 2px 4px">
      <button id="hReportBtn" class="logbtn" style="width:100%;text-align:center;padding:12px">Export for my doctor</button>
      <div class="hpic-hero-sub" style="margin-top:7px;text-align:center">A clean, grouped report of your markers over time — findings to discuss up top, your progress by date, plus DEXA body comp. Opens ready to “Save as PDF” for MyChart or your PCP.</div>
      <button id="hExportBtn" class="ghostbtn" style="width:100%;text-align:center;padding:9px;margin-top:11px">Export structured data (JSON)</button>
      <button id="hAlignBtn" class="ghostbtn" style="width:100%;text-align:center;padding:9px;margin-top:9px">Align lab names</button>
      <div class="hpic-hero-sub" style="margin-top:6px;text-align:center">Different labs name the same test differently — Cairn merges them so each trend is one line. Runs automatically on new labs.</div>
    </div>`;
  $("#hReportBtn")?.addEventListener("click", () => {
    window.open(withToken("/api/health-report"), "_blank");
  });
  $("#hExportBtn")?.addEventListener("click", () => {
    downloadFile(withToken("/api/health-export"));
    toast("Structured data downloaded");
  });
  $("#hAlignBtn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const restore = btnBusy(btn, "aligning…");
    let r = null;
    try { r = await api("/markers/reconcile", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); } catch { r = null; }
    restore();
    if (!r || r.ok === false) { toast("Couldn't align right now — try again in a bit."); return; }
    toast(r.aligned ? `Merged ${r.aligned} duplicate marker${r.aligned === 1 ? "" : "s"}` : "Already aligned");
    if (r.aligned) loadHealthMarkers(pollToken);
  });
  loadHealthMarkers(pollToken);
}

function healthMarkersEmptyHtml() {
  return `<div class="empty-state reveal" style="${stagger(0)}">
    <div class="artile artile-lg" style="margin:0 auto 14px">${HEALTH_HERO_ART}</div>
    <div class="empty-state-line">No markers yet</div>
    <div class="hpic-hero-sub">Add a lab report or DEXA scan and Cairn pulls out the markers — then tracks each one's trend here.</div>
    <button id="hMkToRecords" class="logbtn hpic-cta-btn">ADD A DOCUMENT</button>
  </div>`;
}

// ---- Records tab: upload affordance + the document list ----
function paintHealthRecordsTab() {
  const c = $("#hContent");
  if (!c) return;
  c.innerHTML = `
    <div class="hupload" id="hUploadBox">
      <label class="hupload-file" id="hFileLabel">
        <input id="hFile" type="file" accept="image/*,application/pdf,.zip,.htm,.html,.xml,application/zip,text/html,application/xml" hidden>
        <span class="hupload-plus" aria-hidden="true">+</span>
        <span id="hFileName">${H_FILE_PROMPT}</span>
      </label>
      <textarea id="hText" class="hupload-text" rows="4" placeholder="Paste result text or HTML export"></textarea>
      <button id="hUpload" class="logbtn hupload-btn" disabled>ADD &amp; ANALYZE</button>
      <div id="hStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <div id="hlist"></div>`;
  wireHealthUpload();
  loadHealthDocs();
}

// Wire the Records upload affordance (file picker / drag / paste / submit).
// Extracted from renderHealth so each inner tab paints independently.
function wireHealthUpload() {
  const fileInput = $("#hFile");
  const fileName = $("#hFileName");
  const uploadBox = $("#hUploadBox");
  const textInput = $("#hText");
  const uploadBtn = $("#hUpload");
  const status = $("#hStatus");
  if (!fileInput || !uploadBox) return;
  let pendingFile = null;

  const setUploadReady = () => {
    const hasText = textInput.value.trim().length > 0;
    uploadBtn.disabled = !pendingFile && !hasText;
  };

  const setPendingFile = (f) => {
    if (!f) {
      pendingFile = null;
      fileName.textContent = H_FILE_PROMPT;
      setUploadReady();
      return;
    }
    if (f.size > MAX_DOC_BYTES) {
      toast("File too large (max 15MB)");
      fileInput.value = "";
      pendingFile = null;
      fileName.textContent = H_FILE_PROMPT;
      setUploadReady();
      return;
    }
    pendingFile = f;
    fileName.textContent = f.name || "Pasted image";
    setUploadReady();
  };

  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    setPendingFile(f || null);
  });

  textInput.addEventListener("input", setUploadReady);

  uploadBox.addEventListener("dragover", (e) => {
    e.preventDefault();
    $("#hFileLabel").classList.add("dragover");
  });
  uploadBox.addEventListener("dragleave", () => $("#hFileLabel").classList.remove("dragover"));
  uploadBox.addEventListener("drop", (e) => {
    e.preventDefault();
    $("#hFileLabel").classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setPendingFile(f);
  });
  uploadBox.addEventListener("paste", (e) => {
    const files = e.clipboardData && Array.from(e.clipboardData.files || []);
    const img = files.find((f) => (f.type || "").startsWith("image/"));
    if (img) {
      e.preventDefault();
      setPendingFile(img);
      return;
    }
    if (e.target !== textInput) {
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (text) {
        e.preventDefault();
        textInput.value = text;
        setUploadReady();
      }
    }
  });

  uploadBtn.addEventListener("click", async () => {
    const f = pendingFile;
    const pastedText = textInput.value.trim();
    if (!f && !pastedText) { toast("Add a file or text first"); return; }
    if (f && f.size > MAX_DOC_BYTES) { toast("File too large (max 15MB)"); return; }
    if (!f && pastedText.length > MAX_DOC_TEXT) { toast("Text is too long"); return; }
    uploadBtn.disabled = true;
    status.textContent = "Uploading…";

    const body = {};
    if (f) {
      let dataUrl;
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(new Error("read failed"));
          fr.readAsDataURL(f);
        });
      } catch {
        status.textContent = "Couldn't read that file. Try a different one.";
        uploadBtn.disabled = false;
        return;
      }
      body.original_name = f.name || "Pasted image";
      body.mime = guessUploadMime(f);
      body.data_base64 = String(dataUrl).split(",")[1] || "";
    } else {
      body.original_name = "Pasted results";
      body.text = pastedText;
    }

    let row;
    try {
      row = await api("/health-docs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch { status.textContent = "Couldn't upload that — check your connection."; uploadBtn.disabled = false; return; }

    if (!row || row.error) { status.textContent = "Couldn't upload that — try again."; uploadBtn.disabled = false; return; }

    status.textContent = "";
    toast("Uploaded");
    // reset the picker
    fileInput.value = ""; textInput.value = ""; pendingFile = null; fileName.textContent = H_FILE_PROMPT;
    // stays disabled until a new file is picked

    // prepend the new doc and poll for analysis if pending
    const wrap = $("#hlist");
    if (wrap) {
      const emptyEl = wrap.querySelector(".empty"); if (emptyEl) emptyEl.remove();
      wrap.insertAdjacentHTML("afterbegin", healthDocHtml(row));
      wireHealthDoc(wrap.querySelector(`.hdoc[data-hdoc="${row.id}"]`));
    }
    if (row.id && enrichmentActive(row.enrichment_status)) pollHealthDoc(row.id);

    // the Analysis picture cares: doc count + newest-doc stamp drive its empty/stale states
    if (_hPic) {
      _hPic.docCount = (_hPic.docCount || 0) + 1;
      const stamp = row.created_at || new Date().toISOString();
      if (!_hPic.newestDocAt || stamp > _hPic.newestDocAt) _hPic.newestDocAt = stamp;
    } else {
      _hPic = { review: null, docCount: 1, newestDocAt: row.created_at || new Date().toISOString() };
    }
    paintHealthPicture(); // no-op unless the Analysis tab is showing
  });
}

function wireHealthDoc(el) {
  if (!el) return;
  const id = el.dataset.hdoc;
  const del = el.querySelector("[data-hdel]");
  if (del && !del._wired) { del._wired = true; del.addEventListener("click", () => startHealthDelete(del)); }

  // Date is read-only until the user explicitly asks to change it.
  const editBtn = el.querySelector("[data-hdate-edit]");
  if (editBtn && !editBtn._wired) {
    editBtn._wired = true;
    editBtn.addEventListener("click", () => {
      const editor = el.querySelector("[data-hdate-editor]");
      const flash = el.querySelector("[data-hdate-flash]");
      if (flash) flash.hidden = true;
      editBtn.hidden = true;
      if (editor) {
        editor.hidden = false;
        const inp = editor.querySelector("[data-hdate]");
        if (inp) inp.focus();
      }
    });
  }
  const saveBtn = el.querySelector("[data-hdate-save]");
  if (saveBtn && !saveBtn._wired) { saveBtn._wired = true; saveBtn.addEventListener("click", () => saveHealthDocDate(id)); }
  const cancelBtn = el.querySelector("[data-hdate-cancel]");
  if (cancelBtn && !cancelBtn._wired) {
    cancelBtn._wired = true;
    cancelBtn.addEventListener("click", () => {
      const editor = el.querySelector("[data-hdate-editor]");
      const inp = el.querySelector("[data-hdate]");
      if (inp) inp.value = inp.defaultValue; // discard the unsaved change
      if (editor) editor.hidden = true;
      if (editBtn) editBtn.hidden = false;
    });
  }
  const rescan = el.querySelector("[data-hrescan]");
  if (rescan && !rescan._wired) { rescan._wired = true; rescan.addEventListener("click", () => reanalyzeHealthDoc(id)); }

  // Collapse / expand the record's detail (the header and the collapsed teaser
  // both carry data-hdoc-toggle). Keeps a long history scannable.
  el.querySelectorAll("[data-hdoc-toggle]").forEach((t) => {
    if (t._wired) return;
    t._wired = true;
    const toggle = () => el.classList.toggle("hdoc-collapsed");
    t.addEventListener("click", toggle);
    if (t.getAttribute("role") === "button") {
      t.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    }
  });
}

// Save an explicitly-changed result date, confirm with a brief "✓ updated", and
// re-run the downstream trends + whole-picture review so analysis stays in sync.
async function saveHealthDocDate(id) {
  const row = $(`#hlist .hdoc[data-hdoc="${id}"]`);
  if (!row) return;
  const inp = row.querySelector("[data-hdate]");
  const save = row.querySelector("[data-hdate-save]");
  if (!inp) return;
  if (save) { save.disabled = true; save.textContent = "Saving…"; }
  let updated = null;
  try {
    updated = await api(`/health-docs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_date: inp.value || null }),
    });
  } catch {
    if (save) { save.disabled = false; save.textContent = "Save"; }
    toast("Couldn't update date");
    return;
  }
  if (updated && !updated.error) {
    row.innerHTML = healthDocInner(updated); // back to view mode with the new date
    wireHealthDoc(row);
    const flash = row.querySelector("[data-hdate-flash]");
    if (flash) { flash.hidden = false; setTimeout(() => { if (flash.isConnected) flash.hidden = true; }, 2200); }
    loadHealthMarkers(pollToken);
    paintHealthPicture(); // the review is now stale (date moved) → re-run nudge appears
  } else {
    if (save) { save.disabled = false; save.textContent = "Save"; }
    toast((updated && updated.error) || "Couldn't update date");
  }
}

// Re-run the agentic scan over a document's original file (re-extracts panels).
async function reanalyzeHealthDoc(id) {
  const row = $(`#hlist .hdoc[data-hdoc="${id}"]`);
  let updated = null;
  try {
    updated = await api(`/health-docs/${id}/reanalyze`, { method: "POST" });
  } catch {
    toast("Couldn't start re-analysis");
    return;
  }
  if (!updated || updated.error) { toast((updated && updated.error) || "Couldn't re-analyze"); return; }
  toast("Re-analyzing…");
  if (row) { row.innerHTML = healthDocInner(updated); wireHealthDoc(row); }
  pollHealthDoc(id);
}

function pollHealthDoc(id) {
  const tab = state.tab, token = pollToken;
  // Health ingestion reads PDFs/whole export folders and can run for minutes —
  // poll far longer than the activity/food default (~15s).
  pollEnrichment("/health-docs", id, {
    tab, token, tries: 100, interval: 4000,
    onUpdate: (row) => {
      if (state.meSeg !== "health" || state.healthSeg !== "records") return;
      const el = $(`#hlist .hdoc[data-hdoc="${row.id}"]`);
      if (el) { el.innerHTML = healthDocInner(row); wireHealthDoc(el); }
      if (row.enrichment_status === "done") {
        // An import may have split into NEW dated panels → reload the whole list
        // so they appear; also refresh the trends + the whole-picture review.
        loadHealthDocs();
        loadHealthMarkers(pollToken);
        paintHealthPicture();
      }
    },
  });
}

async function loadHealthDocs() {
  const wrap = $("#hlist");
  if (!wrap) return [];
  let docs = [];
  try { docs = await api("/health-docs"); } catch { docs = []; }
  if (state.tab !== "me" || state.meSeg !== "health" || !wrap.isConnected) return docs || [];
  if (!docs || !docs.length) { wrap.innerHTML = `<div class="empty">No documents yet.</div>`; return []; }
  wrap.innerHTML = docs.map((d, i) => healthDocHtml(d, i)).join("");
  wrap.querySelectorAll(".hdoc").forEach((el) => {
    wireHealthDoc(el);
    if (el.dataset.hdoc) {
      // resume polling any still-pending doc
      const status = el.querySelector(".enr-pending");
      if (status) pollHealthDoc(Number(el.dataset.hdoc));
    }
  });
  return docs;
}

// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startHealthDelete(btn) {
  const row = btn.closest(".hdoc");
  const id = row.dataset.hdoc;
  armDelete(btn, () => {
    api(`/health-docs/${id}`, { method: "DELETE" })
      .then(() => {
        toast("Removed"); row.remove();
        if (!$("#hlist").children.length) $("#hlist").innerHTML = `<div class="empty">No documents yet.</div>`;
        if (_hPic && _hPic.docCount > 0) { _hPic.docCount--; paintHealthPicture(); }
        loadHealthMarkers(pollToken);
      })
      .catch(() => toast("Couldn't remove that — try again."));
  });
}

// ---------- Me: Life (trips / injuries / life events) ----------
const LIFE_KINDS = [["trip", "Trip"], ["injury", "Injury"], ["life_event", "Life event"]];
const LIFE_ICONS = { trip: "✈", injury: "🤕", life_event: "◆" };

function lifeKindLabel(k) {
  const m = LIFE_KINDS.find((x) => x[0] === k);
  return m ? m[1] : (k || "Event");
}

// meta_json may arrive as a JSON string or an object
function parsedMeta(ev) {
  let mj = ev.meta_json;
  if (typeof mj === "string") { try { mj = JSON.parse(mj); } catch { mj = null; } }
  return mj || {};
}

function fmtDateRange(start, end) {
  if (start && end && start !== end) return `${escHtml(start)} → ${escHtml(end)}`;
  if (start) return escHtml(start);
  if (end) return `until ${escHtml(end)}`;
  return "";
}

// Days until a start date (positive = upcoming, 0 = today/active, negative = past). null if no date.
function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(localISO() + "T00:00:00");
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return null;
  return Math.round((d - today) / 86400000);
}

// Is an event currently active or upcoming (not fully in the past, not archived)?
function eventActive(ev) {
  if (ev.archived) return false;
  const todayIso = localISO();
  if (ev.end_date) return ev.end_date >= todayIso;       // ends today or later
  if (ev.start_date) return true;                         // open-ended (e.g. ongoing injury)
  return true;
}

async function renderLife() {
  headerTitle.textContent = "Me";
  state.meSeg = "life";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("life", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Trips, injuries, and life events. The coach factors these into the workout you see — easing off around travel or an injury.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">Add to your timeline</h1>
    <div class="lifeadd">
      <div class="field" style="margin-bottom:9px"><label>Kind</label>
        <select id="lKind" class="selflex">${LIFE_KINDS.map(([k, l]) => `<option value="${k}">${LIFE_ICONS[k]} ${l}</option>`).join("")}</select>
      </div>
      <div id="lFields"></div>
      <button id="lAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
      <div id="lStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Timeline</h1>
    <div id="llist"></div>`;
  wireSeg(ME_HANDLERS);

  const kindSel = $("#lKind");
  kindSel.addEventListener("change", () => drawLifeFields(kindSel.value));
  drawLifeFields(kindSel.value);

  $("#lAdd").addEventListener("click", submitLifeEvent);

  loadLifeEvents();
}

// Render the kind-specific add fields into #lFields.
function drawLifeFields(kind) {
  const wrap = $("#lFields");
  if (!wrap) return;
  const text = (id, label, ph = "") =>
    `<div class="field" style="margin-bottom:9px"><label>${label}</label><input id="${id}" type="text" placeholder="${escAttr(ph)}" class="form-input"></div>`;
  const date = (id, label) =>
    `<div class="field" style="margin-bottom:9px"><label>${label}</label><input id="${id}" type="date" class="form-input" value=""></div>`;
  if (kind === "trip") {
    wrap.innerHTML =
      text("lTitle", "Title", "e.g. Lisbon work trip") +
      text("lLocation", "Location", "e.g. Lisbon") +
      `<div class="ob-grid">${date("lStart", "Start")}${date("lEnd", "End")}</div>` +
      text("lDetail", "Detail (optional)");
  } else if (kind === "injury") {
    wrap.innerHTML =
      text("lTitle", "Title", "e.g. Right knee") +
      text("lArea", "Area", "e.g. knee / lower back") +
      `<div class="field" style="margin-bottom:9px"><label>Severity</label>
        <select id="lSeverity" class="selflex">
          <option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option>
        </select></div>` +
      date("lStart", "Since") +
      date("lEnd", "Expected resolved (optional)") +
      text("lDetail", "Detail (optional)");
  } else {
    wrap.innerHTML =
      text("lTitle", "Title", "e.g. New baby") +
      `<div class="ob-grid">${date("lStart", "Start")}${date("lEnd", "End (optional)")}</div>` +
      `<div class="field" style="margin-bottom:9px"><label>Impact</label>
        <select id="lImpact" class="selflex">
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select></div>` +
      text("lDetail", "Detail (optional)");
  }
}

function collectLifeForm() {
  const kind = $("#lKind").value;
  const val = (id) => { const el = $("#" + id); return el && el.value.trim() ? el.value.trim() : null; };
  const title = val("lTitle");
  const detail = val("lDetail");
  const start_date = val("lStart");
  const end_date = val("lEnd");
  const meta = {};
  if (kind === "trip") { const loc = val("lLocation"); if (loc) meta.location = loc; }
  else if (kind === "injury") { const area = val("lArea"); if (area) meta.area = area; const sev = $("#lSeverity"); if (sev) meta.severity = sev.value; }
  else { const imp = $("#lImpact"); if (imp) meta.impact = imp.value; }
  return { kind, title, detail, start_date, end_date, meta };
}

async function submitLifeEvent() {
  const status = $("#lStatus");
  const body = collectLifeForm();
  if (!body.title) { status.textContent = "Add a title first."; $("#lTitle")?.focus(); return; }
  const btn = $("#lAdd");
  btn.disabled = true;
  try {
    const r = await api("/context-events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r && r.error) { status.textContent = "Couldn't save that — try again."; return; }
    status.textContent = "";
    toast("Added");
    // reset the text + dates but keep the kind
    drawLifeFields($("#lKind").value);
    loadLifeEvents();
  } catch { status.textContent = "Couldn't save that — check your connection."; }
  finally { btn.disabled = false; }
}

// The connected-brain block for an active injury: the planned movements it
// touches + a few calm swap ideas per movement. Pull, not push — suggestions
// only, never a button that changes the plan. Rendered from /injury-impacts
// (keyed by the injury's context_event id), so an empty/no-match injury shows
// nothing (zero noise).
function lifeImpactsHtml(impact) {
  if (!impact || !Array.isArray(impact.affected) || !impact.affected.length) return "";
  const rows = impact.affected.map((a) => {
    const where = Array.isArray(a.days) && a.days.length
      ? a.days.map((d) => escHtml(d.day_name || `Day ${d.day_number}`)).join(", ")
      : "";
    const note = a.constraint_note ? `<div class="linj-note">${escHtml(a.constraint_note)}</div>` : "";
    const swaps = Array.isArray(a.swaps) && a.swaps.length
      ? `<div class="linj-swaps"><span class="linj-swaps-lbl">try instead</span>${a.swaps
          .map((s) => `<span class="linj-swap" title="${escAttr(s.why || "")}">${escHtml(s.name)}</span>`)
          .join("")}</div>`
      : "";
    return `<div class="linj-ex">
        <div class="linj-exhead">
          <span class="linj-exname">${escHtml(a.exercise)}</span>
          ${where ? `<span class="linj-exwhere">${where}</span>` : ""}
        </div>
        ${note}
        ${swaps}
      </div>`;
  }).join("");
  return `<div class="linj">
      <div class="linj-lead">Touches ${impact.affected.length} planned move${impact.affected.length === 1 ? "" : "s"} — ease off or swap, your call.</div>
      ${rows}
    </div>`;
}

// One timeline card (view mode). `impact` (optional) is the injury-impacts row
// for this event, when it's an active injury — rendered as a calm sub-block.
function lifeEventInner(ev, impact) {
  const meta = parsedMeta(ev);
  const icon = LIFE_ICONS[ev.kind] || "◆";
  const range = fmtDateRange(ev.start_date, ev.end_date);
  const du = daysUntil(ev.start_date);
  let when = "";
  if (!ev.archived && du != null) {
    if (du > 0) when = `in ${du} day${du === 1 ? "" : "s"}`;
    else if (du === 0) when = `today`;
    else if (ev.kind !== "injury" && (!ev.end_date || ev.end_date < localISO())) when = "past";
    else when = "active";
  }
  const metaBits = [];
  if (meta.location) metaBits.push(escHtml(meta.location));
  if (meta.area) metaBits.push(escHtml(meta.area));
  if (meta.severity) metaBits.push(escHtml(meta.severity));
  if (meta.impact) metaBits.push(escHtml(meta.impact) + " impact");
  const metaLine = metaBits.join(" · ");
  return `<div class="sess-head">
      <span class="sess-date"><span class="life-ico">${icon}</span> ${escHtml(ev.title || lifeKindLabel(ev.kind))}</span>
      ${when ? `<span class="sess-day">${escHtml(when)}</span>` : ""}
    </div>
    ${range ? `<div class="sess-line" style="color:var(--muted)">${range}</div>` : ""}
    ${metaLine ? `<div class="sess-line" style="color:var(--muted);font-size:.78rem">${metaLine}</div>` : ""}
    ${ev.detail ? `<div class="sess-line">${escHtml(ev.detail)}</div>` : ""}
    ${lifeImpactsHtml(impact)}
    <div class="hdoc-ctl">
      <button class="iconbtn" data-ledit="${ev.id}" title="edit">✎</button>
      <button class="iconbtn life-del" data-ldel="${ev.id}" title="delete">×</button>
    </div>`;
}

function lifeEventHtml(ev, i, impactsById) {
  const past = !eventActive(ev) || ev.archived;
  const rev = typeof i === "number";
  const impact = ev.kind === "injury" && !past ? (impactsById || {})[String(ev.id)] : null;
  return `<div class="sess life-ev${past ? " life-past" : ""}${rev ? " reveal" : ""}" data-life="${ev.id}"${rev ? ` style="${stagger(i)}"` : ""}>${lifeEventInner(ev, impact)}</div>`;
}

async function loadLifeEvents() {
  const wrap = $("#llist");
  if (!wrap) return;
  let events = [];
  // Fetch the timeline and the structured injury impacts together. Impacts are a
  // calm enhancement on active injuries — if the read fails, the cards still draw.
  let impacts = null;
  try {
    [events, impacts] = await Promise.all([
      api("/context-events"),
      api("/injury-impacts").catch(() => null),
    ]);
  } catch { events = []; }
  if (state.tab !== "me" || state.meSeg !== "life" || !wrap.isConnected) return;
  if (!events || !events.length) { wrap.innerHTML = `<div class="empty">Nothing on your timeline yet.</div>`; return; }
  const impactsById = {};
  if (impacts && Array.isArray(impacts.injuries)) {
    for (const inj of impacts.injuries) impactsById[String(inj.id)] = inj;
  }
  // active/upcoming first (sorted by soonest start), then past/archived
  const active = events.filter((e) => eventActive(e));
  const past = events.filter((e) => !eventActive(e));
  const byStart = (a, b) => (a.start_date || "9999") < (b.start_date || "9999") ? -1 : 1;
  active.sort(byStart);
  past.sort((a, b) => byStart(b, a)); // most recent past first
  state._lifeById = Object.fromEntries(events.map((e) => [String(e.id), e]));
  wrap.innerHTML = [...active, ...past].map((ev, i) => lifeEventHtml(ev, i, impactsById)).join("");

  wrap.querySelectorAll("[data-ledit]").forEach((b) => b.addEventListener("click", () => startLifeEdit(b.closest(".life-ev"))));
  wrap.querySelectorAll("[data-ldel]").forEach((b) => b.addEventListener("click", () => startLifeDelete(b)));
}

// Inline edit: swap the card body for a compact editable form.
function startLifeEdit(card) {
  if (!card || card.querySelector(".life-edit")) return;
  const id = card.dataset.life;
  const ev = (state._lifeById || {})[id];
  if (!ev) return;
  const meta = parsedMeta(ev);
  const metaField = ev.kind === "trip"
    ? `<input class="le-meta form-input" placeholder="Location" value="${escAttr(meta.location || "")}">`
    : ev.kind === "injury"
      ? `<input class="le-meta form-input" placeholder="Area" value="${escAttr(meta.area || "")}">`
      : "";
  const box = document.createElement("div");
  box.className = "life-edit";
  box.innerHTML = `
    <input class="le-title form-input" placeholder="Title" value="${escAttr(ev.title || "")}">
    ${metaField}
    <div class="ob-grid" style="margin-top:6px">
      <input class="le-start form-input" type="date" value="${escAttr(ev.start_date || "")}">
      <input class="le-end form-input" type="date" value="${escAttr(ev.end_date || "")}">
    </div>
    <input class="le-detail form-input" placeholder="Detail" value="${escAttr(ev.detail || "")}">
    <div class="life-edit-ctl">
      <button class="iconbtn memok le-save" title="save">✓</button>
      <button class="iconbtn le-cancel" title="cancel">×</button>
    </div>`;
  const prev = card.innerHTML;
  card.innerHTML = "";
  card.appendChild(box);
  box.querySelector(".le-title").focus();

  const cancel = () => { card.innerHTML = prev; rewireLifeCard(card); };
  const save = async () => {
    const v = (cls) => { const el = box.querySelector(cls); return el && el.value.trim() ? el.value.trim() : null; };
    const title = v(".le-title");
    if (!title) { box.querySelector(".le-title").focus(); return; }
    const newMeta = { ...meta };
    const metaEl = box.querySelector(".le-meta");
    if (metaEl) { const mv = metaEl.value.trim(); if (ev.kind === "trip") newMeta.location = mv || undefined; else if (ev.kind === "injury") newMeta.area = mv || undefined; }
    try {
      await api(`/context-events/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: ev.kind, title, detail: v(".le-detail"), start_date: v(".le-start"), end_date: v(".le-end"), meta: newMeta }),
      });
    } catch { toast("Couldn't save that — try again."); return; }
    toast("Updated"); loadLifeEvents();
  };
  box.querySelector(".le-save").addEventListener("click", save);
  box.querySelector(".le-cancel").addEventListener("click", cancel);
}

function rewireLifeCard(card) {
  const e = card.querySelector("[data-ledit]"); if (e) e.addEventListener("click", () => startLifeEdit(card));
  const d = card.querySelector("[data-ldel]"); if (d) d.addEventListener("click", () => startLifeDelete(d));
}

// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startLifeDelete(btn) {
  const id = btn.closest(".life-ev").dataset.life;
  armDelete(btn, () => {
    api(`/context-events/${id}`, { method: "DELETE" })
      .then(() => { toast("Removed"); loadLifeEvents(); })
      .catch(() => toast("Couldn't remove that — try again."));
  });
}

// ---------- Me: Family (the people the coach plans around) ----------
// Family is warm context, not surveillance: who's in your life, so the buddy
// plans around the school run and the 6am-with-kids reality. Recurring
// commitments (soccer Tuesdays) live on the Life timeline as family_event
// context_events — this roster is the people, not their calendar.

// A small Atelier swatch palette drawn from the design tokens. Each entry is the
// stored color value (the token's hex) plus a display label.
const FAMILY_COLORS = [
  { v: "#b4552d", l: "Terracotta" },
  { v: "#6e7f5c", l: "Sage" },
  { v: "#c9a86a", l: "Gold" },
  { v: "#8e4f6d", l: "Plum" },
  { v: "#57503f", l: "Ink" },
  { v: "#7d8f5e", l: "Olive" },
];
const FAMILY_DEFAULT_COLOR = FAMILY_COLORS[0].v;

function familyColor(c) {
  const v = String(c || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : FAMILY_DEFAULT_COLOR;
}

// Plain-language age from a free-text YYYY-MM-DD birthdate. Babies read in months;
// everyone else in years. Null/garbage → "" (no age line shown).
function ageFromBirthdate(bd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(bd || ""));
  if (!m) return "";
  const b = new Date(+m[1], +m[2] - 1, +m[3]);
  if (isNaN(b)) return "";
  const now = new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months--;
  if (months < 0) return "";
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yr`;
}

// Two-initials monogram from a name (deterministic, no caller text in markup risk —
// it's escHtml'd at the call site).
function familyInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function familyCardInner(f) {
  const color = familyColor(f.color);
  const age = ageFromBirthdate(f.birthdate);
  const meta = [];
  if (f.relationship) meta.push(escHtml(f.relationship));
  if (age) meta.push(escHtml(age));
  return `<div class="fam-head">
      <span class="fam-mono" style="--fam:${escAttr(color)}">${escHtml(familyInitials(f.name))}</span>
      <div class="fam-id">
        <span class="fam-name">${escHtml(f.name || "Someone")}</span>
        ${meta.length ? `<span class="fam-meta">${meta.join(" · ")}</span>` : ""}
      </div>
    </div>
    ${f.notes ? `<div class="sess-line fam-notes">${escHtml(f.notes)}</div>` : ""}
    ${(f.allergies || f.dietary_restrictions) ? `<div class="sess-line fam-notes" style="color:var(--muted)">${[f.allergies ? "avoids " + escHtml(f.allergies) : "", f.dietary_restrictions ? escHtml(f.dietary_restrictions) : ""].filter(Boolean).join(" · ")}</div>` : ""}
    <div class="hdoc-ctl">
      <button class="iconbtn" data-fedit="${f.id}" title="edit">✎</button>
      <button class="iconbtn fam-del" data-fdel="${f.id}" title="delete">×</button>
    </div>`;
}

function familyCardHtml(f, i) {
  const rev = typeof i === "number";
  return `<div class="sess fam-card${rev ? " reveal" : ""}" data-fam="${f.id}"${rev ? ` style="${stagger(i)}"` : ""}>${familyCardInner(f)}</div>`;
}

// The swatch row for the add/edit forms. `selected` is the chosen hex.
function familySwatches(selected) {
  const sel = familyColor(selected);
  return `<div class="fam-swatches" role="radiogroup" aria-label="Colour">
    ${FAMILY_COLORS.map((c) => `<button type="button" class="fam-swatch${c.v === sel ? " fam-swatch-on" : ""}" data-color="${escAttr(c.v)}" style="--fam:${escAttr(c.v)}" title="${escAttr(c.l)}" aria-label="${escAttr(c.l)}"></button>`).join("")}
  </div>`;
}

async function renderFamily() {
  headerTitle.textContent = "Me";
  state.meSeg = "family";
  pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
  view.innerHTML = segBar("family", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      The people in your life, so the coach plans around them — never the hardest session on the chaos day. Recurring commitments like the school run or a kid's soccer night live on your <button class="linkbtn" id="famToLife">Life timeline</button> as events.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">Add someone</h1>
    <div class="lifeadd famadd">
      <div class="field" style="margin-bottom:9px"><label>Name</label>
        <input id="fName" type="text" placeholder="e.g. Mara" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label>Relationship (optional)</label>
        <input id="fRel" type="text" placeholder="e.g. daughter / partner" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label>Birthday (optional)</label>
        <input id="fBirth" type="date" max="${localISO()}" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label>Colour</label>${familySwatches(FAMILY_DEFAULT_COLOR)}</div>
      <div class="field" style="margin-bottom:9px"><label>Notes (optional)</label>
        <input id="fNotes" type="text" placeholder="e.g. trains with me on weekends" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label>Allergies (optional)</label>
        <input id="fAllergy" type="text" placeholder="e.g. peanuts, shellfish" class="form-input"></div>
      <div class="field" style="margin-bottom:9px"><label>Dietary needs (optional)</label>
        <input id="fDiet" type="text" placeholder="e.g. vegetarian, no pork" class="form-input"></div>
      <button id="fAdd" class="logbtn" style="width:100%;height:44px;letter-spacing:.05em">ADD</button>
      <div id="fStatus" style="margin-top:6px;color:var(--muted);font-size:.82rem"></div>
    </div>
    <h1 class="lbl" style="margin:24px 0 8px">Your people</h1>
    <div id="flist"></div>`;
  wireSeg(ME_HANDLERS);

  $("#famToLife")?.addEventListener("click", () => withViewTransition(() => renderLife().then(viewEnter)));

  // swatch picker (add form)
  let addColor = FAMILY_DEFAULT_COLOR;
  view.querySelectorAll(".famadd .fam-swatch").forEach((b) => b.addEventListener("click", () => {
    addColor = b.dataset.color;
    view.querySelectorAll(".famadd .fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
  }));

  $("#fAdd").addEventListener("click", async () => {
    const status = $("#fStatus");
    const name = $("#fName").value.trim();
    if (!name) { status.textContent = "Add a name first."; $("#fName").focus(); return; }
    const body = {
      name,
      relationship: $("#fRel").value.trim() || null,
      birthdate: $("#fBirth").value || null,
      color: addColor,
      notes: $("#fNotes").value.trim() || null,
      allergies: $("#fAllergy").value.trim() || null,
      dietary_restrictions: $("#fDiet").value.trim() || null,
    };
    const btn = $("#fAdd");
    btn.disabled = true;
    try {
      const r = await api("/family", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r && r.error) { status.textContent = "Couldn't save that — try again."; return; }
      status.textContent = "";
      toast("Added");
      $("#fName").value = ""; $("#fRel").value = ""; $("#fBirth").value = ""; $("#fNotes").value = "";
      $("#fAllergy").value = ""; $("#fDiet").value = "";
      loadFamily();
    } catch { status.textContent = "Couldn't save that — check your connection."; }
    finally { btn.disabled = false; }
  });

  loadFamily();
}

async function loadFamily() {
  const wrap = $("#flist");
  if (!wrap) return;
  let people = [];
  try { people = await api("/family"); } catch { people = []; }
  if (state.tab !== "me" || state.meSeg !== "family" || !wrap.isConnected) return;
  if (!Array.isArray(people) || !people.length) {
    wrap.innerHTML = `<div class="empty">No one here yet. Add the people you plan your weeks around.</div>`;
    return;
  }
  state._famById = Object.fromEntries(people.map((f) => [String(f.id), f]));
  wrap.innerHTML = people.map((f, i) => familyCardHtml(f, i)).join("");
  wrap.querySelectorAll("[data-fedit]").forEach((b) => b.addEventListener("click", () => startFamilyEdit(b.closest(".fam-card"))));
  wrap.querySelectorAll("[data-fdel]").forEach((b) => b.addEventListener("click", () => startFamilyDelete(b)));
}

// Inline edit: swap the card body for a compact editable form (mirrors Life's pattern).
function startFamilyEdit(card) {
  if (!card || card.querySelector(".fam-edit")) return;
  const id = card.dataset.fam;
  const f = (state._famById || {})[id];
  if (!f) return;
  let editColor = familyColor(f.color);
  const box = document.createElement("div");
  box.className = "fam-edit";
  box.innerHTML = `
    <input class="fe-name form-input" placeholder="Name" value="${escAttr(f.name || "")}">
    <input class="fe-rel form-input" placeholder="Relationship" value="${escAttr(f.relationship || "")}">
    <input class="fe-birth form-input" type="date" max="${localISO()}" value="${escAttr(f.birthdate || "")}">
    ${familySwatches(editColor)}
    <input class="fe-notes form-input" placeholder="Notes" value="${escAttr(f.notes || "")}">
    <input class="fe-allergy form-input" placeholder="Allergies" value="${escAttr(f.allergies || "")}">
    <input class="fe-diet form-input" placeholder="Dietary needs" value="${escAttr(f.dietary_restrictions || "")}">
    <div class="life-edit-ctl">
      <button class="iconbtn memok fe-save" title="save">✓</button>
      <button class="iconbtn fe-cancel" title="cancel">×</button>
    </div>`;
  const prev = card.innerHTML;
  card.innerHTML = "";
  card.appendChild(box);
  box.querySelector(".fe-name").focus();
  box.querySelectorAll(".fam-swatch").forEach((b) => b.addEventListener("click", () => {
    editColor = b.dataset.color;
    box.querySelectorAll(".fam-swatch").forEach((x) => x.classList.toggle("fam-swatch-on", x === b));
  }));

  const cancel = () => { card.innerHTML = prev; rewireFamilyCard(card); };
  const save = async () => {
    const v = (cls) => { const el = box.querySelector(cls); return el && el.value.trim() ? el.value.trim() : null; };
    const name = v(".fe-name");
    if (!name) { box.querySelector(".fe-name").focus(); return; }
    try {
      await api(`/family/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, relationship: v(".fe-rel"), birthdate: v(".fe-birth"), color: editColor, notes: v(".fe-notes"), allergies: v(".fe-allergy"), dietary_restrictions: v(".fe-diet") }),
      });
    } catch { toast("Couldn't save that — try again."); return; }
    toast("Updated"); loadFamily();
  };
  box.querySelector(".fe-save").addEventListener("click", save);
  box.querySelector(".fe-cancel").addEventListener("click", cancel);
}

function rewireFamilyCard(card) {
  const e = card.querySelector("[data-fedit]"); if (e) e.addEventListener("click", () => startFamilyEdit(card));
  const d = card.querySelector("[data-fdel]"); if (d) d.addEventListener("click", () => startFamilyDelete(d));
}

// two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
function startFamilyDelete(btn) {
  const id = btn.closest(".fam-card").dataset.fam;
  armDelete(btn, () => {
    api(`/family/${id}`, { method: "DELETE" })
      .then(() => { toast("Removed"); loadFamily(); })
      .catch(() => toast("Couldn't remove that — try again."));
  });
}


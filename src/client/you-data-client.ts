// @ts-check
// "Your data", the view: the You home's first card. One row per source Cairn reads
// about you (GET /api/health/data-coverage) — a dot in the domain's stone hue, the
// source's name, what it holds, and on the right how fresh it is ("Aug 24", "synced 2h
// ago"); a source with nothing yet wears a hollow dashed dot and a dawn "Add"/"Connect".
// Under the rows, a soft well of at most two "would sharpen your reads" gaps, hidden when
// there are none. Every word is the server's; this module only frames it.
//
// Also the Add sheet's markup: one line, three equal ways in (File / Photo / Paste) that
// feed Records' own upload, and a "Connect a source" row.
{
  type Read = import("../contracts/data-coverage.js").DataCoverageRead;
  type Row = import("../contracts/data-coverage.js").DataCoverageRow;
  type Gap = import("../contracts/data-coverage.js").DataCoverageGap;

  // Each source's dot is the stone hue of the part of the picture it mostly feeds.
  const HUES: Readonly<Record<string, string>> = {
    labs: "heart",
    scans: "strength",
    visits: "fuel",
    garmin: "endurance",
    apple_health: "recovery",
    body: "body",
  };

  // The same accept list Records' own picker uses for a record, so a file chosen here
  // is one Records would have taken.
  const RECORD_ACCEPT = "image/*,application/pdf,.zip,.htm,.html,.xml,application/zip,text/html,application/xml";

  function isRow(value: unknown): value is Row {
    const row = value as Row | null;
    return !!row && typeof row === "object" && typeof row.key === "string" && typeof row.label === "string";
  }

  function isGap(value: unknown): value is Gap {
    const gap = value as Gap | null;
    return !!gap && typeof gap === "object" && typeof gap.key === "string" && typeof gap.subject === "string";
  }

  /** The read's rows and gaps, or null when the payload is not a coverage read. */
  function normalize(read: unknown): { rows: Row[]; gaps: Gap[] } | null {
    const r = read as Partial<Read> | null;
    if (!r || typeof r !== "object" || !Array.isArray(r.rows)) return null;
    const rows = r.rows.filter(isRow);
    if (!rows.length) return null;
    return { rows, gaps: (Array.isArray(r.gaps) ? r.gaps.filter(isGap) : []).slice(0, 2) };
  }

  /** The right-hand freshness words: a sync clock for a live wearable, else the date. */
  function whenWords(row: Row, relTimeFn?: (iso: string) => string): string {
    if (row.state === "absent") return "";
    if (row.synced_at && relTimeFn) {
      const ago = relTimeFn(row.synced_at);
      if (ago) return `synced ${ago}`;
    }
    return row.date_words || "";
  }

  function rowHtml(row: Row, relTimeFn?: (iso: string) => string): string {
    const absent = row.state === "absent";
    const when = whenWords(row, relTimeFn);
    const hue = HUES[row.key] || "body";
    const right = absent
      ? `<span class="you-data-cta">${escHtml(row.cta || "Add")}</span>`
      : `<span class="you-data-when${row.quiet ? " is-quiet" : ""}">${escHtml(when)}</span>`;
    const said = [row.label, row.holds, absent ? row.cta || "Add" : when].filter(Boolean).join(", ");
    return `<li class="you-data-item"><button class="you-data-row${absent ? " is-absent" : ""}" type="button" data-you-data-open="${escAttr(row.key)}" aria-label="${escAttr(said)}">
      <span class="you-data-dot stone-${escAttr(hue)}" aria-hidden="true"></span>
      <span class="you-data-text"><span class="you-data-label">${escHtml(row.label)}</span><span class="you-data-holds">${escHtml(row.holds)}</span></span>
      ${right}
    </button></li>`;
  }

  function gapsHtml(gaps: Gap[]): string {
    if (!gaps.length) return "";
    return `<div class="you-data-gaps">
      <p class="you-data-gaps-h">Would sharpen your reads</p>
      <ul class="you-data-gap-list">${gaps
        .map(
          (gap) => `<li class="you-data-gap">
        <span class="you-data-gap-s">${escHtml(gap.subject)}</span>
        <span class="you-data-gap-why">${escHtml(gap.why)}</span>
        <button class="you-data-gap-go" type="button" data-you-data-gap="${escAttr(gap.key)}">${escHtml(gap.action_label)}</button>
      </li>`
        )
        .join("")}</ul>
    </div>`;
  }

  function headHtml(): string {
    return `<div class="you-data-head">
      <h2 class="lbl you-data-h" id="youDataH">Your data</h2>
      <button class="you-data-add" type="button" data-you-data-add aria-haspopup="dialog"><span aria-hidden="true">+</span> Add</button>
    </div>`;
  }

  /** The card; "" when the read holds nothing to show (the slot then collapses). */
  function youDataHtml(read: unknown, opts: { relTime?: (iso: string) => string } = {}): string {
    const model = normalize(read);
    if (!model) return "";
    return `${headHtml()}
    <div class="you-data-card" data-you-data-drop>
      <ul class="you-data-list">${model.rows.map((row) => rowHtml(row, opts.relTime)).join("")}</ul>
      ${gapsHtml(model.gaps)}
      <p class="you-data-drophint" aria-hidden="true">Drop a file to add it to your records</p>
    </div>`;
  }

  function skeletonHtml(): string {
    const ghost = `<li class="you-data-item"><span class="you-data-row is-ghost"><span class="you-data-dot"></span><span class="you-data-text"><span class="you-data-ghost"></span></span></span></li>`;
    return `${headHtml()}<div class="you-data-card is-loading" aria-busy="true"><ul class="you-data-list">${ghost.repeat(4)}</ul></div>`;
  }

  const GLYPHS: Readonly<Record<"file" | "photo" | "paste", string>> = {
    file: `<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>`,
    photo: `<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`,
    paste: `<path d="M8 5H6v16h12V5h-2"/><path d="M9 3h6v4H9z"/><path d="M9 12h6M9 16h4"/>`,
  };

  function glyph(kind: "file" | "photo" | "paste"): string {
    return `<svg class="you-add-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${GLYPHS[kind]}</svg>`;
  }

  /** The Add sheet's inner markup (CairnUiSheet supplies the dialog around it). */
  function addSheetHtml(): string {
    return `<div class="you-add-hd"><h3 class="you-add-h" id="youAddH">Add to your record</h3><button class="xbtn" type="button" data-ui-sheet-close aria-label="Close">✕</button></div>
      <p class="you-add-lede">A lab report, a scan or a visit summary: a PDF, a photo of the page, or its text. Cairn reads it and files it with your records.</p>
      <div class="you-add-opts" role="group" aria-label="Add from">
        <button class="you-add-opt" type="button" data-you-add="file">${glyph("file")}<span>File</span></button>
        <button class="you-add-opt" type="button" data-you-add="photo">${glyph("photo")}<span>Photo</span></button>
        <button class="you-add-opt" type="button" data-you-add="paste">${glyph("paste")}<span>Paste</span></button>
      </div>
      <button class="you-add-src" type="button" data-you-add="sources"><span class="you-add-src-text"><span class="you-add-src-t">Connect a source</span><span class="you-add-src-s">Garmin or Apple Health, synced on its own</span></span><span class="chev" aria-hidden="true">›</span></button>
      <input class="you-add-input" type="file" hidden accept="${escAttr(RECORD_ACCEPT)}" data-you-add-input="file">
      <input class="you-add-input" type="file" hidden accept="image/*" capture="environment" data-you-add-input="photo">`;
  }

  const YOU_DATA: Window["CairnYouData"] = {
    KEY: "health:data-coverage",
    PATH: "/health/data-coverage",
    html: youDataHtml,
    skeletonHtml,
    addSheetHtml,
    whenWords,
    normalize,
  };

  Object.assign(globalThis, { CairnYouData: YOU_DATA });
}

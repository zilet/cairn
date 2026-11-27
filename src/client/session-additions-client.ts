// @ts-check
// Pure HTML templates for the mid-session "Ideas to add" bottom sheet.

type SessionAdditionsItemLike = {
  exercise?: unknown;
  mode?: unknown;
  sets?: unknown;
  rep_low?: unknown;
  rep_high?: unknown;
  target_weight?: unknown;
  target_seconds?: unknown;
  load_basis?: unknown;
  fit?: unknown;
  note?: unknown;
};

(() => {
  function sheetHtml(opts: {
    subtitle: string;
    vibes?: readonly string[];
    activeSteer?: string;
  }): string {
    const vibes = opts.vibes ?? CairnSessionAdditionsModel.IDEATE_VIBES;
    const activeSteer = String(opts.activeSteer || "").trim();
    const chips = vibes
      .map((v) => {
        const selected = activeSteer.toLowerCase() === v.toLowerCase();
        return `<button class="ideate-vibe${selected ? " is-active" : ""}" type="button" data-ideate-vibe="${escAttr(v)}">${escHtml(v)}</button>`;
      })
      .join("");
    return `<div class="ideate-head">
        <h2 class="ideate-title" id="ideateSheetTitle">Add to this session</h2>
        <button type="button" class="xbtn ideate-sheet-x" data-ui-sheet-close aria-label="Close">✕</button>
      </div>
      <p class="ideate-lead">${escHtml(opts.subtitle)}</p>
      <div class="ideate-steer">
        <div class="rail ideate-vibes" role="group" aria-label="Quick directions">${chips}</div>
        <div class="ideate-steer-row">
          <label for="ideateSteerInput" class="sr-only">Optional direction</label>
          <input id="ideateSteerInput" class="input ideate-steer-input" type="text" autocomplete="off" enterkeyhint="go"
            placeholder="Optional steer (e.g. light shoulders, 10 min)" value="${escAttr(activeSteer)}">
          <button class="pillbtn ideate-steer-go" type="button" data-ideate-go>Steer</button>
        </div>
      </div>
      <div class="ideate-slot"></div>`;
  }

  function loadingHtml(): string {
    return `<div class="ideate-loading settle-in" role="status" aria-live="polite">
      <span class="aspin" aria-hidden="true"></span>
      ${CairnUi.jobCaptionHtml({ tag: "div", className: "ideate-loading-line job-cap" })}
      <div class="ideate-stream" data-stream-slot hidden></div>
    </div>`;
  }

  function rowHtml(
    item: SessionAdditionsItemLike,
    index: number,
    addedKeys: Set<string>,
    formatDur?: (seconds: number) => string
  ): string {
    const exercise = String(item.exercise || "Exercise");
    const key = CairnSessionAdditionsModel.exerciseKey(exercise);
    const added = addedKeys.has(key);
    const rx = CairnSessionAdditionsModel.rxSummary(item, formatDur);
    const fit = String(item.fit || "").trim();
    const note = String(item.note || "").trim();
    const tile = artImg("exercise", exercise, "artile-sm ideate-art", art("exercise", exercise));
    return `<li class="ideate-item reveal" style="${stagger(index + 1)}">
      ${tile}
      <div class="ideate-item-main">
        <div class="ideate-item-top">
          <span class="ideate-item-name">${escHtml(exercise)}</span>
          <span class="ideate-item-rx num">${escHtml(rx)}</span>
        </div>
        ${fit ? `<p class="ideate-item-fit">${escHtml(fit)}</p>` : ""}
        ${note ? `<p class="ideate-item-note">${escHtml(note)}</p>` : ""}
      </div>
      <button type="button" class="pillbtn ideate-add-btn${added ? " is-added" : ""}" data-ideate-add="${index}"${added ? " disabled" : ""}>${added ? "Added ✓" : "+ Add"}</button>
    </li>`;
  }

  function resultsHtml(opts: {
    why?: string;
    suggestions: SessionAdditionsItemLike[];
    addedKeys: Set<string>;
    formatDur?: (seconds: number) => string;
  }): string {
    const why = String(opts.why || "").trim();
    const list = Array.isArray(opts.suggestions) ? opts.suggestions : [];
    const rows = list.map((item, i) => rowHtml(item, i, opts.addedKeys, opts.formatDur)).join("");
    return `<div class="ideate-results settle-in">
      ${why ? `<p class="ideate-why">${escHtml(why)}</p>` : ""}
      ${rows ? `<ul class="ideate-list">${rows}</ul>` : `<p class="ideate-empty">Nothing new came back — try a steer or use + Add exercise.</p>`}
      <div class="ideate-foot">
        <button type="button" class="linkbtn linkbtn-quiet ideate-more" data-ideate-more>Different ideas</button>
        <button type="button" class="pillbtn ideate-done" data-ui-sheet-close>Done</button>
      </div>
    </div>`;
  }

  function failureHtml(): string {
    return `<div class="ideate-fail settle-in" role="status" aria-live="polite">
      <p class="ideate-fail-line">Couldn't pull exercise ideas just now. You can try again or add anything directly with + Add exercise.</p>
      <div class="ideate-foot">
        <button type="button" class="pillbtn" data-ideate-retry>Try again</button>
        <button type="button" class="linkbtn linkbtn-quiet" data-ui-sheet-close>Close</button>
      </div>
    </div>`;
  }

  const CAIRN_SESSION_ADDITIONS_CLIENT = {
    sheetHtml,
    loadingHtml,
    rowHtml,
    resultsHtml,
    failureHtml,
  };

  Object.assign(globalThis, { CairnSessionAdditionsClient: CAIRN_SESSION_ADDITIONS_CLIENT });
  if (typeof window !== "undefined") {
    Object.assign(window, { CairnSessionAdditionsClient: CAIRN_SESSION_ADDITIONS_CLIENT });
  }
})();
